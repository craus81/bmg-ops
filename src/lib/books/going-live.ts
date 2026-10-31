import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { BooksError, postEntry, type BooksCompany } from './journal';
import { BOOKS_GL_SYNC, monthOfDate, toCents } from './netsuite-gl';
import { centralDate } from './mistake-checks';
import {
  addDays, lastDay, longDate, openingJournalEntry, PLANNED_LIVE_FROM, workOutOpeningEntry,
  type OpeningAccount, type OpeningData, type OpeningEntry, type OpeningPartyData,
} from './opening-balances';
import type { ReportAmount } from './reports';
import type { TbData } from './trial-balance';

/**
 * Going live (docs/books.md "Going live"). A super admin's tap on the Going
 * live page sets the day a company's books start, January 1, 2027, which
 * can't be undone (migration 359): from then on the books take nothing dated
 * before it but opening balances, and the posting run leaves what's dated
 * before it as it stands. Once the month before is over and a whole copy of
 * NetSuite's ledger has been made since, the posting run posts the opening
 * entry (src/lib/books/opening-balances.ts), customer by customer and vendor
 * by vendor on the receivable and payable accounts, and posts again whenever
 * NetSuite's numbers for that day change, so the books open at them line for
 * line.
 */

/** The first day the Going live page offers the tap: a month before the books go live. */
export const GO_LIVE_FROM = addDays(PLANNED_LIVE_FROM, -31);

export interface CompanyRow {
  id: string;
  code: string;
  name: string;
  books_live_from: string | null;
}

/** The last copy of NetSuite's ledger: when it ran, when one last finished whole, and how the last went. */
export interface LastCopy {
  at: string;
  syncedAt: string | null;
  error: string | null;
}

/** An opening entry the books have, as gl_opening_entries gives it (migration 476). */
export interface OpeningPosted {
  id: string;
  entryNo: number;
  date: string;
  memo: string | null;
  postedAt: string;
  /** What it posts in all, cents. */
  debit: number;
  lines: number;
  /** The number of the entry that reversed it, if one did. */
  reversedBy: number | null;
}

type ChartRow = Omit<OpeningAccount, 'company'> & { company_id: string | null };

/** The month a company's books open at the end of: the one before they go live. */
export const openingMonth = (liveFrom: string) => monthOfDate(addDays(liveFrom, -1))!;

export async function readCompanies(service: SupabaseClient): Promise<CompanyRow[]> {
  const res = await service.from('gl_companies').select('id, code, name, books_live_from').order('code');
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []) as CompanyRow[];
}

export async function readChart(service: SupabaseClient): Promise<ChartRow[]> {
  const res = await fetchAllRows<ChartRow>((from, to) => service
    .from('gl_accounts')
    .select('id, netsuite_account_id, number, name, account_type, statement, is_summary, company_id')
    .order('id', { ascending: true })
    .range(from, to));
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

/** The chart with each account's company named by its code, as the trial balance takes it. */
export const withCompanies = (rows: readonly ChartRow[], codeOf: ReadonlyMap<string, string>): OpeningAccount[] =>
  rows.map(({ company_id, ...a }) => ({ ...a, company: company_id ? codeOf.get(company_id) ?? null : null }));

export async function readLastCopy(service: SupabaseClient): Promise<LastCopy | null> {
  const res = await service.from('sync_state').select('last_result, last_synced_at, updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle();
  if (res.error) throw new Error(res.error.message);
  if (!res.data) return null;
  const last = (res.data.last_result ?? null) as { error?: string } | null;
  return { at: res.data.updated_at, syncedAt: res.data.last_synced_at ?? null, error: last?.error ?? null };
}

/** One company's books as the opening entry is worked out from them: NetSuite's totals and the copy's, and its journal's. */
export async function readTotals(
  service: SupabaseClient,
  company: string,
  accounts: OpeningAccount[],
): Promise<{ data: OpeningData; journal: ReportAmount[] }> {
  const [netsuite, fleetsuite] = await Promise.all([
    service.rpc('gl_netsuite_totals', { p_company: company }),
    service.rpc('gl_books_totals', { p_company: company }),
  ]);
  const error = netsuite.error || fleetsuite.error;
  if (error) throw new Error(error.message);
  const totals = (netsuite.data ?? {}) as Partial<TbData>;
  return {
    data: { company, accounts, opening: totals.opening ?? [], netsuite: totals.netsuite ?? [], copied: totals.copied ?? [] },
    journal: (fleetsuite.data ?? []) as ReportAmount[],
  };
}

export async function readOpeningParties(service: SupabaseClient, company: string, through: string): Promise<OpeningPartyData[]> {
  const res = await service.rpc('gl_opening_parties', { p_company: company, p_through: through });
  if (res.error) throw new Error(res.error.message);
  return ((res.data as { parties?: OpeningPartyData[] } | null)?.parties ?? []);
}

export async function readOpeningEntries(service: SupabaseClient, company: string): Promise<OpeningPosted[]> {
  const res = await service.rpc('gl_opening_entries', { p_company: company });
  if (res.error) throw new Error(res.error.message);
  const entries = ((res.data as { entries?: Array<Record<string, any>> } | null)?.entries ?? []);
  return entries.map((e) => ({
    id: e.id,
    entryNo: Number(e.entry_no),
    date: e.entry_date,
    memo: e.memo ?? null,
    postedAt: e.posted_at,
    debit: toCents(e.debit),
    lines: Number(e.lines),
    reversedBy: e.reversed_by == null ? null : Number(e.reversed_by),
  }));
}

/** Why the tap can't set a company's books live today, as the route answers it; null when it can. */
export function goLiveRefusal(
  company: Pick<CompanyRow, 'code' | 'name' | 'books_live_from'>,
  confirm: string,
  today: string,
): { status: number; message: string } | null {
  if (company.books_live_from) return { status: 409, message: `${company.name}'s books already went live on ${longDate(company.books_live_from)}.` };
  if (today < GO_LIVE_FROM) return { status: 400, message: `${company.name}'s books can go live from ${longDate(GO_LIVE_FROM)}.` };
  if (confirm.trim().toUpperCase() !== company.code.toUpperCase()) return { status: 400, message: `Type ${company.code} to go live.` };
  return null;
}

/**
 * Why a live company's opening entry won't post with the next posting run,
 * or null when it will, or has nothing to post: what would stop it, else a
 * copy of NetSuite's ledger that failed or isn't from since the day ended
 * (in Central time, where the books keep their days).
 */
export function openingWait(entry: OpeningEntry, copy: LastCopy | null): string | null {
  if (entry.problems.length) return entry.problems[0];
  if (!entry.lines.length) return null;
  if (copy?.error) return `The last copy of NetSuite's ledger failed: ${copy.error}${/[.!?]$/.test(copy.error) ? '' : '.'}`;
  if (!copy?.syncedAt || centralDate(new Date(copy.syncedAt)) < entry.liveFrom) {
    return `No whole copy of NetSuite's ledger has been made since ${longDate(entry.date)} ended.`;
  }
  return null;
}

const reason = (err: unknown) => (err instanceof BooksError ? err.problems.join('; ') : String((err as any)?.message || err));

/**
 * The posting run's step for companies whose books are live: once the month
 * before is over, the opening entry posts, and again whenever what differs
 * from NetSuite's numbers for that day changes, until nothing does. The run
 * holds the books' lock (src/lib/books/invoice-posting.ts), so the copy of
 * NetSuite's ledger doesn't change under it. Never throws: what waits or
 * fails is a note for the run's record.
 */
export async function postOpeningEntries(
  service: SupabaseClient,
  /** `today` is Central time's, 'YYYY-MM-DD'; `codeOf` names each company's id by its code, as the chart takes them. */
  opts: { today: string; live: ReadonlyArray<{ code: BooksCompany; liveFrom: string }>; codeOf: ReadonlyMap<string, string> },
): Promise<{ posted: number; notes: string[] }> {
  const run = { posted: 0, notes: [] as string[] };
  const due = opts.live.filter((c) => opts.today >= c.liveFrom);
  if (!due.length) return run;

  let copy: LastCopy | null;
  let accounts: OpeningAccount[];
  try {
    const [last, chart] = await Promise.all([readLastCopy(service), readChart(service)]);
    copy = last;
    accounts = withCompanies(chart, opts.codeOf);
  } catch (err) {
    run.notes.push(`The opening entries couldn't be worked out this time: ${reason(err)}`);
    return run;
  }

  for (const { code, liveFrom } of due) {
    const month = openingMonth(liveFrom);
    const date = lastDay(month);
    const whose = `${code}'s opening entry for ${longDate(date)}`;
    try {
      const { data, journal } = await readTotals(service, code, accounts);
      const [parties, posted] = await Promise.all([readOpeningParties(service, code, date), readOpeningEntries(service, code)]);
      const entry = workOutOpeningEntry(data, journal, month, opts.today, parties);
      const wait = openingWait(entry, copy);
      if (wait) {
        run.notes.push(`${whose} is waiting: ${wait} Going live shows it.`);
        continue;
      }
      if (!entry.lines.length) continue;
      const done = await postEntry(service, openingJournalEntry(entry, posted.length + 1));
      if (!done.alreadyPosted) run.posted += 1;
    } catch (err) {
      run.notes.push(`${whose} couldn't post: ${reason(err)}`);
    }
  }
  return run;
}
