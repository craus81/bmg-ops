import {
  booksCounts, centsOf, entryDate,
  type AccountAmount, type ChartAccount, type CheckStatus, type InvoiceBooks, type InvoiceRowView, type InvoiceView, type MonthCheck,
  type MonthReason, type MonthSummary, type NetSuitePosting, type Reason,
} from './invoice-check';
import { MAIN_LINE, isLayoutItem } from './invoice-rule';
import type { BillItem, BillLine } from './bill-rule';
import { withOwnBillAmounts, type BillLineView, type BillMonthData } from './bill-check';
import { onIncomeStatement } from './payment-check';
import { PAID_FROM_LINE } from './bill-payment-rule';
import {
  REFUND_TYPES, spendingEntry,
  type SpendingLineRole, type SpendingProblem, type SpendingRuleLine, type SpendingType,
} from './spending-rule';

/**
 * Each NetSuite check, credit card charge and credit card refund checked
 * against NetSuite (docs/books.md "Checks and card charges"): FleetSuite's
 * own entry from the spending rule next to the GL lines NetSuite posted for
 * the same document (the copy, migration 361), account by account, to the
 * cent, as bills are checked (src/lib/books/bill-check.ts), and the entry the
 * posting job posts for it (src/lib/books/invoice-posting.ts). Pure; amounts
 * are whole cents, debit positive.
 */

export interface SpendingRow {
  /** PAID_FROM_LINE for the account the money comes out of, `account:<id>` for every other account. */
  lineId: string;
  /** What the account is to the document, as the rule posts it; 'other' for an account only NetSuite posts to. */
  role: SpendingLineRole | 'other';
  /** What the rule's lines on the account come to. */
  fleetsuite: AccountAmount | null;
  /** What NetSuite posted to the account for the document, its lines on the account together. */
  netsuite: AccountAmount | null;
  same: boolean;
}

export interface CheckedSpending {
  status: CheckStatus;
  /** Why it's waiting: NetSuite's GL copy has nothing for it yet, or its lines haven't been copied. */
  waiting?: 'gl' | 'lines';
  problems: SpendingProblem[];
  /** The rule's accounts in the order its lines come, the account the money comes out of first, then anything else NetSuite posts, in its order. */
  rows: SpendingRow[];
  /** The rule's entry line by line, as it posts; empty when it's waiting or can't be worked out. */
  lines: SpendingRuleLine[];
}

/**
 * The account a check's or a card charge's money came out of, or a card
 * refund's went back to, as NetSuite posted it: the one on its main line.
 * Should that line be missing, the one account outside income and expenses
 * NetSuite posts the other way from the document's lines: credited for a
 * check or a charge, debited for a refund. Null when NetSuite's posting
 * doesn't say.
 */
export function spendingAccount(netsuite: NetSuitePosting[], type: SpendingType, accountTypes: Map<string, string>): string | null {
  const main = netsuite.find((p) => p.lineId === MAIN_LINE);
  if (main) return main.account;
  const refund = REFUND_TYPES.has(type);
  const opposite = netsuite.filter((p) => (refund ? p.cents > 0 : p.cents < 0) && !onIncomeStatement(p.account, accountTypes));
  const accounts = [...new Set(opposite.map((p) => p.account))];
  return accounts.length === 1 ? accounts[0] : null;
}

/** One check, card charge or card refund, its lines signed debit positive (spendingLineSigns); null when they haven't been copied. */
export function checkSpending(
  doc: { type: SpendingType; cents: number | null; lines: BillLine[] | null; netsuite: NetSuitePosting[] },
  ctx: { items: Map<string, BillItem>; posted?: Map<string, string>; accountTypes: Map<string, string> },
): CheckedSpending {
  if (doc.netsuite.length === 0 && doc.cents !== null && doc.cents !== 0) {
    return { status: 'waiting', waiting: 'gl', problems: [], rows: [], lines: [] };
  }
  if (doc.lines === null) return { status: 'waiting', waiting: 'lines', problems: [], rows: [], lines: [] };

  // Each side, one amount to each account; an account a side's lines come to nothing on is the same as none.
  const posted = new Map<string, number>();
  for (const p of doc.netsuite) if (p.cents !== 0) posted.set(p.account, (posted.get(p.account) ?? 0) + p.cents);
  for (const [account, cents] of posted) if (cents === 0) posted.delete(account);

  const paidFrom = spendingAccount(doc.netsuite, doc.type, ctx.accountTypes);
  const entry = spendingEntry({ lines: doc.lines }, { items: ctx.items, paidFrom, posted: ctx.posted });
  const ours = new Map<string, { cents: number; role: SpendingLineRole }>();
  for (const l of entry.lines) {
    const was = ours.get(l.account);
    ours.set(l.account, { cents: (was?.cents ?? 0) + l.cents, role: was?.role ?? l.role });
  }
  for (const [account, o] of ours) if (o.cents === 0) ours.delete(account);

  const rows: SpendingRow[] = [];
  for (const [account, o] of ours) {
    const n = posted.has(account) ? { account, cents: posted.get(account)! } : null;
    rows.push({
      lineId: o.role === 'paid_from' ? PAID_FROM_LINE : `account:${account}`,
      role: o.role,
      fleetsuite: { account, cents: o.cents },
      netsuite: n,
      same: !!n && n.cents === o.cents,
    });
  }
  for (const [account, cents] of posted) {
    if (ours.has(account)) continue;
    rows.push({ lineId: `account:${account}`, role: 'other', fleetsuite: null, netsuite: { account, cents }, same: false });
  }

  if (entry.problems.length) return { status: 'unworkable', problems: entry.problems, rows, lines: [] };
  return { status: rows.every((r) => r.same) ? 'matches' : 'differs', problems: [], rows, lines: entry.lines };
}

/**
 * Which way round NetSuite signs the lines of each kind of document: 1 when
 * they come debit positive, as the GL has them, -1 when they come the other
 * way. The month's documents say: a check's or a card charge's lines come to
 * more than nothing, a card refund's to less. A kind with no say is taken as
 * the GL has it.
 */
export function spendingLineSigns(docs: Array<{ type: SpendingType; lines: Array<{ amount: string | null }> | null }>): Record<SpendingType, 1 | -1> {
  const votes: Record<SpendingType, number> = { Check: 0, CardChrg: 0, CardRfnd: 0 };
  for (const d of docs) {
    if (!d.lines) continue;
    const sum = d.lines.reduce((n, l) => n + (centsOf(l.amount) ?? 0), 0);
    const debits = REFUND_TYPES.has(d.type) ? -sum : sum;
    if (debits !== 0) votes[d.type] += Math.sign(debits);
  }
  return { Check: votes.Check < 0 ? -1 : 1, CardChrg: votes.CardChrg < 0 ? -1 : 1, CardRfnd: votes.CardRfnd < 0 ? -1 : 1 };
}

// ── Reasons, in words ──────────────────────────────────────────────────────

const DOC: Record<SpendingType, string> = { Check: 'check', CardChrg: 'card charge', CardRfnd: 'card refund' };

const ROLE_LABELS: Record<SpendingRow['role'], string> = {
  paid_from: 'Paid from', expense: 'Expense', item: 'Items', stock: 'Inventory', other: 'Other line',
};

/** What a row is called on a document: a refund's money goes back to the account a charge's comes out of. */
const rowLabel = (role: SpendingRow['role'], type: SpendingType) =>
  (role === 'paid_from' && REFUND_TYPES.has(type) ? 'Refunded to' : ROLE_LABELS[role]);

export function spendingProblemReason(p: SpendingProblem, type: SpendingType): Reason {
  switch (p.kind) {
    case 'unreadable':
      return { key: `unreadable|${type}`, text: `A line's amount couldn't be read from the copy of the ${DOC[type]}.` };
    case 'no_account':
      return { key: `no_account|${type}`, text: `An expense line on the ${DOC[type]} has no account: NetSuite didn't say which account it goes to.` };
    case 'not_copied':
      return {
        key: `not_copied|${p.itemId}`,
        text: `Item ${p.itemId} isn't in the copy of NetSuite's items yet. Sync now on the NetSuite lists page copies it.`,
      };
    case 'no_item_account':
      return {
        key: `no_item_account|${p.itemId}`,
        text: p.stock
          ? `${p.itemNumber} has no asset account in the copy of NetSuite's items.`
          : `${p.itemNumber} has no expense account in the copy of NetSuite's items, and no copied check, card charge or refund shows where NetSuite posts it.`,
      };
    case 'tax':
      return { key: `tax|${type}`, text: `The ${DOC[type]} has a tax line, which the spending rule doesn't post yet.` };
    case 'no_paid_from':
      return {
        key: `no_paid_from|${type}`,
        text: REFUND_TYPES.has(type)
          ? `NetSuite's posting of the ${DOC[type]} doesn't say which account the money went back to.`
          : `NetSuite's posting of the ${DOC[type]} doesn't say which account the money came out of.`,
      };
  }
}

/** Each distinct reason a document doesn't match, in the order its rows come. `account` names a NetSuite account. */
export function spendingReasons(checked: CheckedSpending, type: SpendingType, account: (id: string) => string): Reason[] {
  const out = new Map<string, Reason>();
  const add = (r: Reason) => {
    if (!out.has(r.key)) out.set(r.key, r);
  };
  for (const p of checked.problems) add(spendingProblemReason(p, type));
  if (checked.status !== 'differs') return [...out.values()];

  // FleetSuite put an amount in one account and NetSuite the same amount in another: one reason, not two.
  const unmatched = checked.rows.filter((r) => !r.same);
  const twins = new Map<SpendingRow, SpendingRow>();
  const taken = new Set<SpendingRow>();
  for (const r of unmatched) {
    if (!r.fleetsuite || r.netsuite) continue;
    const twin = unmatched.find((n) => !n.fleetsuite && n.netsuite && !taken.has(n) && n.netsuite.cents === r.fleetsuite!.cents);
    if (!twin) continue;
    twins.set(r, twin);
    taken.add(twin);
  }

  for (const r of unmatched) {
    if (taken.has(r)) continue;
    const { fleetsuite: f, netsuite: n } = r;
    const twin = twins.get(r);
    if (f && twin) {
      add({
        key: `swap|${r.role}|${f.account}|${twin.netsuite!.account}`,
        text: `${rowLabel(r.role, type)}: FleetSuite used ${account(f.account)}, NetSuite ${account(twin.netsuite!.account)}.`,
      });
    } else if (f && n) {
      add({
        key: `amount|${f.account}`,
        text: r.role === 'paid_from'
          ? `The ${DOC[type]}'s total differs from what NetSuite posted to ${account(f.account)}.`
          : `What FleetSuite posts to ${account(f.account)} differs from what NetSuite posted there.`,
      });
    } else if (f) {
      add({ key: `none|${type}|${f.account}`, text: `NetSuite posted nothing to ${account(f.account)} for the ${DOC[type]}.` });
    } else if (n) {
      add({ key: `other|${n.account}`, text: `NetSuite also posts to ${account(n.account)}, which the spending rule doesn't.` });
    }
  }
  return [...out.values()];
}

// ── A month ────────────────────────────────────────────────────────────────

/** What gl_spending_month (migration 391) returns: the month's checks and card charges and refunds. */
export interface SpendingMonthData {
  documents: Array<{
    netsuite_id: string;
    type: SpendingType;
    number: string | null;
    date: string;
    /** The month NetSuite booked it to, 'YYYY-MM-01'; null when the GL copy has none of it. */
    posting_month?: string | null;
    total: string;
    voided: boolean;
    /** NetSuite's status for it, in its words; null when NetSuite wouldn't give it or has none. */
    status: string | null;
    /** Who was paid, or who refunded: the vendors copy's name for a vendor, else NetSuite's. */
    payee: string | null;
    payee_netsuite_id: string | null;
    /** Companies NetSuite posted it to; empty when the GL copy has none of it. */
    companies: string[];
    /** Its lines but the one for the account the money comes out of, signed as NetSuite gives them; null until they've been copied. */
    lines: Array<{
      line_id: string;
      item: string | null;
      account: string | null;
      /** Its net amount, a discount line's amount shared out over the lines above it. */
      amount: string | null;
      /** Its own amount; null when NetSuite didn't give it. */
      own_amount?: string | null;
      quantity: string | null;
      memo: string | null;
      tax: boolean;
    }> | null;
    netsuite: Array<{ line_id: string; account: string; debit: string; credit: string }>;
  }>;
  /** The copied items the month's lines name. */
  items: BillMonthData['items'];
  /** Checks and card charges and refunds the GL copy has in the month that the copy of the documents doesn't. */
  not_copied: Array<{ netsuite_id: string; type: string; number: string | null }>;
  /**
   * Where NetSuite's GL posted the lines of the month's items the copy of
   * NetSuite's items has no account for (gl_spending_item_accounts,
   * migration 391); left out when not read.
   */
  item_accounts?: Array<{ item: string; account: string; lines: number }>;
}

export interface SpendingView extends InvoiceView {
  type: SpendingType;
  /** NetSuite's status for it, in its words. */
  netsuiteStatus?: string;
  /** Its lines, as the copy of it has them; empty until they've been copied. */
  lines: BillLineView[];
}

/** A month of checks and card charges and refunds, in the shape the invoices page shows a month in. */
export interface SpendingMonthCheck extends Omit<MonthCheck, 'invoices'> {
  invoices: SpendingView[];
}

/** The documents, in the words the notes use. */
const ONE = 'check, card charge or refund';
const MANY = 'checks, card charges and refunds';
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
/** A line whose item isn't in the copy: NetSuite's own lines carry ids below 1, its subtotal -2. */
const ownLineLabel = (itemId: string) => (itemId === '-2' ? 'Subtotal' : isLayoutItem(itemId, null) ? "NetSuite's own line" : `Item ${itemId}`);
const listed = (numbers: string[]) => `${numbers.slice(0, 10).join(', ')}${numbers.length > 10 ? ', …' : ''}`;


/** One document of the month, worked out with the spending rule and checked against NetSuite. */
export interface WorkedSpending {
  doc: SpendingMonthData['documents'][number];
  number: string;
  /** Its lines as the rule takes them, signed debit positive; null until they've been copied. */
  lines: BillLine[] | null;
  /** Which amounts its lines went in at (withOwnBillAmounts); null until they've been copied. */
  amounts: 'own' | 'net' | 'unfit' | null;
  checked: CheckedSpending;
}

/**
 * Every check and card charge and refund of the month worked out with the
 * spending rule and checked: what checkSpendingMonth shows.
 */
export function workOutSpendingMonth(
  data: SpendingMonthData,
  opts: { company: string; chart: ChartAccount[] },
): { documents: WorkedSpending[]; account: (id: string) => string } {
  const accountTypes = new Map<string, string>();
  const accountNames = new Map<string, string>();
  for (const a of opts.chart) {
    if (!a.netsuite_account_id) continue;
    accountTypes.set(a.netsuite_account_id, a.account_type);
    accountNames.set(a.netsuite_account_id, [a.number, a.name].filter(Boolean).join(' '));
  }
  const account = (id: string) => accountNames.get(id) ?? `NetSuite account ${id}`;

  const items = new Map<string, BillItem>((data.items ?? []).map((i) => [i.netsuite_id, {
    number: i.name,
    type: i.item_type,
    assetAccount: i.asset_account,
    expenseAccount: i.expense_account,
    incomeAccount: i.income_account,
  }]));
  const postings = (d: SpendingMonthData['documents'][number]): NetSuitePosting[] =>
    d.netsuite.map((l) => ({ lineId: l.line_id, account: l.account, cents: (centsOf(l.debit) ?? 0) - (centsOf(l.credit) ?? 0) }));
  const signs = spendingLineSigns(data.documents);
  // For an item with no account in the copy: the account NetSuite posted most of its lines to, the lower id on a tie.
  const most = new Map<string, { account: string; lines: number }>();
  for (const u of data.item_accounts ?? []) {
    const lines = Number(u.lines) || 0;
    const was = most.get(u.item);
    if (!was || lines > was.lines || (lines === was.lines && Number(u.account) < Number(was.account))) most.set(u.item, { account: u.account, lines });
  }
  const posted = new Map([...most].map(([item, u]) => [item, u.account]));

  const documents = data.documents.map((d): WorkedSpending => {
    const netLines = d.lines?.map((l): BillLine => {
      const cents = l.amount === null ? null : centsOf(l.amount);
      return {
        lineId: l.line_id,
        itemId: l.item,
        account: l.account,
        cents: cents === null || cents === 0 ? cents : signs[d.type] * cents,
        tax: !!l.tax,
      };
    }) ?? null;
    const own = netLines ? withOwnBillAmounts(netLines, d.lines!, items) : null;
    const lines = own?.lines ?? null;
    return {
      doc: d,
      number: d.number || `NetSuite ${d.netsuite_id}`,
      lines,
      amounts: own?.amounts ?? null,
      checked: checkSpending({ type: d.type, cents: centsOf(d.total), lines, netsuite: postings(d) }, { items, posted, accountTypes }),
    };
  });
  return { documents, account };
}

/**
 * One company's checks and card charges and refunds for one month, each
 * checked against NetSuite. `books`, when the company's checks and card
 * charges post, says what FleetSuite's books hold for each.
 */
export function checkSpendingMonth(
  data: SpendingMonthData,
  opts: { company: string; chart: ChartAccount[] },
  books?: (worked: WorkedSpending) => InvoiceBooks,
): SpendingMonthCheck {
  const { documents: worked, account } = workOutSpendingMonth(data, opts);
  const itemNames = new Map((data.items ?? []).map((i) => [i.netsuite_id, i.name]));

  const summary: MonthSummary = { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 };
  const reasons = new Map<string, MonthReason>();
  const views: SpendingView[] = [];
  const notes: string[] = [];
  const notInGl: string[] = [];
  const moved: string[] = [];
  const unfit: string[] = [];
  const used = new Set<string>();
  for (const w of worked) {
    const { doc: d, number, lines, amounts, checked } = w;
    if (d.companies.length === 0) {
      // In neither company's GL copy: only worth a word when FleetSuite would post it.
      if (checked.status !== 'matches') notInGl.push(number);
      continue;
    }

    const why = spendingReasons(checked, d.type, account);
    if (amounts === 'unfit') unfit.push(number);
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
      return { lineId: r.lineId, label: rowLabel(r.role, d.type), division: null, fleetsuite: r.fleetsuite, netsuite: r.netsuite, cost: false, same: r.same };
    });
    const refund = REFUND_TYPES.has(d.type);
    const shownLines = (lines ?? []).map((l, i): BillLineView => {
      const copied = d.lines![i];
      return {
        label: l.tax ? 'Tax'
          : l.itemId ? itemNames.get(l.itemId) ?? ownLineLabel(l.itemId)
            : l.account ? `Expense to ${account(l.account)}` : 'Expense',
        quantity: copied.quantity,
        memo: copied.memo,
        // As the document shows them: a refund's lines positive too.
        cents: l.cents === null || l.cents === 0 || !refund ? l.cents : -l.cents,
      };
    });
    const bookedInto = d.posting_month && d.posting_month.slice(0, 7) !== d.date.slice(0, 7) ? d.posting_month : null;
    if (bookedInto) moved.push(number);
    views.push({
      netsuiteId: d.netsuite_id,
      number,
      date: d.date,
      ...(bookedInto ? { booked: { month: bookedInto, date: entryDate(d) } } : {}),
      customer: d.payee,
      total: centsOf(d.total) ?? 0,
      voided: d.voided,
      status: checked.status,
      ...(checked.waiting ? { waiting: checked.waiting } : {}),
      ...(amounts === 'own' || amounts === 'unfit' ? { amounts } : {}),
      reasons: why.map((r) => r.text),
      rows,
      type: d.type,
      ...(d.status ? { netsuiteStatus: d.status } : {}),
      lines: shownLines,
      ...(books ? { books: books(w) } : {}),
    });
  }

  if (books) Object.assign(summary, booksCounts(views));

  if (moved.length) {
    const them = moved.length === 1 ? 'it' : 'them';
    notes.push(`${plural(moved.length, `${ONE} dated in another month is`, `${MANY} dated in other months are`)} `
      + `here because NetSuite booked ${them} into this month: ${listed(moved)}.`);
  }
  if (notInGl.length) {
    const them = notInGl.length === 1 ? 'it' : 'them';
    notes.push(`${plural(notInGl.length, `more ${ONE}`, `more ${MANY}`)} dated this month `
      + `${notInGl.length === 1 ? "isn't" : "aren't"} in the copy of NetSuite's GL for either company: ${listed(notInGl)}. NetSuite may have `
      + `deleted ${them}, or the copy, which runs every two hours, hasn't reached ${them} yet.`);
  }
  const missing = (data.not_copied ?? []).map((m) => m.number || `NetSuite ${m.netsuite_id}`);
  if (missing.length) {
    const them = missing.length === 1 ? 'it' : 'them';
    notes.push(`The copy of NetSuite's GL has ${plural(missing.length, ONE, MANY)} of this company's `
      + `booked into this month that the copy of the ${MANY} doesn't: ${listed(missing)}. That copy runs every two hours and `
      + `may not have reached ${them} yet, or NetSuite deleted ${them} and the GL copy hasn't caught up.`);
  }
  if (unfit.length) {
    notes.push(`NetSuite's own amounts for the lines of ${plural(unfit.length, ONE, MANY)} don't add `
      + `up to ${unfit.length === 1 ? 'it' : 'them'}, so FleetSuite took ${unfit.length === 1 ? 'its' : 'their'} lines at their net amounts, `
      + `with any discount shared out over them: ${listed(unfit)}.`);
  }

  return {
    summary,
    reasons: [...reasons.values()].sort((a, b) => b.invoices - a.invoices || a.text.localeCompare(b.text)),
    notes,
    invoices: views,
    accounts: Object.fromEntries([...used].sort().map((id) => [id, account(id)])),
  };
}
