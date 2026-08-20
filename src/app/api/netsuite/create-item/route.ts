import { NextRequest, NextResponse } from 'next/server';
import { createItem, findItems, itemUrl, updateItemFields } from '@/lib/netsuite';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { partNumberPattern } from '@/lib/part-number';

export const dynamic = 'force-dynamic';
// NetSuite's REST record create plus the price RESTlet routinely take longer
// than the default function window; without this the request 504s mid-flight —
// often *after* NetSuite created the item but before the local mirror updated,
// which is how parts end up existing in NetSuite while still flagged local-only.
export const maxDuration = 60;

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
      return NextResponse.json({ success: true, alreadyExists: true, part: row, netsuiteUrl: itemUrl(row.netsuite_id!) });
    }
    upgradeTarget = row;
  } else {
    // Legacy data can hold several rows per item number (casing included) —
    // prefer any real NetSuite row, otherwise upgrade the first local one.
    const { data: rows } = await supabase
      .from('netsuite_parts')
      .select(PART_COLS)
      .ilike('item_number', partNumberPattern(partNumber));
    const real = (rows || []).find(r => isRealNsId(r.netsuite_id));
    if (real) {
      return NextResponse.json({ success: true, alreadyExists: true, part: real, netsuiteUrl: itemUrl(real.netsuite_id!) });
    }
    upgradeTarget = (rows || [])[0] || null;
  }

  // The local mirror only knows about items FleetSuite itself created — there
  // is no scheduled item sync — so check NetSuite directly before creating.
  // If the item already exists there, link it to the local row instead of
  // letting NetSuite reject the create with a duplicate-name error. This also
  // self-heals parts wrongly flagged as local-only.
  try {
    const found = (await findItems([partNumber]))[partNumber.toUpperCase()];
    if (found?.id) {
      const nsUrl = itemUrl(found.id);
      if (upgradeTarget) {
        const { data: linked } = await supabase
          .from('netsuite_parts')
          .update({
            netsuite_id: found.id,
            item_type: found.type || undefined,
            is_active: true,
            updated_at: new Date().toISOString(),
          })
          .eq('id', upgradeTarget.id)
          .select('id, item_number, display_name, billable_customer, sales_price')
          .single();
        return NextResponse.json({
          success: true,
          alreadyExists: true,
          linkedExisting: true,
          internalId: found.id,
          netsuiteUrl: nsUrl,
          part: linked || upgradeTarget,
        });
      }
      const { data: mirrored } = await supabase
        .from('netsuite_parts')
        .insert({
          netsuite_id: found.id,
          item_number: found.name || partNumber,
          display_name: found.displayName || displayName || partNumber,
          description: found.description || description || '',
          item_type: found.type || 'NonInvtPart',
          catalog: catalog || 'graphics',
          sales_price: salesPrice || 0,
          billable_customer: billableCustomer || null,
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .select('id, item_number, display_name, billable_customer, sales_price')
        .single();
      return NextResponse.json({
        success: true,
        alreadyExists: true,
        internalId: found.id,
        netsuiteUrl: nsUrl,
        part: mirrored || undefined,
      });
    }
  } catch (err: any) {
    // Lookup failure shouldn't block creation — NetSuite itself will still
    // reject a true duplicate, and that error is surfaced verbatim below.
    console.warn('NetSuite pre-create item lookup failed:', err?.message || err);
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

  // Push the sales price to NetSuite too. Base price lives in the item's
  // pricing matrix, which the REST record create can't set — the item RESTlet
  // writes it (same path as the catalog's inline price edit). Non-fatal: the
  // price is always stored locally, so a failure only means NetSuite shows $0
  // until the part's price is edited.
  let priceWarning: string | undefined;
  if (salesPrice != null && salesPrice > 0) {
    if (result.internalId) {
      const priceRes = await updateItemFields(result.internalId, { salesPrice });
      if (!priceRes.success) {
        priceWarning = `Item created, but setting its NetSuite sales price failed: ${priceRes.error}`;
      }
    } else {
      priceWarning = 'Item created, but NetSuite did not return its internal id, so the sales price could not be set there.';
    }
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
        priceWarning,
        mirrorWarning: `Created in NetSuite but linking the local catalog entry failed: ${updateError.message}`,
      });
    }

    return NextResponse.json({
      success: true,
      linkedExisting: true,
      netsuiteUrl: result.netsuiteUrl,
      internalId: result.internalId,
      priceWarning,
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
      priceWarning,
      mirrorWarning: `Created in NetSuite but local catalog sync failed: ${insertError.message}`,
    });
  }

  return NextResponse.json({
    success: true,
    netsuiteUrl: result.netsuiteUrl,
    internalId: result.internalId,
    priceWarning,
    part: inserted,
  });
}
