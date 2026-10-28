import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ findItems: vi.fn() }));
vi.mock('@/lib/estimate-review-content', () => ({
  snapshotReviewedContent: vi.fn(async () => null),
  clearReviewIfContentChanged: vi.fn(async () => false),
}));

import { removeWrapQuoteFromEstimate } from './wrap-quote-estimate';

type Row = Record<string, any>;

/** Just enough of supabase-js for the remove path: eq/neq/in filters,
 *  select, update and delete on in-memory tables. */
function fakeDb(tables: Record<string, Row[]>) {
  const from = (name: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: 'select' | 'update' | 'delete' = 'select';
    let patch: Row = {};
    const rows = () => (tables[name] ||= []).filter(r => filters.every(f => f(r)));
    const q: any = {
      select: () => q,
      update: (p: Row) => { op = 'update'; patch = p; return q; },
      delete: () => { op = 'delete'; return q; },
      eq: (c: string, v: any) => { filters.push(r => r[c] === v); return q; },
      neq: (c: string, v: any) => { filters.push(r => r[c] !== v); return q; },
      in: (c: string, v: any[]) => { filters.push(r => v.includes(r[c])); return q; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (res: any, rej: any) => {
        const hit = rows();
        if (op === 'update') hit.forEach(r => Object.assign(r, patch));
        if (op === 'delete') tables[name] = tables[name].filter(r => !hit.includes(r));
        return Promise.resolve({ data: hit, error: null }).then(res, rej);
      },
    };
    return q;
  };
  return { from } as any;
}

const est = (id: string, extra: Row = {}) => ({
  id, estimate_number: id.toUpperCase(), tax_rate: 0, tax_exempt: false, labor_rate: 120, labor_hours_override: null,
  customer_approved: false, status: 'draft', netsuite_so_id: null, vehicle_count: 1, discount_type: null, discount_value: null,
  fleet_group_id: null, grand_total: 0, ...extra,
});

describe('removeWrapQuoteFromEstimate', () => {
  it('takes the worksheet\'s lines off, unpins it and recomputes the total', async () => {
    const tables = {
      estimates: [est('e1', { grand_total: 2000 })],
      wrap_quotes: [{ id: 'q1', quote_number: 'WQ-1', estimate_id: 'e1' }],
      estimate_line_items: [
        { id: 1, estimate_id: 'e1', wrap_quote_id: 'q1', quantity: 1, unit_price: 1880, labor_hours: 0 },
        { id: 2, estimate_id: 'e1', wrap_quote_id: null, quantity: 1, unit_price: 100, labor_hours: 0 },
      ],
    };
    const r = await removeWrapQuoteFromEstimate(fakeDb(tables), 'e1', 'q1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, quoteNumber: 'WQ-1', linesRemoved: 1 });
    expect(tables.estimate_line_items.map(l => l.id)).toEqual([2]);
    expect(tables.wrap_quotes[0].estimate_id).toBeNull();
    expect(tables.estimates[0].grand_total).toBe(100);
  });

  it('refuses an approved or converted estimate and leaves everything alone', async () => {
    for (const lock of [{ customer_approved: true }, { netsuite_so_id: '55' }]) {
      const tables = {
        estimates: [est('e1', lock)],
        wrap_quotes: [{ id: 'q1', quote_number: 'WQ-1', estimate_id: 'e1' }],
        estimate_line_items: [{ id: 1, estimate_id: 'e1', wrap_quote_id: 'q1', quantity: 1, unit_price: 5 }],
      };
      const r = await removeWrapQuoteFromEstimate(fakeDb(tables), 'e1', 'q1');
      expect(r.status).toBe(409);
      expect(tables.estimate_line_items).toHaveLength(1);
      expect(tables.wrap_quotes[0].estimate_id).toBe('e1');
    }
  });

  it('refuses a worksheet pinned to another estimate', async () => {
    const tables = { estimates: [est('e1')], wrap_quotes: [{ id: 'q1', quote_number: 'WQ-1', estimate_id: 'e2' }], estimate_line_items: [] };
    const r = await removeWrapQuoteFromEstimate(fakeDb(tables), 'e1', 'q1');
    expect(r.status).toBe(404);
  });

  it('clears open fleet copies and reports locked ones', async () => {
    const tables = {
      estimates: [est('e1', { fleet_group_id: 'g' }), est('e2', { fleet_group_id: 'g' }), est('e3', { fleet_group_id: 'g', customer_approved: true })],
      wrap_quotes: [{ id: 'q1', quote_number: 'WQ-1', estimate_id: 'e1' }],
      estimate_line_items: ['e1', 'e2', 'e3'].map((e, i) => ({ id: i, estimate_id: e, wrap_quote_id: 'q1', quantity: 1, unit_price: 10 })),
    };
    const r = await removeWrapQuoteFromEstimate(fakeDb(tables), 'e1', 'q1');
    expect(r.body.fleet).toEqual({ updated: ['E2'], locked: ['E3'] });
    expect(tables.estimate_line_items.map(l => l.estimate_id)).toEqual(['e3']);
  });
});
