import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createSalesOrder, findCustomer, findItems, findLocation } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

const adminSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(
  _req: NextRequest,
  { params }: { params: { orderId: string } }
) {
  try {
    // Load the portal order with all relations
    const { data: order, error: orderError } = await adminSupabase
      .from('portal_orders')
      .select(`
        *,
        portal_customer:portal_customers(id, company_name),
        lines:portal_order_lines(
          *,
          proof_part:proof_parts(id, part_name, part_number, unit_price)
        )
      `)
      .eq('id', params.orderId)
      .single();

    if (orderError || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Already pushed?
    if (order.netsuite_so_id) {
      return NextResponse.json({
        status: 'already_created',
        salesOrderId: order.netsuite_so_id,
        salesOrderNumber: order.netsuite_so_number || '',
        message: `Sales Order already exists in NetSuite (SO #${order.netsuite_so_number || order.netsuite_so_id})`,
      });
    }

    const lines = order.lines || [];
    if (lines.length === 0) {
      return NextResponse.json({ error: 'Order has no line items' }, { status: 400 });
    }

    // Step 1: Find the customer in NetSuite by company name
    const companyName = order.portal_customer?.company_name;
    if (!companyName) {
      return NextResponse.json({ error: 'Portal customer not found' }, { status: 400 });
    }

    const customerResult = await findCustomer(companyName);
    if (!customerResult.found || customerResult.customers.length === 0) {
      return NextResponse.json({
        error: `Customer "${companyName}" not found in NetSuite. Please verify the customer exists.`,
        step: 'customer_lookup',
      }, { status: 400 });
    }
    const nsCustomer = customerResult.customers[0];

    // Step 2: Look up items by part number
    const partNumbers = lines
      .map((l: any) => l.proof_part?.part_number)
      .filter(Boolean);

    const itemMap = await findItems(partNumbers);

    const soLineItems: { itemId: string | number; quantity: number; rate: number; description?: string }[] = [];
    const unmatchedParts: string[] = [];

    for (const line of lines) {
      const partNumber = line.proof_part?.part_number;
      const partKey = partNumber?.toUpperCase();
      const nsItem = partKey ? itemMap[partKey] : null;

      if (nsItem) {
        soLineItems.push({
          itemId: nsItem.id,
          quantity: line.quantity,
          rate: line.unit_price,
          description: nsItem.description || line.proof_part?.part_name || partNumber,
        });
      } else {
        unmatchedParts.push(partNumber || line.proof_part?.part_name || 'Unknown');
      }
    }

    if (soLineItems.length === 0) {
      return NextResponse.json({
        error: `None of the order line items matched items in NetSuite. Unmatched: ${unmatchedParts.join(', ')}`,
        step: 'item_lookup',
        unmatchedParts,
      }, { status: 400 });
    }

    // Step 3: Location
    const nsLocation = await findLocation("O'Fallon");
    if (!nsLocation) {
      return NextResponse.json({
        error: "Location \"O'Fallon\" not found in NetSuite.",
        step: 'location_lookup',
      }, { status: 400 });
    }

    // Step 4: Build memo with ship-to info
    const addr = order.ship_to_address;
    const addrStr = addr
      ? ` | Ship to: ${addr.street}, ${addr.city}, ${addr.state} ${addr.zip}`
      : '';

    const result = await createSalesOrder({
      customerId: nsCustomer.id,
      poNumber: order.po_number || undefined,
      locationId: nsLocation.id,
      memo: `Portal Order — ${companyName}${order.po_number ? ' PO #' + order.po_number : ''}${addrStr}`,
      lineItems: soLineItems,
    });

    if (!result.success) {
      return NextResponse.json({
        error: result.error || 'Failed to create sales order in NetSuite',
        step: 'create_so',
      }, { status: 500 });
    }

    // Step 5: Save NS reference back to portal_order
    await adminSupabase
      .from('portal_orders')
      .update({
        netsuite_so_id: result.salesOrderId,
        netsuite_so_number: result.salesOrderNumber || null,
        status: 'confirmed',
      })
      .eq('id', params.orderId);

    return NextResponse.json({
      status: 'created',
      salesOrderId: result.salesOrderId,
      salesOrderNumber: result.salesOrderNumber,
      customer: nsCustomer.name,
      lineItemCount: soLineItems.length,
      unmatchedParts: unmatchedParts.length > 0 ? unmatchedParts : undefined,
    });
  } catch (err: any) {
    console.error('Portal order NetSuite push error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create sales order' }, { status: 500 });
  }
}
