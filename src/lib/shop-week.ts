import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { chicagoDay } from './exec-metrics';
import { groupArrivals, loadArrivalLinks } from './arrival-groups';
import { loadStaffCalendar, dayCapacity, rosterCovers, type StaffDepartment } from './shop-staff';

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
  kind: 'arrival_project' | 'arrival_graphics' | 'arrival_manual' | 'upfit' | 'promised' | 'booking';
  /** The row the MOVE writes to (project id / graphics job id / inbound id
   *  / checkin id). A 'booking' unit is a customer drop-off booked before
   *  the estimate had a project or Sales Order; its id is the estimate id
   *  and it doesn't move from the board. */
  id: string;
  label: string;
  customer: string | null;
  hours: number | null; // effective sold labor hours; null = unknown
  /** Graphics install hours: the estimate's Graphics Install Labor dollars
   *  ÷ the graphics install rate. null = none on the estimate, or the rate
   *  or estimate is unknown. */
  graphicsHours: number | null;
  /** Booked drop-off time ('HH:MM') when a customer booked this arrival. */
  time: string | null;
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
  /** Where capacityHours came from: a per-day override, the staff
   *  calendar (migration 442), crew size × shift hours, or nothing. */
  capacitySource: 'override' | 'roster' | 'crew' | null;
  /** Graphics install hours available (staff calendar); null when no
   *  graphics installer is on the roster. */
  graphicsCapacityHours: number | null;
  /** Graphics install hours of the day's incoming work. */
  graphicsDemandHours: number;
  /** Rostered people out that day. */
  out: { name: string; department: StaffDepartment; hours: number; fullDay: boolean }[];
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

/** The day is over capacity once demand passes 100% — the line the
 *  drop-off booking warning uses (the amber band on the bars starts at
 *  85% and runs to 110%). */
export function overCapacity(demandHours: number, capacityHours: number | null): boolean {
  return capacityHours != null && demandHours > capacityHours;
}

/** The over-capacity sentence for a day, or null when it fits (or when
 *  nothing is configured to judge it against). Upfit and graphics install
 *  are judged separately against their own capacity. */
export function capacityWarning(d: Pick<ShopWeekDay, 'demandHours' | 'capacityHours' | 'graphicsDemandHours' | 'graphicsCapacityHours' | 'knownHours' | 'totalUnits'>): string | null {
  const parts: string[] = [];
  if (overCapacity(d.demandHours, d.capacityHours)) parts.push(`upfit ${d.demandHours} of ${d.capacityHours} hours`);
  if (overCapacity(d.graphicsDemandHours, d.graphicsCapacityHours)) parts.push(`graphics install ${d.graphicsDemandHours} of ${d.graphicsCapacityHours} hours`);
  if (parts.length === 0) return null;
  const unknown = d.totalUnits - d.knownHours;
  return `Over capacity that day: ${parts.join(', ')}.`
    + (unknown > 0 ? ` ${unknown} vehicle${unknown === 1 ? ' has' : 's have'} no labor hours yet, so the real load is higher.` : '');
}

/** Is this estimate line graphics install labor? The two shapes it takes:
 *  the wrap-quote fold's "Graphics Install Labor" item and Quick Graphics'
 *  "Graphics install labor…" custom line (graphics-lines.ts). */
export function isGraphicsInstallLabor(l: { item_number?: string | null; description?: string | null }): boolean {
  return String(l.item_number || '').trim().toUpperCase() === 'GRAPHICS INSTALL LABOR'
    || /^graphics install labor/i.test(String(l.description || '').trim());
}

/** Graphics install labor dollars → install hours at the configured rate.
 *  No rate, or no graphics labor, is null (unknown / none), never zero. */
export function graphicsHoursFromDollars(dollars: number | null | undefined, rate: number | null): number | null {
  if (!dollars || dollars <= 0 || rate == null || rate <= 0) return null;
  return Math.round((dollars / rate) * 10) / 10;
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
  /** The upfit shop's capacity comes from the staff calendar. */
  rosterConfigured: boolean;
  /** Graphics install $/hour (migration 443); null = not set, so graphics
   *  hours are unknown. */
  graphicsInstallRate: number | null;
  inShopNow: number;
  /** Overall sold-hours coverage across the window's units. */
  coverage: { known: number; total: number };
}

export async function loadShopWeek(service: SupabaseClient, start: string, numDays: number): Promise<ShopWeek> {
  const end = addDays(start, numDays); // exclusive

  const [inboundRes, upfitRes, promisedRes, settingsRes, overridesRes, inShopRes, staffCal, bookingsRes] = await Promise.all([
    fetchAllRows<any>((from, to) => service
      .from('shop_inbound')
      // Every expected row, not just this window's: a van's undated SO row
      // and its dated graphics row are one arrival (arrival-groups.ts).
      .select('id, source_type, source_id, vehicle_desc, customer_name, work_summary, expected_date, need_back_date, vin, netsuite_so_number')
      .eq('status', 'expected')
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
    service.from('quote_settings').select('shop_crew_size, shop_shift_hours, graphics_install_rate').eq('id', 1).maybeSingle(),
    service.from('shop_capacity_overrides').select('day, hours, note').gte('day', start).lt('day', end),
    service.from('fleet_checkins').select('id', { count: 'exact', head: true }).in('status', IN_SHOP).is('archived_at', null),
    loadStaffCalendar(service, start, end),
    // Customer-booked drop-offs (R5-17) in the window — for their time, and
    // as arrivals of their own when the estimate has no project or SO row.
    service.from('shop_appointments')
      .select('id, estimate_id, slot_date, slot_time, customer_name')
      .eq('kind', 'dropoff').eq('status', 'booked')
      .gte('slot_date', start).lt('slot_date', end)
      .order('slot_date').order('slot_time'),
  ]);
  for (const r of [inboundRes, upfitRes, promisedRes]) {
    if (r.error) throw new Error(r.error.message);
  }

  const crew = settingsRes.data?.shop_crew_size != null ? Number(settingsRes.data.shop_crew_size) : null;
  const shift = settingsRes.data?.shop_shift_hours != null ? Number(settingsRes.data.shop_shift_hours) : null;
  const baseCapacity = crew != null && shift != null ? Math.round(crew * shift * 10) / 10 : null;
  const gfxRate = settingsRes.data?.graphics_install_rate != null ? Number(settingsRes.data.graphics_install_rate) : null;
  // Staff calendar: once anyone active is on the upfit roster, who's
  // working replaces crew × shift as the upfit shop's daily capacity.
  const rosterUpfit = rosterCovers(staffCal.staff, 'upfit');
  const rosterGraphics = rosterCovers(staffCal.staff, 'graphics_install');
  const overrideByDay = new Map<string, { hours: number; note: string | null }>(
    (overridesRes.data || []).map((o: any) => [o.day, { hours: Number(o.hours), note: o.note }]),
  );

  // ── One arrival per van ──────────────────────────────────────────────
  // The van lands once, on its drop-off day (the row that sets that date);
  // its graphics installs on other days are work on those days. A shared SO
  // row of a multi-van estimate shows once.
  const allInbound = inboundRes.data || [];
  const placed: { day: string; row: any }[] = [];
  const placedIds = new Set<string>();
  const place = (d: string | null, row: any) => {
    if (!d || d < start || d >= end || placedIds.has(row.id)) return;
    placedIds.add(row.id);
    placed.push({ day: d, row });
  };
  for (const g of groupArrivals(allInbound, await loadArrivalLinks(service, allInbound))) {
    const arrivalRow = g.rows.find(r => r.source_type !== 'graphics_job' && r.expected_date?.slice(0, 10) === g.arrivalDate)
      || g.installs[0]?.row;
    if (arrivalRow) place(g.arrivalDate, arrivalRow);
    for (const i of g.installs) place(i.date, i.row);
  }

  // ── Demand hours: linked estimates per unit ──────────────────────────
  const inbound = placed.map(p => p.row);
  const upfits = upfitRes.data || [];
  const promised = promisedRes.data || [];

  // Check-in → estimates (upfits). Non-rejected estimates SUM (aggregation rule).
  const checkinIds = upfits.map((c: any) => c.id);
  type EstRow = { id: string; labor_hours: number | null; labor_hours_override: number | null };
  const estByCheckin = new Map<string, EstRow[]>();
  for (let i = 0; i < checkinIds.length; i += 100) {
    const { data } = await service
      .from('estimates')
      .select('id, fleet_checkin_id, labor_hours, labor_hours_override, status')
      .in('fleet_checkin_id', checkinIds.slice(i, i + 100))
      .in('status', OPEN_ESTIMATE_FILTER);
    for (const e of data || []) {
      const arr = estByCheckin.get(e.fleet_checkin_id) || [];
      arr.push(e);
      estByCheckin.set(e.fleet_checkin_id, arr);
    }
  }

  // Inbound rows route through their source: upfit_project → project.estimate_id;
  // sales_order rows key on the estimate UUID directly (their date comes
  // from a customer drop-off booking); graphics_job → the job's estimate;
  // manual rows have no estimate. Every expected row is resolved, not just
  // this window's, so a booking whose estimate already has an arrival row
  // isn't shown twice.
  const projectIds = allInbound.filter((r: any) => r.source_type === 'upfit_project').map((r: any) => r.source_id);
  const estIdByProject = new Map<string, string>();
  for (let i = 0; i < projectIds.length; i += 100) {
    const { data } = await service
      .from('upfit_projects').select('id, estimate_id').in('id', projectIds.slice(i, i + 100));
    for (const p of data || []) if (p.estimate_id) estIdByProject.set(p.id, p.estimate_id);
  }
  const placedJobIds = inbound.filter((r: any) => r.source_type === 'graphics_job').map((r: any) => r.source_id);
  const estIdByJob = new Map<string, string>();
  for (let i = 0; i < placedJobIds.length; i += 100) {
    const { data } = await service
      .from('graphics_jobs').select('id, estimate_id').in('id', placedJobIds.slice(i, i + 100));
    for (const j of data || []) if (j.estimate_id) estIdByJob.set(j.id, j.estimate_id);
  }
  const estIdOfRow = (r: any): string | null =>
    r.source_type === 'upfit_project' ? estIdByProject.get(r.source_id) || null
      : r.source_type === 'sales_order' ? r.source_id
        : r.source_type === 'graphics_job' ? estIdByJob.get(r.source_id) || null
          : null;

  const bookings = bookingsRes.data || [];
  const coveredEstimates = new Set(
    allInbound.filter((r: any) => r.source_type !== 'graphics_job').map(estIdOfRow).filter(Boolean) as string[],
  );
  const bookingByEstimate = new Map<string, any>(bookings.filter((b: any) => b.estimate_id).map((b: any) => [b.estimate_id, b]));
  const bookingArrivals = bookings.filter((b: any) => b.estimate_id && !coveredEstimates.has(b.estimate_id));

  const estIds = [...new Set([
    ...inbound.map(estIdOfRow).filter(Boolean) as string[],
    ...bookingArrivals.map((b: any) => b.estimate_id as string),
  ])];
  const estById = new Map<string, EstRow & { estimate_number: string | null; title: string | null; customer_name: string | null }>();
  for (let i = 0; i < estIds.length; i += 100) {
    const { data } = await service
      .from('estimates')
      .select('id, estimate_number, title, customer_name, labor_hours, labor_hours_override')
      .in('id', estIds.slice(i, i + 100));
    for (const e of data || []) estById.set(e.id, e);
  }

  // Graphics install labor dollars per estimate, and how many graphics jobs
  // carry each estimate. An estimate with graphics jobs has its install
  // hours land on the jobs' install days (split evenly across its jobs);
  // one without lands them on the vehicle's arrival.
  const allEstIds = [...new Set([...estIds, ...[...estByCheckin.values()].flat().map(e => e.id)])];
  const gfxDollars = new Map<string, number>();
  const jobsPerEstimate = new Map<string, number>();
  for (let i = 0; i < allEstIds.length; i += 100) {
    const chunk = allEstIds.slice(i, i + 100);
    const [linesRes, jobsRes] = await Promise.all([
      // Every line of these estimates, matched in code: the two graphics
      // labor shapes (graphics-lines.ts) don't fit one PostgREST filter.
      fetchAllRows<any>((from, to) => service.from('estimate_line_items')
        .select('id, estimate_id, item_number, description, quantity, unit_price')
        .in('estimate_id', chunk)
        .order('estimate_id').order('id')
        .range(from, to)),
      service.from('graphics_jobs').select('estimate_id').in('estimate_id', chunk),
    ]);
    for (const l of linesRes.data || []) {
      if (!isGraphicsInstallLabor(l)) continue;
      const amt = Number(l.quantity || 0) * Number(l.unit_price || 0);
      gfxDollars.set(l.estimate_id, (gfxDollars.get(l.estimate_id) || 0) + amt);
    }
    for (const j of jobsRes.data || []) {
      jobsPerEstimate.set(j.estimate_id, (jobsPerEstimate.get(j.estimate_id) || 0) + 1);
    }
  }
  /** Graphics hours that land on a vehicle arrival (estimates with no
   *  graphics job) or on one graphics job's install day. */
  const arrivalGfxHours = (ids: string[]): number | null => {
    const dollars = ids.filter(id => !jobsPerEstimate.get(id)).reduce((n, id) => n + (gfxDollars.get(id) || 0), 0);
    return graphicsHoursFromDollars(dollars, gfxRate);
  };
  const jobGfxHours = (estId: string | null): number | null => {
    if (!estId) return null;
    const jobs = jobsPerEstimate.get(estId) || 1;
    return graphicsHoursFromDollars((gfxDollars.get(estId) || 0) / jobs, gfxRate);
  };
  const timeOf = (estId: string | null, day: string): string | null => {
    const b = estId ? bookingByEstimate.get(estId) : null;
    return b && String(b.slot_date).slice(0, 10) === day ? String(b.slot_time).slice(0, 5) : null;
  };

  const vehicleLabel = (v: any) =>
    [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')
      || (v.vin ? `VIN …${String(v.vin).slice(-8)}` : 'Vehicle');

  const days: ShopWeekDay[] = [];
  for (let i = 0; i < numDays; i++) {
    const day = addDays(start, i);
    const units: ShopWeekUnit[] = [];

    for (const r of placed.filter(p => p.day === day).map(p => p.row)) {
      const estId = estIdOfRow(r);
      const est = estId && r.source_type !== 'graphics_job' ? estById.get(estId) : null;
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
        graphicsHours: r.source_type === 'graphics_job' ? jobGfxHours(estId) : estId ? arrivalGfxHours([estId]) : null,
        time: r.source_type === 'graphics_job' ? null : timeOf(estId, day),
        needBack: r.need_back_date,
        vin: r.vin,
      });
    }
    for (const b of bookingArrivals.filter((x: any) => String(x.slot_date).slice(0, 10) === day)) {
      const est = estById.get(b.estimate_id);
      units.push({
        key: `bk-${b.id}`,
        kind: 'booking',
        id: b.estimate_id,
        label: est?.title || (est?.estimate_number ? `Estimate #${est.estimate_number}` : 'Booked drop-off'),
        customer: b.customer_name || est?.customer_name || null,
        hours: est ? sumEstimateHours([est]) : null,
        graphicsHours: arrivalGfxHours([b.estimate_id]),
        time: String(b.slot_time).slice(0, 5),
        needBack: null,
        vin: null,
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
        graphicsHours: arrivalGfxHours((estByCheckin.get(c.id) || []).map(e => e.id)),
        time: null,
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
        graphicsHours: null,
        time: null,
        needBack: c.promised_back_date,
        vin: c.vin,
      });
    }

    // Demand counts incoming work only (arrivals + scheduled upfits). A
    // graphics install isn't upfit work, so it never counts as an upfit
    // vehicle with unknown hours; its hours go to graphics demand.
    const demandUnits = units.filter(u => u.kind !== 'promised' && u.kind !== 'arrival_graphics');
    const demandHours = Math.round(demandUnits.reduce((s, u) => s + (u.hours || 0), 0) * 10) / 10;
    const graphicsDemandHours = Math.round(units.reduce((s, u) => s + (u.graphicsHours || 0), 0) * 10) / 10;
    const override = overrideByDay.get(day);
    const cap = dayCapacity(staffCal.staff, staffCal.timeOff, day);
    const rosterHours = rosterUpfit ? cap.hours.upfit : null;
    const capacitySource = override ? 'override' : rosterUpfit ? 'roster' : baseCapacity != null ? 'crew' : null;
    days.push({
      day,
      units,
      demandHours,
      knownHours: demandUnits.filter(u => u.hours != null).length,
      totalUnits: demandUnits.length,
      capacityHours: override ? override.hours : rosterUpfit ? rosterHours : baseCapacity,
      overrideNote: override?.note || null,
      capacitySource,
      graphicsCapacityHours: rosterGraphics ? cap.hours.graphics_install : null,
      graphicsDemandHours,
      out: cap.out.map(o => ({ name: o.name, department: o.department, hours: o.hours, fullDay: o.fullDay })),
    });
  }

  const coverage = days.reduce(
    (acc, d) => ({ known: acc.known + d.knownHours, total: acc.total + d.totalUnits }),
    { known: 0, total: 0 },
  );
  return {
    start,
    days,
    capacityConfigured: baseCapacity != null || rosterUpfit,
    baseCapacityHours: baseCapacity,
    rosterConfigured: rosterUpfit,
    graphicsInstallRate: gfxRate,
    inShopNow: inShopRes.count || 0,
    coverage,
  };
}

export function defaultWeekStart(): string {
  return weekStartMonday(chicagoDay());
}
