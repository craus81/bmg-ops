import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * Operations pulse (R5-15): the CEO band's flow numbers, completing the
 * R4-4 Operations band — slowest stage over 30 days, graphics throughput
 * + proof-approval time, the never-invoiced leak count, and the CACHED
 * leading-margin snapshot (the audit doc's rule: the band reads cached or
 * Supabase-local sources, never inline per-request SuiteQL).
 */

const IN_SHOP_DWELL_STAGES = ['received', 'in_progress', 'stuck_parts', 'stuck_graphics'] as const;

export interface StageDwell {
  stage: string;
  medianDays: number;
  samples: number;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Per-stage dwell for vehicles that completed, from their status events.
 * Pure. Re-check-in handling (the m229 trap): a returning vehicle carries
 * MULTIPLE cycles of history — only segments from the LAST entry into
 * received/checked_in before the completion count, so an earlier visit's
 * dwell never pollutes this cycle's numbers. The slowest stage needs ≥3
 * samples — one stuck vehicle shouldn't crown a stage on its own.
 */
export function computeStageDwell(
  events: { vehicleId: string; toStatus: string; at: string }[],
  completedAt: Map<string, string>,
): { stages: StageDwell[]; slowest: StageDwell | null } {
  const byVehicle = new Map<string, { toStatus: string; at: string }[]>();
  for (const e of events) {
    const arr = byVehicle.get(e.vehicleId) || [];
    arr.push({ toStatus: e.toStatus, at: e.at });
    byVehicle.set(e.vehicleId, arr);
  }

  const dwell = new Map<string, number[]>();
  for (const [vehicleId, done] of completedAt) {
    const history = (byVehicle.get(vehicleId) || [])
      .filter(e => e.at <= done)
      .sort((a, b) => a.at.localeCompare(b.at));
    // Cycle start: the last transition INTO the shop before this completion.
    let cycleStart = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].toStatus === 'received' || history[i].toStatus === 'checked_in') { cycleStart = i; break; }
    }
    if (cycleStart === -1) continue;
    for (let i = cycleStart; i < history.length; i++) {
      const stage = history[i].toStatus === 'checked_in' ? 'received' : history[i].toStatus;
      if (!(IN_SHOP_DWELL_STAGES as readonly string[]).includes(stage)) continue;
      const leftAt = i + 1 < history.length ? history[i + 1].at : done;
      const days = (Date.parse(leftAt) - Date.parse(history[i].at)) / 86_400_000;
      if (days < 0 || days > 365) continue;
      const arr = dwell.get(stage) || [];
      arr.push(days);
      dwell.set(stage, arr);
    }
  }

  const stages: StageDwell[] = [...dwell.entries()]
    .map(([stage, days]) => ({
      stage,
      medianDays: Math.round((median(days) || 0) * 10) / 10,
      samples: days.length,
    }))
    .sort((a, b) => b.medianDays - a.medianDays);
  const slowest = stages.find(s => s.samples >= 3) || null;
  return { stages, slowest };
}

/** Stage dwell over vehicles completing in the last 30 days. Null on failure. */
export async function loadStageDwell(service: SupabaseClient): Promise<{ stages: StageDwell[]; slowest: StageDwell | null; completions: number } | null> {
  try {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data: doneRows, error } = await fetchAllRows<{ vehicle_id: string; created_at: string }>((from, to) => service
      .from('vehicle_status_history')
      .select('vehicle_id, created_at')
      .eq('to_status', 'complete')
      .gte('created_at', since)
      .order('created_at').order('id')
      .range(from, to));
    if (error) throw new Error(error.message);
    // Ascending scan → the FIRST completion per vehicle in the window wins.
    const completedAt = new Map<string, string>();
    for (const r of doneRows || []) {
      if (!completedAt.has(r.vehicle_id)) completedAt.set(r.vehicle_id, r.created_at);
    }
    if (completedAt.size === 0) return { stages: [], slowest: null, completions: 0 };

    const ids = [...completedAt.keys()];
    const events: { vehicleId: string; toStatus: string; at: string }[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error: hErr } = await fetchAllRows<any>((from, to) => service
        .from('vehicle_status_history')
        .select('vehicle_id, to_status, created_at')
        .in('vehicle_id', ids.slice(i, i + 100))
        .order('created_at').order('id')
        .range(from, to));
      if (hErr) throw new Error(hErr.message);
      for (const e of data || []) events.push({ vehicleId: e.vehicle_id, toStatus: e.to_status, at: e.created_at });
    }
    return { ...computeStageDwell(events, completedAt), completions: completedAt.size };
  } catch (e) {
    console.error('ops-pulse stage dwell failed:', e);
    return null;
  }
}

const GRAPHICS_OUT_STATUSES = ['shipped', 'picked_up', 'installed'];

/** Graphics throughput + proof-approval time. Null on failure. */
export async function loadGraphicsPulse(service: SupabaseClient): Promise<{
  shippedPerWeek: number;
  shipped28d: number;
  proofMedianDays: number | null;
  proofSamples: number;
} | null> {
  try {
    const since28 = new Date(Date.now() - 28 * 86_400_000).toISOString();
    const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const [outRes, proofRes] = await Promise.all([
      fetchAllRows<{ job_id: string }>((from, to) => service
        .from('graphics_status_history')
        .select('job_id, created_at')
        .in('to_status', GRAPHICS_OUT_STATUSES)
        .gte('created_at', since28)
        .order('created_at').order('id')
        .range(from, to)),
      fetchAllRows<{ sent_for_approval_at: string; customer_approved_at: string }>((from, to) => service
        .from('graphics_jobs')
        .select('sent_for_approval_at, customer_approved_at')
        .gte('customer_approved_at', since90)
        .not('sent_for_approval_at', 'is', null)
        .order('customer_approved_at').order('id')
        .range(from, to)),
    ]);
    if (outRes.error) throw new Error(outRes.error.message);
    if (proofRes.error) throw new Error(proofRes.error.message);

    const shippedJobs = new Set((outRes.data || []).map(r => r.job_id));
    const proofDays = (proofRes.data || [])
      .map(r => (Date.parse(r.customer_approved_at) - Date.parse(r.sent_for_approval_at)) / 86_400_000)
      .filter(d => d >= 0 && d < 180);
    const proofMedian = median(proofDays);
    return {
      shipped28d: shippedJobs.size,
      shippedPerWeek: Math.round((shippedJobs.size / 4) * 10) / 10,
      proofMedianDays: proofMedian == null ? null : Math.round(proofMedian * 10) / 10,
      proofSamples: proofDays.length,
    };
  } catch (e) {
    console.error('ops-pulse graphics failed:', e);
    return null;
  }
}

/**
 * Completed/shipped vehicles with NO invoice anywhere — the same predicate
 * as the OpsDashboard's never-invoiced queue (R3-14c): neither the legacy
 * scalar nor a stamped per-SO ledger row; 180-day window; archived rows
 * stay IN. Null on failure.
 */
export async function loadNeverInvoicedCount(service: SupabaseClient): Promise<number | null> {
  try {
    const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
    const { data: done, error } = await fetchAllRows<{ id: string }>((from, to) => service
      .from('fleet_checkins')
      .select('id')
      .in('status', ['complete', 'shipped'])
      .is('invoice_number', null)
      .gte('created_at', cutoff)
      .order('id')
      .range(from, to));
    if (error) throw new Error(error.message);
    const ids = (done || []).map(c => c.id);
    const billed = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await service
        .from('fleet_checkin_invoices')
        .select('fleet_checkin_id')
        .in('fleet_checkin_id', ids.slice(i, i + 200))
        .not('invoice_number', 'is', null);
      for (const r of data || []) billed.add(r.fleet_checkin_id);
    }
    return ids.filter(id => !billed.has(id)).length;
  } catch (e) {
    console.error('ops-pulse never-invoiced failed:', e);
    return null;
  }
}

/** Latest cached leading-margin snapshot (R5-10's nightly metric) — the
 *  band's margin tile reads this, never inline SuiteQL. Null until the
 *  metric accrues. */
export async function loadLeadingMargin(service: SupabaseClient): Promise<{ pct: number; day: string } | null> {
  try {
    const { data } = await service
      .from('metric_snapshots')
      .select('day, value')
      .eq('metric', 'quoted_margin_pct_30d')
      .not('value', 'is', null)
      .order('day', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.value != null ? { pct: Number(data.value), day: data.day } : null;
  } catch (e) {
    console.error('ops-pulse leading margin failed:', e);
    return null;
  }
}
