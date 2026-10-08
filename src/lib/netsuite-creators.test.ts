import { describe, it, expect, vi, beforeEach } from 'vitest';

const suiteql = vi.fn();
vi.mock('@/lib/netsuite', () => ({ suiteqlQuery: (...a: any[]) => suiteql(...a) }));

import { buildCreatorQuery, syncNetsuiteCreators } from './netsuite-creators';

/** Minimal supabase-js stand-in: one select chain + update chains, recorded. */
function fakeService(unchecked: Record<string, string[]>) {
  const updates: Array<{ table: string; values: any; eq?: string; in?: string[] }> = [];
  const service: any = {
    from(table: string) {
      return {
        select() {
          const chain: any = {
            is: () => chain,
            order: () => chain,
            limit: async () => ({ data: (unchecked[table] || []).map(id => ({ netsuite_id: id })), error: null }),
          };
          return chain;
        },
        update(values: any) {
          return {
            eq: async (_c: string, v: string) => { updates.push({ table, values, eq: v }); return { error: null }; },
            in: async (_c: string, v: string[]) => { updates.push({ table, values, in: v }); return { error: null }; },
          };
        },
      };
    },
  };
  return { service, updates };
}

beforeEach(() => { suiteql.mockReset(); });

describe('buildCreatorQuery', () => {
  it('asks for the display name and drops non-numeric ids', () => {
    const q = buildCreatorQuery(['12', 'x; DROP', '34']);
    expect(q).toContain('BUILTIN.DF(t.createdby) AS created_by_name');
    expect(q).toContain('IN (12, 34)');
  });
});

describe('syncNetsuiteCreators', () => {
  it('names the rows NetSuite answers for and stamps the rest as checked', async () => {
    suiteql.mockResolvedValue({ items: [{ id: '12', created_by_name: 'Sam Lee' }, { id: '34', created_by_name: null }] });
    const { service, updates } = fakeService({ netsuite_sales_orders: ['12', '34'] });
    const res = await syncNetsuiteCreators(service);
    expect(res.salesOrders).toEqual({ checked: 2, named: 1 });
    expect(updates).toContainEqual(expect.objectContaining({ table: 'netsuite_sales_orders', eq: '12', values: expect.objectContaining({ created_by_name: 'Sam Lee' }) }));
    expect(updates).toContainEqual(expect.objectContaining({ table: 'netsuite_sales_orders', in: ['34'] }));
  });

  it('stamps nothing when NetSuite rejects the query, so the next run retries', async () => {
    suiteql.mockImplementation(async () => { throw new Error('NetSuite SuiteQL error (400): Invalid field createdby'); });
    const { service, updates } = fakeService({ netsuite_vendor_pos: ['56'] });
    const res = await syncNetsuiteCreators(service);
    expect(res.purchaseOrders.error).toContain('createdby');
    expect(updates).toHaveLength(0);
  });
});
