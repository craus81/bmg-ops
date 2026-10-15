import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { compactSuiteqlError } from '@/lib/sales-order-sync';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { writeSyncStateCursor } from '@/lib/ledger/write';
import { fetchAllRows } from '@/lib/fetch-all';
import {
  BooksError, centsToAmount, postEntry, repostEntry, reverseEntry,
  type BooksCompany, type JournalEntryInput,
} from './journal';
import { COPY_FROM, monthOfDate, monthsBetween } from './netsuite-gl';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { MAIN_LINE, RULES, type RuleLine, type SalesDocKind } from './invoice-rule';
import {
  centsOf, workOutMonth,
  type ChartAccount, type InvoiceBooks, type InvoiceMonthData, type ItemAccountCount, type LineFacts,
  type LineFactsRead, type TaxAccountCount, type WorkedInvoice,
} from './invoice-check';
import { readLineFacts } from './invoice-line-facts';
import { PAYMENT_RULE, RECEIVABLE_LINE } from './payment-rule';
import { workOutPaymentMonth, type PaymentMonthData, type WorkedPayment } from './payment-check';

/**
 * NetSuite's invoices posted to FleetSuite's own journal with the invoice
 * rule (migration 367, docs/books.md "Posting invoices"; owner decision
 * 2026-10-13, thread "Replacing NetSuite with FleetSuite"), and its credit
 * memos with the credit memo rule, the same the other way round (migration
 * 370; owner decision 2026-10-14). Everything below that says invoice holds
 * for a credit memo too, and for a customer payment, posted with the payment
 * rule (migration 376; owner decision 2026-10-15), except where the
 * payments' own section says otherwise.
 *
 * Every BMG invoice dated from January 2025 that the rule can work out posts
 * once, as the check on Invoices vs NetSuite shows it, whether it matches
 * NetSuite or not: during 2027 the differences are what the side-by-side run
 * is for. Each run (/api/cron/books-invoice-posting at :48 on odd hours, and
 * "Post now" on that page) goes through every month again:
 *
 *   - an invoice with no entry gets one;
 *   - one whose entry no longer fits what the rule works out now (NetSuite
 *     changed it, or the copies of its lines, items or GL did) has its entry
 *     reversed and the new one posted, in one transaction;
 *   - one NetSuite voided or deleted, or that now comes to nothing, has its
 *     entry reversed;
 *   - one the rule can't work out yet, or whose lines don't add up to its
 *     total in the copy (caught mid-refresh), keeps whatever it has.
 *
 * A month whose invoice lines NetSuite couldn't be asked about is left as it
 * is, since its entries could come out different without those answers. The
 * run takes the NetSuite GL copy's lock: it reads that copy, so it never runs
 * while the copy is changing it, and two runs never overlap.
 *
 * Until a company's books go live, the journal can be emptied and posted
 * again (gl_reset_journal). Nothing is written to NetSuite.
 *
 * The run is recorded in sync_state as 'books_invoice_posting' and left out
 * of HEALTH_MONITORS like the other books jobs; no amount goes in that
 * record, a log line or the cron's response.
 */

export const BOOKS_INVOICE_POSTING = 'books_invoice_posting';

/** The companies whose invoices, credit memos and payments post. 1084's join once they've been checked against NetSuite. */
export const POSTING_COMPANIES: readonly BooksCompany[] = ['BMG'];

/** Seconds a run holds the lock: past the routes' 300 s limit, so a run that dies lets go soon after. */
const LEASE_SECONDS = 330;
/** A month is only started with this much of the budget left. */
const MIN_LEFT_MS = 25_000;
/** No new write starts with less than this left. */
const WRITE_MIN_LEFT_MS = 5_000;
/** Entries written at once. */
const WRITERS = 4;
/** Failures kept in the run's record. */
const FAILURES_KEPT = 20;
/** NetSuite throws the odd UNEXPECTED_ERROR that succeeds on re-send. */
const SUITEQL_OPTS = { retries: 2 };
/** What NetSuite says about a line that changes the entry, in words; without one, a month's entries could come out different. */
const NEEDED_FACTS: ReadonlyArray<{ fact: keyof LineFacts; words: string }> = [
  { fact: 'cogs', words: 'which lines are cost of goods' },
  { fact: 'topDiscount', words: 'which line is a discount or markup set at the top' },
  { fact: 'amount', words: "the lines' own amounts" },
];

const MONTH_RE = /^\d{4}-\d{2}-01$/;

// ── What the journal holds ─────────────────────────────────────────────────

/** A line of the entry that stands, as gl_invoice_postings returns it. */
export interface PostedLine {
  /** NetSuite's id for the account. */
  account: string | null;
  debit: string;
  credit: string;
  division: string | null;
  source_line_ref: string | null;
  customer_id: string | null;
}

/** What the journal holds for one invoice or credit memo (gl_invoice_postings, migrations 367 and 370). */
export interface InvoicePosting {
  source_type: SalesDocKind;
  source_id: string;
  /** How many entries it has had. */
  entries: number;
  /** Its entries nothing reversed, newest first: normally just the one that stands. */
  unreversed: string[];
  current: { id: string; entry_no: number; entry_date: string; lines?: PostedLine[] | null } | null;
  history: Array<{ entry_no: number; entry_date: string; reversed_by: number | null }>;
  /** What the copy of NetSuite's invoices says of it; null when the copy has none. */
  invoice: { number: string | null; deleted: boolean; voided: boolean } | null;
}

// ── Deciding ───────────────────────────────────────────────────────────────

/** Which kind of document it is: anything but a credit memo is an invoice. */
const kindOf = (worked: WorkedInvoice): SalesDocKind => (worked.invoice.doc_type === 'credit_memo' ? 'credit_memo' : 'invoice');

/** What the journal holds for a document is looked up by its kind and NetSuite id, as its entries name it. */
export const postingKey = (kind: SalesDocKind, netsuiteId: string) => `${kind}:${netsuiteId}`;

/** What the journal holds for a worked out document, from gl_invoice_postings' answer keyed by postingKey. */
export const postingFor = (postings: Map<string, InvoicePosting>, worked: WorkedInvoice) =>
  postings.get(postingKey(kindOf(worked), worked.invoice.netsuite_id));

/** The lines the rule works out for an invoice, the receivable first; none when it posts nothing. */
export function entryLines(worked: WorkedInvoice): RuleLine[] {
  return worked.checked.rows.flatMap((r) => (r.fleetsuite && r.fleetsuite.cents !== 0 ? [r.fleetsuite] : []));
}

interface SignatureLine {
  account: string;
  /** Debit positive. */
  cents: number;
  division: string | null;
  lineRef: string | null;
  customerId: string | null;
}

/**
 * What an entry says, as text two entries can be compared by: its date and
 * each line's account, amount, division, invoice line and customer. Memos
 * and item numbers only describe, so a rename doesn't re-post anything.
 */
export function signature(date: string, lines: SignatureLine[]): string {
  const keyed = lines.map((l) => [l.account, l.cents, l.division ?? '', l.lineRef ?? '', l.customerId ?? ''].join('|'));
  return [date, ...keyed.sort()].join('\n');
}

const postedSignature = (current: NonNullable<InvoicePosting['current']>) => signature(
  current.entry_date,
  (current.lines ?? []).map((l) => ({
    account: l.account ?? '',
    cents: (centsOf(l.debit) ?? 0) - (centsOf(l.credit) ?? 0),
    division: l.division,
    lineRef: l.source_line_ref,
    customerId: l.customer_id,
  })),
);

const workedSignature = (worked: WorkedInvoice) => signature(
  worked.invoice.date,
  entryLines(worked).map((l) => ({
    account: l.account,
    cents: l.cents,
    division: l.division,
    lineRef: l.lineId,
    customerId: l.lineId === MAIN_LINE ? worked.invoice.customer_id ?? null : null,
  })),
);

export type Decision =
  /** Nothing stands for it: post its entry. */
  | { kind: 'post' }
  /** What stands no longer fits: reverse it and post the new entry. */
  | { kind: 'replace' }
  /** Reverse what stands and post nothing: NetSuite voided it, or it comes to nothing now. */
  | { kind: 'reverse'; why: 'voided' | 'nothing' }
  /** What stands is right, or nothing stands and nothing should. */
  | { kind: 'keep' }
  /**
   * Whatever stands stays: the rule can't work it out yet, its lines aren't
   * copied yet, or they don't add up to its total in the copy (caught
   * mid-refresh). The next run looks again.
   */
  | { kind: 'leave'; why: 'unworkable' | 'waiting' | 'total' };

/** What to do about one invoice the rule has worked out, given what the journal holds for it. */
export function decide(worked: WorkedInvoice, posting: InvoicePosting | undefined): Decision {
  const current = posting?.current ?? null;
  if (worked.invoice.voided) return current ? { kind: 'reverse', why: 'voided' } : { kind: 'keep' };
  const { status } = worked.checked;
  if (status === 'waiting') return { kind: 'leave', why: 'waiting' };
  if (status === 'unworkable') return { kind: 'leave', why: 'unworkable' };

  // The receivable is the invoice's total, or a credit memo's credited (the
  // copy keeps both totals unsigned), so lines that don't come to it are the
  // copy's lines caught mid-refresh, not the document.
  const lines = entryLines(worked);
  const receivable = lines.find((l) => l.lineId === MAIN_LINE)?.cents ?? 0;
  const total = centsOf(worked.invoice.total);
  if (receivable !== (total !== null && kindOf(worked) === 'credit_memo' ? -total : total)) return { kind: 'leave', why: 'total' };

  if (lines.length === 0) return current ? { kind: 'reverse', why: 'nothing' } : { kind: 'keep' };
  if (!current) return { kind: 'post' };
  return postedSignature(current) === workedSignature(worked) ? { kind: 'keep' } : { kind: 'replace' };
}

/** What NetSuite wouldn't say about a month's invoice lines that the entries depend on; a run leaves such a month alone. */
export function unsaidFacts(facts: LineFactsRead): Array<(typeof NEEDED_FACTS)[number]> {
  return NEEDED_FACTS.filter((f) => facts.missing.includes(f.fact));
}

/**
 * What the journal holds for an invoice and what the next run does about
 * it, for the invoices page. `decides` is false when NetSuite couldn't say
 * enough about the month's lines: the run would leave the month alone, so
 * nothing is shown as next.
 */
export function invoiceBooks(worked: WorkedInvoice, posting: InvoicePosting | undefined, decides = true): InvoiceBooks {
  return booksOf(decide(worked, posting), posting, decides);
}

/** What the journal holds for a document and what the next run does about it, given the run's decision. */
function booksOf(d: Decision, posting: Pick<InvoicePosting, 'current' | 'history'> | undefined, decides: boolean): InvoiceBooks {
  const current = posting?.current ?? null;
  return {
    entryNo: current?.entry_no ?? null,
    next: decides && (d.kind === 'post' || d.kind === 'replace' || d.kind === 'reverse') ? d.kind : null,
    earlier: (posting?.history ?? [])
      .filter((h) => h.entry_no !== current?.entry_no)
      .map((h) => ({ entryNo: h.entry_no, reversedBy: h.reversed_by })),
  };
}

/**
 * The journal entry for an invoice or credit memo, its `generation`th: the
 * rule's lines on the chart's accounts, the receivable carrying the customer,
 * keyed by its kind (`invoice:…`, `credit_memo:…`). Null with the NetSuite
 * accounts the chart doesn't have when it can't be built.
 */
export function invoiceJournalEntry(
  worked: WorkedInvoice,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  const lines = entryLines(worked);
  const missing = [...new Set(lines.map((l) => l.account).filter((a) => !accountIds.has(a)))];
  if (missing.length) return { entry: null, missing };
  const inv = worked.invoice;
  const kind = kindOf(worked);
  return {
    entry: {
      company,
      entryDate: inv.date,
      sourceType: kind,
      sourceId: inv.netsuite_id,
      postingRule: RULES[kind],
      idempotencyKey: `${kind}:${inv.netsuite_id}:${generation}`,
      memo: inv.customer ? `${worked.number}, ${inv.customer}` : worked.number,
      postedBy: null,
      lines: lines.map((l) => ({
        accountId: accountIds.get(l.account)!,
        debit: l.cents > 0 ? centsToAmount(l.cents) : null,
        credit: l.cents < 0 ? centsToAmount(-l.cents) : null,
        division: l.division,
        itemNumber: l.itemNumber,
        sourceLineRef: l.lineId,
        customerId: l.lineId === MAIN_LINE ? inv.customer_id ?? null : null,
      })),
    },
    missing: [],
  };
}

// ── Payments ───────────────────────────────────────────────────────────────
//
// A payment posts as an invoice does, with two differences: it has no lines
// of its own to wait for or add up (its entry is the money, any discount and
// the receivable), and what the journal holds for it comes from
// gl_payment_postings (migration 376), keyed payment:<NetSuite id>:<n>.

/** What the journal holds for one customer payment (gl_payment_postings, migration 376). */
export interface PaymentPosting extends Omit<InvoicePosting, 'source_type' | 'invoice'> {
  source_type: 'payment';
  /** What the ledger mirror's copy of the payment says of it now; null when the copy has none. */
  payment: { number: string | null; deleted: boolean; voided: boolean } | null;
}

/** The lines the payment rule works out for a payment: where the money went, any discount and the receivable; none when it posts nothing. */
export function paymentEntryLines(worked: WorkedPayment): RuleLine[] {
  return worked.checked.rows.flatMap((r) => (r.fleetsuite && r.fleetsuite.cents !== 0
    ? [{ account: r.fleetsuite.account, cents: r.fleetsuite.cents, lineId: r.lineId, itemNumber: null, division: null }]
    : []));
}

const paymentSignature = (worked: WorkedPayment) => signature(
  worked.payment.date,
  paymentEntryLines(worked).map((l) => ({
    account: l.account,
    cents: l.cents,
    division: null,
    lineRef: l.lineId,
    customerId: l.lineId === RECEIVABLE_LINE ? worked.payment.customer_id ?? null : null,
  })),
);

/** What to do about one payment the rule has worked out, given what the journal holds for it. */
export function decidePayment(worked: WorkedPayment, posting: PaymentPosting | undefined): Decision {
  const current = posting?.current ?? null;
  if (worked.payment.voided) return current ? { kind: 'reverse', why: 'voided' } : { kind: 'keep' };
  const { status } = worked.checked;
  if (status === 'waiting') return { kind: 'leave', why: 'waiting' };
  if (status === 'unworkable') return { kind: 'leave', why: 'unworkable' };
  if (paymentEntryLines(worked).length === 0) return current ? { kind: 'reverse', why: 'nothing' } : { kind: 'keep' };
  if (!current) return { kind: 'post' };
  return postedSignature(current) === paymentSignature(worked) ? { kind: 'keep' } : { kind: 'replace' };
}

/** What the journal holds for a payment and what the next run does about it, for the invoices page. */
export function paymentBooks(worked: WorkedPayment, posting: PaymentPosting | undefined): InvoiceBooks {
  return booksOf(decidePayment(worked, posting), posting, true);
}

/**
 * The journal entry for a payment, its `generation`th: the rule's lines on
 * the chart's accounts, the receivable carrying the customer, keyed
 * `payment:…`. Null with the NetSuite accounts the chart doesn't have when
 * it can't be built.
 */
export function paymentJournalEntry(
  worked: WorkedPayment,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  const lines = paymentEntryLines(worked);
  const missing = [...new Set(lines.map((l) => l.account).filter((a) => !accountIds.has(a)))];
  if (missing.length) return { entry: null, missing };
  const p = worked.payment;
  return {
    entry: {
      company,
      entryDate: p.date,
      sourceType: 'payment',
      sourceId: p.netsuite_id,
      postingRule: PAYMENT_RULE,
      idempotencyKey: `payment:${p.netsuite_id}:${generation}`,
      memo: p.customer ? `${worked.number}, ${p.customer}` : worked.number,
      postedBy: null,
      lines: lines.map((l) => ({
        accountId: accountIds.get(l.account)!,
        debit: l.cents > 0 ? centsToAmount(l.cents) : null,
        credit: l.cents < 0 ? centsToAmount(-l.cents) : null,
        division: null,
        itemNumber: null,
        sourceLineRef: l.lineId,
        customerId: l.lineId === RECEIVABLE_LINE ? p.customer_id ?? null : null,
      })),
    },
    missing: [],
  };
}

/** Why a write failed, in words that carry no amount: the run's record is kept where amounts never go. */
export function failureReason(err: unknown): string {
  const money = /\$|\bdebits?\b|\bcredits?\b|balance/i;
  const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`.slice(0, 200);
  if (err instanceof BooksError) {
    const told = err.problems.filter((p) => !money.test(p));
    if (told.length) return sentence(told.join('; '));
    return err.kind === 'invalid' ? "FleetSuite's entry didn't pass the journal's own checks." : 'The journal refused the entry.';
  }
  return sentence(String((err as any)?.message || err).replace(/-?\d[\d,]*\.\d{2}\b/g, '…'));
}

// ── The run ────────────────────────────────────────────────────────────────

export interface InvoicePostingResult {
  /** Months gone through this run, 'YYYY-MM-01'. */
  months?: string[];
  posted?: number;
  replaced?: number;
  reversed?: number;
  unchanged?: number;
  /** Invoices, credit memos and payments the rule can't work out yet, or whose copy was mid-refresh: whatever stands for them stayed. */
  left?: number;
  /** Writes the journal refused or that failed, a few of them with why. */
  failedCount?: number;
  failed?: Array<{ number: string; reason: string }>;
  /** Stopped for time with months still to go through; the next run carries on. */
  partial?: boolean;
  /** What the run couldn't do, in plain words. */
  notes?: string[];
  /** Another books job was running, so this one did nothing. */
  skipped?: string;
  error?: string;
}

/** Where a run cut short carries on: a company and month. */
interface PostingState {
  resume: { company: BooksCompany; month: string } | null;
}

/** sync_state.last_result is data, so it's checked before it's used. */
export function parsePostingState(lastResult: unknown): PostingState {
  const r = ((lastResult ?? {}) as Record<string, any>).resume;
  if (r && typeof r === 'object' && (POSTING_COMPANIES as readonly string[]).includes(r.company)
    && typeof r.month === 'string' && MONTH_RE.test(r.month)) {
    return { resume: { company: r.company, month: r.month } };
  }
  return { resume: null };
}

/** Every company's months in turn, starting where the last run stopped. */
export function postingQueue(companies: readonly BooksCompany[], months: string[], resume: PostingState['resume']) {
  const queue = companies.flatMap((company) => months.map((month) => ({ company, month })));
  const at = resume ? queue.findIndex((q) => q.company === resume.company && q.month === resume.month) : -1;
  return at > 0 ? [...queue.slice(at), ...queue.slice(0, at)] : queue;
}

type SuiteqlAll = (query: string) => Promise<Array<Record<string, unknown>>>;

export interface PostingDeps {
  query?: SuiteqlAll;
  now?: () => number;
}

const monthLabel = (month: string) =>
  new Date(`${month}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const listed = (items: string[], max = 10) => `${items.slice(0, max).join(', ')}${items.length > max ? ', …' : ''}`;
const joined = (words: string[], last: 'and' | 'or') =>
  (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} ${last} ${words[words.length - 1]}`);
/** '2 invoices and 1 credit memo', for documents of these kinds. */
const documents = (kinds: SalesDocKind[]) => {
  const invoices = kinds.filter((k) => k === 'invoice').length;
  const memos = kinds.length - invoices;
  return joined([
    invoices ? plural(invoices, 'invoice', 'invoices') : '',
    memos ? plural(memos, 'credit memo', 'credit memos') : '',
  ].filter(Boolean), 'and');
};

async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

export async function postInvoices(
  service: SupabaseClient,
  opts: { deadline: number; deps?: PostingDeps },
): Promise<InvoicePostingResult & { heartbeat?: HeartbeatResult }> {
  const now = opts.deps?.now ?? Date.now;
  const query: SuiteqlAll = opts.deps?.query ?? ((q) => suiteqlQueryAll(q, 1000, SUITEQL_OPTS));
  const timeLeft = () => opts.deadline - now();
  const startedAt = now();

  const prev = await service.from('sync_state').select('last_result').eq('sync_type', BOOKS_INVOICE_POSTING).maybeSingle();
  const state = parsePostingState(prev.data?.last_result);

  // Posting reads the GL copy, so it takes the copy's lock: never while the copy changes it, never twice at once.
  const holder = `posting:${crypto.randomUUID()}`;
  const claim = await service.rpc('gl_netsuite_claim_copy', { p_holder: holder, p_seconds: LEASE_SECONDS });
  if (!claim.error && claim.data !== true) return { skipped: 'Another books job is running.' };

  const result: InvoicePostingResult = { months: [], posted: 0, replaced: 0, reversed: 0, unchanged: 0, left: 0, failedCount: 0, failed: [] };
  const notes: string[] = [];
  const record = () => ({ ...result, ...(notes.length ? { notes } : {}), resume: state.resume });

  const failed = (number: string, err: unknown) => {
    result.failedCount! += 1;
    if (result.failed!.length < FAILURES_KEPT) result.failed!.push({ number, reason: failureReason(err) });
  };

  try {
    if (claim.error) throw new Error(`Couldn't start posting: ${claim.error.message}`);

    const [chart, lists] = await Promise.all([
      fetchAllRows<{ id: string; netsuite_account_id: string | null; number: string | null; name: string; account_type: string; company_id: string | null; active: boolean; is_summary: boolean }>((from, to) => service
        .from('gl_accounts')
        .select('id, netsuite_account_id, number, name, account_type, company_id, active, is_summary')
        .order('id', { ascending: true })
        .range(from, to)),
      service.from('sync_state').select('last_result').eq('sync_type', BOOKS_LISTS_SYNC).maybeSingle(),
    ]);
    if (chart.error) throw new Error(chart.error.message);
    if (lists.error) throw new Error(lists.error.message);
    const companies = await service.from('gl_companies').select('id, code');
    if (companies.error) throw new Error(companies.error.message);
    const codeOf = new Map(((companies.data ?? []) as Array<{ id: string; code: string }>).map((c) => [c.id, c.code]));

    const accountIds = new Map<string, string>();
    for (const a of chart.data) if (a.netsuite_account_id) accountIds.set(a.netsuite_account_id, a.id);
    const chartAccounts: ChartAccount[] = chart.data.map(({ id: _id, company_id, ...a }) => ({
      ...a, company: company_id ? codeOf.get(company_id) ?? null : null,
    }));
    const lastLists = (lists.data?.last_result ?? null) as { taxAccounts?: TaxAccountCount[]; itemAccounts?: ItemAccountCount[] } | null;
    const taxAccounts = Array.isArray(lastLists?.taxAccounts) ? lastLists.taxAccounts : null;
    const itemAccounts = Array.isArray(lastLists?.itemAccounts) ? lastLists.itemAccounts : null;
    if (!taxAccounts) notes.push("Where sales tax posts hasn't been read yet, so invoices and credit memos with sales tax weren't posted. Sync now on the NetSuite lists page reads it.");

    const reverse = async (number: string, entryId: string, memo: string) => {
      try {
        await reverseEntry(service, { entryId, memo });
        result.reversed! += 1;
      } catch (err) {
        failed(number, err);
      }
    };

    // 1. What NetSuite deleted or voided, and any second entry standing for one document.
    for (const company of POSTING_COMPANIES) {
      const [all, paid] = await Promise.all([
        service.rpc('gl_invoice_postings', { p_company: company, p_source_ids: null, p_lines: false }),
        service.rpc('gl_payment_postings', { p_company: company, p_source_ids: null, p_lines: false }),
      ]);
      if (all.error) throw new Error(all.error.message);
      if (paid.error) throw new Error(paid.error.message);
      const held = [
        ...(((all.data as any)?.invoices ?? []) as InvoicePosting[]).map((p) => ({ posting: p, copy: p.invoice })),
        ...(((paid.data as any)?.payments ?? []) as PaymentPosting[]).map((p) => ({ posting: p, copy: p.payment })),
      ];
      const tasks: Array<() => Promise<void>> = [];
      for (const { posting: p, copy } of held) {
        const number = copy?.number || `NetSuite ${p.source_id}`;
        for (const extra of p.unreversed.slice(1)) {
          tasks.push(() => reverse(number, extra, `${number} had another entry standing`));
        }
        const gone = copy?.deleted ? 'deleted' : copy?.voided ? 'voided' : null;
        if (p.current && gone) {
          const entryId = p.current.id;
          tasks.push(() => reverse(number, entryId, `${number} ${gone} in NetSuite`));
        }
      }
      await runLimited(tasks, WRITERS);
    }

    // 2. Every month, from where the last run stopped.
    const months = monthsBetween(COPY_FROM, monthOfDate(new Date(now()).toISOString().slice(0, 10))!);
    const skippedMonths: string[] = [];
    let skippedWhy = '';
    const leftTotal: Array<{ number: string; kind: SalesDocKind }> = [];
    const missingAccounts = new Set<string>();
    const queue = postingQueue(POSTING_COMPANIES, months, state.resume);

    /** Queues the writes a decision about one document calls for, or counts it when it calls for none. */
    const enqueue = (
      tasks: Array<() => Promise<void>>,
      number: string,
      d: Decision,
      current: { id: string } | null,
      build: () => { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] },
    ) => {
      if (d.kind === 'keep') {
        if (current) result.unchanged! += 1;
        return;
      }
      if (d.kind === 'leave') {
        result.left! += 1;
        return;
      }
      if (d.kind === 'reverse') {
        const memo = `${number} ${d.why === 'voided' ? 'voided' : 'comes to nothing'} in NetSuite`;
        tasks.push(() => reverse(number, current!.id, memo));
        return;
      }
      const built = build();
      if (!built.entry) {
        for (const a of built.missing) missingAccounts.add(a);
        failed(number, new Error(`It posts to NetSuite account ${built.missing.join(', ')}, which the chart of accounts doesn't have`));
        return;
      }
      const entry = built.entry;
      tasks.push(async () => {
        if (timeLeft() < WRITE_MIN_LEFT_MS) {
          result.partial = true;
          return;
        }
        try {
          if (d.kind === 'post') {
            const posted = await postEntry(service, entry);
            if (posted.alreadyPosted) result.unchanged! += 1;
            else result.posted! += 1;
          } else {
            await repostEntry(service, { entryId: current!.id, memo: `${number} changed in NetSuite`, entry });
            result.replaced! += 1;
          }
        } catch (err) {
          failed(number, err);
        }
      });
    };

    for (const [i, { company, month }] of queue.entries()) {
      if (timeLeft() < MIN_LEFT_MS) {
        result.partial = true;
        break;
      }
      state.resume = { company, month };

      const res = await service.rpc('gl_invoice_month', { p_company: company, p_month: month });
      if (res.error) throw new Error(res.error.message);
      const data = (res.data ?? {}) as Partial<InvoiceMonthData>;
      const invoices = data.invoices ?? [];
      const mine = invoices.filter((inv) => inv.companies.includes(company));

      if (mine.length) {
        let facts: LineFactsRead | null = null;
        try {
          facts = await readLineFacts(query, mine.map((inv) => inv.netsuite_id));
        } catch (err) {
          skippedMonths.push(month);
          skippedWhy ||= `NetSuite couldn't be asked about the invoices' and credit memos' lines (${compactSuiteqlError(err)})`;
        }
        const unsaid = facts ? unsaidFacts(facts) : [];
        if (facts && unsaid.length) {
          skippedMonths.push(month);
          skippedWhy ||= `NetSuite wouldn't say ${joined(unsaid.map((f) => f.words), 'and')} on the invoices and credit memos`;
          facts = null;
        }

        if (facts) {
          const worked = workOutMonth(
            { invoices, items: data.items ?? [] },
            { company, chart: chartAccounts, taxAccounts, itemAccounts, facts },
          ).invoices.filter((w) => w.invoice.companies.includes(company));

          const held = await service.rpc('gl_invoice_postings', {
            p_company: company, p_source_ids: mine.map((inv) => inv.netsuite_id), p_lines: true,
          });
          if (held.error) throw new Error(held.error.message);
          const postings = new Map((((held.data as any)?.invoices ?? []) as InvoicePosting[]).map((p) => [postingKey(p.source_type, p.source_id), p]));

          const tasks: Array<() => Promise<void>> = [];
          for (const w of worked) {
            const posting = postingFor(postings, w);
            const d = decide(w, posting);
            if (d.kind === 'leave' && d.why === 'total') leftTotal.push({ number: w.number, kind: kindOf(w) });
            enqueue(tasks, w.number, d, posting?.current ?? null, () => invoiceJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds));
          }
          await runLimited(tasks, WRITERS);
          if (result.partial) break;
        }
      }

      // The month's payments: no lines of their own, so nothing to ask NetSuite. One in neither company's GL copy
      // is this company's only while an entry of it stands here: NetSuite posts nothing for it now (a $0 payment
      // posts no lines), or the copy hasn't caught up with it, and the decision tells the two apart.
      const paid = await service.rpc('gl_payment_month', { p_company: company, p_month: month });
      if (paid.error) throw new Error(paid.error.message);
      const payments = workOutPaymentMonth(
        { payments: ((paid.data ?? {}) as Partial<PaymentMonthData>).payments ?? [] },
        { company, chart: chartAccounts },
      ).payments.filter((w) => w.payment.companies.length === 0 || w.payment.companies.includes(company));
      if (payments.length) {
        const held = await service.rpc('gl_payment_postings', {
          p_company: company, p_source_ids: payments.map((w) => w.payment.netsuite_id), p_lines: true,
        });
        if (held.error) throw new Error(held.error.message);
        const postings = new Map((((held.data as any)?.payments ?? []) as PaymentPosting[]).map((p) => [p.source_id, p]));
        const tasks: Array<() => Promise<void>> = [];
        for (const w of payments) {
          const posting = postings.get(w.payment.netsuite_id);
          if (!w.payment.companies.length && !posting?.current) continue;
          enqueue(tasks, w.number, decidePayment(w, posting), posting?.current ?? null,
            () => paymentJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds));
        }
        await runLimited(tasks, WRITERS);
        if (result.partial) break;
      }

      result.months!.push(month);
      state.resume = queue[i + 1] ?? null;
      await writeSyncStateCursor(service, BOOKS_INVOICE_POSTING, record());
    }

    if (skippedMonths.length) {
      notes.push(`${skippedWhy}, so no invoice or credit memo dated ${joined(skippedMonths.map(monthLabel), 'or')} was posted or changed this time.`);
    }
    if (leftTotal.length) {
      const one = leftTotal.length === 1;
      notes.push(`FleetSuite's ${one ? 'entry' : 'entries'} for ${documents(leftTotal.map((l) => l.kind))} ${one ? "doesn't come to its total" : "don't come to their totals"}, `
        + `so whatever FleetSuite holds for ${one ? 'it' : 'them'} stayed as it is: ${listed(leftTotal.map((l) => l.number))}. `
        + `Either the ${one ? 'copy was' : 'copies were'} caught mid-refresh, and the next run looks again, or the rule leaves out a line `
        + 'NetSuite posts, which Invoices vs NetSuite shows.');
    }
    if (missingAccounts.size) {
      notes.push(`NetSuite account${missingAccounts.size === 1 ? '' : 's'} ${listed([...missingAccounts])} ${missingAccounts.size === 1 ? "isn't" : "aren't"} `
        + 'in the chart of accounts yet, so invoices, credit memos and payments posting there weren\'t posted. Sync now on the chart of accounts page copies them.');
    }
  } catch (err) {
    result.error = String((err as any)?.message || err).slice(0, 300);
  } finally {
    if (!claim.error) {
      const released = await service.rpc('gl_netsuite_release_copy', { p_holder: holder });
      if (released.error) console.error('[books] could not release the books lock after posting:', released.error.message);
    }
  }

  if (!result.failed!.length) delete result.failed;
  const heartbeat = await recordHeartbeat(service, BOOKS_INVOICE_POSTING, record(), {
    startedAt,
    records: (result.posted ?? 0) + (result.replaced ?? 0) + (result.reversed ?? 0),
    touchLastSyncedAt: !result.partial && !result.error,
  });
  return { ...result, ...(notes.length ? { notes } : {}), heartbeat };
}
