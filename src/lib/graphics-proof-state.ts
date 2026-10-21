import type { GraphicsJobStatus } from '@/lib/types';

/**
 * Where a graphics job's proof stands, for the board and Home screen.
 *
 * A customer approval (magic link, or the rep's verbal OK) only sets
 * customer_approved — it never moves the job's status, so an approved job
 * still reads "Designing" on the board. Owner decision 2026-10-21 (option A):
 * keep the status as it is and make approval visible instead, with an
 * "Approved, ready to produce" box, a green row and a ✓ Approved tab.
 *
 * Pure and client-safe so the board, Home and their tests agree.
 */

/** Statuses before production starts. An approved job in one of these is
 *  waiting for someone to print it. */
export const GRAPHICS_PRE_PRODUCTION_STATUSES: GraphicsJobStatus[] = ['received', 'designing'];

export interface ProofStateJob {
  status: GraphicsJobStatus;
  job_category?: string | null;
  customer_approved?: boolean | null;
  customer_approved_at?: string | null;
  customer_rejected_at?: string | null;
  sent_for_approval_at?: string | null;
}

/**
 * Approved and nobody has started printing: the job is ready to produce.
 * "Proofing" jobs are design-and-approval only with no production steps, so
 * an approval there finishes the job rather than starting production.
 */
export function isReadyToProduce(job: ProofStateJob | null | undefined): boolean {
  if (!job?.customer_approved) return false;
  if (job.job_category === 'proofing') return false;
  return GRAPHICS_PRE_PRODUCTION_STATUSES.includes(job.status);
}

export type ProofState =
  | { kind: 'ready'; approvedAt: string | null }
  | { kind: 'approved'; approvedAt: string | null }
  | { kind: 'changes'; at: string }
  | { kind: 'waiting'; sentAt: string; days: number }
  | { kind: 'none' };

export function proofState(job: ProofStateJob, now: number = Date.now()): ProofState {
  if (job.customer_approved) {
    const approvedAt = job.customer_approved_at || null;
    return isReadyToProduce(job) ? { kind: 'ready', approvedAt } : { kind: 'approved', approvedAt };
  }
  if (job.customer_rejected_at) return { kind: 'changes', at: job.customer_rejected_at };
  if (job.sent_for_approval_at) {
    const days = Math.max(0, Math.floor((now - new Date(job.sent_for_approval_at).getTime()) / 86_400_000));
    return { kind: 'waiting', sentAt: job.sent_for_approval_at, days };
  }
  return { kind: 'none' };
}

/**
 * Order for the ready box: overdue and soonest-due first, undated last, then
 * the longest-approved first so nothing sits forgotten.
 */
export function compareReadyJobs(
  a: { due_date?: string | null; customer_approved_at?: string | null },
  b: { due_date?: string | null; customer_approved_at?: string | null },
): number {
  const da = (a.due_date || '9999-12-31').slice(0, 10);
  const db = (b.due_date || '9999-12-31').slice(0, 10);
  if (da !== db) return da < db ? -1 : 1;
  return (a.customer_approved_at || '').localeCompare(b.customer_approved_at || '');
}
