import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchOpenArInvoices, computeArAging, arCustomerKey, type OpenArInvoice } from './financials-data';
import { chicagoDay } from './exec-metrics';

/**
 * Nightly A/R snapshots (R5-1): persist the same numbers the Financials
 * tab computes live — open total, each aging bucket, and the top open
 * customers — so DSO and "is our A/R getting better or worse" become
 * chartable. Reuses computeArAging/arCustomerKey EXACTLY so a trend point
 * can never disagree with the live tab. Ridden by the metric-snapshots
 * cron (04:30 UTC); upsert per (day, scope, key) keeps re-runs idempotent.
 */

const TOP_CUSTOMERS = 20;

export interface ArSnapshotRow {
  day: string;
  scope: 'total' | 'bucket' | 'customer';
  key: string;
  label: string | null;
  value: number;
  meta: Record<string, unknown> | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: the snapshot rows for one day from an open-invoice read. */
export function buildArSnapshotRows(invoices: OpenArInvoice[], day: string): ArSnapshotRow[] {
  const aging = computeArAging(invoices);
  const rows: ArSnapshotRow[] = [
    {
      day, scope: 'total', key: 'total', label: null,
      value: round2(aging.total),
      meta: { openCount: aging.openCount, pastDue: round2(aging.pastDue) },
    },
    ...Object.entries(aging.buckets).map(([key, value]) => ({
      day, scope: 'bucket' as const, key, label: null, value: round2(value), meta: null,
    })),
  ];

  // Top open customers by TOTAL open balance (stable selection — the trend
  // needs the same accounts night over night, not whoever is most overdue
  // today), keyed by arCustomerKey so same-named accounts never merge.
  const byCustomer = new Map<string, { key: string; customer: string; open: number; pastDue: number }>();
  for (const inv of invoices) {
    const key = arCustomerKey(inv);
    const cur = byCustomer.get(key) || { key, customer: inv.customer, open: 0, pastDue: 0 };
    cur.open += inv.unpaid;
    if (inv.bucket !== 'current') cur.pastDue += inv.unpaid;
    byCustomer.set(key, cur);
  }
  const top = [...byCustomer.values()]
    .sort((a, b) => b.open - a.open || a.key.localeCompare(b.key))
    .slice(0, TOP_CUSTOMERS);
  for (const c of top) {
    rows.push({
      day, scope: 'customer', key: c.key, label: c.customer,
      value: round2(c.open),
      meta: { pastDue: round2(c.pastDue) },
    });
  }
  return rows;
}

/** One open-AR read → upserted snapshot rows. Returns what it wrote. */
export async function writeArSnapshots(
  service: SupabaseClient,
  day: string = chicagoDay(),
): Promise<{ rows: number; total: number }> {
  const { invoices } = await fetchOpenArInvoices();
  const rows = buildArSnapshotRows(invoices, day);
  const { error } = await service
    .from('ar_snapshots')
    .upsert(rows, { onConflict: 'day,scope,key' });
  if (error) throw new Error('ar_snapshots upsert: ' + error.message);
  return { rows: rows.length, total: rows[0]?.value ?? 0 };
}
