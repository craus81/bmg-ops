import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createInvoiceFromSO, suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const Schema = z.object({
  salesOrderIds: z.array(z.string().regex(/^\d{1,15}$/, 'Sales order id must be numeric')).min(1).max(200),
});

/**
 * POST /api/netsuite/create-invoice
 * Body: { salesOrderIds: string[] }
 * Creates invoices in NetSuite from one or more sales orders,
 * billing only the installed quantities from our PO tracking.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { salesOrderIds } = parsed.data;

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

      if (!hasInstalled) {
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

        // Build installed quantities map: SO line number -> installed qty
        const installedQuantities: Record<number, number> = {};

        for (const poLine of lineItems) {
          if (poLine.installed <= 0) continue;

          // Match PO line to SO line by part number
          const matchingSoLine = soLines.find((sl: any) =>
            sl.itemid?.toUpperCase() === poLine.part_number?.toUpperCase()
          );

          if (matchingSoLine) {
            const lineNum = parseInt(matchingSoLine.linesequencenumber);
            // Use the lesser of installed vs ordered quantity
            installedQuantities[lineNum] = Math.min(poLine.installed, poLine.quantity);
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

        // Create the invoice
        const invoiceResult = await createInvoiceFromSO({
          salesOrderId: soId,
          installedQuantities,
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
