import type { SupabaseClient } from '@supabase/supabase-js';
import type { RestletPnlRow } from '@/lib/netsuite';
import { parseReportLines } from '@/lib/quickbooks/reports';
import { fetchAllRows } from '@/lib/fetch-all';
import { readLedgerSettings } from '@/lib/ledger/pdf-gate';
import type { HistorySource } from '@/lib/financial-history';

/**
 * One year of Financial History taken apart, so a total that looks wrong can
 * be traced (owner, 2026-10-01: 2024 read $8.7M between two ~$3M years).
 *
 * Everything here is read from what is already stored, never fetched live:
 *   - each system's monthly P&L revenue side by side, whichever one the
 *     report uses for that month, so a year booked in BOTH shows up;
 *   - invoices dated in each month, per system, as a second opinion on
 *     revenue (totals include sales tax: NetSuite's mirror has no tax split);
 *   - QuickBooks' own yearly P&L beside the sum of its months;
 *   - revenue, cost and expense by account, for the system(s) the year uses.
 */

export const SECTION_ORDER = ['Income', 'Cost of Goods Sold', 'Expenses', 'Other Income', 'Other Expenses'] as const;
export type SectionName = (typeof SECTION_ORDER)[number];

/** NetSuite account types → the QuickBooks P&L section names, so both read alike. */
const NS_SECTION: Record<string, SectionName> = {
  Income: 'Income',
  COGS: 'Cost of Goods Sold',
  Expense: 'Expenses',
  OthIncome: 'Other Income',
  OthExpense: 'Other Expenses',
};

export interface AccountLine { label: string; amount: number }
export interface AccountSection { section: SectionName; total: number; lines: AccountLine[] }

export interface DetailMonth {
  /** YYYY-MM */
  month: string;
  /** Which system the report uses for this month. */
  used: HistorySource;
  /** Revenue on each system's monthly P&L; null when none is stored. */
  quickbooksPnl: number | null;
  netsuitePnl: number | null;
  /** Invoices + sales receipts − credits dated this month, tax included. */
  quickbooksInvoiced: number;
  netsuiteInvoiced: number;
}

export interface YearDetail {
  year: number;
  cutover: string | null;
  months: DetailMonth[];
  /** QuickBooks' own P&L for the whole year (null when not imported). */
  quickbooksYear: { income: number | null; cogs: number | null; expenses: number | null; netIncome: number | null } | null;
  /** Sum of QuickBooks' monthly P&L revenue for the year, to compare with the above. */
  quickbooksMonthsIncome: number | null;
  accounts: { source: HistorySource; sections: AccountSection[] }[];
  /** NetSuite months the report has not cached yet (current month, or never loaded). */
  netsuiteMonthsMissing: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');

function toSections(map: Map<SectionName, Map<string, number>>): AccountSection[] {
  return SECTION_ORDER.filter(s => map.has(s)).map(section => {
    const lines = [...map.get(section)!.entries()]
      .map(([label, amount]) => ({ label, amount: round2(amount) }))
      .filter(l => l.amount !== 0)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    return { section, total: round2(lines.reduce((s, l) => s + l.amount, 0)), lines };
  }).filter(s => s.lines.length > 0);
}

function add(map: Map<SectionName, Map<string, number>>, section: SectionName, label: string, amount: number) {
  if (!map.has(section)) map.set(section, new Map());
  const inner = map.get(section)!;
  inner.set(label, (inner.get(label) || 0) + amount);
}

/**
 * NetSuite accounts summed over the months given. Each month's bucket is
 * oriented the way summarizePnl orients it (one flip per account type, from
 * that bucket's total), so these lines add up to the report's own totals.
 */
export function netsuiteAccountSections(months: RestletPnlRow[][]): AccountSection[] {
  const map = new Map<SectionName, Map<string, number>>();
  for (const rows of months) {
    const flip = new Map<string, number>();
    for (const type of Object.keys(NS_SECTION)) {
      const total = rows.filter(r => r.accountType === type).reduce((s, r) => s + r.amount, 0);
      flip.set(type, total < 0 ? -1 : 1);
    }
    for (const r of rows) {
      const section = NS_SECTION[r.accountType];
      if (!section) continue;
      add(map, section, r.accountName || `Account ${r.accountId}`, r.amount * (flip.get(r.accountType) || 1));
    }
  }
  return toSections(map);
}

/**
 * QuickBooks accounts from one stored P&L report. Only data rows count:
 * a parent account's own postings are a data row inside its section, and
 * its "Total …" row would count the children twice.
 */
export function quickbooksAccountSections(json: unknown): AccountSection[] {
  const map = new Map<SectionName, Map<string, number>>();
  for (const l of parseReportLines(json)) {
    if (l.row_type !== 'data' || l.column_key !== 'total' || l.amount === null) continue;
    const path = l.section_path ? l.section_path.split('/') : [];
    const section = SECTION_ORDER.find(s => s.toLowerCase() === (path[0] || '').toLowerCase());
    if (!section) continue;
    const label = [...path.slice(1), l.label].filter(Boolean).join(' › ');
    add(map, section, label || l.label, l.amount);
  }
  return toSections(map);
}

export type InvoiceRow = { source: string; doc_type: string; doc_date: string; total: number | string | null };

/** Net invoiced per month and source: invoices and sales receipts in, credits and refunds out. */
export function invoicedByMonth(rows: InvoiceRow[]): Map<string, { quickbooks: number; netsuite: number }> {
  const out = new Map<string, { quickbooks: number; netsuite: number }>();
  for (const r of rows) {
    if (r.source !== 'quickbooks' && r.source !== 'netsuite') continue;
    const sign = r.doc_type === 'invoice' || r.doc_type === 'sales_receipt' ? 1
      : r.doc_type === 'credit_memo' || r.doc_type === 'refund_receipt' ? -1 : 0;
    if (!sign) continue;
    const amount = Math.abs(Number(r.total) || 0) * sign;
    const month = String(r.doc_date).slice(0, 7);
    const cur = out.get(month) || { quickbooks: 0, netsuite: 0 };
    cur[r.source] = round2(cur[r.source] + amount);
    out.set(month, cur);
  }
  return out;
}

const qboIncome = (summary: Record<string, unknown> | null | undefined): number | null => {
  const v = summary?.['Total Income'];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type SnapRow = { period_start: string; summary: Record<string, unknown> | null; payload: any };

async function readYearSnapshots(service: SupabaseClient, source: HistorySource, kind: 'month' | 'year', year: number) {
  const { data, error } = await service.from('ledger_report_snapshots')
    .select('period_start, summary, payload')
    .eq('source', source)
    .eq('report_type', 'ProfitAndLoss')
    .eq('basis', 'accrual')
    .eq('period_kind', kind)
    .eq('status', 'stored')
    .gte('period_start', `${year}-01-01`)
    .lte('period_start', `${year}-12-31`)
    .order('period_start')
    .order('id');
  if (error) throw new Error(`Could not read ${source} P&L snapshots: ${error.message}`);
  return (data || []) as SnapRow[];
}

export async function loadYearDetail(service: SupabaseClient, year: number): Promise<YearDetail> {
  const settings = await readLedgerSettings(service);
  const cutover = settings.cutover?.date || null;
  const cutoverMonth = cutover ? cutover.slice(0, 7) : null;

  const [qboMonths, qboYears, nsMonths, invoices] = await Promise.all([
    readYearSnapshots(service, 'quickbooks', 'month', year),
    readYearSnapshots(service, 'quickbooks', 'year', year),
    readYearSnapshots(service, 'netsuite', 'month', year),
    fetchAllRows<InvoiceRow>((lo, hi) => service.from('ledger_invoices')
      .select('source, doc_type, doc_date, total')
      .in('doc_type', ['invoice', 'credit_memo', 'sales_receipt', 'refund_receipt'])
      .eq('voided', false)
      .is('deleted_at', null)
      .gte('doc_date', `${year}-01-01`)
      .lte('doc_date', `${year}-12-31`)
      .order('doc_date')
      .order('id')
      .range(lo, hi)),
  ]);
  if (invoices.error) throw new Error(`Could not read invoices: ${invoices.error.message}`);

  const qboByMonth = new Map(qboMonths.map(r => [r.period_start.slice(0, 7), r]));
  const nsByMonth = new Map(nsMonths.map(r => [r.period_start.slice(0, 7), r]));
  const invoiced = invoicedByMonth(invoices.data);

  const months: DetailMonth[] = [];
  const netsuiteMonthsMissing: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${pad(m)}`;
    const used: HistorySource = cutoverMonth && month < cutoverMonth ? 'quickbooks' : 'netsuite';
    const ns = nsByMonth.get(month);
    const nsIncome = ns?.summary && typeof ns.summary.income === 'number' ? ns.summary.income : null;
    if (used === 'netsuite' && nsIncome === null) netsuiteMonthsMissing.push(month);
    months.push({
      month,
      used,
      quickbooksPnl: qboIncome(qboByMonth.get(month)?.summary),
      netsuitePnl: nsIncome,
      quickbooksInvoiced: invoiced.get(month)?.quickbooks || 0,
      netsuiteInvoiced: invoiced.get(month)?.netsuite || 0,
    });
  }

  const qboYear = qboYears.find(r => r.period_start === `${year}-01-01`) || null;
  const num = (k: string) => {
    const v = qboYear?.summary?.[k];
    return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  const qboMonthIncomes = months.map(m => m.quickbooksPnl).filter((n): n is number => n !== null);

  const usedSources = new Set(months.map(m => m.used));
  const accounts: YearDetail['accounts'] = [];
  if (usedSources.has('quickbooks') && qboYear?.payload) {
    accounts.push({ source: 'quickbooks', sections: quickbooksAccountSections(qboYear.payload) });
  }
  if (usedSources.has('netsuite')) {
    const rows = months
      .filter(m => m.used === 'netsuite')
      .map(m => nsByMonth.get(m.month)?.payload?.rows)
      .filter((r): r is RestletPnlRow[] => Array.isArray(r));
    if (rows.length > 0) accounts.push({ source: 'netsuite', sections: netsuiteAccountSections(rows) });
  }

  return {
    year,
    cutover,
    months,
    quickbooksYear: qboYear
      ? { income: num('Total Income'), cogs: num('Total Cost of Goods Sold'), expenses: num('Total Expenses'), netIncome: num('Net Income') }
      : null,
    quickbooksMonthsIncome: qboMonthIncomes.length ? round2(qboMonthIncomes.reduce((s, n) => s + n, 0)) : null,
    accounts,
    netsuiteMonthsMissing,
  };
}
