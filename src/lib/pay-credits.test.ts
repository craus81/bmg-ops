import { describe, it, expect, vi } from 'vitest';
import { splitAmounts, priceUnpricedCredits, creditRowsForAddedPart } from './pay-credits';

const m = (profile_id: string, share_weight = 1) => ({ profile_id, share_weight });

describe('splitAmounts', () => {
  it('splits evenly across the crew', () => {
    const out = splitAmounts(100, [m('a'), m('b'), m('c'), m('d')]);
    expect(out.map(o => o.amount)).toEqual([25, 25, 25, 25]);
  });

  it('always sums exactly to the rate (rounding remainder lands on the first member)', () => {
    const out = splitAmounts(100, [m('a'), m('b'), m('c')]);
    expect(out.reduce((s, o) => s + (o.amount || 0), 0)).toBeCloseTo(100, 10);
    expect(out.map(o => o.amount)).toEqual([33.34, 33.33, 33.33]);
  });

  it('honors uneven share weights', () => {
    const out = splitAmounts(100, [m('lead', 2), m('helper'), m('helper2')]);
    expect(out.map(o => o.amount)).toEqual([50, 25, 25]);
  });

  it('handles fractional weights and awkward rates without losing cents', () => {
    const out = splitAmounts(99.99, [m('a', 1.5), m('b', 1), m('c', 1)]);
    const total = out.reduce((s, o) => s + Math.round((o.amount || 0) * 100), 0);
    expect(total).toBe(9999);
  });

  it('solo crew takes the full rate', () => {
    expect(splitAmounts(87.5, [m('a')])[0].amount).toBe(87.5);
  });

  it('null rate (unpriced part) yields null amounts but keeps the members', () => {
    const out = splitAmounts(null, [m('a'), m('b')]);
    expect(out).toHaveLength(2);
    expect(out.every(o => o.amount === null)).toBe(true);
  });

  it('empty crew yields no rows', () => {
    expect(splitAmounts(100, [])).toEqual([]);
  });
});

describe('priceUnpricedCredits', () => {
  it('only prices FIELD credits — a field rate must never touch CNI credits for the same part', async () => {
    // Regression: without .eq('source','field'), setting a field pay rate
    // silently priced unpriced CNI credits (which price from their job's
    // pay-per-vehicle) at the field rate.
    const filters: Record<string, unknown> = {};
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn((col: string, val: unknown) => { filters[col] = val; return query; }),
      // Part-number matching is case-insensitive (ilike, wildcards escaped).
      ilike: vi.fn((col: string, val: unknown) => { filters[`ilike:${col}`] = val; return query; }),
      is: vi.fn((col: string, val: unknown) => { filters[`is:${col}`] = val; return query; }),
      then: (resolve: (v: { data: any[] }) => void) => resolve({ data: [] }),
    };
    const service: any = { from: vi.fn(() => query) };

    const result = await priceUnpricedCredits(service, '06T895', 145);
    expect(result).toEqual({ ok: true, priced: 0 });
    expect(filters['ilike:part_number']).toBe('06T895');
    expect(filters['source']).toBe('field');
    expect(filters['is:amount']).toBe(null);
    expect(filters['is:voided_at']).toBe(null);
  });
});

describe('creditRowsForAddedPart', () => {
  const src = (profile_id: string, share_weight = 1) => ({
    shift_id: 'shift-1', profile_id, share_weight, source: 'field',
  });

  it('pays the crew that was on the vehicle, at the ADDED part\'s own rate', () => {
    // The decal kit was credited to a two-person crew at its own rate; the
    // unit number added afterwards pays the same two people at the unit
    // number's rate, on the same shift.
    const rows = creditRowsForAddedPart([src('a'), src('b')], {
      scanLogId: 'scan-2', vin: '1FTBW2CM4NKA00001', partNumber: '06U166', rate: 50, createdBy: 'admin',
    });
    expect(rows.map(r => r.amount)).toEqual([25, 25]);
    expect(rows.every(r => r.shift_id === 'shift-1')).toBe(true);
    expect(rows.every(r => r.scan_log_id === 'scan-2')).toBe(true);
    expect(rows.every(r => r.part_number === '06U166')).toBe(true);
    expect(rows.every(r => r.rate_per_vehicle === 50)).toBe(true);
    expect(rows.every(r => r.crew_size === 2)).toBe(true);
  });

  it('keeps each member\'s snapshotted weight', () => {
    const rows = creditRowsForAddedPart([src('lead', 2), src('helper', 1)], {
      scanLogId: 'scan-2', vin: 'VIN', partNumber: 'P', rate: 90, createdBy: 'admin',
    });
    expect(rows.map(r => r.amount)).toEqual([60, 30]);
    expect(rows.map(r => r.share_weight)).toEqual([2, 1]);
  });

  it('an unpriced added part still credits the crew (amount NULL, needs pricing)', () => {
    const rows = creditRowsForAddedPart([src('a')], {
      scanLogId: 'scan-2', vin: 'VIN', partNumber: 'NEWPART', rate: null, createdBy: 'admin',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(null);
    expect(rows[0].rate_per_vehicle).toBe(null);
  });

  it('pays a member once even if the source somehow holds two live rows for them', () => {
    const rows = creditRowsForAddedPart([src('a'), src('a'), src('b')], {
      scanLogId: 'scan-2', vin: 'VIN', partNumber: 'P', rate: 100, createdBy: 'admin',
    });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((t, r) => t + (r.amount || 0), 0)).toBeCloseTo(100, 10);
  });

  it('no crew on the first part means nothing to pay for the added one', () => {
    expect(creditRowsForAddedPart([], {
      scanLogId: 'scan-2', vin: 'VIN', partNumber: 'P', rate: 100, createdBy: 'admin',
    })).toEqual([]);
  });
});
