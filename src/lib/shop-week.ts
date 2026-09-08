import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { chicagoDay } from './exec-metrics';

/**
 * Shop week planner data (R5-16): what lands each day — arriving vehicles
 * (shop_inbound), scheduled upfits, promised-backs — with demand hours
 * (sold labor from linked estimates, the everywhere idiom
 * labor_hours_override ?? labor_hours) against crew-hours capacity.
 *
 * Honesty rules baked in:
 * - Sold-hours coverage is spotty (m258 mass-NULLed unset labor_hours), so
 *   every day carries a known/total coverage count — the load bar never
 *   pretends unknown hours are zero demand.
 * - Several estimates can link one check-in (non-unique fleet_checkin_id):
 *   the aggregation rule is SUM of non-rejected estimates' effective hours.
 * - Capacity NULL (not configured) renders demand without judging it.
 */

export interface ShopWeekUnit {
  key: string; // stable render key
  kind: 'arrival_project' | 'arrival_graphics' | 'arrival_manual' | 'upfit' | 'promised';
  id: string; // the row the MOVE writes to (project id / graphics job id / inbound id / checkin id)
  label: string;
  customer: string | null;
  hours: number | null; // effective sold labor hours; null = unknown
  needBack: string | null;
  vin: string | null;
}

export interface ShopWeekDay {
  day: string; // YYYY-MM-DD
  units: ShopWeekUnit[];
  demandHours: number;
  knownHours: number; // units with hours
  totalUnits: number;
  capacityHours: number | null;
  overrideNote: string | null;
}

export type LoadTone = 'green' | 'amber' | 'red' | 'none';

/** Load color: green under 85%, amber to 110%, red past that; 'none' when
 *  capacity is unset or the day is empty. */
export function loadTone(demandHours: number, capacityHours: number | null): { tone: LoadTone; pct: number | null } {
  if (capacityHours == null || capacityHours <= 0) return { tone: 'none', pct: null };
  const pct = Math.round((demandHours / capacityHours) * 100);
  if (demandHours === 0) return { tone: 'none', pct };
  return { tone: pct < 85 ? 'green' : pct <= 110 ? 'amber' : 'red', pct };
}

/** The effective-hours idiom (so-sync/push/send-for-approval): override wins;
 *  both unset = unknown, never zero. */
export function effectiveHours(est: { labor_hours: number | null; labor_hours_override: number | null }): number | null {
  const v = est.labor_hours_override ?? est.labor_hours;
  return v != null ? Number(v) : null;
}

/** SUM the effective hours of several linked estimates (the multi-estimate
 *  aggregation rule); all-unknown stays unknown. */
export function sumEstimateHours(list: { labor_hours: number | null; labor_hours_override: number | null }[]): number | null {
  let total = 0;
  let known = false;
  for (const est of list) {
    const h = effectiveHours(est);
    if (h != null) { total += h; known = true; }
  }
  return known ? Math.round(total * 10) / 10 : null;
}

/** The Monday of the week containing `today` (YYYY-MM-DD). */
export function weekStartMonday(today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const back = (dow + 6) % 7;
  return new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const OPEN_ESTIMATE_FILTER = ['draft', 'pushed', 'sent', 'accepted'];
const IN_SHOP = ['received', 'checked_in', 'in_progress', 'stuck_parts', 'stuck_graphics'];

export interface ShopWeek {
  start: string;
  days: ShopWeekDay[];
  capacityConfigured: boolean;
  baseCapacityHours: number | null;
  inShopNow: number;
  /** Overall sold-hours coverage across the window's units. */
  coverage: { known: number; total: number };
}

export async function loadShopWeek(service: SupabaseClient, start: string, numDays: number): Promise<ShopWeek> {
  const end = addDays(start, numDays); // exclusive

  const [inboundRes, upfitRes, promisedRes, settingsRes, overridesRes, inShopRes] = await Promise.all([
    fetchAllRows<any>((from, to) => service
      .from('shop_inbound')
      .select('id, source_type, source_id, vehicle_desc, customer_name, work_summary, expected_date, need_back_date, vin')
      .eq('status', 'expected')
      .gte('expected_date', start)
      .lt('expected_date', end)
      .order('expected_date').order('id')
      .range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, scheduled_upfit_date, promised_back_date, status')
      // Done vehicles with a stale upfit date aren't incoming work (the
      // schedule board's exact exclusion).
      .not('status', 'in', '("shipped","complete")')
      .is('archived_at', null)
      .gte('scheduled_upfit_date', start)
      .lt('scheduled_upfit_date', end)
      .order('scheduled_upfit_date').order('id')
      .range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, promised_back_date, status')
      .in('status', IN_SHOP)
      .is('archived_at', null)
      .gte('promised_back_date', start)
      .lt('promised_back_date', end)
      .order('promised_back_date').order('id')
      .range(from, to)),
    service.from('quote_settings').select('shop_crew_size, shop_shift_hours').eq('id', 1).maybeSingle(),
    service.from('shop_capacity_overrides').select('day, hours, note').gte('day', start).lt('day', end),
    service.from('fleet_checkins').select('id', { count: 'exact', head: true }).in('status', IN_SHOP).is('archived_at', null),
  ]);
  for (const r of [inboundRes, upfitRes, promisedRes]) {
    if (r.error) throw new Error(r.error.message);
  }

  const crew = settingsRes.data?.shop_crew_size != null ? Number(settingsRes.data.shop_crew_size) : null;
  const shift = settingsRes.data?.shop_shift_hours != null ? Number(settingsRes.data.shop_shift_hours) : null;
  const baseCapacity = crew != null && shift != null ? Math.round(crew * shift * 10) / 10 : null;
  const overrideByDay = new Map<string, { hours: number; note: string | null }>(
    (overridesRes.data || []).map((o: any) => [o.day, { hours: Number(o.hours), note: o.note }]),
  );

  // ── Demand hours: linked estimates per unit ──────────────────────────
  const inbound = inboundRes.data || [];
  const upfits = upfitRes.data || [];
  const promised = promisedRes.data || [];

  // Check-in → estimates (upfits). Non-rejected estimates SUM (aggregation rule).
  const checkinIds = upfits.map((c: any) => c.id);
  const estByCheckin = new Map<string, { labor_hours: number | null; labor_hours_override: number | null }[]>();
  for (let i = 0; i < checkinIds.length; i += 100) {
    const { data } = await service
      .from('estimates')
      .select('fleet_checkin_id, labor_hours, labor_hours_override, status')
      .in('fleet_checkin_id', checkinIds.slice(i, i + 100))
      .in('status', OPEN_ESTIMATE_FILTER);
    for (const e of data || []) {
      const arr = estByCheckin.get(e.fleet_checkin_id) || [];
      arr.push(e);
      estByCheckin.set(e.fleet_checkin_id, arr);
    }
  }

  // Inbound rows route through their source: upfit_project → project.estimate_id;
  // sales_order rows key on the estimate UUID directly but carry no
  // expected_date (never in this window); graphics/manual have no estimate.
  const projectIds = inbound.filter((r: any) => r.source_type === 'upfit_project').map((r: any) => r.source_id);
  const estIdByProject = new Map<string, string>();
  for (let i = 0; i < projectIds.length; i += 100) {
    const { data } = await service
      .from('upfit_projects').select('id, estimate_id').in('id', projectIds.slice(i, i + 100));
    for (const p of data || []) if (p.estimate_id) estIdByProject.set(p.id, p.estimate_id);
  }
  const estIds = [...new Set([...estIdByProject.values()])];
  const estById = new Map<string, { labor_hours: number | null; labor_hours_override: number | null }>();
  for (let i = 0; i < estIds.length; i += 100) {
    const { data } = await service
      .from('estimates').select('id, labor_hours, labor_hours_override').in('id', estIds.slice(i, i + 100));
    for (const e of data || []) estById.set(e.id, e);
  }

  const vehicleLabel = (v: any) =>
    [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')
      || (v.vin ? `VIN …${String(v.vin).slice(-8)}` : 'Vehicle');

  const days: ShopWeekDay[] = [];
  for (let i = 0; i < numDays; i++) {
    const day = addDays(start, i);
    const units: ShopWeekUnit[] = [];

    for (const r of inbound.filter((x: any) => x.expected_date === day)) {
      const estId = r.source_type === 'upfit_project' ? estIdByProject.get(r.source_id) : null;
      const est = estId ? estById.get(estId) : null;
      units.push({
        key: `in-${r.id}`,
        kind: r.source_type === 'upfit_project' ? 'arrival_project'
          : r.source_type === 'graphics_job' ? 'arrival_graphics' : 'arrival_manual',
        // The MOVE target: a project row's date lives on the SOURCE
        // (customer_dropoff_date) or the auto-maintenance fights the edit;
        // graphics rows move via the job's scheduled_install_date; manual
        // rows own their expected_date.
        id: r.source_type === 'upfit_project' || r.source_type === 'graphics_job' ? r.source_id : r.id,
        label: r.vehicle_desc || r.work_summary || 'Arriving vehicle',
        customer: r.customer_name,
        hours: est ? sumEstimateHours([est]) : null,
        needBack: r.need_back_date,
        vin: r.vin,
      });
    }
    for (const c of upfits.filter((x: any) => x.scheduled_upfit_date === day)) {
      units.push({
        key: `up-${c.id}`,
        kind: 'upfit',
        id: c.id,
        label: vehicleLabel(c),
        customer: c.customer_name,
        hours: sumEstimateHours(estByCheckin.get(c.id) || []),
        needBack: c.promised_back_date,
        vin: c.vin,
      });
    }
    for (const c of promised.filter((x: any) => x.promised_back_date === day)) {
      units.push({
        key: `pb-${c.id}`,
        kind: 'promised',
        id: c.id,
        label: vehicleLabel(c),
        customer: c.customer_name,
        hours: null, // due out, not incoming work — never adds demand
        needBack: c.promised_back_date,
        vin: c.vin,
      });
    }

    // Demand counts incoming work only (arrivals + scheduled upfits).
    const demandUnits = units.filter(u => u.kind !== 'promised');
    const demandHours = Math.round(demandUnits.reduce((s, u) => s + (u.hours || 0), 0) * 10) / 10;
    const override = overrideByDay.get(day);
    days.push({
      day,
      units,
      demandHours,
      knownHours: demandUnits.filter(u => u.hours != null).length,
      totalUnits: demandUnits.length,
      capacityHours: override ? override.hours : baseCapacity,
      overrideNote: override?.note || null,
    });
  }

  const coverage = days.reduce(
    (acc, d) => ({ known: acc.known + d.knownHours, total: acc.total + d.totalUnits }),
    { known: 0, total: 0 },
  );
  return {
    start,
    days,
    capacityConfigured: baseCapacity != null,
    baseCapacityHours: baseCapacity,
    inShopNow: inShopRes.count || 0,
    coverage,
  };
}

export function defaultWeekStart(): string {
  return weekStartMonday(chicagoDay());
}
