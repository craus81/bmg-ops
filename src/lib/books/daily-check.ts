import type { SupabaseClient } from '@supabase/supabase-js';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import type { BooksCompany } from './journal';
import { BOOKS_GL_SYNC, COPY_FROM } from './netsuite-gl';
import { BOOKS_INVOICE_POSTING, POSTING_COMPANIES, runLimited } from './invoice-posting';
import {
  documentNumber, indexMonths, lastMonth, monthStatuses, monthText, NETSUITE_TYPE, postedKinds,
  type DiffData, type DiffDocumentData,
} from './differences';

/**
 * The daily books check (owner decision 2026-10-18, thread "Replacing
 * NetSuite with FleetSuite"; docs/books.md "Daily check"): every month of
 * each company's books is put next to NetSuite's, as Differences vs NetSuite
 * does, and the super admins are told in FleetSuite when a month stops
 * matching, with a link to that month there.
 *
 * A month stops matching when it matched and now differs on what FleetSuite
 * posts, or when it already differed and more of its documents differ now
 * than when the super admins last heard of it. So a month that differs for a
 * known reason (December 2025, one invoice's sales tax, while a question for
 * the CPA stands) says nothing more until another of its documents differs.
 * The first look learns where things stand and tells nobody.
 *
 * It looks twice each morning (/api/cron/books-daily-check at 09:58 and
 * 13:58 UTC), each time just after a posting run. A document someone was
 * changing in NetSuite while the copies ran can differ until the next
 * posting run catches it up, so the first look, at 4:58 AM Central (3:58 in
 * winter) when nobody works in NetSuite, only notes what newly differs, and
 * the second, at 8:58 (7:58), two posting runs later, tells about what of
 * that still differs. What first differs at the second look waits for the
 * next morning.
 *
 * In-app and push only (books_month_differs). The record in sync_state,
 * 'books_daily_check', holds which months differ and how many of their
 * documents, never an amount, and is left out of HEALTH_MONITORS like the
 * other books jobs; Differences vs NetSuite says when the check last looked.
 * Nothing is written to NetSuite or to the books.
 */

export const BOOKS_DAILY_CHECK = 'books_daily_check';

/** The first look of the day notes what newly differs; the second tells about what of it still does. */
export type Look = 'first' | 'second';

/** The look a run is: the 09:58 UTC run is the first, the 13:58 one the second (vercel.json). */
export const lookOf = (at: Date): Look => (at.getUTCHours() < 12 ? 'first' : 'second');

/** One company's months that differ, 'YYYY-MM-01', each with how many of its documents differ. */
export type DifferingMonths = Record<string, number>;

/** What the check holds for one company from one look to the next. */
export interface CompanyCheck {
  /**
   * The months that differ which the super admins have heard of, or that differed when the check first looked, each
   * with how many of its documents differed then, or fewer if fewer do now. A month drops out once it matches.
   */
  known: DifferingMonths;
  /** What the day's first look found newly differing, for the second to tell about what of it still does. */
  noted: DifferingMonths;
}

export interface DailyCheckState {
  companies: Partial<Record<BooksCompany, CompanyCheck>>;
}

const MONTH_RE = /^\d{4}-\d{2}-01$/;
const has = (months: DifferingMonths, month: string) => Object.prototype.hasOwnProperty.call(months, month);

function parseMonths(raw: unknown): DifferingMonths | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: DifferingMonths = {};
  for (const [month, n] of Object.entries(raw as Record<string, unknown>)) {
    if (!MONTH_RE.test(month) || typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
    out[month] = n;
  }
  return out;
}

/** sync_state.last_result is data, so it's checked before it's used: a company whose part doesn't read is looked at afresh. */
export function parseCheckState(lastResult: unknown): DailyCheckState {
  const raw = ((lastResult ?? {}) as Record<string, any>).companies;
  const companies: DailyCheckState['companies'] = {};
  if (raw && typeof raw === 'object') {
    for (const company of POSTING_COMPANIES) {
      const known = parseMonths(raw[company]?.known);
      const noted = parseMonths(raw[company]?.noted);
      if (known && noted) companies[company] = { known, noted };
    }
  }
  return { companies };
}

/** A month to tell the super admins about. */
export interface MonthNews {
  month: string;
  /** How many of its documents differ now. */
  documents: number;
  /** How many differed when they last heard of it; null when it matched. */
  before: number | null;
}

/**
 * One company's check after a look at the months that differ now, and what to tell about. With nothing held for the
 * company yet (the check's first look, or a company new to the books) what differs now is taken as known.
 */
export function nextCheck(prev: CompanyCheck | undefined, now: DifferingMonths, look: Look): { check: CompanyCheck; news: MonthNews[] } {
  if (!prev) return { check: { known: { ...now }, noted: {} }, news: [] };
  const known: DifferingMonths = {};
  for (const [month, n] of Object.entries(prev.known)) if (has(now, month)) known[month] = Math.min(n, now[month]);
  const isNew = (month: string) => has(now, month) && (!has(known, month) || now[month] > known[month]);

  if (look === 'first') {
    const noted: DifferingMonths = {};
    for (const month of Object.keys(now).sort()) if (isNew(month)) noted[month] = now[month];
    return { check: { known, noted }, news: [] };
  }

  const news = Object.keys(prev.noted).sort().filter(isNew)
    .map((month): MonthNews => ({ month, documents: now[month], before: has(known, month) ? known[month] : null }));
  for (const n of news) known[n.month] = n.documents;
  return { check: { known, noted: {} }, news };
}

// ── What the super admins are told ─────────────────────────────────────────

/** A notification for the super admins. */
export interface CheckAlert {
  title: string;
  body: string;
  url: string;
}

/** What a notification about a month names: its documents that differ, the largest differences first, and how many of its accounts differ. */
export interface MonthFacts {
  documents: DiffDocumentData[];
  accounts: number;
}

/** Documents a notification names. */
const NAMED = 2;
/** More months of a company than this at one look are told about in one notification. */
const ONE_BY_ONE = 3;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const named = (doc: DiffDocumentData) => (doc.copy?.customer ? `${documentNumber(doc)} (${doc.copy.customer})` : documentNumber(doc));

/** What one month's notification says has changed. */
function whatDiffers(n: MonthNews, facts: MonthFacts | undefined): string {
  const docs = (facts?.documents ?? []).slice(0, NAMED).map(named);
  const all = n.documents <= docs.length;
  if (n.before !== null) {
    const which = docs.length ? `${all ? ': ' : ', the largest '}${listed(docs)}` : '';
    return `${plural(n.documents, 'document differs', 'documents differ')} now, ${n.before || 'none'} before${which}.`;
  }
  if (!n.documents) return `FleetSuite's entries differ from NetSuite's on ${plural(facts?.accounts ?? 0, 'account', 'accounts')}.`;
  if (all) return `${listed(docs)} ${n.documents === 1 ? 'differs' : 'differ'} from what NetSuite posted.`;
  return `${plural(n.documents, 'document differs', 'documents differ')} from what NetSuite posted, the largest ${listed(docs)}.`;
}

/**
 * What the super admins are told about one company's months: a notification a month, or one for them all, linking to
 * the first, when there are more than ONE_BY_ONE. `hint` says when the last posting run or copy of NetSuite's ledger
 * failed, which can be why.
 */
export function alertsFor(company: BooksCompany, news: MonthNews[], facts: Map<string, MonthFacts>, hint = ''): CheckAlert[] {
  if (!news.length) return [];
  const books = `${company}'s books`;
  const why = `Differences vs NetSuite shows why.${hint ? ` ${hint}` : ''}`;
  if (news.length > ONE_BY_ONE) {
    const months = news.slice(0, ONE_BY_ONE).map((n) => monthText(n.month));
    return [{
      title: `${books}: ${news.length} months differ from NetSuite now`,
      body: `${listed([...months, `${news.length - ONE_BY_ONE} more`])}. ${why}`,
      url: deepLinks.booksDifferences(company, news[0].month),
    }];
  }
  return news.map((n) => ({
    title: n.before === null
      ? `${books}: ${monthText(n.month)} no longer matches NetSuite`
      : `${books}: more of ${monthText(n.month)} differs from NetSuite`,
    body: `${whatDiffers(n, facts.get(n.month))} ${why}`,
    url: deepLinks.booksDifferences(company, n.month),
  }));
}

// ── Looking ────────────────────────────────────────────────────────────────

/** Months whose documents are looked up at once. */
const LOOKUPS = 4;

/** One company's months that differ now, by the same comparison as Differences vs NetSuite, with what to name for each. */
async function lookAt(service: SupabaseClient, company: BooksCompany): Promise<{ now: DifferingMonths; facts: Map<string, MonthFacts> }> {
  const sides = await service.rpc('gl_books_differences', { p_company: company });
  if (sides.error) throw new Error(`couldn't compare the books (${sides.error.message})`);
  const raw = (sides.data ?? {}) as Partial<DiffData>;
  const data: DiffData = {
    netsuite: raw.netsuite ?? [],
    fleetsuite: raw.fleetsuite ?? [],
    netsuite_kinds: raw.netsuite_kinds ?? [],
    fleetsuite_kinds: raw.fleetsuite_kinds ?? [],
  };
  const posted = postedKinds(data, true);
  const differing = monthStatuses(indexMonths(data), posted, lastMonth(data, COPY_FROM)).filter((m) => m.status === 'differs');
  const kinds = Object.fromEntries(Object.entries(NETSUITE_TYPE).filter(([, type]) => posted.has(type)));

  const now: DifferingMonths = {};
  const facts = new Map<string, MonthFacts>();
  await runLimited(differing.map((m) => async () => {
    const res = await service.rpc('gl_books_difference_documents', {
      p_company: company, p_month: m.month, p_kinds: kinds, p_limit: NAMED,
    });
    if (res.error) throw new Error(`couldn't list ${monthText(m.month)}'s documents (${res.error.message})`);
    const found = (res.data ?? {}) as { counts?: Record<string, number>; documents?: DiffDocumentData[] };
    now[m.month] = Object.values(found.counts ?? {}).reduce((total, n) => total + Number(n || 0), 0);
    facts.set(m.month, { documents: found.documents ?? [], accounts: m.differing });
  }), LOOKUPS);
  return { now, facts };
}

export interface DailyCheckResult {
  look: Look;
  /** Months told about. */
  told: number;
  /** What the look couldn't do; a company it couldn't look at keeps what the check held for it. */
  error?: string;
  heartbeat?: HeartbeatResult;
}

export interface DailyCheckOptions {
  look: Look;
  /** Sends the notifications; the check records them as told once it has. */
  tell: (alerts: CheckAlert[]) => Promise<void>;
}

const reason = (err: unknown) => String((err as any)?.message || err).slice(0, 300);

/** One look at every posting company's months (POSTING_COMPANIES), telling the super admins what stopped matching. */
export async function runDailyCheck(service: SupabaseClient, opts: DailyCheckOptions): Promise<DailyCheckResult> {
  const startedAt = Date.now();
  const read = (syncType: string) => service.from('sync_state').select('last_result').eq('sync_type', syncType).maybeSingle();
  const [prev, posting, copy] = await Promise.all([read(BOOKS_DAILY_CHECK), read(BOOKS_INVOICE_POSTING), read(BOOKS_GL_SYNC)]);
  // Without the last record, what differs now would pass for what the super admins have heard of.
  if (prev.error) return { look: opts.look, told: 0, error: `Couldn't read the last check: ${prev.error.message}` };

  const held = parseCheckState(prev.data?.last_result);
  const failed = (row: typeof posting) => !!(row.data?.last_result as { error?: string } | null)?.error;
  const hint = [
    failed(posting) ? 'The last posting run failed, so FleetSuite may be behind.' : '',
    failed(copy) ? "The last copy of NetSuite's ledger failed." : '',
  ].filter(Boolean).join(' ');

  const companies: DailyCheckState['companies'] = { ...held.companies };
  const alerts: CheckAlert[] = [];
  const errors: string[] = [];
  let told = 0;
  for (const company of POSTING_COMPANIES) {
    try {
      const { now, facts } = await lookAt(service, company);
      const { check, news } = nextCheck(held.companies[company], now, opts.look);
      companies[company] = check;
      alerts.push(...alertsFor(company, news, facts, hint));
      told += news.length;
    } catch (err) {
      errors.push(`${company}: ${reason(err)}`);
    }
  }

  // Told before it's recorded: a send that fails leaves the record as it was, and the next morning tells again.
  if (alerts.length) await opts.tell(alerts);
  const result: DailyCheckResult = { look: opts.look, told, ...(errors.length ? { error: errors.join(' ') } : {}) };
  const heartbeat = await recordHeartbeat(service, BOOKS_DAILY_CHECK, { ...result, companies }, {
    startedAt,
    records: told,
    touchLastSyncedAt: !errors.length,
  });
  return { ...result, heartbeat };
}
