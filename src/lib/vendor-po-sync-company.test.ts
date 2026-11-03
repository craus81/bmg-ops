// The company each purchase order is for (migration 511): the vendor PO sync keeps NetSuite's subsidiary for each PO
// on FleetSuite's copy, and poCompanyOf gives it to Parts Mail's bills and Receiving's receipts, asking NetSuite
// when the copy doesn't have it yet. NetSuite and the database are stand-ins. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    /** NetSuite's POs modified since the last sync: header rows as SuiteQL gives them. */
    headers: [] as Record<string, any>[],
    /** Main-line rows: each PO's subsidiary. */
    mains: [] as Record<string, any>[],
    /** Whether NetSuite refuses the subsidiary read. */
    mainsFail: false,
    /** Whether the API's schema doesn't have subsidiary_netsuite_id yet. */
    noColumn: false,
    upserts: [] as Record<string, any>[],
    updates: [] as Array<{ patch: Record<string, any>; eq: [string, unknown][]; is: [string, unknown][] }>,
    updateError: null as { message: string } | null,
  };
  const suiteql = vi.fn(async (sql: string) => {
    if (/tl\.subsidiary AS subsidiary_id/.test(sql)) {
      if (state.mainsFail) throw new Error('SuiteQL: Invalid search query');
      return state.mains;
    }
    if (/FROM transactionline tl/.test(sql)) return [];
    if (/t\.type = 'PurchOrd'/.test(sql)) return state.headers;
    throw new Error(`stand-in can't answer ${sql}`);
  });
  const service = {
    from(table: string) {
      if (table === 'sync_state') {
        const q: any = { select: () => q, eq: () => q, single: async () => ({ data: { last_synced_at: '2026-11-02T20:00:00Z' }, error: null }) };
        return q;
      }
      if (table === 'netsuite_vendor_po_lines') {
        const q: any = {
          delete: () => q, eq: () => q,
          insert: async () => ({ error: null }),
          then: (done: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(done),
        };
        return q;
      }
      if (table !== 'netsuite_vendor_pos') throw new Error(`stand-in has no ${table}`);
      return {
        upsert(row: Record<string, any>) {
          state.upserts.push({ ...row });
          const answer = state.noColumn && 'subsidiary_netsuite_id' in row
            ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'subsidiary_netsuite_id' column of 'netsuite_vendor_pos' in the schema cache" } }
            : { data: { id: `copy-${row.netsuite_id}` }, error: null };
          const q: any = { select: () => q, single: async () => answer };
          return q;
        },
        update(patch: Record<string, any>) {
          const call = { patch, eq: [] as [string, unknown][], is: [] as [string, unknown][] };
          state.updates.push(call);
          const q: any = {
            eq: (col: string, val: unknown) => { call.eq.push([col, val]); return q; },
            is: (col: string, val: unknown) => { call.is.push([col, val]); return q; },
            then: (done: (v: unknown) => unknown) => Promise.resolve({ error: state.updateError }).then(done),
          };
          return q;
        },
      };
    },
  };
  return { state, suiteql, service, heartbeat: vi.fn(async (..._args: unknown[]) => ({ ok: true })) };
});

vi.mock('@/lib/netsuite', () => ({ suiteqlQueryAll: h.suiteql }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: h.heartbeat }));

import { poCompanyOf, subsidiariesByPo, syncVendorPos } from './vendor-po-sync';

const service = h.service as any;
const header = (id: string, tranid: string) => ({
  id, tranid, trandate: '11/2/2026', status: 'B', status_label: 'Pending Receipt', memo: null, total: '412.50', vendor_id: '3001', vendor_name: 'Ranger Design',
});
const subsidiaryReads = () => h.suiteql.mock.calls.map((c) => c[0] as string).filter((sql) => /tl\.subsidiary AS subsidiary_id/.test(sql));

beforeEach(() => {
  Object.assign(h.state, { headers: [], mains: [], mainsFail: false, noColumn: false, upserts: [], updates: [], updateError: null });
  h.suiteql.mockClear();
  h.heartbeat.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('subsidiariesByPo', () => {
  it("takes each PO's subsidiary by its id, and leaves out rows without both", () => {
    const got = subsidiariesByPo([
      { id: '7001', subsidiary_id: '2' },
      { id: ' 7002 ', subsidiary_id: 3 },
      { id: '7003', subsidiary_id: null },
      { id: null, subsidiary_id: '2' },
      { id: '7004', subsidiary_id: 'BMG' },
      { id: '7005; DROP', subsidiary_id: '2' },
    ]);
    expect([...got]).toEqual([['7001', '2'], ['7002', '3']]);
  });
});

describe('the vendor PO sync', () => {
  it("keeps the company each PO is for on its copy, from the PO's main line", async () => {
    h.state.headers = [header('7001', 'PO2290'), header('7002', 'PO2291')];
    h.state.mains = [{ id: '7001', subsidiary_id: '2' }, { id: '7002', subsidiary_id: '3' }];
    const result = await syncVendorPos(service);
    expect(result).toMatchObject({ modified: 2, synced: 2, headerErrors: 0 });
    expect(result.companyError).toBeUndefined();
    expect(h.state.upserts.map((r) => [r.netsuite_id, r.subsidiary_netsuite_id])).toEqual([['7001', '2'], ['7002', '3']]);
    const [sql] = subsidiaryReads();
    expect(sql).toMatch(/JOIN transactionline tl ON tl\.transaction = t\.id AND tl\.mainline = 'T'/);
    expect(sql).toMatch(/t\.type = 'PurchOrd'/);
    expect(sql).toMatch(/t\.lastmodifieddate >= TO_DATE\('11\/1\/2026', 'MM\/DD\/YYYY'\)/);
  });

  it("leaves a copy's company as it is when NetSuite gives none for its PO", async () => {
    h.state.headers = [header('7001', 'PO2290'), header('7002', 'PO2291')];
    h.state.mains = [{ id: '7001', subsidiary_id: '2' }];
    await syncVendorPos(service);
    expect(h.state.upserts[0]).toMatchObject({ netsuite_id: '7001', subsidiary_netsuite_id: '2' });
    expect(h.state.upserts[1]).not.toHaveProperty('subsidiary_netsuite_id');
  });

  it("goes on when NetSuite won't say which company the POs are for, and says so", async () => {
    h.state.headers = [header('7001', 'PO2290')];
    h.state.mainsFail = true;
    const result = await syncVendorPos(service);
    expect(result).toMatchObject({ synced: 1, headerErrors: 0, companyError: 'SuiteQL: Invalid search query' });
    expect(h.state.upserts[0]).not.toHaveProperty('subsidiary_netsuite_id');
    expect(h.heartbeat).toHaveBeenCalledWith(service, 'netsuite_vendor_pos', expect.objectContaining({ companyError: 'SuiteQL: Invalid search query' }));
  });

  it("saves the POs without the company while the API's schema doesn't have its column yet", async () => {
    h.state.headers = [header('7001', 'PO2290'), header('7002', 'PO2291')];
    h.state.mains = [{ id: '7001', subsidiary_id: '2' }, { id: '7002', subsidiary_id: '2' }];
    h.state.noColumn = true;
    const result = await syncVendorPos(service);
    expect(result).toMatchObject({ synced: 2, headerErrors: 0 });
    // The first PO is tried with it once, then without; the second goes without it straight away.
    expect(h.state.upserts.map((r) => [r.netsuite_id, 'subsidiary_netsuite_id' in r])).toEqual([['7001', true], ['7001', false], ['7002', false]]);
  });

  it("doesn't ask NetSuite about companies when no PO changed", async () => {
    const result = await syncVendorPos(service);
    expect(result).toMatchObject({ modified: 0, synced: 0 });
    expect(subsidiaryReads()).toEqual([]);
    expect(h.heartbeat.mock.calls[0][2]).not.toHaveProperty('companyError');
  });
});

describe('poCompanyOf', () => {
  const PO = { id: 'c0000000-0000-4000-8000-000000000001', netsuite_id: '7001' };

  it("gives the company FleetSuite's copy keeps, without asking NetSuite", async () => {
    expect(await poCompanyOf(service, { ...PO, subsidiary_netsuite_id: '3' })).toBe('3');
    expect(h.suiteql).not.toHaveBeenCalled();
    expect(h.state.updates).toEqual([]);
  });

  it("asks NetSuite when the copy doesn't have it yet, and keeps it on the copy only where it's still empty", async () => {
    // Only the asked PO's row counts, whatever else comes back.
    h.state.mains = [{ id: '7002', subsidiary_id: '2' }, { id: '7001', subsidiary_id: '3' }];
    expect(await poCompanyOf(service, { ...PO, subsidiary_netsuite_id: null })).toBe('3');
    const [sql] = subsidiaryReads();
    expect(sql).toMatch(/t\.id = 7001\b/);
    expect(sql).toMatch(/tl\.mainline = 'T'/);
    expect(h.state.updates).toEqual([{
      patch: { subsidiary_netsuite_id: '3' },
      eq: [['id', PO.id]],
      is: [['subsidiary_netsuite_id', null]],
    }]);
  });

  it("gives nothing, and keeps nothing, when NetSuite doesn't say", async () => {
    expect(await poCompanyOf(service, PO)).toBeNull();
    h.state.mains = [{ id: '7002', subsidiary_id: '2' }];
    expect(await poCompanyOf(service, PO)).toBeNull();
    expect(h.suiteql).toHaveBeenCalledTimes(2);
    expect(h.state.updates).toEqual([]);
  });

  it('gives nothing when NetSuite fails, and never throws', async () => {
    h.state.mainsFail = true;
    expect(await poCompanyOf(service, PO)).toBeNull();
    expect(h.state.updates).toEqual([]);
  });

  it("asks NetSuite nothing for a PO id that isn't a bare number", async () => {
    expect(await poCompanyOf(service, { ...PO, netsuite_id: '7001 OR 1=1' })).toBeNull();
    expect(await poCompanyOf(service, { ...PO, netsuite_id: null })).toBeNull();
    expect(await poCompanyOf(service, { ...PO, subsidiary_netsuite_id: 'BMG', netsuite_id: '' })).toBeNull();
    expect(h.suiteql).not.toHaveBeenCalled();
  });

  it("still gives the company when it can't be kept on the copy", async () => {
    h.state.mains = [{ id: '7001', subsidiary_id: '3' }];
    h.state.updateError = { message: "Could not find the 'subsidiary_netsuite_id' column" };
    expect(await poCompanyOf(service, PO)).toBe('3');
    expect(h.state.updates).toHaveLength(1);
  });

  it('keeps nothing without the copy to keep it on', async () => {
    h.state.mains = [{ id: '7001', subsidiary_id: '3' }];
    expect(await poCompanyOf(service, { netsuite_id: 7001 })).toBe('3');
    expect(h.state.updates).toEqual([]);
  });
});
