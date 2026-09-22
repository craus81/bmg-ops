import { describe, it, expect } from 'vitest';
import { computeCniScorecards, cniChipText, type CniFacts } from './cni-scorecards';

// Windows: [PREV, START) = prior period, [START, now] = current period.
const PREV = '2026-06-10T00:00:00Z';
const START = '2026-09-08T00:00:00Z';

describe('computeCniScorecards', () => {
  const facts: CniFacts = {
    jobs: [
      { id: 'j1', companyId: 'c1', installerId: 'u1', deadline: '2026-09-10' },
      { id: 'j2', companyId: 'c1', installerId: null, deadline: null },
    ],
    completions: [
      { jobId: 'j1', at: '2026-09-09T12:00:00Z' }, // current window, on time
      { jobId: 'j2', at: '2026-07-01T12:00:00Z' }, // prior window, no deadline
    ],
    invites: [
      { jobId: 'j1', installerId: 'u1', sentAt: '2026-09-09T00:00:00Z' },
      { jobId: 'j2', installerId: 'u1', sentAt: '2026-09-09T00:00:00Z' },
    ],
    bids: [
      { jobId: 'j1', installerId: 'u1', response: 'interested', respondedAt: '2026-09-09T04:00:00Z' }, // 4h
      { jobId: 'j2', installerId: 'u1', response: 'declined', respondedAt: '2026-09-09T10:00:00Z' }, // 10h
    ],
    vins: [{ jobId: 'j1', completedAt: '2026-09-09T13:00:00Z' }],
    companyByUser: { u1: 'c1' },
  };
  const out = computeCniScorecards(facts, PREV, START);

  it('company grain: current window + prior-window trend, on-time only counts deadlined jobs', () => {
    const c1 = out.companies.c1;
    expect(c1).toMatchObject({ jobsCompleted: 1, onTimeRate: 100, onTimeSamples: 1, vehiclesCompleted: 1 });
    expect(c1.prev).toMatchObject({ jobsCompleted: 1, onTimeRate: null, onTimeSamples: 0 });
  });

  // Migration 307 retired the photo approve/deny review, and the photo
  // first-pass metric went with it: there are no verdicts to score. Photos
  // are no longer read by the scorecards at all.
  it('scores nothing from photos', () => {
    expect(out.companies.c1).not.toHaveProperty('photoFirstPassRate');
    expect(out.companies.c1).not.toHaveProperty('photoDenials');
  });

  it('invite→response median and decline rate on both grains', () => {
    expect(out.installers.u1).toMatchObject({ medianResponseHours: 7, responseSamples: 2, declineRate: 50 });
    expect(out.companies.c1).toMatchObject({ medianResponseHours: 7, responseSamples: 2 });
  });
});

describe('cniChipText', () => {
  it('joins the stats that exist; null when none', () => {
    expect(cniChipText({
      jobsCompleted: 12, onTimeRate: 92, onTimeSamples: 10,
      medianResponseHours: 5, responseSamples: 9,
      declineRate: 0, vehiclesCompleted: 30,
    })).toBe('12 jobs · 92% on time · ~5h response');
    expect(cniChipText({
      jobsCompleted: 0, onTimeRate: null, onTimeSamples: 0,
      medianResponseHours: null, responseSamples: 0,
      declineRate: null, vehiclesCompleted: 0,
    })).toBe(null);
  });
});
