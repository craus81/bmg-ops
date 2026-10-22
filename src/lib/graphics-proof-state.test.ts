import { describe, it, expect } from 'vitest';
import { isReadyToProduce, proofState, compareReadyJobs } from './graphics-proof-state';

const NOW = new Date('2026-10-21T12:00:00Z').getTime();

describe('isReadyToProduce', () => {
  it('is approved and not printing yet', () => {
    expect(isReadyToProduce({ status: 'designing', customer_approved: true })).toBe(true);
    expect(isReadyToProduce({ status: 'received', customer_approved: true })).toBe(true);
  });
  it('drops off once production starts', () => {
    for (const status of ['printing', 'cutting', 'packing', 'ready', 'shipped'] as const) {
      expect(isReadyToProduce({ status, customer_approved: true })).toBe(false);
    }
  });
  it('needs an approval', () => {
    expect(isReadyToProduce({ status: 'designing', customer_approved: false })).toBe(false);
    expect(isReadyToProduce({ status: 'designing' })).toBe(false);
  });
  it('skips flagged, revision and cancelled jobs', () => {
    for (const status of ['flagged', 'revision', 'cancelled'] as const) {
      expect(isReadyToProduce({ status, customer_approved: true })).toBe(false);
    }
  });
  it('skips proofing-only jobs, which have no production', () => {
    expect(isReadyToProduce({ status: 'designing', customer_approved: true, job_category: 'proofing' })).toBe(false);
    expect(isReadyToProduce({ status: 'designing', customer_approved: true, job_category: 'production' })).toBe(true);
  });
});

describe('proofState', () => {
  it('ready vs approved-and-moving', () => {
    expect(proofState({ status: 'designing', customer_approved: true, customer_approved_at: 'x' }, NOW))
      .toEqual({ kind: 'ready', approvedAt: 'x' });
    expect(proofState({ status: 'printing', customer_approved: true }, NOW))
      .toEqual({ kind: 'approved', approvedAt: null });
  });
  it('changes requested', () => {
    expect(proofState({ status: 'revision', customer_rejected_at: '2026-10-20T00:00:00Z' }, NOW).kind).toBe('changes');
  });
  it('waiting counts whole days', () => {
    expect(proofState({ status: 'designing', sent_for_approval_at: '2026-10-18T11:00:00Z' }, NOW))
      .toEqual({ kind: 'waiting', sentAt: '2026-10-18T11:00:00Z', days: 3 });
  });
  it('nothing sent', () => {
    expect(proofState({ status: 'designing' }, NOW).kind).toBe('none');
  });
});

describe('compareReadyJobs', () => {
  it('soonest due first, undated last, then oldest approval', () => {
    const jobs = [
      { id: 'c', due_date: null, customer_approved_at: '2026-10-01' },
      { id: 'b', due_date: '2026-10-24', customer_approved_at: '2026-10-21' },
      { id: 'a', due_date: '2026-10-20', customer_approved_at: '2026-10-21' },
      { id: 'b0', due_date: '2026-10-24', customer_approved_at: '2026-10-19' },
    ];
    expect(jobs.sort(compareReadyJobs).map(j => j.id)).toEqual(['a', 'b0', 'b', 'c']);
  });
});
