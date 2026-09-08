import { describe, it, expect } from 'vitest';
import {
  CLOSE_GATES, resolveGate, closeVerdict, monthBounds, shiftPeriod, periodFor, PERIOD_RE,
  type GateDef, type GateResult, type GateSignoff,
} from './month-close';

const computed: GateDef = {
  key: 't', title: 'T', passMeans: 'clean', link: '/x', fixLabel: 'Fix', kind: 'computed',
};
const manual: GateDef = { ...computed, key: 'm', kind: 'manual', manualBecause: 'lives in NetSuite' };

const signoff = (kind: 'acknowledged' | 'waived', note = 'because'): GateSignoff =>
  ({ kind, note, signedByName: 'Dana', signedAt: '2026-09-01T00:00:00.000Z' });

describe('resolveGate', () => {
  it('passes a computed gate with nothing outstanding', () => {
    expect(resolveGate(computed, { count: 0 }, null).state).toBe('pass');
  });

  it('fails a computed gate with work outstanding', () => {
    const g = resolveGate(computed, { count: 3 }, null);
    expect(g.state).toBe('fail');
    expect(g.count).toBe(3);
  });

  it('reports a FAILED read as unknown — never as a pass', () => {
    const g = resolveGate(computed, { count: null, error: 'timeout' }, null);
    expect(g.state).toBe('unknown');
    expect(g.error).toBe('timeout');
  });

  it('reports a missing read as unknown too', () => {
    expect(resolveGate(computed, null, null).state).toBe('unknown');
  });

  it('a waiver marks a failing gate waived — it does NOT become a pass', () => {
    const g = resolveGate(computed, { count: 2 }, signoff('waived'));
    expect(g.state).toBe('waived');
    // The outstanding count stays visible: a waiver is acceptance, not a fix.
    expect(g.count).toBe(2);
    expect(g.signoff?.signedByName).toBe('Dana');
  });

  it('refuses to let a waiver rescue an UNKNOWN gate', () => {
    // You cannot accept a number you were never shown.
    const g = resolveGate(computed, { count: null, error: 'boom' }, signoff('waived'));
    expect(g.state).toBe('unknown');
    expect(g.signoff).toBeNull();
  });

  it('leaves a manual gate pending until someone signs it off', () => {
    expect(resolveGate(manual, null, null).state).toBe('pending');
    expect(resolveGate(manual, null, signoff('acknowledged')).state).toBe('acknowledged');
  });

  it('never gives a manual gate a count, even if one is passed in', () => {
    expect(resolveGate(manual, { count: 7 }, null).count).toBeNull();
  });
});

describe('closeVerdict', () => {
  const g = (state: GateResult['state']): GateResult =>
    ({ ...computed, key: state, state, count: null, examples: [], error: null, signoff: null });

  it('is ready when every gate is passed, acknowledged or waived', () => {
    const v = closeVerdict([g('pass'), g('acknowledged'), g('waived')]);
    expect(v.ready).toBe(true);
    expect(v.blocking).toHaveLength(0);
  });

  it('blocks on a failing gate', () => {
    const v = closeVerdict([g('pass'), g('fail')]);
    expect(v.ready).toBe(false);
    expect(v.blocking.map(b => b.state)).toEqual(['fail']);
  });

  it('blocks on an unmeasured gate — unknown is not clean', () => {
    const v = closeVerdict([g('pass'), g('unknown')]);
    expect(v.ready).toBe(false);
    expect(v.unmeasured).toHaveLength(1);
  });

  it('blocks on a pending manual gate', () => {
    expect(closeVerdict([g('pending')]).ready).toBe(false);
  });

  it('surfaces waived gates separately so "closed" never reads as "all clean"', () => {
    const v = closeVerdict([g('pass'), g('waived')]);
    expect(v.ready).toBe(true);
    expect(v.waived).toHaveLength(1);
    expect(v.passed).toBe(1);
  });
});

describe('periods', () => {
  it('shifts forward and backward across year boundaries', () => {
    expect(shiftPeriod('2026-01', -1)).toBe('2025-12');
    expect(shiftPeriod('2026-12', 1)).toBe('2027-01');
    expect(shiftPeriod('2026-09', 0)).toBe('2026-09');
    expect(shiftPeriod('2026-03', -14)).toBe('2025-01');
  });

  it('bounds a winter month at Chicago midnight (CST, UTC-6)', () => {
    const b = monthBounds('2026-01');
    expect(b.startIso).toBe('2026-01-01T06:00:00.000Z');
    expect(b.endIso).toBe('2026-02-01T06:00:00.000Z');
    expect(b.label).toBe('January 2026');
  });

  it('bounds a summer month at Chicago midnight (CDT, UTC-5)', () => {
    const b = monthBounds('2026-07');
    expect(b.startIso).toBe('2026-07-01T05:00:00.000Z');
    expect(b.endIso).toBe('2026-08-01T05:00:00.000Z');
  });

  it('handles the month a DST change falls inside — each end uses its OWN offset', () => {
    // DST starts 2026-03-08: March opens on CST and closes on CDT.
    const march = monthBounds('2026-03');
    expect(march.startIso).toBe('2026-03-01T06:00:00.000Z');
    expect(march.endIso).toBe('2026-04-01T05:00:00.000Z');
    // DST ends 2026-11-01: November opens on CDT and closes on CST.
    const nov = monthBounds('2026-11');
    expect(nov.startIso).toBe('2026-11-01T05:00:00.000Z');
    expect(nov.endIso).toBe('2026-12-01T06:00:00.000Z');
  });

  it('rejects a malformed period rather than bounding something arbitrary', () => {
    expect(() => monthBounds('2026-13')).toThrow();
    expect(() => monthBounds('2026-1')).toThrow();
    expect(() => monthBounds('nope')).toThrow();
  });

  it('derives the period from the Chicago calendar, not UTC', () => {
    // 2026-10-01T02:00Z is still 9pm Sept 30 in Chicago — September's month.
    expect(periodFor(new Date('2026-10-01T02:00:00Z'))).toBe('2026-09');
    expect(periodFor(new Date('2026-10-01T06:00:00Z'))).toBe('2026-10');
  });
});

describe('the gate registry', () => {
  it('has unique keys', () => {
    expect(new Set(CLOSE_GATES.map(g => g.key)).size).toBe(CLOSE_GATES.length);
  });

  it('gives every gate a real destination, never a bare hash or empty string', () => {
    for (const g of CLOSE_GATES) {
      expect(g.link.startsWith('/')).toBe(true);
      expect(g.fixLabel.length).toBeGreaterThan(0);
      expect(g.passMeans.length).toBeGreaterThan(0);
    }
  });

  it('makes every manual gate explain why the app cannot compute it', () => {
    for (const g of CLOSE_GATES.filter(x => x.kind === 'manual')) {
      expect(g.manualBecause && g.manualBecause.length > 0).toBe(true);
    }
  });

  it('accepts only YYYY-MM periods', () => {
    expect(PERIOD_RE.test('2026-09')).toBe(true);
    expect(PERIOD_RE.test('2026-00')).toBe(false);
    expect(PERIOD_RE.test('2026-09-01')).toBe(false);
  });
});
