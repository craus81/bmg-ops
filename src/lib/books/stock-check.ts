import type { ChartAccount, InvoiceBooks, InvoiceView, MonthCheck } from './invoice-check';
import type { StockType } from './stock-rule';
import { checkLedgerCopyMonth, firstMemo, workOutLedgerCopies, type LedgerCopyDocument, type WorkedLedgerCopy } from './journal-entry-check';

/**
 * Each NetSuite document of a month that moves stock or books its cost, as
 * FleetSuite posts it (docs/books.md "Stock and cost"): its lines for the
 * company from the copy of NetSuite's GL (migration 361), each next to the
 * line of the entry made of it line for line, as for a journal entry
 * (journal-entry-check.ts), for the invoices page's Stock and cost switch and
 * the posting job (src/lib/books/invoice-posting.ts). An invoice's or credit
 * memo's lines are only its cost lines. Pure; amounts are whole cents, debit
 * positive.
 */

/** One stock document, as gl_stock_month (migration 395) gives it. */
export interface StockDocument extends LedgerCopyDocument {
  type: StockType;
}

/** What gl_stock_month (migration 395) returns: one company's stock documents NetSuite booked into a month. */
export interface StockMonthData {
  documents: StockDocument[];
}

/** One stock document of the month, worked out line for line. */
export type WorkedStockDocument = WorkedLedgerCopy<StockDocument>;

/** One stock document in the list, with which kind it is. */
export interface StockView extends InvoiceView {
  type: StockType;
}

/** A month's stock documents, checked. */
export interface StockMonthCheck extends MonthCheck {
  invoices: StockView[];
}

/** Every stock document of the month worked out: what checkStockMonth shows and the posting job posts. */
export function workOutStockMonth(
  data: StockMonthData,
  opts: { company: string; chart: ChartAccount[] },
): { documents: WorkedStockDocument[]; account: (id: string) => string } {
  const { worked, account } = workOutLedgerCopies(data.documents ?? [], opts.chart);
  return { documents: worked, account };
}

/**
 * One company's stock documents for one month, each with its lines next to
 * FleetSuite's. `books`, when the company's documents post, says what
 * FleetSuite's books hold for each.
 */
export function checkStockMonth(
  data: StockMonthData,
  opts: { company: string; chart: ChartAccount[] },
  books?: (worked: WorkedStockDocument) => InvoiceBooks,
): StockMonthCheck {
  const { documents, account } = workOutStockMonth(data, opts);
  // As for a journal entry, the list shows its first memo, or its first name, and which kind it is goes beside its number.
  const words = { one: 'stock document', many: 'stock documents' };
  const check = checkLedgerCopyMonth(documents, account, { company: opts.company, words, describe: firstMemo }, books);
  const types = new Map(documents.map((w) => [w.entry.netsuite_id, w.entry.type]));
  return { ...check, invoices: check.invoices.map((v) => ({ ...v, type: types.get(v.netsuiteId)! })) };
}
