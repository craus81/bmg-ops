import {
  arCustomerKey, type AccountBalance, type AgingBucketKey, type ArAging, type OpenArInvoice, type OpenVendorBill, type OverdueAccount,
  type StatementInvoice,
} from '@/lib/financials-data';
import { pnlSummaryOf, type PnlPeriod, type PnlPeriodDef, type PnlSummary } from '@/lib/pnl';
import { BUCKETS } from './aging-buckets';
import type { AgedDocument, Agings } from './agings';
import { toCents } from './netsuite-gl';
import { lineSpan, type ReportAccount, type ReportData } from './reports';

/**
 * Home → Financials on FleetSuite's books (migration 504, docs/books.md
 * "Money screens"; the NetSuite Exit Checklist's "Money screens on
 * FleetSuite's books", thread "Replacing NetSuite with FleetSuite",
 * 2026-10-31). With the switch on, the tab's money reads BMG's books in
 * FleetSuite instead of NetSuite, so 1084's rent and mortgage no longer
 * show in BMG's profit and loss (NetSuite's income statement read has no
 * company in it):
 *
 *  - Cash, the cards and sales tax owed are the balance sheet's: each bank
 *    and credit card account the company's books use, and the accounts
 *    NetSuite posts sales tax to, with everything posted on them.
 *  - What customers owe and what BMG owes are AR and AP agings' (Books →
 *    AR and AP agings): the receivable and payable accounts' balances, their
 *    open invoices, credit memos, bills and bill credits aged by FleetSuite's
 *    due dates, and the rest "not in an open invoice": a payment not applied
 *    yet, a journal entry.
 *  - The profit and loss band sums each income and expense account's
 *    entries for the period's months, as Books → Reports does; collections
 *    are gl_books_collections'.
 *
 * The customer portal's billing reads the customers' agings here too, with
 * a switch of its own (migration 505, portalInvoices below).
 *
 * Amounts here are dollars, as the tab shows them; the books keep cents.
 */

/** Whose books the tab reads with the switch on: BMG's alone. */
export const MONEY_SCREENS_COMPANY = 'BMG';

/** Where the tab's numbers came from with the switch on. */
export interface BooksSource {
  company: string;
  name: string;
  /** When the posting run (every two hours) last ran, what went wrong if it did, and whether it stopped for time with documents left to post. */
  postedAt: string | null;
  postingError: string | null;
  postingPartial: boolean;
}

/** A document's page in NetSuite, or '' when there's no NetSuite to link to. */
export type DocLink = (page: 'custinvc' | 'custcred' | 'vendbill' | 'vendcred', id: string) => string;

const dollars = (cents: number) => cents / 100;
const keyOf = (a: ReportAccount) => a.netsuite_account_id ?? `fs:${a.id}`;
const collator = new Intl.Collator('en', { numeric: true });

export interface BooksAccountGroups {
  success: true;
  bank: AccountBalance[];
  card: AccountBalance[];
  ap: AccountBalance[];
  salesTax: AccountBalance[];
  /** The chart has accounts of each kind the company can use; sales tax's are known once NetSuite's lists are read. */
  has: { bank: boolean; card: boolean; ap: boolean; salesTax: boolean };
}

/**
 * Each bank, credit card and payable account the company's books can use,
 * and the accounts NetSuite posts sales tax to (`taxAccounts`, NetSuite's
 * ids; null before its lists are read), at their balance at the end of
 * `month` ('YYYY-MM-01') in FleetSuite's books, as the balance sheet shows
 * it: a bank account's money, a card's or a payable's what's owed. An
 * account with nothing on it isn't listed.
 */
export function accountGroups(data: ReportData, month: string, taxAccounts: readonly string[] | null): BooksAccountGroups {
  const usable = data.accounts.filter((a) => !a.company || a.company === data.company);
  const taxKeys = new Set(taxAccounts ?? []);
  const sorted = (list: ReportAccount[]) => [...list].sort((x, y) =>
    Number(x.number === null) - Number(y.number === null) || collator.compare(x.number ?? '', y.number ?? '') || collator.compare(x.name, y.name));
  const listed = (list: ReportAccount[]): AccountBalance[] => sorted(list)
    .map((a) => ({
      id: keyOf(a),
      name: a.number ? `${a.number} ${a.name}` : a.name,
      type: a.account_type,
      balance: dollars(lineSpan(data, 'balance_sheet', keyOf(a), { from: month, to: month }).ending.fleetsuite),
    }))
    .filter((a) => a.balance !== 0);
  const ofType = (type: string) => usable.filter((a) => a.account_type === type);
  const tax = usable.filter((a) => taxKeys.has(keyOf(a)));
  return {
    success: true,
    bank: listed(ofType('bank')),
    card: listed(ofType('credit_card')),
    ap: listed(ofType('accounts_payable')),
    salesTax: listed(tax),
    has: { bank: ofType('bank').length > 0, card: ofType('credit_card').length > 0, ap: ofType('accounts_payable').length > 0, salesTax: tax.length > 0 },
  };
}

/** The A/R tile and aging, from the customers' agings: the receivable accounts' balance, aged by its open documents. */
export interface BooksArAging extends ArAging {
  /** What the receivable accounts hold beyond their open invoices and credit memos: a payment not applied yet, a journal entry. */
  notOpen: number;
}

/** What a customer's or vendor's aging comes to on the tab, FleetSuite's side. */
export function arAging(customers: Agings): BooksArAging {
  const bucketCents = Object.fromEntries(BUCKETS.map((b) => [b, customers.totals.buckets[b].fleetsuite])) as Record<AgingBucketKey, number>;
  const balance = customers.totals.balance.fleetsuite;
  const aged = BUCKETS.reduce((sum, b) => sum + bucketCents[b], 0);
  const pastDue = aged - bucketCents.current;

  let openCount = 0;
  const overdue: OverdueAccount[] = [];
  for (const p of customers.parties) {
    let cents = 0;
    let days = 0;
    for (const d of p.documents) {
      if (!d.open.fleetsuite) continue;
      openCount += 1;
      if (d.bucket.fleetsuite === 'current') continue;
      cents += d.open.fleetsuite;
      // A credit memo ages from its date; it takes off what's past due, but how late an account is is its invoices'.
      if (d.open.fleetsuite > 0) days = Math.max(days, d.days.fleetsuite ?? 0);
    }
    if (cents > 0) overdue.push({ key: arCustomerKey({ entityId: p.party || null, customer: p.name }), customer: p.name, amount: dollars(cents), days });
  }
  overdue.sort((a, b) => b.amount - a.amount || a.customer.localeCompare(b.customer, 'en-US', { sensitivity: 'base' }) || a.key.localeCompare(b.key));

  return {
    total: dollars(balance),
    pastDue: dollars(pastDue),
    openCount,
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, dollars(bucketCents[b])])) as Record<AgingBucketKey, number>,
    topOverdue: overdue.slice(0, 6),
    notOpen: dollars(balance - aged),
  };
}

/** The tab's summary with the switch on: the shape /api/reports/financials answers with NetSuite's. */
export interface BooksFinancials {
  ar: BooksArAging;
  ap: { vendorBills: number; cardOwed: number; salesTax: number; total: number };
  cash: number;
  net: number;
  config: {
    balancesOk: true;
    balancesError: null;
    bankConfigured: boolean;
    cardConfigured: boolean;
    apConfigured: boolean;
    salesTaxConfigured: boolean;
  };
  books: BooksSource;
}

/**
 * The tiles: cash in the bank accounts, what customers owe, and what BMG
 * owes (the payable accounts' balance, `payables` in cents as the vendors'
 * agings read it, with what's owed on the cards and the sales tax
 * collected, a card or tax account in credit counting nothing), and the
 * net of them.
 */
export function booksFinancials(groups: BooksAccountGroups, customers: Agings, payables: number, source: BooksSource): BooksFinancials {
  const sum = (list: AccountBalance[], counts: (cents: number) => number) => list.reduce((total, a) => total + counts(toCents(a.balance)), 0);
  const owed = (cents: number) => Math.max(0, cents);
  const cash = sum(groups.bank, (cents) => cents);
  const cardOwed = sum(groups.card, owed);
  const salesTax = sum(groups.salesTax, owed);
  const total = payables + cardOwed + salesTax;
  return {
    ar: arAging(customers),
    ap: { vendorBills: dollars(payables), cardOwed: dollars(cardOwed), salesTax: dollars(salesTax), total: dollars(total) },
    cash: dollars(cash),
    net: dollars(cash + customers.totals.balance.fleetsuite - total),
    config: {
      balancesOk: true,
      balancesError: null,
      bankConfigured: groups.has.bank,
      cardConfigured: groups.has.card,
      apConfigured: groups.has.ap,
      salesTaxConfigured: groups.has.salesTax,
    },
    books: source,
  };
}

/** What's known of each document beyond its aging, by NetSuite's id: its total, as a positive amount, and its PO or memo. */
export interface DocumentFacts {
  total: number;
  note: string | null;
  /** NetSuite's id for an invoice's or credit memo's customer, as the ledger mirror copied it. */
  customer?: string | null;
}

/** One open invoice or credit memo, as the A/R list shows it, its customer named `customer` (`entityId`). */
function arRow(d: AgedDocument, customer: string, entityId: string | null, facts: ReadonlyMap<string, DocumentFacts>, link: DocLink): OpenArInvoice {
  const credit = d.type === 'CustCred';
  const unpaid = dollars(d.open.fleetsuite);
  const fact = facts.get(d.doc);
  return {
    id: d.doc,
    tranid: d.number ?? d.doc,
    date: d.date,
    dueDate: d.due.fleetsuite,
    po: fact?.note ?? null,
    customer,
    entityId,
    total: fact ? (credit ? -fact.total : fact.total) : unpaid,
    unpaid,
    daysPastDue: Math.max(0, d.days.fleetsuite ?? 0),
    bucket: d.bucket.fleetsuite,
    nsUrl: link(credit ? 'custcred' : 'custinvc', d.doc),
    ...(credit ? { creditMemo: true } : {}),
  };
}

/**
 * Every open invoice and credit memo in the customers' agings, as the A/R
 * list shows them: its open amount in FleetSuite's books (a credit memo's
 * negative), aged by FleetSuite's due date. A document's total and PO come
 * from `facts` (the copy of NetSuite's invoices); without them its total
 * is what's open.
 */
export function arRows(customers: Agings, facts: ReadonlyMap<string, DocumentFacts>, link: DocLink): OpenArInvoice[] {
  return customers.parties.flatMap((p) => p.documents.filter((d) => d.open.fleetsuite).map((d) => arRow(d, p.name, p.party || null, facts, link)));
}

/** Every open bill and bill credit in the vendors' agings, as the A/P list shows them; `facts` holds each one's total and memo. */
export function apRows(vendors: Agings, facts: ReadonlyMap<string, DocumentFacts>, link: DocLink): OpenVendorBill[] {
  return vendors.parties.flatMap((p) => p.documents.filter((d) => d.open.fleetsuite).map((d): OpenVendorBill => {
    const credit = d.type === 'VendCred';
    const unpaid = dollars(d.open.fleetsuite);
    const fact = facts.get(d.doc);
    return {
      id: d.doc,
      tranid: d.number ?? d.doc,
      date: d.date,
      dueDate: d.due.fleetsuite,
      vendor: p.name,
      memo: fact?.note ?? null,
      total: fact ? (credit ? -fact.total : fact.total) : unpaid,
      unpaid,
      daysPastDue: Math.max(0, d.days.fleetsuite ?? 0),
      nsUrl: link(credit ? 'vendcred' : 'vendbill', d.doc),
      ...(credit ? { billCredit: true } : {}),
    };
  }));
}

/**
 * One customer's open invoices in FleetSuite's books, for the customer
 * portal (migration 505, docs/books.md "The portal"), keyed as NetSuite's
 * open invoices are: on the customer's NetSuite id, never a name. An
 * invoice is theirs when NetSuite names them on it (`customerOf`, NetSuite's
 * id for each invoice's customer), whichever customer the agings have it
 * under, and what's open on it is FleetSuite's, added up over every one it's
 * under: while the ledger mirror's match of a NetSuite customer to a
 * FleetSuite one changes, an invoice's lines can sit under two. The portal
 * shows open invoices alone, as it does NetSuite's: credit memos, what's not
 * in an open invoice and an invoice NetSuite doesn't have aren't in it.
 */
export function portalInvoices(customers: Agings, netsuiteId: string, customerOf: ReadonlyMap<string, string>,
  facts: ReadonlyMap<string, DocumentFacts>, link: DocLink): StatementInvoice[] {
  const theirs = new Map<string, AgedDocument>();
  for (const d of customers.parties.flatMap((p) => p.documents)) {
    if (d.type !== 'CustInvc' || customerOf.get(d.doc) !== netsuiteId) continue;
    const seen = theirs.get(d.doc);
    theirs.set(d.doc, seen ? { ...seen, open: { ...seen.open, fleetsuite: seen.open.fleetsuite + d.open.fleetsuite } } : d);
  }
  return [...theirs.values()].filter((d) => d.open.fleetsuite > 0)
    .map((d) => ({ ...arRow(d, '', netsuiteId, facts, link), status: 'open' as const }));
}

/** How long after BMG's books last caught up with NetSuite the portal shows them: a day, a dozen runs missed. */
export const PORTAL_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * When BMG's books last caught up with NetSuite, the portal's "as of": the
 * earliest of the last full runs of the copy of NetSuite's general ledger,
 * the posting run and the copy of NetSuite's open items (each every two
 * hours; one that fails or stops for time leaves its time as it was).
 * Books that never caught up, or not in the last day, throw: the portal
 * says billing is unavailable rather than show what was owed days ago.
 */
export function portalAsOf(times: { copied: string | null; posted: string | null; open: string | null }, now: number): string {
  if (!times.copied) throw new Error("the copy of NetSuite's general ledger hasn't finished a run");
  if (!times.posted) throw new Error("the posting run hasn't finished a run");
  if (!times.open) throw new Error("the copy of NetSuite's open invoices hasn't finished a run");
  const at = Math.min(Date.parse(times.copied), Date.parse(times.posted), Date.parse(times.open));
  const asOf = new Date(at).toISOString();
  if (now - at > PORTAL_FRESH_MS) throw new Error(`the books haven't caught up with NetSuite since ${asOf}`);
  return asOf;
}

/** What the open documents leave of the accounts' balance, in dollars: the list's "not in an open invoice (bill)". */
export const notOpenOf = (agings: Agings) =>
  dollars(agings.totals.balance.fleetsuite - BUCKETS.reduce((sum, b) => sum + agings.totals.buckets[b].fleetsuite, 0));

/**
 * The profit and loss band's figures for the months from `from` through
 * `to` ('YYYY-MM-01') in FleetSuite's books: what each income and expense
 * account's entries came to, income and costs positive, payroll the
 * expense accounts in `payrollIds` (NetSuite's ids, as the chart keys them).
 */
export function booksPnl(data: ReportData, from: string, to: string, payrollIds: ReadonlySet<string>): PnlSummary {
  const typeOf = new Map(data.accounts.map((a) => [keyOf(a), a.account_type]));
  const moved = new Map<string, number>();
  for (const r of data.fleetsuite) {
    if (r.month >= from && r.month <= to) moved.set(r.account, (moved.get(r.account) ?? 0) + toCents(r.debit) - toCents(r.credit));
  }
  const parts = { income: 0, cogs: 0, expense: 0, payroll: 0, otherIncome: 0, otherExpense: 0 };
  let accounts = 0;
  for (const [key, cents] of moved) {
    const type = typeOf.get(key);
    if (!cents) continue;
    if (type === 'income') parts.income -= cents;
    else if (type === 'cost_of_goods_sold') parts.cogs += cents;
    else if (type === 'expense' && payrollIds.has(key)) parts.payroll += cents;
    else if (type === 'expense') parts.expense += cents;
    else if (type === 'other_income') parts.otherIncome -= cents;
    else if (type === 'other_expense') parts.otherExpense += cents;
    else continue;
    accounts += 1;
  }
  return pnlSummaryOf({
    income: dollars(parts.income),
    cogs: dollars(parts.cogs),
    expense: dollars(parts.expense),
    payroll: dollars(parts.payroll),
    otherIncome: dollars(parts.otherIncome),
    otherExpense: dollars(parts.otherExpense),
  }, accounts);
}

/**
 * Financial History's months from FleetSuite's books (src/lib/financial-history.ts):
 * each month given ('YYYY-MM') as the band works one out. Financial History
 * puts payroll in expenses, so none is set apart.
 */
export function booksMonths(data: ReportData, months: readonly string[]): Map<string, PnlSummary> {
  return new Map(months.map((month) => [month, booksPnl(data, `${month}-01`, `${month}-01`, new Set())]));
}

/** The month a day is in, 'YYYY-MM-01'. */
const monthOf = (day: string) => `${day.slice(0, 7)}-01`;

/**
 * One period of the band from FleetSuite's books: its months' profit and
 * loss, and what customers paid on its days (gl_books_collections). A
 * period that takes in today covers everything posted in its months so far.
 */
export function booksPnlPeriod(
  data: ReportData,
  def: PnlPeriodDef,
  payrollIds: ReadonlySet<string>,
  collections: { total: number; count: number } | null,
): PnlPeriod {
  return { ...def, pnl: booksPnl(data, monthOf(def.from), monthOf(def.to), payrollIds), collections, error: null };
}
