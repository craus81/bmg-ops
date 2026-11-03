import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { centralLastMonth, centralMonth } from '@/lib/central-day';
import { BOOKS_GL_SYNC, COPY_FROM, toCents } from './netsuite-gl';
import { BOOKS_INVOICE_POSTING, type InvoicePostingResult } from './invoice-posting';
import type { BuilderAsk, Parties, PartyAmount, SplitAmount } from './report-builder';
import { BUILDER_BY, BUILDER_MONTHS, BUILDER_ROWS, type BuilderBy, type BuilderMonths, type BuilderRows } from './report-builder-words';
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

  const currentMonth = centralMonth();
  const previous = centralLastMonth();

  const copied = (copy.data?.last_result ?? null) as { error?: string } | null;
  return {
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name, legal_name: c.legal_name, netsuite_subsidiary_id: c.netsuite_subsidiary_id })),
    company,
    data,
    through: lastReportMonth(data, currentMonth),
    lastMonth: previous >= COPY_FROM ? previous : COPY_FROM,
    lastPosting: postingOf(posting.data),
    lastCopy: copy.data ? { at: copy.data.updated_at, error: copied?.error ?? null } : null,
  };
}

/** How the last posting run went, from its sync_state row; null before it has run. */
export function postingOf(row: { last_result: unknown; updated_at: string } | null): LoadedReports['lastPosting'] {
  if (!row) return null;
  const run = (row.last_result ?? null) as InvoicePostingResult | null;
  return { at: row.updated_at, error: run?.error ?? null, partial: !!run?.partial };
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

/**
 * What the report builder reads for one company: what Reports does, the
 * report asked for, FleetSuite's journal split by division and location,
 * and by customer or vendor too when the report has a line for each.
 */
export interface LoadedBuilder extends LoadedReports {
  ask: BuilderAsk;
  /** gl_books_split_totals (migration 500). */
  split: SplitAmount[];
  /** NetSuite's location names by id, from the copy of its lists (migration 363). */
  locationNames: Map<string, string>;
  /** gl_books_party_totals (migration 501) for the months asked for, with NetSuite's names; null for lines by account. */
  parties: Parties | null;
}

/**
 * FleetSuite's journal for one company split by division and location
 * (gl_books_split_totals, migration 500), with NetSuite's location names
 * by id from the copy of its lists (migration 363): what the report builder
 * lays its lines out from.
 */
export async function loadSplit(
  service: SupabaseClient, company: string,
): Promise<Pick<LoadedBuilder, 'split' | 'locationNames'> | { error: string }> {
  const [split, locations] = await Promise.all([
    service.rpc('gl_books_split_totals', { p_company: company }),
    service.from('gl_netsuite_lists').select('netsuite_id, name').eq('kind', 'location'),
  ]);
  const error = split.error || locations.error;
  if (error) return { error: error.message };
  return {
    split: (split.data ?? []) as SplitAmount[],
    locationNames: new Map((locations.data ?? []).map((l) => [String(l.netsuite_id), String(l.name)])),
  };
}

/**
 * One company's books for the report builder (src/app/api/admin/books/reports/builder):
 * the one asked for (company=), else BMG, else the first, and the report
 * the request asks for (builderAsk).
 */
export async function loadBuilder(service: SupabaseClient, params: URLSearchParams): Promise<LoadedBuilder | { error: string }> {
  const loaded = await loadReports(service, params.get('company'));
  if ('error' in loaded) return loaded;
  const ask = builderAsk(params, loaded);
  const [split, parties] = await Promise.all([
    loadSplit(service, loaded.company),
    ask.rows === 'account' ? null
      : service.rpc('gl_books_party_totals', { p_company: loaded.company, p_kind: ask.rows, p_from: ask.from, p_to: ask.to }),
  ]);
  if ('error' in split) return split;
  if (parties?.error) return { error: parties.error.message };
  const named = (parties?.data ?? null) as { rows?: PartyAmount[]; names?: Record<string, string> } | null;
  return {
    ...loaded,
    ask,
    ...split,
    parties: parties ? { rows: named?.rows ?? [], names: new Map(Object.entries(named?.names ?? {})) } : null,
  };
}

/**
 * The months that move with the calendar, as of last month (`lastMonth`, a
 * report's default end): the year to date, last month, the last quarter or
 * year that has ended, or the 12 months through last month, from January
 * 2025 at the earliest. Null for months picked by hand.
 */
export function monthsFor(months: BuilderMonths, lastMonth: string): { from: string; to: string } | null {
  const year = Number(lastMonth.slice(0, 4));
  const m = Number(lastMonth.slice(5, 7));
  // The first of the month `month` (1 for January) of `year`, a month before January being one of the year before.
  const first = (month: number) => new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const range = (() => {
    switch (months) {
      case 'picked': return null;
      case 'year_to_date': return { from: first(1), to: lastMonth };
      case 'last_month': return { from: lastMonth, to: lastMonth };
      case 'last_quarter': return { from: first(m - (m % 3) - 2), to: first(m - (m % 3)) };
      case 'last_year': return m === 12 ? { from: first(1), to: lastMonth } : { from: first(-11), to: first(0) };
      case 'last_12_months': return { from: first(m - 11), to: lastMonth };
    }
  })();
  if (!range) return null;
  if (range.to < COPY_FROM) return { from: COPY_FROM, to: COPY_FROM };
  return { from: range.from < COPY_FROM ? COPY_FROM : range.from, to: range.to };
}

/**
 * The report a request asks the builder for (rows=, by=, months=, from=,
 * to=, division=, location=): a line for each account and a column for each
 * division by default; months that move with the calendar when asked for
 * (months=last_quarter, say), else those picked: the end last month by
 * default, as on Reports, the start January of the end's year by default,
 * or when asked for after the end. With no months asked for or picked, the
 * year to date.
 */
export function builderAsk(params: URLSearchParams, loaded: LoadedReports): BuilderAsk {
  const askedTo = monthParam(params.get('to'), loaded.through);
  const askedFrom = monthParam(params.get('from'), loaded.through);
  const askedMonths = params.get('months');
  const months = BUILDER_MONTHS.find((m) => m === askedMonths) ?? (askedTo || askedFrom ? 'picked' : 'year_to_date');
  const to = askedTo ?? loaded.lastMonth;
  const by = params.get('by');
  const rows = params.get('rows');
  return {
    rows: BUILDER_ROWS.find((r) => r === rows) ?? 'account',
    months,
    ...(monthsFor(months, loaded.lastMonth) ?? { from: askedFrom && askedFrom <= to ? askedFrom : `${to.slice(0, 4)}-01-01`, to }),
    by: BUILDER_BY.find((b) => b === by) ?? 'division',
    division: params.get('division') || null,
    location: params.get('location') || null,
  };
}

/** A report saved by name, as the builder lists it. */
export interface SavedReport {
  id: string;
  name: string;
  rows: BuilderRows;
  by: BuilderBy;
  division: string | null;
  location: string | null;
  months: BuilderMonths;
  /** 'YYYY-MM-01', for months picked by hand; null for months that move with the calendar. */
  from: string | null;
  to: string | null;
  /** Who saved it, by name. */
  savedBy: string | null;
  /** When it was last saved, as the books have it: what a change or a delete sends back as `seen`. */
  updatedAt: string;
  /** Whether this login can change or delete it: its saver's, or a super admin's. */
  canChange: boolean;
}

const nameOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** One company's reports saved by name (books_saved_reports, migration 501), by name; `me` changes the ones it saved, or all of them as `owner`. */
export async function loadSavedReports(
  service: SupabaseClient, company: string, me: string, owner: boolean,
): Promise<SavedReport[] | { error: string }> {
  const { data, error } = await service.from('books_saved_reports')
    .select('id, name, rows, columns, division, location, months, from_month, to_month, saved_by, saved_by_name, updated_at')
    .eq('company', company)
    .order('id', { ascending: true });
  if (error) return { error: error.message };
  return (data ?? [])
    .map((r) => ({
      id: r.id as string,
      name: r.name as string,
      rows: r.rows as BuilderRows,
      by: r.columns as BuilderBy,
      division: (r.division as string | null) ?? null,
      location: (r.location as string | null) ?? null,
      months: r.months as BuilderMonths,
      from: (r.from_month as string | null) ?? null,
      to: (r.to_month as string | null) ?? null,
      savedBy: (r.saved_by_name as string | null) ?? null,
      updatedAt: r.updated_at as string,
      canChange: owner || r.saved_by === me,
    }))
    .sort((x, y) => nameOrder.compare(x.name, y.name));
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
 * migrations 400 and 460), only those that differ with `differs`, at most
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
