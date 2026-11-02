import type { AgingBucketKey, OpenArInvoice, OpenVendorBill } from '@/lib/financials-data';
import type { PnlSummary } from '@/lib/pnl';
import { BUCKETS } from './aging-buckets';
import type { Agings } from './agings';
import { booksPnl, type BooksAccountGroups, type BooksFinancials } from './money-screens';
import { COPY_FROM, monthsBetween } from './netsuite-gl';
import type { ReportData } from './reports';

/**
 * FleetSuite AI on FleetSuite's books (docs/books.md "The AI assistant"; the
 * NetSuite Exit Checklist's "Money screens on FleetSuite's books", thread
 * "Replacing NetSuite with FleetSuite"). With Financials on FleetSuite's
 * books on (money_screens, the switch Home → Financials and Financial
 * History read), the assistant (src/app/api/ai-agent/chat) answers money
 * questions from BMG's books, the numbers those screens show, rather than
 * NetSuite's:
 *
 *  - It asks the books by name, a "books" read with no SQL: the tab's
 *    summary, each customer's or vendor's balance and how late it is, the
 *    open invoices and bills, the accounts behind cash, and the profit and
 *    loss for months or month by month. Each is BMG's alone, as the tab's
 *    are, so 1084's books stay out of it, and open to whoever opens the tab
 *    (super admins and executives).
 *  - Its SuiteQL reading balances or what's open is refused, pointing at
 *    the books (readsNetSuiteBalances in src/lib/ai-agent-access.ts).
 *    NetSuite's documents themselves, sales orders and invoice lines, stay.
 *  - Each answer says when the books are as of: the last posting run, and
 *    whether it failed or stopped for time.
 *
 * With the switch off, nothing changes: the prompt has no books, and a
 * books read is refused.
 */

export const BOOKS_READS = ['summary', 'receivables', 'open_invoices', 'payables', 'open_bills', 'accounts', 'profit_and_loss', 'months'] as const;
export type BooksRead = (typeof BOOKS_READS)[number];

/** One read the assistant asks of the books. */
export interface BooksAsk {
  read: BooksRead;
  /** Part of a customer's or vendor's name, for the reads that take one. */
  name?: string;
  /** Months, 'YYYY-MM', for the profit and loss reads. */
  from?: string;
  to?: string;
}

/** One row of an answer, as the assistant reads it. */
export type BooksRow = Record<string, string | number | boolean | null>;

/** The months a profit and loss read covers, 'YYYY-MM-01'. */
export interface MonthRange {
  from: string;
  to: string;
}

/** The reads that take a name, and which. */
const NAME_OF: Partial<Record<BooksRead, 'customer' | 'vendor'>> = {
  receivables: 'customer',
  open_invoices: 'customer',
  payables: 'vendor',
  open_bills: 'vendor',
};

const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/** A read and its params as the assistant wrote them, checked; a name is trimmed to 80 characters. */
export function parseBooksAsk(read: unknown, params: unknown): BooksAsk | { error: string } {
  const asked = BOOKS_READS.find((r) => r === read);
  if (!asked) return { error: `FleetSuite's books answer these reads: ${BOOKS_READS.join(', ')}.` };
  const p = (params ?? {}) as Record<string, unknown>;
  const key = NAME_OF[asked];
  if (key) {
    const v = p[key];
    const name = typeof v === 'string' ? v.trim().slice(0, 80) : '';
    return name ? { read: asked, name } : { read: asked };
  }
  if (asked !== 'profit_and_loss' && asked !== 'months') return { read: asked };
  const ask: BooksAsk = { read: asked };
  for (const end of ['from', 'to'] as const) {
    const v = p[end];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !MONTH_RE.test(v.trim())) return { error: `"${end}" is a month written YYYY-MM, like 2026-10.` };
    ask[end] = v.trim();
  }
  if (ask.from && ask.to && ask.from > ask.to) return { error: '"from" comes after "to".' };
  return ask;
}

/**
 * The months a profit and loss read covers, within the books: from January
 * 2025 through `through` (Reports' latest month, never before this one).
 * "to" left out runs through this month when "from" is given; "from" left
 * out is "to" itself (profit_and_loss) or January of its year (months); both
 * left out, last month (`lastMonth`) or this year so far.
 */
export function monthsAsked(ask: BooksAsk, lastMonth: string, through: string): MonthRange | { error: string } {
  const months = ask.read === 'months';
  const to = ask.to ? `${ask.to}-01` : ask.from || months ? through : lastMonth;
  const from = ask.from ? `${ask.from}-01` : months ? `${to.slice(0, 4)}-01-01` : to;
  if (from < COPY_FROM) {
    return { error: "FleetSuite's books start in January 2025: the months before are QuickBooks', in Reports → Financial History." };
  }
  if (to > through || from > through) return { error: `FleetSuite's books have months from 2025-01 through ${through.slice(0, 7)}.` };
  return { from, to };
}

const dollars = (cents: number) => cents / 100;

const BUCKET_FIELDS: Readonly<Record<AgingBucketKey, string>> = {
  current: 'current',
  d1_30: 'days_1_30',
  d31_60: 'days_31_60',
  d61_90: 'days_61_90',
  d90plus: 'over_90_days',
};

const bucketFields = (amount: (bucket: AgingBucketKey) => number): BooksRow =>
  Object.fromEntries(BUCKETS.map((b) => [BUCKET_FIELDS[b], amount(b)]));

/** Letters and digits alone, lower case, so "Acme Fleet, Inc." is found by "acme fleet inc". */
const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const named = (name: string, part: string | undefined) => !part || plain(name).includes(plain(part));

/** The tab's tiles: cash, what customers owe and how late, what BMG owes and the net of them. */
export function summaryRow(f: BooksFinancials): BooksRow {
  return {
    cash: f.cash,
    customers_owe: f.ar.total,
    past_due: f.ar.pastDue,
    ...bucketFields((b) => f.ar.buckets[b]),
    not_in_an_open_invoice: f.ar.notOpen,
    open_invoices_and_credit_memos: f.ar.openCount,
    bmg_owes: f.ap.total,
    vendor_bills: f.ap.vendorBills,
    cards: f.ap.cardOwed,
    sales_tax: f.ap.salesTax,
    net: f.net,
  };
}

/**
 * Each customer's (vendor's) balance in FleetSuite's books and how late,
 * from AR and AP agings: the largest first, those whose name has `name` in
 * it, and none with nothing on it. How late an account is is its invoices'
 * (bills'): a credit ages from its date but takes off what's owed.
 */
export function partyRows(agings: Agings, name?: string): BooksRow[] {
  const who = agings.kind;
  return agings.parties
    .filter((p) => (p.balance.fleetsuite !== 0 || p.documents.some((d) => d.open.fleetsuite)) && named(p.name, name))
    .map((p): BooksRow => {
      const open = p.documents.filter((d) => d.open.fleetsuite);
      return {
        [who]: p.name,
        balance: dollars(p.balance.fleetsuite),
        ...bucketFields((b) => dollars(p.buckets[b].fleetsuite)),
        not_in_an_open_document: dollars(p.notOpen.fleetsuite),
        open_documents: open.length,
        most_days_past_due: open.reduce((most, d) => (d.open.fleetsuite > 0 ? Math.max(most, d.days.fleetsuite ?? 0) : most), 0),
      };
    })
    .sort((a, b) => Number(b.balance) - Number(a.balance) || String(a[who]).localeCompare(String(b[who]), 'en-US', { sensitivity: 'base' }));
}

/** The A/R list's open invoices and credit memos, in its order, those of customers whose name has `name` in it. */
export function invoiceRows(list: readonly OpenArInvoice[], name?: string): BooksRow[] {
  return list.filter((i) => named(i.customer, name)).map((i) => ({
    number: i.tranid,
    customer: i.customer,
    date: i.date,
    due: i.dueDate,
    po: i.po,
    total: i.total,
    open: i.unpaid,
    days_past_due: i.daysPastDue,
    ...(i.creditMemo ? { credit_memo: true } : {}),
  }));
}

/** The A/P list's open bills and bill credits, in its order, those of vendors whose name has `name` in it. */
export function billRows(list: readonly OpenVendorBill[], name?: string): BooksRow[] {
  return list.filter((b) => named(b.vendor, name)).map((b) => ({
    number: b.tranid,
    vendor: b.vendor,
    date: b.date,
    due: b.dueDate,
    memo: b.memo,
    total: b.total,
    open: b.unpaid,
    days_past_due: b.daysPastDue,
    ...(b.billCredit ? { bill_credit: true } : {}),
  }));
}

const ACCOUNT_KINDS = [['bank', 'bank'], ['card', 'credit card'], ['ap', 'payable'], ['salesTax', 'sales tax']] as const;

/** The accounts behind the tiles, each with its balance: a bank's money, a card's, payable's or sales tax's what's owed. */
export function accountRows(groups: BooksAccountGroups): BooksRow[] {
  return ACCOUNT_KINDS.flatMap(([key, kind]) => groups[key].map((a) => ({ kind, account: a.name, balance: a.balance })));
}

/** The profit and loss's parts as a row, income and costs positive; payroll apart only when its accounts are set. */
function pnlFields(s: PnlSummary, payroll: boolean): BooksRow {
  return {
    revenue: s.income,
    cost_of_sales: s.cogs,
    gross_profit: s.grossMargin,
    gross_margin_pct: s.grossMarginPct,
    ...(payroll ? { payroll: s.payroll } : {}),
    expenses: s.expense,
    other_income: s.otherIncome,
    other_expenses: s.otherExpense,
    net_income: s.netProfit,
    net_margin_pct: s.netProfitPct,
  };
}

/**
 * The months' profit and loss as one total, as the tab's band works it out
 * (booksPnl), and what customers paid in them (gl_books_collections); a
 * range taking in `thisMonth` ('YYYY-MM-01') isn't over yet.
 */
export function pnlRow(data: ReportData, range: MonthRange, payrollIds: ReadonlySet<string>,
  collections: { total: number; count: number } | null, thisMonth: string): BooksRow {
  return {
    from: range.from.slice(0, 7),
    to: range.to.slice(0, 7),
    ...pnlFields(booksPnl(data, range.from, range.to, payrollIds), payrollIds.size > 0),
    ...(collections ? { customers_paid: collections.total, payments: collections.count } : {}),
    ...(range.to >= thisMonth ? { not_over_yet: true } : {}),
  };
}

/** Each month's profit and loss, oldest first. */
export function monthRows(data: ReportData, range: MonthRange, payrollIds: ReadonlySet<string>, thisMonth: string): BooksRow[] {
  return monthsBetween(range.from, range.to).map((month) => ({
    month: month.slice(0, 7),
    ...pnlFields(booksPnl(data, month, month, payrollIds), payrollIds.size > 0),
    ...(month >= thisMonth ? { not_over_yet: true } : {}),
  }));
}

/** When the books' numbers are as of, for the assistant to pass on: the last posting run, and what went wrong with it. */
export function booksNote(posting: { at: string; error: string | null; partial: boolean } | null): string {
  const from = "From BMG's books in FleetSuite, as Home → Financials shows them";
  if (!posting) return `${from}. The posting run hasn't run yet, so documents NetSuite has may be missing: say so.`;
  const at = `${new Date(posting.at).toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })} Central`;
  if (posting.error) return `${from}. The last posting run, at ${at}, failed (${posting.error}), so they may be behind NetSuite: say so.`;
  if (posting.partial) return `${from}, as of the posting run at ${at}, which stopped for time with documents left to post, so they may be behind NetSuite: say so.`;
  return `${from}, as of the posting run at ${at} (it runs every two hours).`;
}

/** What the assistant is told when it asks the books while they aren't switched on. */
export const BOOKS_OFF = "FleetSuite's books aren't switched on for the assistant (Books → Switches → Financials on FleetSuite's books), so answer from NetSuite.";

/** What it's told when it asks NetSuite for balances or what's open once they are. */
export const BOOKS_INSTEAD =
  'Financials on FleetSuite\'s books is on, so balances and what\'s open come from FleetSuite\'s books, not NetSuite: ask with source "books" (summary, receivables, open_invoices, payables, open_bills or accounts).';

/** The prompt's NetSuite examples for what the books answer once they're on: A/R, A/P, revenue by month, overdue invoices. */
const NETSUITE_MONEY_EXAMPLES = /^- (?:AR|AP|Revenue by month|Overdue invoices): .*\n/gm;

export const BOOKS_PROMPT = `═══════════════════════════════════════════
FLEETSUITE'S BOOKS (source "books")
═══════════════════════════════════════════

Financials on FleetSuite's books is switched on, which overrides the rules above for money: answer money questions from BMG's books in FleetSuite, the numbers Home → Financials and Financial History show, not from NetSuite. That's cash and bank balances, what customers owe and what BMG owes, open and overdue invoices and bills, revenue, the profit and loss, expenses and what customers paid. NetSuite queries that read balances, GL lines or what's unpaid are refused while it's on. Sales orders, estimates, items, stock and the Upfit vs Graphics split of invoice lines still come from NetSuite, and payroll from the app database.

Ask the books by read name, with no SQL:
{"id": "owed", "source": "books", "read": "receivables"}
{"id": "acme", "source": "books", "read": "open_invoices", "params": {"customer": "acme"}}
{"id": "pl", "source": "books", "read": "profit_and_loss", "params": {"from": "2026-01", "to": "2026-10"}}

Reads:
- summary: cash, what customers owe and how late, what BMG owes (vendor bills, cards, sales tax) and the net of them.
- receivables: each customer's balance and how late it is, largest first. "customer": part of a name, optional.
- open_invoices: each open invoice and credit memo (number, customer, date, due date, PO, total, what's open, days past due), most overdue first. "customer" optional.
- payables: each vendor's balance and how late it is, largest first. "vendor" optional.
- open_bills: each open bill and bill credit (number, vendor, date, due date, memo, total, what's open, days past due), most overdue first. "vendor" optional.
- accounts: each bank, credit card, payable and sales tax account's balance.
- profit_and_loss: the months "from" through "to" (YYYY-MM) as one total: revenue, cost of sales, gross profit, payroll when it's set apart, expenses, other income and expenses, net income, and what customers paid. One month: give it as both. Only "from": through this month. Neither: last month.
- months: the same, month by month from "from" through "to". Neither: this year so far.

The books start in January 2025 and are BMG's alone: 1084's rent and mortgage aren't in them. Each result says when they last caught up with NetSuite; pass on any warning in it. For labor as a share of revenue, take revenue from the months read.`;

/** FleetSuite AI's prompt with the books switched on: NetSuite's money examples out, the books' reads in. */
export function withBooks(prompt: string): string {
  return `${prompt.replace(NETSUITE_MONEY_EXAMPLES, '')}\n\n${BOOKS_PROMPT}`;
}
