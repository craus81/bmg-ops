import {
  booksCounts, centsOf, pickReceivable,
  type AccountAmount, type ChartAccount, type CheckStatus, type InvoiceBooks, type InvoiceRowView, type InvoiceView, type MonthCheck,
  type MonthReason, type MonthSummary, type NetSuitePosting, type Reason,
} from './invoice-check';
import { depositAccount } from './payment-check';
import { RECEIVABLE_LINE } from './payment-rule';
import { DEPOSITS_LINE, MONEY_LINE, depositEntry, type DepositProblem, type DepositType } from './deposit-rule';

/**
 * Each NetSuite customer deposit and deposit application checked against
 * NetSuite (docs/books.md "Customer deposits"): FleetSuite's own entry from
 * the deposit rule next to the GL lines NetSuite posted for the same
 * document (the copy, migration 361), account by account, to the cent, as
 * payments are checked (src/lib/books/payment-check.ts). Pure; amounts are
 * whole cents, debit positive.
 */

export interface DepositRow {
  /** MONEY_LINE, DEPOSITS_LINE, RECEIVABLE_LINE, or `account:<id>` for an account only NetSuite posts to. */
  lineId: string;
  /** What the account is to the document: where a deposit's money went, customer deposits, receivables, or anything else NetSuite posts. */
  role: 'money' | 'deposits' | 'receivable' | 'other';
  fleetsuite: AccountAmount | null;
  /** What NetSuite posted to the account for the document, its lines on the account together. */
  netsuite: AccountAmount | null;
  same: boolean;
}

export interface CheckedDeposit {
  status: CheckStatus;
  /** Why it's waiting: NetSuite's GL copy has nothing for it yet. */
  waiting?: 'gl';
  problems: DepositProblem[];
  /** The rule's lines in its order, then anything else NetSuite posts, in its order. */
  rows: DepositRow[];
}

/** Income and expense accounts: customer deposits are never held in one. */
const INCOME_STATEMENT = new Set(['income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense']);

/**
 * The account that holds what customers paid ahead, for one company: the
 * one NetSuite's deposits credit and its deposit applications debit, for
 * the most of the company's documents in the GL copy (gl_deposit_month's
 * `accounts`, migration 382). A receivable, income or expense account is
 * never it. With more than one in use, the note says which was taken. Null
 * when the GL copy has no deposit of the company's yet.
 */
export function pickDepositsAccount(
  usage: Array<{ account: string; documents: number }>,
  company: string,
  accountTypes: Map<string, string>,
  name: (id: string) => string,
): { account: string | null; note: string | null } {
  const candidates = usage
    .filter((u) => u.documents > 0 && accountTypes.get(u.account) !== 'accounts_receivable'
      && !INCOME_STATEMENT.has(accountTypes.get(u.account) ?? ''))
    .sort((a, b) => b.documents - a.documents || Number(a.account) - Number(b.account));
  if (candidates.length === 0) return { account: null, note: null };
  const pick = candidates[0].account;
  if (candidates.length === 1) return { account: pick, note: null };
  return {
    account: pick,
    note: `NetSuite's customer deposits for ${company} use ${candidates.length} accounts, so FleetSuite took ${name(pick)}, the one most of them use.`,
  };
}

/** One customer deposit or deposit application. `cents` is its total, as the copy of it has it. */
export function checkDeposit(
  doc: { type: DepositType; cents: number | null; netsuite: NetSuitePosting[] },
  ctx: { deposits: string | null; receivable: string | null; accountTypes: Map<string, string> },
): CheckedDeposit {
  if (doc.netsuite.length === 0 && doc.cents !== null && doc.cents !== 0) {
    return { status: 'waiting', waiting: 'gl', problems: [], rows: [] };
  }

  // NetSuite's lines, one amount to each account; an account they come to nothing on is the same as none.
  const posted = new Map<string, number>();
  for (const p of doc.netsuite) if (p.cents !== 0) posted.set(p.account, (posted.get(p.account) ?? 0) + p.cents);
  for (const [account, cents] of posted) if (cents === 0) posted.delete(account);

  const money = doc.type === 'CustDep' ? depositAccount(doc.netsuite, ctx.accountTypes) : null;
  const entry = depositEntry({ type: doc.type, cents: doc.cents, moneyAccount: money }, { deposits: ctx.deposits, receivable: ctx.receivable });
  const ours = new Map(entry.lines.map((l) => [l.lineId, l]));

  const rows: DepositRow[] = [];
  const shown = new Set<string>();
  const row = (lineId: string, role: DepositRow['role'], account: string | null) => {
    const f = ours.get(lineId);
    const at = f?.account ?? account;
    const n = at !== null && posted.has(at) && !shown.has(at) ? { account: at, cents: posted.get(at)! } : null;
    if (at !== null) shown.add(at);
    if (!f && !n) return;
    rows.push({
      lineId, role, fleetsuite: f ? { account: f.account, cents: f.cents } : null, netsuite: n, same: !!f && !!n && f.cents === n.cents,
    });
  };
  if (doc.type === 'CustDep') {
    row(MONEY_LINE, 'money', money);
    row(DEPOSITS_LINE, 'deposits', ctx.deposits);
  } else {
    row(DEPOSITS_LINE, 'deposits', ctx.deposits);
    row(RECEIVABLE_LINE, 'receivable', ctx.receivable);
  }
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

const DOC: Record<DepositType, string> = { CustDep: 'deposit', DepAppl: 'application' };

export function depositProblemReason(p: DepositProblem, type: DepositType): Reason {
  switch (p.kind) {
    case 'unreadable':
      return { key: `unreadable|${type}`, text: `The ${DOC[type]}'s amount couldn't be read from the copy of it.` };
    case 'no_money_account':
      return { key: 'no_money_account', text: "NetSuite's posting of the deposit doesn't say which account the money went to." };
    case 'no_deposits_account':
      return {
        key: 'no_deposits_account',
        text: "FleetSuite can't tell which account holds customer deposits: the copy of NetSuite's GL has no deposit of this company's yet.",
      };
    case 'no_receivable':
      return { key: 'no_receivable', text: 'The chart of accounts has no receivable account this company can use.' };
  }
}

/** Each distinct reason a document doesn't match, in the order its rows come. `account` names a NetSuite account. */
export function depositReasons(checked: CheckedDeposit, type: DepositType, account: (id: string) => string): Reason[] {
  const out = new Map<string, Reason>();
  const add = (r: Reason) => {
    if (!out.has(r.key)) out.set(r.key, r);
  };
  for (const p of checked.problems) add(depositProblemReason(p, type));
  if (checked.status !== 'differs') return [...out.values()];

  const zero: Reason = { key: `zero|${type}`, text: `The copy of the ${DOC[type]} comes to $0, yet NetSuite posts it.` };
  // NetSuite booked the customer deposits side, or the receivable, to another account than FleetSuite's: one reason, not two.
  const deposits = checked.rows.find((r) => r.lineId === DEPOSITS_LINE);
  const side = type === 'CustDep' ? -1 : 1;
  const theirDeposits = checked.rows
    .filter((r) => r.role === 'other' && !r.fleetsuite && r.netsuite && Math.sign(r.netsuite.cents) === side)
    .map((r) => r.netsuite!.account);
  const otherDeposits = !!deposits?.fleetsuite && !deposits.netsuite && theirDeposits.length > 0;
  const receivable = checked.rows.find((r) => r.lineId === RECEIVABLE_LINE);
  const theirReceivables = checked.rows.filter((r) => r.role === 'receivable' && !r.fleetsuite && r.netsuite).map((r) => r.netsuite!.account);
  const otherReceivable = !!receivable?.fleetsuite && !receivable.netsuite && theirReceivables.length > 0;

  for (const r of checked.rows) {
    if (r.same) continue;
    const { fleetsuite: f, netsuite: n } = r;
    if (r.lineId === MONEY_LINE) {
      if (!f) add(zero);
      else if (n) add({ key: 'money_amount', text: `The deposit's total differs from what NetSuite put in ${account(n.account)}.` });
      else add({ key: 'money_none', text: `NetSuite put nothing in ${account(f.account)} for the deposit.` });
    } else if (r.lineId === DEPOSITS_LINE) {
      if (!f) add(zero);
      else if (n) {
        add({
          key: `deposits_amount|${type}`,
          text: type === 'CustDep'
            ? `The deposit's total differs from what NetSuite credited to ${account(n.account)}.`
            : `The application's total differs from what NetSuite took out of ${account(n.account)}.`,
        });
      } else if (otherDeposits) {
        add({ key: `deposits|${f.account}|${theirDeposits[0]}`, text: `Customer deposits: FleetSuite used ${account(f.account)}, NetSuite ${account(theirDeposits[0])}.` });
      } else {
        add({
          key: `deposits_none|${type}`,
          text: type === 'CustDep'
            ? `NetSuite credited nothing to ${account(f.account)} for the deposit.`
            : `NetSuite took nothing out of ${account(f.account)} for the application.`,
        });
      }
    } else if (r.lineId === RECEIVABLE_LINE) {
      if (!f) add(zero);
      else if (n) add({ key: 'receivable_amount', text: 'What FleetSuite takes off receivables differs from what NetSuite took off.' });
      else if (otherReceivable) {
        add({ key: `receivable|${f.account}|${theirReceivables[0]}`, text: `Receivables: FleetSuite used ${account(f.account)}, NetSuite ${account(theirReceivables[0])}.` });
      } else add({ key: 'receivable_none', text: 'NetSuite took nothing off receivables for the application.' });
    } else if (!(r.role === 'receivable' && otherReceivable) && !(otherDeposits && theirDeposits.includes(n!.account))) {
      add({ key: `other|${n!.account}`, text: `NetSuite also posts to ${account(n!.account)}, which the deposit rule doesn't.` });
    }
  }
  return [...out.values()];
}

// ── A month ────────────────────────────────────────────────────────────────

/** A NetSuite document a deposit or application is linked to, as the copy has it; the amount positive. */
export interface DepositLink {
  netsuite_id: string;
  type: string | null;
  number: string | null;
  amount: string | null;
}

/** What gl_deposit_month (migrations 382 and 383) returns: the month's customer deposits and deposit applications. */
export interface DepositMonthData {
  deposits: Array<{
    netsuite_id: string;
    type: DepositType;
    number: string | null;
    date: string;
    total: string;
    voided: boolean;
    /** NetSuite's status for it, in its words; null when NetSuite wouldn't give it. */
    status: string | null;
    customer: string | null;
    /** The FleetSuite customer the ledger mirror matched its NetSuite customer to; null when none. */
    customer_id?: string | null;
    /** Companies NetSuite posted it to; empty when the GL copy has none of it. */
    companies: string[];
    /** What it applies: an application's deposit and invoices, a deposit's sales order. */
    links: DepositLink[];
    /** A deposit's: the applications that applied it, with what each applied it to. */
    applications: Array<{ netsuite_id: string; number: string | null; date: string; links: DepositLink[] }>;
    netsuite: Array<{ line_id: string; account: string; debit: string; credit: string }>;
  }>;
  /** The accounts the company's deposits credit and applications debit across the GL copy, by documents. */
  accounts: Array<{ account: string; documents: number }>;
  /** Deposits and applications the GL copy has in the month that the copy of the documents doesn't. */
  not_copied: Array<{ netsuite_id: string; type: string; number: string | null }>;
}

export interface DepositView extends InvoiceView {
  type: DepositType;
  /** NetSuite's status for it, in its words. */
  netsuiteStatus?: string;
  /** An application's: the deposit it applies. */
  deposit?: string;
  /** A deposit's: the sales order NetSuite links it to. */
  order?: string;
  /** An application's: what it applies the deposit to. A deposit's: what its applications applied it to, each on its date. */
  applied: Array<{ number: string; cents: number | null; date?: string }>;
}

/** A month of deposits and applications, in the shape the invoices page shows a month in. */
export interface DepositMonthCheck extends Omit<MonthCheck, 'invoices'> {
  invoices: DepositView[];
}

const ROW_LABELS: Record<DepositRow['role'], string> = {
  money: 'Deposited to', deposits: 'Customer deposits', receivable: 'Receivable', other: 'Other line',
};

/** What a linked NetSuite document is called when the copy has no number for it. */
const DOC_WORDS: Record<string, string> = {
  CustInvc: 'invoice', CustCred: 'credit memo', CustDep: 'deposit', CustRfnd: 'refund', DepAppl: 'deposit application', SalesOrd: 'sales order',
};
const linkName = (l: DepositLink) => l.number || `NetSuite ${DOC_WORDS[l.type ?? ''] ?? 'document'} ${l.netsuite_id}`;
const linkCents = (l: DepositLink) => (l.amount === null || l.amount === '' ? null : centsOf(l.amount));
/** What an application applies a deposit to: anything it's linked to but the deposit, or a sales order. */
const appliedTo = (links: DepositLink[]) => links.filter((l) => l.type !== 'CustDep' && l.type !== 'SalesOrd');

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const listed = (numbers: string[]) => `${numbers.slice(0, 10).join(', ')}${numbers.length > 10 ? ', …' : ''}`;

/** One document of the month, worked out with the deposit rule and checked against NetSuite. */
export interface WorkedDeposit {
  deposit: DepositMonthData['deposits'][number];
  number: string;
  checked: CheckedDeposit;
}

/**
 * Every deposit and application of the month worked out with the deposit
 * rule and checked: what checkDepositMonth shows, and what the posting job
 * posts (src/lib/books/invoice-posting.ts).
 */
export function workOutDepositMonth(
  data: DepositMonthData,
  opts: { company: string; chart: ChartAccount[] },
): { deposits: WorkedDeposit[]; account: (id: string) => string; notes: string[] } {
  const accountTypes = new Map<string, string>();
  const accountNames = new Map<string, string>();
  for (const a of opts.chart) {
    if (!a.netsuite_account_id) continue;
    accountTypes.set(a.netsuite_account_id, a.account_type);
    accountNames.set(a.netsuite_account_id, [a.number, a.name].filter(Boolean).join(' '));
  }
  const account = (id: string) => accountNames.get(id) ?? `NetSuite account ${id}`;

  const postings = (d: DepositMonthData['deposits'][number]): NetSuitePosting[] =>
    d.netsuite.map((l) => ({ lineId: l.line_id, account: l.account, cents: (centsOf(l.debit) ?? 0) - (centsOf(l.credit) ?? 0) }));
  const applications = data.deposits.filter((d) => d.type === 'DepAppl');
  const receivable = pickReceivable(opts.chart, opts.company, applications.flatMap(postings), 'deposit applications');
  const deposits = pickDepositsAccount(data.accounts ?? [], opts.company, accountTypes, account);
  const ctx = { deposits: deposits.account, receivable: receivable.account, accountTypes };

  const notes: string[] = [];
  if (data.deposits.length && deposits.note) notes.push(deposits.note);
  if (applications.length && receivable.note) notes.push(receivable.note);

  const worked = data.deposits.map((d): WorkedDeposit => ({
    deposit: d,
    number: d.number || `NetSuite ${d.netsuite_id}`,
    checked: checkDeposit({ type: d.type, cents: centsOf(d.total), netsuite: postings(d) }, ctx),
  }));
  return { deposits: worked, account, notes };
}

/**
 * One company's customer deposits and deposit applications dated in one
 * month, each checked against NetSuite. `books`, when the company's
 * deposits post, says what FleetSuite's books hold for each.
 */
export function checkDepositMonth(
  data: DepositMonthData,
  opts: { company: string; chart: ChartAccount[] },
  books?: (worked: WorkedDeposit) => InvoiceBooks,
): DepositMonthCheck {
  const { deposits: worked, account, notes } = workOutDepositMonth(data, opts);

  const summary: MonthSummary = { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 };
  const reasons = new Map<string, MonthReason>();
  const views: DepositView[] = [];
  const notInGl: string[] = [];
  const used = new Set<string>();
  for (const w of worked) {
    const { deposit: d, number, checked } = w;
    if (d.companies.length === 0) {
      // In neither company's GL copy: only worth a word when FleetSuite would post it.
      if (checked.status !== 'matches') notInGl.push(number);
      continue;
    }

    const why = depositReasons(checked, d.type, account);
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
    const links = d.links ?? [];
    const deposit = d.type === 'DepAppl' ? links.find((l) => l.type === 'CustDep') : undefined;
    const order = d.type === 'CustDep' ? links.find((l) => l.type === 'SalesOrd') : undefined;
    views.push({
      netsuiteId: d.netsuite_id,
      number,
      date: d.date,
      customer: d.customer,
      total: centsOf(d.total) ?? 0,
      voided: d.voided,
      status: checked.status,
      ...(checked.waiting ? { waiting: checked.waiting } : {}),
      reasons: why.map((r) => r.text),
      rows,
      type: d.type,
      ...(d.status ? { netsuiteStatus: d.status } : {}),
      ...(deposit ? { deposit: linkName(deposit) } : {}),
      ...(order ? { order: linkName(order) } : {}),
      applied: d.type === 'DepAppl'
        ? appliedTo(links).map((l) => ({ number: linkName(l), cents: linkCents(l) }))
        : (d.applications ?? []).flatMap((a) => appliedTo(a.links ?? []).map((l) => ({ number: linkName(l), cents: linkCents(l), date: a.date }))),
      ...(books ? { books: books(w) } : {}),
    });
  }

  if (books) Object.assign(summary, booksCounts(views));

  if (notInGl.length) {
    const them = notInGl.length === 1 ? 'it' : 'them';
    notes.push(`${plural(notInGl.length, 'more deposit or application', 'more deposits and applications')} dated this month `
      + `${notInGl.length === 1 ? "isn't" : "aren't"} in the copy of NetSuite's GL for either company: ${listed(notInGl)}. NetSuite may have `
      + `deleted ${them}, or the copy, which runs every two hours, hasn't reached ${them} yet.`);
  }
  const missing = (data.not_copied ?? []).map((m) => m.number || `NetSuite ${m.netsuite_id}`);
  if (missing.length) {
    const them = missing.length === 1 ? 'it' : 'them';
    notes.push(`The copy of NetSuite's GL has ${plural(missing.length, 'deposit or application', 'deposits and applications')} of this `
      + `company's dated this month that the copy of the deposits doesn't: ${listed(missing)}. The deposits copy runs every two hours `
      + `and may not have reached ${them} yet, or NetSuite deleted ${them} and the GL copy hasn't caught up.`);
  }

  return {
    summary,
    reasons: [...reasons.values()].sort((a, b) => b.invoices - a.invoices || a.text.localeCompare(b.text)),
    notes,
    invoices: views,
    accounts: Object.fromEntries([...used].sort().map((id) => [id, account(id)])),
  };
}
