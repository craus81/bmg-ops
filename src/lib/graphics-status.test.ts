import { describe, it, expect } from 'vitest';
import {
  classifyTransition, requiresReason, proofGateApplies,
  inStatusScope, GRAPHICS_ACTIVE_STATUSES, GRAPHICS_FINISHED_STATUSES,
  GRAPHICS_PIPELINE, GRAPHICS_SIDE_STATES,
} from './graphics-status';
import { GRAPHICS_STATUS_ORDER } from './types';

describe('classifyTransition', () => {
  it('treats an unchanged status as same', () => {
    expect(classifyTransition('printing', 'printing')).toBe('same');
  });

  it('allows a single step forward', () => {
    expect(classifyTransition('designing', 'printing')).toBe('forward');
  });

  it('allows a long forward skip — the floor runs ahead of the buttons', () => {
    expect(classifyTransition('printing', 'shipped')).toBe('forward');
    expect(classifyTransition('cutting', 'picked_up')).toBe('forward');
    expect(classifyTransition('received', 'installed')).toBe('forward');
  });

  it('calls a move back up the pipeline backward', () => {
    expect(classifyTransition('shipped', 'printing')).toBe('backward');
    expect(classifyTransition('packing', 'designing')).toBe('backward');
  });

  it('treats the escape hatches as side moves in both directions', () => {
    for (const s of GRAPHICS_SIDE_STATES) {
      expect(classifyTransition('printing', s)).toBe('side');
      expect(classifyTransition(s, 'printing')).toBe('side');
    }
  });
});

describe('requiresReason', () => {
  it('only asks on backward moves', () => {
    expect(requiresReason('shipped', 'designing')).toBe(true);
    expect(requiresReason('designing', 'shipped')).toBe(false);
    expect(requiresReason('printing', 'flagged')).toBe(false);
    expect(requiresReason('flagged', 'printing')).toBe(false);
    expect(requiresReason('cancelled', 'received')).toBe(false);
  });
});

describe('proofGateApplies', () => {
  it('gates printing when the proof is not approved', () => {
    expect(proofGateApplies('printing', { customer_approved: false })).toBe(true);
    expect(proofGateApplies('printing', {})).toBe(true);
    expect(proofGateApplies('printing', { customer_approved: null })).toBe(true);
  });

  it('lets an approved proof print freely', () => {
    expect(proofGateApplies('printing', { customer_approved: true })).toBe(false);
  });

  it('does not re-gate a job already past printing', () => {
    expect(proofGateApplies('cutting', { customer_approved: false })).toBe(false);
    expect(proofGateApplies('shipped', { customer_approved: false })).toBe(false);
  });
});

describe('coverage of the real status list', () => {
  it('accounts for every status in GRAPHICS_STATUS_ORDER', () => {
    const covered = new Set([...GRAPHICS_PIPELINE, ...GRAPHICS_SIDE_STATES]);
    const missing = GRAPHICS_STATUS_ORDER.filter(s => !covered.has(s));
    expect(missing).toEqual([]);
  });

  it('never classifies a real pair as anything but the four kinds', () => {
    const kinds = new Set<string>();
    for (const a of GRAPHICS_STATUS_ORDER) {
      for (const b of GRAPHICS_STATUS_ORDER) kinds.add(classifyTransition(a, b));
    }
    expect([...kinds].sort()).toEqual(['backward', 'forward', 'same', 'side']);
  });
});

describe('inStatusScope', () => {
  it('keeps everything under the All tab', () => {
    for (const status of GRAPHICS_STATUS_ORDER) {
      expect(inStatusScope(status, 'all')).toBe(true);
    }
  });

  it('keeps live work under the Active tab', () => {
    expect(inStatusScope('designing', 'active')).toBe(true);
    expect(inStatusScope('printing', 'active')).toBe(true);
    expect(inStatusScope('ready_to_pickup', 'active')).toBe(true);
  });

  it('drops a job that has left the floor from the Active tab', () => {
    // The "My Jobs (23)" over a table of 6 bug: a shipped job stays assigned
    // to whoever ran it, so any count labelling the Active tab has to drop it.
    expect(inStatusScope('shipped', 'active')).toBe(false);
    expect(inStatusScope('picked_up', 'active')).toBe(false);
    expect(inStatusScope('installed', 'active')).toBe(false);
    expect(inStatusScope('cancelled', 'active')).toBe(false);
  });

  it('matches exactly one status when the scope is a status', () => {
    expect(inStatusScope('printing', 'printing')).toBe(true);
    expect(inStatusScope('designing', 'printing')).toBe(false);
    // Even a finished status is in scope when it IS the scope.
    expect(inStatusScope('shipped', 'shipped')).toBe(true);
  });

  it('sorts every status into exactly one of active or finished', () => {
    // A new status that lands in neither list would vanish from the Active
    // tab AND keep its work-order slot forever. Adding one means choosing.
    for (const status of GRAPHICS_STATUS_ORDER) {
      const active = GRAPHICS_ACTIVE_STATUSES.includes(status);
      const finished = GRAPHICS_FINISHED_STATUSES.includes(status);
      expect(active || finished, `${status} is in neither list`).toBe(true);
      expect(active && finished, `${status} is in both lists`).toBe(false);
    }
  });
});
