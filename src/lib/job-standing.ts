/**
 * Where a sold job stands, in one word, worked out from facts rather than
 * the hand-moved status bar (Craig, 2026-10-20, retiring the Upfit tab:
 * "Option C"). A job is an upfit project — one per sales order.
 *
 * Order of precedence:
 *  - Cancelled / Completed are the only hand-set states still honored.
 *  - A vehicle in the bay (In Progress / Scheduled Pickup) reads In shop.
 *  - Otherwise the parts verdict from the readiness board: Short, On order,
 *    or Parts in (ready or reserved).
 *  - No verdict (no SO yet, or nothing stocked on it) reads Sold.
 */
import type { BoardReadiness } from '@/lib/parts-readiness';

export type JobStandingKey = 'short' | 'on_order' | 'parts_in' | 'in_shop' | 'sold' | 'done' | 'cancelled';

export interface JobStanding {
  key: JobStandingKey;
  label: string;
  /** Plain detail for the line under the job, e.g. "2 parts short". */
  detail: string | null;
  tone: 'bad' | 'warn' | 'good' | 'info' | 'muted';
}

const IN_SHOP_STATUSES = new Set(['in_progress', 'scheduled_pickup']);

/** "Oct 24" from a YYYY-MM-DD (or ISO) date, read as a calendar day. */
function shortDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function jobStanding(
  project: { status: string | null },
  readiness?: BoardReadiness | null,
): JobStanding {
  const status = project.status || '';
  if (status === 'cancelled') return { key: 'cancelled', label: 'Cancelled', detail: null, tone: 'muted' };
  if (status === 'completed') return { key: 'done', label: 'Done', detail: null, tone: 'good' };
  if (IN_SHOP_STATUSES.has(status)) return { key: 'in_shop', label: 'In shop', detail: null, tone: 'info' };
  if (readiness) {
    if (readiness.verdict === 'short') {
      return {
        key: 'short', label: 'Short', tone: 'bad',
        detail: `${readiness.short} part${readiness.short === 1 ? '' : 's'} short`,
      };
    }
    if (readiness.verdict === 'waiting') {
      return {
        key: 'on_order', label: 'On order', tone: 'warn',
        detail: readiness.lastEta ? `ETA ${shortDate(readiness.lastEta)}` : 'No ETA yet',
      };
    }
    return {
      key: 'parts_in', label: 'Parts in', tone: 'good',
      detail: readiness.verdict === 'reserved' ? 'All parts reserved' : 'All parts in stock',
    };
  }
  return { key: 'sold', label: 'Sold', detail: null, tone: 'muted' };
}

/** Open jobs first (most urgent standing first), then finished ones. */
const RANK: Record<JobStandingKey, number> = {
  short: 0, on_order: 1, parts_in: 2, in_shop: 3, sold: 4, done: 5, cancelled: 6,
};

export function compareJobStanding(a: JobStanding, b: JobStanding): number {
  return RANK[a.key] - RANK[b.key];
}
