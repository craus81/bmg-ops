import type { SupabaseClient } from '@supabase/supabase-js';
import { centsOf, entryDate, type WorkedInvoice } from './invoice-check';
import { invoiceEntry, type InvoiceLine, type RuleLine, type RuleResult } from './invoice-rule';
import { checkOwnCreditMemo, type OwnCreditMemoCheck, type OwnCreditMemoData, type OwnCreditPairsData } from './own-credit-memo-check';
import { ownLists } from './own-invoice-check';
import { pickChecked, type OwnMonth, type OwnPick, type OwnWords } from './own-invoice-posting';
import { OWN_COMPANY } from './own-invoices';

/**
 * Books' own credit memos posted to its books (migration 518; NetSuite Exit
 * Checklist, "Gaps in what's built", thread "Replacing NetSuite with
 * FleetSuite", 2026-11-03; docs/books.md "Posting FleetSuite's own credit
 * memos").
 *
 * A credit memo FleetSuite made against an invoice posts from Books' own copy
 * of it (src/lib/books/own-credit-memos.ts) instead of from NetSuite's when,
 * as for an own invoice (src/lib/books/own-invoice-posting.ts):
 *   - the copy matches NetSuite's credit memo, as Own credit memos checks it
 *     (src/lib/books/own-credit-memo-check.ts): who it's for, its date and
 *     location, each line, the sales tax it gives back and the total;
 *   - and the entry the copy makes is the one NetSuite's makes, account by
 *     account and division by division, with the same customer on the
 *     receivable and on the same date, so nothing in the books moves when a
 *     credit memo changes copies.
 * Otherwise NetSuite's credit memo posts, with the credit memo rule, since
 * that's what the customer was credited, and the pages say why.
 *
 * The copy's entry, own_credit_memo@1, is the credit memo rule's working
 * (src/lib/books/invoice-rule.ts) on the copy's own lines: each line back out
 * of its item's income account and division, the sales tax it gives back out
 * of the sales tax account own invoices post theirs to (salesTaxAccount), and
 * the receivable credited the copy's total for its FleetSuite customer. It's
 * the credit memo's entry as NetSuite's is, keyed `credit_memo:<NetSuite
 * id>:<n>`, in the month NetSuite booked the credit memo into, and its lines
 * name the copy's own (`own:<line>`, `own:tax`). The stock it puts back on
 * the shelf posts apart, as NetSuite's credit memo's cost lines do: from
 * Books' own copy too when what it put back matches (own_credit_memo_cost@1,
 * migration 519, src/lib/books/own-stock-posting.ts).
 *
 * Pure but for readOwnCreditCopies. Amounts are whole cents, debit positive.
 */

export const OWN_CREDIT_MEMO_RULE = 'own_credit_memo@1';

/** Books' own copy of a credit memo, and how it compares with NetSuite's. */
export interface OwnCreditCopy {
  own: OwnCreditMemoData;
  check: OwnCreditMemoCheck;
}

/** Books' own copies of credit memos, by NetSuite's id for the credit memo. */
export type OwnCreditCopies = Map<string, OwnCreditCopy>;

export const CREDIT_MEMO_WORDS: OwnWords = { theirs: "NetSuite's credit memo", done: 'credited' };

/** The rule takes a line as an invoice charges it: what a credit memo credits is the other way round. */
const backOut = (cents: number | null) => (cents === null || cents === 0 ? cents : -cents);

/** The copy's entry: the credit memo rule on its lines and the sales tax it gives back, the receivable first, or why it can't be worked out. */
export function ownCreditEntry(own: OwnCreditMemoData, accounts: OwnMonth['accounts'], salesTax: string | null): RuleResult {
  const lines: InvoiceLine[] = (own.lines ?? []).map((l) => ({
    lineId: `own:${l.line_no}`, itemId: l.item_id, itemNumber: l.item_number, tax: false, cents: backOut(centsOf(l.amount)),
  }));
  const tax = backOut(centsOf(own.tax));
  // No tax code: the one sales tax account stands in for every one.
  if (tax !== 0) lines.push({ lineId: 'own:tax', itemId: null, itemNumber: null, tax: true, cents: tax });
  return invoiceEntry(lines, { items: accounts.items, taxAccounts: new Map(salesTax ? [['', salesTax]] : []), receivable: accounts.receivable });
}

/**
 * What the books post for a credit memo, given Books' own copy of it and the entry NetSuite's makes with the credit
 * memo rule (`netsuite`, entryLines in src/lib/books/invoice-posting.ts). Null when the copy has no say: there's none,
 * or the document is an invoice, another company's, or posted to more than one.
 */
export function ownCreditPick(worked: WorkedInvoice, netsuite: RuleLine[], copy: OwnCreditCopy | undefined, month: OwnMonth): OwnPick | null {
  const inv = worked.invoice;
  if (!copy || month.company !== OWN_COMPANY || inv.doc_type !== 'credit_memo') return null;
  if (inv.companies.length !== 1 || inv.companies[0] !== month.company) return null;
  const { own, check } = copy;
  return pickChecked(worked, netsuite, check, () => ({
    result: ownCreditEntry(own, month.accounts, month.salesTax),
    date: entryDate({ date: own.date, posting_month: inv.posting_month }),
    customerId: own.customer_id,
  }), month.names, CREDIT_MEMO_WORDS);
}

/** Books' own copies of the credit memos FleetSuite made from `from` to `to` ('YYYY-MM-DD'), each checked against NetSuite's. */
export async function readOwnCreditCopies(service: SupabaseClient, from: string, to: string): Promise<OwnCreditCopies> {
  const res = await service.rpc('gl_own_credit_memo_pairs', { p_from: from, p_to: to, p_netsuite_id: null });
  if (res.error) throw new Error(res.error.message);
  const data = (res.data ?? {}) as OwnCreditPairsData;
  const lists = ownLists(data);
  return new Map((data.credit_memos ?? []).map((pair) => [pair.own.netsuite_id, { own: pair.own, check: checkOwnCreditMemo(pair, lists) }]));
}

/** The first month Books has an own credit memo in ('YYYY-MM-01'), or null when it has none. */
export async function readOwnCreditSince(service: SupabaseClient): Promise<string | null> {
  const res = await service.rpc('gl_own_credit_memo_months');
  if (res.error) throw new Error(res.error.message);
  return ((res.data ?? []) as Array<{ month: string }>).map((m) => m.month).sort()[0] ?? null;
}
