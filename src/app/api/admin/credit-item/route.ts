import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin, requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { CREDIT_ITEM_TYPES, CREDIT_ITEM_TYPE_WORDS, configuredCreditItem, creditItemCandidates } from '@/lib/credit-item';
import { suiteqlQuery } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

/**
 * The NetSuite item a credit memo credits money on when no part comes back
 * (Settings -> NetSuite Credit Item, migration 466, src/lib/credit-item.ts).
 * Same shape as ../discount-item: GET returns the item Settings names and
 * NetSuite's likely ones; reading is admin-only, writing super-admin, since
 * it decides which income account those credits come off.
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const supabase = createServiceClient();
  const [configured, found] = await Promise.all([configuredCreditItem(supabase), creditItemCandidates()]);
  return NextResponse.json({
    configured_item_id: configured?.id ?? null,
    configured_item_number: configured?.itemNumber ?? null,
    candidates: found.candidates,
    error: found.error,
  });
}

const UpdateSchema = z.object({
  // The NetSuite item NAME (itemid). Empty clears the setting.
  item_number: z.string().max(120).nullable().optional(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;

  const supabase = createServiceClient();
  const raw = (parsed.data.item_number || '').trim();
  const before = await configuredCreditItem(supabase);

  if (!raw) {
    const { error } = await supabase.from('quote_settings').upsert({
      id: 1,
      netsuite_credit_item_id: null,
      netsuite_credit_item_number: null,
      updated_at: new Date().toISOString(),
      updated_by: auth.user.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'quote_settings',
      recordId: '1',
      action: 'credit_item_changed',
      detail: { from: before?.itemNumber || null, to: null },
    });
    return NextResponse.json({ configured_item_id: null, configured_item_number: null });
  }

  // The name goes into a SuiteQL string literal. Whitelist the characters a
  // NetSuite item name actually uses instead of trying to escape quotes.
  if (!/^[A-Za-z0-9 ._\-/&()#+]+$/.test(raw)) {
    return NextResponse.json({
      error: 'That does not look like a NetSuite item name: letters, digits, spaces and . _ - / & ( ) # + only.',
    }, { status: 400 });
  }

  // Resolve the name to the INTERNAL id, and its type: a stock item would put parts back on the shelf.
  let match: { id: string; itemid: string; itemtype: string | null } | null = null;
  try {
    const res = await suiteqlQuery(
      `SELECT i.id, i.itemid, i.itemtype FROM item i WHERE UPPER(i.itemid) = '${raw.toUpperCase()}' AND i.isinactive = 'F' FETCH FIRST 1 ROWS ONLY`
    );
    const row = res?.items?.[0];
    if (row) match = { id: String(row.id), itemid: row.itemid || raw, itemtype: row.itemtype || null };
  } catch (err: any) {
    return NextResponse.json({ error: `NetSuite lookup failed: ${err?.message || err}` }, { status: 502 });
  }

  if (!match) {
    return NextResponse.json({
      error: `No active NetSuite item is named "${raw}". Use the exact item name as it appears in NetSuite.`,
    }, { status: 400 });
  }
  if (!CREDIT_ITEM_TYPES.has(String(match.itemtype || ''))) {
    return NextResponse.json({
      error: `${match.itemid} is ${match.itemtype ? `a ${match.itemtype} item` : 'an item of a type NetSuite didn\'t say'}. The credit item has to be ${CREDIT_ITEM_TYPE_WORDS}, so no part goes back on the shelf.`,
    }, { status: 400 });
  }

  const { error } = await supabase.from('quote_settings').upsert({
    id: 1,
    netsuite_credit_item_id: match.id,
    netsuite_credit_item_number: match.itemid,
    updated_at: new Date().toISOString(),
    updated_by: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'quote_settings',
    recordId: '1',
    action: 'credit_item_changed',
    detail: { from: before?.itemNumber || null, to: match.itemid, netsuite_item_id: match.id },
  });

  return NextResponse.json({ configured_item_id: match.id, configured_item_number: match.itemid });
}
