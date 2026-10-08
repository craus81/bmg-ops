import { describe, it, expect } from 'vitest';
import { pickReviewer, reviewStateOf, canDecideReview, reviewReminderDue, reviewSnoozedUntil, type StaffOption } from './estimate-review';
import { shopWorkMs } from './shop-hours';

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

describe('reviewReminderDue', () => {
  // Mon 2026-10-05 is a weekday; Central is UTC-5 (CDT).
  const at = (iso: string) => new Date(iso).getTime();
  const pendingSince = (requested: string, reminded: string | null = null) => ({
    internal_review_status: 'pending',
    internal_review_requested_at: requested,
    internal_review_reminded_at: reminded,
  });

  it('fires once 6 shop hours have passed', () => {
    // 8:00 AM Central request; lunch (11:30–12:00) doesn't count.
    const est = pendingSince('2026-10-05T13:00:00Z');
    expect(reviewReminderDue(est, at('2026-10-05T18:00:00Z'), shopWorkMs)).toBe(false); // 1:00 PM = 4.5h
    expect(reviewReminderDue(est, at('2026-10-05T19:30:00Z'), shopWorkMs)).toBe(true); // 2:30 PM = 6h
  });

  it('carries a late Friday send over the weekend instead of firing at night', () => {
    // Fri 2:00 PM Central → 1.5 shop hours Friday, so due Monday ~11:30.
    const est = pendingSince('2026-10-09T19:00:00Z');
    expect(reviewReminderDue(est, at('2026-10-10T19:00:00Z'), shopWorkMs)).toBe(false); // Saturday
    expect(reviewReminderDue(est, at('2026-10-12T15:00:00Z'), shopWorkMs)).toBe(false); // Mon 10:00 AM
    expect(reviewReminderDue(est, at('2026-10-12T17:00:00Z'), shopWorkMs)).toBe(true); // Mon 12:00 PM
  });

  it('reminds once per review round, and again after a re-send', () => {
    const now = at('2026-10-06T21:00:00Z');
    expect(reviewReminderDue(pendingSince('2026-10-05T13:00:00Z', '2026-10-05T19:30:00Z'), now, shopWorkMs)).toBe(false);
    // Re-sent after the reminder: new round, new reminder once it ages.
    expect(reviewReminderDue(pendingSince('2026-10-06T12:00:00Z', '2026-10-05T19:30:00Z'), now, shopWorkMs)).toBe(true);
  });

  it('ignores reviews that are answered or never requested', () => {
    const now = at('2026-10-09T21:00:00Z');
    expect(reviewReminderDue({ internal_review_status: 'approved', internal_review_requested_at: '2026-10-05T13:00:00Z' }, now, shopWorkMs)).toBe(false);
    expect(reviewReminderDue({ internal_review_status: 'pending', internal_review_requested_at: null }, now, shopWorkMs)).toBe(false);
  });
});

describe('review snooze', () => {
  const at = (iso: string) => new Date(iso).getTime();
  // Requested Mon 8:00 AM Central; 6 shop hours lands Mon 2:30 PM.
  const base = {
    internal_review_status: 'pending',
    internal_review_requested_at: '2026-10-05T13:00:00Z',
  };

  it('stays quiet while snoozed, then reminds once more when it runs out', () => {
    const est = { ...base, internal_review_reminded_at: '2026-10-05T19:30:00Z', internal_review_snoozed_until: '2026-10-08T15:00:00Z' };
    expect(reviewReminderDue(est, at('2026-10-07T16:00:00Z'), shopWorkMs)).toBe(false); // snoozed
    expect(reviewReminderDue(est, at('2026-10-08T15:30:00Z'), shopWorkMs)).toBe(true); // snooze ended
    // Once reminded after the snooze, that round is done.
    expect(reviewReminderDue({ ...est, internal_review_reminded_at: '2026-10-08T15:30:00Z' }, at('2026-10-08T17:00:00Z'), shopWorkMs)).toBe(false);
  });

  it('a snooze set before the 6 hours were up still holds the first reminder', () => {
    const est = { ...base, internal_review_snoozed_until: '2026-10-06T14:00:00Z' };
    expect(reviewReminderDue(est, at('2026-10-05T20:00:00Z'), shopWorkMs)).toBe(false);
    expect(reviewReminderDue(est, at('2026-10-06T14:30:00Z'), shopWorkMs)).toBe(true);
  });

  it('ignores a snooze left over from before the latest Send for Review', () => {
    const est = { ...base, internal_review_snoozed_until: '2026-10-04T13:00:00Z' };
    expect(reviewSnoozedUntil(est)).toBeNull();
    expect(reviewReminderDue(est, at('2026-10-05T19:30:00Z'), shopWorkMs)).toBe(true);
  });
});
