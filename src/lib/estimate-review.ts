/**
 * Internal review of an estimate (migration 316) — the step between "the rep
 * finished building it" and "the customer sees it".
 *
 * The rep sends the estimate to a BMG teammate through the same compose
 * screen the customer send uses; the reviewer reads it in their inbox, opens
 * it in FleetView, edits what they want, and then approves it, hands it back
 * with notes, or sends it to the customer themselves.
 *
 * Pure helpers only — shared by the send/decision routes and the estimates
 * page so the two can't describe the same state differently.
 */

export type InternalReviewStatus = 'pending' | 'approved' | 'changes_requested';

export const REVIEW_DECISIONS = ['approved', 'changes_requested'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** How each state reads on a badge or banner, and the color it wears. */
export const REVIEW_STATUS_DISPLAY: Record<InternalReviewStatus, { label: string; color: string }> = {
  pending: { label: 'In review', color: '#f59e0b' },
  approved: { label: 'Review approved', color: '#22c55e' },
  changes_requested: { label: 'Changes requested', color: '#ef4444' },
};

export interface StaffOption {
  id: string;
  name: string;
  email: string;
}

/**
 * The reviewer of record for a send: the first To address that belongs to a
 * BMG login. The compose screen's To line is free text (and may carry several
 * people), but exactly one of them owns the review — they get the task, the
 * in-app ping, and the buttons. Order matters, so "reviewer first" is a rule
 * the sender can see rather than a hidden ranking.
 *
 * Returns null when nobody in To has a FleetView account: an estimate can't
 * be "in review with" an address that can't open it, and the caller should
 * say so rather than silently sending a decorative email.
 */
export function pickReviewer(staff: StaffOption[], emails: string[]): StaffOption | null {
  const byEmail = new Map(staff.map(s => [s.email.trim().toLowerCase(), s]));
  for (const raw of emails) {
    const match = byEmail.get(String(raw || '').trim().toLowerCase());
    if (match) return match;
  }
  return null;
}

/** The review state as the UI reads it, from an estimate row. */
export interface EstimateReviewState {
  status: InternalReviewStatus | null;
  reviewerId: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

export function reviewStateOf(estimate: any): EstimateReviewState {
  const status = estimate?.internal_review_status;
  return {
    status: status === 'pending' || status === 'approved' || status === 'changes_requested' ? status : null,
    reviewerId: estimate?.internal_reviewer_id || null,
    requestedBy: estimate?.internal_review_requested_by || null,
    requestedAt: estimate?.internal_review_requested_at || null,
    decidedBy: estimate?.internal_review_decided_by || null,
    decidedAt: estimate?.internal_review_decided_at || null,
    note: estimate?.internal_review_note || null,
  };
}

/**
 * Who may decide a pending review: the assigned reviewer, or an admin (an
 * owner stepping in for someone who's out). The requester is deliberately
 * NOT on this list — approving your own estimate is the thing the step
 * exists to prevent — unless they were also picked as the reviewer.
 */
export function canDecideReview(
  state: EstimateReviewState,
  userId: string | null | undefined,
  isAdmin: boolean,
): boolean {
  if (state.status !== 'pending' || !userId) return false;
  return state.reviewerId === userId || isAdmin;
}
