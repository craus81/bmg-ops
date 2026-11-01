import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { readSwitch } from '@/lib/books/switches';
import { adjustInventory, type AdjustResult } from '@/lib/inventory-adjust';
import {
  ASK_COLUMNS, NOT_NOW_TEXT, NUMBER_MAX, OPEN_STATUSES, WHY_MAX, approvedByName, askFromRow, leavesUnsure, sentence,
  type AdjustmentAsk, type AskStatus,
} from '@/lib/inventory-adjust-approvals';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Adjustments to approve (Books part 63, migration 494, src/lib/inventory-adjust-approvals.ts,
 * page /admin/inventory/approvals): once approving adjustments is switched on in Books → Switches, each adjustment
 * made with Adjust waits here.
 *
 * GET ?status=1 — whether it's switched on, how many aren't decided, and whether the caller approves, for the
 *     Inventory page's link.
 * GET — the ones not decided, oldest first, and the 30 decided last.
 * POST { action: 'approve', id } — a super admin who didn't ask: posts it in NetSuite as Adjust does, as the change
 *        worked out when it was asked.
 *      { action: 'turn_down', id, why } — a super admin who didn't ask, saying why, which whoever asked sees.
 *      { action: 'withdraw', id } — whoever asked, while it waits.
 *      { action: 'settle', id, made, number? } — a super admin, for one NetSuite didn't say about: it's in NetSuite,
 *        or it isn't and waits again.
 *
 * Admins open it, as Adjust. Ones asked while it was on are approved or turned down after it's switched off too.
 * Nobody is alerted (Craig, 2026-10-30: no alerts for adjustments).
 */

const DECIDED: AskStatus[] = ['made', 'turned_down', 'withdrawn'];

type Row = Record<string, unknown>;

/** The asks, each with its part's name from FleetSuite's parts list. */
async function withNames(rows: Row[]): Promise<AdjustmentAsk[]> {
  const ids = [...new Set(rows.map((r) => r.part_id).filter((id): id is string => typeof id === 'string'))];
  const names = new Map<string, string | null>();
  if (ids.length) {
    const { data, error } = await service.from('netsuite_parts').select('id, display_name').in('id', ids);
    if (error) throw new Error(`couldn't read the parts list (${error.message})`);
    for (const p of (data ?? []) as Array<{ id: string; display_name: string | null }>) names.set(p.id, p.display_name);
  }
  return rows.map((r) => askFromRow(r, names.get(String(r.part_id)) ?? null));
}

/** Whether it's switched on, or null when that can't be read. */
async function switchedOn(): Promise<boolean | null> {
  try {
    return await readSwitch(service, 'adjustment_approvals');
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const superAdmin = getProfileRoles(auth.profile).includes('super_admin');

  try {
    if (req.nextUrl.searchParams.get('status') === '1') {
      const { data, error } = await service.from('inventory_adjustment_asks').select('id').in('status', [...OPEN_STATUSES]).limit(1000);
      if (error) throw new Error(error.message);
      return NextResponse.json({ on: await switchedOn(), open: (data ?? []).length, canApprove: superAdmin });
    }
    const [open, decided] = await Promise.all([
      service.from('inventory_adjustment_asks').select(ASK_COLUMNS).in('status', [...OPEN_STATUSES])
        .order('asked_at', { ascending: true }).order('id', { ascending: true }).limit(1000),
      service.from('inventory_adjustment_asks').select(ASK_COLUMNS).in('status', DECIDED)
        .order('decided_at', { ascending: false }).order('id', { ascending: false }).limit(30),
    ]);
    if (open.error) throw new Error(open.error.message);
    if (decided.error) throw new Error(decided.error.message);
    return NextResponse.json({
      on: await switchedOn(),
      superAdmin,
      me: auth.user!.id,
      open: await withNames((open.data ?? []) as unknown as Row[]),
      decided: await withNames((decided.data ?? []) as unknown as Row[]),
    });
  } catch (err: any) {
    return NextResponse.json({ error: `Couldn't read the adjustments asked for: ${err?.message || String(err)}` }, { status: 500 });
  }
}

const Schema = z.object({
  action: z.enum(['approve', 'turn_down', 'withdraw', 'settle']),
  id: z.string().uuid(),
  why: z.string().max(2000).optional(),
  made: z.boolean().optional(),
  number: z.string().max(200).optional(),
});

type Answer = { state: string; ask?: Row; settled?: boolean };

async function rpc(fn: string, p: Record<string, unknown>): Promise<Answer & Record<string, unknown>> {
  const { data, error } = await service.rpc(fn, { p });
  if (error) throw new Error(error.message);
  return data as Answer & Record<string, unknown>;
}

const refusal = (state: string, own: string, status = 409): NextResponse => {
  if (state === 'gone') return NextResponse.json({ error: "That adjustment isn't there any more." }, { status: 404 });
  if (state === 'own' || state === 'not_yours') return NextResponse.json({ error: own }, { status: 403 });
  return NextResponse.json({ error: NOT_NOW_TEXT[state as AskStatus] ?? `It's ${state}.` }, { status });
};

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const superAdmin = getProfileRoles(auth.profile).includes('super_admin');
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { action, id } = parsed.data;
  const me = auth.user!.id;
  const myName = auth.profile?.full_name || null;
  if (action !== 'withdraw' && !superAdmin) {
    return NextResponse.json({ error: 'Only a super admin approves, turns down or settles an adjustment.' }, { status: 403 });
  }

  try {
    if (action === 'approve') return await approve(id, me, myName);

    if (action === 'turn_down') {
      const why = (parsed.data.why ?? '').trim();
      if (!why) return NextResponse.json({ error: 'Say why it is turned down.' }, { status: 400 });
      if (why.length > WHY_MAX) return NextResponse.json({ error: `Keep why to ${WHY_MAX} characters.` }, { status: 400 });
      const answer = await rpc('inventory_adjustment_turn_down', { id, by: me, by_name: myName, why });
      if (answer.state !== 'turned_down') return refusal(answer.state, 'You asked for this one, so withdraw it instead.');
      const ask = askFromRow(answer.ask!);
      await audit(me, ask, 'turn_down', { why });
      return NextResponse.json({ ask });
    }

    if (action === 'withdraw') {
      const answer = await rpc('inventory_adjustment_withdraw', { id, by: me, by_name: myName });
      if (answer.state !== 'withdrawn') {
        return refusal(answer.state, 'Only whoever asked withdraws it. A super admin turns it down instead.');
      }
      const ask = askFromRow(answer.ask!);
      await audit(me, ask, 'withdraw');
      return NextResponse.json({ ask });
    }

    // settle
    const made = parsed.data.made;
    if (typeof made !== 'boolean') return NextResponse.json({ error: "Say whether it's in NetSuite." }, { status: 400 });
    const number = (parsed.data.number ?? '').trim();
    if (number.length > NUMBER_MAX) return NextResponse.json({ error: `Keep NetSuite's number to ${NUMBER_MAX} characters.` }, { status: 400 });
    const answer = await rpc('inventory_adjustment_settle', { id, by: me, by_name: myName, made, netsuite_number: number || null });
    if (!answer.settled) {
      if (answer.state !== 'not_yet') return refusal(answer.state, '');
      return NextResponse.json({
        error: "It's still being posted. If it's still stuck five minutes after it was approved, say then whether it's in NetSuite.",
      }, { status: 409 });
    }
    const ask = askFromRow(answer.ask!);
    await audit(me, ask, made ? 'settle_made' : 'settle_not_made', made ? { netsuite_number: ask.netsuiteNumber } : {});
    return NextResponse.json({ ask });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

/**
 * Approves one: claims it for this press, posts it as Adjust does, as the change worked out when it was asked, and
 * keeps what NetSuite said: made, refused (back to wait, with why), or not known (for a super admin to settle).
 */
async function approve(id: string, me: string, myName: string | null): Promise<NextResponse> {
  const claim = await rpc('inventory_adjustment_claim', { id, by: me, by_name: myName });
  if (claim.state !== 'claimed') {
    return refusal(claim.state, 'You asked for this one, so a super admin who didn\'t ask approves it.');
  }
  const ask = askFromRow(claim.ask!);

  let result: AdjustResult;
  try {
    result = await adjustInventory(service, {
      netsuiteId: ask.netsuiteItemId,
      mode: 'delta',
      qty: ask.change,
      reason: ask.reason,
      note: ask.note,
      userId: ask.askedBy ?? me,
      userName: approvedByName(ask.askedByName, myName),
    });
  } catch (e: any) {
    result = { ok: false, status: 502, error: `Couldn't reach NetSuite: ${e?.message || String(e)}` };
  }

  if (result.ok) {
    let warning = result.warning ?? null;
    try {
      const kept = await rpc('inventory_adjustment_made', { id, netsuite_number: result.adjustmentNumber, warning });
      if (!kept.made) warning = 'NetSuite posted it, but someone had settled it meanwhile. Check it on Adjustments to approve.';
    } catch (e: any) {
      warning = `NetSuite posted it, but FleetSuite couldn't keep that (${e?.message || String(e)}). Five minutes after it was approved, `
        + "say it's in NetSuite on Adjustments to approve.";
    }
    await audit(me, ask, 'approve', { netsuite_number: result.adjustmentNumber });
    return NextResponse.json({
      made: true, adjustmentNumber: result.adjustmentNumber, onHand: result.onHand, available: result.available,
      ...(warning ? { warning } : {}),
    });
  }

  if (leavesUnsure(result.error)) {
    let kept = true;
    try {
      kept = !!(await rpc('inventory_adjustment_unsure', { id, error: result.error })).unsure;
    } catch {
      kept = false;
    }
    await audit(me, ask, 'approve_unsure');
    return NextResponse.json({
      unsure: true,
      error: `${sentence(result.error)} NetSuite may have posted it. Check NetSuite's inventory adjustments for ${ask.itemNumber}, then say `
        + `whether it's there${kept ? '.' : ' once five minutes have passed.'}`,
    }, { status: 502 });
  }

  try {
    await rpc('inventory_adjustment_let_go', { id, error: result.error });
  } catch {
    return NextResponse.json({
      error: `${sentence(result.error)} Nothing was posted, but FleetSuite couldn't put it back to wait. Five minutes after it was approved, `
        + "say it isn't in NetSuite on Adjustments to approve.",
    }, { status: result.status });
  }
  return NextResponse.json({ error: `${sentence(result.error)} Nothing was posted, and it's waiting for approval again.` }, { status: result.status });
}

async function audit(me: string, ask: AdjustmentAsk, action: string, more: Record<string, unknown> = {}) {
  await logAudit(service, {
    actorId: me,
    table: 'inventory_adjustment_asks',
    recordId: ask.id,
    action,
    detail: { item_number: ask.itemNumber, mode: ask.mode, change: ask.change, reason: ask.reason, ...more },
  });
}
