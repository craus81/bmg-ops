import { NextRequest, NextResponse } from 'next/server';
import { createSalesOrder, findCustomer, findItems } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) {
  try {
    const { poId } = await req.json();
    if (!poId) {
      return NextResponse.json({ error: 'poId required' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Load PO with line items
    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .select('*, po_line_items(*)')
      .eq('id', poId)
      .single();

    if (poError || !po) {
      return NextResponse.json({ error: 'PO not found' }, { status: 404 });
    }

    // Check if already pushed
    if (po.netsuite_so_id) {
      return NextResponse.json({
        status: 'already_created',
        salesOrderId: po.netsuite_so_id,
        salesOrderNumber: po.netsuite_so_number || '',
        message: `Sales Order already exists in NetSuite (SO #${po.netsuite_so_number || po.netsuite_so_id})`,
      });
    }

    const lineItems = po.po_line_items || [];
    if (lineItems.length === 0) {
      return NextResponse.json({ error: 'PO has no line items' }, { status: 400 });
    }

    // Step 1: Find the customer in NetSuite
    const customerResult = await findCustomer(po.customer);
    if (!customerResult.found || customerResult.customers.length === 0) {
      return NextResponse.json({
        error: `Customer "${po.customer}" not found in NetSuite. Please verify the customer exists.`,
        step: 'customer_lookup',
      }, { status: 400 });
    }

    // Use the first matching customer
    const nsCustomer = customerResult.customers[0];

    // Step 2: Look up item IDs in NetSuite by part number
    const partNumbers = lineItems.map((li: any) => li.part_number).filter(Boolean);
    const itemMap = await findItems(partNumbers);

    // Build line items — use NetSuite item IDs where found, skip unmatched
    const soLineItems: {
      itemId: string | number;
      quantity: number;
      rate: number;
      description?: string;
    }[] = [];

    const unmatchedParts: string[] = [];

    for (const li of lineItems) {
      const partKey = li.part_number?.toUpperCase();
      const nsItem = partKey ? itemMap[partKey] : null;

      if (nsItem) {
        soLineItems.push({
          itemId: nsItem.id,
          quantity: li.quantity,
          rate: li.unit_price,
          description: `PO #${po.po_number} - ${li.part_number}`,
        });
      } else {
        unmatchedParts.push(li.part_number);
      }
    }

    if (soLineItems.length === 0) {
      return NextResponse.json({
        error: `None of the PO line items matched items in NetSuite. Unmatched parts: ${unmatchedParts.join(', ')}`,
        step: 'item_lookup',
        unmatchedParts,
      }, { status: 400 });
    }

    // Step 3: Create the sales order
    const result = await createSalesOrder({
      customerId: nsCustomer.id,
      poNumber: po.po_number,
      memo: `Auto-created from BMG FleetSuite PO #${po.po_number}${po.notes ? ' - ' + po.notes : ''}`,
      lineItems: soLineItems,
    });

    if (!result.success) {
      return NextResponse.json({
        error: result.error || 'Failed to create sales order in NetSuite',
        step: 'create_so',
        customer: nsCustomer,
        lineItemCount: soLineItems.length,
      }, { status: 500 });
    }

    // Step 4: Save the NetSuite SO reference back to the PO
    await supabase
      .from('purchase_orders')
      .update({
        netsuite_so_id: result.salesOrderId,
        netsuite_so_number: result.salesOrderNumber || null,
      })
      .eq('id', poId);

    return NextResponse.json({
      status: 'created',
      salesOrderId: result.salesOrderId,
      salesOrderNumber: result.salesOrderNumber,
      customer: nsCustomer.name,
      lineItemCount: soLineItems.length,
      unmatchedParts: unmatchedParts.length > 0 ? unmatchedParts : undefined,
    });
  } catch (err: any) {
    console.error('Create NetSuite SO error:', err);
    return NextResponse.json({ error: err.message || 'Failed to create sales order' }, { status: 500 });
  }
}
