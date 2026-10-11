import { invoiceEntry, MAIN_LINE, type InvoiceLine, type RuleAccounts, type RuleItem, type RuleLine, type RuleProblem } from './invoice-rule';

/**
 * Each NetSuite invoice checked against NetSuite (docs/books.md "Invoices"):
 * FleetSuite's own entry from the invoice rule next to the GL lines NetSuite
 * posted for the same invoice (the copy, migration 361), line by line, to
 * the cent. Pure; amounts are whole cents, debit positive.
 */

export interface NetSuitePosting {
  /** NetSuite's transaction line id; MAIN_LINE is the invoice's own. */
  lineId: string;
  account: string;
  cents: number;
}

export interface CheckContext extends RuleAccounts {
  /** NetSuite account id → its type in the chart of accounts (gl_accounts.account_type). */
  accountTypes: Map<string, string>;
}

export type CheckStatus = 'matches' | 'differs' | 'unworkable' | 'waiting';

export interface CheckRow {
  lineId: string;
  /** The invoice's line, when the copy of the invoice has one by that id. */
  line: InvoiceLine | null;
  fleetsuite: RuleLine | null;
  netsuite: NetSuitePosting | null;
  /** NetSuite booked the cost of the stock sold on this line: left to the fulfillment rule, not compared. */
  cost: boolean;
  same: boolean;
}

export interface CheckedInvoice {
  status: CheckStatus;
  /** Why it's waiting: its lines aren't copied yet, or NetSuite's GL copy has nothing for it. */
  waiting?: 'lines' | 'gl';
  problems: RuleProblem[];
  /** Every line either side posts, the receivable first, then in the invoice's order. */
  rows: CheckRow[];
}

/**
 * The lines NetSuite booked cost of goods on. An invoice that wasn't
 * fulfilled first relieves the stock itself, on lines of its own: one to a
 * cost of goods sold account, one to the item's inventory asset account.
 * FleetSuite posts that cost with the fulfillment rule, so the invoice rule
 * leaves those lines out. A line that posts to its item's own income
 * account is a sale, whatever that account is.
 */
export function costLines(lines: InvoiceLine[], netsuite: Map<string, NetSuitePosting>, ctx: CheckContext): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    const posted = netsuite.get(line.lineId);
    if (!posted || line.tax || !line.itemId) continue;
    const item = ctx.items.get(line.itemId);
    if (item?.incomeAccount === posted.account) continue;
    if (ctx.accountTypes.get(posted.account) === 'cost_of_goods_sold' || item?.assetAccount === posted.account) {
      out.add(line.lineId);
    }
  }
  return out;
}

const byLineId = (a: string, b: string) => {
  const x = /^\d+$/.test(a) ? Number(a) : Infinity;
  const y = /^\d+$/.test(b) ? Number(b) : Infinity;
  return x - y || a.localeCompare(b);
};

export function checkInvoice(
  invoice: { lines: InvoiceLine[]; linesCopied: boolean; netsuite: NetSuitePosting[] },
  ctx: CheckContext,
): CheckedInvoice {
  if (!invoice.linesCopied) return { status: 'waiting', waiting: 'lines', problems: [], rows: [] };

  // A line that posts nothing is the same as no line.
  const netsuite = new Map<string, NetSuitePosting>();
  for (const p of invoice.netsuite) if (p.cents !== 0) netsuite.set(p.lineId, p);

  const cost = costLines(invoice.lines, netsuite, ctx);
  const entry = invoiceEntry(invoice.lines.filter((l) => !cost.has(l.lineId)), ctx);
  const fleetsuite = new Map(entry.lines.map((l) => [l.lineId, l]));

  const known = new Map(invoice.lines.map((l) => [l.lineId, l]));
  const ids = [MAIN_LINE, ...invoice.lines.map((l) => l.lineId).filter((id) => id !== MAIN_LINE)];
  ids.push(...[...netsuite.keys()].filter((id) => !known.has(id) && id !== MAIN_LINE).sort(byLineId));

  const rows: CheckRow[] = [];
  for (const lineId of ids) {
    const f = fleetsuite.get(lineId) ?? null;
    const n = netsuite.get(lineId) ?? null;
    if (!f && !n) continue;
    const isCost = cost.has(lineId);
    const same = isCost || (!!f && !!n && f.account === n.account && f.cents === n.cents);
    rows.push({ lineId, line: known.get(lineId) ?? null, fleetsuite: f, netsuite: n, cost: isCost, same });
  }

  if (entry.problems.length) return { status: 'unworkable', problems: entry.problems, rows };
  if (netsuite.size === 0 && invoice.netsuite.length === 0 && entry.lines.length > 0) {
    return { status: 'waiting', waiting: 'gl', problems: [], rows };
  }
  return { status: rows.every((r) => r.same) ? 'matches' : 'differs', problems: [], rows };
}

// ── Reasons, in words ──────────────────────────────────────────────────────

export interface ReasonNames {
  /** NetSuite account id → '4000 Sales'. */
  account: (id: string) => string;
  /** NetSuite tax code id → its name ('' = none). */
  taxCode: (id: string) => string;
}

export interface Reason {
  /** Groups the same reason across invoices. */
  key: string;
  text: string;
}

const itemLabel = (line: InvoiceLine | null, fallback: string) => line?.itemNumber || (line?.itemId ? `Item ${line.itemId}` : fallback);

export function problemReason(p: RuleProblem, names: ReasonNames): Reason {
  switch (p.kind) {
    case 'unreadable':
      return { key: 'unreadable', text: "A line's amount couldn't be read from the copy of the invoice." };
    case 'no_item':
      return { key: 'no_item', text: 'A line carries an amount but no item, so it has no income account.' };
    case 'not_copied':
      return {
        key: `not_copied|${p.itemId}`,
        text: `${p.itemNumber || `Item ${p.itemId}`} isn't in the copy of NetSuite's items yet. Sync now on the NetSuite lists page copies it.`,
      };
    case 'no_income_account':
      return { key: `no_income|${p.itemId}`, text: `${p.itemNumber} has no income account in the copy of NetSuite's items.` };
    case 'no_tax_account':
      return {
        key: `no_tax|${p.taxCode}`,
        text: `FleetSuite doesn't know where sales tax ${p.taxCode ? `for ${names.taxCode(p.taxCode)}` : 'with no tax code'} posts yet. `
          + "It learns that from NetSuite's sales tax postings since January 2025, as of the last copy of the NetSuite lists.",
      };
    case 'no_receivable':
      return { key: 'no_receivable', text: "The chart of accounts has no receivable account this company can use." };
  }
}

export function rowReason(row: CheckRow, names: ReasonNames): Reason | null {
  if (row.same) return null;
  const { fleetsuite: f, netsuite: n, line } = row;
  const acct = names.account;
  const what = row.lineId === MAIN_LINE ? 'receivable' : line?.tax ? 'tax' : line ? 'item' : 'unknown';

  if (what === 'unknown') {
    return { key: `unknown|${n!.account}`, text: `NetSuite posts to ${acct(n!.account)} on a line the copy of the invoice doesn't have.` };
  }
  if (what === 'receivable') {
    if (f && n && f.account !== n.account) {
      return { key: `receivable|${f.account}|${n.account}`, text: `Receivables: FleetSuite used ${acct(f.account)}, NetSuite ${acct(n.account)}.` };
    }
    return { key: 'receivable_amount', text: 'The total FleetSuite works out differs from what NetSuite put in receivables.' };
  }
  if (what === 'tax') {
    if (f && n && f.account !== n.account) {
      return { key: `tax|${f.account}|${n.account}`, text: `Sales tax: FleetSuite used ${acct(f.account)}, NetSuite ${acct(n.account)}.` };
    }
    if (f && n) return { key: 'tax_amount', text: 'Sales tax amounts differ.' };
    return f
      ? { key: 'tax_netsuite_none', text: 'NetSuite posted nothing for a sales tax line.' }
      : { key: 'tax_fleetsuite_none', text: 'NetSuite posted a sales tax line FleetSuite reads as $0.' };
  }
  const item = itemLabel(line, `Line ${row.lineId}`);
  const id = line?.itemId ?? '';
  if (f && n && f.account !== n.account) {
    return {
      key: `item|${id}|${f.account}|${n.account}`,
      text: `${item}: FleetSuite used its income account, ${acct(f.account)}; NetSuite posted to ${acct(n.account)}.`,
    };
  }
  if (f && n) return { key: `item_amount|${id}`, text: `${item}: the amounts differ.` };
  return f
    ? { key: `item_netsuite_none|${id}`, text: `${item}: NetSuite posts nothing for its line.` }
    : { key: `item_fleetsuite_none|${id}`, text: `${item}: NetSuite posts its line and FleetSuite doesn't.` };
}

/** Each distinct reason an invoice doesn't match, in the order its lines come. */
export function invoiceReasons(checked: CheckedInvoice, names: ReasonNames): Reason[] {
  const out = new Map<string, Reason>();
  for (const p of checked.problems) {
    const r = problemReason(p, names);
    if (!out.has(r.key)) out.set(r.key, r);
  }
  if (checked.status === 'differs') {
    for (const row of checked.rows) {
      const r = rowReason(row, names);
      if (r && !out.has(r.key)) out.set(r.key, r);
    }
  }
  return [...out.values()];
}

// ── A month ────────────────────────────────────────────────────────────────

export interface MonthSummary {
  invoices: number;
  matches: number;
  differs: number;
  unworkable: number;
  waiting: number;
  /** Invoices with lines NetSuite booked cost of goods on. */
  withCost: number;
}

export interface MonthReason extends Reason {
  invoices: number;
  /** A few of the invoices' numbers. */
  examples: string[];
}

export function summarize(checked: Array<{ number: string; checked: CheckedInvoice }>, names: ReasonNames, examples = 5) {
  const summary: MonthSummary = { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 };
  const reasons = new Map<string, MonthReason>();
  for (const { number, checked: c } of checked) {
    summary.invoices += 1;
    summary[c.status] += 1;
    if (c.rows.some((r) => r.cost)) summary.withCost += 1;
    for (const r of invoiceReasons(c, names)) {
      const m = reasons.get(r.key) ?? { ...r, invoices: 0, examples: [] };
      m.invoices += 1;
      if (m.examples.length < examples) m.examples.push(number);
      reasons.set(r.key, m);
    }
  }
  return { summary, reasons: [...reasons.values()].sort((a, b) => b.invoices - a.invoices || a.text.localeCompare(b.text)) };
}

// ── The receivable ─────────────────────────────────────────────────────────

export interface ChartAccount {
  netsuite_account_id: string | null;
  number: string | null;
  name: string;
  account_type: string;
  /** The company it's limited to; null = both. */
  company: string | null;
  active: boolean;
  is_summary: boolean;
}

/**
 * The receivable account a company's invoices debit: its only one, as the
 * chart of accounts has it. With more than one, the one NetSuite's invoices
 * used most this month, and a note saying so.
 */
export function pickReceivable(
  accounts: ChartAccount[],
  company: string,
  mainLines: NetSuitePosting[],
): { account: string | null; note: string | null } {
  const candidates = accounts.filter((a) => a.account_type === 'accounts_receivable' && a.active && !a.is_summary
    && a.netsuite_account_id && (a.company === null || a.company === company));
  if (candidates.length === 1) return { account: candidates[0].netsuite_account_id, note: null };
  if (candidates.length === 0) return { account: null, note: `The chart of accounts has no receivable account ${company} can use.` };

  const ids = new Set(candidates.map((a) => a.netsuite_account_id!));
  const uses = new Map<string, number>();
  for (const p of mainLines) if (ids.has(p.account)) uses.set(p.account, (uses.get(p.account) ?? 0) + 1);
  const [most] = [...uses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const pick = most?.[0] ?? candidates.map((a) => a.netsuite_account_id!).sort()[0];
  const name = (id: string) => {
    const a = candidates.find((c) => c.netsuite_account_id === id)!;
    return [a.number, a.name].filter(Boolean).join(' ');
  };
  return {
    account: pick,
    note: `${company} can use ${candidates.length} receivable accounts, so FleetSuite used ${name(pick)}, `
      + (most ? "the one NetSuite's invoices used most this month." : 'the first in the chart.'),
  };
}

// ── A month, from the database ─────────────────────────────────────────────

/** What gl_invoice_month (migration 364) returns. */
export interface InvoiceMonthData {
  invoices: Array<{
    id: string;
    netsuite_id: string;
    number: string | null;
    date: string;
    total: string;
    voided: boolean;
    customer: string | null;
    lines_copied: boolean;
    /** Companies NetSuite posted it to; empty when the GL copy has none of it. */
    companies: string[];
    lines: Array<{
      line_id: string;
      line_no: number | null;
      kind: string;
      item_id: string | null;
      item_number: string | null;
      amount: string;
      netamount: string | null;
    }>;
    netsuite: Array<{ line_id: string; account: string; debit: string; credit: string }>;
  }>;
  items: Array<{
    kind: 'item' | 'tax_code';
    netsuite_id: string;
    name: string;
    item_type: string | null;
    income_account: string | null;
    asset_account: string | null;
  }>;
}

/** Where a tax code's sales tax posted, as the lists copy counted it (src/lib/books/netsuite-lists.ts). */
export interface TaxAccountCount {
  tax_code_id: string | null;
  account_id: string;
  lines: number;
}

export interface AccountAmount {
  account: string;
  /** Debit positive. */
  cents: number;
}

export interface InvoiceRowView {
  lineId: string;
  label: string;
  division: 'upfit' | 'graphics' | null;
  fleetsuite: AccountAmount | null;
  netsuite: AccountAmount | null;
  cost: boolean;
  same: boolean;
}

export interface InvoiceView {
  netsuiteId: string;
  number: string;
  date: string;
  customer: string | null;
  total: number;
  voided: boolean;
  status: CheckStatus;
  waiting?: 'lines' | 'gl';
  reasons: string[];
  rows: InvoiceRowView[];
}

export interface MonthCheck {
  summary: MonthSummary;
  reasons: MonthReason[];
  notes: string[];
  invoices: InvoiceView[];
  /** NetSuite account id → '4000 Sales', for every account the rows name. */
  accounts: Record<string, string>;
}

/** Whole cents from a decimal string or number, signed; null when it can't be read. */
export function centsOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return cents === 0 ? 0 : cents;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function checkMonth(
  data: InvoiceMonthData,
  opts: { company: string; chart: ChartAccount[]; taxAccounts: TaxAccountCount[] | null },
): MonthCheck {
  const items = new Map<string, RuleItem>();
  const taxNames = new Map<string, string>();
  for (const it of data.items) {
    if (it.kind === 'tax_code') taxNames.set(it.netsuite_id, it.name);
    else items.set(it.netsuite_id, { number: it.name, type: it.item_type, incomeAccount: it.income_account, assetAccount: it.asset_account });
  }

  // The tax code's most used account.
  const taxAccounts = new Map<string, string>();
  const best = new Map<string, number>();
  for (const t of opts.taxAccounts ?? []) {
    const code = t.tax_code_id ?? '';
    if ((best.get(code) ?? -1) < t.lines) {
      best.set(code, t.lines);
      taxAccounts.set(code, t.account_id);
    }
  }

  const accountTypes = new Map<string, string>();
  const accountNames = new Map<string, string>();
  for (const a of opts.chart) {
    if (!a.netsuite_account_id) continue;
    accountTypes.set(a.netsuite_account_id, a.account_type);
    accountNames.set(a.netsuite_account_id, [a.number, a.name].filter(Boolean).join(' '));
  }

  const postings = (inv: InvoiceMonthData['invoices'][number]): NetSuitePosting[] =>
    inv.netsuite.map((l) => ({ lineId: l.line_id, account: l.account, cents: (centsOf(l.debit) ?? 0) - (centsOf(l.credit) ?? 0) }));
  const mainLines = data.invoices.flatMap((inv) => postings(inv).filter((p) => p.lineId === MAIN_LINE));
  const receivable = pickReceivable(opts.chart, opts.company, mainLines);

  const ctx: CheckContext = { items, taxAccounts, receivable: receivable.account, accountTypes };
  const names: ReasonNames = {
    account: (id) => accountNames.get(id) ?? `NetSuite account ${id}`,
    taxCode: (id) => taxNames.get(id) ?? `tax code ${id}`,
  };

  const checked: Array<{ number: string; checked: CheckedInvoice }> = [];
  const invoices: InvoiceView[] = [];
  const notInGl: string[] = [];
  const used = new Set<string>();
  for (const inv of data.invoices) {
    const number = inv.number || `NetSuite ${inv.netsuite_id}`;
    const lines: InvoiceLine[] = inv.lines.map((l) => {
      // NetSuite's netamount is signed, a sale negative; the mirror's amount isn't, so it only says "nothing".
      let cents: number | null;
      if (l.netamount !== null) {
        const net = centsOf(l.netamount);
        cents = net === null ? null : net === 0 ? 0 : -net;
      } else {
        cents = centsOf(l.amount) === 0 ? 0 : null;
      }
      return { lineId: l.line_id, itemId: l.item_id, itemNumber: l.item_number, tax: l.kind === 'tax', cents };
    });
    const c = checkInvoice({ lines, linesCopied: inv.lines_copied, netsuite: postings(inv) }, ctx);
    if (inv.companies.length === 0) {
      // In neither company's GL copy: only worth a word when FleetSuite would post it.
      if (c.status !== 'matches') notInGl.push(number);
      continue;
    }
    checked.push({ number, checked: c });

    const rows = c.rows.map((r): InvoiceRowView => {
      const label = r.lineId === MAIN_LINE ? 'Receivable'
        : r.line?.tax ? (r.line.itemId ? `Sales tax, ${names.taxCode(r.line.itemId)}` : 'Sales tax')
          : r.line ? r.line.itemNumber || (r.line.itemId ? `Item ${r.line.itemId}` : `Line ${r.lineId}`)
            : `Line ${r.lineId}`;
      if (r.fleetsuite) used.add(r.fleetsuite.account);
      if (r.netsuite) used.add(r.netsuite.account);
      return {
        lineId: r.lineId,
        label,
        division: r.fleetsuite?.division ?? null,
        fleetsuite: r.fleetsuite ? { account: r.fleetsuite.account, cents: r.fleetsuite.cents } : null,
        netsuite: r.netsuite ? { account: r.netsuite.account, cents: r.netsuite.cents } : null,
        cost: r.cost,
        same: r.same,
      };
    });
    invoices.push({
      netsuiteId: inv.netsuite_id,
      number,
      date: inv.date,
      customer: inv.customer,
      total: centsOf(inv.total) ?? 0,
      voided: inv.voided,
      status: c.status,
      ...(c.waiting ? { waiting: c.waiting } : {}),
      reasons: invoiceReasons(c, names).map((r) => r.text),
      rows,
    });
  }

  const { summary, reasons } = summarize(checked, names);
  const notes: string[] = [];
  if (receivable.note) notes.push(receivable.note);
  if (!opts.taxAccounts) notes.push("Where sales tax posts hasn't been read yet. Sync now on the NetSuite lists page reads it.");
  if (summary.withCost) {
    notes.push(`${plural(summary.withCost, 'invoice also books', 'invoices also book')} the cost of the stock sold, as NetSuite does when an `
      + "invoice isn't fulfilled first. FleetSuite will post that cost with the fulfillment rule, so those lines aren't compared here.");
  }
  if (notInGl.length) {
    const shown = notInGl.slice(0, 10).join(', ');
    notes.push(`${plural(notInGl.length, 'more invoice', 'more invoices')} dated this month ${notInGl.length === 1 ? "isn't" : "aren't"} in the copy `
      + `of NetSuite's GL for either company: ${shown}${notInGl.length > 10 ? ', …' : ''}. NetSuite may not have posted `
      + `${notInGl.length === 1 ? 'it' : 'them'} (an invoice waiting for approval doesn't post), or the copy, which runs every two hours, hasn't reached `
      + `${notInGl.length === 1 ? 'it' : 'them'} yet.`);
  }

  return {
    summary,
    reasons,
    notes,
    invoices,
    accounts: Object.fromEntries([...used].sort().map((id) => [id, names.account(id)])),
  };
}
