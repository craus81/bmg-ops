import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin, requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { resolveLaborItem } from '@/lib/labor-item';
import { suiteqlQuery } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';

/**
 * The NetSuite item estimates and sales orders bill shop labor to
 * (Settings -> NetSuite Labor Item).
 *
 * GET also answers the question staff actually ask -- "where is our labor
 * going?" -- by returning what the resolver picks right now and the other
 * LABOR items in the account. Reading is admin-only because it exposes
 * NetSuite item ids; writing is super-admin, like the sales tax rate: it
 * decides which GL account every labor dollar posts to.
 */

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const supabase = getSupabase();
  const { data: settings } = await supabase
    .from('quote_settings')
    .select('netsuite_labor_item_id, netsuite_labor_item_number')
    .eq('id', 1)
    .maybeSingle();

  const resolution = await resolveLaborItem(supabase);

  return NextResponse.json({
    configured_item_id: settings?.netsuite_labor_item_id || null,
    configured_item_number: settings?.netsuite_labor_item_number || null,
    resolved: resolution.item,
    reason: resolution.reason,
    error: resolution.error,
    candidates: resolution.candidates || [],
  });
}

const UpdateSchema = z.object({
  // The NetSuite item NAME (itemid), e.g. "Graphics Install Labor". Empty
  // clears the setting and falls back to the ranked search.
  item_number: z.string().max(120).nullable().optional(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;

  const supabase = getSupabase();
  const raw = (parsed.data.item_number || '').trim();

  const { data: before } = await supabase
    .from('quote_settings')
    .select('netsuite_labor_item_id, netsuite_labor_item_number')
    .eq('id', 1)
    .maybeSingle();

  if (!raw) {
    const { error } = await supabase.from('quote_settings').upsert({
      id: 1,
      netsuite_labor_item_id: null,
      netsuite_labor_item_number: null,
      updated_at: new Date().toISOString(),
      updated_by: auth.user.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'quote_settings',
      recordId: '1',
      action: 'labor_item_changed',
      detail: { from: before?.netsuite_labor_item_number || null, to: null },
    });
    return NextResponse.json({ configured_item_id: null, configured_item_number: null });
  }

  // The name goes into a SuiteQL string literal. Whitelist the characters a
  // NetSuite item name actually uses instead of trying to escape quotes.
  if (!/^[A-Za-z0-9 ._\-/&()#+]+$/.test(raw)) {
    return NextResponse.json({
      error: 'That does not look like a NetSuite item name — letters, digits, spaces and . _ - / & ( ) # + only.',
    }, { status: 400 });
  }

  // Resolve the name to the INTERNAL id: an item name in the id column 500s
  // every estimate that tries to use it (the same trap as CNI vendor bills).
  let match: { id: string; itemid: string } | null = null;
  try {
    const res = await suiteqlQuery(
      `SELECT i.id, i.itemid FROM item i WHERE UPPER(i.itemid) = '${raw.toUpperCase()}' AND i.isinactive = 'F' FETCH FIRST 1 ROWS ONLY`
    );
    const row = res?.items?.[0];
    if (row) match = { id: String(row.id), itemid: row.itemid || raw };
  } catch (err: any) {
    return NextResponse.json({ error: `NetSuite lookup failed: ${err?.message || err}` }, { status: 502 });
  }

  if (!match) {
    return NextResponse.json({
      error: `No active NetSuite item is named "${raw}". Use the exact item name as it appears in NetSuite.`,
    }, { status: 400 });
  }

  const { error } = await supabase.from('quote_settings').upsert({
    id: 1,
    netsuite_labor_item_id: match.id,
    netsuite_labor_item_number: match.itemid,
    updated_at: new Date().toISOString(),
    updated_by: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'quote_settings',
    recordId: '1',
    action: 'labor_item_changed',
    detail: {
      from: before?.netsuite_labor_item_number || null,
      to: match.itemid,
      netsuite_item_id: match.id,
    },
  });

  return NextResponse.json({ configured_item_id: match.id, configured_item_number: match.itemid });
}
