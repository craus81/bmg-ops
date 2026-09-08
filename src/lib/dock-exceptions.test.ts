import { describe, it, expect } from 'vitest';
import {
  ageDays, ageTone, exceptionChipText, summarizeExceptions, type DockException,
} from './dock-exceptions';

const NOW = Date.parse('2026-09-08T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const ex = (over: Partial<DockException> = {}): DockException => ({
  id: 'e1', poId: 'p1', poTranid: 'PO123', vendorName: 'Grimco',
  itemNumber: 'IJ280-54', kind: 'short', quantity: 2, note: null,
  status: 'open', resolution: null, createdAt: daysAgo(1), ...over,
});

describe('ageDays / ageTone', () => {
  it('ages a claim and escalates at a week and a fortnight', () => {
    expect(ageDays(ex({ createdAt: daysAgo(3) }), NOW)).toBe(3);
    expect(ageTone(3)).toBe('ok');
    expect(ageTone(7)).toBe('warn');
    expect(ageTone(21)).toBe('bad');
  });

  it('survives an unparseable timestamp instead of returning NaN', () => {
    expect(ageDays(ex({ createdAt: 'not a date' }), NOW)).toBe(0);
  });
});

describe('summarizeExceptions', () => {
  it('counts only OPEN claims, grouped by kind and vendor', () => {
    const s = summarizeExceptions([
      ex({ id: 'a', kind: 'short', createdAt: daysAgo(2) }),
      ex({ id: 'b', kind: 'damaged', vendorName: 'Fellers', createdAt: daysAgo(20) }),
      ex({ id: 'c', kind: 'short', status: 'resolved', resolution: 'vendor_credit', createdAt: daysAgo(30) }),
    ], NOW);
    expect(s.open).toBe(2);
    expect(s.byKind).toEqual({ short: 1, damaged: 1, wrong_item: 0 });
    // The resolved 30-day-old claim must not set "oldest".
    expect(s.oldestDays).toBe(20);
    expect(s.stale).toBe(1);
  });

  it('sorts vendors by their oldest rotting claim, not by count', () => {
    const s = summarizeExceptions([
      ex({ id: 'a', vendorName: 'Busy Vendor', createdAt: daysAgo(1) }),
      ex({ id: 'b', vendorName: 'Busy Vendor', createdAt: daysAgo(2) }),
      ex({ id: 'c', vendorName: 'Old Claim Co', createdAt: daysAgo(30) }),
    ], NOW);
    expect(s.byVendor[0]).toMatchObject({ vendor: 'Old Claim Co', open: 1, oldestDays: 30 });
    expect(s.byVendor[1]).toMatchObject({ vendor: 'Busy Vendor', open: 2 });
  });

  it('buckets a missing vendor name rather than dropping the claim', () => {
    const s = summarizeExceptions([ex({ vendorName: null })], NOW);
    expect(s.byVendor[0].vendor).toBe('Unknown vendor');
  });
});

describe('exceptionChipText', () => {
  it('stays silent when there is nothing to chase', () => {
    expect(exceptionChipText(summarizeExceptions([], NOW))).toBeNull();
    expect(exceptionChipText(summarizeExceptions([
      ex({ status: 'resolved', resolution: 'written_off' }),
    ], NOW))).toBeNull();
  });

  it('names the count and the oldest claim', () => {
    const text = exceptionChipText(summarizeExceptions([ex({ createdAt: daysAgo(9) })], NOW));
    expect(text).toBe('1 open dock issue · oldest 9d');
  });
});
