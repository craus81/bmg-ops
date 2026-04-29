import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createDirectInvoice, findCustomer, findItems, findLocation, suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

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

  try {
    const { scanIds } = await req.json();

    if (!scanIds || !Array.isArray(scanIds) || scanIds.length === 0) {
      return NextResponse.json({ error: 'scanIds array required' }, { status: 400 });
    }

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

        for (const [partNum, group] of Object.entries(partGroups)) {
          const nsItem = nsItems[partNum.toUpperCase()];
          if (!nsItem) {
            unmatchedParts.push(partNum);
            continue;
          }
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

        const memo = 'BMG FleetSuite Invoice';

        // Find a NetSuite location — use scan's location, fall back to O'Fallon
        let locationId: string | undefined;
        const firstLocation = custScans.find(s => s.location_name)?.location_name;
        const loc = await findLocation(firstLocation || "Fallon");
        if (loc) locationId = loc.id;

        // If location lookup failed, try a broader search
        if (!locationId) {
          try {
            const locResult = await suiteqlQuery("SELECT id FROM location WHERE UPPER(name) LIKE '%FALLON%' FETCH FIRST 1 ROWS ONLY");
            if (locResult?.items?.[0]?.id) locationId = locResult.items[0].id.toString();
          } catch {}
        }

        if (!locationId) {
          results.push({
            customer: customerName,
            po: poNumber,
            scanIds: custScans.map(s => s.id),
            vehicleCount: custScans.length,
            status: 'error',
            error: 'Could not find O\'Fallon location in NetSuite',
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
          // Mark scans as exported if not already
          const unexportedIds = custScans.filter(s => !s.exported_at).map(s => s.id);
          if (unexportedIds.length > 0) {
            await supabase
              .from('scan_logs')
              .update({ exported_at: new Date().toISOString(), exported_by: auth.user.id })
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
            error: invoiceResult.error,
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
