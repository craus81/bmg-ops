import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { chicagoDay } from './exec-metrics';

/**
 * Promised-back tracking (R4-6): every check-in captures
 * fleet_checkins.promised_back_date (migration 158), but nothing defended it
 * or measured it. This lib is the shared source for both halves — the daily
 * guardian cron (open commitments approaching/overdue) and the on-time
 * scorecard (kept vs missed, from the completion transitions in
 * vehicle_status_history) — so the alert and the report can never disagree.
 *
 * Dates are calendar days: promised_back_date is a DATE, completions key on
 * the shop's Chicago day. A vehicle completed ON its promised day is on time.
 */

export type PromiseOutcome = 'on_time' | 'late' | 'no_promise';

export function classifyPromise(promised: string | null, completedDay: string): PromiseOutcome {
  if (!promised) return 'no_promise';
  // Both YYYY-MM-DD — lexicographic compare is date compare.
  return completedDay <= promised ? 'on_time' : 'late';
}

/** Whole calendar days from `from` to `to` (YYYY-MM-DD each); negative when `to` is earlier. */
export function dateDiffDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export interface CompletionRow {
  vehicleId: string;
  customerName: string | null;
  promised: string | null; // YYYY-MM-DD
  completedDay: string; // YYYY-MM-DD, Chicago
}

export interface OnTimeBucket {
  completed: number;
  onTime: number;
  late: number;
  noPromise: number;
  /** % kept among completions that HAD a promise; null when none did. */
  pct: number | null;
  /** Average days past the promise among the late ones. */
  avgDaysLate: number;
}

function emptyBucket(): OnTimeBucket {
  return { completed: 0, onTime: 0, late: 0, noPromise: 0, pct: null, avgDaysLate: 0 };
}

function addTo(bucket: OnTimeBucket & { lateDaysSum?: number }, row: CompletionRow): void {
  bucket.completed++;
  const outcome = classifyPromise(row.promised, row.completedDay);
  if (outcome === 'on_time') bucket.onTime++;
  else if (outcome === 'no_promise') bucket.noPromise++;
  else {
    bucket.late++;
    bucket.lateDaysSum = (bucket.lateDaysSum || 0) + dateDiffDays(row.promised!, row.completedDay);
  }
}

function finishBucket(bucket: OnTimeBucket & { lateDaysSum?: number }): OnTimeBucket {
  const promised = bucket.onTime + bucket.late;
  bucket.pct = promised > 0 ? Math.round((bucket.onTime / promised) * 100) : null;
  bucket.avgDaysLate = bucket.late > 0 ? Math.round(((bucket.lateDaysSum || 0) / bucket.late) * 10) / 10 : 0;
  delete bucket.lateDaysSum;
  return bucket;
}

export interface OnTimeSummary {
  overall: OnTimeBucket;
  monthly: ({ month: string } & OnTimeBucket)[]; // oldest first
  perCustomer: ({ customer: string } & OnTimeBucket)[]; // most completions first
}

export function summarizeOnTime(rows: CompletionRow[]): OnTimeSummary {
  const overall = emptyBucket();
  const byMonth = new Map<string, OnTimeBucket>();
  const byCustomer = new Map<string, OnTimeBucket>();
  for (const row of rows) {
    addTo(overall, row);
    const month = row.completedDay.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, emptyBucket());
    addTo(byMonth.get(month)!, row);
    const customer = (row.customerName || '').trim() || '(no customer)';
    if (!byCustomer.has(customer)) byCustomer.set(customer, emptyBucket());
    addTo(byCustomer.get(customer)!, row);
  }
  return {
    overall: finishBucket(overall),
    monthly: [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, b]) => ({ month, ...finishBucket(b) })),
    perCustomer: [...byCustomer.entries()]
      .map(([customer, b]) => ({ customer, ...finishBucket(b) }))
      .sort((a, b) => b.completed - a.completed || a.customer.localeCompare(b.customer)),
  };
}

/**
 * Every completion since `sinceDay` (Chicago YYYY-MM-DD) with its promise.
 * The completion event is the vehicle's earliest transition to 'complete'
 * (or to 'shipped' for vehicles force-jumped past complete). Archived
 * vehicles are INCLUDED — archiving is how finished vehicles leave the
 * board, and a scorecard that forgets them empties itself within weeks.
 */
export async function loadCompletions(service: SupabaseClient, sinceDay: string): Promise<CompletionRow[]> {
  const sinceIso = `${sinceDay}T00:00:00-06:00`; // Chicago is UTC-5/-6; the hour of slack is irrelevant at month grain
  const { data: history, error } = await fetchAllRows<{
    vehicle_id: string; to_status: string; created_at: string;
  }>((from, to) => service
    .from('vehicle_status_history')
    .select('id, vehicle_id, to_status, created_at')
    .in('to_status', ['complete', 'shipped'])
    .gte('created_at', sinceIso)
    .order('created_at').order('id')
    .range(from, to));
  if (error) throw new Error('on-time history: ' + error.message);

  // Ascending scan: keep each vehicle's FIRST 'complete'; a 'shipped' row
  // only stands in when no 'complete' exists in the window.
  const completeAt = new Map<string, string>();
  const shippedAt = new Map<string, string>();
  for (const h of history || []) {
    const map = h.to_status === 'complete' ? completeAt : shippedAt;
    if (!map.has(h.vehicle_id)) map.set(h.vehicle_id, h.created_at);
  }
  const completedAt = new Map<string, string>(shippedAt);
  for (const [id, at] of completeAt) completedAt.set(id, at);

  const ids = [...completedAt.keys()];
  const rows: CompletionRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: checkins, error: cErr } = await service
      .from('fleet_checkins')
      .select('id, customer_name, promised_back_date')
      .in('id', chunk);
    if (cErr) throw new Error('on-time checkins: ' + cErr.message);
    for (const c of checkins || []) {
      rows.push({
        vehicleId: c.id,
        customerName: c.customer_name,
        promised: c.promised_back_date,
        completedDay: chicagoDay(new Date(completedAt.get(c.id)!)),
      });
    }
  }
  return rows;
}

/** In-shop statuses — loadShopCounts' list (checked_in is the legacy synonym of received). */
export const OPEN_STATUSES = ['received', 'checked_in', 'in_progress', 'stuck_parts', 'stuck_graphics'];

export interface OpenCommitment {
  id: string;
  vin: string | null;
  label: string;
  customerName: string | null;
  status: string;
  assignedTo: string | null;
  promised: string; // YYYY-MM-DD
  /** Days until the promise from today (Chicago); negative = overdue. */
  daysUntil: number;
}

/** Every unarchived in-shop vehicle carrying a promise date, soonest first. */
export async function loadOpenCommitments(service: SupabaseClient): Promise<OpenCommitment[]> {
  const today = chicagoDay();
  const { data, error } = await fetchAllRows<any>((from, to) => service
    .from('fleet_checkins')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, status, assigned_to, promised_back_date')
    .in('status', OPEN_STATUSES)
    .is('archived_at', null)
    .not('promised_back_date', 'is', null)
    .order('promised_back_date').order('id')
    .range(from, to));
  if (error) throw new Error('open commitments: ' + error.message);
  return (data || []).map((v: any) => ({
    id: v.id,
    vin: v.vin,
    label: [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ')
      || `VIN …${String(v.vin || '').slice(-8)}`,
    customerName: v.customer_name,
    status: v.status,
    assignedTo: v.assigned_to,
    promised: v.promised_back_date,
    daysUntil: dateDiffDays(today, v.promised_back_date),
  }));
}
