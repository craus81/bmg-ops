import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { loadedHourlyCost, rateWindowStart } from './paychex-payroll';

/**
 * Shop labor cost rate from Paychex payroll (migration 340, owner ask
 * 2026-10-06).
 *
 * ONE pooled rate, not a per-tech one: the Vehicle Margin report is open to
 * admins and sales, and a per-tech rate on a one-tech job lets anyone divide
 * labor dollars by hours and read a coworker's pay. So the rate is the
 * loaded cost per worked hour (total labor cost ÷ regular + overtime hours)
 * of EVERYONE tagged on a shop timer in the window, pooled — real payroll,
 * refreshed by every upload, traceable to nobody.
 *
 * With fewer than MIN_POOL_PEOPLE in the pool the average would just be one
 * or two people's pay, so it isn't used (the Settings rate is).
 *
 * Window: the RATE_WINDOW_DAYS of paychecks ending at the latest uploaded
 * period, and shop timers that started inside the same window. Only people
 * linked to a Paychex employee count (import page → match people).
 */

/** Fewer people than this and the "pool" IS someone's pay — use the Settings rate. */
export const MIN_POOL_PEOPLE = 3;

export interface ShopPayrollRate {
  rate: number;
  /** Linked people on shop timers whose paychecks fed the rate. */
  people: number;
  windowStart: string; // first period_end in the window (exclusive)
  windowEnd: string;   // latest uploaded period_end
}

/** Null when nothing is uploaded, nobody on a shop timer is linked, or no worked hours. */
export async function loadShopPayrollRate(service: SupabaseClient): Promise<ShopPayrollRate | null> {
  const { data: latest, error: latestErr } = await service
    .from('payroll_checks')
    .select('period_end')
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr || !latest?.period_end) return null;
  const windowEnd: string = latest.period_end;
  const windowStart = rateWindowStart(windowEnd);

  const { data: shifts, error: shiftErr } = await fetchAllRows<{ id: string }>((from, to) => service
    .from('work_shifts')
    .select('id')
    .eq('context', 'shop')
    .gte('started_at', `${windowStart}T00:00:00Z`)
    .order('id')
    .range(from, to));
  if (shiftErr || shifts.length === 0) return null;

  const profileIds = new Set<string>();
  const shiftIds = shifts.map(s => s.id);
  for (let i = 0; i < shiftIds.length; i += 100) {
    const { data, error } = await service
      .from('work_shift_members')
      .select('profile_id')
      .in('shift_id', shiftIds.slice(i, i + 100));
    if (error) return null;
    for (const m of data || []) if (m.profile_id) profileIds.add(m.profile_id);
  }
  if (profileIds.size === 0) return null;

  const { data: links, error: linkErr } = await service
    .from('payroll_employee_links')
    .select('paychex_employee_id, profile_id')
    .in('profile_id', [...profileIds]);
  if (linkErr || !links?.length) return null;

  const { data: checks, error: checkErr } = await fetchAllRows<{
    paychex_employee_id: string; period_end: string; regular_hours: number; overtime_hours: number; total_labor_cost: number;
  }>((from, to) => service
    .from('payroll_checks')
    .select('paychex_employee_id, period_end, regular_hours, overtime_hours, total_labor_cost')
    .in('paychex_employee_id', links.map(l => l.paychex_employee_id))
    .gt('period_end', windowStart)
    .order('id')
    .range(from, to));
  if (checkErr || checks.length === 0) return null;

  const people = new Set(checks.map(c => c.paychex_employee_id)).size;
  if (people < MIN_POOL_PEOPLE) return null;
  const { rate } = loadedHourlyCost(checks);
  if (rate == null) return null;
  return { rate, people, windowStart, windowEnd };
}
