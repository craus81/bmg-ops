import { describe, it, expect } from 'vitest';
import { loadShopPayrollRate, MIN_POOL_PEOPLE } from './payroll-rates';

type Row = Record<string, any>;
/** Thenable query fake with the filters loadShopPayrollRate uses. */
function makeFake(tables: Record<string, Row[]>) {
  return {
    from: (table: string) => {
      let rows = [...(tables[table] || [])];
      const b: any = {
        select: () => b,
        eq: (c: string, v: any) => { rows = rows.filter(r => r[c] === v); return b; },
        in: (c: string, vs: any[]) => { rows = rows.filter(r => vs.includes(r[c])); return b; },
        gte: (c: string, v: any) => { rows = rows.filter(r => r[c] >= v); return b; },
        gt: (c: string, v: any) => { rows = rows.filter(r => r[c] > v); return b; },
        order: (c: string, o?: { ascending?: boolean }) => {
          if (o?.ascending === false) rows.sort((a, z) => String(z[c]).localeCompare(String(a[c])));
          return b;
        },
        limit: (n: number) => { rows = rows.slice(0, n); return b; },
        range: (f: number, t: number) => { rows = rows.slice(f, t + 1); return b; },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (res: any) => res({ data: rows, error: null }),
      };
      return b;
    },
  } as any;
}

const check = (id: string, end: string, hrs: number, cost: number) =>
  ({ id: `${id}-${end}`, paychex_employee_id: id, period_end: end, regular_hours: hrs, overtime_hours: 0, total_labor_cost: cost });

function world(people: string[]) {
  return {
    payroll_checks: [
      ...people.map(p => check(p, '2026-09-20', 80, 3200)),
      ...people.map(p => check(p, '2026-01-11', 80, 99999)), // outside the 91-day window
      check('zz', '2026-09-20', 80, 99999),                  // not on a shop timer
    ],
    work_shifts: [{ id: 's1', context: 'shop', started_at: '2026-09-10T13:00:00Z' }, { id: 's0', context: 'shop', started_at: '2026-01-02T13:00:00Z' }],
    work_shift_members: [...people.map(p => ({ shift_id: 's1', profile_id: `prof-${p}` })), { shift_id: 's0', profile_id: 'prof-zz' }],
    payroll_employee_links: [...people, 'zz'].map(p => ({ paychex_employee_id: p, profile_id: `prof-${p}` })),
  };
}

describe('loadShopPayrollRate', () => {
  it('pools linked shop-timer people over the window', async () => {
    const r = await loadShopPayrollRate(makeFake(world(['a', 'b', 'c'])));
    expect(r).toEqual({ rate: 40, people: 3, windowStart: '2026-06-21', windowEnd: '2026-09-20' });
  });

  it(`fewer than ${MIN_POOL_PEOPLE} people would expose someone's pay → null`, async () => {
    expect(await loadShopPayrollRate(makeFake(world(['a', 'b'])))).toBeNull();
  });

  it('nothing uploaded → null', async () => {
    expect(await loadShopPayrollRate(makeFake({}))).toBeNull();
  });
});
