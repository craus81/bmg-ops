import { describe, expect, it } from 'vitest';
import { deriveJobProgress, chicagoToday, type JobProgressInput } from './job-progress';

const base = (over: Partial<JobProgressInput> = {}): JobProgressInput => ({
  approved: true,
  approvedAt: '2026-11-01T15:00:00Z',
  parts: { total: 0, ordered: 0, received: 0, orderedAt: null, receivedAt: null },
  partsAllInAt: null,
  graphics: [],
  schedule: null,
  onsite: false,
  arrivedAt: null,
  installStartedAt: null,
  installLabel: null,
  complete: null,
  invoiced: null,
  today: '2026-11-06',
  ...over,
});

const states = (v: ReturnType<typeof deriveJobProgress>) => v.stages.map(s => `${s.key}:${s.state}`);

describe('deriveJobProgress', () => {
  it('a fresh order: Submitted green, Parts ordered in progress, no graphics skipped', () => {
    const v = deriveJobProgress(base());
    expect(states(v)).toEqual([
      'submitted:done', 'parts_ordered:now', 'graphics:skip', 'parts_in:todo',
      'scheduled:todo', 'arrived:todo', 'install:todo', 'complete:todo',
    ]);
    expect(v.stages[2].label).toBe('No graphics');
    expect(v.nextStep).toBe('Order the parts');
  });

  it('all parts on a PO moves to graphics design', () => {
    const v = deriveJobProgress(base({
      parts: { total: 3, ordered: 3, received: 1, orderedAt: '2026-11-02T10:00:00Z', receivedAt: null },
      graphics: [{ status: 'designing', approved: false, approvedAt: null }],
    }));
    expect(v.current).toBe('graphics');
    expect(v.currentLabel).toBe('Graphic design');
    expect(v.parts).toEqual({ text: '3 of 3 ordered · 1 in', ok: false });
  });

  it('a proof sent back reads Design in revision', () => {
    const v = deriveJobProgress(base({
      parts: { total: 1, ordered: 1, received: 0, orderedAt: null, receivedAt: null },
      graphics: [{ status: 'revision', approved: false, approvedAt: null }],
    }));
    expect(v.currentLabel).toBe('Design in revision');
  });

  it('an approved proof, or printing without one recorded, is Design approved', () => {
    for (const g of [
      { status: 'designing', approved: true, approvedAt: '2026-11-03T10:00:00Z' },
      { status: 'printing', approved: false, approvedAt: null },
    ]) {
      const v = deriveJobProgress(base({
        parts: { total: 1, ordered: 1, received: 0, orderedAt: null, receivedAt: null },
        graphics: [g],
      }));
      expect(v.stages[2]).toMatchObject({ state: 'done', label: 'Design approved' });
      expect(v.current).toBe('parts_in');
    }
  });

  it('parts in moves on its own when every part is received, or by hand', () => {
    const auto = deriveJobProgress(base({ parts: { total: 2, ordered: 2, received: 2, orderedAt: null, receivedAt: '2026-11-04T10:00:00Z' } }));
    expect(auto.current).toBe('scheduled');
    const byHand = deriveJobProgress(base({ parts: { total: 2, ordered: 2, received: 0, orderedAt: null, receivedAt: null }, partsAllInAt: '2026-11-04T10:00:00Z' }));
    expect(byHand.current).toBe('scheduled');
    expect(byHand.parts).toEqual({ text: 'All items in', ok: true });
  });

  it('a vehicle in the bay with parts still out shows Parts in held up, not green', () => {
    const v = deriveJobProgress(base({
      parts: { total: 4, ordered: 4, received: 3, orderedAt: null, receivedAt: null },
      schedule: { date: '2026-11-05', time: '08:00:00', place: 'shop' },
      arrivedAt: '2026-11-05T13:45:00Z',
    }));
    expect(v.current).toBe('install');
    expect(v.stages.find(s => s.key === 'parts_in')!.state).toBe('held');
    expect(v.heldUp).toEqual(['Parts in']);
    expect(v.nextStep).toBe('Tech starts the install');
  });

  it('nothing ever requested: earlier parts steps go green once a later step is reached', () => {
    const v = deriveJobProgress(base({ arrivedAt: '2026-11-05T13:45:00Z' }));
    expect(v.stages.find(s => s.key === 'parts_ordered')!.state).toBe('done');
    expect(v.stages.find(s => s.key === 'parts_in')!.state).toBe('done');
    expect(v.current).toBe('install');
  });

  it('install starts when the tech starts work, not at check-in', () => {
    const v = deriveJobProgress(base({
      arrivedAt: '2026-11-05T13:45:00Z',
      installStartedAt: '2026-11-05T15:10:00Z',
      installLabel: 'Upfit In Progress',
    }));
    expect(v.current).toBe('complete');
    expect(v.stages.find(s => s.key === 'install')!.detail).toContain('Upfit In Progress');
  });

  it('on-site jobs read Tech on site and move on the install day', () => {
    const before = deriveJobProgress(base({
      graphics: [{ status: 'ready', approved: true, approvedAt: null }],
      schedule: { date: '2026-11-10', time: null, place: 'onsite' },
      onsite: true,
    }));
    expect(before.current).toBe('arrived');
    expect(before.currentLabel).toBe('Tech on site');
    const day = deriveJobProgress(base({
      graphics: [{ status: 'ready', approved: true, approvedAt: null }],
      schedule: { date: '2026-11-06', time: null, place: 'onsite' },
      onsite: true,
    }));
    expect(day.current).toBe('complete');
  });

  it('complete or billed turns every step green', () => {
    const v = deriveJobProgress(base({
      parts: { total: 2, ordered: 1, received: 0, orderedAt: null, receivedAt: null },
      graphics: [{ status: 'designing', approved: false, approvedAt: null }],
      invoiced: { at: '2026-11-05', number: 'INV2712' },
    }));
    expect(v.done).toBe(true);
    expect(v.stages.every(s => s.state === 'done')).toBe(true);
    expect(v.nextStep).toBe('Nothing left');
    expect(v.stages[7].detail).toContain('INV2712');
  });
});

describe('chicagoToday', () => {
  it('uses the Chicago date, not UTC', () => {
    expect(chicagoToday(new Date('2026-11-06T03:00:00Z'))).toBe('2026-11-05');
  });
});
