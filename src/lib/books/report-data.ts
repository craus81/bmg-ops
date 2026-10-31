import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { BOOKS_GL_SYNC, COPY_FROM, monthOfDate, toCents } from './netsuite-gl';
import { BOOKS_INVOICE_POSTING, type InvoicePostingResult } from './invoice-posting';
import type { AccountDocumentsData } from './report-detail';
import {
  lastReportMonth, lineSpan, REPORT_KINDS,
  type LineSpan, type ReportAccount, type ReportAmount, type ReportData, type ReportKind,
} from './reports';
import type { TbData } from './trial-balance';

/**
 * What Reports and an account line's detail read for one company
 * (src/app/api/admin/books/reports, and its detail): the chart, NetSuite's
 * own totals (migration 361) and FleetSuite's journal summed per account and
 * month (migration 396), and how the last posting run and the last copy of
 * NetSuite's ledger went.
 */
export interface LoadedReports {
  companies: Array<{ code: string; name: string; legal_name: string | null; netsuite_subsidiary_id: string | null }>;
  company: string;
  data: ReportData;
  /** The latest month either side has, but never before this month. */
  through: string;
  /** A report's default end: last month, the newest one NetSuite may already have closed, but never before January 2025. */
  lastMonth: string;
  lastPosting: { at: string; error: string | null; partial: boolean } | null;
  lastCopy: { at: string; error: string | null } | null;
}

/** One company's books for the reports: the one asked for, else BMG, else the first. */
export async function loadReports(service: SupabaseClient, asked: string | null): Promise<LoadedReports | { error: string }> {
  const [companies, accounts, posting, copy] = await Promise.all([
    service.from('gl_companies').select('id, code, name, legal_name, netsuite_subsidiary_id').order('code'),
    fetchAllRows<Omit<ReportAccount, 'company'> & { company_id: string | null }>((from, to) => service
      .from('gl_accounts')
      .select('id, netsuite_account_id, number, name, account_type, statement, parent_id, company_id')
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_INVOICE_POSTING).maybeSingle(),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
  ]);
  const error = companies.error || accounts.error || posting.error || copy.error;
  if (error) return { error: error.message };

  const codeOf = new Map((companies.data || []).map((c) => [c.id as string, c.code as string]));
  const codes = [...codeOf.values()];
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return { error: 'No companies set up' };

  const [netsuite, fleetsuite] = await Promise.all([
    service.rpc('gl_netsuite_totals', { p_company: company }),
    service.rpc('gl_books_totals', { p_company: company }),
  ]);
  const rpcError = netsuite.error || fleetsuite.error;
  if (rpcError) return { error: rpcError.message };
  const totals = (netsuite.data ?? {}) as Partial<TbData>;
  const data: ReportData = {
    company,
    accounts: accounts.data.map(({ company_id, ...a }) => ({ ...a, company: company_id ? codeOf.get(company_id) ?? null : null })),
    opening: totals.opening ?? [],
    netsuite: totals.netsuite ?? [],
    fleetsuite: (fleetsuite.data ?? []) as ReportAmount[],
  };

  const currentMonth = monthOfDate(new Date().toISOString().slice(0, 10))!;
  const lastCalendar = new Date();
  lastCalendar.setUTCDate(1);
  lastCalendar.setUTCMonth(lastCalendar.getUTCMonth() - 1);
  const previous = monthOfDate(lastCalendar.toISOString().slice(0, 10))!;

  const run = (posting.data?.last_result ?? null) as InvoicePostingResult | null;
  const copied = (copy.data?.last_result ?? null) as { error?: string } | null;
  return {
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name, legal_name: c.legal_name, netsuite_subsidiary_id: c.netsuite_subsidiary_id })),
    company,
    data,
    through: lastReportMonth(data, currentMonth),
    lastMonth: previous >= COPY_FROM ? previous : COPY_FROM,
    lastPosting: posting.data ? { at: posting.data.updated_at, error: run?.error ?? null, partial: !!run?.partial } : null,
    lastCopy: copy.data ? { at: copy.data.updated_at, error: copied?.error ?? null } : null,
  };
}

/** A month param ('YYYY-MM') a report can cover, from January 2025 through `through`, as 'YYYY-MM-01'; else null. */
export function monthParam(value: string | null, through: string): string | null {
  const m = value && /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : null;
  return m && m >= COPY_FROM && m <= through ? m : null;
}

/**
 * The report a request asks for (report=, from=, to=): the profit and loss
 * by default; its end last month by default, the newest one NetSuite may
 * already have closed, as the trial balance does; its start the end's month
 * alone by default, or when asked for after the end.
 */
export function reportRange(params: URLSearchParams, loaded: LoadedReports): { kind: ReportKind; from: string; to: string } {
  const askedKind = params.get('report');
  const kind: ReportKind = REPORT_KINDS.find((k) => k === askedKind) ?? 'profit_and_loss';
  const to = monthParam(params.get('to'), loaded.through) ?? loaded.lastMonth;
  const askedFrom = monthParam(params.get('from'), loaded.through);
  const from = askedFrom && askedFrom <= to ? askedFrom : to;
  return { kind, from, to };
}

/** One account line's detail, as its page and its Excel download read it. */
export interface LoadedAccountDetail {
  kind: ReportKind;
  from: string;
  to: string;
  account: { key: string; number: string | null; name: string; inChart: boolean };
  span: LineSpan;
  found: AccountDocumentsData;
  /** What the copy of NetSuite's ledger holds of the account in the months, as the line shows it. */
  copied: number;
}

/**
 * What one account's line on a report is made of over the months asked for
 * (account=, report=, from=, to=): its two ends from the report itself
 * (lineSpan) and the documents between them (gl_books_account_documents,
 * migrations 400 and 459), only those that differ with `differs`, at most
 * `limit`. `account` is the line's key: the account's NetSuite id, or
 * fs:<id> for one NetSuite doesn't have.
 */
export async function loadAccountDetail(
  service: SupabaseClient,
  loaded: LoadedReports,
  params: URLSearchParams,
  opts: { differs: boolean; limit: number },
): Promise<LoadedAccountDetail | { error: string; status: number }> {
  const { data, company } = loaded;
  // A line's account is in the chart, or is a NetSuite account either side has amounts on.
  const key = params.get('account') ?? '';
  const account = data.accounts.find((a) => (a.netsuite_account_id ?? `fs:${a.id}`) === key) ?? null;
  const known = !!account
    || [...data.opening, ...data.netsuite].some((r) => r.netsuite_account_id === key)
    || data.fleetsuite.some((r) => r.account === key);
  if (!known) return { error: 'That account has nothing in these books', status: 404 };

  const { kind, from, to } = reportRange(params, loaded);
  const span = lineSpan(data, kind, key, { from, to });
  const docs = await service.rpc('gl_books_account_documents', {
    p_company: company, p_account: key, p_from: from, p_to: to, p_differs: opts.differs, p_limit: opts.limit,
  });
  if (docs.error) return { error: docs.error.message, status: 500 };
  const found = docs.data as AccountDocumentsData;
  return {
    kind,
    from,
    to,
    account: { key, number: account?.number ?? null, name: account?.name ?? `NetSuite account ${key}`, inChart: !!account },
    span,
    found,
    copied: span.sign * toCents(found.netsuite) || 0,
  };
}
