import { describe, it, expect, vi, beforeEach } from 'vitest';

// The sync talks to NetSuite (SuiteQL) and writes its heartbeat through
// system-health; both are stubbed so the run loop — paging, budget, cursor,
// bulk writes — is exercised against an in-memory NetSuite and mirror.
vi.mock('@/lib/netsuite', () => ({
  suiteqlQuery: vi.fn(),
  suiteqlQueryAll: vi.fn(),
}));
vi.mock('@/lib/system-health', () => ({
  recordHeartbeat: vi.fn(async () => ({ ok: true })),
}));

import { suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat } from '@/lib/system-health';
import {
  classifySoMatch, syncSalesOrders, buildSoHeaderQuery, parseSoSyncResume, SO_PAGE_SIZE,
} from './sales-order-sync';

const suiteql = vi.mocked(suiteqlQuery);
const suiteqlAll = vi.mocked(suiteqlQueryAll);
const heartbeat = vi.mocked(recordHeartbeat);

// SO→estimate matching is the whole point of N3 — pin the precedence and,
// critically, the otherrefnum guard: that field is free text where customer
// PO numbers also live, and a loose match would attach an SO to the wrong
// estimate (the roadmap's named risk).
describe('classifySoMatch', () => {
  it('createdfrom wins over everything', () => {
    expect(classifySoMatch({ createdfrom: '12345', otherrefnum: 'EST-2608-041', memo: 'FleetSuite Estimate #EST-2608-042' }))
      .toEqual({ source: 'createdfrom', nsEstimateId: '12345' });
  });

  it('otherrefnum matches estimate-number shapes, old and new', () => {
    expect(classifySoMatch({ otherrefnum: 'EST-2608-041' }))
      .toEqual({ source: 'otherrefnum', estimateNumber: 'EST-2608-041' });
    expect(classifySoMatch({ otherrefnum: 'est-2608-k3qx' }))
      .toEqual({ source: 'otherrefnum', estimateNumber: 'EST-2608-K3QX' });
  });

  it('otherrefnum REFUSES customer PO numbers (the collision risk)', () => {
    expect(classifySoMatch({ otherrefnum: '4500012345' })).toBeNull();
    expect(classifySoMatch({ otherrefnum: 'PO-88123' })).toBeNull();
    expect(classifySoMatch({ otherrefnum: 'ESTIMATE 41' })).toBeNull();
  });

  it('memo is the weakest signal, only when nothing stronger exists', () => {
    expect(classifySoMatch({ memo: 'Fleet Upfit\nFleetSuite Estimate #EST-2608-041' }))
      .toEqual({ source: 'memo', estimateNumber: 'EST-2608-041' });
    expect(classifySoMatch({ otherrefnum: 'EST-2608-040', memo: 'FleetSuite Estimate #EST-2608-041' }))
      .toEqual({ source: 'otherrefnum', estimateNumber: 'EST-2608-040' });
  });

  it('non-numeric createdfrom falls through instead of matching garbage', () => {
    expect(classifySoMatch({ createdfrom: 'Estimate #EST-1', otherrefnum: 'EST-2608-041' }))
      .toEqual({ source: 'otherrefnum', estimateNumber: 'EST-2608-041' });
  });

  it('returns null when no key matches', () => {
    expect(classifySoMatch({})).toBeNull();
    expect(classifySoMatch({ memo: 'rush job for Acme' })).toBeNull();
  });
});

// ── In-memory NetSuite ────────────────────────────────────────────────────

interface NsLine { line_id: number; item: number; item_number: string; quantity: string; quantitybilled?: string }
interface NsSo {
  id: number; tranid: string; status?: string;
  createdfrom?: string; otherrefnum?: string; memo?: string; lines?: NsLine[];
}

const so = (id: number, extra: Partial<NsSo> = {}): NsSo => ({
  id, tranid: `SO${id}`,
  lines: [{ line_id: id * 10, item: 500, item_number: 'PARENT : PART-A', quantity: '2', quantitybilled: '1' }],
  ...extra,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => so(i + 1));

/** Answers header pages (newest first, honouring `t.id < N` and the limit)
 *  and line queries the way NetSuite would. */
function installNetSuite(sos: NsSo[], opts?: { rejectExtras?: boolean; failOnCall?: number }) {
  let call = 0;
  suiteql.mockImplementation(async (q: string, limit?: number) => {
    call++;
    if (opts?.rejectExtras && q.includes('BUILTIN.DF')) throw new Error('Invalid search query: BUILTIN.DF');
    if (opts?.failOnCall === call) throw new Error('NetSuite SuiteQL error (500): boom');
    const m = q.match(/t\.id < (\d+)/);
    const before = m ? Number(m[1]) : Infinity;
    const items = sos
      .filter(s => s.id < before)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit ?? 1000)
      .map(s => ({
        id: String(s.id), tranid: s.tranid, trandate: '9/1/2026', status: s.status || 'B',
        status_label: q.includes('BUILTIN.DF') ? 'Pending Fulfillment' : undefined,
        memo: s.memo || null, otherrefnum: s.otherrefnum || null, createdfrom: s.createdfrom || null,
        total: '100', customer_id: '7', customer_name: 'Acme Fleet',
      }));
    return { items };
  });
  suiteqlAll.mockImplementation(async (q: string) => {
    const m = q.match(/IN \(([^)]+)\)/);
    const ids = new Set((m ? m[1] : '').split(',').map(x => x.trim()));
    const rows: any[] = [];
    for (const s of sos) {
      if (!ids.has(String(s.id))) continue;
      for (const l of s.lines || []) {
        rows.push({
          so_id: String(s.id), line_id: String(l.line_id), item: String(l.item), item_number: l.item_number,
          description: null, quantity: l.quantity, quantitybilled: l.quantitybilled || '0', rate: null, netamount: null,
        });
      }
    }
    return rows;
  });
}

// ── In-memory mirror (a chainable supabase-js stand-in) ───────────────────

interface Call { method: string; args: any[] }
interface MirrorState {
  syncState?: any;
  estimates?: any[];
  failBulkUpsert?: boolean;
  failRow?: (row: any) => string | null;
}

function fakeService(state: MirrorState) {
  const writes = { headers: [] as any[], lines: [] as any[], deletedSoIds: [] as string[], estimateUpdates: [] as any[] };
  const queries = { estimateOr: [] as string[], estimateIn: [] as any[] };

  const respond = (table: string, calls: Call[]) => {
    const has = (m: string) => calls.find(c => c.method === m);
    if (table === 'sync_state') return { data: state.syncState ?? null, error: null };
    if (table === 'estimates') {
      const update = has('update');
      if (update) {
        writes.estimateUpdates.push({ set: update.args[0], eq: has('eq')?.args, is: has('is')?.args });
        return { data: null, error: null };
      }
      const ests = state.estimates || [];
      const or = has('or');
      const inn = has('in');
      if (or) {
        queries.estimateOr.push(or.args[0]);
        const filter = String(or.args[0]).toUpperCase();
        return { data: ests.filter(e => e.estimate_number && filter.includes(`ILIKE.${String(e.estimate_number).toUpperCase()}`)), error: null };
      }
      if (inn) {
        queries.estimateIn.push(inn.args);
        return { data: ests.filter(e => inn.args[1].includes(e.netsuite_estimate_id)), error: null };
      }
      return { data: [], error: null };
    }
    if (table === 'netsuite_sales_orders') {
      const up = has('upsert')!;
      const bulk = Array.isArray(up.args[0]);
      const rows = bulk ? up.args[0] : [up.args[0]];
      if (bulk && state.failBulkUpsert) return { data: null, error: { message: 'bulk boom' } };
      if (!bulk && state.failRow) {
        const msg = state.failRow(up.args[0]);
        if (msg) return { data: null, error: { message: msg } };
      }
      writes.headers.push(...rows);
      const data = rows.map((r: any) => ({ id: `row-${r.netsuite_id}`, netsuite_id: r.netsuite_id }));
      return { data: bulk ? data : data[0], error: null };
    }
    if (table === 'netsuite_sales_order_lines') {
      if (has('delete')) { writes.deletedSoIds.push(...has('in')!.args[1]); return { data: null, error: null }; }
      if (has('insert')) { writes.lines.push(...has('insert')!.args[0]); return { data: null, error: null }; }
    }
    throw new Error(`unexpected query on ${table}: ${calls.map(c => c.method).join('.')}`);
  };

  const service: any = {
    from(table: string) {
      const calls: Call[] = [];
      const b: any = {};
      for (const m of ['select', 'eq', 'in', 'or', 'is', 'maybeSingle', 'single', 'upsert', 'insert', 'delete', 'update', 'order', 'range', 'not']) {
        b[m] = (...args: any[]) => { calls.push({ method: m, args }); return b; };
      }
      b.then = (resolve: any, reject: any) => Promise.resolve().then(() => respond(table, calls)).then(resolve, reject);
      return b;
    },
  };
  return { service, writes, queries };
}

const far = () => Date.now() + 60_000;

describe('buildSoHeaderQuery', () => {
  it('pages newest first and continues strictly below the cursor', () => {
    expect(buildSoHeaderQuery('2025-01-01T00:00:00Z', null, true)).toContain('ORDER BY t.id DESC');
    expect(buildSoHeaderQuery('2025-01-01T00:00:00Z', null, true)).not.toMatch(/t\.id </);
    expect(buildSoHeaderQuery('2025-01-01T00:00:00Z', '251', true)).toContain('AND t.id < 251');
  });

  it('refuses a non-numeric cursor rather than splicing it into SQL', () => {
    expect(buildSoHeaderQuery('2025-01-01T00:00:00Z', '1 OR 1=1', true)).not.toMatch(/t\.id </);
  });

  it('formats the window date the way SuiteQL wants, in UTC', () => {
    expect(buildSoHeaderQuery('2025-01-01T00:00:00Z', null, true)).toContain("TO_DATE('1/1/2025', 'MM/DD/YYYY')");
    expect(buildSoHeaderQuery('2026-08-31T23:30:00Z', null, true)).toContain("TO_DATE('8/31/2026'");
  });

  it('drops the optional columns on request', () => {
    const q = buildSoHeaderQuery('2025-01-01T00:00:00Z', null, false);
    expect(q).not.toContain('BUILTIN.DF');
    expect(q).not.toContain('custbody_vin_number_');
    expect(q).toContain('t.status,');
  });
});

describe('parseSoSyncResume', () => {
  const good = { windowStartedAt: '2026-09-01T00:00:00.000Z', since: '2025-01-01T00:00:00.000Z', beforeId: '251', processed: 200 };
  it('accepts a cursor this sync wrote', () => {
    expect(parseSoSyncResume({ partial: true, resume: good })).toEqual(good);
  });
  it('ignores anything that is not a complete numeric cursor', () => {
    expect(parseSoSyncResume(null)).toBeNull();
    expect(parseSoSyncResume({ modified: 3 })).toBeNull();
    expect(parseSoSyncResume({ resume: { ...good, beforeId: 'abc' } })).toBeNull();
    expect(parseSoSyncResume({ resume: { ...good, beforeId: 251 } })).toBeNull();
    expect(parseSoSyncResume({ resume: { ...good, since: 'yesterday' } })).toBeNull();
  });
});

describe('syncSalesOrders', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('first run: newest page lands first, the run stops on its budget and saves a cursor without advancing last_synced_at', async () => {
    installNetSuite(many(450));
    const { service, writes } = fakeService({ syncState: null });

    const result = await syncSalesOrders(service, { deadline: Date.now() - 1 });

    expect(result.partial).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.synced).toBe(SO_PAGE_SIZE);
    const ids = writes.headers.map(h => h.netsuite_id);
    expect(ids[0]).toBe('450');
    expect(ids[ids.length - 1]).toBe('251');
    // Fresh window: no cursor clause, and the default first-run start minus a day.
    expect(suiteql.mock.calls[0][0]).not.toMatch(/t\.id </);
    expect(suiteql.mock.calls[0][0]).toContain("TO_DATE('12/31/2024'");

    expect(heartbeat).toHaveBeenCalledTimes(1);
    const [, type, payload, opts] = heartbeat.mock.calls[0];
    expect(type).toBe('netsuite_sales_orders');
    expect(opts).toEqual({ touchLastSyncedAt: false });
    expect(payload).toMatchObject({ partial: true, synced: 200, resume: { beforeId: '251', processed: 200, since: '2024-12-31T00:00:00.000Z' } });
  });

  it('continues a saved window below its cursor and, once drained, advances last_synced_at to when the window OPENED', async () => {
    installNetSuite(many(450));
    const resume = { windowStartedAt: '2026-09-01T00:00:00.000Z', since: '2025-01-01T00:00:00.000Z', beforeId: '251', processed: 200 };
    const { service, writes } = fakeService({
      syncState: { last_synced_at: '2020-01-01T00:00:00Z', last_result: { partial: true, resume } },
    });

    const result = await syncSalesOrders(service, { deadline: far() });

    expect(suiteql.mock.calls[0][0]).toContain('AND t.id < 251');
    expect(suiteql.mock.calls[0][0]).toContain("TO_DATE('1/1/2025'");
    expect(result).toMatchObject({ partial: false, synced: 250, windowProcessed: 450 });
    expect(writes.headers.map(h => h.netsuite_id)).not.toContain('251');
    const [, , payload, opts] = heartbeat.mock.calls[0];
    expect(opts).toEqual({ lastSyncedAt: '2026-09-01T00:00:00.000Z' });
    expect(payload).not.toHaveProperty('resume');
    expect(payload).not.toHaveProperty('partial');
  });

  it('an incremental window starts a day before the last drained one', async () => {
    installNetSuite([]);
    const { service } = fakeService({ syncState: { last_synced_at: '2026-09-01T12:00:00Z', last_result: { modified: 3 } } });
    const before = Date.now();

    const result = await syncSalesOrders(service);

    expect(suiteql.mock.calls[0][0]).toContain("TO_DATE('8/31/2026'");
    expect(result).toMatchObject({ modified: 0, synced: 0, partial: false });
    const [, , , opts] = heartbeat.mock.calls[0];
    expect(Date.parse((opts as any).lastSyncedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('a full resync ignores the cursor and reaches back to 2024', async () => {
    installNetSuite(many(3));
    const resume = { windowStartedAt: '2026-09-01T00:00:00.000Z', since: '2025-01-01T00:00:00.000Z', beforeId: '2', processed: 1 };
    const { service, writes } = fakeService({ syncState: { last_synced_at: '2026-09-01T12:00:00Z', last_result: { partial: true, resume } } });

    await syncSalesOrders(service, { fullResync: true, deadline: far() });

    expect(suiteql.mock.calls[0][0]).toContain("TO_DATE('1/1/2024'");
    expect(suiteql.mock.calls[0][0]).not.toMatch(/t\.id </);
    expect(writes.headers.map(h => h.netsuite_id)).toEqual(['3', '2', '1']);
  });

  it('a NetSuite failure mid-run keeps the cursor and reports the error instead of throwing', async () => {
    installNetSuite(many(450), { failOnCall: 2 });
    const { service } = fakeService({ syncState: null });

    const result = await syncSalesOrders(service, { deadline: far() });

    expect(result.error).toMatch(/boom/);
    expect(result.partial).toBe(false);
    expect(result.synced).toBe(200);
    const [, , payload, opts] = heartbeat.mock.calls[0];
    expect(opts).toEqual({ touchLastSyncedAt: false });
    expect(payload).toMatchObject({ error: expect.stringMatching(/boom/), resume: { beforeId: '251', processed: 200 } });
  });

  it('retries without the optional columns when SuiteQL rejects them, and stays without them for the run', async () => {
    installNetSuite(many(250), { rejectExtras: true });
    const { service, writes } = fakeService({ syncState: null });

    const result = await syncSalesOrders(service, { deadline: far() });

    expect(result.error).toBeUndefined();
    const queries = suiteql.mock.calls.map(c => c[0] as string);
    expect(queries[0]).toContain('BUILTIN.DF');
    expect(queries.slice(1).every(q => !q.includes('BUILTIN.DF'))).toBe(true);
    expect(queries).toHaveLength(3); // rejected, page 1, page 2
    expect(writes.headers).toHaveLength(250);
    expect(writes.headers[0].status_label).toBeNull();
  });

  it('writes lines against the mirror row, item numbers normalized, billed quantity carried', async () => {
    installNetSuite([so(9, {
      lines: [
        { line_id: 91, item: 500, item_number: 'PARENT : PART-A', quantity: '2', quantitybilled: '1' },
        { line_id: 92, item: 501, item_number: 'part-b', quantity: '-3' },
      ],
    })]);
    const { service, writes } = fakeService({ syncState: null });

    await syncSalesOrders(service, { deadline: far() });

    expect(writes.deletedSoIds).toEqual(['row-9']);
    expect(writes.lines).toEqual([
      expect.objectContaining({ so_id: 'row-9', line_id: '91', item_netsuite_id: '500', item_number: 'PART-A', quantity: 2, quantity_billed: 1 }),
      expect.objectContaining({ so_id: 'row-9', line_id: '92', item_netsuite_id: '501', item_number: 'PART-B', quantity: 3, quantity_billed: 0 }),
    ]);
  });

  it('links SOs to estimates with two reads per page and backfills only strong matches onto unlinked estimates', async () => {
    installNetSuite([
      so(1, { otherrefnum: 'EST-2608-041' }),               // strong → link + backfill
      so(2, { memo: 'FleetSuite Estimate #EST-2608-042' }), // weak → link on the mirror only
      so(3, { createdfrom: '777' }),                        // strong, estimate already linked → no backfill
      so(4, { otherrefnum: 'EST-2608-044' }),               // two estimates share the number → no match
      so(5, { otherrefnum: '4500012345' }),                 // customer PO number → no match
    ]);
    const { service, writes, queries } = fakeService({
      syncState: null,
      estimates: [
        { id: 'e41', estimate_number: 'EST-2608-041', netsuite_so_id: null },
        { id: 'e42', estimate_number: 'est-2608-042', netsuite_so_id: null },
        { id: 'e77', netsuite_estimate_id: '777', netsuite_so_id: '999' },
        { id: 'e44a', estimate_number: 'EST-2608-044', netsuite_so_id: null },
        { id: 'e44b', estimate_number: 'EST-2608-044', netsuite_so_id: null },
      ],
    });

    const result = await syncSalesOrders(service, { deadline: far() });

    const byId = new Map(writes.headers.map(h => [h.netsuite_id, h]));
    expect(byId.get('1')).toMatchObject({ estimate_id: 'e41', match_source: 'otherrefnum' });
    expect(byId.get('2')).toMatchObject({ estimate_id: 'e42', match_source: 'memo' });
    expect(byId.get('3')).toMatchObject({ estimate_id: 'e77', match_source: 'createdfrom' });
    expect(byId.get('4')).toMatchObject({ estimate_id: null, match_source: null });
    expect(byId.get('5')).toMatchObject({ estimate_id: null, match_source: null });
    expect(result.matched).toBe(3);
    expect(result.backfilled).toBe(1);
    expect(writes.estimateUpdates).toEqual([
      { set: { netsuite_so_id: '1', netsuite_so_number: 'SO1' }, eq: ['id', 'e41'], is: ['netsuite_so_id', null] },
    ]);
    expect(queries.estimateOr).toHaveLength(1);
    expect(queries.estimateIn).toHaveLength(1);
  });

  it('falls back to one row at a time when the bulk header write fails, and counts what still fails', async () => {
    installNetSuite(many(3));
    const { service, writes } = fakeService({
      syncState: null,
      failBulkUpsert: true,
      failRow: r => (r.netsuite_id === '2' ? 'bad row' : null),
    });

    const result = await syncSalesOrders(service, { deadline: far() });

    expect(result.synced).toBe(2);
    expect(result.headerErrors).toBe(1);
    expect(writes.headers.map(h => h.netsuite_id)).toEqual(['3', '1']);
    expect(writes.lines.map(l => l.so_id)).toEqual(['row-3', 'row-1']);
    const [, , payload] = heartbeat.mock.calls[0];
    expect((payload as any).headerErrorSamples[0]).toMatch(/SO2: bad row/);
  });
});
