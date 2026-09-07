import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { fetchOpenArInvoices, computeArAging, fetchAccountGroups, fetchOpenVendorBills } from './financials-data';
import { loadOrderBook } from './order-book';

export { unbilledLineValue } from './order-book';

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

/** Open quotes = wrap quotes (draft/sent, unarchived) + estimates
 *  (draft/pushed/sent) — the OpsDashboard/quote-list semantics. */
export async function loadOpenQuotes(service: SupabaseClient): Promise<{ count: number; value: number }> {
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
  return { count, value: round2(value) };
}

/** Pipeline = open deal stages only (lead/quoted/negotiating), matching the
 *  dashboard's pipeline band. */
export async function loadPipeline(service: SupabaseClient): Promise<{ stage: string; count: number; value: number }[]> {
  const { data, error } = await fetchAllRows<any>((from, to) => service
    .from('prospect_opportunities').select('stage, value')
    .in('stage', ['lead', 'quoted', 'negotiating'])
    .order('id').range(from, to));
  if (error) throw new Error(error.message);
  return ['lead', 'quoted', 'negotiating'].map(stage => {
    const inStage = (data || []).filter(o => o.stage === stage);
    return { stage, count: inStage.length, value: round2(inStage.reduce((s, o) => s + (Number(o.value) || 0), 0)) };
  });
}

/** Vehicles actively in the shop, and complete-but-not-shipped, both unarchived. */
export async function loadShopCounts(service: SupabaseClient): Promise<{ inShop: number; completeNotShipped: number }> {
  const [{ count: inShop, error: e1 }, { count: doneNotShipped, error: e2 }] = await Promise.all([
    service.from('fleet_checkins').select('id', { count: 'exact', head: true })
      .in('status', ['received', 'checked_in', 'in_progress', 'stuck_parts', 'stuck_graphics'])
      .is('archived_at', null),
    service.from('fleet_checkins').select('id', { count: 'exact', head: true })
      .eq('status', 'complete')
      .is('archived_at', null),
  ]);
  if (e1 || e2) throw new Error((e1 || e2)!.message);
  return { inShop: inShop || 0, completeNotShipped: doneNotShipped || 0 };
}

async function collectSales(service: SupabaseClient, out: ExecMetric[]): Promise<void> {
  try {
    const quotes = await loadOpenQuotes(service);
    out.push({ metric: 'open_quotes_count', value: quotes.count });
    out.push({ metric: 'open_quotes_value', value: quotes.value });
  } catch (e: any) {
    const meta = { error: String(e?.message || e).slice(0, 300) };
    out.push({ metric: 'open_quotes_count', value: null, meta });
    out.push({ metric: 'open_quotes_value', value: null, meta });
  }

  try {
    const stages = await loadPipeline(service);
    out.push({ metric: 'pipeline_deals', value: stages.reduce((s, x) => s + x.count, 0) });
    out.push({ metric: 'pipeline_value', value: round2(stages.reduce((s, x) => s + x.value, 0)) });
  } catch (e: any) {
    const meta = { error: String(e?.message || e).slice(0, 300) };
    out.push({ metric: 'pipeline_deals', value: null, meta });
    out.push({ metric: 'pipeline_value', value: null, meta });
  }
}

async function collectOrderBook(service: SupabaseClient, out: ExecMetric[]): Promise<void> {
  try {
    // Same loader as the Order Book report and the CEO Operations band —
    // the snapshot can never disagree with the report behind it.
    const { totals } = await loadOrderBook(service);
    out.push({ metric: 'so_order_book_count', value: totals.count });
    out.push({ metric: 'so_order_book_value', value: totals.value });
    out.push({ metric: 'so_unbilled_value', value: totals.unbilled });
  } catch (e: any) {
    const meta = { error: String(e?.message || e).slice(0, 300) };
    for (const m of ['so_order_book_count', 'so_order_book_value', 'so_unbilled_value']) {
      out.push({ metric: m, value: null, meta });
    }
  }
}

async function collectShop(service: SupabaseClient, out: ExecMetric[]): Promise<void> {
  try {
    const counts = await loadShopCounts(service);
    out.push({ metric: 'vehicles_in_shop', value: counts.inShop });
    out.push({ metric: 'vehicles_complete_not_shipped', value: counts.completeNotShipped });
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
