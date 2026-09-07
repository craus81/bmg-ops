import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { fetchOpenArInvoices, computeArAging, fetchAccountGroups, fetchOpenVendorBills } from './financials-data';
import { isOpenSalesOrderStatus } from './parts-demand';

/**
 * Executive metrics (Round 4 / R4-1): the one place the numbers behind the
 * CEO view and the nightly metric_snapshots cron are computed, so a tile
 * never disagrees with the snapshot behind its sparkline. Query semantics
 * deliberately mirror their originals — open quotes and the pipeline match
 * OpsDashboard's tiles (which match /quotes and the CRM), the order book
 * matches parts-demand's open-SO predicate — and each origin is noted so
 * a change there gets mirrored here.
 *
 * Every metric is computed independently and failure is recorded, not
 * spread: a NetSuite/RESTlet error makes THAT metric null with the error
 * in meta (a snapshot of 0 would make trend charts lie), while the
 * Supabase-only metrics still snapshot.
 */

export interface ExecMetric {
  metric: string;
  value: number | null;
  meta?: Record<string, unknown>;
}

/** The America/Chicago calendar date (YYYY-MM-DD) — snapshots key on shop days, not UTC days. */
export function chicagoDay(at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(at);
}

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

const round2 = (n: number) => Math.round(n * 100) / 100;

async function collectFinancials(out: ExecMetric[]): Promise<void> {
  // A/R from open invoices (SuiteQL); cash and A/P from the financials
  // RESTlet — each can fail independently.
  try {
    const { invoices } = await fetchOpenArInvoices();
    const aging = computeArAging(invoices);
    out.push({ metric: 'ar_total', value: round2(aging.total) });
    out.push({ metric: 'ar_current', value: round2(aging.buckets.current) });
    out.push({ metric: 'ar_1_30', value: round2(aging.buckets.d1_30) });
    out.push({ metric: 'ar_31_60', value: round2(aging.buckets.d31_60) });
    out.push({ metric: 'ar_61_90', value: round2(aging.buckets.d61_90) });
    out.push({ metric: 'ar_90_plus', value: round2(aging.buckets.d90plus) });
  } catch (e: any) {
    const meta = { error: String(e?.message || e).slice(0, 300) };
    for (const m of ['ar_total', 'ar_current', 'ar_1_30', 'ar_31_60', 'ar_61_90', 'ar_90_plus']) {
      out.push({ metric: m, value: null, meta });
    }
  }

  try {
    const acct = await fetchAccountGroups();
    if (!acct.success) throw new Error(acct.error || 'financials RESTlet unavailable');
    const cash = acct.bank.reduce((s: number, a: any) => s + (a.balance || 0), 0);
    const cardOwed = acct.card.reduce((s: number, a: any) => s + (a.balance || 0), 0);
    const salesTax = acct.salesTax.reduce((s: number, a: any) => s + (a.balance || 0), 0);
    let vendorBills = 0;
    try {
      const { bills } = await fetchOpenVendorBills();
      vendorBills = bills.reduce((s: number, b: any) => s + (b.unpaid || 0), 0);
    } catch { /* bills alone failing leaves ap = card + tax, still recorded */ }
    out.push({ metric: 'cash', value: round2(cash) });
    out.push({ metric: 'ap_total', value: round2(vendorBills + cardOwed + salesTax) });
  } catch (e: any) {
    const meta = { error: String(e?.message || e).slice(0, 300) };
    out.push({ metric: 'cash', value: null, meta });
    out.push({ metric: 'ap_total', value: null, meta });
  }
}

async function collectSales(service: SupabaseClient, out: ExecMetric[]): Promise<void> {
  try {
    // Open quotes = wrap quotes (draft/sent, unarchived) + estimates
    // (draft/pushed/sent) — the OpsDashboard/quote-list semantics.
    const [{ data: wraps, error: wErr }, { data: ests, error: eErr }] = await Promise.all([
      fetchAllRows<any>((from, to) => service.from('wrap_quotes')
        .select('total').in('status', ['draft', 'sent']).is('archived_at', null)
        .order('id').range(from, to)),
      fetchAllRows<any>((from, to) => service.from('estimates')
        .select('grand_total').in('status', ['draft', 'pushed', 'sent'])
        .order('id').range(from, to)),
    ]);
    if (wErr || eErr) throw new Error((wErr || eErr)!.message);
    const count = (wraps || []).length + (ests || []).length;
    const value = (wraps || []).reduce((s, q) => s + (Number(q.total) || 0), 0)
      + (ests || []).reduce((s, e2) => s + (Number(e2.grand_total) || 0), 0);
    out.push({ metric: 'open_quotes_count', value: count });
    out.push({ metric: 'open_quotes_value', value: round2(value) });
  } catch (e: any) {
    const meta = { error: String(e?.message || e).slice(0, 300) };
    out.push({ metric: 'open_quotes_count', value: null, meta });
    out.push({ metric: 'open_quotes_value', value: null, meta });
  }

  try {
    // Pipeline = open deal stages only (lead/quoted/negotiating), matching
    // the dashboard's pipeline band.
    const { data, error } = await fetchAllRows<any>((from, to) => service
      .from('prospect_opportunities').select('stage, value')
      .in('stage', ['lead', 'quoted', 'negotiating'])
      .order('id').range(from, to));
    if (error) throw new Error(error.message);
    out.push({ metric: 'pipeline_deals', value: (data || []).length });
    out.push({ metric: 'pipeline_value', value: round2((data || []).reduce((s, o) => s + (Number(o.value) || 0), 0)) });
  } catch (e: any) {
    const meta = { error: String(e?.message || e).slice(0, 300) };
    out.push({ metric: 'pipeline_deals', value: null, meta });
    out.push({ metric: 'pipeline_value', value: null, meta });
  }
}

async function collectOrderBook(service: SupabaseClient, out: ExecMetric[]): Promise<void> {
  try {
    const { data: sos, error } = await fetchAllRows<any>((from, to) => service
      .from('netsuite_sales_orders')
      .select('id, status, status_label, total')
      .order('id').range(from, to));
    if (error) throw new Error(error.message);
    const open = (sos || []).filter(so => isOpenSalesOrderStatus(so.status, so.status_label));
    out.push({ metric: 'so_order_book_count', value: open.length });
    out.push({ metric: 'so_order_book_value', value: round2(open.reduce((s, so) => s + (Number(so.total) || 0), 0)) });

    let unbilled = 0;
    const openIds = open.map(so => so.id);
    for (let i = 0; i < openIds.length; i += 100) {
      const chunk = openIds.slice(i, i + 100);
      const { data: lines, error: lErr } = await fetchAllRows<any>((from, to) => service
        .from('netsuite_sales_order_lines')
        .select('quantity, quantity_billed, rate, amount')
        .in('so_id', chunk)
        .order('id').range(from, to));
      if (lErr) throw new Error(lErr.message);
      for (const line of lines || []) unbilled += unbilledLineValue(line);
    }
    out.push({ metric: 'so_unbilled_value', value: round2(unbilled) });
  } catch (e: any) {
    const meta = { error: String(e?.message || e).slice(0, 300) };
    for (const m of ['so_order_book_count', 'so_order_book_value', 'so_unbilled_value']) {
      out.push({ metric: m, value: null, meta });
    }
  }
}

async function collectShop(service: SupabaseClient, out: ExecMetric[]): Promise<void> {
  try {
    const [{ count: inShop, error: e1 }, { count: doneNotShipped, error: e2 }] = await Promise.all([
      service.from('fleet_checkins').select('id', { count: 'exact', head: true })
        .in('status', ['received', 'checked_in', 'in_progress', 'stuck_parts', 'stuck_graphics'])
        .is('archived_at', null),
      service.from('fleet_checkins').select('id', { count: 'exact', head: true })
        .eq('status', 'complete')
        .is('archived_at', null),
    ]);
    if (e1 || e2) throw new Error((e1 || e2)!.message);
    out.push({ metric: 'vehicles_in_shop', value: inShop || 0 });
    out.push({ metric: 'vehicles_complete_not_shipped', value: doneNotShipped || 0 });
  } catch (e: any) {
    const meta = { error: String(e?.message || e).slice(0, 300) };
    out.push({ metric: 'vehicles_in_shop', value: null, meta });
    out.push({ metric: 'vehicles_complete_not_shipped', value: null, meta });
  }
}

async function collectRevenueMtd(out: ExecMetric[]): Promise<void> {
  try {
    // Same CustInvc line filters as /api/reports/invoiced-summary, uncached
    // (this runs nightly, not per page view).
    const { suiteqlQuery } = await import('./netsuite');
    const now = chicagoDay();
    const monthStart = now.slice(0, 8) + '01';
    const q = `
      SELECT SUM(-tl.netamount) AS mtd
      FROM transaction t
      INNER JOIN transactionline tl ON tl.transaction = t.id
      WHERE t.type = 'CustInvc'
        AND t.trandate >= TO_DATE('${monthStart}', 'YYYY-MM-DD')
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
    `;
    const result = await suiteqlQuery(q);
    out.push({ metric: 'revenue_mtd', value: round2(parseFloat(result?.items?.[0]?.mtd || '0') || 0) });
  } catch (e: any) {
    out.push({ metric: 'revenue_mtd', value: null, meta: { error: String(e?.message || e).slice(0, 300) } });
  }
}

/** Compute every snapshot metric; never throws — failures land as null-valued metrics. */
export async function collectExecMetrics(service: SupabaseClient): Promise<ExecMetric[]> {
  const out: ExecMetric[] = [];
  await Promise.all([
    collectFinancials(out),
    collectSales(service, out),
    collectOrderBook(service, out),
    collectShop(service, out),
    collectRevenueMtd(out),
  ]);
  return out;
}
