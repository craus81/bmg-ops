/**
 * Which months an account line on Reports opens its detail on
 * (docs/books.md "Report detail"), apart from the server code so the Reports
 * page can use it.
 */

export type DetailReport = 'profit_and_loss' | 'balance_sheet' | 'trial_balance' | 'cash_flow';

/** The reports that cover the months from From through To; the balance sheet and trial balance are at To's end. */
export const coversMonths = (report: DetailReport) => report === 'profit_and_loss' || report === 'cash_flow';

/**
 * The months a line's detail covers: the profit and loss's or cash flow
 * statement's own months; the year to date for an income or expense line on
 * the trial balance; else the report's month. A line that differs from
 * NetSuite starts at the first month it differs in when that's earlier
 * (owner decision 2026-10-18), as a balance carries a difference forward
 * from the month it started in, so the documents behind it show; never
 * before `first`, the reports' first month.
 */
export function detailMonths(
  report: DetailReport,
  line: { yearToDate?: true; months?: ReadonlyArray<{ month: string }> },
  range: { from: string; to: string; first: string },
): { from: string; to: string } {
  const own = coversMonths(report) ? range.from : line.yearToDate ? `${range.to.slice(0, 4)}-01-01` : range.to;
  // A line's months are oldest first.
  const started = line.months?.[0]?.month;
  if (!started || started >= own) return { from: own, to: range.to };
  return { from: started < range.first ? range.first : started, to: range.to };
}
