import { NextRequest, NextResponse } from 'next/server';
import { createSalesOrder, findLocation, suiteqlQuery } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { safeStringLiteral } from '@/lib/sql-safe';

const ConvertSchema = z.object({
  estimateId: z.string().uuid(),
});

/**
 * Resolve the NetSuite item id for the FS-CUSTOM placeholder used to land
 * custom estimate line items on the SO. Admins create the item once in NS
 * (Item Number = FS-CUSTOM, any NonInventory or Service item type) and any
 * estimate line without a netsuite_item_id is pushed as FS-CUSTOM with the
 * line's own description carrying the detail.
 */
async function findCustomItemId(): Promise<string | null> {
  try {
    const res = await suiteqlQuery(
      "SELECT i.id FROM item i WHERE UPPER(i.itemid) = 'FS-CUSTOM' FETCH FIRST 1 ROWS ONLY"
    );
    const id = res?.items?.[0]?.id;
    return id ? id.toString() : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ConvertSchema);
  if (parsed.error) return parsed.error;
  const { estimateId } = parsed.data;

  try {
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
      try {
        const safeName = safeStringLiteral(estimate.customer_name, 200);
        const result = await suiteqlQuery(
          `SELECT c.id FROM customer c WHERE UPPER(c.companyname) = UPPER('${safeName}') FETCH FIRST 1 ROWS ONLY`
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

    const lineItems = (estimate.estimate_line_items || [])
      .sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0));

    const soLineItems: { itemId: string; quantity: number; rate: number; description?: string }[] = [];
    const customLineDescriptions: string[] = [];
    const unmappedLineDescriptions: string[] = [];

    let customItemId: string | null = null;

    for (const li of lineItems) {
      if (li.netsuite_item_id) {
        const lineDesc = [li.description, li.notes].filter(Boolean).join(' — ')
          || li.item_number
          || undefined;
        soLineItems.push({
          itemId: li.netsuite_item_id,
          quantity: parseFloat(li.quantity) || 1,
          rate: parseFloat(li.unit_price) || 0,
          description: lineDesc,
        });
        continue;
      }

      // Custom line — route through the FS-CUSTOM placeholder item. Admin
      // must create the item in NS (Item Number = FS-CUSTOM) before the
      // first custom push.
      if (customItemId === null) customItemId = await findCustomItemId();
      if (!customItemId) {
        unmappedLineDescriptions.push(li.item_number || li.description || 'Custom item');
        continue;
      }

      const label = li.item_number
        ? `${li.item_number}${li.description ? ' — ' + li.description : ''}`
        : (li.description || 'Custom item');
      const fullDesc = li.notes ? `${label} (${li.notes})` : label;
      soLineItems.push({
        itemId: customItemId,
        quantity: parseFloat(li.quantity) || 1,
        rate: parseFloat(li.unit_price) || 0,
        description: fullDesc,
      });
      customLineDescriptions.push(label);
    }

    // Add labor as a line item if there are labor hours
    const laborHours = parseFloat(estimate.labor_hours_override ?? estimate.labor_hours) || 0;
    const laborRate = parseFloat(estimate.labor_rate) || 85;
    if (laborHours > 0) {
      try {
        const laborResult = await suiteqlQuery(
          "SELECT i.id FROM item i WHERE UPPER(i.itemid) LIKE 'LABOR%' FETCH FIRST 1 ROWS ONLY"
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
        error: 'No line items could be mapped to NetSuite. Ensure parts have NetSuite item IDs or create the FS-CUSTOM placeholder item in NetSuite.',
        step: 'line_items',
        unmappedLines: unmappedLineDescriptions,
      }, { status: 400 });
    }

    // Build a richer SO memo that preserves the sales rep's notes +
    // install context instead of the old hardcoded boilerplate. Installer-
    // visible install context still lives on FleetSuite's purchase_orders
    // + fleet_checkins records; copying it into the NS memo keeps a
    // durable customer-facing reference on the SO itself.
    const memoParts: string[] = [];
    if (estimate.title) memoParts.push(estimate.title.trim());
    if (estimate.notes?.trim()) memoParts.push(estimate.notes.trim());
    const ctxLines: string[] = [];
    if (estimate.install_instructions?.trim()) ctxLines.push(`Install: ${estimate.install_instructions.trim()}`);
    if (estimate.delivery_preferences?.trim()) ctxLines.push(`Delivery: ${estimate.delivery_preferences.trim()}`);
    const onSite = [estimate.on_site_contact_name, estimate.on_site_contact_phone].filter(Boolean).join(' ');
    if (onSite) ctxLines.push(`On-site: ${onSite}`);
    if (ctxLines.length > 0) memoParts.push(ctxLines.join(' · '));
    memoParts.push(`FleetSuite Estimate #${estimate.estimate_number}`);
    const memo = memoParts.join('\n');

    const nsLocation = await findLocation("O'Fallon");

    const result = await createSalesOrder({
      customerId,
      poNumber: estimate.estimate_number,
      locationId: nsLocation?.id,
      memo,
      lineItems: soLineItems,
    });

    if (!result.success) {
      return NextResponse.json({
        error: result.error || 'Failed to create Sales Order in NetSuite',
        step: 'create_so',
      }, { status: 500 });
    }

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
      customLineCount: customLineDescriptions.length,
      customLines: customLineDescriptions.length > 0 ? customLineDescriptions : undefined,
      unmappedLines: unmappedLineDescriptions.length > 0 ? unmappedLineDescriptions : undefined,
      memoUsed: memo,
    });
  } catch (err: any) {
    console.error('Convert estimate to SO error:', err);
    return NextResponse.json({ error: err.message || 'Failed to convert estimate' }, { status: 500 });
  }
}
