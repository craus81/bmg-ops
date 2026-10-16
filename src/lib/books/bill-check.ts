import {
  centsOf, entryDate,
  type AccountAmount, type ChartAccount, type CheckStatus, type InvoiceRowView, type InvoiceView, type MonthCheck,
  type MonthReason, type MonthSummary, type NetSuitePosting, type Reason,
} from './invoice-check';
import {
  PAYABLES_LINE, STOCK_TYPES, billEntry,
  type BillAccounts, type BillItem, type BillLine, type BillLineRole, type BillProblem, type BillType,
} from './bill-rule';

/**
 * Each NetSuite vendor bill and bill credit checked against NetSuite
 * (docs/books.md "Vendor bills"): FleetSuite's own entry from the bill rule
 * next to the GL lines NetSuite posted for the same document (the copy,
 * migration 361), account by account, to the cent, as deposits are checked
 * (src/lib/books/deposit-check.ts). Pure; amounts are whole cents, debit
 * positive.
 */

export interface BillRow {
  /** PAYABLES_LINE for the rule's payables, `account:<id>` for every other account. */
  lineId: string;
  /** What the account is to the document, as the rule posts it; 'payables' or 'other' for an account only NetSuite posts to. */
  role: BillLineRole | 'other';
  /** What the rule's lines on the account come to. */
  fleetsuite: AccountAmount | null;
  /** What NetSuite posted to the account for the document, its lines on the account together. */
  netsuite: AccountAmount | null;
  same: boolean;
}

export interface CheckedBill {
  status: CheckStatus;
  /** Why it's waiting: NetSuite's GL copy has nothing for it yet, or its lines haven't been copied. */
  waiting?: 'gl' | 'lines';
  problems: BillProblem[];
  /** The rule's accounts in the order its lines come, payables first, then anything else NetSuite posts, in its order. */
  rows: BillRow[];
}

/** One bill or bill credit, its lines signed debit positive (lineSigns); null when they haven't been copied. */
export function checkBill(
  doc: { cents: number | null; lines: BillLine[] | null; ordered: boolean | null; netsuite: NetSuitePosting[] },
  ctx: { accounts: BillAccounts; accountTypes: Map<string, string> },
): CheckedBill {
  if (doc.netsuite.length === 0 && doc.cents !== null && doc.cents !== 0) {
    return { status: 'waiting', waiting: 'gl', problems: [], rows: [] };
  }
  if (doc.lines === null) return { status: 'waiting', waiting: 'lines', problems: [], rows: [] };

  // Each side, one amount to each account; an account a side's lines come to nothing on is the same as none.
  const posted = new Map<string, number>();
  for (const p of doc.netsuite) if (p.cents !== 0) posted.set(p.account, (posted.get(p.account) ?? 0) + p.cents);
  for (const [account, cents] of posted) if (cents === 0) posted.delete(account);

  const entry = billEntry({ lines: doc.lines, ordered: doc.ordered }, ctx.accounts);
  const ours = new Map<string, { cents: number; role: BillLineRole }>();
  for (const l of entry.lines) {
    const was = ours.get(l.account);
    ours.set(l.account, { cents: (was?.cents ?? 0) + l.cents, role: was?.role ?? l.role });
  }
  for (const [account, o] of ours) if (o.cents === 0) ours.delete(account);

  const rows: BillRow[] = [];
  for (const [account, o] of ours) {
    const n = posted.has(account) ? { account, cents: posted.get(account)! } : null;
    rows.push({
      lineId: o.role === 'payables' ? PAYABLES_LINE : `account:${account}`,
      role: o.role,
      fleetsuite: { account, cents: o.cents },
      netsuite: n,
      same: !!n && n.cents === o.cents,
    });
  }
  for (const [account, cents] of posted) {
    if (ours.has(account)) continue;
    rows.push({
      lineId: `account:${account}`,
      role: ctx.accountTypes.get(account) === 'accounts_payable' ? 'payables' : 'other',
      fleetsuite: null,
      netsuite: { account, cents },
      same: false,
    });
  }

  if (entry.problems.length) return { status: 'unworkable', problems: entry.problems, rows };
  return { status: rows.every((r) => r.same) ? 'matches' : 'differs', problems: [], rows };
}

// ── The accounts ───────────────────────────────────────────────────────────

/**
 * The payables accounts a company's bills can credit, as the chart of
 * accounts has them, and the one a bill whose vendor has none of the
 * company's goes to: the company's only one, or with more than one the one
 * NetSuite's bills (`postings`, every GL line of the month's documents)
 * used most this month, and a note saying so.
 */
export function pickPayables(
  chart: ChartAccount[],
  company: string,
  postings: NetSuitePosting[],
  name: (id: string) => string,
): { candidates: Set<string>; fallback: string | null; note: string | null } {
  const candidates = new Set(chart
    .filter((a) => a.account_type === 'accounts_payable' && a.active && !a.is_summary && a.netsuite_account_id
      && (a.company === null || a.company === company))
    .map((a) => a.netsuite_account_id!));
  if (candidates.size === 1) return { candidates, fallback: [...candidates][0], note: null };
  if (candidates.size === 0) return { candidates, fallback: null, note: `The chart of accounts has no payables account ${company} can use.` };

  const uses = new Map<string, number>();
  for (const p of postings) if (candidates.has(p.account)) uses.set(p.account, (uses.get(p.account) ?? 0) + 1);
  const [most] = [...uses].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
  const fallback = most?.[0] ?? [...candidates].sort((a, b) => Number(a) - Number(b))[0];
  return {
    candidates,
    fallback,
    note: `${company} can use ${candidates.size} payables accounts, so for a vendor with none of its own FleetSuite used ${name(fallback)}, `
      + (most ? "the one NetSuite's bills used most this month." : 'the first in the chart.'),
  };
}

/** Where received stock can be held: a liability, never payables itself. */
const RECEIVED_TYPES: ReadonlySet<string> = new Set(['other_current_liability', 'long_term_liability']);

/**
 * The account NetSuite holds received stock against until it's billed, for
 * one company: the liability its item receipts credit, for the most of the
 * company's receipts in the GL copy (gl_bill_month's `receipt_accounts`,
 * migration 384). With more than one in use, the note says which was taken.
 * Null when the company's receipts credit none, as when NetSuite doesn't
 * keep receipts apart from bills: stock on a bill then goes to its asset
 * account.
 */
export function pickReceivedAccount(
  usage: Array<{ account: string; documents: number }>,
  company: string,
  accountTypes: Map<string, string>,
  name: (id: string) => string,
): { account: string | null; note: string | null } {
  const candidates = usage
    .filter((u) => u.documents > 0 && RECEIVED_TYPES.has(accountTypes.get(u.account) ?? ''))
    .sort((a, b) => b.documents - a.documents || Number(a.account) - Number(b.account));
  if (candidates.length === 0) return { account: null, note: null };
  const pick = candidates[0].account;
  if (candidates.length === 1) return { account: pick, note: null };
  return {
    account: pick,
    note: `NetSuite's item receipts for ${company} credit ${candidates.length} accounts, so FleetSuite takes received stock off `
      + `${name(pick)}, the one most of them credit.`,
  };
}

/**
 * Which way round NetSuite signs bill lines, for each kind of document: 1
 * when its lines come debit positive, as the GL has them, -1 when they come
 * the other way. The month's documents say: a bill's lines come to more
 * than nothing, a bill credit's to less. A kind with no say is taken as the
 * GL has it.
 */
export function lineSigns(docs: Array<{ type: BillType; lines: Array<{ amount: string | null }> | null }>): Record<BillType, 1 | -1> {
  const votes: Record<BillType, number> = { VendBill: 0, VendCred: 0 };
  for (const d of docs) {
    if (!d.lines) continue;
    const sum = d.lines.reduce((n, l) => n + (centsOf(l.amount) ?? 0), 0);
    const debits = d.type === 'VendBill' ? sum : -sum;
    if (debits !== 0) votes[d.type] += Math.sign(debits);
  }
  return { VendBill: votes.VendBill < 0 ? -1 : 1, VendCred: votes.VendCred < 0 ? -1 : 1 };
}

// ── Reasons, in words ──────────────────────────────────────────────────────

const DOC: Record<BillType, string> = { VendBill: 'bill', VendCred: 'bill credit' };

const ROLE_LABELS: Record<BillRow['role'], string> = {
  payables: 'Payables', expense: 'Expense', item: 'Items', stock: 'Inventory', received: 'Received stock', other: 'Other line',
};

export function billProblemReason(p: BillProblem, type: BillType): Reason {
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
        text: `${p.itemNumber} has no ${p.stock ? 'asset' : 'expense'} account in the copy of NetSuite's items.`,
      };
    case 'tax':
      return { key: `tax|${type}`, text: `The ${DOC[type]} has a tax line, which the bill rule doesn't post yet.` };
    case 'no_links':
      return {
        key: `no_links|${type}`,
        text: `FleetSuite can't tell whether the ${DOC[type]} came from ${type === 'VendBill' ? 'a purchase order' : 'a vendor return'}: `
          + "what it's linked to hasn't been copied from NetSuite yet.",
      };
    case 'no_payables':
      return { key: 'no_payables', text: 'The chart of accounts has no payables account this company can use.' };
  }
}

/** Each distinct reason a document doesn't match, in the order its rows come. `account` names a NetSuite account. */
export function billReasons(checked: CheckedBill, type: BillType, account: (id: string) => string): Reason[] {
  const out = new Map<string, Reason>();
  const add = (r: Reason) => {
    if (!out.has(r.key)) out.set(r.key, r);
  };
  for (const p of checked.problems) add(billProblemReason(p, type));
  if (checked.status !== 'differs') return [...out.values()];

  // FleetSuite put an amount in one account and NetSuite the same amount in another: one reason, not two.
  const unmatched = checked.rows.filter((r) => !r.same);
  const twins = new Map<BillRow, BillRow>();
  const taken = new Set<BillRow>();
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
        text: `${ROLE_LABELS[r.role]}: FleetSuite used ${account(f.account)}, NetSuite ${account(twin.netsuite!.account)}.`,
      });
    } else if (f && n) {
      add({
        key: `amount|${f.account}`,
        text: r.role === 'payables'
          ? `What's owed in ${account(f.account)} differs from what NetSuite posted there.`
          : `What FleetSuite posts to ${account(f.account)} differs from what NetSuite posted there.`,
      });
    } else if (f) {
      add({ key: `none|${type}|${f.account}`, text: `NetSuite posted nothing to ${account(f.account)} for the ${DOC[type]}.` });
    } else if (n) {
      add({ key: `other|${n.account}`, text: `NetSuite also posts to ${account(n.account)}, which the bill rule doesn't.` });
    }
  }
  return [...out.values()];
}

// ── A month ────────────────────────────────────────────────────────────────

/** A NetSuite document a bill or bill credit came from, as the copy has it; the amount positive. */
export interface BillLink {
  netsuite_id: string;
  type: string | null;
  number: string | null;
  amount: string | null;
}

/** What gl_bill_month (migration 384) returns: the month's vendor bills and bill credits. */
export interface BillMonthData {
  bills: Array<{
    netsuite_id: string;
    type: BillType;
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
    /** Its lines but the payables line, signed as NetSuite gives them; null until they've been copied. */
    lines: Array<{
      line_id: string;
      item: string | null;
      account: string | null;
      amount: string | null;
      quantity: string | null;
      memo: string | null;
      tax: boolean;
    }> | null;
    /** The documents it came from; null until they've been copied. */
    links: BillLink[] | null;
    netsuite: Array<{ line_id: string; account: string; debit: string; credit: string }>;
  }>;
  /** The copied items the month's lines name. */
  items: Array<{
    netsuite_id: string;
    name: string;
    item_type: string | null;
    asset_account: string | null;
    expense_account: string | null;
    income_account: string | null;
  }>;
  /** The accounts the company's item receipts credit across the GL copy, by receipts. */
  receipt_accounts: Array<{ account: string; documents: number }>;
  /** Bills and bill credits the GL copy has in the month that the copy of the documents doesn't. */
  not_copied: Array<{ netsuite_id: string; type: string; number: string | null }>;
}

/** One of a document's lines, to show: what it is, and its amount as the document has it (a bill credit's lines positive too). */
export interface BillLineView {
  label: string;
  quantity: string | null;
  memo: string | null;
  cents: number | null;
}

export interface BillView extends InvoiceView {
  type: BillType;
  /** NetSuite's status for it, in its words. */
  netsuiteStatus?: string;
  /** The purchase orders and receipts a bill came from, or a bill credit's vendor return. */
  from: string[];
  /** Its lines, as the copy of it has them; empty until they've been copied. */
  lines: BillLineView[];
}

/** A month of bills and bill credits, in the shape the invoices page shows a month in. */
export interface BillMonthCheck extends Omit<MonthCheck, 'invoices'> {
  invoices: BillView[];
}

/** The documents a bill or bill credit comes from that say it was ordered and received, not bought on the bill itself. */
const ORDERED_FROM: Record<BillType, ReadonlySet<string>> = {
  VendBill: new Set(['PurchOrd', 'ItemRcpt']),
  VendCred: new Set(['VendAuth', 'ItemShip']),
};

/** What a linked NetSuite document is called when the copy has no number for it. */
const DOC_WORDS: Record<string, string> = {
  PurchOrd: 'purchase order', ItemRcpt: 'item receipt', VendAuth: 'vendor return', ItemShip: 'return shipment', VendBill: 'bill',
};
const linkName = (l: BillLink) => l.number || `NetSuite ${DOC_WORDS[l.type ?? ''] ?? 'document'} ${l.netsuite_id}`;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const listed = (numbers: string[]) => `${numbers.slice(0, 10).join(', ')}${numbers.length > 10 ? ', …' : ''}`;

/** One document of the month, worked out with the bill rule and checked against NetSuite. */
export interface WorkedBill {
  bill: BillMonthData['bills'][number];
  number: string;
  /** Its lines, signed debit positive; null until they've been copied. */
  lines: BillLine[] | null;
  checked: CheckedBill;
}

/**
 * Every bill and bill credit of the month worked out with the bill rule and
 * checked: what checkBillMonth shows, and what the posting job will post.
 */
export function workOutBillMonth(
  data: BillMonthData,
  opts: { company: string; chart: ChartAccount[] },
): { bills: WorkedBill[]; account: (id: string) => string; notes: string[] } {
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
  const postings = (b: BillMonthData['bills'][number]): NetSuitePosting[] =>
    b.netsuite.map((l) => ({ lineId: l.line_id, account: l.account, cents: (centsOf(l.debit) ?? 0) - (centsOf(l.credit) ?? 0) }));
  const payables = pickPayables(opts.chart, opts.company, data.bills.flatMap(postings), account);
  const received = pickReceivedAccount(data.receipt_accounts ?? [], opts.company, accountTypes, account);
  const signs = lineSigns(data.bills);

  const notes: string[] = [];
  if (data.bills.length && payables.note) notes.push(payables.note);
  if (data.bills.length && received.note) notes.push(received.note);

  const worked = data.bills.map((b): WorkedBill => {
    const lines = b.lines?.map((l): BillLine => {
      const cents = l.amount === null ? null : centsOf(l.amount);
      return {
        lineId: l.line_id,
        itemId: l.item,
        account: l.account,
        cents: cents === null || cents === 0 ? cents : signs[b.type] * cents,
        tax: !!l.tax,
      };
    }) ?? null;
    const ordered = b.links ? b.links.some((l) => ORDERED_FROM[b.type].has(l.type ?? '')) : null;
    const accounts: BillAccounts = {
      items,
      payables: b.vendor_payables && payables.candidates.has(b.vendor_payables) ? b.vendor_payables : payables.fallback,
      received: received.account,
    };
    return {
      bill: b,
      number: b.number || `NetSuite ${b.netsuite_id}`,
      lines,
      checked: checkBill({ cents: centsOf(b.total), lines, ordered, netsuite: postings(b) }, { accounts, accountTypes }),
    };
  });

  // Ordered stock with nowhere to be held: say why it goes to the items' asset accounts.
  const stockOrdered = worked.some((w) => w.lines?.some((l) => {
    const type = l.itemId ? items.get(l.itemId)?.type : null;
    return !!type && STOCK_TYPES.has(type) && !!w.bill.links?.some((k) => ORDERED_FROM[w.bill.type].has(k.type ?? ''));
  }));
  if (stockOrdered && !received.account) {
    notes.push(`The copy of NetSuite's GL has no item receipt of ${opts.company}'s that holds received stock in an account until it's billed, `
      + 'so stock on bills from purchase orders goes to the items\' asset accounts.');
  }
  return { bills: worked, account, notes };
}

/** One company's vendor bills and bill credits for one month, each checked against NetSuite. */
export function checkBillMonth(data: BillMonthData, opts: { company: string; chart: ChartAccount[] }): BillMonthCheck {
  const { bills: worked, account, notes } = workOutBillMonth(data, opts);
  const itemNames = new Map((data.items ?? []).map((i) => [i.netsuite_id, i.name]));

  const summary: MonthSummary = { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 };
  const reasons = new Map<string, MonthReason>();
  const views: BillView[] = [];
  const notInGl: string[] = [];
  const moved: string[] = [];
  const used = new Set<string>();
  for (const { bill: b, number, lines, checked } of worked) {
    if (b.companies.length === 0) {
      // In neither company's GL copy: only worth a word when FleetSuite would post it.
      if (checked.status !== 'matches') notInGl.push(number);
      continue;
    }

    const why = billReasons(checked, b.type, account);
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
      return { lineId: r.lineId, label: ROLE_LABELS[r.role], division: null, fleetsuite: r.fleetsuite, netsuite: r.netsuite, cost: false, same: r.same };
    });
    const shownLines = (lines ?? []).map((l, i): BillLineView => {
      const copied = b.lines![i];
      return {
        label: l.tax ? 'Tax'
          : l.itemId ? itemNames.get(l.itemId) ?? `Item ${l.itemId}`
            : l.account ? `Expense to ${account(l.account)}` : 'Expense',
        quantity: copied.quantity,
        memo: copied.memo,
        cents: l.cents === null || l.cents === 0 || b.type === 'VendBill' ? l.cents : -l.cents,
      };
    });
    const bookedInto = b.posting_month && b.posting_month.slice(0, 7) !== b.date.slice(0, 7) ? b.posting_month : null;
    if (bookedInto) moved.push(number);
    views.push({
      netsuiteId: b.netsuite_id,
      number,
      date: b.date,
      ...(bookedInto ? { booked: { month: bookedInto, date: entryDate(b) } } : {}),
      customer: b.vendor,
      total: centsOf(b.total) ?? 0,
      voided: b.voided,
      status: checked.status,
      ...(checked.waiting ? { waiting: checked.waiting } : {}),
      reasons: why.map((r) => r.text),
      rows,
      type: b.type,
      ...(b.status ? { netsuiteStatus: b.status } : {}),
      from: (b.links ?? []).filter((l) => ORDERED_FROM[b.type].has(l.type ?? '')).map(linkName),
      lines: shownLines,
    });
  }

  if (moved.length) {
    const them = moved.length === 1 ? 'it' : 'them';
    notes.push(`${plural(moved.length, 'bill or bill credit dated in another month is', 'bills and bill credits dated in other months are')} here `
      + `because NetSuite booked ${them} into this month: ${listed(moved)}.`);
  }
  if (notInGl.length) {
    const them = notInGl.length === 1 ? 'it' : 'them';
    notes.push(`${plural(notInGl.length, 'more bill or bill credit', 'more bills and bill credits')} dated this month `
      + `${notInGl.length === 1 ? "isn't" : "aren't"} in the copy of NetSuite's GL for either company: ${listed(notInGl)}. NetSuite may not have `
      + `posted ${them} (a bill waiting for approval doesn't post), or the copy, which runs every two hours, hasn't reached ${them} yet.`);
  }
  const missing = (data.not_copied ?? []).map((m) => m.number || `NetSuite ${m.netsuite_id}`);
  if (missing.length) {
    const them = missing.length === 1 ? 'it' : 'them';
    notes.push(`The copy of NetSuite's GL has ${plural(missing.length, 'bill or bill credit', 'bills and bill credits')} of this company's `
      + `booked into this month that the copy of the bills doesn't: ${listed(missing)}. The bills copy runs every two hours and may not have `
      + `reached ${them} yet, or NetSuite deleted ${them} and the GL copy hasn't caught up.`);
  }

  return {
    summary,
    reasons: [...reasons.values()].sort((a, b) => b.invoices - a.invoices || a.text.localeCompare(b.text)),
    notes,
    invoices: views,
    accounts: Object.fromEntries([...used].sort().map((id) => [id, account(id)])),
  };
}
