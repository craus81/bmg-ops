/**
 * Per-person priority lists ("My List") — migration 326.
 *
 * A person's list is every job assigned to them that can still be worked;
 * membership is computed, never stored. personal_work_ranks only holds the
 * order a manager dragged it into. Jobs the manager ordered come first, in
 * that order; anything assigned since then follows in the board's own
 * default order, so a list nobody has touched reads exactly like the board
 * filtered to that person (for graphics that means the shared work order,
 * then due date — owner decision 2026-09-25 to keep the shared order as the
 * starting point).
 *
 * Pure and client-safe — no DB, no fetch — so the route and the unit test
 * agree on the rules.
 */

import { compareByDueDate } from './graphics-work-order';

export type WorkListType = 'graphics' | 'vehicle';

export const WORK_LIST_TYPES: readonly WorkListType[] = ['graphics', 'vehicle'];

/** One row of a person's list, as /api/work-lists returns it. */
export interface WorkListItem {
  id: string;
  title: string;
  /** Customer, job number, VIN tail — whatever tells two rows apart. */
  subtitle: string;
  statusLabel: string;
  /** Due date (graphics) or promised-back date (vehicles), YYYY-MM-DD. */
  due: string | null;
  href: string;
  /** True when a manager placed it; false when it only follows the default order. */
  ranked: boolean;
}

/**
 * The saved order first (by stored rank), then everything else by `fallback`.
 * Stored ranks for jobs no longer on the list are ignored, which is why the
 * result is renumbered by position rather than by the stored number.
 */
export function orderPersonalList<T extends { id: string }>(
  items: T[],
  ranks: Map<string, number>,
  fallback: (a: T, b: T) => number,
): T[] {
  const ranked = items.filter(i => ranks.has(i.id))
    .sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
  const rest = items.filter(i => !ranks.has(i.id)).sort(fallback);
  return [...ranked, ...rest];
}

/** Graphics default: the shared work order (ranked first), then due date. */
export function compareGraphicsDefault(
  a: { work_rank: number | null; due_date?: string | null; created_at?: string | null },
  b: { work_rank: number | null; due_date?: string | null; created_at?: string | null },
): number {
  if ((a.work_rank == null) !== (b.work_rank == null)) return a.work_rank == null ? 1 : -1;
  if (a.work_rank != null && b.work_rank != null && a.work_rank !== b.work_rank) return a.work_rank - b.work_rank;
  return compareByDueDate(a, b);
}

/** Vehicle default: soonest promised-back date first, undated last, then oldest check-in. */
export function compareVehicleDefault(
  a: { promised_back_date?: string | null; created_at?: string | null },
  b: { promised_back_date?: string | null; created_at?: string | null },
): number {
  return compareByDueDate(
    { due_date: a.promised_back_date, created_at: a.created_at },
    { due_date: b.promised_back_date, created_at: b.created_at },
  );
}

/**
 * Only ids that are on the person's list right now, each once, in the order
 * given. The saved order can't smuggle in someone else's job or a finished one.
 */
export function sanitizeOrder(requested: string[], onList: Set<string>): string[] {
  return [...new Set(requested)].filter(id => onList.has(id));
}
