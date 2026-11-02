import type { CheckKey, CheckState } from './year-end';

/**
 * What Books → Year end calls each check done before a year closes, and
 * each check's state, as the page and the year-end package's Excel file
 * both read them (src/lib/books/year-end.ts, docs/books.md "Year end").
 */

export const CHECK_LABELS: Record<CheckKey, string> = {
  months: 'Months closed',
  netsuite: 'Matches NetSuite',
  entries: 'Journal entries',
  yearly: "CPA's yearly entries",
  bank: 'Bank reconciliations',
  sales_tax: 'Sales tax returns',
};

export const STATE_WORDS: Record<CheckState, string> = {
  done: 'Done',
  todo: 'Not yet',
  none: 'Not here',
};
