/**
 * Open Estimates report (owner ask 2026-10-14): one page that lists every
 * estimate still waiting on someone, so nothing gets dropped because nobody
 * remembered it. Each open estimate lands in exactly one bucket — the place
 * it is stuck — and is "stale" once it has waited longer than that bucket's
 * limit.
 *
 * Pure helpers only; /api/reports/open-estimates reads the rows and the
 * page renders what this returns.
 */

import { REVIEW_REMINDER_SHOP_HOURS } from './estimate-review';

export type OpenBucket = 'in_review' | 'changes_requested' | 'not_sent' | 'waiting' | 'needs_so';

/** Buckets in pipeline order, with how each reads and when it goes stale. */
export const OPEN_BUCKETS: { key: OpenBucket; label: string; help: string; staleLabel: string }[] = [
  {
    key: 'in_review',
    label: 'In review',
    help: 'Sent to a teammate for review. The customer has not seen it yet.',
    staleLabel: `${REVIEW_REMINDER_SHOP_HOURS}+ shop hours`,
  },
  {
    key: 'changes_requested',
    label: 'Changes requested',
    help: 'The reviewer handed it back with notes. The rep needs to fix it and send it again.',
    staleLabel: '2+ days',
  },
  {
    key: 'not_sent',
    label: 'Not sent yet',
    help: 'Drafts and estimates pushed to NetSuite that have not gone to the customer.',
    staleLabel: '3+ days untouched',
  },
  {
    key: 'waiting',
    label: 'Waiting on customer',
    help: 'Sent for approval with no answer yet. Log a follow-up to reset the clock.',
    staleLabel: '5+ quiet days',
  },
  {
    key: 'needs_so',
    label: 'Approved, no sales order',
    help: 'The customer said yes but nobody has converted it to a sales order.',
    staleLabel: '2+ days',
  },
];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Days a bucket may wait before it counts as stale (in_review uses shop hours). */
const STALE_DAYS: Record<Exclude<OpenBucket, 'in_review'>, number> = {
  changes_requested: 2,
  not_sent: 3,
  waiting: 5,
  needs_so: 2,
};

/** Drafts nobody has touched in this many days are folded away by default:
 *  most are abandoned, and they would bury the ones that matter. */
export const OLD_DRAFT_DAYS = 90;

export interface OpenEstimateSource {
  id: string;
  estimate_number: string | null;
  netsuite_estimate_number?: string | null;
  title: string | null;
  customer_name: string | null;
  grand_total: number | string | null;
  status: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  sent_for_approval_at: string | null;
  last_followup_at: string | null;
  customer_approved: boolean | null;
  customer_approved_at: string | null;
  netsuite_so_id: string | null;
  internal_review_status: string | null;
  internal_reviewer_id: string | null;
  internal_review_requested_by: string | null;
  internal_review_requested_at: string | null;
  internal_review_decided_at: string | null;
  internal_review_note: string | null;
}

export interface OpenEstimateRow {
  id: string;
  number: string;
  title: string;
  customer: string;
  total: number;
  bucket: OpenBucket;
  /** The person the estimate is waiting on: the reviewer while in review,
   *  otherwise the rep who built it. */
  ownerId: string | null;
  repId: string | null;
  reviewerId: string | null;
  /** When the current wait started. */
  since: string | null;
  /** Age of the wait: shop hours for in_review, whole days otherwise. */
  age: number;
  ageUnit: 'shop_hours' | 'days';
  stale: boolean;
  /** A not-sent draft untouched for OLD_DRAFT_DAYS — hidden by default. */
  old: boolean;
  note: string | null;
}

/** Where an open estimate is stuck, or null when it is finished (sales
 *  order, lost) and has no place on the report. */
export function bucketOf(e: OpenEstimateSource): OpenBucket | null {
  if (e.netsuite_so_id) return null;
  if (e.customer_approved || e.status === 'accepted') return 'needs_so';
  if (e.status === 'rejected') return null;
  // Review first: an estimate mid-review that also went out is still waiting
  // on the teammate who owns the review.
  if (e.internal_review_status === 'pending') return 'in_review';
  if (e.status === 'sent') return 'waiting';
  if (e.internal_review_status === 'changes_requested') return 'changes_requested';
  return 'not_sent';
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** The moment the current wait began, per bucket. */
function waitStart(e: OpenEstimateSource, bucket: OpenBucket): string | null {
  switch (bucket) {
    case 'in_review':
      return e.internal_review_requested_at || e.updated_at;
    case 'changes_requested':
      return e.internal_review_decided_at || e.updated_at;
    case 'waiting': {
      // Quiet time: since the send or the last logged follow-up, whichever
      // is later — the same clock the Quotes page sorts by.
      const sent = e.sent_for_approval_at || e.updated_at;
      return ms(e.last_followup_at) > ms(sent) ? e.last_followup_at : sent;
    }
    case 'needs_so':
      return e.customer_approved_at || e.updated_at;
    case 'not_sent':
      return e.updated_at || e.created_at;
  }
}

export function toOpenRow(
  e: OpenEstimateSource,
  nowMs: number,
  shopMsBetween: (fromMs: number, toMs: number) => number,
): OpenEstimateRow | null {
  const bucket = bucketOf(e);
  if (!bucket) return null;
  const since = waitStart(e, bucket);
  const startMs = ms(since);
  let age = 0;
  let stale = false;
  if (Number.isFinite(startMs)) {
    if (bucket === 'in_review') {
      age = Math.floor(shopMsBetween(startMs, nowMs) / HOUR_MS);
      stale = age >= REVIEW_REMINDER_SHOP_HOURS;
    } else {
      age = Math.max(0, Math.floor((nowMs - startMs) / DAY_MS));
      stale = age >= STALE_DAYS[bucket];
    }
  }
  return {
    id: e.id,
    number: e.estimate_number || e.netsuite_estimate_number || '—',
    title: e.title || '',
    customer: e.customer_name || '',
    total: Number(e.grand_total) || 0,
    bucket,
    ownerId: bucket === 'in_review' ? e.internal_reviewer_id : e.created_by,
    repId: e.created_by,
    reviewerId: e.internal_reviewer_id,
    since,
    age,
    ageUnit: bucket === 'in_review' ? 'shop_hours' : 'days',
    stale,
    old: bucket === 'not_sent' && age >= OLD_DRAFT_DAYS,
    note: bucket === 'changes_requested' ? e.internal_review_note : null,
  };
}

export interface OpenEstimatesReport {
  rows: OpenEstimateRow[];
  counts: Record<OpenBucket, { count: number; stale: number; total: number }>;
}

/** Every open estimate, oldest wait first within each bucket. Old drafts are
 *  returned (flagged) but left out of the counts so the headline numbers
 *  match what the page shows by default. */
export function summarizeOpenEstimates(
  estimates: OpenEstimateSource[],
  nowMs: number,
  shopMsBetween: (fromMs: number, toMs: number) => number,
): OpenEstimatesReport {
  const order = new Map(OPEN_BUCKETS.map((b, i) => [b.key, i]));
  const rows = estimates
    .map(e => toOpenRow(e, nowMs, shopMsBetween))
    .filter((r): r is OpenEstimateRow => r !== null)
    .sort((a, b) =>
      (order.get(a.bucket)! - order.get(b.bucket)!)
      || (ms(a.since) || 0) - (ms(b.since) || 0));
  const counts = Object.fromEntries(
    OPEN_BUCKETS.map(b => [b.key, { count: 0, stale: 0, total: 0 }]),
  ) as OpenEstimatesReport['counts'];
  for (const r of rows) {
    if (r.old) continue;
    const c = counts[r.bucket];
    c.count += 1;
    c.total += r.total;
    if (r.stale) c.stale += 1;
  }
  return { rows, counts };
}
