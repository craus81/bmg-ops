import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * Closing-this-month forecast (R5-8): reps enter expected_close_date on
 * every deal and until now the date did nothing — forecast dollars silently
 * rolled forward month after month. This lib is the one place deals are
 * bucketed by close date, shared by the dashboard's forecast strip and the
 * weekly slippage cron so the strip and the nudges can never disagree.
 *
 * Buckets are calendar months in the shop's frame (callers pass the
 * Chicago day): a deal expected to close TODAY is still this_month, not
 * overdue — it has until midnight.
 */

export const OPEN_DEAL_STAGES = ['lead', 'quoted', 'negotiating'];

export interface ForecastDeal {
  id: string;
  prospectId: string;
  title: string;
  stage: string;
  value: number;
  expectedClose: string | null; // YYYY-MM-DD
  customer: string;
  createdBy: string | null;
}

export type CloseBucket = 'overdue' | 'this_month' | 'next_month' | 'later' | 'undated';

export function classifyCloseBucket(expectedClose: string | null, today: string): CloseBucket {
  if (!expectedClose) return 'undated';
  if (expectedClose < today) return 'overdue';
  const month = expectedClose.slice(0, 7);
  const thisMonth = today.slice(0, 7);
  if (month === thisMonth) return 'this_month';
  const [y, m] = thisMonth.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return month === next ? 'next_month' : 'later';
}

export interface ForecastColumn {
  count: number;
  value: number;
  /** Soonest close first (overdue: longest-overdue first); undated by value. */
  deals: ForecastDeal[];
}

export interface DealForecast {
  overdue: ForecastColumn;
  thisMonth: ForecastColumn;
  nextMonth: ForecastColumn;
  later: ForecastColumn;
  undated: ForecastColumn;
}

const emptyColumn = (): ForecastColumn => ({ count: 0, value: 0, deals: [] });

export function summarizeDealForecast(deals: ForecastDeal[], today: string): DealForecast {
  const out: DealForecast = {
    overdue: emptyColumn(), thisMonth: emptyColumn(), nextMonth: emptyColumn(),
    later: emptyColumn(), undated: emptyColumn(),
  };
  const keyOf: Record<CloseBucket, keyof DealForecast> = {
    overdue: 'overdue', this_month: 'thisMonth', next_month: 'nextMonth',
    later: 'later', undated: 'undated',
  };
  for (const deal of deals) {
    const col = out[keyOf[classifyCloseBucket(deal.expectedClose, today)]];
    col.count++;
    col.value += deal.value || 0;
    col.deals.push(deal);
  }
  for (const col of [out.overdue, out.thisMonth, out.nextMonth, out.later]) {
    col.deals.sort((a, b) => (a.expectedClose || '').localeCompare(b.expectedClose || '') || b.value - a.value);
  }
  out.undated.deals.sort((a, b) => b.value - a.value);
  return out;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); positive when `to` is later. */
export function daysPast(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Every open deal with its prospect name — the server-side twin of the
 *  dashboard's client read (same table, same stage filter). */
export async function loadOpenDeals(service: SupabaseClient): Promise<ForecastDeal[]> {
  const { data, error } = await fetchAllRows<any>((from, to) => service
    .from('prospect_opportunities')
    .select('id, prospect_id, title, stage, value, expected_close_date, created_by, prospects(company_name)')
    .in('stage', OPEN_DEAL_STAGES)
    .order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  return (data || []).map((o: any) => ({
    id: o.id,
    prospectId: o.prospect_id,
    title: o.title || 'Untitled deal',
    stage: o.stage,
    value: Number(o.value) || 0,
    expectedClose: o.expected_close_date,
    customer: o.prospects?.company_name || '—',
    createdBy: o.created_by,
  }));
}
