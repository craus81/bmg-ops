import { describe, it, expect } from 'vitest';
import {
  shiftMemberHours,
  totalShiftHours,
  getShopLaborForCheckins,
  closeShopShiftsForCheckin,
  type MemberWindow,
} from './shop-labor';

// 4-hour shift: 08:00 → 12:00 UTC.
const S = '2026-09-07T08:00:00.000Z';
const E = '2026-09-07T12:00:00.000Z';
const w = (profile_id: string, added_at: string | null, removed_at: string | null): MemberWindow =>
  ({ profile_id, added_at, removed_at });

describe('shiftMemberHours — presence overlap', () => {
  it('full-span member gets the whole shift; missing added_at counts from shift start', () => {
    const hours = shiftMemberHours(S, E, [
      w('a', S, null),
      w('b', null, null),
      w('c', '2026-09-07T06:00:00.000Z', null), // added before the shift → clamped
    ]);
    expect(hours.get('a')).toBe(4);
    expect(hours.get('b')).toBe(4);
    expect(hours.get('c')).toBe(4);
  });

  it('late add and early remove clip to the membership window', () => {
    const hours = shiftMemberHours(S, E, [
      w('late', '2026-09-07T10:00:00.000Z', null),
      w('early', S, '2026-09-07T09:30:00.000Z'),
      w('middle', '2026-09-07T09:00:00.000Z', '2026-09-07T11:00:00.000Z'),
    ]);
    expect(hours.get('late')).toBe(2);
    expect(hours.get('early')).toBe(1.5);
    expect(hours.get('middle')).toBe(2);
  });

  it('windows outside the shift clamp to zero, never negative', () => {
    const hours = shiftMemberHours(S, E, [
      w('after', '2026-09-07T13:00:00.000Z', null), // added after the shift ended
      w('before', S, '2026-09-07T07:00:00.000Z'), // removed before it started
    ]);
    expect(hours.get('after')).toBe(0);
    expect(hours.get('before')).toBe(0);
  });

  it('a re-added member (two windows) accumulates both', () => {
    const hours = shiftMemberHours(S, E, [
      w('a', S, '2026-09-07T09:00:00.000Z'),
      w('a', '2026-09-07T10:00:00.000Z', '2026-09-07T11:00:00.000Z'),
    ]);
    expect(hours.get('a')).toBe(2);
  });

  it('an invalid interval (end ≤ start, or unparsable) yields zeros for everyone', () => {
    expect(shiftMemberHours(E, S, [w('a', null, null)]).get('a')).toBe(0);
    expect(shiftMemberHours(S, S, [w('a', null, null)]).get('a')).toBe(0);
    expect(shiftMemberHours('not-a-date', E, [w('a', null, null)]).get('a')).toBe(0);
  });
});

describe('totalShiftHours', () => {
  it('sums member-hours (crew of 2 on a 4h shift = 8 member-hours)', () => {
    expect(totalShiftHours(S, E, [w('a', null, null), w('b', null, null)])).toBe(8);
    expect(totalShiftHours(S, E, [])).toBe(0);
  });
});

/**
 * Minimal thenable query fake: enough chain surface for shop-labor's reads
 * (select/eq/in/is/order/limit/maybeSingle) and closeShopShiftsForCheckin's
 * update…select. `update` mutates the backing rows so idempotence is real.
 */
type Row = Record<string, any>;
function makeFake(tables: { work_shifts?: Row[]; work_shift_members?: Row[]; quote_settings?: Row[] }) {
  const from = (table: string) => {
    const rows: Row[] = (tables as any)[table] || [];
    let filtered = [...rows];
    let patch: Row | null = null;
    const builder: any = {
      select: () => builder,
      update: (p: Row) => { patch = p; return builder; },
      eq: (col: string, val: any) => { filtered = filtered.filter(r => r[col] === val); return builder; },
      in: (col: string, vals: any[]) => { filtered = filtered.filter(r => vals.includes(r[col])); return builder; },
      is: (col: string, val: any) => { filtered = filtered.filter(r => r[col] === val); return builder; },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => {
        if (patch) for (const r of filtered) Object.assign(r, patch);
        return resolve({ data: filtered, error: null });
      },
    };
    return builder;
  };
  return { from } as any;
}

describe('getShopLaborForCheckins', () => {
  const shift = (id: string, checkin: string, started: string, ended: string | null, autoClosed = false): Row =>
    ({ id, context: 'shop', fleet_checkin_id: checkin, started_at: started, ended_at: ended, auto_closed: autoClosed });
  const member = (shiftId: string, profile: string): Row =>
    ({ shift_id: shiftId, profile_id: profile, added_at: null, removed_at: null });

  it('prices clean closed shifts exactly, with none of it approximate', async () => {
    const service = makeFake({
      work_shifts: [shift('s1', 'v1', S, '2026-09-07T10:00:00.000Z')], // 2h
      work_shift_members: [member('s1', 'a'), member('s1', 'b')],
      quote_settings: [{ id: 1, shop_labor_cost_rate: '35.5' }], // numeric arrives as a string
    });
    const labor = (await getShopLaborForCheckins(service, ['v1'])).get('v1')!;
    expect(labor.hours).toBe(4); // 2 members × 2h
    expect(labor.approxHours).toBe(0);
    expect(labor.cost).toBe(142); // 4 × 35.5
    expect(labor.hasOpenShift).toBe(false);
  });

  it('rounds to 2dp and prices from the rounded hours', async () => {
    const service = makeFake({
      work_shifts: [shift('s1', 'v1', S, '2026-09-07T09:40:00.000Z')], // 100min = 1.666…h
      work_shift_members: [member('s1', 'a')],
      quote_settings: [{ id: 1, shop_labor_cost_rate: 30 }],
    });
    const labor = (await getShopLaborForCheckins(service, ['v1'])).get('v1')!;
    expect(labor.hours).toBe(1.67);
    expect(labor.cost).toBe(50.1); // 1.67 × 30 — rounded hours are the priced hours
  });

  it('marks auto-closed and open shifts as approximate; open counts elapsed-to-now', async () => {
    const openStart = new Date(Date.now() - 3_600_000).toISOString(); // 1h ago
    const service = makeFake({
      work_shifts: [
        shift('s1', 'v1', S, '2026-09-07T10:00:00.000Z', true), // auto-closed 2h
        shift('s2', 'v1', openStart, null),
      ],
      work_shift_members: [member('s1', 'a'), member('s2', 'a')],
      quote_settings: [{ id: 1, shop_labor_cost_rate: null }],
    });
    const labor = (await getShopLaborForCheckins(service, ['v1'])).get('v1')!;
    expect(labor.hasOpenShift).toBe(true);
    expect(labor.hours).toBeGreaterThanOrEqual(2.99);
    expect(labor.hours).toBeLessThanOrEqual(3.02);
    expect(labor.approxHours).toBe(labor.hours); // both shifts are approximate
    expect(labor.cost).toBeNull(); // no rate configured → hours-only reporting
  });

  it('returns no entry for a check-in with no shop shifts', async () => {
    const service = makeFake({ work_shifts: [], work_shift_members: [], quote_settings: [] });
    const map = await getShopLaborForCheckins(service, ['v1']);
    expect(map.size).toBe(0);
    expect(await getShopLaborForCheckins(service, [])).toEqual(new Map());
  });
});

describe('closeShopShiftsForCheckin', () => {
  it('closes only that check-in’s open shop shifts, marking auto_closed, and is idempotent', async () => {
    const rows = [
      { id: 's1', context: 'shop', fleet_checkin_id: 'v1', ended_at: null, auto_closed: false },
      { id: 's2', context: 'shop', fleet_checkin_id: 'v1', ended_at: '2026-09-07T09:00:00.000Z', auto_closed: false },
      { id: 's3', context: 'shop', fleet_checkin_id: 'v2', ended_at: null, auto_closed: false },
      { id: 's4', context: 'cni', fleet_checkin_id: 'v1', ended_at: null, auto_closed: false },
    ];
    const service = makeFake({ work_shifts: rows });
    expect(await closeShopShiftsForCheckin(service, 'v1')).toBe(1);
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows[0].auto_closed).toBe(true);
    expect(rows[1].auto_closed).toBe(false); // already ended — untouched
    expect(rows[2].ended_at).toBeNull(); // other check-in untouched
    expect(rows[3].ended_at).toBeNull(); // cni context untouched
    expect(await closeShopShiftsForCheckin(makeFake({ work_shifts: rows }), 'v1')).toBe(0);
  });
});
