import { NextRequest, NextResponse } from 'next/server';
import { createItem } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

// REST record types we allow callers to create. Keeps the path segment
// constrained to a known set rather than free text.
const ITEM_RECORD_TYPES = [
  'serviceSaleItem',
  'serviceResaleItem',
  'nonInventorySaleItem',
  'nonInventoryResaleItem',
  'inventoryItem',
] as const;

const Schema = z.object({
  partNumber: z.string().trim().min(1).max(120),
  recordType: z.enum(ITEM_RECORD_TYPES),
  displayName: z.string().max(300).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  salesPrice: z.number().nonnegative().optional().nullable(),
  catalog: z.enum(['upfit', 'graphics']).optional().nullable(),
  billableCustomer: z.string().max(200).optional().nullable(),
  // Local netsuite_parts row to link to the new NetSuite record (catalog flow:
  // the part already exists in FleetSuite, so upgrade that row in place).
  existingPartId: z.string().uuid().optional().nullable(),
});

// A row whose netsuite_id is a LOCAL-/bmg- placeholder was never created in
// NetSuite — only a numeric internal id counts as a real NetSuite part.
const isRealNsId = (id: string | null) => !!id && !/^(LOCAL-|bmg-)/i.test(id);

const PART_COLS = 'id, netsuite_id, item_number, display_name, billable_customer, sales_price';

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { partNumber, recordType, displayName, description, salesPrice, catalog, billableCustomer, existingPartId } = parsed.data;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Figure out whether this part already exists locally, and in what form.
  // A row with a real NetSuite id means the item is already in NetSuite — bail.
  // A local-only row (LOCAL-/bmg- placeholder id) becomes the upgrade target:
  // we create the NetSuite record and link it to that row instead of inserting
  // a duplicate.
  let upgradeTarget: { id: string; netsuite_id: string | null } | null = null;
  if (existingPartId) {
    const { data: row } = await supabase
      .from('netsuite_parts')
      .select(PART_COLS)
      .eq('id', existingPartId)
      .maybeSingle();
    if (!row) {
      return NextResponse.json({ success: false, error: 'Part not found' }, { status: 404 });
    }
    if (isRealNsId(row.netsuite_id)) {
      return NextResponse.json({ success: true, alreadyExists: true, part: row });
    }
    upgradeTarget = row;
  } else {
    // Legacy data can hold several rows per item number — prefer any real
    // NetSuite row, otherwise upgrade the first local one.
    const { data: rows } = await supabase
      .from('netsuite_parts')
      .select(PART_COLS)
      .eq('item_number', partNumber);
    const real = (rows || []).find(r => isRealNsId(r.netsuite_id));
    if (real) {
      return NextResponse.json({ success: true, alreadyExists: true, part: real });
    }
    upgradeTarget = (rows || [])[0] || null;
  }

  // Create the item in NetSuite (minimal fields; surfaces NS error verbatim)
  const result = await createItem({
    itemId: partNumber,
    recordType,
    displayName: displayName || partNumber,
    description: description || undefined,
  });

  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 502 });
  }

  // Mirror into netsuite_parts so the new item is immediately matchable in
  // PO import, scans, estimates, etc. without waiting for the next full sync.
  const itemType = recordType.startsWith('service')
    ? 'Service'
    : recordType.startsWith('inventory')
      ? 'InvtPart'
      : 'NonInvtPart';

  if (upgradeTarget) {
    // Link the NetSuite record to the existing local row. Only overwrite
    // optional fields the caller actually supplied.
    const { data: updated, error: updateError } = await supabase
      .from('netsuite_parts')
      .update({
        netsuite_id: result.internalId || upgradeTarget.netsuite_id,
        item_number: partNumber,
        item_type: itemType,
        is_active: true,
        ...(displayName ? { display_name: displayName } : {}),
        ...(description ? { description } : {}),
        ...(salesPrice != null ? { sales_price: salesPrice } : {}),
        ...(billableCustomer ? { billable_customer: billableCustomer } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', upgradeTarget.id)
      .select('id, item_number, display_name, billable_customer, sales_price')
      .single();

    if (updateError) {
      return NextResponse.json({
        success: true,
        netsuiteUrl: result.netsuiteUrl,
        internalId: result.internalId,
        mirrorWarning: `Created in NetSuite but linking the local catalog entry failed: ${updateError.message}`,
      });
    }

    return NextResponse.json({
      success: true,
      linkedExisting: true,
      netsuiteUrl: result.netsuiteUrl,
      internalId: result.internalId,
      part: updated,
    });
  }

  const { data: inserted, error: insertError } = await supabase
    .from('netsuite_parts')
    .insert({
      netsuite_id: result.internalId || `bmg-${crypto.randomUUID()}`,
      item_number: partNumber,
      display_name: displayName || partNumber,
      description: description || displayName || '',
      item_type: itemType,
      catalog: catalog || 'graphics',
      sales_price: salesPrice || 0,
      billable_customer: billableCustomer || null,
      is_active: true,
      updated_at: new Date().toISOString(),
    })
    .select('id, item_number, display_name, billable_customer, sales_price')
    .single();

  if (insertError) {
    // The item exists in NetSuite even though the local mirror failed — say so.
    return NextResponse.json({
      success: true,
      netsuiteUrl: result.netsuiteUrl,
      internalId: result.internalId,
      mirrorWarning: `Created in NetSuite but local catalog sync failed: ${insertError.message}`,
    });
  }

  return NextResponse.json({
    success: true,
    netsuiteUrl: result.netsuiteUrl,
    internalId: result.internalId,
    part: inserted,
  });
}
