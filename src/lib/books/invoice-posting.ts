import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { compactSuiteqlError } from '@/lib/sales-order-sync';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { writeSyncStateCursor } from '@/lib/ledger/write';
import { fetchAllRows } from '@/lib/fetch-all';
import {
  centsToAmount, failureReason, postEntry, repostEntry, reverseEntry,
  type BooksCompany, type JournalEntryInput,
} from './journal';
import { BOOKS_GL_SYNC, COPY_FROM, monthOfDate, monthsBetween } from './netsuite-gl';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { MAIN_LINE, RULES, type RuleLine, type SalesDocKind } from './invoice-rule';
import {
  centsOf, entryDate, workOutMonth,
  type ChartAccount, type InvoiceBooks, type InvoiceMonthData, type ItemAccountCount, type LineFacts,
  type LineFactsRead, type TaxAccountCount, type WorkedInvoice,
} from './invoice-check';
import { readLineFacts } from './invoice-line-facts';
import { PAYMENT_RULE, RECEIVABLE_LINE } from './payment-rule';
import { workOutPaymentMonth, type PaymentMonthData, type WorkedPayment } from './payment-check';
import { DEPOSIT_RULE, DEPOSIT_SOURCE_TYPE, DEPOSITS_LINE, type DepositSourceType } from './deposit-rule';
import { workOutDepositMonth, type DepositMonthData, type WorkedDeposit } from './deposit-check';
import { BILL_RULE, BILL_SOURCE_TYPE, PAYABLES_LINE, type BillSourceType } from './bill-rule';
import { itemsWithoutAccount, workOutBillMonth, type BillMonthData, type WorkedBill } from './bill-check';
import { BILL_PAYMENT_RULE, BILL_PAYMENT_SOURCE_TYPE, PAID_FROM_LINE } from './bill-payment-rule';
import { workOutBillPaymentMonth, type BillPaymentMonthData, type WorkedBillPayment } from './bill-payment-check';
import { REFUND_TYPES, SPENDING_RULE, SPENDING_SOURCE_TYPE, type SpendingSourceType } from './spending-rule';
import { workOutSpendingMonth, type WorkedSpending } from './spending-check';
import { readSpendingMonth } from './netsuite-spending';
import { JOURNAL_ENTRY_RULE, JOURNAL_ENTRY_SOURCE_TYPE, type JournalRuleLine } from './journal-entry-rule';
import { workOutJournalMonth, type JournalMonthData, type WorkedJournalEntry, type WorkedLedgerCopy } from './journal-entry-check';
import { BANK_RULE, BANK_SOURCE_TYPE, type BankSourceType } from './bank-rule';
import { workOutBankMonth, type BankMonthData, type WorkedBankDocument } from './bank-check';
import { STOCK_RULE, STOCK_SOURCE_TYPE, type StockSourceType } from './stock-rule';
import { workOutStockMonth, type StockMonthData, type WorkedStockDocument } from './stock-check';
import { OWN_COMPANY } from './own-invoices';
import { OWN_INVOICE_RULE, ownCopyDays, ownPick, readOwnCopies, salesTaxAccount, type OwnCopies, type OwnPick } from './own-invoice-posting';
import { chartNames, ownStockPick, ownStockRule, readOwnStockCopies, readOwnStockSince, THEIRS, type OwnStockEntry, type OwnStockPick } from './own-stock-posting';
import type { CopiesThrough } from './own-fulfillment-check';
import type { BillCopiesThrough } from './own-bill-check';
import { OWN_BILL_RULE, ownBillPick, readOwnBillCopies, readOwnBillSince, type OwnBillCopies, type OwnBillEntry, type OwnBillPick } from './own-bill-posting';
import { BOOKS_STOCK_SYNC } from './netsuite-stock';
import { BOOKS_BILLS_SYNC } from './netsuite-bills';
import { postOpeningEntries } from './going-live';
import { centralDate } from './mistake-checks';
import { readClosedMonths } from './months';

/**
 * NetSuite's invoices posted to FleetSuite's own journal with the invoice
 * rule (migration 367, docs/books.md "Posting invoices"; owner decision
 * 2026-10-13, thread "Replacing NetSuite with FleetSuite"), and its credit
 * memos with the credit memo rule, the same the other way round (migration
 * 370; owner decision 2026-10-14). Everything below that says invoice holds
 * for a credit memo too, for a customer payment, posted with the payment
 * rule (migration 376; owner decision 2026-10-15), for a customer deposit or
 * deposit application, posted with the deposit rule (migration 383; owner
 * decision 2026-10-15), for a vendor bill or bill credit, posted with the
 * bill rule (migration 386; owner decision 2026-10-16), for a bill
 * payment, posted with the bill payment rule (migration 390; owner decision
 * 2026-10-16), for a check, credit card charge or credit card refund,
 * posted with the spending rule (migration 392; owner decision 2026-10-16),
 * for a NetSuite journal entry, posted as NetSuite's GL copy has it
 * (migration 393; owner decision 2026-10-17), for a NetSuite bank deposit,
 * transfer or customer refund, posted the same way (migrations 394 and 399;
 * owner decisions 2026-10-17 and 2026-10-18), and for a NetSuite document
 * that moves stock or books its cost, an item fulfillment, item receipt,
 * inventory adjustment or transfer, assembly build or unbuild, or an
 * invoice's or credit memo's cost lines, posted the same way too (migration
 * 395; owner decision 2026-10-17),
 * except where the payments', deposits', bills', bill payments', checks' and
 * journal entries' own sections say otherwise.
 *
 * Every invoice of BMG's and 1084's (POSTING_COMPANIES) NetSuite booked into
 * a month from January 2025 that the rule can work out posts once, for its
 * company and under a key of that company's (entryKey), as the check on
 * Invoices vs NetSuite shows it, whether it matches NetSuite or not: during
 * 2027 the differences are what the side-by-side run is for. It posts in the
 * month NetSuite booked it to, whatever its own date (entryDate; migration
 * 380), so an invoice dated before the books start that NetSuite carried into
 * January 2025 posts on January 1. Each run (/api/cron/books-invoice-posting
 * at :48 on odd hours, and "Post now" on that page) goes through every
 * company's months again, BMG's then 1084's:
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
 * A month whose invoice lines NetSuite couldn't be asked about has its
 * invoices and credit memos left as they are, since their entries could come
 * out different without those answers. The
 * run takes the NetSuite GL copy's lock: it reads that copy, so it never runs
 * while the copy is changing it, and two runs never overlap.
 *
 * An invoice FleetSuite made posts from FleetSuite's own copy of it instead
 * (own_invoice@1, src/lib/books/own-invoice-posting.ts; migration 409; owner
 * decision 2026-10-19, "Post own invoices") when the copy matches NetSuite's
 * invoice and makes the same entry: the run reads the copies along with the
 * month's invoices, and an invoice that changes copies has its entry
 * replaced, as when NetSuite changes it. A fulfillment FleetSuite made, a
 * Receive NetSuite took and a bill FleetSuite made post from Books' own
 * copies the same way (own_fulfillment@1, own_receipt@1 and own_bill@1,
 * src/lib/books/own-stock-posting.ts and own-bill-posting.ts; migration 456;
 * owner decision 2026-10-30, "Own postings").
 *
 * Until a company's books go live, the journal can be emptied and posted
 * again (gl_reset_journal). Nothing is written to NetSuite.
 *
 * The run is recorded in sync_state as 'books_invoice_posting' and left out
 * of HEALTH_MONITORS like the other books jobs; no amount goes in that
 * record, a log line or the cron's response.
 */

export const BOOKS_INVOICE_POSTING = 'books_invoice_posting';

/**
 * The companies whose invoices, credit memos, payments, deposits, bills, bill payments, checks, card charges, journal entries,
 * bank deposits, transfers, customer refunds and stock documents post. 1084's joined once its journal entries, the only kind
 * of document Differences vs NetSuite showed for it, matched NetSuite (owner decision 2026-10-18, "1084's books").
 */
export const POSTING_COMPANIES: readonly BooksCompany[] = ['BMG', '1084'];

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
  /**
   * The vendor on a bill's, bill payment's, journal entry's, bank deposit's, transfer's, customer refund's or stock document's
   * payables line (gl_bill_postings, gl_bill_payment_postings, gl_journal_postings, gl_bank_postings and gl_stock_postings,
   * migrations 386, 390, 393, 394, 395 and 399; gl_spending_postings, migration 392, gives none); the other documents' reads leave
   * it out.
   */
  vendor_ref?: string | null;
}

/** What the journal holds for one invoice or credit memo (gl_invoice_postings, migrations 367, 370 and 409). */
export interface InvoicePosting {
  source_type: SalesDocKind;
  source_id: string;
  /** How many entries it has had. */
  entries: number;
  /** Its entries nothing reversed, newest first: normally just the one that stands. */
  unreversed: string[];
  /**
   * `posting_rule` is the rule that made it: invoice@1 or credit_memo@1 from NetSuite's copy, own_invoice@1 from FleetSuite's
   * (migration 409); for a stock document or bill, stock@1 or bill@1 from NetSuite's, own_fulfillment@1, own_receipt@1 or
   * own_bill@1 from Books' own copy (migration 456).
   */
  current: { id: string; entry_no: number; entry_date: string; posting_rule?: string; lines?: PostedLine[] | null } | null;
  history: Array<{ entry_no: number; entry_date: string; reversed_by: number | null }>;
  /** What the copy of NetSuite's invoices says of it; null when the copy has none. */
  invoice: { number: string | null; deleted: boolean; voided: boolean } | null;
}

// ── Deciding ───────────────────────────────────────────────────────────────

/** Which kind of document it is: anything but a credit memo is an invoice. */
const kindOf = (worked: WorkedInvoice): SalesDocKind => (worked.invoice.doc_type === 'credit_memo' ? 'credit_memo' : 'invoice');

/** What the journal holds for a document is looked up by its kind (its entries' source type) and NetSuite id, as its entries name it. */
export const postingKey = (kind: string, netsuiteId: string) => `${kind}:${netsuiteId}`;

/**
 * The idempotency key of a document's `generation`th entry: its kind (the entry's source type), NetSuite id and
 * generation, `invoice:<NetSuite id>:<n>`. The journal takes each key once whatever the company, so a company other
 * than BMG puts its code in front, `1084:journal_entry:<NetSuite id>:<n>`, and a document with lines for both companies
 * posts once for each. BMG's keep the form they had, so nothing it has posted changes.
 */
const entryKey = (company: BooksCompany, kind: string, netsuiteId: string, generation: number) =>
  `${company === 'BMG' ? '' : `${company}:`}${kind}:${netsuiteId}:${generation}`;

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
  vendorRef?: string | null;
}

/**
 * What an entry says, as text two entries can be compared by: its date and
 * each line's account, amount, division, document line, customer and
 * vendor. Memos and item numbers only describe, so a rename doesn't re-post
 * anything.
 */
export function signature(date: string, lines: SignatureLine[]): string {
  const keyed = lines.map((l) => [l.account, l.cents, l.division ?? '', l.lineRef ?? '', l.customerId ?? '', l.vendorRef ?? ''].join('|'));
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
    vendorRef: l.vendor_ref ?? null,
  })),
);

const workedSignature = (worked: WorkedInvoice) => signature(
  entryDate(worked.invoice),
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
  /** What stands is right, or nothing stands and nothing should, `why` then saying why: NetSuite voided it, or it comes to nothing. */
  | { kind: 'keep'; why?: 'voided' | 'nothing' }
  /**
   * Whatever stands stays: the rule can't work it out yet, its lines aren't
   * copied yet, or they don't add up to its total in the copy (caught
   * mid-refresh). The next run looks again.
   */
  | { kind: 'leave'; why: 'unworkable' | 'waiting' | 'total' };

/**
 * What a decision comes to once the company's books are live (src/lib/books/going-live.ts), given the date of the
 * entry that stands for the document: the books take nothing dated before the day they went live but opening entries
 * (migration 359), so an entry dated before it stays as it is, and the opening entry trues up what NetSuite has changed
 * of it since. The document posts afresh when NetSuite books it into a month since, in place of replacing that entry.
 */
export function liveDecision(d: Decision, current: { entry_date: string } | null, liveFrom: string | null): Decision {
  if (!liveFrom || !current || current.entry_date >= liveFrom) return d;
  if (d.kind === 'reverse') return { kind: 'keep' };
  if (d.kind === 'replace') return { kind: 'post' };
  return d;
}

/** The dates of a document's entries that nothing reversed, newest first, as its `unreversed` lists them. */
export const standingDates = (p: Pick<InvoicePosting, 'history'>) => (p.history ?? [])
  .filter((h) => h.reversed_by == null)
  .sort((a, b) => b.entry_no - a.entry_no)
  .map((h) => h.entry_date);

/** The receivable's customer and the lines of FleetSuite's own copy's entry, as signature compares them. */
const ownSignature = (entry: NonNullable<OwnPick['entry']>) => signature(
  entry.date,
  entry.lines.map((l) => ({
    account: l.account,
    cents: l.cents,
    division: l.division,
    lineRef: l.lineId,
    customerId: l.lineId === MAIN_LINE ? entry.customerId : null,
  })),
);

/**
 * What to do about one invoice the rule has worked out, given what the journal holds for it and, when FleetSuite has
 * its own copy of it, what the books post for that (ownPick): the copy's entry when it posts, otherwise NetSuite's. An
 * entry made by the other copy's rule is replaced.
 */
export function decide(worked: WorkedInvoice, posting: InvoicePosting | undefined, own?: OwnPick | null): Decision {
  const current = posting?.current ?? null;
  if (worked.invoice.voided) return current ? { kind: 'reverse', why: 'voided' } : { kind: 'keep', why: 'voided' };
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

  if (lines.length === 0) return current ? { kind: 'reverse', why: 'nothing' } : { kind: 'keep', why: 'nothing' };
  if (!current) return { kind: 'post' };
  const entry = own?.entry ?? null;
  if (current.posting_rule && current.posting_rule !== (entry ? OWN_INVOICE_RULE : RULES[kindOf(worked)])) return { kind: 'replace' };
  return postedSignature(current) === (entry ? ownSignature(entry) : workedSignature(worked)) ? { kind: 'keep' } : { kind: 'replace' };
}

/**
 * Why a document's entry is replaced, for the memo of the entry reversing it: it changes copies, from NetSuite's
 * document (`theirs`, in words) to its own copy, which posts with `ownRule`, or back; or NetSuite changed it.
 */
function switchedMemo(number: string, current: { posting_rule?: string } | null, toOwn: boolean, ownRule: string, theirs: string): string {
  if (current?.posting_rule && (current.posting_rule === ownRule) !== toOwn) {
    return `${number} now posts from ${toOwn ? "FleetSuite's own copy" : theirs}`;
  }
  return `${number} changed in NetSuite`;
}

/**
 * Why an invoice's entry is replaced, for the memo of the entry reversing it: it changes copies (decide), or NetSuite
 * changed it.
 */
export function replaceMemo(number: string, current: { posting_rule?: string } | null, own?: OwnPick | null): string {
  return switchedMemo(number, current, !!own?.entry, OWN_INVOICE_RULE, "NetSuite's invoice");
}

/** Why a bill's entry is replaced, as for an invoice's (decideBill). */
export function replaceBillMemo(worked: WorkedBill, current: { posting_rule?: string } | null, own?: OwnBillPick | null): string {
  return switchedMemo(worked.number, current, !!own?.entry, OWN_BILL_RULE, "NetSuite's bill");
}

/** Why a stock document's entry is replaced, as for an invoice's (decideStockDocument): only a fulfillment, receipt or adjustment changes copies. */
export function replaceStockMemo(worked: WorkedStockDocument, current: { posting_rule?: string } | null, own?: OwnStockPick | null): string {
  const rule = ownStockRule(worked.entry.type);
  if (!rule) return `${worked.number} changed in NetSuite`;
  return switchedMemo(worked.number, current, !!own?.entry, rule, `NetSuite's ${THEIRS[worked.entry.type]}`);
}

/** What NetSuite wouldn't say about a month's invoice lines that the entries depend on; a run leaves such a month alone. */
export function unsaidFacts(facts: LineFactsRead): Array<(typeof NEEDED_FACTS)[number]> {
  return NEEDED_FACTS.filter((f) => facts.missing.includes(f.fact));
}

/**
 * What the journal holds for an invoice and what the next run does about
 * it, for the invoices page. `decides` is false when NetSuite couldn't say
 * enough about the month's lines: the run would leave the month alone, so
 * nothing is shown as next. `own` is what the books post for FleetSuite's
 * own copy of it, when there's one (ownPick).
 */
export function invoiceBooks(worked: WorkedInvoice, posting: InvoicePosting | undefined, decides = true, own?: OwnPick | null): InvoiceBooks {
  return copyBooks(booksOf(decide(worked, posting, own), posting, decides), posting?.current?.posting_rule, OWN_INVOICE_RULE, own);
}

/**
 * What the journal holds for a document and what the next run does about
 * it, given the run's decision, and whether it has nothing to post.
 */
function booksOf(d: Decision, posting: Pick<InvoicePosting, 'current' | 'history'> | undefined, decides: boolean): InvoiceBooks {
  const current = posting?.current ?? null;
  return {
    entryNo: current?.entry_no ?? null,
    next: decides && (d.kind === 'post' || d.kind === 'replace' || d.kind === 'reverse') ? d.kind : null,
    earlier: (posting?.history ?? [])
      .filter((h) => h.entry_no !== current?.entry_no)
      .map((h) => ({ entryNo: h.entry_no, reversedBy: h.reversed_by })),
    ...(d.kind === 'keep' && d.why ? { nothingToPost: d.why === 'voided' ? 'voided' as const : 'zero' as const } : {}),
  };
}

/**
 * Which copy the entry that stands for a document was made from, given its rule and the rule of Books' own copies of
 * its kind, and what the books post for its own copy when there's one, for the invoices page.
 */
function copyBooks(
  books: InvoiceBooks,
  rule: string | undefined,
  ownRule: string | null,
  own: { entry: unknown; why: string | null; receiptKey?: string; adjustmentId?: string } | null | undefined,
): InvoiceBooks {
  return {
    ...books,
    ...(rule ? { from: rule === ownRule ? 'fleetsuite' as const : 'netsuite' as const } : {}),
    ...(own ? {
      own: {
        posts: !!own.entry,
        ...(own.why ? { why: own.why } : {}),
        ...(own.receiptKey ? { receiptKey: own.receiptKey } : {}),
        ...(own.adjustmentId ? { adjustmentId: own.adjustmentId } : {}),
      },
    } : {}),
  };
}

/**
 * The journal entry for an invoice or credit memo, its `generation`th: the
 * rule's lines on the chart's accounts, the receivable carrying the customer,
 * keyed by its kind (`invoice:…`, `credit_memo:…`). With `own`, the entry of
 * FleetSuite's own copy of the invoice instead (own_invoice@1), under the
 * same key. Null with the NetSuite accounts the chart doesn't have when it
 * can't be built.
 */
export function invoiceJournalEntry(
  worked: WorkedInvoice,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
  own?: OwnPick['entry'],
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  const lines = own ? own.lines : entryLines(worked);
  const missing = [...new Set(lines.map((l) => l.account).filter((a) => !accountIds.has(a)))];
  if (missing.length) return { entry: null, missing };
  const inv = worked.invoice;
  const kind = kindOf(worked);
  const customerId = own ? own.customerId : inv.customer_id ?? null;
  return {
    entry: {
      company,
      entryDate: own ? own.date : entryDate(inv),
      sourceType: kind,
      sourceId: inv.netsuite_id,
      postingRule: own ? OWN_INVOICE_RULE : RULES[kind],
      idempotencyKey: entryKey(company, kind, inv.netsuite_id, generation),
      memo: inv.customer ? `${worked.number}, ${inv.customer}` : worked.number,
      postedBy: null,
      lines: lines.map((l) => ({
        accountId: accountIds.get(l.account)!,
        debit: l.cents > 0 ? centsToAmount(l.cents) : null,
        credit: l.cents < 0 ? centsToAmount(-l.cents) : null,
        division: l.division,
        itemNumber: l.itemNumber,
        sourceLineRef: l.lineId,
        customerId: l.lineId === MAIN_LINE ? customerId : null,
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
  if (worked.payment.voided) return current ? { kind: 'reverse', why: 'voided' } : { kind: 'keep', why: 'voided' };
  const { status } = worked.checked;
  if (status === 'waiting') return { kind: 'leave', why: 'waiting' };
  if (status === 'unworkable') return { kind: 'leave', why: 'unworkable' };
  if (paymentEntryLines(worked).length === 0) return current ? { kind: 'reverse', why: 'nothing' } : { kind: 'keep', why: 'nothing' };
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
      idempotencyKey: entryKey(company, 'payment', p.netsuite_id, generation),
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

// ── Deposits ───────────────────────────────────────────────────────────────
//
// A customer deposit or deposit application posts as a payment does: no
// lines of its own to wait for or add up (its entry is worked out from its
// total with the deposit rule), what the journal holds for it from
// gl_deposit_postings (migration 383), keyed customer_deposit:<NetSuite
// id>:<n> or deposit_application:<NetSuite id>:<n>. Its customer goes on the
// customer deposits line, what BMG holds for the customer, and on an
// application's receivable, as on a payment's.

/** What the journal holds for one customer deposit or deposit application (gl_deposit_postings, migration 383). */
export interface DepositPosting extends Omit<InvoicePosting, 'source_type' | 'invoice'> {
  source_type: DepositSourceType;
  /** What the copy of NetSuite's deposits says of it now, deleted when NetSuite no longer lists it; null when the copy has none. */
  deposit: { number: string | null; deleted: boolean; voided: boolean } | null;
}

/** What the journal holds for a worked out deposit or application, from gl_deposit_postings' answer keyed by postingKey. */
export const depositPostingFor = (postings: Map<string, DepositPosting>, worked: WorkedDeposit) =>
  postings.get(postingKey(DEPOSIT_SOURCE_TYPE[worked.deposit.type], worked.deposit.netsuite_id));

/** The lines the deposit rule works out for a deposit or application; none when it posts nothing. */
export function depositEntryLines(worked: WorkedDeposit): RuleLine[] {
  return worked.checked.rows.flatMap((r) => (r.fleetsuite && r.fleetsuite.cents !== 0
    ? [{ account: r.fleetsuite.account, cents: r.fleetsuite.cents, lineId: r.lineId, itemNumber: null, division: null }]
    : []));
}

/** The customer a line of a deposit's or application's entry carries: on the customer deposits line and the receivable. */
const depositCustomer = (worked: WorkedDeposit, lineId: string) =>
  (lineId === DEPOSITS_LINE || lineId === RECEIVABLE_LINE ? worked.deposit.customer_id ?? null : null);

const depositSignature = (worked: WorkedDeposit) => signature(
  worked.deposit.date,
  depositEntryLines(worked).map((l) => ({
    account: l.account,
    cents: l.cents,
    division: null,
    lineRef: l.lineId,
    customerId: depositCustomer(worked, l.lineId),
  })),
);

/** What to do about one deposit or application the rule has worked out, given what the journal holds for it. */
export function decideDeposit(worked: WorkedDeposit, posting: DepositPosting | undefined): Decision {
  const current = posting?.current ?? null;
  if (worked.deposit.voided) return current ? { kind: 'reverse', why: 'voided' } : { kind: 'keep', why: 'voided' };
  const { status } = worked.checked;
  if (status === 'waiting') return { kind: 'leave', why: 'waiting' };
  if (status === 'unworkable') return { kind: 'leave', why: 'unworkable' };
  if (depositEntryLines(worked).length === 0) return current ? { kind: 'reverse', why: 'nothing' } : { kind: 'keep', why: 'nothing' };
  if (!current) return { kind: 'post' };
  return postedSignature(current) === depositSignature(worked) ? { kind: 'keep' } : { kind: 'replace' };
}

/** What the journal holds for a deposit or application and what the next run does about it, for the invoices page. */
export function depositBooks(worked: WorkedDeposit, posting: DepositPosting | undefined): InvoiceBooks {
  return booksOf(decideDeposit(worked, posting), posting, true);
}

/**
 * The journal entry for a deposit or application, its `generation`th: the
 * rule's lines on the chart's accounts, the customer deposits line and the
 * receivable carrying the customer, keyed `customer_deposit:…` or
 * `deposit_application:…`. Null with the NetSuite accounts the chart doesn't
 * have when it can't be built.
 */
export function depositJournalEntry(
  worked: WorkedDeposit,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  const lines = depositEntryLines(worked);
  const missing = [...new Set(lines.map((l) => l.account).filter((a) => !accountIds.has(a)))];
  if (missing.length) return { entry: null, missing };
  const d = worked.deposit;
  const sourceType = DEPOSIT_SOURCE_TYPE[d.type];
  return {
    entry: {
      company,
      entryDate: d.date,
      sourceType,
      sourceId: d.netsuite_id,
      postingRule: DEPOSIT_RULE,
      idempotencyKey: entryKey(company, sourceType, d.netsuite_id, generation),
      memo: d.customer ? `${worked.number}, ${d.customer}` : worked.number,
      postedBy: null,
      lines: lines.map((l) => ({
        accountId: accountIds.get(l.account)!,
        debit: l.cents > 0 ? centsToAmount(l.cents) : null,
        credit: l.cents < 0 ? centsToAmount(-l.cents) : null,
        division: null,
        itemNumber: null,
        sourceLineRef: l.lineId,
        customerId: depositCustomer(worked, l.lineId),
      })),
    },
    missing: [],
  };
}

// ── Bills ──────────────────────────────────────────────────────────────────
//
// A vendor bill or bill credit posts as an invoice does: in the month
// NetSuite booked it to (entryDate), from its copied lines, which must come
// to its total, line by line as the bill rule works them out. What the
// journal holds for it comes from gl_bill_postings (migration 386), keyed
// vendor_bill:<NetSuite id>:<n> or vendor_credit:<NetSuite id>:<n>. Its
// vendor goes on the payables line, what BMG owes the vendor, as the
// vendor's NetSuite id (vendor_ref). As for payments, one in neither
// company's GL copy is looked at only while an entry of it stands.

/** What the journal holds for one vendor bill or bill credit (gl_bill_postings, migration 386). */
export interface BillPosting extends Omit<InvoicePosting, 'source_type' | 'invoice'> {
  source_type: BillSourceType;
  /** What the copy of NetSuite's bills says of it now, deleted when NetSuite no longer lists it; null when the copy has none. */
  bill: { number: string | null; deleted: boolean; voided: boolean } | null;
}

/** What the journal holds for a worked out bill or bill credit, from gl_bill_postings' answer keyed by postingKey. */
export const billPostingFor = (postings: Map<string, BillPosting>, worked: WorkedBill) =>
  postings.get(postingKey(BILL_SOURCE_TYPE[worked.bill.type], worked.bill.netsuite_id));

/** The vendor a line of a bill's or bill credit's entry carries: on the payables line. */
const billVendor = (worked: WorkedBill, lineId: string) =>
  (lineId === PAYABLES_LINE ? worked.bill.vendor_netsuite_id ?? null : null);

const billSignature = (worked: WorkedBill) => signature(
  entryDate(worked.bill),
  worked.checked.lines.map((l) => ({
    account: l.account,
    cents: l.cents,
    division: null,
    lineRef: l.lineId,
    customerId: null,
    vendorRef: billVendor(worked, l.lineId),
  })),
);

/** The lines of Books' own copy's entry of a bill, as signature compares them: its vendor on payables. */
const ownBillSignature = (entry: OwnBillEntry) => signature(
  entry.date,
  entry.lines.map((l) => ({
    account: l.account,
    cents: l.cents,
    division: null,
    lineRef: l.lineId,
    customerId: null,
    vendorRef: l.lineId === PAYABLES_LINE ? entry.vendorRef : null,
  })),
);

/**
 * What to do about one bill or bill credit the rule has worked out, given what the journal holds for it and, when Books
 * has its own copy of it, what the books post for that (ownBillPick): the copy's entry when it posts, otherwise
 * NetSuite's. An entry made by the other copy's rule is replaced, as an invoice's is (decide).
 */
export function decideBill(worked: WorkedBill, posting: BillPosting | undefined, own?: OwnBillPick | null): Decision {
  const current = posting?.current ?? null;
  if (worked.bill.voided) return current ? { kind: 'reverse', why: 'voided' } : { kind: 'keep', why: 'voided' };
  const { status, lines } = worked.checked;
  if (status === 'waiting') return { kind: 'leave', why: 'waiting' };
  if (status === 'unworkable') return { kind: 'leave', why: 'unworkable' };

  // Payables are a bill's total as a credit, a bill credit's as a debit (the
  // copy keeps both totals unsigned), so lines that don't come to it are the
  // copy's lines caught mid-refresh, or taken the wrong way round, not the
  // document.
  const payables = lines.find((l) => l.lineId === PAYABLES_LINE)?.cents ?? 0;
  const total = centsOf(worked.bill.total);
  if (total === null || payables !== (worked.bill.type === 'VendCred' ? total : -total)) return { kind: 'leave', why: 'total' };

  if (lines.length === 0) return current ? { kind: 'reverse', why: 'nothing' } : { kind: 'keep', why: 'nothing' };
  if (!current) return { kind: 'post' };
  const entry = own?.entry ?? null;
  if (current.posting_rule && current.posting_rule !== (entry ? OWN_BILL_RULE : BILL_RULE)) return { kind: 'replace' };
  return postedSignature(current) === (entry ? ownBillSignature(entry) : billSignature(worked)) ? { kind: 'keep' } : { kind: 'replace' };
}

/**
 * What the journal holds for a bill or bill credit and what the next run does about it, for the invoices page. `own` is
 * what the books post for Books' own copy of it, when there's one (ownBillPick).
 */
export function billBooks(worked: WorkedBill, posting: BillPosting | undefined, own?: OwnBillPick | null): InvoiceBooks {
  return copyBooks(booksOf(decideBill(worked, posting, own), posting, true), posting?.current?.posting_rule, OWN_BILL_RULE, own);
}

/**
 * The journal entry for a bill or bill credit, its `generation`th: the
 * rule's lines on the chart's accounts, in the month NetSuite booked it to,
 * the payables line carrying the vendor, keyed `vendor_bill:…` or
 * `vendor_credit:…`. With `own`, the entry of Books' own copy of the bill
 * instead (own_bill@1), under the same key. Null with the NetSuite accounts
 * the chart doesn't have when it can't be built.
 */
export function billJournalEntry(
  worked: WorkedBill,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
  own?: OwnBillEntry | null,
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  const lines = own ? own.lines : worked.checked.lines;
  const missing = [...new Set(lines.map((l) => l.account).filter((a) => !accountIds.has(a)))];
  if (missing.length) return { entry: null, missing };
  const b = worked.bill;
  const sourceType = BILL_SOURCE_TYPE[b.type];
  const vendor = (lineId: string) => (own ? (lineId === PAYABLES_LINE ? own.vendorRef : null) : billVendor(worked, lineId));
  return {
    entry: {
      company,
      entryDate: own ? own.date : entryDate(b),
      sourceType,
      sourceId: b.netsuite_id,
      postingRule: own ? OWN_BILL_RULE : BILL_RULE,
      idempotencyKey: entryKey(company, sourceType, b.netsuite_id, generation),
      memo: b.vendor ? `${worked.number}, ${b.vendor}` : worked.number,
      postedBy: null,
      lines: lines.map((l) => ({
        accountId: accountIds.get(l.account)!,
        debit: l.cents > 0 ? centsToAmount(l.cents) : null,
        credit: l.cents < 0 ? centsToAmount(-l.cents) : null,
        division: null,
        itemNumber: l.itemNumber,
        sourceLineRef: l.lineId,
        vendorRef: vendor(l.lineId),
      })),
    },
    missing: [],
  };
}

/**
 * One company's vendor bills and bill credits for one month, as the bill
 * check takes them: gl_bill_month (migration 384), and where NetSuite posts
 * the bill lines of the items the copy of its items has no account for
 * (gl_bill_item_accounts, migration 385). The invoices page and the posting
 * job both read a month with it, so what the one shows is what the other
 * posts.
 */
export async function readBillMonth(service: SupabaseClient, company: string, month: string): Promise<BillMonthData> {
  const res = await service.rpc('gl_bill_month', { p_company: company, p_month: month });
  if (res.error) throw new Error(res.error.message);
  const data = (res.data ?? {}) as Partial<BillMonthData>;
  const items = data.items ?? [];
  const unplaced = itemsWithoutAccount(items);
  const placed = unplaced.length ? await service.rpc('gl_bill_item_accounts', { p_items: unplaced }) : null;
  if (placed?.error) throw new Error(placed.error.message);
  return {
    bills: data.bills ?? [],
    items,
    receipt_accounts: data.receipt_accounts ?? [],
    not_copied: data.not_copied ?? [],
    item_accounts: (placed?.data ?? []) as NonNullable<BillMonthData['item_accounts']>,
  };
}

// ── Bill payments ──────────────────────────────────────────────────────────
//
// A bill payment posts as a bill does, in the month NetSuite booked it to
// (entryDate), and as a customer payment does, with no lines of its own to
// wait for or add up: its entry is worked out from its total and NetSuite's
// posting of it with the bill payment rule. What the journal holds for it
// comes from gl_bill_payment_postings (migration 390), keyed
// bill_payment:<NetSuite id>:<n>. Its vendor goes on the payables line, as a
// bill's does. As for payments, one in neither company's GL copy is looked
// at only while an entry of it stands.
//
// One NetSuite voided posts all the same while NetSuite's GL still books it:
// NetSuite voids a bill payment by keeping its lines and booking a journal
// entry that takes them back (seen 2026-10-17), which posts with the journal
// entries, so the two come to nothing together as they do in NetSuite. Only
// one whose void took its lines away has its entry reversed, by its month's
// decision rather than in step 1, since only the month's read has its lines.

/**
 * Whether NetSuite's GL still books a document: its lines come to something
 * on some account. A void that kept them is taken back by a journal entry of
 * its own.
 */
const stillBooked = (lines: ReadonlyArray<{ account: string; debit: string; credit: string }>) => {
  const byAccount = new Map<string, number>();
  for (const l of lines) byAccount.set(l.account, (byAccount.get(l.account) ?? 0) + (centsOf(l.debit) ?? 0) - (centsOf(l.credit) ?? 0));
  return [...byAccount.values()].some((cents) => cents !== 0);
};

/** What the journal holds for one bill payment (gl_bill_payment_postings, migration 390). */
export interface BillPaymentPosting extends Omit<InvoicePosting, 'source_type' | 'invoice'> {
  source_type: typeof BILL_PAYMENT_SOURCE_TYPE;
  /** What the copy of NetSuite's bill payments says of it now, deleted when NetSuite no longer lists it; null when the copy has none. */
  payment: { number: string | null; deleted: boolean; voided: boolean } | null;
}

/** The vendor a line of a bill payment's entry carries: on the payables line. */
const billPaymentVendor = (worked: WorkedBillPayment, lineId: string) =>
  (lineId === PAYABLES_LINE ? worked.payment.vendor_netsuite_id ?? null : null);

const billPaymentSignature = (worked: WorkedBillPayment) => signature(
  entryDate(worked.payment),
  worked.checked.lines.map((l) => ({
    account: l.account,
    cents: l.cents,
    division: null,
    lineRef: l.lineId,
    customerId: null,
    vendorRef: billPaymentVendor(worked, l.lineId),
  })),
);

/** What to do about one bill payment the rule has worked out, given what the journal holds for it. */
export function decideBillPayment(worked: WorkedBillPayment, posting: BillPaymentPosting | undefined): Decision {
  const current = posting?.current ?? null;
  if (worked.payment.voided && !stillBooked(worked.payment.netsuite)) {
    return current ? { kind: 'reverse', why: 'voided' } : { kind: 'keep', why: 'voided' };
  }
  const { status, lines } = worked.checked;
  if (status === 'waiting') return { kind: 'leave', why: 'waiting' };
  if (status === 'unworkable') return { kind: 'leave', why: 'unworkable' };
  if (lines.length === 0) return current ? { kind: 'reverse', why: 'nothing' } : { kind: 'keep', why: 'nothing' };
  if (!current) return { kind: 'post' };
  return postedSignature(current) === billPaymentSignature(worked) ? { kind: 'keep' } : { kind: 'replace' };
}

/** What the journal holds for a bill payment and what the next run does about it, for the invoices page. */
export function billPaymentBooks(worked: WorkedBillPayment, posting: BillPaymentPosting | undefined): InvoiceBooks {
  return booksOf(decideBillPayment(worked, posting), posting, true);
}

/**
 * The journal entry for a bill payment, its `generation`th: the rule's lines
 * on the chart's accounts, in the month NetSuite booked it to, the payables
 * line carrying the vendor, keyed `bill_payment:…`. Null with the NetSuite
 * accounts the chart doesn't have when it can't be built.
 */
export function billPaymentJournalEntry(
  worked: WorkedBillPayment,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  const { lines } = worked.checked;
  const missing = [...new Set(lines.map((l) => l.account).filter((a) => !accountIds.has(a)))];
  if (missing.length) return { entry: null, missing };
  const p = worked.payment;
  return {
    entry: {
      company,
      entryDate: entryDate(p),
      sourceType: BILL_PAYMENT_SOURCE_TYPE,
      sourceId: p.netsuite_id,
      postingRule: BILL_PAYMENT_RULE,
      idempotencyKey: entryKey(company, BILL_PAYMENT_SOURCE_TYPE, p.netsuite_id, generation),
      memo: p.vendor ? `${worked.number}, ${p.vendor}` : worked.number,
      postedBy: null,
      lines: lines.map((l) => ({
        accountId: accountIds.get(l.account)!,
        debit: l.cents > 0 ? centsToAmount(l.cents) : null,
        credit: l.cents < 0 ? centsToAmount(-l.cents) : null,
        division: null,
        itemNumber: null,
        sourceLineRef: l.lineId,
        vendorRef: billPaymentVendor(worked, l.lineId),
      })),
    },
    missing: [],
  };
}

// ── Checks and card charges ────────────────────────────────────────────────
//
// A check, credit card charge or credit card refund posts as a bill does, in
// the month NetSuite booked it to (entryDate), from its copied lines, which
// must come to its total, with the account the money comes out of in place of
// payables. What the journal holds for it comes from gl_spending_postings
// (migration 392), keyed check:<NetSuite id>:<n>, card_charge:… or
// card_refund:…. No line carries a vendor, as nothing is owed on one; its
// payee is in the entry's memo. As for payments, one in neither company's GL
// copy is looked at only while an entry of it stands, and one NetSuite voided
// posts as a voided bill payment does.

/** What the journal holds for one check, card charge or card refund (gl_spending_postings, migration 392). */
export interface SpendingPosting extends Omit<InvoicePosting, 'source_type' | 'invoice'> {
  source_type: SpendingSourceType;
  /** What the copy of NetSuite's checks and card charges and refunds says of it now, deleted when NetSuite no longer lists it; null when the copy has none. */
  document: { number: string | null; deleted: boolean; voided: boolean } | null;
}

/** What the journal holds for a worked out check, card charge or card refund, from gl_spending_postings' answer keyed by postingKey. */
export const spendingPostingFor = (postings: Map<string, SpendingPosting>, worked: WorkedSpending) =>
  postings.get(postingKey(SPENDING_SOURCE_TYPE[worked.doc.type], worked.doc.netsuite_id));

const spendingSignature = (worked: WorkedSpending) => signature(
  entryDate(worked.doc),
  worked.checked.lines.map((l) => ({ account: l.account, cents: l.cents, division: null, lineRef: l.lineId, customerId: null })),
);

/** What to do about one check, card charge or card refund the rule has worked out, given what the journal holds for it. */
export function decideSpending(worked: WorkedSpending, posting: SpendingPosting | undefined): Decision {
  const current = posting?.current ?? null;
  if (worked.doc.voided && !stillBooked(worked.doc.netsuite)) {
    return current ? { kind: 'reverse', why: 'voided' } : { kind: 'keep', why: 'voided' };
  }
  const { status, lines } = worked.checked;
  if (status === 'waiting') return { kind: 'leave', why: 'waiting' };
  if (status === 'unworkable') return { kind: 'leave', why: 'unworkable' };

  // The account the money comes out of is credited with a check's or a charge's total and debited with a refund's
  // (the copy keeps totals unsigned), so lines that don't come to it are the copy's lines caught mid-refresh, or
  // taken the wrong way round, not the document.
  const paidFrom = lines.find((l) => l.lineId === PAID_FROM_LINE)?.cents ?? 0;
  const total = centsOf(worked.doc.total);
  if (total === null || paidFrom !== (REFUND_TYPES.has(worked.doc.type) ? total : -total)) return { kind: 'leave', why: 'total' };

  if (lines.length === 0) return current ? { kind: 'reverse', why: 'nothing' } : { kind: 'keep', why: 'nothing' };
  if (!current) return { kind: 'post' };
  return postedSignature(current) === spendingSignature(worked) ? { kind: 'keep' } : { kind: 'replace' };
}

/** What the journal holds for a check, card charge or card refund and what the next run does about it, for the invoices page. */
export function spendingBooks(worked: WorkedSpending, posting: SpendingPosting | undefined): InvoiceBooks {
  return booksOf(decideSpending(worked, posting), posting, true);
}

/**
 * The journal entry for a check, card charge or card refund, its
 * `generation`th: the rule's lines on the chart's accounts, in the month
 * NetSuite booked it to, keyed `check:…`, `card_charge:…` or `card_refund:…`.
 * Null with the NetSuite accounts the chart doesn't have when it can't be
 * built.
 */
export function spendingJournalEntry(
  worked: WorkedSpending,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  const { lines } = worked.checked;
  const missing = [...new Set(lines.map((l) => l.account).filter((a) => !accountIds.has(a)))];
  if (missing.length) return { entry: null, missing };
  const d = worked.doc;
  const sourceType = SPENDING_SOURCE_TYPE[d.type];
  return {
    entry: {
      company,
      entryDate: entryDate(d),
      sourceType,
      sourceId: d.netsuite_id,
      postingRule: SPENDING_RULE,
      idempotencyKey: entryKey(company, sourceType, d.netsuite_id, generation),
      memo: d.payee ? `${worked.number}, ${d.payee}` : worked.number,
      postedBy: null,
      lines: lines.map((l) => ({
        accountId: accountIds.get(l.account)!,
        debit: l.cents > 0 ? centsToAmount(l.cents) : null,
        credit: l.cents < 0 ? centsToAmount(-l.cents) : null,
        division: null,
        itemNumber: l.itemNumber,
        sourceLineRef: l.lineId,
      })),
    },
    missing: [],
  };
}

// ── Journal entries, bank deposits, transfers and refunds, stock ───────────
//
// A NetSuite journal entry posts as a bill does, in the month NetSuite booked
// it to (entryDate), but has nothing to work out or wait for: its lines for
// the company, as the copy of NetSuite's GL (migration 361) has them, are its
// entry, each with its memo and name, a receivables line carrying its
// customer and a payables line its vendor. What the journal holds for it
// comes from gl_journal_postings (migration 393), keyed
// journal_entry:<NetSuite id>:<n>. It is the company's while the GL copy
// holds a line of it for the company, so one the copy no longer has for it
// (deleted in NetSuite, or moved to the other company) has its entry reversed
// with the deleted documents.
//
// A NetSuite bank deposit, transfer or customer refund posts the same way,
// line for line from the GL copy (bank@1, migrations 394 and 399), keyed
// bank_deposit:<NetSuite id>:<n>, bank_transfer:<NetSuite id>:<n> or
// customer_refund:<NetSuite id>:<n>, with what the journal holds for it from
// gl_bank_postings.
//
// And so does a NetSuite document that moves stock or books its cost (stock@1,
// migration 395), keyed by its STOCK_SOURCE_TYPE, item_fulfillment:<NetSuite
// id>:<n> and so on, with what the journal holds for it from
// gl_stock_postings. An invoice's or credit memo's lines there are only its
// cost lines, filed as invoice_cost apart from the entry for the sale; one
// that books no cost now has that entry reversed with the deleted documents,
// saying so.

/** What the journal holds for one NetSuite journal entry (gl_journal_postings, migration 393). */
export interface JournalEntryPosting extends Omit<InvoicePosting, 'source_type' | 'invoice'> {
  source_type: typeof JOURNAL_ENTRY_SOURCE_TYPE;
  /** What the copy of NetSuite's GL says of it now: its number, and deleted when the copy holds no line of it for the company. */
  journal: { number: string | null; deleted: boolean } | null;
}

/** What the journal holds for one NetSuite bank deposit, transfer or customer refund (gl_bank_postings, migrations 394 and 399). */
export interface BankPosting extends Omit<InvoicePosting, 'source_type' | 'invoice'> {
  source_type: BankSourceType;
  /** What the copy of NetSuite's GL says of it now: its number, and deleted when the copy holds no line of it for the company. */
  document: { number: string | null; deleted: boolean } | null;
}

/** What the journal holds for a bank deposit, transfer or refund, from gl_bank_postings' answer keyed by postingKey. */
export const bankPostingFor = (postings: Map<string, BankPosting>, worked: WorkedBankDocument) =>
  postings.get(postingKey(BANK_SOURCE_TYPE[worked.entry.type], worked.entry.netsuite_id));

/** What the journal holds for one NetSuite stock document (gl_stock_postings, migration 395). */
export interface StockPosting extends Omit<InvoicePosting, 'source_type' | 'invoice'> {
  source_type: StockSourceType;
  /**
   * What the copy of NetSuite's GL says of it now: its number, and deleted when the copy holds no line of it for the company
   * (for an invoice or credit memo, no cost line).
   */
  document: { number: string | null; deleted: boolean } | null;
}

/** What the journal holds for a stock document, from gl_stock_postings' answer keyed by postingKey. */
export const stockPostingFor = (postings: Map<string, StockPosting>, worked: WorkedStockDocument) =>
  postings.get(postingKey(STOCK_SOURCE_TYPE[worked.entry.type], worked.entry.netsuite_id));

const ledgerCopySignature = (worked: WorkedLedgerCopy) => signature(
  entryDate(worked.entry),
  worked.checked.lines.map((l) => ({
    account: l.account, cents: l.cents, division: null, lineRef: l.lineId, customerId: l.customerId, vendorRef: l.vendorRef,
  })),
);

/** The lines of Books' own copy's entry of a fulfillment, receipt or adjustment, as signature compares them. */
const ownStockSignature = (entry: OwnStockEntry) => signature(
  entry.date,
  entry.lines.map((l) => ({
    account: l.account, cents: l.cents, division: null, lineRef: l.lineId, customerId: l.customerId, vendorRef: l.vendorRef,
  })),
);

/**
 * What to do about one document of a month posted from the GL copy, given the entry that stands for it. With `expected`,
 * the rule the entry that stands should have been made with, and when Books' own copy of the document posts its entry
 * (decideStockDocument): one made by another rule is replaced, as an invoice's is (decide).
 */
function decideLedgerCopy(
  worked: WorkedLedgerCopy,
  current: InvoicePosting['current'],
  expected?: { rule: string; own: OwnStockEntry | null },
): Decision {
  // Its lines for the company don't balance on their own: whatever stands stays, and the run's notes name it.
  if (worked.checked.status === 'unworkable') return { kind: 'leave', why: 'unworkable' };
  if (worked.checked.lines.length === 0) return current ? { kind: 'reverse', why: 'nothing' } : { kind: 'keep', why: 'nothing' };
  if (!current) return { kind: 'post' };
  if (expected && current.posting_rule && current.posting_rule !== expected.rule) return { kind: 'replace' };
  const own = expected?.own ?? null;
  return postedSignature(current) === (own ? ownStockSignature(own) : ledgerCopySignature(worked)) ? { kind: 'keep' } : { kind: 'replace' };
}

/** What to do about one journal entry of a month, given what the journal holds for it. */
export function decideJournalEntry(worked: WorkedJournalEntry, posting: JournalEntryPosting | undefined): Decision {
  return decideLedgerCopy(worked, posting?.current ?? null);
}

/** What the journal holds for a journal entry and what the next run does about it, for the invoices page. */
export function journalEntryBooks(worked: WorkedJournalEntry, posting: JournalEntryPosting | undefined): InvoiceBooks {
  return booksOf(decideJournalEntry(worked, posting), posting, true);
}

/**
 * FleetSuite's entry for a NetSuite journal entry, its `generation`th: the
 * company's lines on the chart's accounts, each with its memo and NetSuite
 * line id, in the month NetSuite booked it to, keyed `journal_entry:…`. Null
 * with the NetSuite accounts the chart doesn't have when it can't be built.
 */
export function copiedJournalEntry(
  worked: WorkedJournalEntry,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  return ledgerCopyEntry(worked, company, generation, accountIds, { sourceType: JOURNAL_ENTRY_SOURCE_TYPE, rule: JOURNAL_ENTRY_RULE });
}

/** What to do about one bank deposit, transfer or refund of a month, given what the journal holds for it: as for a journal entry. */
export function decideBankDocument(worked: WorkedBankDocument, posting: BankPosting | undefined): Decision {
  return decideLedgerCopy(worked, posting?.current ?? null);
}

/** What the journal holds for a bank deposit, transfer or refund and what the next run does about it, for the invoices page. */
export function bankDocumentBooks(worked: WorkedBankDocument, posting: BankPosting | undefined): InvoiceBooks {
  return booksOf(decideBankDocument(worked, posting), posting, true);
}

/**
 * FleetSuite's entry for a NetSuite bank deposit, transfer or customer
 * refund, its `generation`th, made as a journal entry's is, keyed
 * `bank_deposit:…`, `bank_transfer:…` or `customer_refund:…`.
 */
export function bankJournalEntry(
  worked: WorkedBankDocument,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  return ledgerCopyEntry(worked, company, generation, accountIds, { sourceType: BANK_SOURCE_TYPE[worked.entry.type], rule: BANK_RULE });
}

/**
 * What to do about one stock document of a month, given what the journal holds for it: as for a journal entry, but for
 * a fulfillment, item receipt or adjustment Books has its own copy of, whose entry posts when ownStockPick says so, as
 * an invoice's own copy's does (decide).
 */
export function decideStockDocument(worked: WorkedStockDocument, posting: StockPosting | undefined, own?: OwnStockPick | null): Decision {
  const entry = own?.entry ?? null;
  const ownRule = ownStockRule(worked.entry.type);
  return decideLedgerCopy(worked, posting?.current ?? null, { rule: entry && ownRule ? ownRule : STOCK_RULE, own: ownRule ? entry : null });
}

/**
 * What the journal holds for a stock document and what the next run does about it, for the invoices page. `own` is what
 * the books post for Books' own copy of it, when there's one (ownStockPick).
 */
export function stockDocumentBooks(worked: WorkedStockDocument, posting: StockPosting | undefined, own?: OwnStockPick | null): InvoiceBooks {
  return copyBooks(booksOf(decideStockDocument(worked, posting, own), posting, true), posting?.current?.posting_rule, ownStockRule(worked.entry.type), own);
}

/**
 * FleetSuite's entry for a NetSuite stock document, its `generation`th, made
 * as a journal entry's is, keyed by its STOCK_SOURCE_TYPE: `item_fulfillment:…`
 * and so on, `invoice_cost:…` for an invoice's or credit memo's cost lines.
 * With `own`, the entry of Books' own copy of a fulfillment, receipt or
 * adjustment instead (own_fulfillment@1, own_receipt@1 or own_adjustment@1),
 * under the same key.
 */
export function stockJournalEntry(
  worked: WorkedStockDocument,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
  own?: OwnStockEntry | null,
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  const ownRule = own ? ownStockRule(worked.entry.type) : null;
  return ledgerCopyEntry(worked, company, generation, accountIds, {
    sourceType: STOCK_SOURCE_TYPE[worked.entry.type],
    rule: ownRule ?? STOCK_RULE,
    ...(own && ownRule ? { own } : {}),
  });
}

/**
 * The entry for a document posted from the GL copy, filed under `filed`'s source type and rule; its number is its memo.
 * With `filed.own`, made of Books' own copy's lines, on its date, each naming its item.
 */
function ledgerCopyEntry(
  worked: WorkedLedgerCopy,
  company: BooksCompany,
  generation: number,
  accountIds: Map<string, string>,
  filed: { sourceType: string; rule: string; own?: OwnStockEntry },
): { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] } {
  const lines: ReadonlyArray<JournalRuleLine & { itemNumber?: string | null }> = filed.own ? filed.own.lines : worked.checked.lines;
  const missing = [...new Set(lines.map((l) => l.account).filter((a) => !accountIds.has(a)))];
  if (missing.length) return { entry: null, missing };
  const e = worked.entry;
  return {
    entry: {
      company,
      entryDate: filed.own ? filed.own.date : entryDate(e),
      sourceType: filed.sourceType,
      sourceId: e.netsuite_id,
      postingRule: filed.rule,
      idempotencyKey: entryKey(company, filed.sourceType, e.netsuite_id, generation),
      memo: worked.number,
      postedBy: null,
      lines: lines.map((l) => ({
        accountId: accountIds.get(l.account)!,
        debit: l.cents > 0 ? centsToAmount(l.cents) : null,
        credit: l.cents < 0 ? centsToAmount(-l.cents) : null,
        memo: l.memo,
        division: null,
        itemNumber: l.itemNumber ?? null,
        sourceLineRef: l.lineId,
        customerId: l.customerId,
        vendorRef: l.vendorRef,
      })),
    },
    missing: [],
  };
}


// ── The run ────────────────────────────────────────────────────────────────

export interface InvoicePostingResult {
  /** Months gone through this run, 'YYYY-MM-01'. */
  months?: string[];
  posted?: number;
  replaced?: number;
  reversed?: number;
  unchanged?: number;
  /** Opening entries posted, once a company's books are live (src/lib/books/going-live.ts); only then is it counted. */
  opened?: number;
  /** Documents the rule can't work out yet, or whose copy was mid-refresh, of every kind the run posts: whatever stands for them stayed. */
  left?: number;
  /** Writes waiting for a month closed in FleetSuite's books to be reopened (src/lib/books/months.ts); only then is it counted. */
  waiting?: number;
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
  /** The companies the run posts; POSTING_COMPANIES unless a test runs one alone. */
  companies?: readonly BooksCompany[];
}

const monthLabel = (month: string) =>
  new Date(`${month}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const listed = (items: string[], max = 10) => `${items.slice(0, max).join(', ')}${items.length > max ? ', …' : ''}`;
/**
 * A document as a run's notes and failures name it: its number, with the company in front for a company other than BMG,
 * "1084's JE1207", as one run posts both companies and a document can have lines for each. Entry memos keep the number
 * alone, the entry being the company's already.
 */
const named = (company: BooksCompany, number: string) => (company === 'BMG' ? number : `${company}'s ${number}`);
const joined = (words: string[], last: 'and' | 'or') =>
  (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} ${last} ${words[words.length - 1]}`);
/** Each kind of document a run reads, in words, as the switches on Invoices vs NetSuite name them. */
const READ_WORDS = {
  invoice: 'invoices and credit memos',
  payment: 'payments',
  deposit: 'deposits',
  bill: 'bills',
  billPayment: 'bill payments',
  spending: 'checks and cards',
  journal: 'journal entries',
  bank: 'bank deposits, transfers and refunds',
  stock: 'stock and cost',
} as const;
type ReadKind = keyof typeof READ_WORDS;
/** A read's error with what it read, so a run that stops says where: "Reading BMG's bills for Mar 2025: …". */
const readFailed = (what: string, err: { message: string }) => new Error(`Reading ${what}: ${err.message}`);
/** The kinds of document a run can leave for not coming to their totals, in words. */
const DOCUMENT_WORDS: Record<SalesDocKind | BillSourceType | SpendingSourceType, [string, string]> = {
  invoice: ['invoice', 'invoices'],
  credit_memo: ['credit memo', 'credit memos'],
  vendor_bill: ['bill', 'bills'],
  vendor_credit: ['bill credit', 'bill credits'],
  check: ['check', 'checks'],
  card_charge: ['card charge', 'card charges'],
  card_refund: ['card refund', 'card refunds'],
};
/** '2 invoices and 1 credit memo', for documents of these kinds. */
const documents = (kinds: Array<keyof typeof DOCUMENT_WORDS>) => joined(
  (Object.keys(DOCUMENT_WORDS) as Array<keyof typeof DOCUMENT_WORDS>).flatMap((k) => {
    const n = kinds.filter((x) => x === k).length;
    return n ? [plural(n, ...DOCUMENT_WORDS[k])] : [];
  }),
  'and',
);

/** Runs the tasks in turn, `limit` of them at once. */
export async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
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
  const postingCompanies = opts.deps?.companies ?? POSTING_COMPANIES;
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
    if (chart.error) throw readFailed('the chart of accounts', chart.error);
    if (lists.error) throw readFailed('the NetSuite lists', lists.error);
    const companies = await service.from('gl_companies').select('id, code, books_live_from');
    if (companies.error) throw readFailed('the companies', companies.error);
    const companyRows = (companies.data ?? []) as Array<{ id: string; code: string; books_live_from: string | null }>;
    const codeOf = new Map(companyRows.map((c) => [c.id, c.code]));
    // The day each company's books went live, for those that have: nothing dated before it posts but opening entries.
    const liveOf = new Map(companyRows.flatMap((c): Array<[BooksCompany, string]> => (
      c.books_live_from && (postingCompanies as readonly string[]).includes(c.code) ? [[c.code as BooksCompany, c.books_live_from]] : [])));

    // The months closed in FleetSuite's books (Books → Months) take nothing new: what would write to one waits until it's reopened.
    const closedOf = await readClosedMonths(service, codeOf).catch((err) => { throw readFailed('the closed months', err); });
    const waiting = new Map<string, { company: BooksCompany; month: string; writes: number }>();
    /** Counts a write that would reverse an entry dated `date` or post one then, when its month is closed: true when it waits. */
    const hold = (company: BooksCompany, date: string | null | undefined) => {
      const month = monthOfDate(date ?? null);
      if (!month || !closedOf.get(company)?.has(month)) return false;
      const key = `${company}|${month}`;
      waiting.set(key, { company, month, writes: (waiting.get(key)?.writes ?? 0) + 1 });
      return true;
    };

    const accountIds = new Map<string, string>();
    for (const a of chart.data) if (a.netsuite_account_id) accountIds.set(a.netsuite_account_id, a.id);
    const chartAccounts: ChartAccount[] = chart.data.map(({ id: _id, company_id, ...a }) => ({
      ...a, company: company_id ? codeOf.get(company_id) ?? null : null,
    }));
    const lastLists = (lists.data?.last_result ?? null) as { taxAccounts?: TaxAccountCount[]; itemAccounts?: ItemAccountCount[] } | null;
    const taxAccounts = Array.isArray(lastLists?.taxAccounts) ? lastLists.taxAccounts : null;
    const itemAccounts = Array.isArray(lastLists?.itemAccounts) ? lastLists.itemAccounts : null;
    if (!taxAccounts) notes.push("Where sales tax posts hasn't been read yet, so invoices and credit memos with sales tax weren't posted. Sync now on the NetSuite lists page reads it.");

    // FleetSuite's own copies of the invoices it made, from the first month it made any, post in place of NetSuite's when they match.
    let ownSince: string | null = null;
    if (postingCompanies.includes(OWN_COMPANY)) {
      const made = await service.rpc('gl_own_invoice_months');
      if (made.error) throw readFailed("the months of FleetSuite's own invoices", made.error);
      ownSince = ((made.data ?? []) as Array<{ month: string }>).map((m) => m.month).sort()[0] ?? null;
    }
    const salesTax = salesTaxAccount(taxAccounts, chartAccounts, OWN_COMPANY);

    // Books' own copies of the fulfillments, receipts and bills FleetSuite made post in place of NetSuite's documents when
    // they match, as its own invoices do: from the first month it made any, checked against the copies of NetSuite's stock
    // moves, bills and GL as far as each had come.
    const [stockSince, billSince, stockCopied, billsCopied, ledgerCopied] = await Promise.all([
      readOwnStockSince(service).catch((err) => { throw readFailed("the months of Books' own fulfillments, receipts and adjustments", err); }),
      readOwnBillSince(service).catch((err) => { throw readFailed("the months of Books' own bills", err); }),
      service.from('sync_state').select('last_synced_at').eq('sync_type', BOOKS_STOCK_SYNC).maybeSingle(),
      service.from('sync_state').select('last_synced_at').eq('sync_type', BOOKS_BILLS_SYNC).maybeSingle(),
      service.from('sync_state').select('last_synced_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
    ]);
    for (const r of [stockCopied, billsCopied, ledgerCopied]) if (r.error) throw readFailed('how far the copies of NetSuite had come', r.error);
    const copiedAt = (r: { data: { last_synced_at?: string | null } | null }) => r.data?.last_synced_at ?? null;
    const stockThrough: CopiesThrough = { stock: copiedAt(stockCopied), ledger: copiedAt(ledgerCopied) };
    const billsThrough: BillCopiesThrough = { bills: copiedAt(billsCopied), ledger: copiedAt(ledgerCopied) };
    const names = chartNames(chartAccounts);

    /** Reverses an entry; should that fail, `shown` is how the run's record names its document. */
    const reverse = async (shown: string, entryId: string, memo: string) => {
      try {
        await reverseEntry(service, { entryId, memo });
        result.reversed! += 1;
      } catch (err) {
        failed(shown, err);
      }
    };

    // 1. What NetSuite deleted or voided, and any second entry standing for one document.
    for (const company of postingCompanies) {
      const [all, paid, deposited, billed, paidOut, spent, journaled, banked, stocked] = await Promise.all([
        service.rpc('gl_invoice_postings', { p_company: company, p_source_ids: null, p_lines: false }),
        service.rpc('gl_payment_postings', { p_company: company, p_source_ids: null, p_lines: false }),
        service.rpc('gl_deposit_postings', { p_company: company, p_source_ids: null, p_lines: false }),
        service.rpc('gl_bill_postings', { p_company: company, p_source_ids: null, p_lines: false }),
        service.rpc('gl_bill_payment_postings', { p_company: company, p_source_ids: null, p_lines: false }),
        service.rpc('gl_spending_postings', { p_company: company, p_source_ids: null, p_lines: false }),
        service.rpc('gl_journal_postings', { p_company: company, p_source_ids: null, p_lines: false }),
        service.rpc('gl_bank_postings', { p_company: company, p_source_ids: null, p_lines: false }),
        service.rpc('gl_stock_postings', { p_company: company, p_source_ids: null, p_lines: false }),
      ]);
      const entriesOf = (kind: ReadKind) => `the journal's entries for ${company}'s ${READ_WORDS[kind]}`;
      if (all.error) throw readFailed(entriesOf('invoice'), all.error);
      if (paid.error) throw readFailed(entriesOf('payment'), paid.error);
      if (deposited.error) throw readFailed(entriesOf('deposit'), deposited.error);
      if (billed.error) throw readFailed(entriesOf('bill'), billed.error);
      if (paidOut.error) throw readFailed(entriesOf('billPayment'), paidOut.error);
      if (spent.error) throw readFailed(entriesOf('spending'), spent.error);
      if (journaled.error) throw readFailed(entriesOf('journal'), journaled.error);
      if (banked.error) throw readFailed(entriesOf('bank'), banked.error);
      if (stocked.error) throw readFailed(entriesOf('stock'), stocked.error);
      const held = [
        ...(((all.data as any)?.invoices ?? []) as InvoicePosting[]).map((p) => ({ posting: p, copy: p.invoice })),
        ...(((paid.data as any)?.payments ?? []) as PaymentPosting[]).map((p) => ({ posting: p, copy: p.payment })),
        ...(((deposited.data as any)?.deposits ?? []) as DepositPosting[]).map((p) => ({ posting: p, copy: p.deposit })),
        ...(((billed.data as any)?.bills ?? []) as BillPosting[]).map((p) => ({ posting: p, copy: p.bill })),
        // A voided bill payment, check, card charge or refund is its month's to decide: NetSuite may still book it (stillBooked).
        ...(((paidOut.data as any)?.payments ?? []) as BillPaymentPosting[])
          .map((p) => ({ posting: p, copy: p.payment && { ...p.payment, voided: false } })),
        ...(((spent.data as any)?.documents ?? []) as SpendingPosting[])
          .map((p) => ({ posting: p, copy: p.document && { ...p.document, voided: false } })),
        // A journal entry is never voided in the GL copy: NetSuite's void reverses it with another, or takes its lines away.
        ...(((journaled.data as any)?.journal_entries ?? []) as JournalEntryPosting[])
          .map((p) => ({ posting: p, copy: p.journal && { ...p.journal, voided: false } })),
        // Nor is a bank deposit, transfer or refund.
        ...(((banked.data as any)?.documents ?? []) as BankPosting[])
          .map((p) => ({ posting: p, copy: p.document && { ...p.document, voided: false } })),
        // Nor a stock document: an invoice's or credit memo's void is for its own entries, and takes its cost lines away.
        ...(((stocked.data as any)?.documents ?? []) as StockPosting[])
          .map((p) => ({ posting: p, copy: p.document && { ...p.document, voided: false } })),
      ];
      // Once the company's books are live, an entry dated before they went live stays: the opening entry trues it up.
      const live = liveOf.get(company) ?? null;
      const tasks: Array<() => Promise<void>> = [];
      for (const { posting: p, copy } of held) {
        const number = copy?.number || `NetSuite ${p.source_id}`;
        const shown = named(company, number);
        const dates = live || closedOf.has(company) ? standingDates(p) : [];
        p.unreversed.slice(1).forEach((extra, i) => {
          if (live && !(dates[i + 1] >= live)) return;
          if (hold(company, dates[i + 1])) return;
          tasks.push(() => reverse(shown, extra, `${number} had another entry standing`));
        });
        // An invoice's or credit memo's cost lines go when NetSuite books no cost on it, whether or not it has it still.
        const deleted = p.source_type === STOCK_SOURCE_TYPE.CustInvc ? 'no longer books a cost' : 'deleted';
        const gone = copy?.deleted ? deleted : copy?.voided ? 'voided' : null;
        if (p.current && gone && !(live && p.current.entry_date < live) && !hold(company, p.current.entry_date)) {
          const entryId = p.current.id;
          tasks.push(() => reverse(shown, entryId, `${number} ${gone} in NetSuite`));
        }
      }
      await runLimited(tasks, WRITERS);
    }

    // The opening entries of companies whose books are live, once the month before is over (src/lib/books/going-live.ts).
    if (liveOf.size) {
      const opening = await postOpeningEntries(service, {
        today: centralDate(new Date(now())),
        live: [...liveOf].map(([code, liveFrom]) => ({ code, liveFrom })),
        codeOf,
      });
      result.opened = opening.posted;
      notes.push(...opening.notes);
    }

    // 2. Every month, from where the last run stopped: for a company whose books are live, from the month they went live.
    const months = monthsBetween(COPY_FROM, monthOfDate(new Date(now()).toISOString().slice(0, 10))!);
    const skippedMonths: string[] = [];
    let skippedWhy = '';
    const leftTotal: Array<{ number: string; kind: keyof typeof DOCUMENT_WORDS }> = [];
    const unbalanced: string[] = [];
    const unbalancedBank: string[] = [];
    const unbalancedStock: string[] = [];
    const missingAccounts = new Set<string>();
    const queue = postingQueue(postingCompanies, months, state.resume).filter((q) => {
      const live = liveOf.get(q.company);
      return !live || q.month >= monthOfDate(live)!;
    });

    /**
     * Queues the writes a decision about one of a company's documents calls for, or counts it when it calls for none.
     * `memo` is why a replaced entry is reversed, when it's not that NetSuite changed the document.
     */
    const enqueue = (
      tasks: Array<() => Promise<void>>,
      company: BooksCompany,
      number: string,
      decided: Decision,
      current: { id: string; entry_date: string } | null,
      build: () => { entry: JournalEntryInput; missing: [] } | { entry: null; missing: string[] },
      memo?: string,
    ) => {
      const shown = named(company, number);
      const d = liveDecision(decided, current, liveOf.get(company) ?? null);
      if (d.kind === 'keep') {
        if (current) result.unchanged! += 1;
        return;
      }
      if (d.kind === 'leave') {
        result.left! += 1;
        return;
      }
      // Reversing the entry that stands, or posting one, in a closed month waits for it to be reopened.
      if (d.kind !== 'post' && current && hold(company, current.entry_date)) return;
      if (d.kind === 'reverse') {
        const memo = `${number} ${d.why === 'voided' ? 'voided' : 'comes to nothing'} in NetSuite`;
        tasks.push(() => reverse(shown, current!.id, memo));
        return;
      }
      const built = build();
      if (!built.entry) {
        for (const a of built.missing) missingAccounts.add(a);
        failed(shown, new Error(`It posts to NetSuite account ${built.missing.join(', ')}, which the chart of accounts doesn't have`));
        return;
      }
      const entry = built.entry;
      if (hold(company, entry.entryDate)) return;
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
            await repostEntry(service, { entryId: current!.id, memo: memo ?? `${number} changed in NetSuite`, entry });
            result.replaced! += 1;
          }
        } catch (err) {
          failed(shown, err);
        }
      });
    };

    for (const [i, { company, month }] of queue.entries()) {
      if (timeLeft() < MIN_LEFT_MS) {
        result.partial = true;
        break;
      }
      state.resume = { company, month };
      /** "BMG's bills for Mar 2025", and the journal's entries for them, for a read's error. */
      const copyOf = (kind: ReadKind) => `${company}'s ${READ_WORDS[kind]} for ${monthLabel(month)}`;
      const entriesOf = (kind: ReadKind) => `the journal's entries for ${company}'s ${READ_WORDS[kind]} in ${monthLabel(month)}`;

      const res = await service.rpc('gl_invoice_month', { p_company: company, p_month: month });
      if (res.error) throw readFailed(copyOf('invoice'), res.error);
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
          const workedMonth = workOutMonth(
            { invoices, items: data.items ?? [] },
            { company, chart: chartAccounts, taxAccounts, itemAccounts, facts },
          );
          const worked = workedMonth.invoices.filter((w) => w.invoice.companies.includes(company));

          // FleetSuite's own copies of the month's invoices, made on the days they're dated.
          const days = company === OWN_COMPANY && ownSince ? ownCopyDays(mine, ownSince) : null;
          const copies: OwnCopies = days
            ? await readOwnCopies(service, days.from, days.to).catch((err) => { throw readFailed(`FleetSuite's own copies of ${company}'s invoices for ${monthLabel(month)}`, err); })
            : new Map();
          const ownMonth = { company, accounts: workedMonth.accounts, names: workedMonth.names, salesTax };

          const held = await service.rpc('gl_invoice_postings', {
            p_company: company, p_source_ids: mine.map((inv) => inv.netsuite_id), p_lines: true,
          });
          if (held.error) throw readFailed(entriesOf('invoice'), held.error);
          const postings = new Map((((held.data as any)?.invoices ?? []) as InvoicePosting[]).map((p) => [postingKey(p.source_type, p.source_id), p]));

          const tasks: Array<() => Promise<void>> = [];
          for (const w of worked) {
            const posting = postingFor(postings, w);
            const own = ownPick(w, entryLines(w), copies.get(w.invoice.netsuite_id), ownMonth);
            const d = decide(w, posting, own);
            if (d.kind === 'leave' && d.why === 'total') leftTotal.push({ number: named(company, w.number), kind: kindOf(w) });
            enqueue(tasks, company, w.number, d, posting?.current ?? null,
              () => invoiceJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds, own?.entry),
              replaceMemo(w.number, posting?.current ?? null, own));
          }
          await runLimited(tasks, WRITERS);
          if (result.partial) break;
        }
      }

      // The month's payments: no lines of their own, so nothing to ask NetSuite. One in neither company's GL copy
      // is this company's only while an entry of it stands here: NetSuite posts nothing for it now (a $0 payment
      // posts no lines), or the copy hasn't caught up with it, and the decision tells the two apart.
      const paid = await service.rpc('gl_payment_month', { p_company: company, p_month: month });
      if (paid.error) throw readFailed(copyOf('payment'), paid.error);
      const payments = workOutPaymentMonth(
        { payments: ((paid.data ?? {}) as Partial<PaymentMonthData>).payments ?? [] },
        { company, chart: chartAccounts },
      ).payments.filter((w) => w.payment.companies.length === 0 || w.payment.companies.includes(company));
      if (payments.length) {
        const held = await service.rpc('gl_payment_postings', {
          p_company: company, p_source_ids: payments.map((w) => w.payment.netsuite_id), p_lines: true,
        });
        if (held.error) throw readFailed(entriesOf('payment'), held.error);
        const postings = new Map((((held.data as any)?.payments ?? []) as PaymentPosting[]).map((p) => [p.source_id, p]));
        const tasks: Array<() => Promise<void>> = [];
        for (const w of payments) {
          const posting = postings.get(w.payment.netsuite_id);
          if (!w.payment.companies.length && !posting?.current) continue;
          enqueue(tasks, company, w.number, decidePayment(w, posting), posting?.current ?? null,
            () => paymentJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds));
        }
        await runLimited(tasks, WRITERS);
        if (result.partial) break;
      }

      // The month's customer deposits and deposit applications, as its payments: one in neither company's GL copy
      // is this company's only while an entry of it stands here.
      const dep = await service.rpc('gl_deposit_month', { p_company: company, p_month: month });
      if (dep.error) throw readFailed(copyOf('deposit'), dep.error);
      const depData = (dep.data ?? {}) as Partial<DepositMonthData>;
      const deposits = workOutDepositMonth(
        { deposits: depData.deposits ?? [], accounts: depData.accounts ?? [], not_copied: [] },
        { company, chart: chartAccounts },
      ).deposits.filter((w) => w.deposit.companies.length === 0 || w.deposit.companies.includes(company));
      if (deposits.length) {
        const held = await service.rpc('gl_deposit_postings', {
          p_company: company, p_source_ids: deposits.map((w) => w.deposit.netsuite_id), p_lines: true,
        });
        if (held.error) throw readFailed(entriesOf('deposit'), held.error);
        const postings = new Map((((held.data as any)?.deposits ?? []) as DepositPosting[]).map((p) => [postingKey(p.source_type, p.source_id), p]));
        const tasks: Array<() => Promise<void>> = [];
        for (const w of deposits) {
          const posting = depositPostingFor(postings, w);
          if (!w.deposit.companies.length && !posting?.current) continue;
          enqueue(tasks, company, w.number, decideDeposit(w, posting), posting?.current ?? null,
            () => depositJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds));
        }
        await runLimited(tasks, WRITERS);
        if (result.partial) break;
      }

      // The month's vendor bills and bill credits, those NetSuite booked into it as for invoices: no lines to ask
      // NetSuite about, as the copy keeps them. One in neither company's GL copy is this company's only while an entry
      // of it stands here, as for payments.
      const billMonth = await readBillMonth(service, company, month).catch((err) => { throw readFailed(copyOf('bill'), err); });
      const bills = workOutBillMonth(billMonth, { company, chart: chartAccounts })
        .bills.filter((w) => w.bill.companies.length === 0 || w.bill.companies.includes(company));
      if (bills.length) {
        const held = await service.rpc('gl_bill_postings', {
          p_company: company, p_source_ids: bills.map((w) => w.bill.netsuite_id), p_lines: true,
        });
        if (held.error) throw readFailed(entriesOf('bill'), held.error);
        const postings = new Map((((held.data as any)?.bills ?? []) as BillPosting[]).map((p) => [postingKey(p.source_type, p.source_id), p]));

        // Books' own copies of the month's bills, made on the days they're dated.
        const billDays = billSince ? ownCopyDays(bills.map((w) => w.bill), billSince) : null;
        const ownBills: OwnBillCopies = billDays
          ? await readOwnBillCopies(service, billDays.from, billDays.to, billsThrough)
            .catch((err) => { throw readFailed(`Books' own copies of ${company}'s bills for ${monthLabel(month)}`, err); })
          : new Map();

        const tasks: Array<() => Promise<void>> = [];
        for (const w of bills) {
          const posting = billPostingFor(postings, w);
          if (!w.bill.companies.length && !posting?.current) continue;
          const own = ownBillPick(w, ownBills.get(w.bill.netsuite_id), { company, names });
          const d = decideBill(w, posting, own);
          if (d.kind === 'leave' && d.why === 'total') leftTotal.push({ number: named(company, w.number), kind: BILL_SOURCE_TYPE[w.bill.type] });
          enqueue(tasks, company, w.number, d, posting?.current ?? null,
            () => billJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds, own?.entry),
            replaceBillMemo(w, posting?.current ?? null, own));
        }
        await runLimited(tasks, WRITERS);
        if (result.partial) break;
      }

      // The month's bill payments, those NetSuite booked into it as for bills, read as the Bill payments switch reads them,
      // so payables are picked from the same payments. No lines to wait for, as for payments; one in neither company's GL
      // copy is this company's only while an entry of it stands here.
      const out = await service.rpc('gl_bill_payment_month', { p_company: company, p_month: month });
      if (out.error) throw readFailed(copyOf('billPayment'), out.error);
      const billPayments = workOutBillPaymentMonth(
        { payments: ((out.data ?? {}) as Partial<BillPaymentMonthData>).payments ?? [], not_copied: [] },
        { company, chart: chartAccounts },
      ).payments.filter((w) => w.payment.companies.length === 0 || w.payment.companies.includes(company));
      if (billPayments.length) {
        const held = await service.rpc('gl_bill_payment_postings', {
          p_company: company, p_source_ids: billPayments.map((w) => w.payment.netsuite_id), p_lines: true,
        });
        if (held.error) throw readFailed(entriesOf('billPayment'), held.error);
        const postings = new Map((((held.data as any)?.payments ?? []) as BillPaymentPosting[]).map((p) => [p.source_id, p]));
        const tasks: Array<() => Promise<void>> = [];
        for (const w of billPayments) {
          const posting = postings.get(w.payment.netsuite_id);
          if (!w.payment.companies.length && !posting?.current) continue;
          enqueue(tasks, company, w.number, decideBillPayment(w, posting), posting?.current ?? null,
            () => billPaymentJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds));
        }
        await runLimited(tasks, WRITERS);
        if (result.partial) break;
      }

      // The month's checks and card charges and refunds, those NetSuite booked into it as for bills, read as the Checks
      // and cards switch reads them, so the account the money comes out of is picked the same way. One in neither
      // company's GL copy is this company's only while an entry of it stands here, as for payments.
      const spendingMonth = await readSpendingMonth(service, company, month).catch((err) => { throw readFailed(copyOf('spending'), err); });
      const spending = workOutSpendingMonth(spendingMonth, { company, chart: chartAccounts })
        .documents.filter((w) => w.doc.companies.length === 0 || w.doc.companies.includes(company));
      if (spending.length) {
        const held = await service.rpc('gl_spending_postings', {
          p_company: company, p_source_ids: spending.map((w) => w.doc.netsuite_id), p_lines: true,
        });
        if (held.error) throw readFailed(entriesOf('spending'), held.error);
        const postings = new Map((((held.data as any)?.documents ?? []) as SpendingPosting[]).map((p) => [postingKey(p.source_type, p.source_id), p]));
        const tasks: Array<() => Promise<void>> = [];
        for (const w of spending) {
          const posting = spendingPostingFor(postings, w);
          if (!w.doc.companies.length && !posting?.current) continue;
          const d = decideSpending(w, posting);
          if (d.kind === 'leave' && d.why === 'total') leftTotal.push({ number: named(company, w.number), kind: SPENDING_SOURCE_TYPE[w.doc.type] });
          enqueue(tasks, company, w.number, d, posting?.current ?? null, () => spendingJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds));
        }
        await runLimited(tasks, WRITERS);
        if (result.partial) break;
      }

      // The month's journal entries, those NetSuite booked into it: each one's lines for this company in the GL copy are
      // its entry, so there's nothing to wait for or ask NetSuite, and one the copy no longer has for this company was
      // reversed in step 1.
      const jr = await service.rpc('gl_journal_month', { p_company: company, p_month: month });
      if (jr.error) throw readFailed(copyOf('journal'), jr.error);
      const journalEntries = workOutJournalMonth(
        { journal_entries: ((jr.data ?? {}) as Partial<JournalMonthData>).journal_entries ?? [] },
        { company, chart: chartAccounts },
      ).journalEntries;
      if (journalEntries.length) {
        const held = await service.rpc('gl_journal_postings', {
          p_company: company, p_source_ids: journalEntries.map((w) => w.entry.netsuite_id), p_lines: true,
        });
        if (held.error) throw readFailed(entriesOf('journal'), held.error);
        const postings = new Map((((held.data as any)?.journal_entries ?? []) as JournalEntryPosting[]).map((p) => [p.source_id, p]));
        const tasks: Array<() => Promise<void>> = [];
        for (const w of journalEntries) {
          const posting = postings.get(w.entry.netsuite_id);
          const d = decideJournalEntry(w, posting);
          if (d.kind === 'leave' && w.checked.problems.some((x) => x.kind === 'unbalanced')) unbalanced.push(named(company, w.number));
          enqueue(tasks, company, w.number, d, posting?.current ?? null, () => copiedJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds));
        }
        await runLimited(tasks, WRITERS);
        if (result.partial) break;
      }

      // The month's bank deposits, transfers and refunds, those NetSuite booked into it, as its journal entries.
      const bk = await service.rpc('gl_bank_month', { p_company: company, p_month: month });
      if (bk.error) throw readFailed(copyOf('bank'), bk.error);
      const bankDocuments = workOutBankMonth(
        { documents: ((bk.data ?? {}) as Partial<BankMonthData>).documents ?? [] },
        { company, chart: chartAccounts },
      ).documents;
      if (bankDocuments.length) {
        const held = await service.rpc('gl_bank_postings', {
          p_company: company, p_source_ids: bankDocuments.map((w) => w.entry.netsuite_id), p_lines: true,
        });
        if (held.error) throw readFailed(entriesOf('bank'), held.error);
        const postings = new Map((((held.data as any)?.documents ?? []) as BankPosting[]).map((p) => [postingKey(p.source_type, p.source_id), p]));
        const tasks: Array<() => Promise<void>> = [];
        for (const w of bankDocuments) {
          const posting = bankPostingFor(postings, w);
          const d = decideBankDocument(w, posting);
          if (d.kind === 'leave' && w.checked.problems.some((x) => x.kind === 'unbalanced')) unbalancedBank.push(named(company, w.number));
          enqueue(tasks, company, w.number, d, posting?.current ?? null, () => bankJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds));
        }
        await runLimited(tasks, WRITERS);
        if (result.partial) break;
      }

      // The month's stock documents, those NetSuite booked into it, as its journal entries: an invoice's or credit memo's
      // cost lines here, beside the entry for the sale.
      const st = await service.rpc('gl_stock_month', { p_company: company, p_month: month });
      if (st.error) throw readFailed(copyOf('stock'), st.error);
      const stockDocuments = workOutStockMonth(
        { documents: ((st.data ?? {}) as Partial<StockMonthData>).documents ?? [] },
        { company, chart: chartAccounts },
      ).documents;
      if (stockDocuments.length) {
        const held = await service.rpc('gl_stock_postings', {
          p_company: company, p_source_ids: stockDocuments.map((w) => w.entry.netsuite_id), p_lines: true,
        });
        if (held.error) throw readFailed(entriesOf('stock'), held.error);
        const postings = new Map((((held.data as any)?.documents ?? []) as StockPosting[]).map((p) => [postingKey(p.source_type, p.source_id), p]));

        // Books' own copies of the month's fulfillments, receipts and adjustments, made on the days they're dated.
        const ownStock = await readOwnStockCopies(service, company, stockDocuments.map((w) => w.entry), stockSince, stockThrough)
          .catch((err) => { throw readFailed(`Books' own copies of ${company}'s fulfillments, receipts and adjustments for ${monthLabel(month)}`, err); });

        const tasks: Array<() => Promise<void>> = [];
        for (const w of stockDocuments) {
          const posting = stockPostingFor(postings, w);
          const own = ownStockPick(w, ownStock, { company, names });
          const d = decideStockDocument(w, posting, own);
          if (d.kind === 'leave' && w.checked.problems.some((x) => x.kind === 'unbalanced')) unbalancedStock.push(named(company, w.number));
          enqueue(tasks, company, w.number, d, posting?.current ?? null,
            () => stockJournalEntry(w, company, (posting?.entries ?? 0) + 1, accountIds, own?.entry),
            replaceStockMemo(w, posting?.current ?? null, own));
        }
        await runLimited(tasks, WRITERS);
        if (result.partial) break;
      }

      result.months!.push(month);
      state.resume = queue[i + 1] ?? null;
      await writeSyncStateCursor(service, BOOKS_INVOICE_POSTING, record());
    }

    if (skippedMonths.length) {
      notes.push(`${skippedWhy}, so no invoice or credit memo in ${joined([...new Set(skippedMonths)].map(monthLabel), 'or')} was posted or changed this time.`);
    }
    if (leftTotal.length) {
      const one = leftTotal.length === 1;
      notes.push(`FleetSuite's ${one ? 'entry' : 'entries'} for ${documents(leftTotal.map((l) => l.kind))} ${one ? "doesn't come to its total" : "don't come to their totals"}, `
        + `so whatever FleetSuite holds for ${one ? 'it' : 'them'} stayed as it is: ${listed(leftTotal.map((l) => l.number))}. `
        + `Either the ${one ? 'copy was' : 'copies were'} caught mid-refresh, and the next run looks again, or the rule leaves out a line `
        + 'NetSuite posts, which Invoices vs NetSuite shows.');
    }
    if (unbalanced.length) {
      const one = unbalanced.length === 1;
      notes.push(`FleetSuite can't post ${plural(unbalanced.length, 'journal entry', 'journal entries')}, as ${one ? 'its' : 'their'} lines for the `
        + `company don't balance on their own, so whatever FleetSuite holds for ${one ? 'it' : 'them'} stayed as it is: ${listed(unbalanced)}. `
        + `The Journal entries switch on Invoices vs NetSuite shows ${one ? 'its' : 'their'} lines.`);
    }
    if (unbalancedBank.length) {
      const one = unbalancedBank.length === 1;
      const counted = plural(unbalancedBank.length, 'bank deposit, transfer or refund', 'bank deposits, transfers and refunds');
      notes.push(`FleetSuite can't post ${counted}, as ${one ? 'its' : 'their'} `
        + `lines for the company don't balance on their own, so whatever FleetSuite holds for ${one ? 'it' : 'them'} stayed as it is: ${listed(unbalancedBank)}. `
        + `The Bank deposits, transfers and refunds switch on Invoices vs NetSuite shows ${one ? 'its' : 'their'} lines.`);
    }
    if (unbalancedStock.length) {
      const one = unbalancedStock.length === 1;
      notes.push(`FleetSuite can't post ${plural(unbalancedStock.length, 'stock document', 'stock documents')}, as ${one ? 'its' : 'their'} `
        + `lines for the company don't balance on their own, so whatever FleetSuite holds for ${one ? 'it' : 'them'} stayed as it is: ${listed(unbalancedStock)}. `
        + `The Stock and cost switch on Invoices vs NetSuite shows ${one ? 'its' : 'their'} lines.`);
    }
    // Company by company as the run goes, each one's months in order.
    const waited = [...waiting.values()]
      .sort((a, b) => postingCompanies.indexOf(a.company) - postingCompanies.indexOf(b.company) || a.month.localeCompare(b.month));
    for (const { company, month, writes } of waited) {
      notes.push(`${company}'s ${monthLabel(month)} is closed in FleetSuite's books, so ${plural(writes, 'change', 'changes')} to it `
        + `${writes === 1 ? 'waits' : 'wait'} until it's reopened on Books → Months.`);
    }
    if (waited.length) result.waiting = waited.reduce((n, w) => n + w.writes, 0);
    if (missingAccounts.size) {
      notes.push(`NetSuite account${missingAccounts.size === 1 ? '' : 's'} ${listed([...missingAccounts])} ${missingAccounts.size === 1 ? "isn't" : "aren't"} `
        + 'in the chart of accounts yet, so invoices, credit memos, payments, deposits, bills, bill payments, checks, card charges, journal entries, '
        + 'bank deposits, transfers, customer refunds and stock documents posting there weren\'t posted. Sync now on the chart of accounts page copies them.');
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
    records: (result.posted ?? 0) + (result.replaced ?? 0) + (result.reversed ?? 0) + (result.opened ?? 0),
    touchLastSyncedAt: !result.partial && !result.error,
  });
  return { ...result, ...(notes.length ? { notes } : {}), heartbeat };
}
