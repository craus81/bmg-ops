import type { SupabaseClient } from '@supabase/supabase-js';
import { BOOKS_INVOICE_POSTING, type InvoicePostingResult } from './invoice-posting';
import { BOOKS_STOCK_SYNC, type StockCopyResult } from './netsuite-stock';
import { COPY_FROM, monthOfDate } from './netsuite-gl';
import { monthParam } from './report-data';
import { monthEndValue, type MonthEndData, type MonthEndValue } from './inventory-value';

/**
 * What Books → Inventory value and its Excel download read (part 64,
 * src/app/api/admin/books/inventory-value and its download): every
 * company's stock and inventory accounts at the end of the month asked for
 * (gl_stock_month_end, migration 495), the companies' names, and how the
 * last copy of NetSuite's stock moves and the last posting run went, since
 * the items' side and FleetSuite's books rest on them.
 */

/** Documents with no stocked item listed on each account, the month's first and then the biggest. */
export const ENTRIES_SHOWN = 100;

/** How a run that feeds the page last went. */
export interface LastRun {
  at: string;
  error: string | null;
  partial: boolean;
}

export interface LoadedInventoryValue {
  /** The month asked for, 'YYYY-MM-01'; last month by default. */
  month: string;
  /** The months it can be: January 2025 through this one. */
  first: string;
  through: string;
  value: MonthEndValue;
  names: Array<{ code: string; name: string; legal_name: string | null }>;
  /** The last copy of NetSuite's stock moves (Stock by item). */
  lastCopy: LastRun | null;
  /** The last posting run into FleetSuite's books. */
  lastPosting: LastRun | null;
}

/** The month before, 'YYYY-MM-01'. */
const monthBefore = (month: string) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
};

/**
 * The month a request asks for (month=YYYY-MM): from January 2025 through this month, last month by default, the
 * newest one that's over, but never before January 2025.
 */
export function valueMonth(params: URLSearchParams, today: string): { month: string; through: string } {
  const through = monthOfDate(today)!;
  const last = monthBefore(through);
  return { month: monthParam(params.get('month'), through) ?? (last >= COPY_FROM ? last : COPY_FROM), through };
}

export async function loadInventoryValue(
  service: SupabaseClient,
  params: URLSearchParams,
  today = new Date().toISOString().slice(0, 10),
): Promise<LoadedInventoryValue | { error: string }> {
  const { month, through } = valueMonth(params, today);
  const [read, companies, copy, posting] = await Promise.all([
    service.rpc('gl_stock_month_end', { p_month: month, p_limit: ENTRIES_SHOWN }),
    service.from('gl_companies').select('code, name, legal_name').order('code'),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_STOCK_SYNC).maybeSingle(),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_INVOICE_POSTING).maybeSingle(),
  ]);
  const error = read.error || companies.error || copy.error || posting.error;
  if (error) return { error: error.message };

  const copied = (copy.data?.last_result ?? null) as Partial<StockCopyResult> | null;
  const posted = (posting.data?.last_result ?? null) as Partial<InvoicePostingResult> | null;
  return {
    month,
    first: COPY_FROM,
    through,
    value: monthEndValue(read.data as MonthEndData),
    names: (companies.data ?? []) as LoadedInventoryValue['names'],
    lastCopy: copy.data ? { at: copy.data.updated_at, error: copied?.error ?? null, partial: !!copied?.partial } : null,
    lastPosting: posting.data ? { at: posting.data.updated_at, error: posted?.error ?? null, partial: !!posted?.partial } : null,
  };
}
