import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { fetchOpenArInvoices, computeArAging, type AgingBucketKey } from './financials-data';
import { loadRevenuePeriods } from './revenue-summary';
import { getCollectionsFromRestlet } from './netsuite';
import { chicagoDay } from './exec-metrics';

/**
 * Days-to-Pay & A/R trends (R5-6): the read side of R5-1's captures.
 * - DSO now = live open A/R ÷ (trailing-12-month revenue / 365) — computable
 *   from day one; the DSO/aging TREND reads ar_snapshots and grows a point
 *   per night from the capture ship date.
 * - Days-to-pay per customer comes from date_invoiced → paid_at, where
 *   paid_at is when the 2-hourly sweep NOTICED Paid In Full (not the
 *   payment's posting date) — labeled as such, NULL rows excluded.
 * - Payments-posted-this-week reads the RESTlet collections mode and
 *   degrades with the redeploy hint until it's deployed.
 */

export interface ArSnapshotDay {
  day: string;
  total: number;
  buckets: Record<AgingBucketKey, number>;
}

/** Pivot ar_snapshots rows (scope total/bucket) into one entry per day, oldest first. */
export function pivotArSnapshots(rows: { day: string; scope: string; key: string; value: number }[]): ArSnapshotDay[] {
  const byDay = new Map<string, ArSnapshotDay>();
  for (const r of rows) {
    if (r.scope !== 'total' && r.scope !== 'bucket') continue;
    let entry = byDay.get(r.day);
    if (!entry) {
      entry = { day: r.day, total: 0, buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 } };
      byDay.set(r.day, entry);
    }
    if (r.scope === 'total') entry.total = r.value;
    else if (r.key in entry.buckets) entry.buckets[r.key as AgingBucketKey] = r.value;
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export interface SlowPayer {
  customer: string;
  medianDays: number;
  invoices: number;
}

/** Whole calendar days between two date-ish strings (paid stamp minus invoice date). */
function daysBetween(invoiced: string, paid: string): number | null {
  const a = Date.parse(String(invoiced).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(paid).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Median days-to-pay per customer from paid rows. One sample per distinct
 * invoice number (a multi-scan invoice is one payment event), negatives
 * dropped (bad hand-entered dates). Slowest first; ties by volume.
 */
export function computeSlowPayers(
  rows: { customer: string | null; invoice: string | null; invoiced: string | null; paid: string | null }[],
  minInvoices = 2,
  topN = 12,
): SlowPayer[] {
  const byCustomer = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const customer = (r.customer || '').trim();
    if (!customer || !r.invoice || !r.invoiced || !r.paid) continue;
    const days = daysBetween(r.invoiced, r.paid);
    if (days == null || days < 0 || days > 400) continue;
    let invoices = byCustomer.get(customer);
    if (!invoices) { invoices = new Map(); byCustomer.set(customer, invoices); }
    if (!invoices.has(r.invoice)) invoices.set(r.invoice, days);
  }
  const out: SlowPayer[] = [];
  for (const [customer, invoices] of byCustomer) {
    if (invoices.size < minInvoices) continue;
    const days = [...invoices.values()].sort((a, b) => a - b);
    const mid = Math.floor(days.length / 2);
    const median = days.length % 2 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
    out.push({ customer, medianDays: Math.round(median * 10) / 10, invoices: invoices.size });
  }
  return out.sort((a, b) => b.medianDays - a.medianDays || b.invoices - a.invoices).slice(0, topN);
}

export interface ArTrends {
  dsoNow: number | null;
  trailing12Revenue: number | null;
  snapshots: ArSnapshotDay[];
  snapshotsSince: string | null;
  slowestPayers: SlowPayer[];
  paidSamples: number;
  paymentsThisWeek: { total: number; count: number } | { error: string };
}

export async function loadArTrends(service: SupabaseClient): Promise<ArTrends> {
  const today = chicagoDay();
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);

  const [agingRes, revenueRes, snapRes, fleetPaid, scanPaid, weekRes] = await Promise.allSettled([
    fetchOpenArInvoices().then(r => computeArAging(r.invoices)),
    loadRevenuePeriods(),
    fetchAllRows<any>((from, to) => service
      .from('ar_snapshots')
      .select('day, scope, key, value')
      .gte('day', since)
      .order('day').order('id')
      .range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('fleet_checkins')
      .select('customer_name, invoice_number, date_invoiced, paid_at')
      .not('paid_at', 'is', null).not('date_invoiced', 'is', null)
      .order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('scan_logs')
      .select('billable_customer, invoice_number, date_invoiced, paid_at')
      .not('paid_at', 'is', null).not('date_invoiced', 'is', null)
      .order('id').range(from, to)),
    getCollectionsFromRestlet(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10), today),
  ]);

  const aging = agingRes.status === 'fulfilled' ? agingRes.value : null;
  const revenue = revenueRes.status === 'fulfilled' ? revenueRes.value : null;
  const dailyRevenue = revenue && revenue.trailing12 > 0 ? revenue.trailing12 / 365 : null;

  const snapRows = snapRes.status === 'fulfilled' ? (snapRes.value.data || []) : [];
  const snapshots = pivotArSnapshots(snapRows);

  const paidRows = [
    ...(fleetPaid.status === 'fulfilled' ? (fleetPaid.value.data || []) : []).map((r: any) => ({
      customer: r.customer_name, invoice: r.invoice_number, invoiced: r.date_invoiced, paid: r.paid_at,
    })),
    ...(scanPaid.status === 'fulfilled' ? (scanPaid.value.data || []) : []).map((r: any) => ({
      customer: r.billable_customer, invoice: r.invoice_number, invoiced: r.date_invoiced, paid: r.paid_at,
    })),
  ];

  const week = weekRes.status === 'fulfilled' ? weekRes.value : { success: false as const, error: 'Collections lookup failed' };

  return {
    dsoNow: aging && dailyRevenue ? Math.round((aging.total / dailyRevenue) * 10) / 10 : null,
    trailing12Revenue: revenue ? revenue.trailing12 : null,
    snapshots,
    snapshotsSince: snapshots[0]?.day || null,
    slowestPayers: computeSlowPayers(paidRows),
    paidSamples: paidRows.length,
    paymentsThisWeek: week.success
      ? { total: Math.abs(week.total || 0), count: week.count || 0 }
      : { error: week.error || 'Collections unavailable' },
  };
}
