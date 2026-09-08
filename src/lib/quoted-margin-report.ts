import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * Quoted Margin report (R5-10): the read side of R5-3's freeze-at-send
 * capture (migration 275). Every estimate SEND froze parts cost, parts
 * margin %, the floor in force, and any below-floor reason on the header —
 * this lib rolls those frozen rows up by rep / customer / month, buckets
 * the distribution against each row's own frozen floor, and lists the
 * below-floor sends with who/when/why.
 *
 * quoted_margin_pct is the PARTS margin over costed lines only (custom
 * lines with no part cost are excluded, never treated as 100%) — label it
 * that way wherever it renders. Rows with no costed lines carry NULL and
 * are counted as "unknown margin", not averaged.
 */

export interface FrozenQuoteRow {
  id: string;
  number: string;
  customer: string;
  total: number;
  costTotal: number | null;
  marginPct: number | null;
  belowFloor: boolean;
  floorPct: number | null;
  reason: string | null;
  frozenAt: string;
  senderId: string | null;
  status: string;
}

/** Value-weighted average of frozen margin %s — Σ(pct×total)/Σtotal over
 *  rows that HAVE a margin and a positive total; null when none do. */
export function weightedMarginPct(rows: { marginPct: number | null; total: number }[]): number | null {
  let num = 0, den = 0;
  for (const r of rows) {
    if (r.marginPct == null || !(r.total > 0)) continue;
    num += r.marginPct * r.total;
    den += r.total;
  }
  return den > 0 ? Math.round((num / den) * 10) / 10 : null;
}

export type FloorBucket = 'below' | 'floor0_10' | 'floor10_20' | 'floor20p' | 'unknown';

/** Where a frozen margin sits against the floor frozen WITH it. */
export function classifyVsFloor(marginPct: number | null, floorPct: number | null): FloorBucket {
  if (marginPct == null || floorPct == null) return 'unknown';
  if (marginPct < floorPct) return 'below';
  const over = marginPct - floorPct;
  if (over < 10) return 'floor0_10';
  if (over < 20) return 'floor10_20';
  return 'floor20p';
}

interface Rollup {
  count: number;
  value: number;
  weightedMarginPct: number | null;
  belowFloor: number;
}

export interface QuotedMarginSummary {
  totals: Rollup & { unknownMargin: number; belowFloorValue: number };
  byRep: ({ senderId: string } & Rollup)[];
  byCustomer: ({ customer: string } & Rollup)[];
  byMonth: ({ month: string } & Omit<Rollup, 'belowFloor'>)[];
  distribution: Record<FloorBucket, { count: number; value: number }>;
  belowFloorList: FrozenQuoteRow[]; // newest first
}

export function summarizeQuotedMargins(rows: FrozenQuoteRow[]): QuotedMarginSummary {
  const rollup = (list: FrozenQuoteRow[]): Rollup => ({
    count: list.length,
    value: Math.round(list.reduce((s, r) => s + r.total, 0) * 100) / 100,
    weightedMarginPct: weightedMarginPct(list),
    belowFloor: list.filter(r => r.belowFloor).length,
  });

  const groupBy = (key: (r: FrozenQuoteRow) => string) => {
    const map = new Map<string, FrozenQuoteRow[]>();
    for (const r of rows) {
      const k = key(r);
      const arr = map.get(k) || [];
      arr.push(r);
      map.set(k, arr);
    }
    return map;
  };

  const distribution: QuotedMarginSummary['distribution'] = {
    below: { count: 0, value: 0 }, floor0_10: { count: 0, value: 0 },
    floor10_20: { count: 0, value: 0 }, floor20p: { count: 0, value: 0 },
    unknown: { count: 0, value: 0 },
  };
  for (const r of rows) {
    const bucket = distribution[classifyVsFloor(r.marginPct, r.floorPct)];
    bucket.count++;
    bucket.value = Math.round((bucket.value + r.total) * 100) / 100;
  }

  const belowFloorRows = rows.filter(r => r.belowFloor);
  return {
    totals: {
      ...rollup(rows),
      unknownMargin: rows.filter(r => r.marginPct == null).length,
      belowFloorValue: Math.round(belowFloorRows.reduce((s, r) => s + r.total, 0) * 100) / 100,
    },
    byRep: [...groupBy(r => r.senderId || 'unknown').entries()]
      .map(([senderId, list]) => ({ senderId, ...rollup(list) }))
      .sort((a, b) => b.value - a.value),
    byCustomer: [...groupBy(r => r.customer || '—').entries()]
      .map(([customer, list]) => ({ customer, ...rollup(list) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 20),
    byMonth: [...groupBy(r => r.frozenAt.slice(0, 7)).entries()]
      .map(([month, list]) => {
        const r = rollup(list);
        return { month, count: r.count, value: r.value, weightedMarginPct: r.weightedMarginPct };
      })
      .sort((a, b) => a.month.localeCompare(b.month)),
    distribution,
    belowFloorList: belowFloorRows.sort((a, b) => b.frozenAt.localeCompare(a.frozenAt)),
  };
}

/** Every estimate whose margin snapshot was frozen in [start, endNext). */
export async function loadFrozenQuotes(
  service: SupabaseClient,
  start: string,
  endNext: string,
): Promise<FrozenQuoteRow[]> {
  const { data, error } = await fetchAllRows<any>((from, to) => service
    .from('estimates')
    .select('id, estimate_number, customer_name, grand_total, quoted_cost_total, quoted_margin_pct, quoted_below_floor, quoted_floor_pct, below_floor_reason, quoted_margin_at, sent_for_approval_by, status')
    .gte('quoted_margin_at', start)
    .lt('quoted_margin_at', endNext)
    .order('quoted_margin_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  return (data || []).map((e: any) => ({
    id: e.id,
    number: e.estimate_number || '—',
    customer: e.customer_name || '—',
    total: Number(e.grand_total) || 0,
    costTotal: e.quoted_cost_total != null ? Number(e.quoted_cost_total) : null,
    marginPct: e.quoted_margin_pct != null ? Number(e.quoted_margin_pct) : null,
    belowFloor: e.quoted_below_floor === true,
    floorPct: e.quoted_floor_pct != null ? Number(e.quoted_floor_pct) : null,
    reason: e.below_floor_reason,
    frozenAt: e.quoted_margin_at,
    senderId: e.sent_for_approval_by,
    status: e.status,
  }));
}
