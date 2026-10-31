import type { AgingBucketKey } from '@/lib/financials-data';

/**
 * How AR and AP agings age a document (src/lib/books/agings.ts), kept apart
 * so the pages can use it without the books' server code: Financials'
 * buckets (src/lib/financials-data.ts bucketFor, which this must agree
 * with), counted in whole days past due.
 */

export type { AgingBucketKey };

export const BUCKETS: readonly AgingBucketKey[] = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'];

export const BUCKET_NAMES: Readonly<Record<AgingBucketKey, string>> = {
  current: 'Current',
  d1_30: '1–30 days',
  d31_60: '31–60 days',
  d61_90: '61–90 days',
  d90plus: 'Over 90 days',
};

/** NetSuite's types for the documents that age, by what the pages call them. */
export const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  CustInvc: 'Invoice',
  CustCred: 'Credit memo',
  VendBill: 'Bill',
  VendCred: 'Bill credit',
};

/** The bucket of a document this many days past due: not yet due (0 or less) is current. */
export function bucketOf(days: number): AgingBucketKey {
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90plus';
}

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** Whole days from `from` to `today` (both 'YYYY-MM-DD'): positive once it's past; null without a date. */
export function daysLate(from: string | null, today: string): number | null {
  if (!from || !DATE_RE.test(from) || !DATE_RE.test(today)) return null;
  return Math.round((dayOf(today) - dayOf(from)) / DAY_MS);
}
