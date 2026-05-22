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
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { partNumber, recordType, displayName, description, salesPrice, catalog, billableCustomer } = parsed.data;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Don't create a duplicate if the part already exists locally
  const { data: existing } = await supabase
    .from('netsuite_parts')
    .select('id, item_number, display_name, billable_customer, sales_price')
    .eq('item_number', partNumber)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ success: true, alreadyExists: true, part: existing });
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
