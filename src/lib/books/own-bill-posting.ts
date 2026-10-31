import type { SupabaseClient } from '@supabase/supabase-js';
import { centsOf, entryDate } from './invoice-check';
import { BILL_SOURCE_TYPE, PAYABLES_LINE, billEntry, type BillLine, type BillRuleLine } from './bill-rule';
import { billProblemReason, type WorkedBill } from './bill-check';
import { billLists, checkOwnBill, type BillCopiesThrough, type BillPairsData, type OwnBillCheck, type OwnBillData } from './own-bill-check';
import { dayText } from './own-invoice-check';
import type { OwnBooksRead } from './own-invoice-posting';
import { accountsApart, listed, type ChartNames } from './own-stock-posting';

/**
 * Books' own bills posted to FleetSuite's books (migration 456; owner
 * decision 2026-10-30, thread "Replacing NetSuite with FleetSuite", "Own
 * postings", then "Build it"; docs/books.md "Posting FleetSuite's own
 * fulfillments, receipts and bills").
 *
 * A bill FleetSuite made in NetSuite (Parts Mail, CNI vendor invoices,
 * installer payouts and Snap a bill) posts from Books' own copy of it
 * (src/lib/books/own-bills.ts) instead of from NetSuite's bill, as an
 * invoice FleetSuite made does (src/lib/books/own-invoice-posting.ts), when:
 *   - the copy matches NetSuite's bill, as Own bills checks it
 *     (src/lib/books/own-bill-check.ts): who it's from, its number, date and
 *     company, each line and its total;
 *   - and the entry the copy makes is the one NetSuite's makes with the bill
 *     rule, account by account, for the same vendor and on the same day, so
 *     nothing in the books moves when a bill changes copies.
 * Otherwise NetSuite's bill posts, with the bill rule, and the pages say
 * why.
 *
 * The copy's entry, own_bill@1, is the bill rule's working
 * (src/lib/books/bill-rule.ts) on the copy's own lines, with the accounts
 * NetSuite's bill is worked out with (workOutBillMonth in
 * src/lib/books/bill-check.ts): payables take the copy's total and carry its
 * vendor, an expense line goes to its account, and an item line to where
 * NetSuite puts it, a stock item from a purchase order's line to the account
 * received stock is held against until it's billed. It's the bill's entry as
 * NetSuite's is, keyed `vendor_bill:<NetSuite id>:<n>`, in the month NetSuite
 * booked the bill into, and its lines name the copy's own (`own:<line>`).
 *
 * Pure but for the reads. Amounts are whole cents, debit positive.
 */

export const OWN_BILL_RULE = 'own_bill@1';

/** Books' own copy of a bill, and how it compares with NetSuite's. */
export interface OwnBillCopy {
  own: OwnBillData;
  check: OwnBillCheck;
}

/** Books' own copies, by NetSuite's id for the bill. */
export type OwnBillCopies = Map<string, OwnBillCopy>;

/** A copy's entry: the bill rule's lines, payables first, its date and the vendor on payables. */
export interface OwnBillEntry {
  lines: BillRuleLine[];
  date: string;
  vendorRef: string | null;
}

/** What the books post for a bill Books has its own copy of. */
export interface OwnBillPick {
  /** The copy's entry, when the books post it. */
  entry: OwnBillEntry | null;
  /** Why NetSuite's bill posts instead, in a sentence or two; null when the copy posts, or there's nothing to say. */
  why: string | null;
  /** The copy's entry as worked out, whether or not the books post it; null when it isn't worked out. */
  own: OwnBillEntry | null;
  /** How the copy's entry differs from NetSuite's, when that's why NetSuite's posts. */
  differs: string | null;
}

/** The copy's lines as the bill rule takes them: a line made from a purchase order's line came from the order. */
export function ownBillLines(own: OwnBillData): BillLine[] {
  return (own.lines ?? []).map((l) => ({
    lineId: `own:${l.line_no}`,
    itemId: l.item_id,
    account: l.account_id,
    cents: l.amount === null ? null : centsOf(l.amount),
    tax: false,
    ordered: l.po_line_id ? true : null,
  }));
}

/** How the copy's entry differs from NetSuite's, in a clause or two; null when it doesn't. */
function billEntryDifference(mine: OwnBillEntry, theirs: OwnBillEntry, names: ChartNames): string | null {
  const parts: string[] = [];
  if (mine.date !== theirs.date) parts.push(`it's dated ${dayText(mine.date)}, and NetSuite's ${dayText(theirs.date)}`);
  const apart = accountsApart(mine.lines, theirs.lines);
  if (apart.length) parts.push(`it posts differently to ${listed(apart.map(names.account))}`);
  else if (mine.lines.some((l) => l.lineId === PAYABLES_LINE) && (mine.vendorRef ?? null) !== (theirs.vendorRef ?? null)) {
    parts.push(mine.vendorRef ? 'its payables are for another vendor' : 'its payables are for no vendor');
  }
  return parts.length ? parts.join('; ') : null;
}

/**
 * What the books post for a bill, given Books' own copy of it and the bill as the rule worked it out. Null when the
 * copy has no say: there's none, the document is a bill credit, or it's another company's, or posted to more than one.
 */
export function ownBillPick(worked: WorkedBill, copy: OwnBillCopy | undefined, month: { company: string; names: ChartNames }): OwnBillPick | null {
  const b = worked.bill;
  if (!copy || b.type !== 'VendBill') return null;
  if (copy.own.company !== month.company || b.companies.length !== 1 || b.companies[0] !== month.company) return null;
  const { own, check } = copy;
  const not = (why: string | null, more: Partial<OwnBillPick> = {}): OwnBillPick => ({ entry: null, why, own: null, differs: null, ...more });

  if (check.status === 'voided') return not(null);
  if (check.status === 'waiting') return not("FleetSuite's own copy is waiting for NetSuite's bill to be copied, so the books post NetSuite's for now.");
  if (check.status === 'differs') return not("FleetSuite's own copy differs from NetSuite's bill, so the books post NetSuite's.");
  if (check.status === 'incomplete') {
    return not(check.unknowns.length
      ? `FleetSuite's own copy matches where it can be checked but is incomplete, so the books post NetSuite's bill: FleetSuite didn't know ${listed(check.unknowns)}.`
      : `FleetSuite's own copy is incomplete, so the books post NetSuite's bill. ${check.summary}`);
  }
  // NetSuite's own entry can't be worked out yet, or its copy is mid-refresh: whatever stands stays, whichever copy made it.
  if (worked.checked.status === 'waiting' || worked.checked.status === 'unworkable') return not(null);

  const built = billEntry({ lines: ownBillLines(own), ordered: own.po_id !== null }, worked.accounts);
  if (built.problems.length) {
    return not(`FleetSuite's own copy matches NetSuite's bill, but its entry can't be worked out, so the books post NetSuite's. ${billProblemReason(built.problems[0], 'VendBill').text}`);
  }
  const mine: OwnBillEntry = { lines: built.lines, date: entryDate({ date: own.date, posting_month: b.posting_month }), vendorRef: own.vendor_id };
  const theirs: OwnBillEntry = { lines: worked.checked.lines, date: entryDate(b), vendorRef: b.vendor_netsuite_id ?? null };
  const differs = billEntryDifference(mine, theirs, month.names);
  if (differs) {
    return not(`FleetSuite's own copy matches NetSuite's bill, but its entry doesn't match NetSuite's, so the books post NetSuite's: ${differs}.`,
      { own: mine, differs });
  }
  // Nothing to post either way.
  if (!mine.lines.length) return not(null, { own: mine });
  return { entry: mine, why: null, own: mine, differs: null };
}

/** Books' own copies of the bills FleetSuite made from `from` to `to` ('YYYY-MM-DD'), each checked against NetSuite's. */
export async function readOwnBillCopies(service: SupabaseClient, from: string, to: string, through: BillCopiesThrough): Promise<OwnBillCopies> {
  const res = await service.rpc('gl_own_bill_pairs', { p_from: from, p_to: to, p_netsuite_id: null });
  if (res.error) throw new Error(res.error.message);
  const data = (res.data ?? {}) as BillPairsData;
  const lists = billLists(data);
  return new Map((data.bills ?? []).map((pair) => [pair.own.netsuite_id, { own: pair.own, check: checkOwnBill(pair, lists, through) }]));
}

/** The first month Books made an own copy of a bill in ('YYYY-MM-01'), from gl_own_bill_months; null when it has none. */
export async function readOwnBillSince(service: SupabaseClient): Promise<string | null> {
  const res = await service.rpc('gl_own_bill_months');
  if (res.error) throw new Error(res.error.message);
  return ((res.data ?? []) as Array<{ month: string }>).map((m) => m.month).sort()[0] ?? null;
}

/** How the journal says what it holds for a bill (gl_bill_postings, migration 456). */
export const BILL_BOOKS: OwnBooksRead = { fn: 'gl_bill_postings', list: 'bills', sourceType: BILL_SOURCE_TYPE.VendBill, ownRule: OWN_BILL_RULE };
