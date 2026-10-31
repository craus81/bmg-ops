import type { SupabaseClient } from '@supabase/supabase-js';
import {
  centsOf, entryDate, problemReason,
  type ChartAccount, type CheckContext, type ReasonNames, type TaxAccountCount, type WorkedInvoice,
} from './invoice-check';
import { invoiceEntry, MAIN_LINE, type InvoiceLine, type RuleLine, type RuleProblem, type RuleResult } from './invoice-rule';
import { checkOwnInvoice, dayText, ownLists, type OwnInvoiceCheck, type OwnInvoiceData, type OwnPairsData } from './own-invoice-check';
import { OWN_COMPANY } from './own-invoices';

/**
 * FleetSuite's own invoices posted to its books (migration 409; owner
 * decision 2026-10-19, thread "Replacing NetSuite with FleetSuite", "Post
 * own invoices"; docs/books.md "Posting FleetSuite's own invoices").
 *
 * An invoice FleetSuite made posts from FleetSuite's own copy of it
 * (src/lib/books/own-invoices.ts) instead of from NetSuite's when:
 *   - the copy matches NetSuite's invoice, as Own invoices checks it
 *     (src/lib/books/own-invoice-check.ts): who it's for, its date,
 *     location and due date, each line, the sales tax and the total;
 *   - and the entry the copy makes is the one NetSuite's makes, account by
 *     account and division by division, with the same customer on the
 *     receivable and on the same date, so nothing in the books moves when an
 *     invoice changes copies.
 * Otherwise NetSuite's invoice posts, with the invoice rule, since that's
 * what the customer was billed, and the pages say why.
 *
 * The copy's entry, own_invoice@1, is the invoice rule's working
 * (src/lib/books/invoice-rule.ts) on FleetSuite's own lines: the receivable
 * takes the copy's total and carries its FleetSuite customer, each line goes
 * to its item's income account and division as NetSuite's line would, and
 * the copy's sales tax goes to the sales tax account, the one NetSuite's
 * sales tax has posted to most since January 2025 (salesTaxAccount):
 * FleetSuite works its tax out at the one rate in Settings, with no tax code
 * to look an account up by. It's the invoice's entry as NetSuite's is, keyed
 * `invoice:<NetSuite id>:<n>`, in the month NetSuite booked the invoice into,
 * and its lines name FleetSuite's own (`own:<line>`, `own:tax`).
 *
 * Pure but for readOwnCopies. Amounts are whole cents, debit positive.
 */

export const OWN_INVOICE_RULE = 'own_invoice@1';

/** FleetSuite's own copy of an invoice, and how it compares with NetSuite's. */
export interface OwnCopy {
  own: OwnInvoiceData;
  check: OwnInvoiceCheck;
}

/** FleetSuite's own copies, by NetSuite's id for the invoice. */
export type OwnCopies = Map<string, OwnCopy>;

/** What the books post for an invoice FleetSuite has its own copy of. */
export interface OwnPick {
  /** The copy's entry, when the books post it: its lines, the receivable first, its date and the receivable's customer. */
  entry: { lines: RuleLine[]; date: string; customerId: string | null } | null;
  /** Why NetSuite's invoice posts instead, in a sentence or two; null when the copy posts, or there's nothing to say. */
  why: string | null;
}

/** The month an invoice is in, as the invoice rule worked it out (workOutMonth), and the account the copies' sales tax goes to. */
export interface OwnMonth {
  company: string;
  accounts: Pick<CheckContext, 'items' | 'receivable'>;
  names: ReasonNames;
  salesTax: string | null;
}

const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * The account FleetSuite's own copies post their sales tax to: of the accounts the company can use in the chart of
 * accounts, the one NetSuite's sales tax lines have posted to most since January 2025, as the lists copy counted them.
 * Null before the lists copy has counted them, or when none of them is the company's.
 */
export function salesTaxAccount(counts: TaxAccountCount[] | null, chart: ChartAccount[], company: string): string | null {
  if (!counts) return null;
  const usable = new Set(chart
    .filter((a) => a.netsuite_account_id && !a.is_summary && (a.company === null || a.company === company))
    .map((a) => a.netsuite_account_id!));
  const lines = new Map<string, number>();
  for (const c of counts) if (usable.has(c.account_id)) lines.set(c.account_id, (lines.get(c.account_id) ?? 0) + c.lines);
  const [most] = [...lines].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return most?.[0] ?? null;
}

/** The copy's entry: the invoice rule on its lines and its sales tax, the receivable first, or why it can't be worked out. */
export function ownEntry(own: OwnInvoiceData, accounts: OwnMonth['accounts'], salesTax: string | null): RuleResult {
  const lines: InvoiceLine[] = (own.lines ?? []).map((l) => ({
    lineId: `own:${l.line_no}`, itemId: l.item_id, itemNumber: l.item_number, tax: false, cents: centsOf(l.amount),
  }));
  const tax = centsOf(own.tax);
  // No tax code: the one sales tax account stands in for every one.
  if (tax !== 0) lines.push({ lineId: 'own:tax', itemId: null, itemNumber: null, tax: true, cents: tax });
  return invoiceEntry(lines, { items: accounts.items, taxAccounts: new Map(salesTax ? [['', salesTax]] : []), receivable: accounts.receivable });
}

/** What an entry puts in each account and division, the receivable's under its customer, nothing left out but $0. */
function movements(lines: RuleLine[], customerId: string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    const key = [l.account, l.division ?? '', l.lineId === MAIN_LINE ? customerId ?? '' : ''].join('|');
    out.set(key, (out.get(key) ?? 0) + l.cents);
  }
  for (const [key, cents] of out) if (cents === 0) out.delete(key);
  return out;
}

const DIVISION_WORDS: Record<string, string> = { upfit: 'Upfit', graphics: 'Graphics' };

/** How the copy's entry differs from NetSuite's, in a clause or two; null when it doesn't. */
function entryDifference(
  mine: { lines: RuleLine[]; date: string; customerId: string | null },
  theirs: { lines: RuleLine[]; date: string; customerId: string | null },
  names: ReasonNames,
): string | null {
  const parts: string[] = [];
  if (mine.date !== theirs.date) parts.push(`it's dated ${dayText(mine.date)}, and NetSuite's ${dayText(theirs.date)}`);
  const a = movements(mine.lines, null);
  const b = movements(theirs.lines, null);
  const accounts = [...new Set([...a.keys(), ...b.keys()])].filter((k) => (a.get(k) ?? 0) !== (b.get(k) ?? 0)).sort();
  if (accounts.length) {
    const named = accounts.map((k) => {
      const [account, division] = k.split('|');
      return `${names.account(account)}${division ? ` (${DIVISION_WORDS[division] ?? division})` : ''}`;
    });
    parts.push(`it posts differently to ${listed(named)}`);
  } else if ((mine.customerId ?? null) !== (theirs.customerId ?? null)) {
    parts.push(mine.customerId ? 'its receivable is for another FleetSuite customer' : 'its receivable is for no FleetSuite customer');
  }
  return parts.length ? parts.join('; ') : null;
}

/** Why the copy's entry can't be worked out, in a sentence. */
function problemText(p: RuleProblem, names: ReasonNames): string {
  if (p.kind === 'no_tax_account') {
    return "FleetSuite doesn't know which account its sales tax goes to yet: it takes the one NetSuite's sales tax has posted to most "
      + 'since January 2025, as of the last copy of the NetSuite lists.';
  }
  return problemReason(p, names).text;
}

/**
 * What the books post for an invoice, given FleetSuite's own copy of it and the entry NetSuite's makes with the
 * invoice rule (`netsuite`, entryLines in src/lib/books/invoice-posting.ts). Null when the copy has no say: there's
 * none, or the invoice is a credit memo, another company's, or posted to more than one.
 */
export function ownPick(worked: WorkedInvoice, netsuite: RuleLine[], copy: OwnCopy | undefined, month: OwnMonth): OwnPick | null {
  const inv = worked.invoice;
  if (!copy || month.company !== OWN_COMPANY || inv.doc_type === 'credit_memo') return null;
  if (inv.companies.length !== 1 || inv.companies[0] !== month.company) return null;
  const { own, check } = copy;
  const not = (why: string | null): OwnPick => ({ entry: null, why });

  if (check.status === 'voided') return not(null);
  if (check.status === 'waiting') return not("FleetSuite's own copy is waiting for NetSuite's invoice to be copied, so the books post NetSuite's for now.");
  if (check.status === 'differs') {
    return not("FleetSuite's own copy differs from NetSuite's invoice, so the books post NetSuite's, since that's what the customer was billed.");
  }
  if (check.status === 'incomplete') {
    return not("FleetSuite's own copy matches where it can be checked but is incomplete, so the books post NetSuite's invoice: "
      + `FleetSuite didn't know ${listed(check.unknowns)}.`);
  }
  // NetSuite's own entry can't be worked out yet, or its copy is mid-refresh: whatever stands stays, whichever copy made it.
  if (worked.checked.status === 'waiting' || worked.checked.status === 'unworkable') return not(null);

  const built = ownEntry(own, month.accounts, month.salesTax);
  if (built.problems.length) {
    return not(`FleetSuite's own copy matches NetSuite's invoice, but its entry can't be worked out, so the books post NetSuite's. ${problemText(built.problems[0], month.names)}`);
  }
  const entry = { lines: built.lines, date: entryDate({ date: own.date, posting_month: inv.posting_month }), customerId: own.customer_id };
  const differs = entryDifference(entry, { lines: netsuite, date: entryDate(inv), customerId: inv.customer_id ?? null }, month.names);
  if (differs) return not(`FleetSuite's own copy matches NetSuite's invoice, but its entry doesn't match NetSuite's, so the books post NetSuite's: ${differs}.`);
  return { entry, why: null };
}

/** What the books hold for an invoice: the entry that stands, its date, and which copy of the invoice it was made from. */
export interface OwnBooks {
  entryNo: number;
  date: string;
  from: 'netsuite' | 'fleetsuite';
}

type PostingsRead = ReadonlyArray<{
  source_type: string;
  source_id: string;
  current: { entry_no: number; entry_date: string; posting_rule?: string } | null;
}>;

/**
 * What the books hold for each invoice, by NetSuite's id, from what gl_invoice_postings returns for them (migration
 * 409): an invoice with no entry standing is left out. A fulfillment's, receipt's or bill's the same way, from
 * gl_stock_postings or gl_bill_postings (migration 456), given its kind (the entries' source type) and the rule Books'
 * own copies of it post with.
 */
export function ownBooks(postings: PostingsRead, sourceType = 'invoice', ownRule = OWN_INVOICE_RULE): Map<string, OwnBooks> {
  const out = new Map<string, OwnBooks>();
  for (const p of postings) {
    if (p.source_type !== sourceType || !p.current) continue;
    out.set(p.source_id, {
      entryNo: p.current.entry_no,
      date: p.current.entry_date,
      from: p.current.posting_rule === ownRule ? 'fleetsuite' : 'netsuite',
    });
  }
  return out;
}

/** How the journal says what it holds for a kind of document Books has its own copies of: its read, the list it answers with, the kind and the copies' rule. */
export interface OwnBooksRead {
  fn: string;
  list: string;
  sourceType: string;
  ownRule: string;
}

/** What the books hold for some documents of one kind, each with its company, by NetSuite's id: read company by company. */
export async function readOwnBooks(
  service: SupabaseClient,
  read: OwnBooksRead,
  documents: ReadonlyArray<{ company: string; netsuiteId: string }>,
): Promise<Map<string, OwnBooks>> {
  const byCompany = new Map<string, string[]>();
  for (const d of documents) byCompany.set(d.company, [...(byCompany.get(d.company) ?? []), d.netsuiteId]);
  const out = new Map<string, OwnBooks>();
  await Promise.all([...byCompany].map(async ([company, ids]) => {
    const res = await service.rpc(read.fn, { p_company: company, p_source_ids: ids, p_lines: false });
    if (res.error) throw new Error(res.error.message);
    const postings = ((res.data ?? {}) as Record<string, PostingsRead | undefined>)[read.list] ?? [];
    for (const [id, books] of ownBooks(postings, read.sourceType, read.ownRule)) out.set(id, books);
  }));
  return out;
}

/** FleetSuite's own copies of the invoices it made from `from` to `to` ('YYYY-MM-DD'), each checked against NetSuite's. */
export async function readOwnCopies(service: SupabaseClient, from: string, to: string): Promise<OwnCopies> {
  const res = await service.rpc('gl_own_invoice_pairs', { p_from: from, p_to: to, p_netsuite_id: null });
  if (res.error) throw new Error(res.error.message);
  const data = (res.data ?? {}) as OwnPairsData;
  const lists = ownLists(data);
  return new Map((data.invoices ?? []).map((pair) => [pair.own.netsuite_id, { own: pair.own, check: checkOwnInvoice(pair, lists) }]));
}

/**
 * The days a month's invoices are dated across, which their own copies are made on: none before `since`, the first
 * day FleetSuite could have one ('YYYY-MM-DD', its first month with any when known). Null when no copy can be there.
 */
export function ownCopyDays(invoices: ReadonlyArray<{ date: string }>, since: string | null = null): { from: string; to: string } | null {
  if (!invoices.length) return null;
  const dates = invoices.map((i) => i.date).sort();
  const to = dates[dates.length - 1];
  const from = since && since > dates[0] ? since : dates[0];
  return from <= to ? { from, to } : null;
}
