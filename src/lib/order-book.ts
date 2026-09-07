import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { isOpenSalesOrderStatus } from './parts-demand';

interface UnbilledLine {
  quantity: number | string | null;
  quantity_billed: number | string | null;
  rate: number | string | null;
  amount: number | string | null;
}

/**
 * Sold-but-not-yet-invoiced dollars on one mirrored SO line. Prefer the
 * line's real amount scaled by the unbilled fraction (amount already carries
 * discounts); fall back to remaining × rate when amount is missing.
 */
export function unbilledLineValue(line: UnbilledLine): number {
  const qty = Number(line.quantity) || 0;
  const billed = Number(line.quantity_billed) || 0;
  const remaining = Math.max(0, qty - billed);
  if (remaining <= 0) return 0;
  const amount = line.amount != null ? Number(line.amount) : NaN;
  if (qty > 0 && Number.isFinite(amount)) return amount * (remaining / qty);
  return remaining * (Number(line.rate) || 0);
}

/**
 * The open order book (R4-3): every open sales order in the 2-hourly
 * NetSuite mirror with its sold total, what's already been billed, and the
 * unbilled remainder — "money we've sold but not yet invoiced", which
 * nothing surfaced before this despite the mirror carrying it since 2024.
 *
 * One loader serves the report page, the nightly metric snapshots, and the
 * CEO Operations band, so the headline number can never disagree with the
 * report behind it. Open/closed uses parts-demand's isOpenSalesOrderStatus
 * (the app's one open-SO predicate); unbilled uses exec-metrics'
 * unbilledLineValue (amount scaled by the unbilled fraction, rate fallback).
 */

export interface OrderBookRow {
  id: string;
  netsuiteId: string;
  tranid: string | null;
  customerName: string | null;
  trandate: string | null;
  statusLabel: string | null;
  total: number;
  unbilled: number;
  billedPct: number; // 0-100, of sold value
  ageDays: number;
}

export interface OrderBookTotals {
  count: number;
  value: number;
  unbilled: number;
  over60Count: number;
  aging: { d0_30: number; d31_60: number; d61_90: number; d90plus: number };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function orderAgeDays(trandate: string | null, now: Date = new Date()): number {
  if (!trandate) return 0;
  const t = Date.parse(trandate);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function summarizeOrderBook(rows: OrderBookRow[]): OrderBookTotals {
  const totals: OrderBookTotals = {
    count: rows.length,
    value: 0,
    unbilled: 0,
    over60Count: 0,
    aging: { d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 },
  };
  for (const r of rows) {
    totals.value += r.total;
    totals.unbilled += r.unbilled;
    if (r.ageDays > 60) totals.over60Count++;
    const bucket = r.ageDays <= 30 ? 'd0_30' : r.ageDays <= 60 ? 'd31_60' : r.ageDays <= 90 ? 'd61_90' : 'd90plus';
    totals.aging[bucket] += r.total;
  }
  totals.value = round2(totals.value);
  totals.unbilled = round2(totals.unbilled);
  for (const k of Object.keys(totals.aging) as (keyof OrderBookTotals['aging'])[]) {
    totals.aging[k] = round2(totals.aging[k]);
  }
  return totals;
}

export async function loadOrderBook(service: SupabaseClient): Promise<{ rows: OrderBookRow[]; totals: OrderBookTotals }> {
  const { data: sos, error } = await fetchAllRows<any>((from, to) => service
    .from('netsuite_sales_orders')
    .select('id, netsuite_id, tranid, customer_name, trandate, status, status_label, total')
    .order('id').range(from, to));
  if (error) throw new Error('order book: ' + error.message);
  const open = (sos || []).filter(so => isOpenSalesOrderStatus(so.status, so.status_label));

  const unbilledBySo = new Map<string, number>();
  const openIds = open.map(so => so.id);
  for (let i = 0; i < openIds.length; i += 100) {
    const chunk = openIds.slice(i, i + 100);
    const { data: lines, error: lErr } = await fetchAllRows<any>((from, to) => service
      .from('netsuite_sales_order_lines')
      .select('so_id, quantity, quantity_billed, rate, amount')
      .in('so_id', chunk)
      .order('id').range(from, to));
    if (lErr) throw new Error('order book lines: ' + lErr.message);
    for (const line of lines || []) {
      unbilledBySo.set(line.so_id, (unbilledBySo.get(line.so_id) || 0) + unbilledLineValue(line));
    }
  }

  const rows: OrderBookRow[] = open.map(so => {
    const total = Number(so.total) || 0;
    const unbilled = round2(unbilledBySo.get(so.id) || 0);
    return {
      id: so.id,
      netsuiteId: so.netsuite_id,
      tranid: so.tranid,
      customerName: so.customer_name,
      trandate: so.trandate,
      statusLabel: so.status_label || so.status,
      total: round2(total),
      unbilled,
      billedPct: total > 0 ? Math.round(Math.max(0, Math.min(1, 1 - unbilled / total)) * 100) : 0,
      ageDays: orderAgeDays(so.trandate),
    };
  }).sort((a, b) => b.ageDays - a.ageDays || (b.total - a.total));

  return { rows, totals: summarizeOrderBook(rows) };
}
