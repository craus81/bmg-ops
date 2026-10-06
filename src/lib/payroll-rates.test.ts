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

/** `shop` people are Shop Techs, `gfx` Graphics Production/Installers. */
function world(shop: string[], gfx: string[] = []) {
  const everyone = [...shop, ...gfx];
  return {
    payroll_checks: [
      ...shop.map(p => check(p, '2026-09-20', 80, 3200)),       // $40/hr
      ...gfx.map(p => check(p, '2026-09-20', 80, 2400)),        // $30/hr
      ...everyone.map(p => check(p, '2026-01-11', 80, 99999)),  // outside the 91-day window
      check('mgr', '2026-09-20', 80, 99999),                    // Upfit Management: in no pool
    ],
    payroll_employee_roles: [
      ...shop.map(p => ({ paychex_employee_id: p, role: 'shop_tech' })),
      ...gfx.map((p, i) => ({ paychex_employee_id: p, role: i % 2 ? 'graphics_installer' : 'graphics_production' })),
      { paychex_employee_id: 'mgr', role: 'upfit_management' },
    ],
  };
}

describe('loadShopPayrollRate', () => {
  it('upfit pools Shop Techs only, over the window', async () => {
    const r = await loadShopPayrollRate(makeFake(world(['a', 'b', 'c'], ['x', 'y', 'z'])), 'upfit');
    expect(r).toEqual({ rate: 40, people: 3, windowStart: '2026-06-21', windowEnd: '2026-09-20' });
  });

  it('graphics pools Graphics Production + Installers', async () => {
    const r = await loadShopPayrollRate(makeFake(world(['a', 'b', 'c'], ['x', 'y', 'z'])), 'graphics');
    expect(r?.rate).toBe(30);
    expect(r?.people).toBe(3);
  });

  it(`fewer than ${MIN_POOL_PEOPLE} people would expose someone's pay → null`, async () => {
    expect(await loadShopPayrollRate(makeFake(world(['a', 'b'])), 'upfit')).toBeNull();
  });

  it('nothing uploaded → null', async () => {
    expect(await loadShopPayrollRate(makeFake({}), 'upfit')).toBeNull();
  });
});
