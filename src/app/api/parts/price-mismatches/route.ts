import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { logAudit } from '@/lib/audit';
import { recordHeartbeat } from '@/lib/system-health';
import { isRealNetsuiteId, writePricesToNetsuite } from '@/lib/part-netsuite-write';
import { PRICE_MISMATCH_SYNC, clearMismatch, noteRefusedPrice, runPriceMismatchCheck } from '@/lib/price-mismatch';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createServiceClient();

interface MismatchRow {
  part_id: string;
  item_number: string;
  fleetsuite_price: number | string | null;
  netsuite_price: number | string | null;
  reason: string | null;
  first_seen_at: string;
  checked_at: string;
}

async function list() {
  const [{ data: rows, error }, { data: state }] = await Promise.all([
    fetchAllRows<MismatchRow>((from, to) =>
      supabase.from('part_price_mismatches')
        .select('part_id, item_number, fleetsuite_price, netsuite_price, reason, first_seen_at, checked_at')
        .order('item_number').order('part_id')
        .range(from, to),
    ),
    supabase.from('sync_state').select('last_synced_at, last_result').eq('sync_type', PRICE_MISMATCH_SYNC).maybeSingle(),
  ]);
  if (error) throw new Error(`Couldn't read the list: ${error.message}`);
  const ids = rows.map(r => r.part_id);
  const names = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('netsuite_parts').select('id, display_name').in('id', ids.slice(i, i + 200));
    (data || []).forEach((p: any) => names.set(p.id, p.display_name ?? null));
  }
  return {
    mismatches: rows.map(r => ({
      partId: r.part_id,
      partNumber: r.item_number,
      displayName: names.get(r.part_id) ?? null,
      fleetsuitePrice: r.fleetsuite_price === null ? null : Number(r.fleetsuite_price),
      netsuitePrice: r.netsuite_price === null ? null : Number(r.netsuite_price),
      reason: r.reason,
      firstSeenAt: r.first_seen_at,
    })),
    lastCheck: state ? { at: (state as any).last_synced_at as string | null, result: (state as any).last_result ?? null } : null,
  };
}

/** GET /api/parts/price-mismatches: the parts whose FleetSuite and NetSuite prices differ, and the last check. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  try {
    return NextResponse.json(await list());
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Couldn’t read the list' }, { status: 500 });
  }
}

const Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check') }),
  z.object({ action: z.enum(['send', 'use']), partIds: z.array(z.string().uuid()).min(1).max(25) }),
]);

/**
 * POST /api/parts/price-mismatches:
 *   check — compare every part with NetSuite now (as the nightly check does);
 *   send  — put FleetSuite's price in NetSuite for these parts (25 at most);
 *   use   — take NetSuite's price into FleetSuite for these parts, for a price
 *           someone changed in NetSuite on purpose.
 * Answers with the list as it now stands, plus any parts that failed.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    if (body.action === 'check') {
      const startedAt = Date.now();
      const out = await runPriceMismatchCheck(supabase);
      await recordHeartbeat(supabase, PRICE_MISMATCH_SYNC, { checked: out.checked, mismatches: out.mismatches, by: 'check_now' }, { startedAt, records: out.checked });
      return NextResponse.json({ ...(await list()), failed: [] });
    }

    const { data: rows, error } = await supabase.from('part_price_mismatches')
      .select('part_id, item_number, fleetsuite_price, netsuite_price')
      .in('part_id', body.partIds);
    if (error) throw new Error(error.message);
    const { data: parts, error: pErr } = await supabase.from('netsuite_parts')
      .select('id, netsuite_id, item_number, sales_price')
      .in('id', body.partIds);
    if (pErr) throw new Error(pErr.message);
    const partById = new Map((parts || []).map((p: any) => [p.id as string, p]));
    const failed: { partNumber: string; error: string }[] = [];

    for (const m of (rows || []) as any[]) {
      const part = partById.get(m.part_id);
      if (!part) { await clearMismatch(supabase, [m.part_id]); continue; }

      if (body.action === 'send') {
        const price = Number(part.sales_price) || 0;
        if (price <= 0 || !isRealNetsuiteId(part.netsuite_id)) { failed.push({ partNumber: m.item_number, error: 'This part has no FleetSuite price or isn’t a NetSuite item.' }); continue; }
        const out = await writePricesToNetsuite(part.netsuite_id, { sales_price: price });
        if (out.notInNetsuite.length > 0) {
          failed.push({ partNumber: m.item_number, error: out.reason || 'NetSuite didn’t take it.' });
          await noteRefusedPrice(supabase, { part_id: m.part_id, item_number: m.item_number, fleetsuite_price: price, netsuite_price: m.netsuite_price === null ? null : Number(m.netsuite_price), reason: `NetSuite didn't take it. ${out.reason || ''}`.trim() });
          continue;
        }
        await clearMismatch(supabase, [m.part_id]);
        await logAudit(supabase, { actorId: auth.user.id, table: 'netsuite_parts', recordId: m.part_id, action: 'update', detail: { item_number: m.item_number, via: 'price_mismatch_send', netsuite_price_before: m.netsuite_price, sent: price } });
      } else {
        const ns = m.netsuite_price === null ? null : Number(m.netsuite_price);
        if (ns === null || ns <= 0) { failed.push({ partNumber: m.item_number, error: 'NetSuite has no price for this part, so there’s nothing to take.' }); continue; }
        // Every catalog row with this part number, as an upload would.
        const { error: upErr } = await supabase.from('netsuite_parts')
          .update({ sales_price: ns, updated_at: new Date().toISOString() })
          .ilike('item_number', String(part.item_number).replace(/([%_\\])/g, '\\$1'));
        if (upErr) { failed.push({ partNumber: m.item_number, error: upErr.message }); continue; }
        await clearMismatch(supabase, [m.part_id]);
        await logAudit(supabase, { actorId: auth.user.id, table: 'netsuite_parts', recordId: m.part_id, action: 'update', detail: { item_number: m.item_number, via: 'price_mismatch_use_netsuite', before: { sales_price: Number(part.sales_price) }, after: { sales_price: ns } } });
      }
    }

    return NextResponse.json({ ...(await list()), failed });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'That didn’t work' }, { status: 500 });
  }
}
