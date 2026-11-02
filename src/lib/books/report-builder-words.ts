/**
 * How the report builder (src/lib/books/report-builder.ts) names what a
 * report has columns for and what its filters keep, apart from the server
 * code so its page and its Excel file read the same.
 */

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

/** A report's name, as a page heading reads it: "Profit and loss by division". */
export const builderTitle = (by: BuilderBy) => (by === 'total' ? 'Profit and loss' : `Profit and loss by ${by}`);

/** What the filters keep, as a sentence: "Only Graphics lines at Kansas City."; nothing when every line is kept. */
export function filterWords(division: { key: string; label: string } | null, location: { key: string; label: string } | null): string {
  if (!division && !location) return '';
  const what = !division ? 'lines' : division.key === NONE ? 'lines not split by division' : `${division.label} lines`;
  const where = !location ? '' : location.key === NONE ? ' with no location' : ` at ${location.label}`;
  return `Only ${what}${where}.`;
}
