import type { SupabaseClient } from '@supabase/supabase-js';

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
 * no part here. Cost = total member-hours × the blended shop rate
 * (quote_settings.shop_labor_cost_rate, Settings → Shop Labor Cost Rate);
 * with no rate configured the margin report shows hours but excludes labor
 * from the math, saying so.
 *
 * Timers are only as accurate as button-pressing, so hours from shifts that
 * nobody stopped (auto_closed: vehicle completion or the daily sweep ended
 * them) are reported separately as approximate.
 */

/** Cap the daily sweep writes when closing a forgotten timer. */
export const SHOP_SHIFT_MAX_HOURS = 12;
/** The sweep closes open shop shifts older than this. */
export const SHOP_SHIFT_STALE_HOURS = 14;

export interface MemberWindow {
  profile_id: string;
  added_at: string | null;
  removed_at: string | null;
}

/**
 * Presence-overlap hours per member for one shift interval. Pure math so the
 * tests can pin it: clamp each member's window to [start, end], never
 * negative; a missing added_at counts from shift start.
 */
export function shiftMemberHours(
  startedAt: string,
  endedAt: string,
  members: MemberWindow[],
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
    const hours = Math.max(0, (to - from) / 3_600_000);
    out.set(m.profile_id, (out.get(m.profile_id) || 0) + hours);
  }
  return out;
}

/** Σ member-hours for one shift. */
export function totalShiftHours(startedAt: string, endedAt: string, members: MemberWindow[]): number {
  let total = 0;
  for (const h of shiftMemberHours(startedAt, endedAt, members).values()) total += h;
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

/** The check-in's open shop shift, if any (mirrors getOpenCniShift). */
export async function getOpenShopShift(service: SupabaseClient, checkinId: string) {
  const { data } = await service
    .from('work_shifts')
    .select('id, started_by, started_at')
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
  /** hours × the blended rate, or null when no rate is configured. */
  cost: number | null;
  hasOpenShift: boolean;
}

/**
 * Aggregate shop labor per check-in for the margin report and the pick-list
 * header — a handful of reads regardless of vehicle count.
 */
export async function getShopLaborForCheckins(
  service: SupabaseClient,
  checkinIds: string[],
): Promise<Map<string, CheckinLabor>> {
  const out = new Map<string, CheckinLabor>();
  if (checkinIds.length === 0) return out;

  const shifts: any[] = [];
  for (let i = 0; i < checkinIds.length; i += 100) {
    const { data, error } = await service
      .from('work_shifts')
      .select('id, fleet_checkin_id, started_at, ended_at, auto_closed')
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

  const rate = await getShopLaborRate(service);
  const nowIso = new Date().toISOString();
  for (const s of shifts) {
    const entry = out.get(s.fleet_checkin_id) || { hours: 0, approxHours: 0, cost: null, hasOpenShift: false };
    const open = !s.ended_at;
    const hours = totalShiftHours(s.started_at, s.ended_at || nowIso, membersByShift.get(s.id) || []);
    entry.hours += hours;
    if (open || s.auto_closed) entry.approxHours += hours;
    if (open) entry.hasOpenShift = true;
    out.set(s.fleet_checkin_id, entry);
  }
  for (const entry of out.values()) {
    entry.hours = Math.round(entry.hours * 100) / 100;
    entry.approxHours = Math.round(entry.approxHours * 100) / 100;
    entry.cost = rate != null ? Math.round(entry.hours * rate * 100) / 100 : null;
  }
  return out;
}

/**
 * End every open shop shift on a check-in, marking auto_closed — the
 * completion ceremony calls this so a forgotten timer stops when the
 * vehicle does. Best effort; idempotent (no open shifts = no writes).
 */
export async function closeShopShiftsForCheckin(service: SupabaseClient, checkinId: string): Promise<number> {
  const { data, error } = await service
    .from('work_shifts')
    .update({ ended_at: new Date().toISOString(), auto_closed: true })
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
