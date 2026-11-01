import type { DocumentBasis } from './sales-tax-worksheet';

/**
 * Books → Sales tax's words (part 65, docs/books.md "Sales tax"): the
 * return's figures and how a document is taxed, as the page, the
 * worksheet's sentences (sales-tax-worksheet.ts) and the Excel download all
 * name them. Client-safe: the page imports it, and the worksheet's own
 * module reads NetSuite's copy on the server.
 */

/** A figure on the return as it was filed, Form 53-1's order. */
export type ReturnField = 'gross' | 'adjustments' | 'taxable' | 'tax' | 'allowance' | 'paid';
export const RETURN_FIELDS: readonly ReturnField[] = ['gross', 'adjustments', 'taxable', 'tax', 'allowance', 'paid'];
export const RETURN_FIELD_WORDS: Readonly<Record<ReturnField, string>> = {
  gross: 'Gross receipts',
  adjustments: 'Adjustments',
  taxable: 'Taxable sales',
  tax: 'Tax',
  allowance: 'Timely payment allowance',
  paid: 'Paid',
};

/** How a document is taxed, in a few words. */
export const BASIS_WORDS: Readonly<Record<DocumentBasis, string>> = {
  rate: "At its location's rate",
  exempt_customer: 'Exempt customer',
  georgia: 'Georgia, not taxed',
  no_rate: 'No rate for its day',
  no_location: 'No location',
  other_state: 'Not in Missouri or Georgia',
};
