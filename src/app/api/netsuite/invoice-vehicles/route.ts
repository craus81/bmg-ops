import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createDirectInvoice, findCustomer, findItems, findLocation } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

/**
 * POST /api/netsuite/invoice-vehicles
 * Body: { vehicleIds: string[] }
 * Creates a NetSuite invoice directly from scanned vehicles (no PO/SO needed).
 * Groups vehicles by customer, looks up catalog pricing, and creates one invoice per customer.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { vehicleIds } = await req.json();

    if (!vehicleIds || !Array.isArray(vehicleIds) || vehicleIds.length === 0) {
      return NextResponse.json({ error: 'vehicleIds array required' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Load the vehicles with their catalog info
    const { data: vehicles, error: vErr } = await supabase
      .from('scanned_vehicles')
      .select('*, catalog:catalog_id(*)')
      .in('id', vehicleIds);

    if (vErr || !vehicles || vehicles.length === 0) {
      return NextResponse.json({ error: 'No vehicles found' }, { status: 400 });
    }

    // Group vehicles by customer
    const byCustomer: Record<string, any[]> = {};
    for (const v of vehicles) {
      const customer = v.customer || 'Unknown';
      if (!byCustomer[customer]) byCustomer[customer] = [];
      byCustomer[customer].push(v);
    }

    // Get location
    const location = await findLocation("O'Fallon");

    const results: {
      customer: string;
      vehicleCount: number;
      status: 'success' | 'error';
      invoiceId?: string;
      invoiceNumber?: string;
      error?: string;
    }[] = [];

    for (const [customerName, custVehicles] of Object.entries(byCustomer)) {
      try {
        // Find the NetSuite customer
        const customerResult = await findCustomer(customerName);
        if (!customerResult.found || customerResult.customers.length === 0) {
          results.push({
            customer: customerName,
            vehicleCount: custVehicles.length,
            status: 'error',
            error: `Customer "${customerName}" not found in NetSuite`,
          });
          continue;
        }
        const nsCustomer = customerResult.customers[0];

        // Group vehicles by part number and aggregate quantities
        const partGroups: Record<string, { count: number; price: number; description: string; partNumber: string }> = {};
        for (const v of custVehicles) {
          const partNum = v.part_number || 'UNKNOWN';
          if (!partGroups[partNum]) {
            const catalogPrice = v.catalog?.price || 0;
            const desc = v.catalog?.graphic_package || v.catalog?.vehicle_type || partNum;
            partGroups[partNum] = { count: 0, price: catalogPrice, description: desc, partNumber: partNum };
          }
          partGroups[partNum].count++;
        }

        // Look up NetSuite items by part number
        const partNumbers = Object.keys(partGroups);
        const nsItems = await findItems(partNumbers);

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
            vehicleCount: custVehicles.length,
            status: 'error',
            error: `No parts matched in NetSuite: ${unmatchedParts.join(', ')}`,
          });
          continue;
        }

        // Build VIN list for the memo
        const vinList = custVehicles.map((v: any) => v.vin).join(', ');
        const memo = `BMG FleetSuite Invoice — ${custVehicles.length} vehicle${custVehicles.length !== 1 ? 's' : ''}: ${vinList.length > 200 ? vinList.slice(0, 200) + '...' : vinList}`;

        // Create the invoice
        const invoiceResult = await createDirectInvoice({
          customerId: nsCustomer.id,
          locationId: location?.id,
          memo,
          lineItems,
        });

        if (invoiceResult.success) {
          // Mark vehicles as invoiced
          await supabase
            .from('scanned_vehicles')
            .update({ netsuite_invoice_id: invoiceResult.invoiceId })
            .in('id', custVehicles.map((v: any) => v.id));

          results.push({
            customer: customerName,
            vehicleCount: custVehicles.length,
            status: 'success',
            invoiceId: invoiceResult.invoiceId,
            invoiceNumber: invoiceResult.invoiceNumber,
          });
        } else {
          results.push({
            customer: customerName,
            vehicleCount: custVehicles.length,
            status: 'error',
            error: invoiceResult.error,
          });
        }
      } catch (e: any) {
        results.push({
          customer: customerName,
          vehicleCount: custVehicles.length,
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
        totalCustomers: Object.keys(byCustomer).length,
        totalVehicles: vehicleIds.length,
        success: successCount,
        errors: errorCount,
      },
    });
  } catch (err: any) {
    console.error('Invoice vehicles error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create invoices' }, { status: 500 });
  }
}
