import {
  centsOf, entryDate,
  type AccountAmount, type ChartAccount, type CheckStatus, type InvoiceBooks, type InvoiceRowView, type InvoiceView, type MonthCheck,
  type MonthReason, type MonthSummary, type NetSuitePosting, type Reason,
} from './invoice-check';
import { MAIN_LINE, type RuleLine } from './invoice-rule';
import { PAYABLES_LINE } from './bill-rule';
import { pickPayables } from './bill-check';
import { onIncomeStatement } from './payment-check';
import { DISCOUNT_LINE, PAID_FROM_LINE, billPaymentEntry, type BillPaymentProblem } from './bill-payment-rule';

/**
 * Each NetSuite bill payment checked against NetSuite (docs/books.md "Bill
 * payments"): FleetSuite's own entry from the bill payment rule next to the
 * GL lines NetSuite posted for the same payment (the copy, migration 361),
 * account by account, to the cent, as customer payments are checked
 * (src/lib/books/payment-check.ts), and the entry the posting job posts for
 * it (src/lib/books/invoice-posting.ts). Pure; amounts are whole cents,
 * debit positive.
 */

export interface BillPaymentRow {
  /** PAYABLES_LINE, PAID_FROM_LINE, DISCOUNT_LINE, or `account:<id>` for an account only NetSuite posts to. */
  lineId: string;
  /** What the account is to the payment: payables, where the money came from, the discount, or anything else NetSuite posts. */
  role: 'payables' | 'paid_from' | 'discount' | 'other';
  fleetsuite: AccountAmount | null;
  /** What NetSuite posted to the account for the payment, its lines on the account together. */
  netsuite: AccountAmount | null;
  same: boolean;
}

export interface CheckedBillPayment {
  status: CheckStatus;
  /** Why it's waiting: NetSuite's GL copy has nothing for it yet. */
  waiting?: 'gl';
  problems: BillPaymentProblem[];
  /** Payables, where the money came from, the discount, then anything else NetSuite posts, in its order. */
  rows: BillPaymentRow[];
  /** The rule's entry line by line; empty when it's waiting or can't be worked out. */
  lines: RuleLine[];
}

/**
 * Where a bill payment's money came from, as NetSuite posted it: the account
 * its main line credits, the one it was paid from. Should that line be
 * missing or payables, the one account outside payables, income and
 * expenses NetSuite credits for it. Null when NetSuite's posting doesn't say.
 */
export function paidFromAccount(netsuite: NetSuitePosting[], accountTypes: Map<string, string>): string | null {
  const outside = netsuite.filter((p) => p.cents < 0 && accountTypes.get(p.account) !== 'accounts_payable');
  const main = outside.find((p) => p.lineId === MAIN_LINE);
  if (main) return main.account;
  const accounts = [...new Set(outside.filter((p) => !onIncomeStatement(p.account, accountTypes)).map((p) => p.account))];
  return accounts.length === 1 ? accounts[0] : null;
}

/**
 * The discount BMG took, as NetSuite posted it: what NetSuite credits, its
 * lines on the account together, to the one income or expense account it
 * credits for the payment, other than where the money came from; positive.
 * Null when it credits none, or more than one, which then show as lines the
 * bill payment rule doesn't have.
 */
export function billPaymentDiscount(
  netsuite: NetSuitePosting[],
  accountTypes: Map<string, string>,
  paidFrom: string | null,
): { account: string; cents: number } | null {
  const credited = new Map<string, number>();
  for (const p of netsuite) {
    if (p.account !== paidFrom && onIncomeStatement(p.account, accountTypes)) credited.set(p.account, (credited.get(p.account) ?? 0) - p.cents);
  }
  const taken = [...credited].filter(([, cents]) => cents > 0);
  return taken.length === 1 ? { account: taken[0][0], cents: taken[0][1] } : null;
}

/** One bill payment. `cents` is the money paid, as the copy of the payment has it. */
export function checkBillPayment(
  payment: { cents: number | null; netsuite: NetSuitePosting[] },
  ctx: { payables: string | null; accountTypes: Map<string, string> },
): CheckedBillPayment {
  if (payment.netsuite.length === 0 && payment.cents !== null && payment.cents !== 0) {
    return { status: 'waiting', waiting: 'gl', problems: [], rows: [], lines: [] };
  }

  // NetSuite's lines, one amount to each account; an account they come to nothing on is the same as none.
  const posted = new Map<string, number>();
  for (const p of payment.netsuite) if (p.cents !== 0) posted.set(p.account, (posted.get(p.account) ?? 0) + p.cents);
  for (const [account, cents] of posted) if (cents === 0) posted.delete(account);

  const paidFrom = paidFromAccount(payment.netsuite, ctx.accountTypes);
  const discount = billPaymentDiscount(payment.netsuite, ctx.accountTypes, paidFrom);
  const entry = billPaymentEntry({ cents: payment.cents, paidFrom, discount }, ctx.payables);
  const ours = new Map(entry.lines.map((l) => [l.lineId, l]));

  const rows: BillPaymentRow[] = [];
  const shown = new Set<string>();
  const row = (lineId: string, role: BillPaymentRow['role'], account: string | null) => {
    const f = ours.get(lineId);
    const at = f?.account ?? account;
    const n = at !== null && posted.has(at) && !shown.has(at) ? { account: at, cents: posted.get(at)! } : null;
    if (at !== null) shown.add(at);
    if (!f && !n) return;
    rows.push({
      lineId, role, fleetsuite: f ? { account: f.account, cents: f.cents } : null, netsuite: n, same: !!f && !!n && f.cents === n.cents,
    });
  };
  row(PAYABLES_LINE, 'payables', ctx.payables);
  row(PAID_FROM_LINE, 'paid_from', paidFrom);
  row(DISCOUNT_LINE, 'discount', discount?.account ?? null);
  for (const [account, cents] of posted) {
    if (shown.has(account)) continue;
    rows.push({
      lineId: `account:${account}`,
      role: ctx.accountTypes.get(account) === 'accounts_payable' ? 'payables' : 'other',
      fleetsuite: null,
      netsuite: { account, cents },
      same: false,
    });
  }

  if (entry.problems.length) return { status: 'unworkable', problems: entry.problems, rows, lines: [] };
  return { status: rows.every((r) => r.same) ? 'matches' : 'differs', problems: [], rows, lines: entry.lines };
}

// ── Reasons, in words ──────────────────────────────────────────────────────

export function billPaymentProblemReason(p: BillPaymentProblem): Reason {
  switch (p.kind) {
    case 'unreadable':
      return { key: 'unreadable', text: "The payment's total couldn't be read from the copy of the bill payment." };
    case 'no_paid_from':
      return { key: 'no_paid_from', text: "NetSuite's posting of the bill payment doesn't say which account the money came from." };
    case 'no_payables':
      return { key: 'no_payables', text: 'The chart of accounts has no payables account this company can use.' };
  }
}

/** Each distinct reason a bill payment doesn't match, in the order its rows come. `account` names a NetSuite account. */
export function billPaymentReasons(checked: CheckedBillPayment, account: (id: string) => string): Reason[] {
  const out = new Map<string, Reason>();
  const add = (r: Reason) => {
    if (!out.has(r.key)) out.set(r.key, r);
  };
  for (const p of checked.problems) add(billPaymentProblemReason(p));
  if (checked.status !== 'differs') return [...out.values()];

  const zero: Reason = { key: 'zero', text: 'The copy of the bill payment comes to $0, yet NetSuite posts it.' };
  const ours = checked.rows.find((r) => r.lineId === PAYABLES_LINE);
  const theirs = checked.rows.filter((r) => r.role === 'payables' && !r.fleetsuite && r.netsuite).map((r) => r.netsuite!.account);
  const otherPayables = !!ours?.fleetsuite && !ours.netsuite && theirs.length > 0;
  for (const r of checked.rows) {
    if (r.same) continue;
    const { fleetsuite: f, netsuite: n } = r;
    if (r.lineId === PAYABLES_LINE) {
      if (!f) add(zero);
      else if (n) add({ key: 'payables_amount', text: 'What FleetSuite takes off payables differs from what NetSuite took off.' });
      else if (otherPayables) {
        add({ key: `payables|${f.account}|${theirs[0]}`, text: `Payables: FleetSuite used ${account(f.account)}, NetSuite ${account(theirs[0])}.` });
      } else add({ key: 'payables_none', text: 'NetSuite took nothing off payables for the bill payment.' });
    } else if (r.lineId === PAID_FROM_LINE) {
      if (!f) add(zero);
      else if (n) add({ key: 'paid_from_amount', text: `The payment's total differs from what NetSuite took out of ${account(n.account)}.` });
      else add({ key: 'paid_from_none', text: `NetSuite took nothing out of ${account(f.account)} for the bill payment.` });
    } else if (r.lineId === DISCOUNT_LINE) {
      const at = (f ?? n)!.account;
      add({ key: `discount|${at}`, text: `The discount differs from what NetSuite booked to ${account(at)}.` });
    } else if (!(r.role === 'payables' && otherPayables)) {
      add({ key: `other|${n!.account}`, text: `NetSuite also posts to ${account(n!.account)}, which the bill payment rule doesn't.` });
    }
  }
  return [...out.values()];
}

// ── A month ────────────────────────────────────────────────────────────────

/** A document a bill payment paid, as the copy has it; the amount positive. */
export interface PaidDocument {
  netsuite_id: string;
  type: string | null;
  number: string | null;
  amount: string | null;
}

/** What gl_bill_payment_month (migration 389) returns: the month's bill payments. */
export interface BillPaymentMonthData {
  payments: Array<{
    netsuite_id: string;
    number: string | null;
    date: string;
    /** The month NetSuite booked it to, 'YYYY-MM-01'; null when the GL copy has none of it. */
    posting_month?: string | null;
    total: string;
    voided: boolean;
    /** NetSuite's status for it, in its words; null when NetSuite wouldn't give it. */
    status: string | null;
    vendor: string | null;
    vendor_netsuite_id: string | null;
    /** The vendor's own payables account, from the copy of NetSuite's vendors; null when it has none. */
    vendor_payables: string | null;
    /** Companies NetSuite posted it to; empty when the GL copy has none of it. */
    companies: string[];
    /** The bills, and any bill credits, it paid; null until they've been copied. */
    links: PaidDocument[] | null;
    netsuite: Array<{ line_id: string; account: string; debit: string; credit: string }>;
  }>;
  /** Bill payments the GL copy has in the month that the copy of the payments doesn't. */
  not_copied: Array<{ netsuite_id: string; type: string; number: string | null }>;
}

export interface BillPaymentView extends InvoiceView {
  type: 'VendPymt';
  /** NetSuite's status for it, in its words. */
  netsuiteStatus?: string;
  /** What it paid, as the copy of the payment has it. */
  applied: Array<{ number: string; cents: number | null }>;
}

/** A month of bill payments, in the shape the invoices page shows a month in. */
export interface BillPaymentMonthCheck extends Omit<MonthCheck, 'invoices'> {
  invoices: BillPaymentView[];
}

const ROW_LABELS: Record<BillPaymentRow['role'], string> = {
  payables: 'Payables', paid_from: 'Paid from', discount: 'Discount', other: 'Other line',
};

/** What a paid document is called: its number (a bill credit's said to be one), or NetSuite's id when the copy has no number. */
const DOC_WORDS: Record<string, string> = { VendBill: 'bill', VendCred: 'bill credit' };
const paidName = (d: PaidDocument) => (d.number
  ? (d.type === 'VendCred' ? `bill credit ${d.number}` : d.number)
  : `NetSuite ${DOC_WORDS[d.type ?? ''] ?? 'document'} ${d.netsuite_id}`);

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const listed = (numbers: string[]) => `${numbers.slice(0, 10).join(', ')}${numbers.length > 10 ? ', …' : ''}`;

/** One bill payment of the month, worked out with the bill payment rule and checked against NetSuite. */
export interface WorkedBillPayment {
  payment: BillPaymentMonthData['payments'][number];
  number: string;
  checked: CheckedBillPayment;
}

/**
 * Every bill payment of the month worked out with the bill payment rule and
 * checked: what checkBillPaymentMonth shows. Payables are picked as the bill
 * rule picks them: the vendor's own when the company can use it, else the
 * company's only one, or the one NetSuite's bill payments used most this
 * month.
 */
export function workOutBillPaymentMonth(
  data: BillPaymentMonthData,
  opts: { company: string; chart: ChartAccount[] },
): { payments: WorkedBillPayment[]; account: (id: string) => string; notes: string[] } {
  const accountTypes = new Map<string, string>();
  const accountNames = new Map<string, string>();
  for (const a of opts.chart) {
    if (!a.netsuite_account_id) continue;
    accountTypes.set(a.netsuite_account_id, a.account_type);
    accountNames.set(a.netsuite_account_id, [a.number, a.name].filter(Boolean).join(' '));
  }
  const account = (id: string) => accountNames.get(id) ?? `NetSuite account ${id}`;

  const postings = (p: BillPaymentMonthData['payments'][number]): NetSuitePosting[] =>
    p.netsuite.map((l) => ({ lineId: l.line_id, account: l.account, cents: (centsOf(l.debit) ?? 0) - (centsOf(l.credit) ?? 0) }));
  const payables = pickPayables(opts.chart, opts.company, data.payments.flatMap(postings), account, 'bill payments');
  const notes: string[] = [];
  if (data.payments.length && payables.note) notes.push(payables.note);

  const payments = data.payments.map((p): WorkedBillPayment => ({
    payment: p,
    number: p.number || `NetSuite ${p.netsuite_id}`,
    checked: checkBillPayment(
      { cents: centsOf(p.total), netsuite: postings(p) },
      { payables: p.vendor_payables && payables.candidates.has(p.vendor_payables) ? p.vendor_payables : payables.fallback, accountTypes },
    ),
  }));
  return { payments, account, notes };
}

/**
 * One company's bill payments for one month, each checked against NetSuite.
 * `books`, when the company's bill payments post, says what FleetSuite's
 * books hold for each.
 */
export function checkBillPaymentMonth(
  data: BillPaymentMonthData,
  opts: { company: string; chart: ChartAccount[] },
  books?: (worked: WorkedBillPayment) => InvoiceBooks,
): BillPaymentMonthCheck {
  const { payments: worked, account, notes } = workOutBillPaymentMonth(data, opts);

  const summary: MonthSummary = { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 };
  const reasons = new Map<string, MonthReason>();
  const views: BillPaymentView[] = [];
  const notInGl: string[] = [];
  const moved: string[] = [];
  const used = new Set<string>();
  for (const w of worked) {
    const { payment: p, number, checked } = w;
    if (p.companies.length === 0) {
      // In neither company's GL copy: only worth a word when FleetSuite would post it.
      if (checked.status !== 'matches') notInGl.push(number);
      continue;
    }

    const why = billPaymentReasons(checked, account);
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
    const bookedInto = p.posting_month && p.posting_month.slice(0, 7) !== p.date.slice(0, 7) ? p.posting_month : null;
    if (bookedInto) moved.push(number);
    views.push({
      netsuiteId: p.netsuite_id,
      number,
      date: p.date,
      ...(bookedInto ? { booked: { month: bookedInto, date: entryDate(p) } } : {}),
      customer: p.vendor,
      total: centsOf(p.total) ?? 0,
      voided: p.voided,
      status: checked.status,
      ...(checked.waiting ? { waiting: checked.waiting } : {}),
      reasons: why.map((r) => r.text),
      rows,
      type: 'VendPymt',
      ...(p.status ? { netsuiteStatus: p.status } : {}),
      applied: (p.links ?? []).map((d) => ({ number: paidName(d), cents: d.amount === null ? null : centsOf(d.amount) })),
      ...(books ? { books: books(w) } : {}),
    });
  }

  if (books) {
    summary.posted = views.filter((v) => v.books && v.books.entryNo !== null).length;
    summary.pending = views.filter((v) => v.books?.next).length;
  }

  if (moved.length) {
    const them = moved.length === 1 ? 'it' : 'them';
    notes.push(`${plural(moved.length, 'bill payment dated in another month is', 'bill payments dated in other months are')} here `
      + `because NetSuite booked ${them} into this month: ${listed(moved)}.`);
  }
  if (notInGl.length) {
    const them = notInGl.length === 1 ? 'it' : 'them';
    notes.push(`${plural(notInGl.length, 'more bill payment', 'more bill payments')} dated this month `
      + `${notInGl.length === 1 ? "isn't" : "aren't"} in the copy of NetSuite's GL for either company: ${listed(notInGl)}. NetSuite may have `
      + `voided or deleted ${them}, or the copy, which runs every two hours, hasn't reached ${them} yet.`);
  }
  const missing = (data.not_copied ?? []).map((m) => m.number || `NetSuite ${m.netsuite_id}`);
  if (missing.length) {
    const them = missing.length === 1 ? 'it' : 'them';
    notes.push(`The copy of NetSuite's GL has ${plural(missing.length, 'bill payment', 'bill payments')} of this company's booked into `
      + `this month that the copy of the bill payments doesn't: ${listed(missing)}. The bill payments copy runs every two hours and may not `
      + `have reached ${them} yet, or NetSuite deleted ${them} and the GL copy hasn't caught up.`);
  }

  return {
    summary,
    reasons: [...reasons.values()].sort((a, b) => b.invoices - a.invoices || a.text.localeCompare(b.text)),
    notes,
    invoices: views,
    accounts: Object.fromEntries([...used].sort().map((id) => [id, account(id)])),
  };
}
