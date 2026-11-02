import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { monthText } from './differences';
import { differs, type MonthCompared, type PeriodRow, type Refusal } from './months';
import { monthOfDate, monthsBetween } from './netsuite-gl';
import { lastDay } from './opening-balances';
import type { YearCloseAmounts } from './reports';

/**
 * Year end (docs/books.md "Year end"). Books → Year end shows a company's
 * year closing into retained earnings, FleetSuite's books next to
 * NetSuite's (reports.ts's yearCloseAmounts), with what's done before it
 * closes, and closes it once every month of it is closed on Books → Months.
 * Nothing is posted: the year's net income goes into retained earnings at
 * the next one's start, as the reports already have it. Closing holds it:
 * none of a closed year's months reopens until the year does (migration
 * 502). Years close in order from the one the books went live in, and only
 * the latest one closed reopens, for a reason. A year before the books went
 * live closes in NetSuite, so it shows as a rehearsal with nothing to
 * close.
 */

/** FleetSuite's books start in January 2025. */
export const FIRST_YEAR = 2025;

export const REASON_MAX = 500;

export type CheckState = 'done' | 'todo' | 'none';

export type CheckKey = 'months' | 'netsuite' | 'entries' | 'bank' | 'sales_tax';

/** One thing done before a year closes: done, not yet, or not one for this company or year ('none'). */
export interface YearCheck {
  key: CheckKey;
  state: CheckState;
  detail: string;
  /** The months it names, 'YYYY-MM-01', oldest first: the next to close, those that differ from NetSuite, those missing a return. */
  months?: string[];
}

/** A close or a reopen, as gl_year_close_events keeps it. */
export interface YearEvent {
  action: 'closed' | 'reopened';
  by: string | null;
  reason: string | null;
  at: string;
  /** On a close, FleetSuite's net income and retained earnings after the close, whole cents. */
  netIncome: number | null;
  retainedEarnings: number | null;
}

/** One of a company's years as gl_year_closes has it: a year has a row once it's first closed. */
export interface YearRow {
  year: number;
  closed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  netIncome: number | null;
  retainedEarnings: number | null;
  events: YearEvent[];
}

/** A journal entry typed in FleetSuite, dated in the year, that isn't made yet. */
export interface WaitingEntry {
  journal: 'general' | 'cpa_adjustments';
  status: 'draft' | 'waiting' | 'sending';
}

/** A bank account reconciled on Books → 1084's bank reconciliation: where it starts, and the year's months done. */
export interface BankYear {
  account: string;
  name: string;
  firstMonth: string;
  done: string[];
}

/** What a year's checks are worked out from. */
export interface YearFacts {
  name: string;
  liveFrom: string | null;
  year: number;
  /** Today in Central time. */
  today: string;
  periods: PeriodRow[];
  compared: ReadonlyMap<string, MonthCompared>;
  entries: WaitingEntry[];
  banks: BankYear[];
  /** The year's months with Missouri's return typed in; null for a company that makes no sales. */
  returns: string[] | null;
  years: YearRow[];
}

export interface YearView {
  /** The year's months are kept in FleetSuite's books, not NetSuite's: the books went live by its end. */
  own: boolean;
  /** Its last day is behind us, in Central time. */
  over: boolean;
  checks: YearCheck[];
  closed: { at: string | null; by: string | null; netIncome: number | null; retainedEarnings: number | null } | null;
  /** On a closed year, FleetSuite's books no longer have what it closed at: an account's type changed since. */
  changedSince: boolean;
  events: YearEvent[];
  /** What can be done with it now. */
  can: 'close' | 'reopen' | null;
}

const yearOf = (iso: string) => Number(iso.slice(0, 4));
const months = (n: number) => `${n} month${n === 1 ? '' : 's'}`;
const entries = (n: number) => `${n} journal entr${n === 1 ? 'y' : 'ies'}`;
const list = (items: string[]) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const monthNames = (ms: string[]) => list(ms.map((m) => monthText(m).split(' ')[0]));

/** The year the books went live in, or null before they do. */
export const liveYear = (liveFrom: string | null) => (liveFrom ? yearOf(liveFrom) : null);

/** The months of a year FleetSuite's books close: from January, or the month they went live, through December. */
export function ownMonths(year: number, liveFrom: string | null): string[] {
  const live = liveYear(liveFrom);
  if (live === null || year < live) return [];
  const first = year === live ? monthOfDate(liveFrom)! : `${year}-01-01`;
  return monthsBetween(first, `${year}-12-01`);
}

/** The years a company's year end lists, from 2025 through this one. */
export const yearsShown = (today: string) =>
  Array.from({ length: Math.max(1, yearOf(today) - FIRST_YEAR + 1) }, (_, i) => FIRST_YEAR + i);

/** The year the page opens on: last year, the latest that's over, but never before 2025. */
export const defaultYear = (today: string) => Math.max(FIRST_YEAR, yearOf(today) - 1);

/** Each closed year. */
export const closedYears = (years: readonly YearRow[]): Set<number> => new Set(years.filter((y) => y.closed).map((y) => y.year));

function monthsCheck(f: YearFacts): YearCheck {
  const live = liveYear(f.liveFrom);
  if (live === null) {
    return { key: 'months', state: 'none', detail: `${f.name}'s books aren't live yet, so ${f.year}'s months close in NetSuite.` };
  }
  if (f.year < live) {
    return { key: 'months', state: 'none', detail: `${f.year} is before ${f.name}'s books went live, so its months close in NetSuite.` };
  }
  const own = ownMonths(f.year, f.liveFrom);
  const closed = new Set(f.periods.filter((p) => p.closed).map((p) => p.month));
  const open = own.filter((m) => !closed.has(m));
  if (!open.length) return { key: 'months', state: 'done', detail: `All ${months(own.length)} are closed.` };
  const next = open[0];
  const over = lastDay(next) < f.today;
  return {
    key: 'months',
    state: 'todo',
    detail: `${own.length - open.length} of ${months(own.length)} closed. ${monthText(next)} is next${over ? '' : ", once it's over"}.`,
    months: [next],
  };
}

function netsuiteCheck(f: YearFacts): YearCheck {
  const all = monthsBetween(`${f.year}-01-01`, `${f.year}-12-01`);
  const off = all.filter((m) => { const c = f.compared.get(m); return !!c && differs(c); });
  if (off.length) {
    return { key: 'netsuite', state: 'todo', detail: `${months(off.length)} ${off.length === 1 ? "doesn't" : "don't"} match NetSuite: ${monthNames(off)}.`, months: off };
  }
  if (all.every((m) => (f.compared.get(m)?.status ?? 'none') === 'none')) {
    return { key: 'netsuite', state: 'none', detail: `Nothing's posted in ${f.year} yet.` };
  }
  return { key: 'netsuite', state: 'done', detail: 'Every month matches NetSuite.' };
}

function entriesCheck(f: YearFacts): YearCheck {
  if (!f.entries.length) return { key: 'entries', state: 'done', detail: `None dated in ${f.year} is waiting.` };
  const count = (status: WaitingEntry['status']) => f.entries.filter((e) => e.status === status).length;
  const drafts = count('draft');
  const waiting = count('waiting');
  const sending = count('sending');
  const parts = [
    drafts ? `${drafts} still ${drafts === 1 ? 'a draft' : 'drafts'}` : '',
    waiting ? `${waiting} waiting for approval` : '',
    sending ? `${sending} being made in NetSuite` : '',
  ].filter(Boolean);
  const cpa = f.entries.filter((e) => e.journal === 'cpa_adjustments').length;
  const total = f.entries.length;
  const whose = !cpa ? '' : cpa < total ? `, ${cpa} of them the CPA's` : total === 1 ? ", the CPA's" : ", all the CPA's";
  return {
    key: 'entries',
    state: 'todo',
    detail: `${entries(total)} dated in ${f.year} ${total === 1 ? "isn't" : "aren't"} made yet: ${list(parts)}${whose}.`,
  };
}

function bankCheck(f: YearFacts): YearCheck {
  if (!f.banks.length) {
    return { key: 'bank', state: 'none', detail: `${f.name}'s bank accounts aren't reconciled in FleetSuite yet.` };
  }
  const december = `${f.year}-12-01`;
  const counted = f.banks.filter((b) => b.firstMonth <= december);
  if (!counted.length) {
    const first = f.banks.map((b) => b.firstMonth).sort()[0];
    return { key: 'bank', state: 'none', detail: `Reconciling starts with ${monthText(first)}.` };
  }
  const behind = counted.map((b) => {
    const due = monthsBetween(b.firstMonth > `${f.year}-01-01` ? b.firstMonth : `${f.year}-01-01`, december);
    const done = new Set(b.done);
    return { name: b.name, due: due.length, done: due.filter((m) => done.has(m)).length };
  }).filter((b) => b.done < b.due);
  if (!behind.length) {
    return { key: 'bank', state: 'done', detail: `${counted.length === 1 ? 'The bank account is' : 'Every bank account is'} reconciled through December.` };
  }
  return { key: 'bank', state: 'todo', detail: behind.map((b) => `${b.name}: ${b.done} of ${months(b.due)} reconciled.`).join(' ') };
}

function salesTaxCheck(f: YearFacts): YearCheck {
  if (!f.returns) return { key: 'sales_tax', state: 'none', detail: `${f.name} makes no sales, so it files no sales tax return.` };
  const due = monthsBetween(`${f.year}-01-01`, `${f.year}-12-01`).filter((m) => lastDay(m) < f.today);
  if (!due.length) return { key: 'sales_tax', state: 'none', detail: `No month of ${f.year} is over yet.` };
  const typed = new Set(f.returns);
  const missing = due.filter((m) => !typed.has(m));
  if (!missing.length) {
    return { key: 'sales_tax', state: 'done', detail: due.length === 12 ? "Every month's return is typed in." : `The returns for all ${months(due.length)} so far are typed in.` };
  }
  return {
    key: 'sales_tax',
    state: 'todo',
    detail: `${due.length - missing.length} of ${months(due.length)} typed in. Not yet: ${monthNames(missing)}.`,
    months: missing,
  };
}

/** What's done before the year closes, in the order the page lists them. */
export function yearChecks(f: YearFacts): YearCheck[] {
  return [monthsCheck(f), netsuiteCheck(f), entriesCheck(f), bankCheck(f), salesTaxCheck(f)];
}

/** Why the year can't be closed now, or null when it can; a year with anything not done needs a reason. */
export function closeYearRefusal(f: YearFacts, reason: string): Refusal | null {
  const live = liveYear(f.liveFrom);
  if (live === null) return { message: `${f.name}'s books aren't live yet, so there's no year to close.`, status: 409 };
  if (f.year < live) return { message: `${f.year} is before ${f.name}'s books went live, so it closes in NetSuite.`, status: 400 };
  const closed = closedYears(f.years);
  if (closed.has(f.year)) return { message: `${f.year} is already closed.`, status: 409 };
  for (let y = live; y < f.year; y++) {
    if (!closed.has(y)) return { message: `Close ${y} first: years close in order.`, status: 409 };
  }
  const checks = yearChecks(f);
  const monthsLeft = checks.find((c) => c.key === 'months');
  if (monthsLeft?.state === 'todo') {
    return { message: `Close ${monthText(monthsLeft.months![0])} first: a year closes once all its months are.`, status: 409 };
  }
  if (checks.some((c) => c.state === 'todo') && !reason.trim()) {
    return { message: `Not everything's done before ${f.year} closes, so say why it's closed anyway.`, status: 400 };
  }
  return null;
}

/** Why the year can't be reopened now, or null when it can: only the latest year closed, and only for a reason. */
export function reopenYearRefusal(f: Pick<YearFacts, 'year' | 'years'>, reason: string): Refusal | null {
  const closed = closedYears(f.years);
  if (!closed.has(f.year)) return { message: `${f.year} isn't closed.`, status: 409 };
  const later = [...closed].filter((y) => y > f.year).sort((a, b) => b - a)[0];
  if (later) return { message: `Reopen ${later} first: years reopen from the latest.`, status: 409 };
  if (!reason.trim()) return { message: `Say why ${f.year} is reopened.`, status: 400 };
  return null;
}

/** The year as the page shows it: its checks, whether it's closed and what can be done with it now. */
export function yearView(f: YearFacts, amounts: Pick<YearCloseAmounts, 'netIncome' | 'closed'>): YearView {
  const row = f.years.find((y) => y.year === f.year);
  const live = liveYear(f.liveFrom);
  const closed = row?.closed
    ? { at: row.closedAt, by: row.closedBy, netIncome: row.netIncome, retainedEarnings: row.retainedEarnings }
    : null;
  return {
    own: live !== null && f.year >= live,
    over: `${f.year}-12-31` < f.today,
    checks: yearChecks(f),
    closed,
    changedSince: !!closed && (closed.netIncome !== amounts.netIncome.fleetsuite || closed.retainedEarnings !== amounts.closed.fleetsuite),
    events: row?.events ?? [],
    can: closed
      ? (reopenYearRefusal(f, 'a reason') ? null : 'reopen')
      : (closeYearRefusal(f, 'a reason') ? null : 'close'),
  };
}

/** A company's years as gl_year_closes has them, with every close and reopen, oldest first. */
export async function readYears(service: SupabaseClient, companyId: string): Promise<YearRow[]> {
  const [years, events] = await Promise.all([
    service
      .from('gl_year_closes')
      .select('year, status, closed_at, closed_by_name, net_income_cents, retained_earnings_cents')
      .eq('company_id', companyId)
      .order('year', { ascending: true }),
    fetchAllRows<{
      id: string; year: number; action: YearEvent['action']; actor_name: string | null; reason: string | null;
      net_income_cents: number | string | null; retained_earnings_cents: number | string | null; created_at: string;
    }>((from, to) => service
      .from('gl_year_close_events')
      .select('id, year, action, actor_name, reason, net_income_cents, retained_earnings_cents, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)),
  ]);
  if (years.error) throw new Error(`Couldn't read the years closed: ${years.error.message}`);
  if (events.error) throw new Error(`Couldn't read when the years were closed: ${events.error.message}`);
  const cents = (v: number | string | null) => (v === null ? null : Number(v));
  const eventsOf = new Map<number, YearEvent[]>();
  for (const e of events.data) {
    const listed = eventsOf.get(e.year) ?? [];
    listed.push({
      action: e.action, by: e.actor_name, reason: e.reason, at: e.created_at,
      netIncome: cents(e.net_income_cents), retainedEarnings: cents(e.retained_earnings_cents),
    });
    eventsOf.set(e.year, listed);
  }
  const rows = (years.data ?? []) as Array<{
    year: number; status: string; closed_at: string | null; closed_by_name: string | null;
    net_income_cents: number | string | null; retained_earnings_cents: number | string | null;
  }>;
  return rows.map((y) => ({
    year: y.year,
    closed: y.status === 'closed',
    closedAt: y.closed_at,
    closedBy: y.closed_by_name,
    netIncome: cents(y.net_income_cents),
    retainedEarnings: cents(y.retained_earnings_cents),
    events: eventsOf.get(y.year) ?? [],
  }));
}

/**
 * What else a year's checks read for a company: journal entries typed in
 * FleetSuite dated in it that aren't made yet, each bank account reconciled
 * on Books → 1084's bank reconciliation with the year's months done, and,
 * for the company that makes sales, the year's months with Missouri's
 * return typed in on Books → Sales tax. `accountName` names a bank account
 * by NetSuite's id.
 */
export async function readYearChecks(
  service: SupabaseClient,
  opts: { company: string; year: number; makesSales: boolean; accountName: (netsuiteId: string) => string },
): Promise<Pick<YearFacts, 'entries' | 'banks' | 'returns'>> {
  const january = `${opts.year}-01-01`;
  const december = `${opts.year}-12-01`;
  const [typed, starts, recs, returns] = await Promise.all([
    fetchAllRows<{ id: string; journal: WaitingEntry['journal']; status: WaitingEntry['status'] | 'made' }>((from, to) => service
      .from('typed_journal_entries')
      .select('id, journal, status')
      .eq('company', opts.company)
      .gte('tran_date', january)
      .lte('tran_date', `${opts.year}-12-31`)
      .neq('status', 'made')
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('bank_rec_starts').select('account, first_month').eq('company', opts.company).order('account', { ascending: true }),
    service
      .from('bank_recs')
      .select('account, month')
      .eq('company', opts.company)
      .eq('status', 'done')
      .gte('month', january)
      .lte('month', december)
      .order('account', { ascending: true })
      .order('month', { ascending: true }),
    opts.makesSales
      ? service.from('sales_tax_returns').select('month').eq('company', opts.company).gte('month', january).lte('month', december).order('month', { ascending: true })
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (typed.error) throw new Error(`Couldn't read the journal entries: ${typed.error.message}`);
  const error = starts.error || recs.error || returns.error;
  if (error) throw new Error(`Couldn't read what's done before the year closes: ${error.message}`);

  const doneOf = new Map<string, string[]>();
  for (const r of (recs.data ?? []) as Array<{ account: string; month: string }>) {
    doneOf.set(r.account, [...(doneOf.get(r.account) ?? []), r.month]);
  }
  return {
    // Made ones aren't read.
    entries: typed.data.map((e) => ({ journal: e.journal, status: e.status as WaitingEntry['status'] })),
    banks: ((starts.data ?? []) as Array<{ account: string; first_month: string }>).map((s) => ({
      account: s.account,
      name: opts.accountName(s.account),
      firstMonth: s.first_month,
      done: doneOf.get(s.account) ?? [],
    })),
    returns: opts.makesSales ? ((returns.data ?? []) as Array<{ month: string }>).map((r) => r.month) : null,
  };
}
