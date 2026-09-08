import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { shiftMemberHours, totalShiftHours, type MemberWindow } from './shop-labor';
import { deepLinks } from './deep-links';

/**
 * Crew Utilization & Field Productivity (R6-12).
 *
 * SCOPE, deliberately narrower than the audit's original three views: the
 * "shop utilization %" half of that item died with the punch clock (#838).
 * A utilization percentage needs clocked attendance as its denominator, and
 * attendance now lives in the payroll app — so this report shows the hours
 * that ARE measured (work_shifts) and says plainly that it cannot divide
 * them by a day, rather than inventing a denominator and printing a
 * percentage nobody can defend.
 *
 * What it does show, all from work_shifts + the records those shifts
 * produced:
 *   - Per CNI job: crew hours (durations x members) against estimated_hours,
 *     vehicles completed, and vehicles per crew hour.
 *   - Per company: hours and completions by week.
 *   - Per person: hours by context, with auto-closed hours called out.
 *
 * Auto-closed shifts (nobody pressed Stop; the sweep capped them) are
 * APPROXIMATE and are reported as their own number everywhere, never
 * blended silently into a measured total.
 */

/** Field crews travel and run multi-vehicle days, so the cap is later than
 *  the shop's 12h — but a shift open past STALE hours is a forgotten Stop
 *  press, not a heroic day. */
export const FIELD_SHIFT_MAX_HOURS = 14;
export const FIELD_SHIFT_STALE_HOURS = 18;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ShiftInput {
  id: string;
  context: 'cni' | 'field' | 'shop' | 'graphics';
  cniJobId: string | null;
  startedAt: string;
  endedAt: string | null;
  autoClosed: boolean;
  members: MemberWindow[];
}

export interface HoursSplit {
  /** Hours from shifts somebody actually stopped. */
  measuredHours: number;
  /** Hours from shifts the sweep capped — approximate, never blended in. */
  autoClosedHours: number;
  totalHours: number;
  shifts: number;
  autoClosedShifts: number;
  /** Shifts still running at the moment of the read: they have no end, so
   *  they contribute NO hours and are counted here instead of being given
   *  an imaginary end time. */
  openShifts: number;
}

const emptySplit = (): HoursSplit => ({
  measuredHours: 0, autoClosedHours: 0, totalHours: 0,
  shifts: 0, autoClosedShifts: 0, openShifts: 0,
});

function addShift(split: HoursSplit, shift: ShiftInput) {
  if (!shift.endedAt) { split.openShifts += 1; return; }
  const hours = totalShiftHours(shift.startedAt, shift.endedAt, shift.members);
  split.shifts += 1;
  if (shift.autoClosed) { split.autoClosedShifts += 1; split.autoClosedHours = round1(split.autoClosedHours + hours); }
  else split.measuredHours = round1(split.measuredHours + hours);
  split.totalHours = round1(split.measuredHours + split.autoClosedHours);
}

/** Σ crew hours over a set of shifts, split by how they ended. Pure. */
export function summarizeHours(shifts: ShiftInput[]): HoursSplit {
  const split = emptySplit();
  for (const s of shifts) addShift(split, s);
  return split;
}

export interface JobProductivity extends HoursSplit {
  jobId: string;
  jobNumber: string | null;
  title: string | null;
  companyName: string | null;
  status: string | null;
  /** Null when nobody estimated the job — NOT zero. A job with no estimate
   *  is unmeasured against plan, not infinitely over it. */
  estimatedHours: number | null;
  /** (total − estimated) / estimated × 100. Null with no estimate, and null
   *  when no hours were logged at all (nothing to compare). */
  variancePct: number | null;
  vehiclesCompleted: number;
  /** Null when no hours were logged — dividing by zero would read as an
   *  infinitely productive crew. */
  vehiclesPerCrewHour: number | null;
  url: string;
}

/** Per-job productivity. Pure. */
export function jobProductivity(
  job: { id: string; jobNumber: string | null; title: string | null; companyName: string | null; status: string | null; estimatedHours: number | null },
  shifts: ShiftInput[],
  vehiclesCompleted: number,
): JobProductivity {
  const split = summarizeHours(shifts);
  const est = job.estimatedHours != null && job.estimatedHours > 0 ? job.estimatedHours : null;
  return {
    ...split,
    jobId: job.id,
    jobNumber: job.jobNumber,
    title: job.title,
    companyName: job.companyName,
    status: job.status,
    estimatedHours: est,
    variancePct: est != null && split.totalHours > 0
      ? Math.round(((split.totalHours - est) / est) * 100)
      : null,
    vehiclesCompleted,
    vehiclesPerCrewHour: split.totalHours > 0 ? round2(vehiclesCompleted / split.totalHours) : null,
    url: deepLinks.cniJob(job.id),
  };
}

export interface WeekRow {
  week: string;          // ISO Monday, YYYY-MM-DD
  hours: number;
  completions: number;
}

export interface CompanyProductivity extends HoursSplit {
  companyId: string | null;
  companyName: string;
  vehiclesCompleted: number;
  vehiclesPerCrewHour: number | null;
  weeks: WeekRow[];
}

/** The Monday (UTC) of a timestamp's week. Pure. */
export function isoWeekStart(at: string): string {
  const t = Date.parse(at);
  const d = new Date(t);
  const dow = d.getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}

export interface PersonHours extends HoursSplit {
  profileId: string;
  name: string;
  /** Hours by shift context, so a shop tech and a field installer are not
   *  averaged into one meaningless figure. */
  byContext: Record<string, number>;
}

/** Per-person hours across contexts. Pure. */
export function perPersonHours(
  shifts: ShiftInput[],
  names: Map<string, string>,
): PersonHours[] {
  const rows = new Map<string, PersonHours>();
  for (const s of shifts) {
    if (!s.endedAt) {
      for (const m of s.members) get(m.profile_id).openShifts += 1;
      continue;
    }
    const hours = shiftMemberHours(s.startedAt, s.endedAt, s.members);
    for (const [profileId, h] of hours) {
      const row = get(profileId);
      row.shifts += 1;
      if (s.autoClosed) { row.autoClosedShifts += 1; row.autoClosedHours = round1(row.autoClosedHours + h); }
      else row.measuredHours = round1(row.measuredHours + h);
      row.totalHours = round1(row.measuredHours + row.autoClosedHours);
      row.byContext[s.context] = round1((row.byContext[s.context] || 0) + h);
    }
  }
  return [...rows.values()].sort((a, b) => b.totalHours - a.totalHours);

  function get(profileId: string): PersonHours {
    let row = rows.get(profileId);
    if (!row) {
      row = { ...emptySplit(), profileId, name: names.get(profileId) || 'Unknown user', byContext: {} };
      rows.set(profileId, row);
    }
    return row;
  }
}

export interface CrewUtilization {
  sinceIso: string;
  jobs: JobProductivity[];
  companies: CompanyProductivity[];
  people: PersonHours[];
  totals: HoursSplit & { vehiclesCompleted: number; jobsWithoutEstimate: number };
  meta: { generatedAt: string; shopUtilizationAvailable: false; shopUtilizationWhy: string };
}

export const SHOP_UTILIZATION_WHY =
  'A utilization percentage needs clocked attendance as its denominator, and the punch clock was retired in #838 — '
  + 'attendance lives in the payroll app now. These are the hours that ARE measured (job timers); '
  + 'FleetSuite cannot divide them by a working day without inventing one.';

/** Load every 'cni'/'field'/'shop'/'graphics' shift since a cutoff, with
 *  member windows, chunked so member reads never hit the 1000-row cap. */
export async function loadShifts(service: SupabaseClient, sinceIso: string): Promise<ShiftInput[]> {
  const { data, error } = await fetchAllRows<any>((from, to) => service
    .from('work_shifts')
    .select('id, context, cni_job_id, started_at, ended_at, auto_closed')
    .gte('started_at', sinceIso)
    .order('started_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const shifts = data || [];
  if (shifts.length === 0) return [];

  const membersByShift = new Map<string, MemberWindow[]>();
  const ids = shifts.map(s => s.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data: mem, error: mErr } = await fetchAllRows<any>((from, to) => service
      .from('work_shift_members')
      .select('shift_id, profile_id, added_at, removed_at')
      .in('shift_id', ids.slice(i, i + 200))
      .order('shift_id').order('id')
      .range(from, to));
    if (mErr) throw new Error(mErr.message);
    for (const m of mem || []) {
      const arr = membersByShift.get(m.shift_id) || [];
      arr.push({ profile_id: m.profile_id, added_at: m.added_at, removed_at: m.removed_at });
      membersByShift.set(m.shift_id, arr);
    }
  }

  return shifts.map(s => ({
    id: s.id,
    context: s.context,
    cniJobId: s.cni_job_id || null,
    startedAt: s.started_at,
    endedAt: s.ended_at || null,
    autoClosed: !!s.auto_closed,
    members: membersByShift.get(s.id) || [],
  }));
}

export async function loadCrewUtilization(
  service: SupabaseClient,
  sinceIso: string,
): Promise<CrewUtilization> {
  const shifts = await loadShifts(service, sinceIso);

  // Vehicles completed, attributed to the shift that did them (m110's
  // cni_job_vins.shift_id) — a completion with no shift_id belongs to no
  // crew and is counted against its JOB but against nobody's hours.
  const jobIds = [...new Set(shifts.map(s => s.cniJobId).filter(Boolean))] as string[];
  const completionsByJob = new Map<string, number>();
  const jobs = new Map<string, any>();
  for (let i = 0; i < jobIds.length; i += 100) {
    const slice = jobIds.slice(i, i + 100);
    const [vinRes, jobRes] = await Promise.all([
      fetchAllRows<any>((from, to) => service
        .from('cni_job_vins')
        .select('job_id, status')
        .in('job_id', slice)
        .eq('status', 'completed')
        .order('job_id').order('id')
        .range(from, to)),
      service.from('cni_jobs')
        .select('id, job_number, title, status, estimated_hours, assigned_company_id')
        .in('id', slice),
    ]);
    if (vinRes.error) throw new Error(vinRes.error.message);
    if (jobRes.error) throw new Error(jobRes.error.message);
    for (const v of vinRes.data || []) completionsByJob.set(v.job_id, (completionsByJob.get(v.job_id) || 0) + 1);
    for (const j of jobRes.data || []) jobs.set(j.id, j);
  }

  const companyIds = [...new Set([...jobs.values()].map(j => j.assigned_company_id).filter(Boolean))] as string[];
  const companyNames = new Map<string, string>();
  for (let i = 0; i < companyIds.length; i += 200) {
    const { data } = await service.from('companies').select('id, name').in('id', companyIds.slice(i, i + 200));
    for (const c of data || []) companyNames.set(c.id, c.name || 'Unnamed company');
  }

  const shiftsByJob = new Map<string, ShiftInput[]>();
  for (const s of shifts) {
    if (!s.cniJobId) continue;
    const arr = shiftsByJob.get(s.cniJobId) || [];
    arr.push(s);
    shiftsByJob.set(s.cniJobId, arr);
  }

  const jobRows: JobProductivity[] = [...jobs.values()].map(j => jobProductivity(
    {
      id: j.id, jobNumber: j.job_number, title: j.title, status: j.status,
      companyName: j.assigned_company_id ? (companyNames.get(j.assigned_company_id) || null) : null,
      estimatedHours: j.estimated_hours != null ? Number(j.estimated_hours) : null,
    },
    shiftsByJob.get(j.id) || [],
    completionsByJob.get(j.id) || 0,
  )).sort((a, b) => b.totalHours - a.totalHours);

  // Per company: roll the job rows up, and week-bucket the shifts.
  const byCompany = new Map<string, CompanyProductivity>();
  for (const j of [...jobs.values()]) {
    const key = j.assigned_company_id || 'unassigned';
    let row = byCompany.get(key);
    if (!row) {
      row = {
        ...emptySplit(),
        companyId: j.assigned_company_id || null,
        companyName: j.assigned_company_id ? (companyNames.get(j.assigned_company_id) || 'Unnamed company') : 'No company assigned',
        vehiclesCompleted: 0, vehiclesPerCrewHour: null, weeks: [],
      };
      byCompany.set(key, row);
    }
    row.vehiclesCompleted += completionsByJob.get(j.id) || 0;
    for (const s of shiftsByJob.get(j.id) || []) addShift(row, s);
  }
  // Weeks, from the same shifts.
  const weekIndex = new Map<string, Map<string, WeekRow>>();
  for (const j of [...jobs.values()]) {
    const key = j.assigned_company_id || 'unassigned';
    const weeks = weekIndex.get(key) || new Map<string, WeekRow>();
    for (const s of shiftsByJob.get(j.id) || []) {
      if (!s.endedAt) continue;
      const week = isoWeekStart(s.startedAt);
      const w = weeks.get(week) || { week, hours: 0, completions: 0 };
      w.hours = round1(w.hours + totalShiftHours(s.startedAt, s.endedAt, s.members));
      weeks.set(week, w);
    }
    weekIndex.set(key, weeks);
  }
  for (const [key, row] of byCompany) {
    row.vehiclesPerCrewHour = row.totalHours > 0 ? round2(row.vehiclesCompleted / row.totalHours) : null;
    row.weeks = [...(weekIndex.get(key)?.values() || [])].sort((a, b) => a.week.localeCompare(b.week));
  }

  // Per person, across every context — including 'shop' and 'graphics',
  // which is the surviving half of the shop view.
  const memberIds = [...new Set(shifts.flatMap(s => s.members.map(m => m.profile_id)))];
  const names = new Map<string, string>();
  for (let i = 0; i < memberIds.length; i += 200) {
    const { data } = await service.from('profiles').select('id, full_name').in('id', memberIds.slice(i, i + 200));
    for (const p of data || []) names.set(p.id, p.full_name || 'Unnamed');
  }

  const totals = summarizeHours(shifts);
  return {
    sinceIso,
    jobs: jobRows,
    companies: [...byCompany.values()].sort((a, b) => b.totalHours - a.totalHours),
    people: perPersonHours(shifts, names),
    totals: {
      ...totals,
      vehiclesCompleted: [...completionsByJob.values()].reduce((s, n) => s + n, 0),
      jobsWithoutEstimate: jobRows.filter(j => j.estimatedHours == null).length,
    },
    meta: {
      generatedAt: new Date().toISOString(),
      shopUtilizationAvailable: false,
      shopUtilizationWhy: SHOP_UTILIZATION_WHY,
    },
  };
}

/** The actual-vs-estimate line for ONE job — the CNI job console's chip. */
export async function loadJobProductivity(
  service: SupabaseClient,
  jobId: string,
): Promise<JobProductivity | null> {
  const { data: job } = await service
    .from('cni_jobs')
    .select('id, job_number, title, status, estimated_hours')
    .eq('id', jobId)
    .maybeSingle();
  if (!job) return null;

  const { data: shiftRows, error } = await fetchAllRows<any>((from, to) => service
    .from('work_shifts')
    .select('id, context, cni_job_id, started_at, ended_at, auto_closed')
    .eq('cni_job_id', jobId)
    .order('started_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);

  const members = new Map<string, MemberWindow[]>();
  const ids = (shiftRows || []).map(s => s.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await service
      .from('work_shift_members')
      .select('shift_id, profile_id, added_at, removed_at')
      .in('shift_id', ids.slice(i, i + 200));
    for (const m of data || []) {
      const arr = members.get(m.shift_id) || [];
      arr.push({ profile_id: m.profile_id, added_at: m.added_at, removed_at: m.removed_at });
      members.set(m.shift_id, arr);
    }
  }

  const { count } = await service
    .from('cni_job_vins')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', jobId)
    .eq('status', 'completed');

  return jobProductivity(
    {
      id: job.id, jobNumber: job.job_number, title: job.title, status: job.status,
      companyName: null,
      estimatedHours: job.estimated_hours != null ? Number(job.estimated_hours) : null,
    },
    (shiftRows || []).map(s => ({
      id: s.id, context: s.context, cniJobId: s.cni_job_id || null,
      startedAt: s.started_at, endedAt: s.ended_at || null,
      autoClosed: !!s.auto_closed, members: members.get(s.id) || [],
    })),
    count || 0,
  );
}
