import { describe, it, expect } from 'vitest';
import { bucketOf, toOpenRow, summarizeOpenEstimates, type OpenEstimateSource } from './open-estimates';

const NOW = new Date('2026-10-14T20:00:00Z').getTime();
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
// Wall-clock hours stand in for shop hours in these tests.
const wall = (a: number, b: number) => b - a;

const est = (over: Partial<OpenEstimateSource> = {}): OpenEstimateSource => ({
  id: 'e1', estimate_number: 'EST-2610-001', netsuite_estimate_number: null, title: 'Van shelving',
  customer_name: 'Acme', grand_total: 1000, status: 'draft', created_by: 'rep', created_at: iso(10 * DAY),
  updated_at: iso(1 * DAY), sent_for_approval_at: null, last_followup_at: null, customer_approved: false,
  customer_approved_at: null, netsuite_so_id: null, internal_review_status: null, internal_reviewer_id: null,
  internal_review_requested_by: null, internal_review_requested_at: null, internal_review_decided_at: null,
  internal_review_note: null, ...over,
});

describe('bucketOf', () => {
  it('drops finished estimates', () => {
    expect(bucketOf(est({ netsuite_so_id: '55', customer_approved: true }))).toBeNull();
    expect(bucketOf(est({ status: 'rejected' }))).toBeNull();
  });
  it('puts approved estimates with no sales order in needs_so', () => {
    expect(bucketOf(est({ customer_approved: true, status: 'sent' }))).toBe('needs_so');
    expect(bucketOf(est({ status: 'accepted' }))).toBe('needs_so');
  });
  it('puts a pending review ahead of the customer send', () => {
    expect(bucketOf(est({ internal_review_status: 'pending', status: 'sent' }))).toBe('in_review');
  });
  it('sorts the rest by where they sit', () => {
    expect(bucketOf(est({ status: 'sent' }))).toBe('waiting');
    expect(bucketOf(est({ internal_review_status: 'changes_requested' }))).toBe('changes_requested');
    expect(bucketOf(est({ internal_review_status: 'approved', status: 'pushed' }))).toBe('not_sent');
    expect(bucketOf(est())).toBe('not_sent');
  });
});

describe('toOpenRow', () => {
  it('ages a review in shop hours and owns it by the reviewer', () => {
    const r = toOpenRow(est({ internal_review_status: 'pending', internal_reviewer_id: 'boss', internal_review_requested_at: iso(7 * 3_600_000) }), NOW, wall)!;
    expect(r.ageUnit).toBe('shop_hours');
    expect(r.age).toBe(7);
    expect(r.stale).toBe(true);
    expect(r.ownerId).toBe('boss');
  });
  it('restarts the waiting clock at the last follow-up', () => {
    const r = toOpenRow(est({ status: 'sent', sent_for_approval_at: iso(20 * DAY), last_followup_at: iso(2 * DAY) }), NOW, wall)!;
    expect(r.age).toBe(2);
    expect(r.stale).toBe(false);
  });
  it('flags long-untouched drafts as old', () => {
    expect(toOpenRow(est({ updated_at: iso(120 * DAY) }), NOW, wall)!.old).toBe(true);
    expect(toOpenRow(est({ updated_at: iso(4 * DAY) }), NOW, wall)!.stale).toBe(true);
  });
});

describe('summarizeOpenEstimates', () => {
  it('counts per bucket, leaves old drafts out of counts, and sorts oldest first', () => {
    const rep = summarizeOpenEstimates([
      est({ id: 'a', status: 'sent', sent_for_approval_at: iso(1 * DAY) }),
      est({ id: 'b', status: 'sent', sent_for_approval_at: iso(9 * DAY), grand_total: 500 }),
      est({ id: 'c', updated_at: iso(200 * DAY) }),
      est({ id: 'd', netsuite_so_id: '1' }),
    ], NOW, wall);
    expect(rep.rows.map(r => r.id)).toEqual(['c', 'b', 'a']);
    expect(rep.counts.waiting).toEqual({ count: 2, stale: 1, total: 1500 });
    expect(rep.counts.not_sent.count).toBe(0);
  });
});
