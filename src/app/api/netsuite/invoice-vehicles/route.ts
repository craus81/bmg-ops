import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createDirectInvoice, findCustomer, findItems } from '@/lib/netsuite';
import { resolveLocationWithOverride } from '@/lib/invoice-location';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { refreshPoInvoiceLinks } from '@/lib/po-invoice-sync';
import { getPoBilledByPart, computeOverbillProblems } from '@/lib/po-invoice-verify';
import { fetchPartRowsCI } from '@/lib/part-number';

// The over-billing gate adds a couple of SuiteQL round trips per PO group on
// top of the NetSuite invoice creation itself.
export const maxDuration = 60;

const Schema = z.object({
  scanIds: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * POST /api/netsuite/invoice-vehicles
 * Body: { scanIds: string[] }
 * Creates a NetSuite invoice directly from scan_logs entries.
 * Groups scans by billable customer + PO number, creating one invoice per PO
 * with multiple part number line items.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['sales']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { scanIds } = parsed.data;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Load the scan logs
    const { data: scans, error: sErr } = await supabase
      .from('scan_logs')
      .select('*')
      .in('id', scanIds);

    if (sErr || !scans || scans.length === 0) {
      return NextResponse.json({ error: 'No scans found' }, { status: 400 });
    }

    // Load pricing from netsuite_parts for all part numbers in the selection.
    // Case-insensitive: scans can carry hand-typed casing (06u166) while the
    // catalog holds NetSuite's (06U166) — an exact .in() here priced those at
    // 0 and refused the invoice with "No NetSuite price set".
    const partNumbers = [...new Set(scans.map(s => s.part_number).filter(Boolean))];
    const partsData = await fetchPartRowsCI(supabase, partNumbers, 'item_number, sales_price');

    const priceMap: Record<string, number> = {};
    for (const p of partsData) {
      priceMap[p.item_number.toUpperCase()] = parseFloat(p.sales_price) || 0;
    }

    // Group scans by billable customer + PO (one invoice per PO)
    const byCustomerPO: Record<string, { customer: string; po: string | null; scans: typeof scans }> = {};
    for (const s of scans) {
      const customer = s.billable_customer || 'Unknown';
      const po = s.po_number || null;
      const key = `${customer}|||${po || 'NO_PO'}`;
      if (!byCustomerPO[key]) byCustomerPO[key] = { customer, po, scans: [] };
      byCustomerPO[key].scans.push(s);
    }

    const results: {
      customer: string;
      po: string | null;
      scanIds: string[];
      vehicleCount: number;
      status: 'success' | 'error';
      invoiceId?: string;
      invoiceNumber?: string;
      error?: string;
    }[] = [];

    for (const { customer: customerName, po: poNumber, scans: custScans } of Object.values(byCustomerPO)) {
      try {
        // Group scans by part number and aggregate quantities (built before
        // any NetSuite call — the billing gate needs the counts). Keyed by
        // uppercase so case variants of one part land on one invoice line;
        // `display` keeps the first-seen casing for messages.
        const partGroups: Record<string, { count: number; price: number; description: string; display: string }> = {};
        for (const s of custScans) {
          const raw = s.part_number || 'UNKNOWN';
          const partNum = raw.toUpperCase();
          if (!partGroups[partNum]) {
            partGroups[partNum] = {
              count: 0,
              price: priceMap[partNum] || 0,
              description: s.part_description || raw,
              display: raw,
            };
          }
          partGroups[partNum].count++;
        }

        // ── Over-billing gate ──────────────────────────────────────────
        // This flow used to bill selected scans with no idea what the PO had
        // already been invoiced for — so a PO pre-billed in full (e.g. an
        // admin invoicing on receipt) got billed AGAIN per scanned vehicle,
        // and the quantity sweep could only flag it after the money went
        // out. Now the PO's invoice links are refreshed live (catching an
        // invoice typed into NetSuite minutes ago, as long as it carries the
        // PO in Reference No.) and the group is refused with specifics when
        // billing it would exceed what the PO ordered. POs FleetSuite
        // doesn't track (no row / no line items) can't be checked and pass
        // through; the sweep still watches those after the fact.
        let poRow: { id: string; ship_to: unknown } | null = null;
        if (poNumber) {
          const { data: po } = await supabase
            .from('purchase_orders')
            .select('id, ship_to, po_line_items(part_number, quantity)')
            .eq('po_number', poNumber)
            .maybeSingle();
          poRow = po ? { id: po.id, ship_to: po.ship_to } : null;
          const poLines = (po?.po_line_items || []) as { part_number: string; quantity: number }[];
          if (po && poLines.length > 0) {
            await refreshPoInvoiceLinks(supabase, po.id);
            const { billedByPart, invoiceNumbers } = await getPoBilledByPart(supabase, po.id);
            const problems = computeOverbillProblems(
              poLines,
              billedByPart,
              Object.values(partGroups).map(g => ({ partNumber: g.display, quantity: g.count })),
            );
            if (problems.length > 0) {
              results.push({
                customer: customerName,
                po: poNumber,
                scanIds: custScans.map(s => s.id),
                vehicleCount: custScans.length,
                status: 'error',
                error: `Blocked — billing these scans would over-bill PO ${poNumber}${invoiceNumbers.length ? ` (already invoiced on ${invoiceNumbers.join(', ')})` : ''}: ${problems.join('; ')}. Fix the invoices or the PO in NetSuite, then use Recheck billing on the PO page.`,
              });
              continue;
            }
          }
        }

        // Find the NetSuite customer
        const customerResult = await findCustomer(customerName);
        if (!customerResult.found || customerResult.customers.length === 0) {
          results.push({
            customer: customerName,
            po: poNumber,
            scanIds: custScans.map(s => s.id),
            vehicleCount: custScans.length,
            status: 'error',
            error: `Customer "${customerName}" not found in NetSuite`,
          });
          continue;
        }
        const nsCustomer = customerResult.customers[0];

        // Look up NetSuite items by part number
        const nsItems = await findItems(Object.keys(partGroups));

        // Build invoice line items
        const lineItems: { itemId: string | number; quantity: number; rate: number; description: string }[] = [];
        const unmatchedParts: string[] = [];
        // Parts that matched a NetSuite item but have no price in netsuite_parts
        // — billing them would silently send a $0 line (docs/cni-redesign.md §3.6).
        const unpricedParts: string[] = [];
        // Track which NetSuite item each part resolved to, so a NetSuite
        // rejection can name the part + internal ID + type rather than a bare id.
        const matchDetail: string[] = [];

        // The rate each part actually bills at — stamped per scan below so
        // profitability reporting has real revenue, not an estimate.
        const billedRates: Record<string, number> = {};

        for (const [partNum, group] of Object.entries(partGroups)) {
          const nsItem = nsItems[partNum];
          if (!nsItem) {
            unmatchedParts.push(group.display);
            continue;
          }
          if (!(group.price > 0)) unpricedParts.push(group.display);
          matchDetail.push(`${group.display} → NS item #${nsItem.id}${nsItem.type ? ` (${nsItem.type})` : ''}`);
          billedRates[partNum] = group.price;
          lineItems.push({
            itemId: nsItem.id,
            quantity: group.count,
            rate: group.price,
            description: `${group.description} — ${group.count} vehicle${group.count !== 1 ? 's' : ''}`,
          });
        }

        if (lineItems.length === 0) {
          results.push({
            customer: customerName,
            po: poNumber,
            scanIds: custScans.map(s => s.id),
            vehicleCount: custScans.length,
            status: 'error',
            error: `No parts matched in NetSuite: ${unmatchedParts.join(', ')}`,
          });
          continue;
        }

        // Refuse to bill a part at $0: without a price in netsuite_parts the
        // line would silently invoice for nothing. Surface it so an admin sets
        // the price and re-invoices, instead of sending a $0 line (§3.6).
        if (unpricedParts.length > 0) {
          results.push({
            customer: customerName,
            po: poNumber,
            scanIds: custScans.map(s => s.id),
            vehicleCount: custScans.length,
            status: 'error',
            error: `No NetSuite price set for: ${unpricedParts.join(', ')} — set a price in netsuite_parts, then re-invoice`,
          });
          continue;
        }

        const memo = 'BMG FleetSuite Invoice';

        // Resolve the NetSuite location from our PO rules: the billed customer
        // plus the plant signal from the PO ship-to / scan work location.
        // O'Fallon is the built-in default. (PO row already loaded by the gate.)
        const poShipTo = (poRow?.ship_to as { city?: string; name?: string } | null) || null;
        const firstLocation = custScans.find(s => s.location_name)?.location_name;
        const { id: locationId } = await resolveLocationWithOverride(supabase, poNumber, {
          customerName,
          city: poShipTo?.city,
          name: poShipTo?.name,
          locationName: firstLocation,
        });

        if (!locationId) {
          results.push({
            customer: customerName,
            po: poNumber,
            scanIds: custScans.map(s => s.id),
            vehicleCount: custScans.length,
            status: 'error',
            error: 'Could not resolve a NetSuite location for this invoice',
          });
          continue;
        }

        // Create the invoice
        const invoiceResult = await createDirectInvoice({
          customerId: nsCustomer.id,
          locationId,
          memo,
          ...(poNumber ? { otherrefnum: poNumber } : {}),
          lineItems,
        });

        if (invoiceResult.success) {
          const nowIso = new Date().toISOString();

          // Fold the full invoice bookkeeping into the endpoint so every caller
          // gets identical accounting in one server-side step, instead of a
          // separate client-side call that could fail after NetSuite already
          // billed (docs/cni-redesign.md §3.3). Only when an invoice number came
          // back — otherwise leave the scans visible for manual handling, as the
          // page did before.
          if (invoiceResult.invoiceNumber) {
            await supabase
              .from('scan_logs')
              .update({
                invoice_number: invoiceResult.invoiceNumber,
                date_invoiced: nowIso.slice(0, 10),
                archived_at: nowIso,
              })
              .in('id', custScans.map(s => s.id));

            // Stamp each scan's billed rate — its exact share of the invoice,
            // since a part's line quantity is the VIN count. Parts that didn't
            // land on the invoice (no NetSuite match) get no stamp.
            await Promise.all(Object.entries(billedRates).map(([partNum, rate]) => {
              const ids = custScans
                .filter(s => (s.part_number || 'UNKNOWN').toUpperCase() === partNum)
                .map(s => s.id);
              if (ids.length === 0) return Promise.resolve(null);
              return supabase.from('scan_logs').update({ invoiced_amount: rate }).in('id', ids);
            }));
          }

          // Mark scans as exported if not already (preserve any earlier export time).
          const unexportedIds = custScans.filter(s => !s.exported_at).map(s => s.id);
          if (unexportedIds.length > 0) {
            await supabase
              .from('scan_logs')
              .update({ exported_at: nowIso, exported_by: auth.user.id })
              .in('id', unexportedIds);
          }

          // Link the invoice to its PO right away, matching the invoice-open
          // flow's bookkeeping — the cron sweep would find it by Reference
          // No. within a couple hours anyway, but an immediate link means
          // the gate and the PO page see it on the very next request.
          if (poRow) {
            await supabase.from('po_invoices').upsert({
              purchase_order_id: poRow.id,
              netsuite_invoice_id: invoiceResult.invoiceId,
              netsuite_invoice_number: invoiceResult.invoiceNumber,
              line_count: lineItems.length,
              total_qty: custScans.length,
              memo: `Scan invoice — ${custScans.length} vehicle${custScans.length !== 1 ? 's' : ''}`,
            }, { onConflict: 'purchase_order_id,netsuite_invoice_id', ignoreDuplicates: true });
          }

          results.push({
            customer: customerName,
            po: poNumber,
            scanIds: custScans.map(s => s.id),
            vehicleCount: custScans.length,
            status: 'success',
            invoiceId: invoiceResult.invoiceId,
            invoiceNumber: invoiceResult.invoiceNumber,
          });
        } else {
          results.push({
            customer: customerName,
            po: poNumber,
            scanIds: custScans.map(s => s.id),
            vehicleCount: custScans.length,
            status: 'error',
            error: `${invoiceResult.error}${matchDetail.length ? ` — matched: ${matchDetail.join('; ')}` : ''}`,
          });
        }
      } catch (e: any) {
        results.push({
          customer: customerName,
          po: poNumber,
          scanIds: custScans.map(s => s.id),
          vehicleCount: custScans.length,
          status: 'error',
          error: e.message || 'Unknown error',
        });
      }
    }

    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    return NextResponse.json({
      results,
      summary: {
        totalGroups: Object.keys(byCustomerPO).length,
        totalVehicles: scanIds.length,
        success: successCount,
        errors: errorCount,
      },
    });
  } catch (err: any) {
    console.error('Invoice vehicles error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create invoices' }, { status: 500 });
  }
}
