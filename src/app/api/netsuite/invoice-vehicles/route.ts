import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createDirectInvoice, findCustomer, findItems, findLocation, suiteqlQuery } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

/**
 * POST /api/netsuite/invoice-vehicles
 * Body: { scanIds: string[] }
 * Creates NetSuite invoices directly from scan_logs entries (no PO/SO needed).
 * Groups scans by billable customer + PO number so each unique PO gets its own
 * invoice with each part number on a separate line. Scans without a PO are
 * grouped together by customer.
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

    // Group scans by billable customer + PO number.
    // Each unique PO gets its own invoice; scans without a PO are grouped together per customer.
    const byGroup: Record<string, typeof scans> = {};
    for (const s of scans) {
      const customer = s.billable_customer || 'Unknown';
      const groupKey = s.po_number
        ? `${customer}|||${s.po_number}`
        : `${customer}|||__NO_PO__`;
      if (!byGroup[groupKey]) byGroup[groupKey] = [];
      byGroup[groupKey].push(s);
    }

    const results: {
      customer: string;
      poNumber?: string;
      vehicleCount: number;
      status: 'success' | 'error';
      invoiceId?: string;
      invoiceNumber?: string;
      error?: string;
    }[] = [];

    for (const [groupKey, groupScans] of Object.entries(byGroup)) {
      const [customerName, poKey] = groupKey.split('|||');
      const poNumber = poKey !== '__NO_PO__' ? poKey : undefined;

      try {
        // Find the NetSuite customer
        const customerResult = await findCustomer(customerName);
        if (!customerResult.found || customerResult.customers.length === 0) {
          results.push({
            customer: customerName,
            poNumber,
            vehicleCount: groupScans.length,
            status: 'error',
            error: `Customer "${customerName}" not found in NetSuite`,
          });
          continue;
        }
        const nsCustomer = customerResult.customers[0];

        // Group scans by part number and aggregate quantities — each part is a separate line
        const partGroups: Record<string, { count: number; price: number }> = {};
        for (const s of groupScans) {
          const partNum = s.part_number || 'UNKNOWN';
          if (!partGroups[partNum]) {
            partGroups[partNum] = {
              count: 0,
              price: priceMap[partNum] || 0,
            };
          }
          partGroups[partNum].count++;
        }

        // Look up NetSuite items by part number
        const nsItems = await findItems(Object.keys(partGroups));

        // Build invoice line items (no description — NetSuite populates from part number)
        const lineItems: { itemId: string | number; quantity: number; rate: number }[] = [];
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
          });
        }

        if (lineItems.length === 0) {
          results.push({
            customer: customerName,
            poNumber,
            vehicleCount: groupScans.length,
            status: 'error',
            error: `No parts matched in NetSuite: ${unmatchedParts.join(', ')}`,
          });
          continue;
        }

        // Build VIN list for the memo
        const vinList = groupScans.map(s => s.vin).join(', ');
        const poLabel = poNumber ? ` — PO #${poNumber}` : '';
        const memo = `BMG FleetSuite Invoice${poLabel} — ${groupScans.length} vehicle${groupScans.length !== 1 ? 's' : ''}: ${vinList.length > 200 ? vinList.slice(0, 200) + '...' : vinList}`;

        // Find a NetSuite location — use scan's location, fall back to O'Fallon
        let locationId: string | undefined;
        const firstLocation = groupScans.find(s => s.location_name)?.location_name;
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
            poNumber,
            vehicleCount: groupScans.length,
            status: 'error',
            error: 'Could not find O\'Fallon location in NetSuite',
          });
          continue;
        }

        // Create the invoice — one per unique PO (or one for all no-PO scans per customer)
        const invoiceResult = await createDirectInvoice({
          customerId: nsCustomer.id,
          locationId,
          poNumber,
          memo,
          lineItems,
        });

        if (invoiceResult.success) {
          // Mark scans as exported if not already
          const unexportedIds = groupScans.filter(s => !s.exported_at).map(s => s.id);
          if (unexportedIds.length > 0) {
            await supabase
              .from('scan_logs')
              .update({ exported_at: new Date().toISOString(), exported_by: auth.user.id })
              .in('id', unexportedIds);
          }

          results.push({
            customer: customerName,
            poNumber,
            vehicleCount: groupScans.length,
            status: 'success',
            invoiceId: invoiceResult.invoiceId,
            invoiceNumber: invoiceResult.invoiceNumber,
          });
        } else {
          results.push({
            customer: customerName,
            poNumber,
            vehicleCount: groupScans.length,
            status: 'error',
            error: invoiceResult.error,
          });
        }
      } catch (e: any) {
        results.push({
          customer: customerName,
          poNumber,
          vehicleCount: groupScans.length,
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
        totalCustomers: new Set(Object.keys(byGroup).map(k => k.split('|||')[0])).size,
        totalInvoices: Object.keys(byGroup).length,
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
