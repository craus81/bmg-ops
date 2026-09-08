import { describe, it, expect } from 'vitest';
import { decideNudges, type ReadyVehicle } from './ready-pickup';

const NOW = Date.parse('2026-09-08T15:00:00Z');
const base: ReadyVehicle = {
  id: 'v1', label: '2024 Ford Transit', customerName: 'Acme', daysReady: 0,
  hasBooking: false, portalToken: 'tok', nudgeCount: 0, lastNudgeAt: null,
  escalatedAt: null, salesRepId: 'rep1',
};

describe('decideNudges', () => {
  it('first reminder at nudgeDays, escalation at 2×, both can fire together', () => {
    const plan = decideNudges([
      { ...base, id: 'fresh', daysReady: 2 }, // too fresh
      { ...base, id: 'due', daysReady: 3 }, // nudge only
      { ...base, id: 'late', daysReady: 6 }, // nudge + escalate
    ], 3, NOW);
    expect(plan.nudges.map(v => v.id)).toEqual(['due', 'late']);
    expect(plan.escalations.map(v => v.id)).toEqual(['late']);
  });

  it('repeats weekly, never daily, and escalates only once', () => {
    const plan = decideNudges([
      { ...base, id: 'recent', daysReady: 5, lastNudgeAt: '2026-09-06T00:00:00Z' }, // nudged 2d ago
      { ...base, id: 'stale', daysReady: 12, lastNudgeAt: '2026-08-30T00:00:00Z', escalatedAt: '2026-09-01T00:00:00Z' },
    ], 3, NOW);
    expect(plan.nudges.map(v => v.id)).toEqual(['stale']); // 9+ days since last
    expect(plan.escalations).toEqual([]); // already escalated
  });

  it('leaves booked vehicles, tokenless rows, and pre-feature relics alone', () => {
    const plan = decideNudges([
      { ...base, id: 'booked', daysReady: 10, hasBooking: true },
      { ...base, id: 'no-token', daysReady: 10, portalToken: null },
      { ...base, id: 'relic', daysReady: 200 }, // months old — no auto-email blast
    ], 3, NOW);
    expect(plan.nudges).toEqual([]);
    // A tokenless vehicle can still escalate to staff; booked and relic don't.
    expect(plan.escalations.map(v => v.id)).toEqual(['no-token']);
  });
});
