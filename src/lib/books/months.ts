import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { compareMonth, indexMonths, monthText, postedKinds, type DiffData, type MonthStatus } from './differences';
import type { BooksCompany } from './journal';
import { monthOfDate, monthsBetween } from './netsuite-gl';
import { lastDay } from './opening-balances';

/**
 * Closing a month (docs/books.md "Closing a month"). Books → Months closes a
 * company's months in FleetSuite's books one after another, each once it's
 * over, and reopens the latest one closed, for a reason; both are logged
 * (migration 359's gl_period_events). A closed month takes nothing new, so
 * the posting run leaves it as it is and what NetSuite changes in it waits
 * until it's reopened. Closing starts with the month the books went live:
 * nothing dated before then posts but the opening entry anyway.
 */

/** A close or a reopen, as gl_period_events keeps it. */
export interface MonthEvent {
  action: 'closed' | 'reopened';
  by: string | null;
  reason: string | null;
  at: string;
}

/** One of a company's months as gl_periods holds it: a month has a row once anything posts to it or it's closed. */
export interface PeriodRow {
  id: string;
  month: string;
  closed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  events: MonthEvent[];
}

/** How FleetSuite's books compare with NetSuite's for a month, as Differences vs NetSuite compares them. */
export interface MonthCompared {
  status: MonthStatus;
  /** Accounts where what FleetSuite posts differs. */
  differing: number;
  /** NetSuite has documents of kinds FleetSuite doesn't post, so the month can't match whole. */
  notPosted: boolean;
}

export interface MonthRow {
  month: string;
  /** Its last day is behind us, in Central time. */
  over: boolean;
  closed: { at: string | null; by: string | null } | null;
  compared: MonthCompared;
  events: MonthEvent[];
  /** What can be done with it now: the first month that's open and over can be closed, the latest one closed reopened. */
  can: 'close' | 'reopen' | null;
}

export interface Refusal {
  message: string;
  status: number;
}

/** It doesn't match NetSuite whole, so closing it needs a reason. */
export const differs = (c: MonthCompared) => c.status === 'differs' || c.notPosted;

/** Each month's comparison with NetSuite, from gl_books_differences, for a company whose books post (POSTING_COMPANIES). */
export function comparedMonths(data: DiffData): Map<string, MonthCompared> {
  const posted = postedKinds(data, true);
  const index = indexMonths(data);
  const out = new Map<string, MonthCompared>();
  for (const month of index.keys()) {
    const cmp = compareMonth(index.get(month), month, posted);
    out.set(month, { status: cmp.status, differing: cmp.differing, notPosted: cmp.covered !== null && cmp.covered < 1 });
  }
  return out;
}

const NOTHING: MonthCompared = { status: 'none', differing: 0, notPosted: false };

/**
 * A company's months from the one its books went live through the one it is now (`today`, Central), newest first, each
 * with what can be done with it. None before the books go live.
 */
export function monthRows(opts: {
  liveFrom: string | null;
  today: string;
  periods: PeriodRow[];
  compared: Map<string, MonthCompared>;
}): MonthRow[] {
  if (!opts.liveFrom) return [];
  const first = monthOfDate(opts.liveFrom)!;
  const current = monthOfDate(opts.today)!;
  const byMonth = new Map(opts.periods.map((p) => [p.month, p]));
  const months = monthsBetween(first, current);
  const isClosed = (month: string) => byMonth.get(month)?.closed ?? false;
  const firstOpen = months.find((m) => !isClosed(m));
  const lastClosed = [...months].reverse().find(isClosed);
  return months.map((month): MonthRow => {
    const period = byMonth.get(month);
    const over = lastDay(month) < opts.today;
    return {
      month,
      over,
      closed: period?.closed ? { at: period.closedAt, by: period.closedBy } : null,
      compared: opts.compared.get(month) ?? NOTHING,
      events: period?.events ?? [],
      can: month === lastClosed ? 'reopen' : month === firstOpen && over ? 'close' : null,
    };
  }).reverse();
}

/** Why a month can't be closed now, or null when it can; a month that differs from NetSuite needs a reason. */
export function closeRefusal(opts: {
  name: string;
  liveFrom: string | null;
  rows: MonthRow[];
  month: string;
  reason: string;
}): Refusal | null {
  const { name, liveFrom, rows, month } = opts;
  const words = monthText(month);
  if (!liveFrom) return { message: `${name}'s books aren't live yet, so there's no month to close.`, status: 409 };
  if (month < monthOfDate(liveFrom)!) {
    return { message: `${words} is before ${name}'s books went live, so nothing posts to it but the opening entry.`, status: 400 };
  }
  const row = rows.find((r) => r.month === month);
  if (!row || !row.over) return { message: `${words} isn't over yet.`, status: 409 };
  if (row.closed) return { message: `${words} is already closed.`, status: 409 };
  const earlier = rows.filter((r) => r.month < month && !r.closed).map((r) => r.month).sort()[0];
  if (earlier) return { message: `Close ${monthText(earlier)} first: months close in order.`, status: 409 };
  if (differs(row.compared) && !opts.reason.trim()) {
    return { message: `${words} doesn't match NetSuite, so say why it's closed anyway.`, status: 400 };
  }
  return null;
}

/** Why a month can't be reopened now, or null when it can: only the latest one closed, and only for a reason. */
export function reopenRefusal(opts: { rows: MonthRow[]; month: string; reason: string }): Refusal | null {
  const words = monthText(opts.month);
  const row = opts.rows.find((r) => r.month === opts.month);
  if (!row?.closed) return { message: `${words} isn't closed.`, status: 409 };
  const later = opts.rows.filter((r) => r.month > opts.month && r.closed).map((r) => r.month).sort().reverse()[0];
  if (later) return { message: `Reopen ${monthText(later)} first: months reopen from the latest.`, status: 409 };
  if (!opts.reason.trim()) return { message: `Say why ${words} is reopened.`, status: 400 };
  return null;
}

/** A company's months as gl_periods holds them, with every close and reopen, oldest first. */
export async function readPeriods(service: SupabaseClient, companyId: string): Promise<PeriodRow[]> {
  const periods = await fetchAllRows<{ id: string; period_start: string; status: string; closed_at: string | null; closed_by_name: string | null }>(
    (from, to) => service
      .from('gl_periods')
      .select('id, period_start, status, closed_at, closed_by_name')
      .eq('company_id', companyId)
      .order('period_start', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (periods.error) throw new Error(`Couldn't read the months: ${periods.error.message}`);
  const ids = periods.data.map((p) => p.id);
  const events = ids.length
    ? await fetchAllRows<{ id: string; period_id: string; action: MonthEvent['action']; actor_name: string | null; reason: string | null; created_at: string }>(
      (from, to) => service
        .from('gl_period_events')
        .select('id, period_id, action, actor_name, reason, created_at')
        .in('period_id', ids)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
    : { data: [], error: null };
  if (events.error) throw new Error(`Couldn't read when the months were closed: ${events.error.message}`);
  const eventsOf = new Map<string, MonthEvent[]>();
  for (const e of events.data) {
    const list = eventsOf.get(e.period_id) ?? [];
    list.push({ action: e.action, by: e.actor_name, reason: e.reason, at: e.created_at });
    eventsOf.set(e.period_id, list);
  }
  return periods.data.map((p) => ({
    id: p.id,
    month: p.period_start,
    closed: p.status === 'closed',
    closedAt: p.closed_at,
    closedBy: p.closed_by_name,
    events: eventsOf.get(p.id) ?? [],
  }));
}

/** Each company's closed months, by its code, as 'YYYY-MM-01'. */
export async function readClosedMonths(service: SupabaseClient, codeOf: ReadonlyMap<string, string>): Promise<Map<BooksCompany, Set<string>>> {
  const res = await fetchAllRows<{ id: string; company_id: string; period_start: string }>((from, to) => service
    .from('gl_periods')
    .select('id, company_id, period_start')
    .eq('status', 'closed')
    .order('id', { ascending: true })
    .range(from, to));
  if (res.error) throw new Error(res.error.message);
  const out = new Map<BooksCompany, Set<string>>();
  for (const p of res.data) {
    const code = codeOf.get(p.company_id) as BooksCompany | undefined;
    if (!code) continue;
    const months = out.get(code) ?? new Set<string>();
    months.add(p.period_start);
    out.set(code, months);
  }
  return out;
}
