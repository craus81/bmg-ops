import type { SupabaseClient } from '@supabase/supabase-js';
import { shopWorkMs } from './shop-hours';
import { loadShopPayrollRate } from './payroll-rates';

/**
 * Shop labor capture (R3-21, owner decisions 2026-09-07): 'shop'-context
 * work_shifts are start/stop timers on ONE check-in, run from the pick-list
 * page. They exist for JOB COSTING ONLY — they never write install_credits
 * (shop techs are hourly employees paid through the punch clock), and the
 * time_entries day clock is untouched.
 *
 * Hours are pure presence overlap: a member's hours on a shift are the
 * intersection of the shift interval with their membership window
 * (added_at → removed_at). share_weight is a piece-rate concept and plays
 * no part here. Cost = total member-hours × the shop cost rate
 * (getShopLaborCostBasis): the pooled Paychex rate when payroll is uploaded
 * and linked (src/lib/payroll-rates.ts, migration 340), else the blended
 * quote_settings.shop_labor_cost_rate (Settings → Shop Labor Cost Rate);
 * with neither, the margin report shows hours but excludes labor from the
 * math, saying so.
 *
 * Shop clock (owner rules 2026-10-02): a shop timer counts only shop
 * hours — weekdays 7:00 AM–3:30 PM Central less lunch (src/lib/shop-hours.ts).
 * Outside them it is paused, not stopped, so one timer can span the days a
 * vehicle is in the bay and finishing the completion procedure is the
 * normal way it ends. A tech who moves to another task pauses themselves
 * (leaves the crew); tagging a tech onto a job moves them off any other
 * running shop job.
 *
 * Timers are only as accurate as button-pressing, so hours from shifts the
 * sweep had to end are reported separately as approximate.
 */

/** Cap the daily sweep writes when closing a forgotten print-room timer.
 *  Shop timers are exempt: they pause off-hours and run until completion. */
export const SHOP_SHIFT_MAX_HOURS = 12;
/** The sweep closes open print-room shifts older than this. */
export const SHOP_SHIFT_STALE_HOURS = 14;

export interface MemberWindow {
  profile_id: string;
  added_at: string | null;
  removed_at: string | null;
}

/**
 * Presence-overlap hours per member for one shift interval. Pure math so the
 * tests can pin it: clamp each member's window to [start, end], never
 * negative; a missing added_at counts from shift start. With `shopClock`
 * (shop-context shifts) only shop hours inside that overlap count.
 */
export function shiftMemberHours(
  startedAt: string,
  endedAt: string,
  members: MemberWindow[],
  opts: { shopClock?: boolean } = {},
): Map<string, number> {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  const out = new Map<string, number>();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    for (const m of members) out.set(m.profile_id, out.get(m.profile_id) || 0);
    return out;
  }
  for (const m of members) {
    const from = Math.max(start, m.added_at ? Date.parse(m.added_at) : start);
    const to = Math.min(end, m.removed_at ? Date.parse(m.removed_at) : end);
    const ms = opts.shopClock ? shopWorkMs(from, to) : to - from;
    const hours = Math.max(0, ms / 3_600_000);
    out.set(m.profile_id, (out.get(m.profile_id) || 0) + hours);
  }
  return out;
}

/** Σ member-hours for one shift. */
export function totalShiftHours(
  startedAt: string,
  endedAt: string,
  members: MemberWindow[],
  opts: { shopClock?: boolean } = {},
): number {
  let total = 0;
  for (const h of shiftMemberHours(startedAt, endedAt, members, opts).values()) total += h;
  return total;
}

/** The blended hourly cost rate, or null when unset (migration 269). */
export async function getShopLaborRate(service: SupabaseClient): Promise<number | null> {
  const { data, error } = await service
    .from('quote_settings')
    .select('shop_labor_cost_rate')
    .eq('id', 1)
    .maybeSingle();
  // Schema-cache grace (#741 lesson): a cache that hasn't seen 269 yet
  // reads as "no rate configured" instead of failing the report.
  if (error) {
    console.warn('getShopLaborRate read failed (schema cache?):', error.message);
    return null;
  }
  const rate = data?.shop_labor_cost_rate;
  return rate != null ? Number(rate) : null;
}

export interface ShopLaborCostBasis {
  rate: number | null;
  /** 'paychex' = pooled payroll rate; 'setting' = the blended rate typed in Settings. */
  source: 'paychex' | 'setting' | null;
  /** Paychex basis only: how many people's paychecks fed it, and through when. */
  people?: number;
  throughPeriodEnd?: string;
}

/**
 * The rate shop hours are costed at. Paychex first (real payroll, pooled so
 * no one person's pay can be read back out of a job); the blended Settings
 * rate when payroll isn't uploaded or nobody on a shop timer is linked yet.
 * A payroll read failure falls back too, never fails the caller.
 */
export async function getShopLaborCostBasis(service: SupabaseClient): Promise<ShopLaborCostBasis> {
  try {
    const p = await loadShopPayrollRate(service);
    if (p) return { rate: p.rate, source: 'paychex', people: p.people, throughPeriodEnd: p.windowEnd };
  } catch (e: any) {
    console.warn('loadShopPayrollRate failed, using the Settings rate:', e?.message || e);
  }
  const rate = await getShopLaborRate(service);
  return { rate, source: rate != null ? 'setting' : null };
}

/**
 * Which crew a shop timer is billing (migration 337, owner rule 2026-10-02:
 * timers run on Graphics and on In Progress Upfit). Older shifts carry null
 * and count as upfit.
 */
export type ShopTimerDept = 'graphics' | 'upfit';

export function deptOfStage(stage: string | null | undefined): ShopTimerDept {
  return stage === 'graphics' || stage === 'graphics_complete' ? 'graphics' : 'upfit';
}

/** The check-in's open shop shift, if any (mirrors getOpenCniShift). */
export async function getOpenShopShift(service: SupabaseClient, checkinId: string) {
  const { data } = await service
    .from('work_shifts')
    .select('id, started_by, started_at, shop_stage')
    .eq('context', 'shop')
    .eq('fleet_checkin_id', checkinId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

export interface CheckinLabor {
  /** Total member-hours across the check-in's shop shifts (open ones count
   *  elapsed-so-far). */
  hours: number;
  /** The subset of `hours` from auto-closed or still-open shifts. */
  approxHours: number;
  /** hours × the shop cost rate (getShopLaborCostBasis), or null when no
   *  rate is configured or the caller asked for hours only. */
  cost: number | null;
  hasOpenShift: boolean;
  /** `hours` split by the crew the timer was billing. */
  byDept: Record<ShopTimerDept, number>;
}

/**
 * Aggregate shop labor per check-in for the margin report and the pick-list
 * header — a handful of reads regardless of vehicle count.
 */
export async function getShopLaborForCheckins(
  service: SupabaseClient,
  checkinIds: string[],
  opts: { cost?: boolean } = {},
): Promise<Map<string, CheckinLabor>> {
  const out = new Map<string, CheckinLabor>();
  if (checkinIds.length === 0) return out;

  const shifts: any[] = [];
  for (let i = 0; i < checkinIds.length; i += 100) {
    const { data, error } = await service
      .from('work_shifts')
      .select('id, fleet_checkin_id, started_at, ended_at, auto_closed, shop_stage')
      .eq('context', 'shop')
      .in('fleet_checkin_id', checkinIds.slice(i, i + 100));
    if (error) {
      // Pre-269 schema cache: no shop shifts exist yet either way.
      console.warn('getShopLaborForCheckins read failed (schema cache?):', error.message);
      return out;
    }
    shifts.push(...(data || []));
  }
  if (shifts.length === 0) return out;

  const membersByShift = new Map<string, MemberWindow[]>();
  const shiftIds = shifts.map(s => s.id);
  for (let i = 0; i < shiftIds.length; i += 100) {
    const { data } = await service
      .from('work_shift_members')
      .select('shift_id, profile_id, added_at, removed_at')
      .in('shift_id', shiftIds.slice(i, i + 100));
    for (const m of data || []) {
      const list = membersByShift.get(m.shift_id) || [];
      list.push({ profile_id: m.profile_id, added_at: m.added_at, removed_at: m.removed_at });
      membersByShift.set(m.shift_id, list);
    }
  }

  // Hours-only callers (pick-list, burn meter) skip the payroll reads.
  const rate = opts.cost === false ? null : (await getShopLaborCostBasis(service)).rate;
  const nowIso = new Date().toISOString();
  for (const s of shifts) {
    const entry = out.get(s.fleet_checkin_id) || { hours: 0, approxHours: 0, cost: null, hasOpenShift: false, byDept: { graphics: 0, upfit: 0 } };
    const open = !s.ended_at;
    const hours = totalShiftHours(s.started_at, s.ended_at || nowIso, membersByShift.get(s.id) || [], { shopClock: true });
    entry.hours += hours;
    entry.byDept[deptOfStage(s.shop_stage)] += hours;
    if (open || s.auto_closed) entry.approxHours += hours;
    if (open) entry.hasOpenShift = true;
    out.set(s.fleet_checkin_id, entry);
  }
  for (const entry of out.values()) {
    entry.hours = Math.round(entry.hours * 100) / 100;
    entry.approxHours = Math.round(entry.approxHours * 100) / 100;
    entry.byDept.graphics = Math.round(entry.byDept.graphics * 100) / 100;
    entry.byDept.upfit = Math.round(entry.byDept.upfit * 100) / 100;
    entry.cost = rate != null ? Math.round(entry.hours * rate * 100) / 100 : null;
  }
  return out;
}

/**
 * End every open shop shift on a check-in — finishing the completion
 * procedure (or shipping) is how a job timer stops (owner rules
 * 2026-10-02), so this is a normal stop, not an approximate auto-close. Best effort; idempotent (no
 * open shifts = no writes).
 */
export async function closeShopShiftsForCheckin(service: SupabaseClient, checkinId: string): Promise<number> {
  const { data, error } = await service
    .from('work_shifts')
    .update({ ended_at: new Date().toISOString() })
    .eq('context', 'shop')
    .eq('fleet_checkin_id', checkinId)
    .is('ended_at', null)
    .select('id');
  if (error) {
    console.warn('closeShopShiftsForCheckin failed:', error.message);
    return 0;
  }
  return (data || []).length;
}

/**
 * A tech works one shop job at a time (owner rule 2026-10-02: tagging a tech
 * who is on another vehicle MOVES them). Takes these people off every OTHER
 * open shop shift, and ends any shift that leaves with nobody on it, so its
 * clock stops rather than running with an empty crew. Returns the check-in
 * ids they were moved off.
 */
export async function moveOffOtherShopShifts(
  service: SupabaseClient,
  profileIds: string[],
  keepShiftId: string,
): Promise<string[]> {
  if (profileIds.length === 0) return [];
  const { data: memberships, error } = await service
    .from('work_shift_members')
    .select('id, shift_id')
    .in('profile_id', profileIds)
    .is('removed_at', null);
  if (error) {
    console.warn('moveOffOtherShopShifts read failed:', error.message);
    return [];
  }
  const candidateIds = [...new Set((memberships || []).map(m => m.shift_id))].filter(id => id !== keepShiftId);
  if (candidateIds.length === 0) return [];
  const { data: shifts } = await service
    .from('work_shifts')
    .select('id, fleet_checkin_id')
    .in('id', candidateIds)
    .eq('context', 'shop')
    .is('ended_at', null);
  if (!shifts || shifts.length === 0) return [];

  const now = new Date().toISOString();
  const shiftIds = new Set(shifts.map(s => s.id));
  await service
    .from('work_shift_members')
    .update({ removed_at: now })
    .in('id', (memberships || []).filter(m => shiftIds.has(m.shift_id)).map(m => m.id));

  const moved: string[] = [];
  for (const shift of shifts) {
    if (shift.fleet_checkin_id) moved.push(shift.fleet_checkin_id);
    const { count } = await service
      .from('work_shift_members')
      .select('id', { count: 'exact', head: true })
      .eq('shift_id', shift.id)
      .is('removed_at', null);
    if (!count) {
      await service.from('work_shifts').update({ ended_at: now }).eq('id', shift.id).is('ended_at', null);
    }
  }
  return moved;
}

/**
 * Keep a running shop timer in step with the vehicle's one-line status
 * (owner rule 2026-10-02: timers run on Graphics and on In Progress Upfit).
 *
 *  - Graphics Complete / Upfit Complete ends a timer billing that crew —
 *    that work is finished — and leaves the other crew's timer alone.
 *  - Graphics / In Progress Upfit, while a timer bills the other crew, ends
 *    it and starts one for this crew with the same people on it, so the
 *    hours land on the right side of the job.
 *
 * Never starts a timer from nothing: tapping a status in the office isn't
 * someone clocking onto the vehicle (Pull In / Start Timer do that).
 * Best effort, like the other shop-timer side effects.
 */
export async function followStageWithShopTimer(
  service: SupabaseClient,
  checkinId: string,
  stage: string,
): Promise<void> {
  const open = await getOpenShopShift(service, checkinId);
  if (!open) return;
  const dept = deptOfStage(stage);
  const running = deptOfStage((open as any).shop_stage);
  if (stage === 'graphics_complete' || stage === 'upfit_complete') {
    if (running === dept) await closeShopShiftsForCheckin(service, checkinId);
    return;
  }
  if (running === dept) return;
  await switchShopShiftDept(service, checkinId, open.id, open.started_by, dept);
}

/**
 * End shift `shiftId` and start a new open shop shift on the same check-in
 * for `dept`, carrying over whoever is still on the crew. Returns the new
 * shift (or null when nobody was on it — then nothing is restarted).
 */
export async function switchShopShiftDept(
  service: SupabaseClient,
  checkinId: string,
  shiftId: string,
  startedBy: string | null,
  dept: ShopTimerDept,
): Promise<{ id: string; started_by: string; started_at: string; shop_stage: string } | null> {
  const now = new Date().toISOString();
  const { data: crew } = await service
    .from('work_shift_members')
    .select('id, profile_id')
    .eq('shift_id', shiftId)
    .is('removed_at', null);
  await service.from('work_shift_members').update({ removed_at: now }).eq('shift_id', shiftId).is('removed_at', null);
  await service.from('work_shifts').update({ ended_at: now }).eq('id', shiftId).is('ended_at', null);
  if (!crew || crew.length === 0) return null;

  const { data: shift, error } = await service
    .from('work_shifts')
    .insert({ context: 'shop', fleet_checkin_id: checkinId, shop_stage: dept, started_by: startedBy || crew[0].profile_id })
    .select('id, started_by, started_at, shop_stage')
    .single();
  if (error || !shift) {
    console.warn('switchShopShiftDept: restart failed:', error?.message);
    return null;
  }
  await service.from('work_shift_members').insert(
    crew.map(m => ({ shift_id: shift.id, profile_id: m.profile_id, share_weight: 1, added_by: startedBy || m.profile_id })),
  );
  return shift as any;
}
