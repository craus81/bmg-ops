import { describe, it, expect } from 'vitest';
import { isRepRoute, reviewingRepId, canActAsRep, isWithRep } from './proof-rep-review-state';

describe('rep reviews first', () => {
  const job = { proof_route: 'rep', proof_rep_id: null, created_by: 'u-entered', rep_review_status: 'pending' };

  it('defaults the rep to whoever entered the job', () => {
    expect(reviewingRepId(job)).toBe('u-entered');
    expect(reviewingRepId({ ...job, proof_rep_id: 'u-zach' })).toBe('u-zach');
  });

  it('treats a job with no route as going to the customer', () => {
    expect(isRepRoute({})).toBe(false);
    expect(isRepRoute({ proof_route: 'customer' })).toBe(false);
    expect(isRepRoute(job)).toBe(true);
  });

  it('lets only the rep or an admin act as the rep', () => {
    expect(canActAsRep(job, 'u-entered', false)).toBe(true);
    expect(canActAsRep(job, 'u-artist', false)).toBe(false);
    expect(canActAsRep(job, 'u-artist', true)).toBe(true);
    expect(canActAsRep({ ...job, proof_rep_id: 'u-zach' }, 'u-entered', false)).toBe(false);
    expect(canActAsRep(job, null, false)).toBe(false);
  });

  it('is with the rep only while a review is pending on a rep-route job', () => {
    expect(isWithRep(job)).toBe(true);
    expect(isWithRep({ ...job, rep_review_status: 'sent_to_customer' })).toBe(false);
    expect(isWithRep({ ...job, proof_route: 'customer' })).toBe(false);
  });
});
