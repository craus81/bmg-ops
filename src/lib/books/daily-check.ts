import type { SupabaseClient } from '@supabase/supabase-js';
import { deepLinks } from '@/lib/deep-links';
import { fetchAllRows } from '@/lib/fetch-all';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import type { BooksCompany } from './journal';
import { BOOKS_GL_SYNC, COPY_FROM, monthOfDate } from './netsuite-gl';
import { BOOKS_INVOICE_POSTING, POSTING_COMPANIES, runLimited } from './invoice-posting';
import { BOOKS_STOCK_SYNC } from './netsuite-stock';
import { compareStock, quantityText, type CountsBy, type StockItemsData, type StockLine } from './stock-items';
import {
  PARTY_KINDS, partyBalances, partyDetail, type PartyBalancesData, type PartyDocumentsData, type PartyKind,
} from './party-balances';
import {
  documentNumber, indexMonths, lastMonth, monthStatuses, monthText, NETSUITE_TYPE, postedKinds,
  type DiffData, type DiffDocumentData,
} from './differences';
import { checkOwnInvoices, type OwnInvoiceCheck, type OwnPairsData } from './own-invoice-check';
import { checkOwnFulfillments, type CopiesThrough, type FulfilPairsData, type OwnFulfillmentCheck } from './own-fulfillment-check';
import { BOOKS_BILLS_SYNC } from './netsuite-bills';
import { checkOwnBills, type BillCopiesThrough, type BillPairsData, type OwnBillCheck } from './own-bill-check';
import { checkOwnReceipts, type OwnReceiptCheck, type ReceiptCopiesThrough, type ReceiptPairsData } from './own-receipt-check';
import { checkOwnAdjustments, INVENTORY_ADJUST_ACCOUNT, type AdjustPairsData, type OwnAdjustmentCheck } from './own-adjustment-check';
import { MISTAKE_KINDS, type MistakeKind } from './mistake-checks';
import { readClosedMonths } from './months';
import { readNames } from './netsuite-feed';
import { describeSend, NO_ANSWER_MS, type SendAction } from '@/lib/netsuite-sends';

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
 * Stock by item (owner decision 2026-10-18, "Stock by item") is looked at
 * the same way: an item whose count at a location stops matching NetSuite's
 * own count is noted at the first look and told about at the second if it
 * still differs, as is one whose counts have drawn further apart. Each look
 * comes just after a copy of NetSuite's stock moves (:43 on odd hours), which
 * reads NetSuite's counts as it ends, so the two counts are of the same
 * moment; after a copy that didn't get that far, stock waits for the next
 * look. Values aren't told about: the page shows them.
 *
 * Each customer's and vendor's balance (owner decision 2026-10-19,
 * "Balance checks"; src/lib/books/party-balances.ts) is looked at the same
 * way too: one whose balance in FleetSuite's books stops matching NetSuite's
 * is noted at the first look and told about at the second if it still
 * differs, as is one more of whose documents differ than before.
 *
 * So is each of FleetSuite's own invoices (owner decision 2026-10-19, "Own
 * invoices"; src/lib/books/own-invoice-check.ts): one that differs from
 * NetSuite's invoice is noted at the first look and told about at the
 * second if it still differs, as is one where more differs than before.
 * FleetSuite keeps them only from the day it began to, so none is known to
 * differ beforehand, even at the check's first look at them.
 *
 * So, too, is each of FleetSuite's own fulfillments (owner decision
 * 2026-10-19, "Fulfillments"; src/lib/books/own-fulfillment-check.ts): one
 * that takes from stock differently from NetSuite's fulfillment, or costs it
 * differently, is noted at the first look and told about at the second if it
 * still differs, as is one where more differs than before.
 *
 * So are Books' own bills and receipts (owner decision 2026-10-24, "Shared
 * bills"; src/lib/books/own-bill-check.ts and own-receipt-check.ts): one that
 * differs from NetSuite's bill or item receipt is noted at the first look and
 * told about at the second if it still differs, as is one where more differs
 * than before. A Receive NetSuite didn't take isn't told about: Receiving
 * already lists it to enter by hand.
 *
 * So is each change made with Inventory Adjust (owner decision 2026-10-30,
 * "Own postings"; src/lib/books/own-adjustment-check.ts): one that differs
 * from NetSuite's inventory adjustment is noted at the first look and told
 * about at the second if it still differs, as is one where more differs than
 * before. One NetSuite didn't say it made isn't told about: Own adjustments
 * lists it as incomplete.
 *
 * And the likely mistakes the nightly mistake checks keep open (owner
 * decision 2026-10-24, "Mistake checks"; src/lib/books/mistake-checks.ts): one
 * the 09:46 look found is noted at the first look and told about at the
 * second if nobody has cleared it by then. One that comes back, or is opened
 * again, is told about again. They start the day the check began to look, so
 * the first ones are told about too.
 *
 * And the sends to NetSuite FleetSuite isn't sure about (part 45, "NetSuite
 * feed"; src/lib/books/netsuite-feed.ts): one NetSuite's answer didn't settle,
 * or that never heard back, which nobody has looked for in NetSuite yet, is
 * told about at the first look that finds it, once.
 *
 * In-app and push only (books_month_differs, books_stock_differs,
 * books_balance_differs, books_own_invoice_differs,
 * books_own_fulfillment_differs, books_own_bill_differs,
 * books_own_receipt_differs, books_mistake_found), but for the Inventory
 * Adjusts (books_own_adjustment_differs) and the sends
 * (books_netsuite_send_unsure), which are emailed too to a super admin with
 * "Copy me on new alerts" ticked (Craig, 2026-10-28). The record in
 * sync_state, 'books_daily_check', holds which months differ and how many of
 * their documents, which items' counts differ and by about how many, whose
 * balances differ and in how many documents, which own invoices,
 * fulfillments, bills, receipts and adjustments differ and in how many
 * things, and which likely mistakes are open, never an amount (each send
 * told about is marked on its own row instead), and is left
 * out of HEALTH_MONITORS like the other books jobs; Differences vs NetSuite
 * says when the check last looked. Nothing is written to NetSuite or to the
 * books.
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

/**
 * What the check holds for stock by item, as for a company's months: the items whose count differs from NetSuite's,
 * by StockLine.key (`<item>|<location>`, or `<item>` when NetSuite counts company-wide, which `by` says), each with how
 * far apart the two counts are, rounded up to a whole one.
 */
export interface StockCheck extends CompanyCheck {
  by: CountsBy;
}

export interface DailyCheckState {
  companies: Partial<Record<BooksCompany, CompanyCheck>>;
  /** Absent until the check has looked at stock. */
  stock?: StockCheck;
  /**
   * Each company's customers and vendors whose balance differs from NetSuite's, as for its months: by balanceKey,
   * each with how many of their documents differ. A company is absent until the check has looked at its balances.
   */
  balances?: Partial<Record<BooksCompany, CompanyCheck>>;
  /**
   * FleetSuite's own invoices that differ from NetSuite's, as for a company's months: by NetSuite's id for the
   * invoice, each with how many of the things compared differ. Absent until the check has looked at them.
   */
  own?: CompanyCheck;
  /** FleetSuite's own fulfillments that differ from NetSuite's, as its own invoices, by NetSuite's id for the fulfillment. */
  fulfillments?: CompanyCheck;
  /** Books' own bills that differ from NetSuite's, as its own invoices, by NetSuite's id for the bill. */
  bills?: CompanyCheck;
  /** Books' own receipts that differ from NetSuite's item receipts, as its own invoices, by the receipt's key. */
  receipts?: CompanyCheck;
  /** The Inventory Adjusts that differ from NetSuite's adjustments, as its own invoices, by FleetSuite's id for each. */
  adjustments?: CompanyCheck;
  /** The likely mistakes open on Mistake checks, as its own invoices, by the item's id, each counted once. */
  mistakes?: CompanyCheck;
}

const MONTH_RE = /^\d{4}-\d{2}-01$/;
/** An item at a location, or an item company-wide: StockLine.key. */
const STOCK_KEY_RE = /^\d+(\|\d*)?$/;
/** A customer, by FleetSuite's id, or a vendor, by NetSuite's; nothing after the colon for the lines FleetSuite can't name. */
const BALANCE_KEY_RE = /^(c:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?|v:(\d+)?)$/;
/** An own invoice or own fulfillment, by NetSuite's id for it. */
const OWN_KEY_RE = /^\d+$/;
/** A likely mistake, by its id on Mistake checks. */
const MISTAKE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An own receipt, by its key: FleetSuite's first row of the Receive. */
const RECEIPT_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An Inventory Adjust, by FleetSuite's id for it. */
const ADJUST_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How the check keys one customer's ('c:<FleetSuite id>') or vendor's ('v:<NetSuite id>') balance; 'c:' and 'v:' for the lines FleetSuite can't name. */
export const balanceKey = (kind: PartyKind, party: string) => `${kind === 'customer' ? 'c' : 'v'}:${party}`;
const partyOfKey = (key: string): { kind: PartyKind; party: string } =>
  ({ kind: key.startsWith('c:') ? 'customer' : 'vendor', party: key.slice(2) });
const has = (months: DifferingMonths, month: string) => Object.prototype.hasOwnProperty.call(months, month);

function parseCounts(raw: unknown, key: RegExp): DifferingMonths | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: DifferingMonths = {};
  for (const [month, n] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.test(month) || typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
    out[month] = n;
  }
  return out;
}

function parseStock(raw: any): StockCheck | null {
  if (raw?.by !== 'location' && raw?.by !== 'item') return null;
  const known = parseCounts(raw.known, STOCK_KEY_RE);
  const noted = parseCounts(raw.noted, STOCK_KEY_RE);
  return known && noted ? { by: raw.by, known, noted } : null;
}

/** sync_state.last_result is data, so it's checked before it's used: a company, or stock, whose part doesn't read is looked at afresh. */
export function parseCheckState(lastResult: unknown): DailyCheckState {
  const last = (lastResult ?? {}) as Record<string, any>;
  const raw = last.companies;
  const companies: DailyCheckState['companies'] = {};
  if (raw && typeof raw === 'object') {
    for (const company of POSTING_COMPANIES) {
      const known = parseCounts(raw[company]?.known, MONTH_RE);
      const noted = parseCounts(raw[company]?.noted, MONTH_RE);
      if (known && noted) companies[company] = { known, noted };
    }
  }
  const stock = parseStock(last.stock);
  const balances: NonNullable<DailyCheckState['balances']> = {};
  for (const company of POSTING_COMPANIES) {
    const known = parseCounts(last.balances?.[company]?.known, BALANCE_KEY_RE);
    const noted = parseCounts(last.balances?.[company]?.noted, BALANCE_KEY_RE);
    if (known && noted) balances[company] = { known, noted };
  }
  const byId = (raw: any, key = OWN_KEY_RE): CompanyCheck | null => {
    const known = parseCounts(raw?.known, key);
    const noted = parseCounts(raw?.noted, key);
    return known && noted ? { known, noted } : null;
  };
  const own = byId(last.own);
  const fulfillments = byId(last.fulfillments);
  const bills = byId(last.bills);
  const receipts = byId(last.receipts, RECEIPT_KEY_RE);
  const adjustments = byId(last.adjustments, ADJUST_KEY_RE);
  const mistakes = byId(last.mistakes, MISTAKE_KEY_RE);
  return {
    companies,
    ...(stock ? { stock } : {}),
    ...(Object.keys(balances).length ? { balances } : {}),
    ...(own ? { own } : {}),
    ...(fulfillments ? { fulfillments } : {}),
    ...(bills ? { bills } : {}),
    ...(receipts ? { receipts } : {}),
    ...(adjustments ? { adjustments } : {}),
    ...(mistakes ? { mistakes } : {}),
  };
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
 * company yet (the check's first look, or a company new to the books) what differs now is taken as known. Stock by
 * item goes through it too, its items for months and how far apart their counts are for documents.
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
  /**
   * Set on a notification about stock by item (books_stock_differs), a customer's or vendor's balance
   * (books_balance_differs), FleetSuite's own invoices (books_own_invoice_differs), its own fulfillments
   * (books_own_fulfillment_differs), Books' own bills (books_own_bill_differs) and receipts
   * (books_own_receipt_differs), the Inventory Adjusts (books_own_adjustment_differs), likely mistakes
   * (books_mistake_found) or sends to NetSuite FleetSuite isn't sure about (books_netsuite_send_unsure); one about
   * months has none (books_month_differs).
   */
  about?: 'stock' | 'balance' | 'own' | 'fulfillment' | 'bill' | 'receipt' | 'adjustment' | 'mistake' | 'send';
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
 * failed, which can be why; of a month closed in FleetSuite's books (`closed`), it says NetSuite's change waits for it
 * to be reopened (src/lib/books/months.ts).
 */
export function alertsFor(
  company: BooksCompany,
  news: MonthNews[],
  facts: Map<string, MonthFacts>,
  hint = '',
  closed: ReadonlySet<string> = new Set(),
): CheckAlert[] {
  if (!news.length) return [];
  const books = `${company}'s books`;
  const why = `Differences vs NetSuite shows why.${hint ? ` ${hint}` : ''}`;
  if (news.length > ONE_BY_ONE) {
    const months = news.slice(0, ONE_BY_ONE).map((n) => monthText(n.month));
    const shut = news.filter((n) => closed.has(n.month)).length;
    const waits = shut
      ? ` ${plural(shut, 'of them is', 'of them are')} closed in FleetSuite's books, so what NetSuite changed there waits until `
        + `${shut === 1 ? "it's" : "they're"} reopened on Books → Months.`
      : '';
    return [{
      title: `${books}: ${news.length} months differ from NetSuite now`,
      body: `${listed([...months, `${news.length - ONE_BY_ONE} more`])}.${waits} ${why}`,
      url: deepLinks.booksDifferences(company, news[0].month),
    }];
  }
  return news.map((n) => ({
    title: n.before === null
      ? `${books}: ${monthText(n.month)} no longer matches NetSuite`
      : `${books}: more of ${monthText(n.month)} differs from NetSuite`,
    body: `${whatDiffers(n, facts.get(n.month))}${closed.has(n.month)
      ? ` ${monthText(n.month)} is closed in FleetSuite's books, so NetSuite's change waits until it's reopened on Books → Months.`
      : ''} ${why}`,
    url: deepLinks.booksDifferences(company, n.month),
  }));
}

/** An item to tell the super admins about. */
export interface StockNews {
  line: StockLine;
  /** Its counts already differed when they last heard of it, and are further apart now. */
  further: boolean;
}

const placeOf = (line: StockLine) => (line.location ? `${line.item} at ${line.location}` : line.item);

/**
 * What the super admins are told about stock by item: a notification for each item, linking to its moves, or one for
 * them all, linking to the items that differ, when there are more than ONE_BY_ONE.
 */
export function stockAlertsFor(news: StockNews[]): CheckAlert[] {
  if (!news.length) return [];
  const why = 'Stock by item shows why.';
  if (news.length > ONE_BY_ONE) {
    const places = news.slice(0, ONE_BY_ONE).map((n) => placeOf(n.line));
    return [{
      title: `Stock: ${news.length} counts differ from NetSuite now`,
      body: `${listed([...places, `${news.length - ONE_BY_ONE} more`])}. ${why}`,
      url: deepLinks.booksStock(true),
      about: 'stock',
    }];
  }
  return news.map(({ line, further }) => ({
    title: further
      ? `Stock: ${placeOf(line)} is further off NetSuite's count`
      : `Stock: ${placeOf(line)} no longer matches NetSuite`,
    body: `${line.description ? `${line.description}. ` : ''}FleetSuite counts ${quantityText(line.fleetsuite.quantity)} `
      + `and NetSuite ${quantityText(line.netsuite.quantity)}${further ? ', further apart than before' : ''}. ${why}`,
    url: deepLinks.booksStockItem(line.itemId, line.locationId),
    about: 'stock',
  }));
}

/** A customer's or vendor's balance to tell the super admins about. */
export interface BalanceNews {
  kind: PartyKind;
  /** A customer's FleetSuite id, a vendor's NetSuite id; '' for the lines FleetSuite can't name. */
  party: string;
  name: string;
  /** How many of its documents differ now. */
  documents: number;
  /** How many differed when they last heard of it; null when its balance matched. */
  before: number | null;
  /** The newest of its documents that differ, by number. */
  named: string[];
}

/** What the lines FleetSuite can't name are, in a sentence. */
const UNNAMED_GROUP: Readonly<Record<PartyKind, string>> = {
  customer: 'customers not matched to FleetSuite',
  vendor: 'payables naming no vendor',
};

const balanceOf = (n: BalanceNews) => (n.party ? `${n.name}'s balance` : `the balance of ${UNNAMED_GROUP[n.kind]}`);
const documentsOf = (n: BalanceNews) => (n.party ? `more of ${n.name}'s documents differ` : `more documents of ${UNNAMED_GROUP[n.kind]} differ`);

/** What one balance's notification says has changed, naming its documents that differ. */
function whatDiffersIn(n: BalanceNews): string {
  const docs = n.named.slice(0, NAMED);
  const all = n.documents <= docs.length;
  if (n.before !== null) {
    const which = docs.length ? `${all ? ': ' : ', the newest '}${listed(docs)}` : '';
    return `${plural(n.documents, 'document differs', 'documents differ')} now, ${n.before || 'none'} before${which}.`;
  }
  if (!docs.length) return `${plural(n.documents, 'document differs', 'documents differ')} from what NetSuite posted.`;
  if (all) return `${listed(docs)} ${n.documents === 1 ? 'differs' : 'differ'} from what NetSuite posted.`;
  return `${plural(n.documents, 'document differs', 'documents differ')} from what NetSuite posted, the newest ${listed(docs)}.`;
}

/**
 * What the super admins are told about one company's customers' and vendors' balances: a notification for each,
 * linking to its documents, or one for them all, linking to the balances that differ, when there are more than
 * ONE_BY_ONE. `hint` says when the last posting run or copy of NetSuite's ledger failed, which can be why.
 */
export function balanceAlertsFor(company: BooksCompany, news: BalanceNews[], hint = ''): CheckAlert[] {
  if (!news.length) return [];
  const books = `${company}'s books`;
  const why = `Customer and vendor balances shows why.${hint ? ` ${hint}` : ''}`;
  if (news.length > ONE_BY_ONE) {
    const kinds = new Set(news.map((n) => n.kind));
    const which = kinds.size > 1 ? 'customer and vendor balances' : `${news[0].kind} balances`;
    const names = listed([...news.slice(0, ONE_BY_ONE).map((n) => (n.party ? n.name : `the ${UNNAMED_GROUP[n.kind]}`)), `${news.length - ONE_BY_ONE} more`]);
    return [{
      title: `${books}: ${news.length} ${which} differ from NetSuite now`,
      body: `${names.charAt(0).toUpperCase()}${names.slice(1)}. ${why}`,
      url: deepLinks.booksBalances(company, news[0].kind, true),
      about: 'balance',
    }];
  }
  return news.map((n) => ({
    title: n.before === null
      ? `${books}: ${balanceOf(n)} no longer matches NetSuite`
      : `${books}: ${documentsOf(n)} from NetSuite`,
    body: `${whatDiffersIn(n)} ${why}`,
    url: deepLinks.booksBalance(company, n.kind, n.party),
    about: 'balance',
  }));
}

/**
 * What the super admins are told about FleetSuite's own invoices: a notification for each, linking to its check, or
 * one for them all, linking to the month of the newest with the ones that differ, when there are more than ONE_BY_ONE.
 */
export function ownAlertsFor(news: MonthNews[], checks: Map<string, OwnInvoiceCheck>): CheckAlert[] {
  const told = news.map((n) => ({ n, check: checks.get(n.month) })).filter((t): t is { n: MonthNews; check: OwnInvoiceCheck } => !!t.check);
  if (!told.length) return [];
  const why = 'Own invoices shows why.';
  const name = (c: OwnInvoiceCheck) => (c.customer ? `${c.number} (${c.customer})` : c.number);
  if (told.length > ONE_BY_ONE) {
    const newest = [...told].sort((a, b) => b.check.date.localeCompare(a.check.date))[0].check;
    return [{
      title: `Own invoices: ${told.length} differ from NetSuite's now`,
      body: `${listed([...told.slice(0, ONE_BY_ONE).map((t) => name(t.check)), `${told.length - ONE_BY_ONE} more`])}. ${why}`,
      url: deepLinks.booksOwnInvoices(newest.date, true),
      about: 'own',
    }];
  }
  return told.map(({ n, check }) => ({
    title: n.before === null
      ? `Own invoices: ${name(check)} differs from NetSuite's`
      : `Own invoices: more of ${name(check)} differs from NetSuite's`,
    body: `${check.summary} ${why}`,
    url: deepLinks.booksOwnInvoice(check.netsuiteId),
    about: 'own',
  }));
}

/**
 * What the super admins are told about FleetSuite's own fulfillments, as about its own invoices: a notification for
 * each, linking to its check, or one for them all, linking to the month of the newest with the ones that differ, when
 * there are more than ONE_BY_ONE.
 */
export function fulfillmentAlertsFor(news: MonthNews[], checks: Map<string, OwnFulfillmentCheck>): CheckAlert[] {
  const told = news.map((n) => ({ n, check: checks.get(n.month) })).filter((t): t is { n: MonthNews; check: OwnFulfillmentCheck } => !!t.check);
  if (!told.length) return [];
  const why = 'Own fulfillments shows why.';
  const name = (c: OwnFulfillmentCheck) => (c.customer ? `${c.number} (${c.customer})` : c.number);
  if (told.length > ONE_BY_ONE) {
    const newest = [...told].sort((a, b) => b.check.date.localeCompare(a.check.date))[0].check;
    return [{
      title: `Own fulfillments: ${told.length} differ from NetSuite's now`,
      body: `${listed([...told.slice(0, ONE_BY_ONE).map((t) => name(t.check)), `${told.length - ONE_BY_ONE} more`])}. ${why}`,
      url: deepLinks.booksOwnFulfillments(newest.date, true),
      about: 'fulfillment',
    }];
  }
  return told.map(({ n, check }) => ({
    title: n.before === null
      ? `Own fulfillments: ${name(check)} differs from NetSuite's`
      : `Own fulfillments: more of ${name(check)} differs from NetSuite's`,
    body: `${check.summary} ${why}`,
    url: deepLinks.booksOwnFulfillment(check.netsuiteId),
    about: 'fulfillment',
  }));
}

/**
 * What the super admins are told about Books' own bills, as about its own invoices: a notification for each, linking
 * to its check, or one for them all, linking to the month of the newest with the ones that differ, when there are
 * more than ONE_BY_ONE.
 */
export function billAlertsFor(news: MonthNews[], checks: Map<string, OwnBillCheck>): CheckAlert[] {
  const told = news.map((n) => ({ n, check: checks.get(n.month) })).filter((t): t is { n: MonthNews; check: OwnBillCheck } => !!t.check);
  if (!told.length) return [];
  const why = 'Own bills shows why.';
  const name = (c: OwnBillCheck) => (c.vendor ? `${c.vendor}'s bill ${c.number}` : `bill ${c.number}`);
  const Name = (c: OwnBillCheck) => `${name(c).charAt(0).toUpperCase()}${name(c).slice(1)}`;
  if (told.length > ONE_BY_ONE) {
    const newest = [...told].sort((a, b) => b.check.date.localeCompare(a.check.date))[0].check;
    return [{
      title: `Own bills: ${told.length} differ from NetSuite's now`,
      body: `${listed([Name(told[0].check), ...told.slice(1, ONE_BY_ONE).map((t) => name(t.check)), `${told.length - ONE_BY_ONE} more`])}. ${why}`,
      url: deepLinks.booksOwnBills(newest.date, true),
      about: 'bill',
    }];
  }
  return told.map(({ n, check }) => ({
    title: n.before === null
      ? `Own bills: ${name(check)} differs from NetSuite's`
      : `Own bills: more of ${name(check)} differs from NetSuite's`,
    body: `${check.summary} ${why}`,
    url: deepLinks.booksOwnBill(check.netsuiteId),
    about: 'bill',
  }));
}

/**
 * What the super admins are told about Books' own receipts, as about its own invoices: a notification for each,
 * linking to its check, or one for them all, linking to the month of the newest with the ones that differ, when there
 * are more than ONE_BY_ONE.
 */
export function receiptAlertsFor(news: MonthNews[], checks: Map<string, OwnReceiptCheck>): CheckAlert[] {
  const told = news.map((n) => ({ n, check: checks.get(n.month) })).filter((t): t is { n: MonthNews; check: OwnReceiptCheck } => !!t.check);
  if (!told.length) return [];
  const why = 'Own receipts shows why.';
  const name = (c: OwnReceiptCheck) => (c.vendor ? `${c.poNumber} (${c.vendor})` : c.poNumber);
  if (told.length > ONE_BY_ONE) {
    const newest = [...told].sort((a, b) => b.check.date.localeCompare(a.check.date))[0].check;
    return [{
      title: `Own receipts: ${told.length} differ from NetSuite's now`,
      body: `${listed([...told.slice(0, ONE_BY_ONE).map((t) => name(t.check)), `${told.length - ONE_BY_ONE} more`])}. ${why}`,
      url: deepLinks.booksOwnReceipts(newest.date, true),
      about: 'receipt',
    }];
  }
  return told.map(({ n, check }) => ({
    title: n.before === null
      ? `Own receipts: the receipt on ${name(check)} differs from NetSuite's`
      : `Own receipts: more of the receipt on ${name(check)} differs from NetSuite's`,
    body: `${check.summary} ${why}`,
    url: deepLinks.booksOwnReceipt(check.receiptKey),
    about: 'receipt',
  }));
}

/**
 * What the super admins are told about the Inventory Adjusts, as about its own invoices: a notification for each,
 * linking to its check, or one for them all, linking to the month of the newest with the ones that differ, when there
 * are more than ONE_BY_ONE.
 */
export function adjustmentAlertsFor(news: MonthNews[], checks: Map<string, OwnAdjustmentCheck>): CheckAlert[] {
  const told = news.map((n) => ({ n, check: checks.get(n.month) })).filter((t): t is { n: MonthNews; check: OwnAdjustmentCheck } => !!t.check);
  if (!told.length) return [];
  const why = 'Own adjustments shows why.';
  const name = (c: OwnAdjustmentCheck) => `${c.number} (${c.item}, ${c.changeText})`;
  if (told.length > ONE_BY_ONE) {
    const newest = [...told].sort((a, b) => b.check.date.localeCompare(a.check.date))[0].check;
    return [{
      title: `Own adjustments: ${told.length} differ from NetSuite's now`,
      body: `${listed([...told.slice(0, ONE_BY_ONE).map((t) => name(t.check)), `${told.length - ONE_BY_ONE} more`])}. ${why}`,
      url: deepLinks.booksOwnAdjustments(newest.date, true),
      about: 'adjustment',
    }];
  }
  return told.map(({ n, check }) => ({
    title: n.before === null
      ? `Own adjustments: ${name(check)} differs from NetSuite's`
      : `Own adjustments: more of ${name(check)} differs from NetSuite's`,
    body: `${check.summary} ${why}`,
    url: deepLinks.booksOwnAdjustment(check.id),
    about: 'adjustment',
  }));
}

/** A likely mistake a notification names: what Mistake checks shows of it. */
export interface MistakeAlertItem {
  id: string;
  company: BooksCompany;
  kind: MistakeKind;
  party: string | null;
  why: string;
}

const MISTAKE_TITLES: Record<MistakeKind, (party: string) => string> = {
  twice: (party) => `${party} may be entered twice`,
  far_off: (party) => `${party} is far off their usual`,
  missing: (party) => `${party}'s monthly charge hasn't come`,
  odd_account: (party) => `${party} is coded to an odd account`,
};
const MISTAKE_WORDS: Record<MistakeKind, string> = {
  twice: 'entered twice', far_off: 'far off usual', missing: 'monthly charge missing', odd_account: 'odd account',
};

/**
 * What the super admins are told about likely mistakes nobody has cleared: a notification for each, opening it on
 * Mistake checks, or with more than ONE_BY_ONE at a look one naming the first few, opening the list.
 */
export function mistakeAlertsFor(news: MonthNews[], items: Map<string, MistakeAlertItem>): CheckAlert[] {
  const told = news.map((n) => items.get(n.month)).filter((i): i is MistakeAlertItem => !!i)
    .sort((a, b) => MISTAKE_KINDS.indexOf(a.kind) - MISTAKE_KINDS.indexOf(b.kind));
  if (!told.length) return [];
  const party = (i: MistakeAlertItem) => i.party ?? 'A vendor';
  if (told.length > ONE_BY_ONE) {
    const companies = [...new Set(told.map((i) => i.company))];
    return [{
      title: `Mistake checks: ${told.length} likely mistakes in NetSuite`,
      body: `${listed([...told.slice(0, ONE_BY_ONE).map((i) => `${party(i)} (${MISTAKE_WORDS[i.kind]})`), `${told.length - ONE_BY_ONE} more`])}. `
        + 'Mistake checks shows why.',
      url: deepLinks.booksMistakeChecks(companies.length === 1 ? companies[0] : null),
      about: 'mistake',
    }];
  }
  return told.map((i) => ({
    title: `Mistake checks: ${MISTAKE_TITLES[i.kind](party(i))}`,
    body: `${i.why} Mistake checks shows it.`,
    url: deepLinks.booksMistakeChecks(i.company, i.id),
    about: 'mistake',
  }));
}

/** A send to NetSuite FleetSuite isn't sure about, as a notification names it. */
export interface SendAlertItem {
  id: string;
  /** What it asked NetSuite for: 'New invoice'. */
  what: string;
  at: string;
  who: string | null;
  /** Why FleetSuite isn't sure; none when it never heard back. */
  error: string | null;
}

const sentAt = (iso: string) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** A reason as a sentence of a notification's length, cut at a word. */
const shortReason = (text: string) => {
  const cut = text.length <= 160 ? text.trim() : `${text.slice(0, 160).replace(/\s+\S*$/, '')}…`;
  return /[.!?…]$/.test(cut) ? cut : `${cut}.`;
};

/**
 * What the super admins are told about sends to NetSuite FleetSuite isn't sure about: a notification for each, opening
 * it on the NetSuite feed, or with more than ONE_BY_ONE at a look one naming the first few, opening the feed.
 */
export function sendAlertsFor(items: SendAlertItem[]): CheckAlert[] {
  if (!items.length) return [];
  if (items.length > ONE_BY_ONE) {
    const names = listed([...items.slice(0, ONE_BY_ONE).map((i) => `the ${lowerFirst(i.what)}`), `${items.length - ONE_BY_ONE} more`]);
    return [{
      title: `NetSuite feed: ${items.length} sends FleetSuite isn't sure about`,
      body: `${names.charAt(0).toUpperCase()}${names.slice(1)}. NetSuite may have done them anyway, so look for each there before anyone tries again.`,
      url: deepLinks.booksNetsuiteFeed(),
      about: 'send',
    }];
  }
  return items.map((i) => ({
    title: `NetSuite feed: not sure about the ${lowerFirst(i.what)}`,
    body: `Sent ${sentAt(i.at)}${i.who ? ` by ${i.who}` : ''}: ${shortReason(i.error ?? 'FleetSuite never heard back from NetSuite.')} `
      + 'NetSuite may have done it anyway, so look for it there before anyone tries again.',
    url: deepLinks.booksNetsuiteFeed(i.id),
    about: 'send',
  }));
}

// ── Looking ────────────────────────────────────────────────────────────────

/** Months whose documents are looked up at once. */
const LOOKUPS = 4;

/**
 * One company's months that differ now, by the same comparison as Differences vs NetSuite, with what to name for each.
 * Once its books are live (`liveFrom`, src/lib/books/going-live.ts), the months before stay as they were and the opening
 * entry, which brings the books to NetSuite's numbers, stands in the last of them, so only the months since are looked at.
 */
async function lookAt(
  service: SupabaseClient,
  company: BooksCompany,
  liveFrom: string | null,
): Promise<{ now: DifferingMonths; facts: Map<string, MonthFacts> }> {
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
  const since = liveFrom ? monthOfDate(liveFrom)! : COPY_FROM;
  const differing = monthStatuses(indexMonths(data), posted, lastMonth(data, COPY_FROM))
    .filter((m) => m.status === 'differs' && m.month >= since);
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

/** How far apart an item's two counts are, rounded up to a whole one, so that counts drawing further apart are told about. */
const apart = (line: StockLine) => Math.max(1, Math.ceil(Math.abs(line.fleetsuite.quantity - line.netsuite.quantity) - 1e-6));

/** The items whose count differs from NetSuite's now, as Stock by item compares them; null before NetSuite's counts are read. */
async function lookAtStock(service: SupabaseClient): Promise<{ by: CountsBy; now: DifferingMonths; lines: Map<string, StockLine> } | null> {
  const res = await service.rpc('gl_stock_items');
  if (res.error) throw new Error(`couldn't compare the counts (${res.error.message})`);
  const compared = compareStock((res.data ?? {}) as StockItemsData);
  if (!compared.by) return null;
  const now: DifferingMonths = {};
  const lines = new Map<string, StockLine>();
  for (const line of compared.lines) {
    if (!line.countDiffers) continue;
    now[line.key] = apart(line);
    lines.set(line.key, line);
  }
  return { by: compared.by, now, lines };
}

/** One company's customers and vendors whose balance differs from NetSuite's now, by balanceKey, with their names. */
async function lookAtBalances(service: SupabaseClient, company: BooksCompany): Promise<{ now: DifferingMonths; names: Map<string, string> }> {
  const now: DifferingMonths = {};
  const names = new Map<string, string>();
  for (const kind of PARTY_KINDS) {
    const res = await service.rpc('gl_party_balances', { p_company: company, p_kind: kind });
    if (res.error) throw new Error(`couldn't compare the ${kind} balances (${res.error.message})`);
    for (const p of partyBalances(res.data as PartyBalancesData, kind).parties) {
      if (!p.differs) continue;
      // A balance that differs has a document that does; at least one, so it's told about.
      now[balanceKey(kind, p.party)] = Math.max(1, p.differing);
      names.set(balanceKey(kind, p.party), p.name);
    }
  }
  return { now, names };
}

/** The last day of a 'YYYY-MM-01' month. */
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** FleetSuite's own invoices that differ from NetSuite's now, as Own invoices checks them, by NetSuite's id for each. */
async function lookAtOwnInvoices(service: SupabaseClient): Promise<{ now: DifferingMonths; checks: Map<string, OwnInvoiceCheck> }> {
  const months = await service.rpc('gl_own_invoice_months');
  if (months.error) throw new Error(`couldn't list the months (${months.error.message})`);
  const now: DifferingMonths = {};
  const checks = new Map<string, OwnInvoiceCheck>();
  await runLimited(((months.data ?? []) as Array<{ month: string }>).map(({ month }) => async () => {
    const res = await service.rpc('gl_own_invoice_pairs', { p_from: month, p_to: monthEnd(month), p_netsuite_id: null });
    if (res.error) throw new Error(`couldn't check ${monthText(month)}'s invoices (${res.error.message})`);
    for (const check of checkOwnInvoices(res.data as OwnPairsData).invoices) {
      if (check.status !== 'differs') continue;
      now[check.netsuiteId] = Math.max(1, check.differing);
      checks.set(check.netsuiteId, check);
    }
  }), LOOKUPS);
  return { now, checks };
}

/** FleetSuite's own fulfillments that differ from NetSuite's now, as Own fulfillments checks them, by NetSuite's id for each. */
async function lookAtOwnFulfillments(
  service: SupabaseClient,
  copies: CopiesThrough,
): Promise<{ now: DifferingMonths; checks: Map<string, OwnFulfillmentCheck> }> {
  const months = await service.rpc('gl_own_fulfillment_months');
  if (months.error) throw new Error(`couldn't list the months (${months.error.message})`);
  const now: DifferingMonths = {};
  const checks = new Map<string, OwnFulfillmentCheck>();
  await runLimited(((months.data ?? []) as Array<{ month: string }>).map(({ month }) => async () => {
    const res = await service.rpc('gl_own_fulfillment_pairs', { p_from: month, p_to: monthEnd(month), p_netsuite_id: null });
    if (res.error) throw new Error(`couldn't check ${monthText(month)}'s fulfillments (${res.error.message})`);
    for (const check of checkOwnFulfillments(res.data as FulfilPairsData, copies).fulfillments) {
      if (check.status !== 'differs') continue;
      now[check.netsuiteId] = Math.max(1, check.differing);
      checks.set(check.netsuiteId, check);
    }
  }), LOOKUPS);
  return { now, checks };
}

/** Books' own bills that differ from NetSuite's now, as Own bills checks them, by NetSuite's id for each. */
async function lookAtOwnBills(
  service: SupabaseClient,
  copies: BillCopiesThrough,
): Promise<{ now: DifferingMonths; checks: Map<string, OwnBillCheck> }> {
  const months = await service.rpc('gl_own_bill_months');
  if (months.error) throw new Error(`couldn't list the months (${months.error.message})`);
  const now: DifferingMonths = {};
  const checks = new Map<string, OwnBillCheck>();
  await runLimited(((months.data ?? []) as Array<{ month: string }>).map(({ month }) => async () => {
    const res = await service.rpc('gl_own_bill_pairs', { p_from: month, p_to: monthEnd(month), p_netsuite_id: null });
    if (res.error) throw new Error(`couldn't check ${monthText(month)}'s bills (${res.error.message})`);
    for (const check of checkOwnBills(res.data as BillPairsData, copies).bills) {
      if (check.status !== 'differs') continue;
      now[check.netsuiteId] = Math.max(1, check.differing);
      checks.set(check.netsuiteId, check);
    }
  }), LOOKUPS);
  return { now, checks };
}

/** Books' own receipts that differ from NetSuite's item receipts now, as Own receipts checks them, by each one's key. */
async function lookAtOwnReceipts(
  service: SupabaseClient,
  copies: ReceiptCopiesThrough,
): Promise<{ now: DifferingMonths; checks: Map<string, OwnReceiptCheck> }> {
  const months = await service.rpc('gl_own_receipt_months');
  if (months.error) throw new Error(`couldn't list the months (${months.error.message})`);
  const now: DifferingMonths = {};
  const checks = new Map<string, OwnReceiptCheck>();
  await runLimited(((months.data ?? []) as Array<{ month: string }>).map(({ month }) => async () => {
    const res = await service.rpc('gl_own_receipt_pairs', { p_from: month, p_to: monthEnd(month), p_key: null });
    if (res.error) throw new Error(`couldn't check ${monthText(month)}'s receipts (${res.error.message})`);
    for (const check of checkOwnReceipts(res.data as ReceiptPairsData, copies).receipts) {
      if (check.status !== 'differs') continue;
      now[check.receiptKey] = Math.max(1, check.differing);
      checks.set(check.receiptKey, check);
    }
  }), LOOKUPS);
  return { now, checks };
}

/** The Inventory Adjusts that differ from NetSuite's adjustments now, as Own adjustments checks them, by FleetSuite's id for each. */
async function lookAtOwnAdjustments(
  service: SupabaseClient,
  copies: CopiesThrough,
): Promise<{ now: DifferingMonths; checks: Map<string, OwnAdjustmentCheck> }> {
  const months = await service.rpc('gl_own_adjustment_months');
  if (months.error) throw new Error(`couldn't list the months (${months.error.message})`);
  const now: DifferingMonths = {};
  const checks = new Map<string, OwnAdjustmentCheck>();
  await runLimited(((months.data ?? []) as Array<{ month: string }>).map(({ month }) => async () => {
    const res = await service.rpc('gl_own_adjustment_pairs', {
      p_from: month, p_to: monthEnd(month), p_id: null, p_account: INVENTORY_ADJUST_ACCOUNT,
    });
    if (res.error) throw new Error(`couldn't check ${monthText(month)}'s adjustments (${res.error.message})`);
    for (const check of checkOwnAdjustments(res.data as AdjustPairsData, copies).adjustments) {
      if (check.status !== 'differs') continue;
      now[check.id] = Math.max(1, check.differing);
      checks.set(check.id, check);
    }
  }), LOOKUPS);
  return { now, checks };
}

/** The likely mistakes open on Mistake checks, each counted once, with what to name for each. */
async function lookAtMistakes(service: SupabaseClient): Promise<{ now: DifferingMonths; items: Map<string, MistakeAlertItem> }> {
  const [rows, companies] = await Promise.all([
    fetchAllRows<{ id: string; company_id: string; kind: MistakeKind; party_name: string | null; why: string }>((from, to) => service
      .from('gl_mistake_checks')
      .select('id, company_id, kind, party_name, why')
      .eq('state', 'open')
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('gl_companies').select('id, code'),
  ]);
  if (rows.error) throw new Error(`couldn't read the open ones (${rows.error.message})`);
  if (companies.error) throw new Error(`couldn't read the companies (${companies.error.message})`);
  const codes = new Map(((companies.data ?? []) as Array<{ id: string; code: string }>).map((c) => [c.id, c.code]));
  const now: DifferingMonths = {};
  const items = new Map<string, MistakeAlertItem>();
  for (const r of rows.data) {
    const company = codes.get(r.company_id);
    if (!company || !POSTING_COMPANIES.includes(company as BooksCompany) || !MISTAKE_KINDS.includes(r.kind)) continue;
    now[r.id] = 1;
    items.set(r.id, { id: r.id, company: company as BooksCompany, kind: r.kind, party: r.party_name, why: r.why });
  }
  return { now, items };
}

/** The most sends one look tells about; any more are told about at the next. */
const SENDS_AT_A_LOOK = 200;

/**
 * The sends to NetSuite FleetSuite isn't sure about at `now` that nobody has looked for or been told about, oldest
 * first: NetSuite's answer didn't settle it, or none came within NO_ANSWER_MS.
 */
async function lookAtSends(service: SupabaseClient, now: Date): Promise<SendAlertItem[]> {
  type Row = { id: string; started_at: string; action: SendAction; record_type: string; made_type: string | null; error: string | null; user_id: string | null };
  const untold = () => service.from('netsuite_sends').select('id, started_at, action, record_type, made_type, error, user_id')
    .is('looked_at', null)
    .is('told_at', null);
  const [answered, unanswered] = await Promise.all([
    untold().eq('outcome', 'unsure')
      .order('started_at', { ascending: true }).order('id', { ascending: true }).limit(SENDS_AT_A_LOOK),
    untold().is('outcome', null).lt('started_at', new Date(now.getTime() - NO_ANSWER_MS).toISOString())
      .order('started_at', { ascending: true }).order('id', { ascending: true }).limit(SENDS_AT_A_LOOK),
  ]);
  const failed = answered.error ?? unanswered.error;
  if (failed) throw new Error(`couldn't read the sends (${failed.message})`);
  const rows = ([...(answered.data ?? []), ...(unanswered.data ?? [])] as Row[])
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id))
    .slice(0, SENDS_AT_A_LOOK);
  const names = await readNames(service, rows.map((r) => r.user_id));
  return rows.map((r) => ({
    id: r.id,
    what: describeSend(r),
    at: r.started_at,
    who: r.user_id ? names.get(r.user_id) ?? null : null,
    error: r.error,
  }));
}

/** Marks the sends told about, so no later look tells about them again. */
async function markSendsTold(service: SupabaseClient, ids: string[], at: Date): Promise<void> {
  const { error } = await service.from('netsuite_sends').update({ told_at: at.toISOString() }).in('id', ids).is('told_at', null);
  if (error) throw new Error(`couldn't mark the sends told about (${error.message})`);
}

/** The newest documents that differ of each balance a notification names one by one. */
async function balanceNews(
  service: SupabaseClient,
  company: BooksCompany,
  news: MonthNews[],
  names: Map<string, string>,
): Promise<BalanceNews[]> {
  const out = news.map((n): BalanceNews => ({
    ...partyOfKey(n.month), name: names.get(n.month) ?? '', documents: n.documents, before: n.before, named: [],
  }));
  if (out.length > ONE_BY_ONE) return out;
  await runLimited(out.map((n) => async () => {
    const res = await service.rpc('gl_party_documents', {
      p_company: company, p_kind: n.kind, p_party: n.party, p_differs: true, p_limit: NAMED,
    });
    // The notification does without them.
    if (!res.error && res.data) n.named = partyDetail(res.data as PartyDocumentsData, n.kind).rows.map((d) => d.number);
  }), LOOKUPS);
  return out;
}

export interface DailyCheckResult {
  look: Look;
  /** Months, items, balances, own invoices, fulfillments, bills, receipts and adjustments, likely mistakes and sends told about. */
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
  const read = (syncType: string) => service.from('sync_state').select('last_result, last_synced_at').eq('sync_type', syncType).maybeSingle();
  const [prev, posting, copy, stockCopy, billsCopy] = await Promise.all([
    read(BOOKS_DAILY_CHECK), read(BOOKS_INVOICE_POSTING), read(BOOKS_GL_SYNC), read(BOOKS_STOCK_SYNC), read(BOOKS_BILLS_SYNC),
  ]);
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
  // The day each company's books went live, for those that have.
  const live = await service.from('gl_companies').select('id, code, books_live_from');
  const companyRows = (live.data ?? []) as Array<{ id: string; code: string; books_live_from: string | null }>;
  const liveFrom = new Map(companyRows.map((c) => [c.code, c.books_live_from]));
  // The months closed in FleetSuite's books, of which a notification says NetSuite's change waits; without them it doesn't say.
  const closed = live.error
    ? new Map<BooksCompany, Set<string>>()
    : await readClosedMonths(service, new Map(companyRows.map((c) => [c.id, c.code]))).catch(() => new Map<BooksCompany, Set<string>>());
  for (const company of POSTING_COMPANIES) {
    try {
      if (live.error) throw new Error(`couldn't read the companies (${live.error.message})`);
      const { now, facts } = await lookAt(service, company, liveFrom.get(company) ?? null);
      const { check, news } = nextCheck(held.companies[company], now, opts.look);
      companies[company] = check;
      alerts.push(...alertsFor(company, news, facts, hint, closed.get(company)));
      told += news.length;
    } catch (err) {
      errors.push(`${company}: ${reason(err)}`);
    }
  }

  // Stock, when the last copy of NetSuite's stock moves read NetSuite's counts as it ended, so both counts are of then.
  let stock = held.stock;
  if (typeof (stockCopy.data?.last_result as { counts?: unknown } | null)?.counts === 'number') {
    try {
      const looked = await lookAtStock(service);
      if (looked) {
        // Counts read another way are keyed another way, so they start afresh.
        const { check, news } = nextCheck(held.stock?.by === looked.by ? held.stock : undefined, looked.now, opts.look);
        stock = { by: looked.by, ...check };
        alerts.push(...stockAlertsFor(news.map((n) => ({ line: looked.lines.get(n.month)!, further: n.before !== null }))));
        told += news.length;
      }
    } catch (err) {
      errors.push(`Stock: ${reason(err)}`);
    }
  }

  // Each customer's and vendor's balance, after the months, from the same posting run and copy.
  const balances: NonNullable<DailyCheckState['balances']> = { ...held.balances };
  for (const company of POSTING_COMPANIES) {
    try {
      const { now, names } = await lookAtBalances(service, company);
      const { check, news } = nextCheck(held.balances?.[company], now, opts.look);
      balances[company] = check;
      alerts.push(...balanceAlertsFor(company, await balanceNews(service, company, news, names), hint));
      told += news.length;
    } catch (err) {
      errors.push(`${company}'s balances: ${reason(err)}`);
    }
  }

  // FleetSuite's own invoices, against the copies of NetSuite's invoices and ledger. They start the day FleetSuite
  // began keeping them, so no difference is known before the check first looks: one is told about from the start.
  let own = held.own;
  try {
    const { now, checks } = await lookAtOwnInvoices(service);
    const { check, news } = nextCheck(held.own ?? { known: {}, noted: {} }, now, opts.look);
    own = check;
    alerts.push(...ownAlertsFor(news, checks));
    told += news.length;
  } catch (err) {
    errors.push(`Own invoices: ${reason(err)}`);
  }

  // FleetSuite's own fulfillments, against the copies of NetSuite's stock moves and ledger, as far as they had come.
  // They too start the day FleetSuite began keeping them.
  let fulfillments = held.fulfillments;
  try {
    const copies: CopiesThrough = {
      stock: (stockCopy.data?.last_synced_at as string | null | undefined) ?? null,
      ledger: (copy.data?.last_synced_at as string | null | undefined) ?? null,
    };
    const { now, checks } = await lookAtOwnFulfillments(service, copies);
    const { check, news } = nextCheck(held.fulfillments ?? { known: {}, noted: {} }, now, opts.look);
    fulfillments = check;
    alerts.push(...fulfillmentAlertsFor(news, checks));
    told += news.length;
  } catch (err) {
    errors.push(`Own fulfillments: ${reason(err)}`);
  }

  // Books' own bills, against the copies of NetSuite's bills and ledger, and its own receipts, against the copies of
  // its stock moves and ledger, as far as they had come. They too start the day Books began keeping them.
  const ledgerThrough = (copy.data?.last_synced_at as string | null | undefined) ?? null;
  let bills = held.bills;
  try {
    const copies: BillCopiesThrough = { bills: (billsCopy.data?.last_synced_at as string | null | undefined) ?? null, ledger: ledgerThrough };
    const { now, checks } = await lookAtOwnBills(service, copies);
    const { check, news } = nextCheck(held.bills ?? { known: {}, noted: {} }, now, opts.look);
    bills = check;
    alerts.push(...billAlertsFor(news, checks));
    told += news.length;
  } catch (err) {
    errors.push(`Own bills: ${reason(err)}`);
  }
  let receipts = held.receipts;
  try {
    const copies: ReceiptCopiesThrough = { stock: (stockCopy.data?.last_synced_at as string | null | undefined) ?? null, ledger: ledgerThrough };
    const { now, checks } = await lookAtOwnReceipts(service, copies);
    const { check, news } = nextCheck(held.receipts ?? { known: {}, noted: {} }, now, opts.look);
    receipts = check;
    alerts.push(...receiptAlertsFor(news, checks));
    told += news.length;
  } catch (err) {
    errors.push(`Own receipts: ${reason(err)}`);
  }

  // The Inventory Adjusts, against the copies of NetSuite's stock moves and ledger, as far as they had come. They
  // start the day Inventory Adjust began making them.
  let adjustments = held.adjustments;
  try {
    const copies: CopiesThrough = { stock: (stockCopy.data?.last_synced_at as string | null | undefined) ?? null, ledger: ledgerThrough };
    const { now, checks } = await lookAtOwnAdjustments(service, copies);
    const { check, news } = nextCheck(held.adjustments ?? { known: {}, noted: {} }, now, opts.look);
    adjustments = check;
    alerts.push(...adjustmentAlertsFor(news, checks));
    told += news.length;
  } catch (err) {
    errors.push(`Own adjustments: ${reason(err)}`);
  }

  // The likely mistakes nobody has cleared, from the night's look. They too start the day the check began to look.
  let mistakes = held.mistakes;
  try {
    const { now, items } = await lookAtMistakes(service);
    const { check, news } = nextCheck(held.mistakes ?? { known: {}, noted: {} }, now, opts.look);
    mistakes = check;
    alerts.push(...mistakeAlertsFor(news, items));
    told += news.length;
  } catch (err) {
    errors.push(`Mistake checks: ${reason(err)}`);
  }

  // The sends to NetSuite FleetSuite isn't sure about, each told about at the first look that finds it.
  let sends: SendAlertItem[] = [];
  try {
    sends = await lookAtSends(service, new Date());
    alerts.push(...sendAlertsFor(sends));
    told += sends.length;
  } catch (err) {
    errors.push(`NetSuite feed: ${reason(err)}`);
  }

  // Told before it's recorded: a send that fails leaves the record as it was, and the next morning tells again.
  if (alerts.length) await opts.tell(alerts);
  if (sends.length) {
    try {
      await markSendsTold(service, sends.map((s) => s.id), new Date());
    } catch (err) {
      errors.push(`NetSuite feed: ${reason(err)}`);
    }
  }
  const result: DailyCheckResult = { look: opts.look, told, ...(errors.length ? { error: errors.join(' ') } : {}) };
  const record = {
    ...result,
    companies,
    ...(stock ? { stock } : {}),
    ...(Object.keys(balances).length ? { balances } : {}),
    ...(own ? { own } : {}),
    ...(fulfillments ? { fulfillments } : {}),
    ...(bills ? { bills } : {}),
    ...(receipts ? { receipts } : {}),
    ...(adjustments ? { adjustments } : {}),
    ...(mistakes ? { mistakes } : {}),
  };
  const heartbeat = await recordHeartbeat(service, BOOKS_DAILY_CHECK, record, {
    startedAt,
    records: told,
    touchLastSyncedAt: !errors.length,
  });
  return { ...result, heartbeat };
}
