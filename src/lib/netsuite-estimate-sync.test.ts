import { describe, it, expect, vi, beforeEach } from 'vitest';

// NetSuite (SuiteQL) and the heartbeat are stubbed so the run loop — paging,
// budget, cursor, bulk writes, the FleetSuite link — runs against an
// in-memory NetSuite and copy, as sales-order-sync.test.ts does.
vi.mock('@/lib/netsuite', () => ({
  suiteqlQuery: vi.fn(),
  suiteqlQueryAll: vi.fn(),
  isSuiteqlError: (err: unknown) => err instanceof Error && typeof (err as any).status === 'number',
}));
vi.mock('@/lib/system-health', () => ({
  recordHeartbeat: vi.fn(async () => ({ ok: true })),
}));
// sales-order-sync pulls these in at import; the estimate copy never calls them.
vi.mock('@/lib/upfit-projects', () => ({ ensureUpfitProjectForSo: vi.fn() }));

import { suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat } from '@/lib/system-health';
import {
  syncNetsuiteEstimates, buildEstimateHeaderQuery, buildEstimateLinesQuery,
  NS_ESTIMATE_PAGE_SIZE, NS_ESTIMATE_SYNC_TYPE,
} from './netsuite-estimate-sync';

const suiteql = vi.mocked(suiteqlQuery);
const suiteqlAll = vi.mocked(suiteqlQueryAll);
const heartbeat = vi.mocked(recordHeartbeat);

interface NsEst { id: number; tranid: string; memo?: string; total?: string }
const est = (id: number, extra: Partial<NsEst> = {}): NsEst => ({ id, tranid: `EST${id}`, ...extra });
const many = (n: number) => Array.from({ length: n }, (_, i) => est(i + 1));

function installNetSuite(ests: NsEst[], opts?: { rejectExtras?: boolean; failOnCall?: number }) {
  let call = 0;
  suiteql.mockImplementation(async (q: string, limit?: number) => {
    call++;
    if (opts?.rejectExtras && q.includes('BUILTIN.DF')) throw Object.assign(new Error('NetSuite SuiteQL error (400): bad column'), { status: 400 });
    if (opts?.failOnCall === call) throw Object.assign(new Error('NetSuite SuiteQL error (500): boom'), { status: 500 });
    const m = q.match(/t\.id < (\d+)/);
    const before = m ? Number(m[1]) : Infinity;
    return {
      items: ests.filter(e => e.id < before).sort((a, b) => b.id - a.id).slice(0, limit ?? 1000).map(e => ({
        id: String(e.id), tranid: e.tranid, trandate: '3/4/2025', status: 'A',
        status_label: q.includes('BUILTIN.DF') ? 'Open' : undefined,
        memo: e.memo || null, otherrefnum: null, total: e.total ?? '-250.50',
        customer_id: '7', customer_name: 'Acme Fleet',
      })),
    };
  });
  suiteqlAll.mockImplementation(async (q: string) => {
    const m = q.match(/IN \(([^)]+)\)/);
    const ids = (m ? m[1] : '').split(',').map(x => x.trim());
    return ids.map(id => ({
      estimate_id: id, line_id: `${id}0`, item: '500', item_number: 'PARENT : rack-a',
      description: 'Rack', quantity: '-2', rate: '100', netamount: '-200',
    }));
  });
}

interface CopyState { syncState?: any; estimates?: any[]; failBulkUpsert?: boolean }

function fakeService(state: CopyState) {
  const writes = { headers: [] as any[], lines: [] as any[], deleted: [] as string[] };
  const respond = (table: string, calls: { method: string; args: any[] }[]) => {
    const has = (m: string) => calls.find(c => c.method === m);
    if (table === 'sync_state') return { data: state.syncState ?? null, error: null };
    if (table === 'estimates') {
      const ids: string[] = has('in')?.args[1] || [];
      return { data: (state.estimates || []).filter(e => ids.includes(e.netsuite_estimate_id)), error: null };
    }
    if (table === 'netsuite_estimates') {
      const up = has('upsert')!;
      const bulk = Array.isArray(up.args[0]);
      if (bulk && state.failBulkUpsert) return { data: null, error: { message: 'bulk boom' } };
      const rows = bulk ? up.args[0] : [up.args[0]];
      writes.headers.push(...rows);
      const data = rows.map((r: any) => ({ id: `row-${r.netsuite_id}`, netsuite_id: r.netsuite_id }));
      return { data: bulk ? data : data[0], error: null };
    }
    if (table === 'netsuite_estimate_lines') {
      if (has('delete')) { writes.deleted.push(...has('in')!.args[1]); return { data: null, error: null }; }
      if (has('insert')) { writes.lines.push(...has('insert')!.args[0]); return { data: null, error: null }; }
    }
    throw new Error(`unexpected query on ${table}: ${calls.map(c => c.method).join('.')}`);
  };
  const service: any = {
    from(table: string) {
      const calls: { method: string; args: any[] }[] = [];
      const b: any = {};
      for (const m of ['select', 'eq', 'in', 'is', 'maybeSingle', 'single', 'upsert', 'insert', 'delete', 'order', 'limit']) {
        b[m] = (...args: any[]) => { calls.push({ method: m, args }); return b; };
      }
      b.then = (resolve: any, reject: any) => Promise.resolve().then(() => respond(table, calls)).then(resolve, reject);
      return b;
    },
  };
  return { service, writes };
}

const far = () => Date.now() + 60_000;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('estimate queries', () => {
  it('reads estimates only, newest first, below the cursor', () => {
    const q = buildEstimateHeaderQuery('2000-01-01T00:00:00Z', '251', ['status_label', 'vin']);
    expect(q).toContain("t.type = 'Estimate'");
    expect(q).toContain('ORDER BY t.id DESC');
    expect(q).toContain('AND t.id < 251');
    expect(q).toContain('BUILTIN.DF(t.status)');
    expect(q).toContain('custbody_vin_number_');
  });

  it('never splices a non-numeric id into SQL', () => {
    expect(buildEstimateHeaderQuery('2025-01-01T00:00:00Z', '1 OR 1=1', [])).not.toMatch(/t\.id </);
    expect(buildEstimateLinesQuery(['12', '1); DROP', '13'])).toContain('IN (12, 13)');
  });
});

describe('syncNetsuiteEstimates', () => {
  it('copies every estimate from the very first on the first run, with lines', async () => {
    installNetSuite([est(526, { memo: 'Orkin Tacoma' }), est(942)]);
    const { service, writes } = fakeService({});
    const r = await syncNetsuiteEstimates(service, { deadline: far() });

    expect(suiteql.mock.calls[0][0]).toContain("TO_DATE('12/31/1999'");
    expect(r).toMatchObject({ modified: 2, synced: 2, lines: 2, partial: false });
    const e526 = writes.headers.find(h => h.tranid === 'EST526');
    expect(e526).toMatchObject({
      netsuite_id: '526', customer_netsuite_id: '7', customer_name: 'Acme Fleet',
      status: 'A', status_label: 'Open', memo: 'Orkin Tacoma', total: 250.5, estimate_id: null,
    });
    expect(writes.lines.find(l => l.ns_estimate_id === 'row-526')).toMatchObject({
      item_number: 'RACK-A', quantity: 2, rate: 100, amount: 200,
    });
    expect(writes.deleted).toEqual(['row-942', 'row-526']);

    // A drained window moves last_synced_at and leaves no cursor.
    const [, type, result, hbOpts] = heartbeat.mock.calls[0];
    expect(type).toBe(NS_ESTIMATE_SYNC_TYPE);
    expect((result as any).resume).toBeUndefined();
    expect(hbOpts?.lastSyncedAt).toBeTruthy();
  });

  it('links a row to the one FleetSuite estimate pushed into it, never to two', async () => {
    installNetSuite([est(10), est(11), est(12)]);
    const { service, writes } = fakeService({
      estimates: [
        { id: 'fs-a', netsuite_estimate_id: '10' },
        { id: 'fs-b', netsuite_estimate_id: '11' },
        { id: 'fs-c', netsuite_estimate_id: '11' },
      ],
    });
    const r = await syncNetsuiteEstimates(service, { deadline: far() });
    expect(r.linked).toBe(1);
    expect(writes.headers.find(h => h.netsuite_id === '10').estimate_id).toBe('fs-a');
    expect(writes.headers.find(h => h.netsuite_id === '11').estimate_id).toBeNull();
    expect(writes.headers.find(h => h.netsuite_id === '12').estimate_id).toBeNull();
  });

  it('stops on its budget and saves where it got to; the next run continues', async () => {
    installNetSuite(many(NS_ESTIMATE_PAGE_SIZE * 2 + 5));
    const first = fakeService({});
    const r1 = await syncNetsuiteEstimates(first.service, { deadline: Date.now() - 1 });
    expect(r1).toMatchObject({ synced: NS_ESTIMATE_PAGE_SIZE, partial: true });
    const [, , saved, savedOpts] = heartbeat.mock.calls[0] as any[];
    expect(saved.resume.beforeId).toBe(String(NS_ESTIMATE_PAGE_SIZE + 6));
    expect(savedOpts.touchLastSyncedAt).toBe(false);

    const second = fakeService({ syncState: { last_synced_at: null, last_result: saved } });
    const r2 = await syncNetsuiteEstimates(second.service, { deadline: far() });
    expect(r2).toMatchObject({ synced: NS_ESTIMATE_PAGE_SIZE + 5, partial: false });
    expect(second.writes.headers.map(h => Number(h.netsuite_id)).sort((a, b) => b - a)[0]).toBe(NS_ESTIMATE_PAGE_SIZE + 5);
  });

  it('runs without the optional columns when NetSuite refuses them', async () => {
    installNetSuite([est(1)], { rejectExtras: true });
    const { service, writes } = fakeService({});
    const r = await syncNetsuiteEstimates(service, { deadline: far() });
    expect(r.synced).toBe(1);
    expect(r.droppedColumns).toEqual(['status_label', 'vin']);
    expect(writes.headers[0].status_label).toBeNull();
  });

  it('falls back to one row at a time when the page upsert fails', async () => {
    installNetSuite([est(1), est(2)]);
    const { service, writes } = fakeService({ failBulkUpsert: true });
    const r = await syncNetsuiteEstimates(service, { deadline: far() });
    expect(r.synced).toBe(2);
    expect(writes.headers).toHaveLength(2);
  });

  it('records a NetSuite failure with the stage it happened in', async () => {
    installNetSuite([est(1)], { rejectExtras: true, failOnCall: 3 });
    const { service } = fakeService({});
    const r = await syncNetsuiteEstimates(service, { deadline: far() });
    expect(r.error).toMatch(/^estimate headers, page 1: NetSuite SuiteQL error \(500\)/);
    expect(r.partial).toBe(false);
  });
});
