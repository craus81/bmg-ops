import { describe, it, expect } from 'vitest';
import { pickReviewer, reviewStateOf, canDecideReview, type StaffOption } from './estimate-review';

const STAFF: StaffOption[] = [
  { id: 'u-craig', name: 'Craig George', email: 'cgeorge@bmgfleet.com' },
  { id: 'u-dana', name: 'Dana Reyes', email: 'dana@bmgfleet.com' },
];

describe('pickReviewer', () => {
  it('takes the first To address that belongs to a BMG login', () => {
    // The customer's address sits first here; the reviewer is still the
    // first STAFF address, not simply emails[0].
    expect(pickReviewer(STAFF, ['buyer@acme.com', 'dana@bmgfleet.com', 'cgeorge@bmgfleet.com'])?.id)
      .toBe('u-dana');
  });

  it('honours To order between two teammates', () => {
    expect(pickReviewer(STAFF, ['cgeorge@bmgfleet.com', 'dana@bmgfleet.com'])?.id).toBe('u-craig');
    expect(pickReviewer(STAFF, ['dana@bmgfleet.com', 'cgeorge@bmgfleet.com'])?.id).toBe('u-dana');
  });

  it('matches regardless of case or stray whitespace', () => {
    expect(pickReviewer(STAFF, ['  CGeorge@BMGFleet.com '])?.id).toBe('u-craig');
  });

  it('returns null when nobody in To can open FleetView', () => {
    // An estimate cannot be "in review with" an address that has no login —
    // the route turns this into an error instead of a decorative send.
    expect(pickReviewer(STAFF, ['buyer@acme.com'])).toBeNull();
    expect(pickReviewer(STAFF, [])).toBeNull();
    expect(pickReviewer([], ['cgeorge@bmgfleet.com'])).toBeNull();
  });

  it('ignores empty and malformed entries rather than throwing', () => {
    expect(pickReviewer(STAFF, ['', '   ', null as any, 'dana@bmgfleet.com'])?.id).toBe('u-dana');
  });
});

describe('reviewStateOf', () => {
  it('reads the review columns off an estimate row', () => {
    const state = reviewStateOf({
      internal_review_status: 'changes_requested',
      internal_reviewer_id: 'u-craig',
      internal_review_requested_by: 'u-dana',
      internal_review_note: 'Drop the labor to 6 hours.',
    });
    expect(state.status).toBe('changes_requested');
    expect(state.reviewerId).toBe('u-craig');
    expect(state.requestedBy).toBe('u-dana');
    expect(state.note).toBe('Drop the labor to 6 hours.');
  });

  it('treats a missing or unknown status as no review', () => {
    expect(reviewStateOf({}).status).toBeNull();
    expect(reviewStateOf({ internal_review_status: 'nonsense' }).status).toBeNull();
    expect(reviewStateOf(null).status).toBeNull();
  });
});

describe('canDecideReview', () => {
  const pending = reviewStateOf({
    internal_review_status: 'pending',
    internal_reviewer_id: 'u-craig',
    internal_review_requested_by: 'u-dana',
  });

  it('lets the assigned reviewer decide', () => {
    expect(canDecideReview(pending, 'u-craig', false)).toBe(true);
  });

  it('lets an admin step in for a reviewer who is out', () => {
    expect(canDecideReview(pending, 'u-someone', true)).toBe(true);
  });

  it('does not let the requester approve their own estimate', () => {
    expect(canDecideReview(pending, 'u-dana', false)).toBe(false);
  });

  it('has nothing to decide once the review is settled', () => {
    const approved = reviewStateOf({ internal_review_status: 'approved', internal_reviewer_id: 'u-craig' });
    expect(canDecideReview(approved, 'u-craig', true)).toBe(false);
    expect(canDecideReview(reviewStateOf({}), 'u-craig', true)).toBe(false);
  });

  it('is false for a signed-out user', () => {
    expect(canDecideReview(pending, null, true)).toBe(false);
  });
});
