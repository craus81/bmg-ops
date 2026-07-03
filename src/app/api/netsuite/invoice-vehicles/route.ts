import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createDirectInvoice, findCustomer, findItems } from '@/lib/netsuite';
import { resolveLocationWithOverride } from '@/lib/invoice-location';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

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
  const auth = await requireAuth(req);
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

    // Load pricing from netsuite_parts for all part numbers in the selection
    const partNumbers = [...new Set(scans.map(s => s.part_number).filter(Boolean))];
    const { data: partsData } = await supabase
      .from('netsuite_parts')
      .select('item_number, sales_price')
      .in('item_number', partNumbers);

    const priceMap: Record<string, number> = {};
    for (const p of partsData || []) {
      priceMap[p.item_number] = parseFloat(p.sales_price) || 0;
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

        // Group scans by part number and aggregate quantities
        const partGroups: Record<string, { count: number; price: number; description: string }> = {};
        for (const s of custScans) {
          const partNum = s.part_number || 'UNKNOWN';
          if (!partGroups[partNum]) {
            partGroups[partNum] = {
              count: 0,
              price: priceMap[partNum] || 0,
              description: s.part_description || partNum,
            };
          }
          partGroups[partNum].count++;
        }

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

        for (const [partNum, group] of Object.entries(partGroups)) {
          const nsItem = nsItems[partNum.toUpperCase()];
          if (!nsItem) {
            unmatchedParts.push(partNum);
            continue;
          }
          if (!(group.price > 0)) unpricedParts.push(partNum);
          matchDetail.push(`${partNum} → NS item #${nsItem.id}${nsItem.type ? ` (${nsItem.type})` : ''}`);
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
        // O'Fallon is the built-in default.
        let poShipTo: { city?: string; name?: string } | null = null;
        if (poNumber) {
          const { data: po } = await supabase
            .from('purchase_orders')
            .select('ship_to')
            .eq('po_number', poNumber)
            .maybeSingle();
          poShipTo = (po?.ship_to as { city?: string; name?: string } | null) || null;
        }
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
          }

          // Mark scans as exported if not already (preserve any earlier export time).
          const unexportedIds = custScans.filter(s => !s.exported_at).map(s => s.id);
          if (unexportedIds.length > 0) {
            await supabase
              .from('scan_logs')
              .update({ exported_at: nowIso, exported_by: auth.user.id })
              .in('id', unexportedIds);
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
