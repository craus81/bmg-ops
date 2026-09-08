import { describe, it, expect } from 'vitest';
import { computeStageDwell } from './ops-pulse';

const ev = (vehicleId: string, toStatus: string, at: string) => ({ vehicleId, toStatus, at });

describe('computeStageDwell', () => {
  it('measures per-stage dwell from entry to the next transition (or completion)', () => {
    const done = new Map([['v1', '2026-09-08T00:00:00Z']]);
    const { stages } = computeStageDwell([
      ev('v1', 'received', '2026-09-01T00:00:00Z'), // 2d in received
      ev('v1', 'in_progress', '2026-09-03T00:00:00Z'), // 4d in progress
      ev('v1', 'stuck_parts', '2026-09-07T00:00:00Z'), // 1d stuck → completion
      ev('v1', 'complete', '2026-09-08T00:00:00Z'),
    ], done);
    const by = Object.fromEntries(stages.map(s => [s.stage, s.medianDays]));
    expect(by).toEqual({ received: 2, in_progress: 4, stuck_parts: 1 });
  });

  it('a returning vehicle only counts its LAST cycle (m229 re-check-in trap)', () => {
    const done = new Map([['v1', '2026-09-08T00:00:00Z']]);
    const { stages } = computeStageDwell([
      // First visit, months earlier — must not pollute this cycle.
      ev('v1', 'received', '2026-06-01T00:00:00Z'),
      ev('v1', 'in_progress', '2026-06-02T00:00:00Z'),
      ev('v1', 'complete', '2026-06-20T00:00:00Z'),
      ev('v1', 'shipped', '2026-06-21T00:00:00Z'),
      // Second visit.
      ev('v1', 'received', '2026-09-05T00:00:00Z'), // 1d
      ev('v1', 'in_progress', '2026-09-06T00:00:00Z'), // 2d
      ev('v1', 'complete', '2026-09-08T00:00:00Z'),
    ], done);
    const by = Object.fromEntries(stages.map(s => [s.stage, s.medianDays]));
    expect(by).toEqual({ received: 1, in_progress: 2 });
  });

  it('the slowest stage needs at least 3 samples — one stuck vehicle never crowns a stage', () => {
    const done = new Map([
      ['a', '2026-09-04T00:00:00Z'], ['b', '2026-09-05T00:00:00Z'], ['c', '2026-09-05T00:00:00Z'],
    ]);
    const { slowest, stages } = computeStageDwell([
      // One vehicle sat 20 days in stuck_parts (1 sample) — not eligible.
      ev('a', 'received', '2026-08-10T00:00:00Z'),
      ev('a', 'stuck_parts', '2026-08-15T00:00:00Z'),
      ev('a', 'complete', '2026-09-04T00:00:00Z'),
      ev('b', 'received', '2026-09-01T00:00:00Z'),
      ev('b', 'in_progress', '2026-09-02T00:00:00Z'),
      ev('b', 'complete', '2026-09-05T00:00:00Z'),
      ev('c', 'received', '2026-09-01T00:00:00Z'),
      ev('c', 'in_progress', '2026-09-02T00:00:00Z'),
      ev('c', 'complete', '2026-09-05T00:00:00Z'),
    ], done);
    // stuck_parts has the biggest median (20d) but only 1 sample; received
    // is the slowest ELIGIBLE stage with 3 samples (5d, 1d, 1d → median 1).
    expect(stages[0]).toMatchObject({ stage: 'stuck_parts', samples: 1 });
    expect(slowest?.stage).toBe('received');
    expect(slowest?.samples).toBe(3);
  });
});
