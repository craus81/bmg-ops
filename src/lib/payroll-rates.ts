import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { loadedHourlyCost, rateWindowStart, SHOP_POOL_ROLES } from './paychex-payroll';

/**
 * Shop labor cost rates from Paychex payroll (migrations 340/341, owner
 * asks 2026-10-06).
 *
 * POOLED rates, not per-tech ones: the Vehicle Margin report is open to
 * admins and sales, and a per-tech rate on a one-tech job lets anyone divide
 * labor dollars by hours and read a coworker's pay. Each pool is the loaded
 * cost per worked hour (total labor cost ÷ regular + overtime hours) of
 * everyone holding the pool's payroll roles (SHOP_POOL_ROLES): Shop Techs
 * price upfit timers, Graphics Production + Installers price graphics
 * timers. Real payroll, refreshed by every upload, traceable to nobody.
 *
 * With fewer than MIN_POOL_PEOPLE in a pool the average would just be one
 * or two people's pay, so it isn't used (the Settings rate is).
 *
 * Window: the RATE_WINDOW_DAYS of paychecks ending at the latest uploaded
 * period.
 */

/** Fewer people than this and the "pool" IS someone's pay — use the Settings rate. */
export const MIN_POOL_PEOPLE = 3;

export interface ShopPayrollRate {
  rate: number;
  /** People in the pool whose paychecks fed the rate. */
  people: number;
  windowStart: string; // first period_end in the window (exclusive)
  windowEnd: string;   // latest uploaded period_end
}

/** Null when nothing is uploaded, the pool has too few people, or no worked hours. */
export async function loadShopPayrollRate(
  service: SupabaseClient,
  dept: keyof typeof SHOP_POOL_ROLES,
): Promise<ShopPayrollRate | null> {
  const { data: latest, error: latestErr } = await service
    .from('payroll_checks')
    .select('period_end')
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr || !latest?.period_end) return null;
  const windowEnd: string = latest.period_end;
  const windowStart = rateWindowStart(windowEnd);

  const { data: roles, error: roleErr } = await service
    .from('payroll_employee_roles')
    .select('paychex_employee_id')
    .in('role', SHOP_POOL_ROLES[dept]);
  if (roleErr || !roles?.length) return null;

  const { data: checks, error: checkErr } = await fetchAllRows<{
    paychex_employee_id: string; period_end: string; regular_hours: number; overtime_hours: number; total_labor_cost: number;
  }>((from, to) => service
    .from('payroll_checks')
    .select('paychex_employee_id, period_end, regular_hours, overtime_hours, total_labor_cost')
    .in('paychex_employee_id', roles.map(r => r.paychex_employee_id))
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
