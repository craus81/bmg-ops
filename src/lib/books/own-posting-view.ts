import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import type { ChartAccount } from './invoice-check';
import { workOutStockMonth, type StockDocument } from './stock-check';
import { workOutBillMonth } from './bill-check';
import { readBillMonth } from './invoice-posting';
import { readOwnBooks, type OwnBooks } from './own-invoice-posting';
import {
  ADJUSTMENT_BOOKS, FULFILLMENT_BOOKS, RECEIPT_BOOKS, chartNames, entryRows, ownStockPick, readOwnStockAccounts, type EntryRow,
} from './own-stock-posting';
import { BILL_BOOKS, ownBillPick, type OwnBillCopy } from './own-bill-posting';
import type { OwnFulfillmentCheck } from './own-fulfillment-check';
import type { OwnReceiptCheck } from './own-receipt-check';
import type { OwnAdjustmentCheck } from './own-adjustment-check';
import { OWN_COMPANY } from './own-invoices';

/**
 * How Books' own copies of fulfillments, receipts, adjustments and bills
 * post, for their pages on Own fulfillments, Own receipts, Own adjustments
 * and Own bills (migrations 456 and 457, docs/books.md "Posting FleetSuite's
 * own fulfillments, receipts and bills"): what the books hold for NetSuite's
 * document, and the copy's entry next to NetSuite's, worked out as the
 * posting run works them out (src/lib/books/own-stock-posting.ts and
 * own-bill-posting.ts).
 */

/** The chart of accounts as the checks take it, each account with its company's code. */
export async function readChart(service: SupabaseClient): Promise<ChartAccount[]> {
  const [accounts, companies] = await Promise.all([
    fetchAllRows<Omit<ChartAccount, 'company'> & { company_id: string | null }>((from, to) => service
      .from('gl_accounts')
      .select('netsuite_account_id, number, name, account_type, company_id, active, is_summary')
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('gl_companies').select('id, code'),
  ]);
  if (accounts.error) throw new Error(accounts.error.message);
  if (companies.error) throw new Error(companies.error.message);
  const codeOf = new Map(((companies.data ?? []) as Array<{ id: string; code: string }>).map((c) => [c.id, c.code]));
  return accounts.data.map(({ company_id, ...a }) => ({ ...a, company: company_id ? codeOf.get(company_id) ?? null : null }));
}

/** How Books' own copy of a document posts, for its page on Own fulfillments, Own receipts, Own adjustments or Own bills. */
export interface OwnPostingView {
  /** What the books hold for NetSuite's document: the entry that stands, its date and which copy made it; null when none stands. */
  books: OwnBooks | null;
  /** The month NetSuite booked its document into ('YYYY-MM-01'), which Invoices vs NetSuite lists it under; null before the copy of NetSuite's GL has it. */
  month: string | null;
  /** Whether the books post this copy. */
  posts: boolean;
  /** Why they post NetSuite's document instead, in a sentence or two; null when there's nothing to say. */
  why: string | null;
  /** The copy's entry next to NetSuite's, account by account, debits first; null when the copy's isn't worked out. */
  entry: EntryRow[] | null;
  /** How the copy's entry differs from NetSuite's, when that's why NetSuite's posts. */
  differs: string | null;
  /** What a copy of a fulfillment takes from NetSuite's posting of it next time, a sentence each. */
  learned: string[];
  /** Where each item's cost goes on a copy of a fulfillment, in a sentence or two. */
  costs: string | null;
}

/** What a page says of a copy whose NetSuite document the books can't work out yet. */
const NOTHING = { posts: false, why: null, entry: null, differs: null, costs: null } as const;

/**
 * How Books' own copy of a fulfillment, item receipt or adjustment posts, for its page: what the books hold for
 * NetSuite's document, and the copy's entry next to NetSuite's when it's worked out, as the posting run works them out.
 */
export async function readOwnStockView(
  service: SupabaseClient,
  copy:
    | { kind: 'fulfillment'; check: OwnFulfillmentCheck }
    | { kind: 'receipt'; check: OwnReceiptCheck & { netsuiteId: string } }
    | { kind: 'adjustment'; check: OwnAdjustmentCheck & { netsuiteId: string } },
): Promise<OwnPostingView> {
  const id = copy.check.netsuiteId;
  const company = copy.kind === 'receipt' ? copy.check.company : OWN_COMPANY;
  const fulfillments = new Map<string, OwnFulfillmentCheck>(copy.kind === 'fulfillment' ? [[id, copy.check]] : []);
  const receipts = new Map<string, OwnReceiptCheck>(copy.kind === 'receipt' ? [[id, copy.check]] : []);
  const adjustments = new Map<string, OwnAdjustmentCheck>(copy.kind === 'adjustment' ? [[id, copy.check]] : []);
  const read = copy.kind === 'fulfillment' ? FULFILLMENT_BOOKS : copy.kind === 'receipt' ? RECEIPT_BOOKS : ADJUSTMENT_BOOKS;
  const [chart, documents, held, accounts] = await Promise.all([
    readChart(service),
    service.rpc('gl_stock_documents', { p_company: company, p_ids: [id] }),
    readOwnBooks(service, read, [{ company, netsuiteId: id }]),
    readOwnStockAccounts(service, company, fulfillments, receipts),
  ]);
  if (documents.error) throw new Error(documents.error.message);
  const doc = (((documents.data ?? {}) as { documents?: StockDocument[] }).documents ?? []).find((d) => d.netsuite_id === id);
  const books = held.get(id) ?? null;
  if (!doc) return { books, month: null, ...NOTHING, learned: [] };

  const names = chartNames(chart);
  const [worked] = workOutStockMonth({ documents: [doc] }, { company, chart }).documents;
  const pick = ownStockPick(worked, { fulfillments, receipts, adjustments, accounts }, { company, names });
  return {
    books,
    month: doc.posting_month,
    posts: !!pick?.entry,
    why: pick?.why ?? null,
    entry: pick?.own ? entryRows(pick.own.lines, worked.checked.lines, names.account) : null,
    differs: pick?.differs ?? null,
    learned: pick?.learned ?? [],
    costs: pick?.costs ?? null,
  };
}

/**
 * How Books' own copy of a bill posts, for its page: what the books hold for NetSuite's bill, and the copy's entry
 * next to NetSuite's when it's worked out, from the month NetSuite booked the bill into as the posting run reads it.
 */
export async function readOwnBillView(service: SupabaseClient, copy: OwnBillCopy): Promise<OwnPostingView> {
  const { own } = copy;
  const id = own.netsuite_id;
  const company = own.company;
  const [chart, booked, held] = await Promise.all([
    readChart(service),
    service.from('gl_netsuite_transactions').select('posting_month').eq('netsuite_id', id).maybeSingle(),
    readOwnBooks(service, BILL_BOOKS, [{ company, netsuiteId: id }]),
  ]);
  if (booked.error) throw new Error(booked.error.message);
  const books = held.get(id) ?? null;
  const postingMonth = ((booked.data as { posting_month?: string } | null)?.posting_month ?? null);
  // One the copy of NetSuite's GL hasn't got yet is in the month it's dated in, as gl_bill_month has it.
  const data = await readBillMonth(service, company, postingMonth ?? `${own.date.slice(0, 7)}-01`);
  const worked = workOutBillMonth(data, { company, chart }).bills.find((w) => w.bill.netsuite_id === id);
  if (!worked) return { books, month: postingMonth, ...NOTHING, learned: [] };

  const names = chartNames(chart);
  const pick = ownBillPick(worked, copy, { company, names });
  return {
    books,
    month: worked.bill.posting_month ?? postingMonth,
    posts: !!pick?.entry,
    why: pick?.why ?? null,
    entry: pick?.own ? entryRows(pick.own.lines, worked.checked.lines, names.account) : null,
    differs: pick?.differs ?? null,
    learned: [],
    costs: null,
  };
}
