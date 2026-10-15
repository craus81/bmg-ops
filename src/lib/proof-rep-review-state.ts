/**
 * "Rep reviews first" proofs (migration 378): the state helpers, client-safe
 * so the job page and the API describe the same state the same way. Server
 * actions live in src/lib/proof-rep-review.ts.
 */

export type ProofRoute = 'customer' | 'rep';
export type RepReviewStatus = 'pending' | 'sent_to_customer' | 'changes_requested' | 'approved_verbally';

export interface RepReviewJob {
  proof_route?: string | null;
  proof_rep_id?: string | null;
  created_by?: string | null;
  rep_review_status?: string | null;
}

/** Proofs on this job go to the rep before the customer. */
export function isRepRoute(job: RepReviewJob | null | undefined): boolean {
  return job?.proof_route === 'rep';
}

/** The rep who reviews: the one picked on the job, else whoever entered it. */
export function reviewingRepId(job: RepReviewJob | null | undefined): string | null {
  return job?.proof_rep_id || job?.created_by || null;
}

/** May this person act as the job's rep (send on, record a verbal OK, send
 *  back)? The rep themselves, or an admin standing in for them. */
export function canActAsRep(job: RepReviewJob | null | undefined, userId: string | null | undefined, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return !!userId && userId === reviewingRepId(job);
}

/** A proof is sitting with the rep, waiting for them. */
export function isWithRep(job: RepReviewJob | null | undefined): boolean {
  return isRepRoute(job) && job?.rep_review_status === 'pending';
}
