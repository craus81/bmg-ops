import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createInvoiceFromSO, suiteqlQuery } from '@/lib/netsuite';
import { resolveLocationWithOverride } from '@/lib/invoice-location';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { normPart } from '@/lib/po-invoice-verify';

const Schema = z.object({
  salesOrderIds: z.array(z.string().regex(/^\d{1,15}$/, 'Sales order id must be numeric')).min(1).max(200),
  // Explicit per-part quantities to bill (part number -> qty), overriding the
  // default installed-quantity billing. Single-SO mode only — the map is
  // meaningless across several sales orders. (The PO screen's "invoice open
  // quantities" flow moved to /api/pos/invoice-open, which invoices NetSuite
  // directly; this SO-transform path is the batch-from-sales-order route.)
  quantities: z.record(z.string().min(1).max(120), z.number().int().min(1).max(100000)).optional(),
});

/**
 * POST /api/netsuite/create-invoice
 * Body: { salesOrderIds: string[], quantities?: Record<partNumber, qty> }
 * Creates invoices in NetSuite from one or more sales orders — billing the
 * installed quantities from our PO tracking by default, or exactly the
 * caller-provided quantities when `quantities` is set.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { salesOrderIds, quantities } = parsed.data;
  if (quantities && salesOrderIds.length !== 1) {
    return NextResponse.json({ error: 'Explicit quantities require exactly one sales order' }, { status: 400 });
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const results: {
      poId: string;
      poNumber: string;
      soId: string;
      soNumber: string;
      status: 'success' | 'error' | 'skipped';
      invoiceId?: string;
      invoiceNumber?: string;
      error?: string;
    }[] = [];

    // For each sales order, look up the PO to get installed quantities
    for (const soId of salesOrderIds) {
      // Find the PO linked to this SO
      const { data: po } = await supabase
        .from('purchase_orders')
        .select('*, po_line_items(*)')
        .eq('netsuite_so_id', soId)
        .maybeSingle();

      if (!po) {
        results.push({
          poId: '',
          poNumber: '',
          soId,
          soNumber: '',
          status: 'error',
          error: 'No PO found linked to this sales order',
        });
        continue;
      }

      const lineItems = po.po_line_items || [];
      const hasInstalled = lineItems.some((li: any) => li.installed > 0);

      if (!quantities && !hasInstalled) {
        results.push({
          poId: po.id,
          poNumber: po.po_number,
          soId,
          soNumber: po.netsuite_so_number || '',
          status: 'skipped',
          error: 'No installed quantities to invoice',
        });
        continue;
      }

      // Get the SO line details from NetSuite to map our PO lines to SO lines
      try {
        const soLinesQuery = `
          SELECT tl.linesequencenumber, tl.item, i.itemid, tl.quantity, tl.rate
          FROM transactionline tl
          LEFT JOIN item i ON tl.item = i.id
          WHERE tl.transaction = ${soId}
          AND tl.mainline = 'F'
          AND tl.taxline = 'F'
          ORDER BY tl.linesequencenumber
        `;
        const soLinesResult = await suiteqlQuery(soLinesQuery);
        const soLines = soLinesResult?.items || [];

        // A part can appear on several SO lines (and several PO lines), and
        // there's no stored line-to-line linkage — only the part number. Group
        // the SO's lines by part, preserving sequence order, so a part's billed
        // quantity can be spread across ALL its lines. The old code matched each
        // PO line to the FIRST SO line of that part, so a part split over
        // multiple lines collapsed onto one (last write wins), silently
        // under-billing the rest.
        const soLinesByPart = new Map<string, any[]>();
        for (const sl of soLines) {
          const key = normPart(sl.itemid || '');
          if (!key) continue;
          const arr = soLinesByPart.get(key);
          if (arr) arr.push(sl);
          else soLinesByPart.set(key, [sl]);
        }

        // Quantity to bill per part. Explicit caller quantities win; the
        // default bills the installed counts from our PO tracking, summed
        // across all of a part's PO lines.
        const billByPart = new Map<string, number>();

        if (quantities) {
          const unmatchedParts: string[] = [];
          const overCapacityParts: string[] = [];
          for (const [partNumber, qty] of Object.entries(quantities)) {
            const key = normPart(partNumber);
            const sls = soLinesByPart.get(key);
            if (!sls || sls.length === 0) {
              unmatchedParts.push(partNumber);
              continue;
            }
            // A part's billable capacity is the sum of its SO lines' quantities;
            // asking for more can't be transformed from this SO.
            const capacity = sls.reduce((s, sl) => s + (Math.abs(parseFloat(sl.quantity)) || 0), 0);
            if (qty > capacity) {
              overCapacityParts.push(`${partNumber} (${qty} > ${capacity})`);
              continue;
            }
            billByPart.set(key, (billByPart.get(key) || 0) + qty);
          }
          // Silently dropping (or over-billing) a requested line would skew the
          // invoice without anyone noticing — refuse instead.
          if (unmatchedParts.length > 0 || overCapacityParts.length > 0) {
            const detail = [
              unmatchedParts.length > 0 ? `not on the sales order: ${unmatchedParts.join(', ')}` : '',
              overCapacityParts.length > 0 ? `exceeds the SO's open quantity: ${overCapacityParts.join(', ')}` : '',
            ].filter(Boolean).join('; ');
            results.push({
              poId: po.id,
              poNumber: po.po_number,
              soId,
              soNumber: po.netsuite_so_number || '',
              status: 'error',
              error: detail,
            });
            continue;
          }
        } else {
          for (const poLine of lineItems) {
            if (poLine.installed <= 0) continue;
            const key = normPart(poLine.part_number || '');
            if (!key) continue;
            // Aggregate installed across all of this part's PO lines, each
            // capped at its own ordered quantity.
            billByPart.set(key, (billByPart.get(key) || 0) + Math.min(poLine.installed, poLine.quantity));
          }
        }

        // Distribute each part's billed quantity across its SO lines in
        // sequence order, filling each up to its quantity — so a part that
        // spans several lines bills the full total instead of collapsing onto
        // one, and no single SO line is billed past its open quantity.
        const installedQuantities: Record<number, number> = {};
        for (const [key, total] of billByPart) {
          let remaining = total;
          for (const sl of soLinesByPart.get(key) || []) {
            if (remaining <= 0) break;
            const cap = Math.abs(parseFloat(sl.quantity)) || 0;
            const fill = Math.min(remaining, cap);
            if (fill > 0) {
              const seq = parseInt(sl.linesequencenumber);
              installedQuantities[seq] = (installedQuantities[seq] || 0) + fill;
              remaining -= fill;
            }
          }
        }

        if (Object.keys(installedQuantities).length === 0) {
          results.push({
            poId: po.id,
            poNumber: po.po_number,
            soId,
            soNumber: po.netsuite_so_number || '',
            status: 'skipped',
            error: 'Could not match installed lines to SO lines',
          });
          continue;
        }

        // Book the invoice to the location our PO rules resolve from the PO's
        // customer + ship-to, instead of whatever the SO→invoice transform
        // would inherit.
        const { id: locationId } = await resolveLocationWithOverride(supabase, po.po_number, {
          customerName: po.customer,
          city: po.ship_to?.city,
          name: po.ship_to?.name,
        });

        // Create the invoice
        const invoiceResult = await createInvoiceFromSO({
          salesOrderId: soId,
          installedQuantities,
          locationId: locationId ?? undefined,
          memo: `Invoice from BMG FleetSuite — PO #${po.po_number}`,
        });

        if (invoiceResult.success) {
          // Store invoice reference on the PO (legacy single-invoice field)
          await supabase
            .from('purchase_orders')
            .update({
              netsuite_invoice_id: invoiceResult.invoiceId,
              netsuite_invoice_number: invoiceResult.invoiceNumber,
            })
            .eq('id', po.id);

          // Also insert into po_invoices for multi-invoice tracking
          const installedLineCount = Object.keys(installedQuantities).length;
          const installedTotalQty = Object.values(installedQuantities).reduce((a, b) => a + b, 0);
          await supabase.from('po_invoices').insert({
            purchase_order_id: po.id,
            netsuite_invoice_id: invoiceResult.invoiceId,
            netsuite_invoice_number: invoiceResult.invoiceNumber,
            line_count: installedLineCount,
            total_qty: installedTotalQty,
            memo: `PO #${po.po_number} — ${installedTotalQty} unit${installedTotalQty !== 1 ? 's' : ''} across ${installedLineCount} line${installedLineCount !== 1 ? 's' : ''}`,
          });

          results.push({
            poId: po.id,
            poNumber: po.po_number,
            soId,
            soNumber: po.netsuite_so_number || '',
            status: 'success',
            invoiceId: invoiceResult.invoiceId,
            invoiceNumber: invoiceResult.invoiceNumber,
          });
        } else {
          results.push({
            poId: po.id,
            poNumber: po.po_number,
            soId,
            soNumber: po.netsuite_so_number || '',
            status: 'error',
            error: invoiceResult.error,
          });
        }
      } catch (e: any) {
        results.push({
          poId: po.id,
          poNumber: po.po_number,
          soId,
          soNumber: po.netsuite_so_number || '',
          status: 'error',
          error: e.message || 'Unknown error',
        });
      }
    }

    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;

    return NextResponse.json({
      results,
      summary: {
        total: salesOrderIds.length,
        success: successCount,
        errors: errorCount,
        skipped: skippedCount,
      },
    });
  } catch (err: any) {
    console.error('Batch invoice error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create invoices' }, { status: 500 });
  }
}
