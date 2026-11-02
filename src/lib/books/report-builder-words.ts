/**
 * How the report builder (src/lib/books/report-builder.ts) names what a
 * report has rows and columns for, the months it covers and what its
 * filters keep, apart from the server code so its page and its Excel file
 * read the same.
 */

/** What a report has a line for: each account, as on Reports, or each customer or vendor. */
export const BUILDER_ROWS = ['account', 'customer', 'vendor'] as const;
export type BuilderRows = (typeof BUILDER_ROWS)[number];

/** Each of them as the page's picker shows it. */
export const ROWS_LABELS: Record<BuilderRows, string> = {
  account: 'Each account',
  customer: 'Each customer',
  vendor: 'Each vendor',
};

/** A line with no customer or vendor. */
export const NO_PARTY: Record<Exclude<BuilderRows, 'account'>, string> = { customer: 'No customer', vendor: 'No vendor' };

/** The months a report covers: those picked, or ones that move with the calendar, each ending last month at the latest. */
export const BUILDER_MONTHS = ['picked', 'year_to_date', 'last_month', 'last_quarter', 'last_year', 'last_12_months'] as const;
export type BuilderMonths = (typeof BUILDER_MONTHS)[number];

/** Each of them as the page's picker shows it. */
export const MONTHS_LABELS: Record<BuilderMonths, string> = {
  picked: 'The months picked',
  year_to_date: 'Year to date',
  last_month: 'Last month',
  last_quarter: 'Last quarter',
  last_year: 'Last year',
  last_12_months: 'Last 12 months',
};

/** What a report has a column for: each month, quarter, year, division or location, or the months altogether ('total'). */
export const BUILDER_BY = ['total', 'month', 'quarter', 'year', 'division', 'location'] as const;
export type BuilderBy = (typeof BUILDER_BY)[number];

/** A line's division or location key when it has none. */
export const NONE = 'none';

/** Each of them as the page's picker shows it. */
export const BY_LABELS: Record<BuilderBy, string> = {
  total: 'The months altogether',
  month: 'Each month',
  quarter: 'Each quarter',
  year: 'Each year',
  division: 'Each division',
  location: 'Each location',
};

/** A report's name, as a page heading reads it: "Profit and loss by division", "Profit and loss by customer and month". */
export function builderTitle(by: BuilderBy, rows: BuilderRows = 'account'): string {
  const what = [...(rows === 'account' ? [] : [rows]), ...(by === 'total' ? [] : [by])];
  return what.length ? `Profit and loss by ${what.join(' and ')}` : 'Profit and loss';
}

/** What the filters keep, as a sentence: "Only Graphics lines at Kansas City."; nothing when every line is kept. */
export function filterWords(division: { key: string; label: string } | null, location: { key: string; label: string } | null): string {
  if (!division && !location) return '';
  const what = !division ? 'lines' : division.key === NONE ? 'lines not split by division' : `${division.label} lines`;
  const where = !location ? '' : location.key === NONE ? ' with no location' : ` at ${location.label}`;
  return `Only ${what}${where}.`;
}
