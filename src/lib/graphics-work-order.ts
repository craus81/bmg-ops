/**
 * The graphics work order — the admin-ranked "what do I do first" queue.
 *
 * Due dates and the priority bucket both tie constantly (a dozen "high" jobs
 * due the same week say nothing about what to start), so admins hand-rank the
 * board and everyone else reads that order. Ranks live in
 * graphics_jobs.work_rank (migration 318) as a contiguous 1..N block, written
 * only by /api/graphics-jobs/rank.
 *
 * Pure and client-safe — no DB, no fetch — so the board, the work-order modal
 * and the job record all number the queue the same way, and the rules can be
 * asserted in a unit test.
 */

import { isFinishedStatus } from './graphics-status';
import type { GraphicsJobStatus } from './types';

/** The only fields the queue rules care about. */
export interface RankableJob {
  id: string;
  status: GraphicsJobStatus;
  work_rank: number | null;
}

/** Just enough of a job to order it the way the board does when unranked. */
export interface DatedJob {
  due_date?: string | null;
  created_at?: string | null;
}

/**
 * Ranked jobs someone can still work, in queue order.
 *
 * Finished jobs are dropped rather than trusted: a job that shipped between
 * reorders keeps whatever rank it had, and it should not hold a slot on the
 * designer's list until an admin next opens the board.
 */
export function rankedQueue<T extends RankableJob>(jobs: T[]): T[] {
  return jobs
    .filter(j => j.work_rank != null && !isFinishedStatus(j.status))
    .sort((a, b) => (a.work_rank as number) - (b.work_rank as number));
}

/**
 * id → 1-based POSITION in the queue (not the stored rank).
 *
 * The stored block goes gappy the moment a ranked job finishes, and a board
 * whose top row reads "#4" is a board nobody trusts. Position is what every
 * surface displays; the stored number only decides the order.
 */
export function workOrderPositions(jobs: RankableJob[]): Map<string, number> {
  return new Map(rankedQueue(jobs).map((j, i) => [j.id, i + 1] as const));
}

/**
 * Soonest due first, undated last, created order as the tiebreak — how the
 * graphics board sorted before the work order existed, and still how it
 * orders everything below the ranked jobs.
 */
export function compareByDueDate(a: DatedJob, b: DatedJob): number {
  if (!!a.due_date !== !!b.due_date) return a.due_date ? -1 : 1;
  if (a.due_date && b.due_date) {
    const cmp = a.due_date.slice(0, 10).localeCompare(b.due_date.slice(0, 10));
    if (cmp !== 0) return cmp;
  }
  return (a.created_at || '').localeCompare(b.created_at || '');
}

/** Active jobs that aren't on the list yet, offered soonest-due first. */
export function unrankedPool<T extends RankableJob & DatedJob>(jobs: T[], rankedIds: Set<string>): T[] {
  return jobs
    .filter(j => !isFinishedStatus(j.status) && !rankedIds.has(j.id))
    .sort(compareByDueDate);
}
