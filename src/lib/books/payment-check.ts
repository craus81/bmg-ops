import {
  booksCounts, centsOf, pickReceivable,
  type AccountAmount, type ChartAccount, type CheckStatus, type InvoiceBooks, type InvoiceRowView, type InvoiceView, type MonthCheck,
  type MonthReason, type MonthSummary, type NetSuitePosting, type Reason,
} from './invoice-check';
import { MAIN_LINE } from './invoice-rule';
import { DEPOSIT_LINE, DISCOUNT_LINE, RECEIVABLE_LINE, paymentEntry, type PaymentProblem } from './payment-rule';

/**
 * Each NetSuite customer payment checked against NetSuite (docs/books.md
 * "Payments"): FleetSuite's own entry from the payment rule next to the GL
 * lines NetSuite posted for the same payment (the copy, migration 361),
 * account by account, to the cent. Pure; amounts are whole cents, debit
 * positive.
 */

export interface PaymentRow {
  /** DEPOSIT_LINE, DISCOUNT_LINE, RECEIVABLE_LINE, or `account:<id>` for an account only NetSuite posts to. */
  lineId: string;
  /** What the account is to the payment: where its money went, the discount, receivables, or anything else NetSuite posts. */
  role: 'deposit' | 'discount' | 'receivable' | 'other';
  fleetsuite: AccountAmount | null;
  /** What NetSuite posted to the account for the payment, its lines on the account together. */
  netsuite: AccountAmount | null;
  same: boolean;
}

export interface CheckedPayment {
  status: CheckStatus;
  /** Why it's waiting: NetSuite's GL copy has nothing for it yet. */
  waiting?: 'gl';
  problems: PaymentProblem[];
  /** Where the money went, the discount, then receivables, then anything else NetSuite posts, in its order. */
  rows: PaymentRow[];
}

/** Income and expense accounts: a discount goes to one, the money never does (a bill payment's neither, src/lib/books/bill-payment-check.ts). */
const INCOME_STATEMENT = new Set(['income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense']);
export const onIncomeStatement = (account: string, accountTypes: Map<string, string>) => INCOME_STATEMENT.has(accountTypes.get(account) ?? '');

/**
 * Where a payment's money went, as NetSuite posted it: the account its main
 * line debits, the one the payment was deposited to. Should that line be
 * missing or a receivable, the one account outside receivables, income and
 * expenses NetSuite debits for it. Null when NetSuite's posting doesn't say.
 */
export function depositAccount(netsuite: NetSuitePosting[], accountTypes: Map<string, string>): string | null {
  const outside = netsuite.filter((p) => p.cents > 0 && accountTypes.get(p.account) !== 'accounts_receivable');
  const main = outside.find((p) => p.lineId === MAIN_LINE);
  if (main) return main.account;
  const accounts = [...new Set(outside.filter((p) => !onIncomeStatement(p.account, accountTypes)).map((p) => p.account))];
  return accounts.length === 1 ? accounts[0] : null;
}

/**
 * The discount the customer took, as NetSuite posted it: what NetSuite
 * debits, its lines on the account together, to the one income or expense
 * account it debits for the payment, other than where the money went. Null
 * when it debits none, or more than one, which then show as lines the
 * payment rule doesn't have.
 */
export function paymentDiscount(
  netsuite: NetSuitePosting[],
  accountTypes: Map<string, string>,
  deposit: string | null,
): { account: string; cents: number } | null {
  const debited = new Map<string, number>();
  for (const p of netsuite) {
    if (p.account !== deposit && onIncomeStatement(p.account, accountTypes)) debited.set(p.account, (debited.get(p.account) ?? 0) + p.cents);
  }
  const taken = [...debited].filter(([, cents]) => cents > 0);
  return taken.length === 1 ? { account: taken[0][0], cents: taken[0][1] } : null;
}

/** One payment. `cents` is its total, as the copy of the payment has it. */
export function checkPayment(
  payment: { cents: number | null; netsuite: NetSuitePosting[] },
  ctx: { receivable: string | null; accountTypes: Map<string, string> },
): CheckedPayment {
  if (payment.netsuite.length === 0 && payment.cents !== null && payment.cents !== 0) {
    return { status: 'waiting', waiting: 'gl', problems: [], rows: [] };
  }

  // NetSuite's lines, one amount to each account; an account they come to nothing on is the same as none.
  const posted = new Map<string, number>();
  for (const p of payment.netsuite) if (p.cents !== 0) posted.set(p.account, (posted.get(p.account) ?? 0) + p.cents);
  for (const [account, cents] of posted) if (cents === 0) posted.delete(account);

  const deposit = depositAccount(payment.netsuite, ctx.accountTypes);
  const discount = paymentDiscount(payment.netsuite, ctx.accountTypes, deposit);
  const entry = paymentEntry({ cents: payment.cents, depositAccount: deposit, discount }, ctx.receivable);
  const ours = new Map(entry.lines.map((l) => [l.lineId, l]));

  const rows: PaymentRow[] = [];
  const shown = new Set<string>();
  const row = (lineId: string, role: PaymentRow['role'], account: string | null) => {
    const f = ours.get(lineId);
    const at = f?.account ?? account;
    const n = at !== null && posted.has(at) && !shown.has(at) ? { account: at, cents: posted.get(at)! } : null;
    if (at !== null) shown.add(at);
    if (!f && !n) return;
    rows.push({
      lineId, role, fleetsuite: f ? { account: f.account, cents: f.cents } : null, netsuite: n, same: !!f && !!n && f.cents === n.cents,
    });
  };
  row(DEPOSIT_LINE, 'deposit', deposit);
  row(DISCOUNT_LINE, 'discount', discount?.account ?? null);
  row(RECEIVABLE_LINE, 'receivable', ctx.receivable);
  for (const [account, cents] of posted) {
    if (shown.has(account)) continue;
    rows.push({
      lineId: `account:${account}`,
      role: ctx.accountTypes.get(account) === 'accounts_receivable' ? 'receivable' : 'other',
      fleetsuite: null,
      netsuite: { account, cents },
      same: false,
    });
  }

  if (entry.problems.length) return { status: 'unworkable', problems: entry.problems, rows };
  return { status: rows.every((r) => r.same) ? 'matches' : 'differs', problems: [], rows };
}

// ── Reasons, in words ──────────────────────────────────────────────────────

export function paymentProblemReason(p: PaymentProblem): Reason {
  switch (p.kind) {
    case 'unreadable':
      return { key: 'unreadable', text: "The payment's amount couldn't be read from the copy of the payment." };
    case 'no_deposit_account':
      return { key: 'no_deposit_account', text: "NetSuite's posting of the payment doesn't say which account the money went to." };
    case 'no_receivable':
      return { key: 'no_receivable', text: 'The chart of accounts has no receivable account this company can use.' };
  }
}

/** Each distinct reason a payment doesn't match, in the order its rows come. `account` names a NetSuite account. */
export function paymentReasons(checked: CheckedPayment, account: (id: string) => string): Reason[] {
  const out = new Map<string, Reason>();
  const add = (r: Reason) => {
    if (!out.has(r.key)) out.set(r.key, r);
  };
  for (const p of checked.problems) add(paymentProblemReason(p));
  if (checked.status !== 'differs') return [...out.values()];

  const zero: Reason = { key: 'zero', text: 'The copy of the payment comes to $0, yet NetSuite posts it.' };
  const ours = checked.rows.find((r) => r.lineId === RECEIVABLE_LINE);
  const theirs = checked.rows.filter((r) => r.role === 'receivable' && !r.fleetsuite && r.netsuite).map((r) => r.netsuite!.account);
  const otherReceivable = !!ours?.fleetsuite && !ours.netsuite && theirs.length > 0;
  for (const r of checked.rows) {
    if (r.same) continue;
    const { fleetsuite: f, netsuite: n } = r;
    if (r.lineId === DEPOSIT_LINE) {
      if (!f) add(zero);
      else if (n) add({ key: 'deposit_amount', text: `The payment's total differs from what NetSuite put in ${account(n.account)}.` });
      else add({ key: 'deposit_none', text: `NetSuite put nothing in ${account(f.account)} for the payment.` });
    } else if (r.lineId === DISCOUNT_LINE) {
      const at = (f ?? n)!.account;
      add({ key: `discount|${at}`, text: `The discount differs from what NetSuite booked to ${account(at)}.` });
    } else if (r.lineId === RECEIVABLE_LINE) {
      if (!f) add(zero);
      else if (n) add({ key: 'receivable_amount', text: 'What FleetSuite takes off receivables differs from what NetSuite took off.' });
      else if (otherReceivable) {
        add({ key: `receivable|${f.account}|${theirs[0]}`, text: `Receivables: FleetSuite used ${account(f.account)}, NetSuite ${account(theirs[0])}.` });
      } else add({ key: 'receivable_none', text: 'NetSuite took nothing off receivables for the payment.' });
    } else if (!(r.role === 'receivable' && otherReceivable)) {
      add({ key: `other|${n!.account}`, text: `NetSuite also posts to ${account(n!.account)}, which the payment rule doesn't.` });
    }
  }
  return [...out.values()];
}

// ── A month ────────────────────────────────────────────────────────────────

/** What gl_payment_month (migration 374) returns: the month's customer payments. */
export interface PaymentMonthData {
  payments: Array<{
    id: string;
    netsuite_id: string;
    number: string | null;
    date: string;
    total: string;
    voided: boolean;
    customer: string | null;
    /** The FleetSuite customer the ledger mirror matched its NetSuite customer to; null when none. */
    customer_id?: string | null;
    /** Companies NetSuite posted it to; empty when the GL copy has none of it. */
    companies: string[];
    /** What it was applied to, as the ledger mirror copied it: each document's number (or NetSuite reference) and amount. */
    applied: Array<{ kind: string; number: string; amount: string }>;
    netsuite: Array<{ line_id: string; account: string; debit: string; credit: string }>;
  }>;
}

export interface PaymentView extends InvoiceView {
  /** What it paid, as the copy of the payment has it. */
  applied: Array<{ number: string; cents: number }>;
}

/** A month of payments, in the shape the invoices page shows a month in. */
export interface PaymentMonthCheck extends Omit<MonthCheck, 'invoices'> {
  invoices: PaymentView[];
}

const ROW_LABELS: Record<PaymentRow['role'], string> = {
  deposit: 'Deposited to', discount: 'Discount', receivable: 'Receivable', other: 'Other line',
};

/** What a payment was applied to, by number; one not copied yet goes by NetSuite's reference ('CustInvc/123'). */
const appliedName = (number: string) => {
  const ref = /^(CustInvc|CustCred)\/(\d+)$/.exec(number);
  return ref ? `NetSuite ${ref[1] === 'CustInvc' ? 'invoice' : 'credit memo'} ${ref[2]}` : number;
};

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** One payment of the month, worked out with the payment rule and checked against NetSuite. */
export interface WorkedPayment {
  payment: PaymentMonthData['payments'][number];
  number: string;
  checked: CheckedPayment;
}

/**
 * Every payment of the month worked out with the payment rule and checked:
 * what checkPaymentMonth shows, and what the posting job posts
 * (src/lib/books/invoice-posting.ts).
 */
export function workOutPaymentMonth(
  data: PaymentMonthData,
  opts: { company: string; chart: ChartAccount[] },
): { payments: WorkedPayment[]; account: (id: string) => string; receivableNote: string | null } {
  const accountTypes = new Map<string, string>();
  const accountNames = new Map<string, string>();
  for (const a of opts.chart) {
    if (!a.netsuite_account_id) continue;
    accountTypes.set(a.netsuite_account_id, a.account_type);
    accountNames.set(a.netsuite_account_id, [a.number, a.name].filter(Boolean).join(' '));
  }
  const account = (id: string) => accountNames.get(id) ?? `NetSuite account ${id}`;

  const postings = (p: PaymentMonthData['payments'][number]): NetSuitePosting[] =>
    p.netsuite.map((l) => ({ lineId: l.line_id, account: l.account, cents: (centsOf(l.debit) ?? 0) - (centsOf(l.credit) ?? 0) }));
  const receivable = pickReceivable(opts.chart, opts.company, data.payments.flatMap(postings), 'payments');
  const ctx = { receivable: receivable.account, accountTypes };

  const payments = data.payments.map((p): WorkedPayment => ({
    payment: p,
    number: p.number || `NetSuite ${p.netsuite_id}`,
    checked: checkPayment({ cents: centsOf(p.total), netsuite: postings(p) }, ctx),
  }));
  return { payments, account, receivableNote: receivable.note };
}

/**
 * One company's customer payments dated in one month, each checked against
 * NetSuite. `books`, when the company's payments post, says what
 * FleetSuite's books hold for each.
 */
export function checkPaymentMonth(
  data: PaymentMonthData,
  opts: { company: string; chart: ChartAccount[] },
  books?: (worked: WorkedPayment) => InvoiceBooks,
): PaymentMonthCheck {
  const { payments: worked, account, receivableNote } = workOutPaymentMonth(data, opts);

  const summary: MonthSummary = { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 };
  const reasons = new Map<string, MonthReason>();
  const views: PaymentView[] = [];
  const notInGl: string[] = [];
  const used = new Set<string>();
  for (const w of worked) {
    const { payment: p, number, checked } = w;
    if (p.companies.length === 0) {
      // In neither company's GL copy: only worth a word when FleetSuite would post it.
      if (checked.status !== 'matches') notInGl.push(number);
      continue;
    }

    const why = paymentReasons(checked, account);
    summary.invoices += 1;
    summary[checked.status] += 1;
    for (const r of why) {
      const m = reasons.get(r.key) ?? { ...r, invoices: 0, examples: [] };
      m.invoices += 1;
      if (m.examples.length < 5) m.examples.push(number);
      reasons.set(r.key, m);
    }

    const rows = checked.rows.map((r): InvoiceRowView => {
      if (r.fleetsuite) used.add(r.fleetsuite.account);
      if (r.netsuite) used.add(r.netsuite.account);
      return { lineId: r.lineId, label: ROW_LABELS[r.role], division: null, fleetsuite: r.fleetsuite, netsuite: r.netsuite, cost: false, same: r.same };
    });
    views.push({
      netsuiteId: p.netsuite_id,
      number,
      date: p.date,
      customer: p.customer,
      total: centsOf(p.total) ?? 0,
      voided: p.voided,
      status: checked.status,
      ...(checked.waiting ? { waiting: checked.waiting } : {}),
      reasons: why.map((r) => r.text),
      rows,
      applied: p.applied.map((a) => ({ number: appliedName(a.number), cents: centsOf(a.amount) ?? 0 })),
      ...(books ? { books: books(w) } : {}),
    });
  }

  if (books) Object.assign(summary, booksCounts(views));
  const notes: string[] = [];
  if (receivableNote) notes.push(receivableNote);
  if (notInGl.length) {
    const them = notInGl.length === 1 ? 'it' : 'them';
    notes.push(`${plural(notInGl.length, 'more payment', 'more payments')} dated this month ${notInGl.length === 1 ? "isn't" : "aren't"} in the copy `
      + `of NetSuite's GL for either company: ${notInGl.slice(0, 10).join(', ')}${notInGl.length > 10 ? ', …' : ''}. NetSuite may have deleted `
      + `${them}, or the copy, which runs every two hours, hasn't reached ${them} yet.`);
  }

  return {
    summary,
    reasons: [...reasons.values()].sort((a, b) => b.invoices - a.invoices || a.text.localeCompare(b.text)),
    notes,
    invoices: views,
    accounts: Object.fromEntries([...used].sort().map((id) => [id, account(id)])),
  };
}
