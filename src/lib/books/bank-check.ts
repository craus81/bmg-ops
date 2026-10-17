import type { ChartAccount, InvoiceBooks, InvoiceView, MonthCheck } from './invoice-check';
import type { BankType } from './bank-rule';
import { checkLedgerCopyMonth, firstMemo, workOutLedgerCopies, type LedgerCopyDocument, type WorkedLedgerCopy } from './journal-entry-check';

/**
 * Each NetSuite bank deposit and transfer of a month as FleetSuite posts it
 * (docs/books.md "Bank deposits and transfers"): its lines for the company
 * from the copy of NetSuite's GL (migration 361), each next to the line of
 * the entry made of it line for line, as for a journal entry
 * (journal-entry-check.ts), for the invoices page's Bank deposits and
 * transfers switch and the posting job (src/lib/books/invoice-posting.ts).
 * Pure; amounts are whole cents, debit positive.
 */

/** One bank deposit or transfer, as gl_bank_month (migration 394) gives it. */
export interface BankDocument extends LedgerCopyDocument {
  type: BankType;
}

/** What gl_bank_month (migration 394) returns: one company's bank deposits and transfers NetSuite booked into a month. */
export interface BankMonthData {
  documents: BankDocument[];
}

/** One bank deposit or transfer of the month, worked out line for line. */
export type WorkedBankDocument = WorkedLedgerCopy<BankDocument>;

/** One bank deposit or transfer in the list, with which it is. */
export interface BankView extends InvoiceView {
  type: BankType;
}

/** A month's bank deposits and transfers, checked. */
export interface BankMonthCheck extends MonthCheck {
  invoices: BankView[];
}

/** Every bank deposit and transfer of the month worked out: what checkBankMonth shows and the posting job posts. */
export function workOutBankMonth(
  data: BankMonthData,
  opts: { company: string; chart: ChartAccount[] },
): { documents: WorkedBankDocument[]; account: (id: string) => string } {
  const { worked, account } = workOutLedgerCopies(data.documents ?? [], opts.chart);
  return { documents: worked, account };
}

/**
 * One company's bank deposits and transfers for one month, each with its
 * lines next to FleetSuite's. `books`, when the company's documents post,
 * says what FleetSuite's books hold for each.
 */
export function checkBankMonth(
  data: BankMonthData,
  opts: { company: string; chart: ChartAccount[] },
  books?: (worked: WorkedBankDocument) => InvoiceBooks,
): BankMonthCheck {
  const { documents, account } = workOutBankMonth(data, opts);
  // As for a journal entry, the list shows its first memo, or its first name, and which it is goes beside its number.
  const words = { one: 'bank deposit or transfer', many: 'bank deposits and transfers' };
  const check = checkLedgerCopyMonth(documents, account, { company: opts.company, words, describe: firstMemo }, books);
  const types = new Map(documents.map((w) => [w.entry.netsuite_id, w.entry.type]));
  return { ...check, invoices: check.invoices.map((v) => ({ ...v, type: types.get(v.netsuiteId)! })) };
}
