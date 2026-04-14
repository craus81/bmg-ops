import { NextRequest, NextResponse } from 'next/server';
import { createSalesOrder, findLocation, suiteqlQuery } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { estimateId } = await req.json();
    if (!estimateId) {
      return NextResponse.json({ error: 'estimateId required' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Load estimate with line items
    const { data: estimate, error: estError } = await supabase
      .from('estimates')
      .select('*, estimate_line_items(*)')
      .eq('id', estimateId)
      .single();

    if (estError || !estimate) {
      return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    }

    // Check if already converted
    if (estimate.netsuite_so_id) {
      return NextResponse.json({
        status: 'already_created',
        salesOrderId: estimate.netsuite_so_id,
        salesOrderNumber: estimate.netsuite_so_number || '',
        message: `Sales Order already exists (SO #${estimate.netsuite_so_number || estimate.netsuite_so_id})`,
      });
    }

    // Verify we have a customer NetSuite ID
    let customerId = estimate.customer_netsuite_id;
    if (!customerId && estimate.customer_name) {
      // Try to find customer by name as fallback
      try {
        const result = await suiteqlQuery(
          `SELECT c.id FROM customer c WHERE UPPER(c.companyname) = UPPER('${estimate.customer_name.replace(/'/g, "''")}') FETCH FIRST 1 ROWS ONLY`
        );
        if (result?.items?.[0]?.id) {
          customerId = result.items[0].id.toString();
        }
      } catch { /* fallback failed */ }
    }

    if (!customerId) {
      return NextResponse.json({
        error: 'No NetSuite customer ID on this estimate. Select a customer that has been synced from NetSuite.',
        step: 'customer',
      }, { status: 400 });
    }

    // Build line items from estimate
    const lineItems = (estimate.estimate_line_items || [])
      .sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0));

    const soLineItems: { itemId: string; quantity: number; rate: number; description?: string }[] = [];
    const skippedItems: string[] = [];

    for (const li of lineItems) {
      if (li.netsuite_item_id) {
        soLineItems.push({
          itemId: li.netsuite_item_id,
          quantity: parseFloat(li.quantity) || 1,
          rate: parseFloat(li.unit_price) || 0,
          description: li.description || li.item_number || undefined,
        });
      } else {
        skippedItems.push(li.item_number || li.description || 'Custom item');
      }
    }

    // Add labor as a line item if there are labor hours
    const laborHours = parseFloat(estimate.labor_hours_override ?? estimate.labor_hours) || 0;
    const laborRate = parseFloat(estimate.labor_rate) || 85;
    if (laborHours > 0) {
      // Look up the LABOR item in NetSuite
      try {
        const laborResult = await suiteqlQuery(
          `SELECT i.id FROM item i WHERE UPPER(i.itemid) LIKE 'LABOR%' FETCH FIRST 1 ROWS ONLY`
        );
        if (laborResult?.items?.[0]?.id) {
          soLineItems.push({
            itemId: laborResult.items[0].id.toString(),
            quantity: laborHours,
            rate: laborRate,
            description: `Labor - ${laborHours} hrs @ $${laborRate}/hr`,
          });
        }
      } catch { /* no labor item found, skip */ }
    }

    if (soLineItems.length === 0) {
      return NextResponse.json({
        error: 'No line items could be mapped to NetSuite. Ensure parts have NetSuite item IDs.',
        step: 'line_items',
        skippedItems,
      }, { status: 400 });
    }

    // Look up default location
    const nsLocation = await findLocation("O'Fallon");

    // Create the Sales Order
    const result = await createSalesOrder({
      customerId,
      poNumber: estimate.estimate_number,
      locationId: nsLocation?.id,
      memo: `Created from FleetSuite Estimate #${estimate.estimate_number}${estimate.title ? ' - ' + estimate.title : ''}`,
      lineItems: soLineItems,
    });

    if (!result.success) {
      return NextResponse.json({
        error: result.error || 'Failed to create Sales Order in NetSuite',
        step: 'create_so',
      }, { status: 500 });
    }

    // Save the SO reference back to the estimate
    await supabase
      .from('estimates')
      .update({
        netsuite_so_id: result.salesOrderId,
        netsuite_so_number: result.salesOrderNumber || null,
        status: 'accepted',
      })
      .eq('id', estimateId);

    return NextResponse.json({
      status: 'created',
      salesOrderId: result.salesOrderId,
      salesOrderNumber: result.salesOrderNumber,
      lineItemCount: soLineItems.length,
      skippedItems: skippedItems.length > 0 ? skippedItems : undefined,
    });
  } catch (err: any) {
    console.error('Convert estimate to SO error:', err);
    return NextResponse.json({ error: err.message || 'Failed to convert estimate' }, { status: 500 });
  }
}
