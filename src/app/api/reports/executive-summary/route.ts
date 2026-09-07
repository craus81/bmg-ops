import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFinancials } from '@/lib/api-auth';
import { loadRevenuePeriods } from '@/lib/revenue-summary';
import { loadOpenQuotes, loadPipeline, loadShopCounts, chicagoDay } from '@/lib/exec-metrics';
import { loadOrderBook } from '@/lib/order-book';
import { loadQuoteFacts, summarizeQuoteFacts } from '@/lib/sales-facts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * The CEO view's data (R4-4): one request feeds every band on the
 * Financials tab beyond the Money hero that /api/reports/financials
 * already serves. Everything is computed by the same shared libs the
 * nightly snapshots and the standalone reports use (sales-facts,
 * order-book, exec-metrics loaders) so a band number can never disagree
 * with the report behind it. Each section fails independently — a
 * NetSuite hiccup nulls the revenue block, not the page.
 *
 * Revenue is netted of credit memos (CustInvc − CustCred over non-tax
 * lines), which the this-month tile on invoiced-summary deliberately is
 * not — the two are labeled differently on the page.
 */

/** Avg received→complete days over completions in the last 30 days. */
async function loadTurnaround(): Promise<{ avgDays: number; completions: number } | null> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: completions, error } = await service
    .from('vehicle_status_history')
    .select('vehicle_id, created_at')
    .eq('to_status', 'complete')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error || !completions || completions.length === 0) return error ? null : { avgDays: 0, completions: 0 };
  const firstComplete = new Map<string, string>();
  for (const c of completions) {
    // newest-first scan: keep the EARLIEST completion per vehicle in window
    firstComplete.set(c.vehicle_id, c.created_at);
  }
  const ids = [...firstComplete.keys()];
  const { data: checkins } = await service
    .from('fleet_checkins')
    .select('id, created_at')
    .in('id', ids.slice(0, 500));
  const started = new Map((checkins || []).map(c => [c.id, c.created_at]));
  const days: number[] = [];
  for (const [vid, doneAt] of firstComplete) {
    const startAt = started.get(vid);
    if (!startAt) continue;
    const dd = (Date.parse(doneAt) - Date.parse(startAt)) / 86_400_000;
    if (dd >= 0 && dd < 365) days.push(dd);
  }
  if (days.length === 0) return { avgDays: 0, completions: 0 };
  return {
    avgDays: Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10,
    completions: days.length,
  };
}

const SPARK_METRICS = ['cash', 'ar_total', 'open_quotes_value', 'so_order_book_value', 'so_unbilled_value', 'revenue_mtd'];

export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const errMeta = (e: any) => String(e?.message || e).slice(0, 300);

  const [sales, revenue, operations, sparklines] = await Promise.all([
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const start = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
        const endNext = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        const [facts, openQuotes, pipeline, topRes] = await Promise.all([
          loadQuoteFacts(service, start, endNext),
          loadOpenQuotes(service),
          loadPipeline(service),
          service.from('customers').select('company_name, ytd_spend').eq('active', true)
            .gt('ytd_spend', 0).order('ytd_spend', { ascending: false }).limit(5),
        ]);
        const s = summarizeQuoteFacts(facts);
        return {
          window: { start, end: today },
          winRate: s.winRate,
          avgDaysToClose: s.avgDaysToClose,
          avgJobSize: s.wonCount > 0 ? Math.round(s.wonValue / s.wonCount) : null,
          wonCount: s.wonCount,
          wonValue: Math.round(s.wonValue),
          openQuotes,
          pipeline,
          topCustomers: (topRes.data || []).map(c => ({ name: c.company_name, ytd: Number(c.ytd_spend) || 0 })),
        };
      } catch (e: any) { return { error: errMeta(e) }; }
    })(),
    (async () => { try { return await loadRevenuePeriods(); } catch (e: any) { return { error: errMeta(e) }; } })(),
    (async () => {
      try {
        const [{ totals }, counts, turnaround] = await Promise.all([
          loadOrderBook(service),
          loadShopCounts(service),
          loadTurnaround(),
        ]);
        return { orderBook: totals, ...counts, turnaround };
      } catch (e: any) { return { error: errMeta(e) }; }
    })(),
    (async () => {
      try {
        const since = chicagoDay(new Date(Date.now() - 60 * 86_400_000));
        const { data, error } = await service
          .from('metric_snapshots')
          .select('metric, day, value')
          .in('metric', SPARK_METRICS)
          .gte('day', since)
          .order('day');
        if (error) throw new Error(error.message);
        const out: Record<string, { day: string; value: number | null }[]> = {};
        for (const row of data || []) {
          (out[row.metric] ||= []).push({ day: row.day, value: row.value != null ? Number(row.value) : null });
        }
        return out;
      } catch (e: any) { return { error: errMeta(e) } as any; }
    })(),
  ]);

  return NextResponse.json({ sales, revenue, operations, sparklines });
}
