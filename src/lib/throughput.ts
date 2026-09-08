import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { deepLinks } from './deep-links';

/**
 * Cycle-Time & Throughput (R6-12) — one report over all three pipelines.
 *
 * The three boards (In-Shop vehicles, Graphics, CNI) each write an
 * append-only status-history table with the same shape, so one engine
 * answers the same questions of all of them: how long does each stage
 * really take, where is the bottleneck, how often does work go backwards,
 * and is turnaround getting better or worse.
 *
 * The numbers are only as honest as their samples, so:
 *  - Nothing is "the bottleneck" on fewer than MIN_BOTTLENECK_SAMPLES
 *    cycles through it. One stuck vehicle must not crown a stage.
 *  - p90 over a handful of points is just the maximum wearing a suit, so
 *    every stage carries its sample count and p90 is null below
 *    MIN_P90_SAMPLES rather than printed as a number.
 *  - A stage nothing passed through has `samples: 0`, never a 0-day dwell.
 *  - Only CLOSED cycles are measured. Work still in flight would drag every
 *    median toward whatever is sitting on the floor right now; the count of
 *    excluded in-flight records is reported, not hidden.
 *  - Re-entry (a returning vehicle, a job reopened) starts a NEW cycle —
 *    the previous visit's dwell never pollutes this one (the m229 rule the
 *    ops-pulse dwell already follows).
 */

export const MIN_BOTTLENECK_SAMPLES = 3;
export const MIN_P90_SAMPLES = 5;

export type PipelineKey = 'vehicles' | 'graphics' | 'cni';

export interface PipelineDef {
  key: PipelineKey;
  label: string;
  /** Status → position in the flow. Equal ranks are peers (a side state,
   *  not a later stage), so moving between them is not "going backwards". */
  rank: Record<string, number>;
  /** Statuses that OPEN a cycle. */
  entry: string[];
  /** Statuses that CLOSE a cycle (first one reached wins). */
  terminal: string[];
  /** Statuses that end a cycle without it counting — abandoned, not done. */
  discard: string[];
  /** Entering one of these is rework however the rank compares. */
  reworkStates: string[];
  /** Stages worth measuring dwell in (terminal states have no dwell). */
  stages: string[];
  historyTable: string;
  idColumn: string;
  recordLink: (id: string) => string;
}

export const PIPELINES: Record<PipelineKey, PipelineDef> = {
  vehicles: {
    key: 'vehicles',
    label: 'Vehicles (In-Shop)',
    rank: {
      received: 0, checked_in: 0,
      in_progress: 1, stuck_parts: 1, stuck_graphics: 1,
      complete: 2, shipped: 3,
    },
    entry: ['received', 'checked_in'],
    terminal: ['complete', 'shipped'],
    discard: [],
    reworkStates: [],
    stages: ['received', 'in_progress', 'stuck_parts', 'stuck_graphics'],
    historyTable: 'vehicle_status_history',
    idColumn: 'vehicle_id',
    recordLink: (id) => deepLinks.vehicle(id),
  },
  graphics: {
    key: 'graphics',
    label: 'Graphics',
    rank: {
      flagged: 0, received: 1,
      // designing and revision are peers: a revision IS a design pass. It
      // still counts as rework via reworkStates — entering it is the signal,
      // not the rank comparison.
      designing: 2, revision: 2,
      printing: 3, outgassing: 4, cutting: 5, packing: 6, ready: 7,
      shipped: 8, installed: 9, cancelled: -1,
    },
    entry: ['flagged', 'received'],
    terminal: ['shipped', 'installed'],
    discard: ['cancelled'],
    reworkStates: ['revision'],
    stages: ['flagged', 'received', 'designing', 'revision', 'printing', 'outgassing', 'cutting', 'packing', 'ready'],
    historyTable: 'graphics_status_history',
    idColumn: 'job_id',
    recordLink: (id) => deepLinks.graphicsJob(id),
  },
  cni: {
    key: 'cni',
    label: 'CNI Jobs',
    rank: {
      awaiting_assignment: 0,
      assigned_awaiting_scheduling: 1,
      scheduling_proposed: 2,
      scheduled_pending_confirmation: 3,
      scheduled_confirmed: 4,
      in_progress: 5,
      completed_pending_review: 6,
      approved_closed: 7,
    },
    entry: ['awaiting_assignment'],
    terminal: ['approved_closed'],
    discard: [],
    reworkStates: [],
    stages: [
      'awaiting_assignment', 'assigned_awaiting_scheduling', 'scheduling_proposed',
      'scheduled_pending_confirmation', 'scheduled_confirmed', 'in_progress',
      'completed_pending_review',
    ],
    historyTable: 'cni_job_status_history',
    idColumn: 'job_id',
    recordLink: (id) => deepLinks.cniJob(id),
  },
};

export const STAGE_LABEL = (stage: string) =>
  stage.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

/* ── pure math ───────────────────────────────────────────────────────── */

export interface StatusEvent {
  recordId: string;
  toStatus: string;
  at: string;
  changedBy?: string | null;
}

export interface Cycle {
  recordId: string;
  startedAt: string;
  endedAt: string;
  turnaroundDays: number;
  /** Stage → days spent in it during THIS cycle (a stage can be re-entered
   *  within one cycle; the segments are summed). */
  stageDays: Record<string, number>;
  closedBy: string | null;
}

const DAY = 86_400_000;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank p90 — index ceil(0.9n) − 1 over the sorted values. */
export function p90(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Split one record's event stream into completed cycles.
 *
 * A cycle runs from an ENTRY status to the first TERMINAL status after it.
 * A discard status (cancelled) abandons the open cycle without recording
 * one. Events must arrive sorted ascending.
 */
export function buildCycles(def: PipelineDef, events: StatusEvent[]): Cycle[] {
  const byRecord = new Map<string, StatusEvent[]>();
  for (const e of events) {
    const arr = byRecord.get(e.recordId) || [];
    arr.push(e);
    byRecord.set(e.recordId, arr);
  }

  const out: Cycle[] = [];
  for (const [recordId, raw] of byRecord) {
    const hist = [...raw].sort((a, b) => a.at.localeCompare(b.at));
    let openAt: number | null = null;
    for (let i = 0; i < hist.length; i++) {
      const s = hist[i].toStatus;
      if (openAt === null) {
        if (def.entry.includes(s)) openAt = i;
        continue;
      }
      if (def.discard.includes(s)) { openAt = null; continue; }
      if (!def.terminal.includes(s)) continue;

      const start = hist[openAt].at;
      const end = hist[i].at;
      const turnaroundDays = (Date.parse(end) - Date.parse(start)) / DAY;
      // A negative or absurd span means the history is wrong, not that the
      // work took that long — drop the cycle rather than poison the median.
      if (turnaroundDays >= 0 && turnaroundDays <= 730) {
        const stageDays: Record<string, number> = {};
        for (let j = openAt; j < i; j++) {
          const stage = normalizeStage(def, hist[j].toStatus);
          if (!def.stages.includes(stage)) continue;
          const days = (Date.parse(hist[j + 1].at) - Date.parse(hist[j].at)) / DAY;
          if (days < 0 || days > 730) continue;
          stageDays[stage] = (stageDays[stage] || 0) + days;
        }
        out.push({ recordId, startedAt: start, endedAt: end, turnaroundDays, stageDays, closedBy: hist[i].changedBy || null });
      }
      openAt = null;
    }
  }
  return out;
}

/** The vehicle board writes both 'received' and 'checked_in' for the same
 *  stage (m229's re-check-in path uses the second); they are one stage. */
function normalizeStage(def: PipelineDef, status: string): string {
  if (def.key === 'vehicles' && status === 'checked_in') return 'received';
  return status;
}

export interface StageStat {
  stage: string;
  label: string;
  medianDays: number;
  /** Null below MIN_P90_SAMPLES — a p90 over four points is just the max. */
  p90Days: number | null;
  samples: number;
}

export function stageStats(def: PipelineDef, cycles: Cycle[]): StageStat[] {
  const byStage = new Map<string, number[]>();
  for (const c of cycles) {
    for (const [stage, days] of Object.entries(c.stageDays)) {
      const arr = byStage.get(stage) || [];
      arr.push(days);
      byStage.set(stage, arr);
    }
  }
  return def.stages
    .filter(s => byStage.has(s))
    .map(stage => {
      const days = byStage.get(stage)!;
      return {
        stage,
        label: STAGE_LABEL(stage),
        medianDays: round1(median(days) || 0),
        p90Days: days.length >= MIN_P90_SAMPLES ? round1(p90(days) || 0) : null,
        samples: days.length,
      };
    })
    .sort((a, b) => b.medianDays - a.medianDays);
}

/** The slowest stage with enough cycles through it to mean anything. */
export function bottleneck(stats: StageStat[]): StageStat | null {
  return stats.find(s => s.samples >= MIN_BOTTLENECK_SAMPLES) || null;
}

export interface MonthPoint {
  month: string;
  medianDays: number;
  completions: number;
}

/** Turnaround trended by the month a cycle CLOSED (that is when the work
 *  landed), on the shop calendar. */
export function turnaroundByMonth(cycles: Cycle[]): MonthPoint[] {
  const byMonth = new Map<string, number[]>();
  for (const c of cycles) {
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' })
      .format(new Date(c.endedAt)).slice(0, 7);
    const arr = byMonth.get(month) || [];
    arr.push(c.turnaroundDays);
    byMonth.set(month, arr);
  }
  return [...byMonth.entries()]
    .map(([month, days]) => ({ month, medianDays: round1(median(days) || 0), completions: days.length }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export interface ReworkRow {
  from: string;
  to: string;
  label: string;
  count: number;
  /** Typed reasons pulled off the transition notes, commonest first. Notes
   *  are free text, so `withoutReason` says how many carried nothing. */
  reasons: { reason: string; count: number }[];
  withoutReason: number;
}

export interface ReworkSummary {
  rows: ReworkRow[];
  events: number;
  /** Records that went backwards at least once, over records seen. */
  affectedRecords: number;
  totalRecords: number;
}

/**
 * Rework = a transition to a LOWER-ranked status, or into a declared rework
 * state (graphics 'revision' — a revision is a design pass again, and its
 * rank ties with designing, so the rank test alone would miss it).
 */
export function summarizeRework(
  def: PipelineDef,
  events: { recordId: string; fromStatus: string | null; toStatus: string; note?: string | null }[],
): ReworkSummary {
  const rows = new Map<string, ReworkRow>();
  const affected = new Set<string>();
  const seen = new Set<string>();
  let count = 0;

  for (const e of events) {
    seen.add(e.recordId);
    if (!e.fromStatus) continue;
    const fromRank = def.rank[e.fromStatus];
    const toRank = def.rank[e.toStatus];
    const backwards = fromRank != null && toRank != null && toRank >= 0 && toRank < fromRank;
    const intoRework = def.reworkStates.includes(e.toStatus) && e.fromStatus !== e.toStatus;
    if (!backwards && !intoRework) continue;

    count += 1;
    affected.add(e.recordId);
    const key = `${e.fromStatus}→${e.toStatus}`;
    const row = rows.get(key) || {
      from: e.fromStatus, to: e.toStatus,
      label: `${STAGE_LABEL(e.fromStatus)} → ${STAGE_LABEL(e.toStatus)}`,
      count: 0, reasons: [], withoutReason: 0,
    };
    row.count += 1;
    const reason = (e.note || '').trim();
    if (!reason) row.withoutReason += 1;
    else {
      const existing = row.reasons.find(r => r.reason.toLowerCase() === reason.toLowerCase());
      if (existing) existing.count += 1;
      else row.reasons.push({ reason, count: 1 });
    }
    rows.set(key, row);
  }

  const out = [...rows.values()].sort((a, b) => b.count - a.count);
  for (const r of out) r.reasons.sort((a, b) => b.count - a.count);
  return { rows: out, events: count, affectedRecords: affected.size, totalRecords: seen.size };
}

export interface ArrivalAccuracy {
  /** Arrivals with BOTH an expected date and a real arrival day to compare. */
  samples: number;
  onDay: number;
  early: number;
  late: number;
  medianDaysLate: number | null;
  /** Arrived, but never carried an expected date. Not "on time" —
   *  unmeasurable, and counted where it can be seen. */
  noForecast: number;
  /** Arrived, but with no trustworthy arrival stamp (no linked check-in).
   *  shop_inbound has no arrived_at column and `updated_at` moves on ANY
   *  edit, so guessing from it would quietly report the day someone last
   *  touched the row as the day the truck showed up. */
  noArrivalStamp: number;
}

export function summarizeArrivals(
  rows: { expectedDate: string | null; arrivedDay: string | null }[],
): ArrivalAccuracy {
  let onDay = 0, early = 0, late = 0, noForecast = 0, noArrivalStamp = 0;
  const deltas: number[] = [];
  for (const r of rows) {
    if (!r.arrivedDay) { noArrivalStamp += 1; continue; }
    if (!r.expectedDate) { noForecast += 1; continue; }
    const delta = Math.round((Date.parse(`${r.arrivedDay}T00:00:00Z`) - Date.parse(`${r.expectedDate}T00:00:00Z`)) / DAY);
    deltas.push(delta);
    if (delta === 0) onDay += 1;
    else if (delta < 0) early += 1;
    else late += 1;
  }
  return {
    samples: deltas.length,
    onDay, early, late,
    medianDaysLate: deltas.length ? Math.round((median(deltas) || 0) * 10) / 10 : null,
    noForecast,
    noArrivalStamp,
  };
}

/* ── loader ──────────────────────────────────────────────────────────── */

export interface ThroughputReport {
  pipeline: PipelineKey;
  label: string;
  since: string;
  stages: StageStat[];
  bottleneck: StageStat | null;
  byMonth: MonthPoint[];
  rework: ReworkSummary;
  completions: number;
  medianTurnaroundDays: number | null;
  p90TurnaroundDays: number | null;
  /** Records with an open cycle at the end of the window — measured cycles
   *  are CLOSED ones only, and this says how many were left out. */
  inFlight: number;
  /** Graphics only: who closed the cycles. */
  closers: { name: string; count: number }[];
  /** Vehicles only. */
  arrivals: ArrivalAccuracy | null;
  meta: { minBottleneckSamples: number; minP90Samples: number; generatedAt: string };
}

export async function loadThroughput(
  service: SupabaseClient,
  pipeline: PipelineKey,
  sinceIso: string,
): Promise<ThroughputReport> {
  const def = PIPELINES[pipeline];

  // Two reads, deliberately different in shape.
  //
  // Cycles are found from records that FINISHED inside the window, then
  // measured over their COMPLETE history — a job that entered 200 days ago
  // and shipped last week is a long cycle, and reading only the window's
  // events would clip it into a short one and quietly pull every median
  // down. Rework and in-flight, by contrast, are about what happened
  // recently, so they read the window's own events.
  const [doneRes, windowRes] = await Promise.all([
    fetchAllRows<any>((from, to) => service
      .from(def.historyTable)
      .select(`${def.idColumn}, to_status, created_at`)
      .in('to_status', def.terminal)
      .gte('created_at', sinceIso)
      .order('created_at').order('id')
      .range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from(def.historyTable)
      .select(`${def.idColumn}, from_status, to_status, note, created_at`)
      .gte('created_at', sinceIso)
      .order('created_at').order('id')
      .range(from, to)),
  ]);
  if (doneRes.error) throw new Error(doneRes.error.message);
  if (windowRes.error) throw new Error(windowRes.error.message);

  const finishedIds = [...new Set((doneRes.data || []).map(r => r[def.idColumn]))];
  const events: StatusEvent[] = [];
  for (let i = 0; i < finishedIds.length; i += 100) {
    const { data, error: hErr } = await fetchAllRows<any>((from, to) => service
      .from(def.historyTable)
      .select(`${def.idColumn}, to_status, changed_by, created_at`)
      .in(def.idColumn, finishedIds.slice(i, i + 100))
      .order('created_at').order('id')
      .range(from, to));
    if (hErr) throw new Error(hErr.message);
    for (const r of data || []) {
      events.push({ recordId: r[def.idColumn], toStatus: r.to_status, at: r.created_at, changedBy: r.changed_by || null });
    }
  }

  // Only cycles that CLOSED inside the window belong to this report — a
  // record's older cycles come back with its full history.
  const cycles = buildCycles(def, events).filter(c => c.endedAt >= sinceIso);

  // In-flight = entered the pipeline during the window, never finished.
  const closedIds = new Set(cycles.map(c => c.recordId));
  const enteredIds = new Set((windowRes.data || [])
    .filter(r => def.entry.includes(r.to_status))
    .map(r => r[def.idColumn]));
  let inFlight = 0;
  for (const id of enteredIds) if (!closedIds.has(id)) inFlight += 1;

  const stages = stageStats(def, cycles);
  const turnarounds = cycles.map(c => c.turnaroundDays);

  const rework = summarizeRework(def, (windowRes.data || []).map(r => ({
    recordId: r[def.idColumn], fromStatus: r.from_status || null, toStatus: r.to_status, note: r.note || null,
  })));

  const closers = pipeline === 'graphics' ? await resolveClosers(service, cycles) : [];
  const arrivals = pipeline === 'vehicles' ? await loadArrivalAccuracy(service, sinceIso) : null;

  return {
    pipeline, label: def.label, since: sinceIso,
    stages,
    bottleneck: bottleneck(stages),
    byMonth: turnaroundByMonth(cycles),
    rework,
    completions: cycles.length,
    medianTurnaroundDays: turnarounds.length ? round1(median(turnarounds)!) : null,
    p90TurnaroundDays: turnarounds.length >= MIN_P90_SAMPLES ? round1(p90(turnarounds)!) : null,
    inFlight,
    closers,
    arrivals,
    meta: {
      minBottleneckSamples: MIN_BOTTLENECK_SAMPLES,
      minP90Samples: MIN_P90_SAMPLES,
      generatedAt: new Date().toISOString(),
    },
  };
}

/** Per-person completion counts. An unattributed close (no changed_by, e.g.
 *  a cron or an old row) is counted under its own label rather than
 *  silently dropped — the totals have to add up to `completions`. */
async function resolveClosers(service: SupabaseClient, cycles: Cycle[]): Promise<{ name: string; count: number }[]> {
  const counts = new Map<string, number>();
  let unattributed = 0;
  for (const c of cycles) {
    if (!c.closedBy) { unattributed += 1; continue; }
    counts.set(c.closedBy, (counts.get(c.closedBy) || 0) + 1);
  }
  const ids = [...counts.keys()];
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await service.from('profiles').select('id, full_name').in('id', ids.slice(i, i + 200));
    for (const p of data || []) names.set(p.id, p.full_name || 'Unnamed');
  }
  const out = ids
    .map(id => ({ name: names.get(id) || 'Unknown user', count: counts.get(id)! }))
    .sort((a, b) => b.count - a.count);
  if (unattributed > 0) out.push({ name: 'Not attributed', count: unattributed });
  return out;
}

/**
 * Expected-vs-actual arrival accuracy from shop_inbound.
 *
 * The arrival DAY comes from the linked check-in's created_at — the moment
 * someone actually received the vehicle. shop_inbound has no arrived_at
 * column and its `updated_at` moves on any later edit, so reading the
 * arrival off that would report the day the row was last touched. Rows with
 * no linked check-in are counted as unstamped rather than guessed at.
 */
async function loadArrivalAccuracy(service: SupabaseClient, sinceIso: string): Promise<ArrivalAccuracy> {
  const { data, error } = await fetchAllRows<any>((from, to) => service
    .from('shop_inbound')
    .select('expected_date, status, updated_at, fleet_checkin_id')
    .eq('status', 'arrived')
    .gte('updated_at', sinceIso)
    .order('updated_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const rows = data || [];

  const checkinIds = [...new Set(rows.map(r => r.fleet_checkin_id).filter(Boolean))] as string[];
  const arrivedAt = new Map<string, string>();
  for (let i = 0; i < checkinIds.length; i += 200) {
    const { data: chk, error: cErr } = await service
      .from('fleet_checkins')
      .select('id, created_at')
      .in('id', checkinIds.slice(i, i + 200));
    if (cErr) throw new Error(cErr.message);
    for (const c of chk || []) arrivedAt.set(c.id, c.created_at);
  }

  return summarizeArrivals(rows.map(r => {
    const at = r.fleet_checkin_id ? arrivedAt.get(r.fleet_checkin_id) : null;
    return {
      expectedDate: r.expected_date || null,
      // Compared on shop-calendar days: expected_date is a DATE with no
      // time of day to compare against.
      arrivedDay: at ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(at)) : null,
    };
  }));
}
