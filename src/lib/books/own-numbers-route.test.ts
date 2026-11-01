// Books → Own numbers (src/app/api/admin/books/own-numbers, src/lib/books/own-numbers.ts): what the page is told,
// with who took each number and the link to NetSuite, the sales orders and POs made in NetSuite instead from the
// day it went on or the last 30 days while it's off, and a super admin's change to a kind's letters and next
// number, checked and audited. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const PAT = 'a0000000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  roles: ['admin', 'super_admin'],
  switchRow: null as Record<string, unknown> | null,
  series: [] as Array<Record<string, unknown>>,
  numbers: [] as Array<Record<string, any>>,
  outside: [] as Array<Record<string, unknown>>,
  setAnswer: { data: true as unknown, error: null as { message: string } | null },
  failing: new Set<string>(),
  reads: [] as Array<{ table: string; eq: Array<[string, unknown]> }>,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  audits: [] as Array<Record<string, any>>,
}));

vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever h.roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => h.roles.includes(r));
      return booksAllows(access, need) ? { user: { id: PAT }, access } : { error: new Response('Forbidden', { status: 403 }) };
    }),
    requireSuperAdmin: vi.fn(async () => (h.roles.includes('super_admin') ? { user: { id: PAT } } : { error: new Response('Forbidden', { status: 403 }) })),
  };
});
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async (_s: unknown, entry: Record<string, any>) => { h.audits.push(entry); }) }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const read = { table, eq: [] as Array<[string, unknown]> };
      h.reads.push(read);
      const rows = () => {
        if (table === 'books_switches') return h.switchRow ? [h.switchRow] : [];
        if (table === 'own_number_series') return h.series;
        if (table === 'own_numbers') return h.numbers.filter((r) => read.eq.every(([c, v]) => r[c] === v));
        if (table === 'profiles') return [{ id: PAT, full_name: 'Pat Example' }];
        return [];
      };
      const run = () => (h.failing.has(table) ? { data: null, error: { message: `${table} said no` } } : { data: rows(), error: null });
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { read.eq.push([c, v]); return q; },
        in: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
        then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(run()).then(done, failed),
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push([fn, args]);
      if (h.failing.has(fn)) return { data: null, error: { message: `${fn} said no` } };
      if (fn === 'own_numbers_made_outside') return { data: h.outside, error: null };
      if (fn === 'own_number_series_set') return h.setAnswer;
      return { data: null, error: { message: `no ${fn}` } };
    },
  }),
}));

import { GET, POST } from '../../app/api/admin/books/own-numbers/route';

const get = (query = '') => GET(new NextRequest(`https://go.bmgfleet.com/api/admin/books/own-numbers${query}`));
const post = (body: unknown) => POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/own-numbers', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

const SERIES = [
  { doc_type: 'sales_order', prefix: 'SO', next_seq: '10001', changed_by: null, changed_at: null },
  { doc_type: 'purchase_order', prefix: 'PO', next_seq: '10001', changed_by: null, changed_at: null },
  { doc_type: 'invoice', prefix: 'INV', next_seq: '10003', changed_by: PAT, changed_at: '2027-04-01T14:00:00Z' },
  { doc_type: 'credit_memo', prefix: 'CM', next_seq: '10001', changed_by: null, changed_at: null },
];
const NUMBERS = [
  {
    id: 'n2', doc_type: 'invoice', number: 'INV10002', reserved_at: '2027-04-10T15:00:00Z', reserved_by: PAT, status: 'made',
    settled_at: '2027-04-10T15:00:02Z', netsuite_id: '9002', netsuite_number: 'INV2703', note: null, kept_own: true,
  },
  {
    id: 'n1', doc_type: 'sales_order', number: 'SO10001', reserved_at: '2027-04-09T15:00:00Z', reserved_by: null, status: 'refused',
    settled_at: '2027-04-09T15:00:01Z', netsuite_id: null, netsuite_number: null, note: 'Invalid value for the field entity.', kept_own: false,
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-04-15T17:00:00Z'));
  vi.stubEnv('NETSUITE_ACCOUNT_ID', '1234567');
  h.roles = ['admin', 'super_admin'];
  h.switchRow = { is_on: false, changed_at: null };
  h.series = structuredClone(SERIES);
  h.numbers = structuredClone(NUMBERS);
  h.outside = [{ netsuite_id: '1001', doc_type: 'sales_order', tranid: 'SO4412', trandate: '2027-04-12', party: 'Acme Plumbing', created_by_name: 'Jo Example', told_at: null }];
  h.setAnswer = { data: true, error: null };
  h.failing.clear();
  h.reads.length = 0;
  h.rpcs.length = 0;
  h.audits.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('GET', () => {
  it('tells the page each kind, the numbers taken and what was made in NetSuite the last 30 days while off', async () => {
    h.roles = ['cpa'];
    const { status, body } = await answer(await get());
    expect(status).toBe(200);
    expect(body).toMatchObject({ on: false, changedAt: null, kind: null, since: '2027-03-16', offDays: 30, numbersMore: false, outsideMore: false });
    expect(body.series.map((s: any) => s.nextNumber)).toEqual(['SO10001', 'PO10001', 'INV10003', 'CM10001']);
    expect(body.series[2]).toMatchObject({ many: 'Invoices', changedBy: 'Pat Example', changedAt: '2027-04-01T14:00:00Z' });
    expect(body.numbers).toEqual([
      expect.objectContaining({
        number: 'INV10002', one: 'invoice', by: 'Pat Example', standing: 'kept_own', netsuiteNumber: 'INV2703',
        link: 'https://1234567.app.netsuite.com/app/accounting/transactions/custinvc.nl?id=9002',
      }),
      expect.objectContaining({ number: 'SO10001', by: null, standing: 'refused', link: null }),
    ]);
    expect(body.outside).toEqual([{
      netsuiteId: '1001', type: 'sales_order', one: 'sales order', number: 'SO4412', date: '2027-04-12', party: 'Acme Plumbing', by: 'Jo Example',
      told: false, link: 'https://1234567.app.netsuite.com/app/accounting/transactions/salesord.nl?id=1001',
    }]);
    expect(h.rpcs).toEqual([['own_numbers_made_outside', { p_since: '2027-03-16', p_limit: 200 }]]);
  });

  it("lists what was made in NetSuite from the day it went on, Central time, and one kind's numbers when asked", async () => {
    h.switchRow = { is_on: true, changed_at: '2027-04-02T03:00:00Z' };
    const { body } = await answer(await get('?show=invoice'));
    expect(body).toMatchObject({ on: true, changedAt: '2027-04-02T03:00:00Z', kind: 'invoice', since: '2027-04-01' });
    expect(body.numbers.map((n: any) => n.number)).toEqual(['INV10002']);
    expect(h.reads.find((r) => r.table === 'own_numbers')?.eq).toEqual([['doc_type', 'invoice']]);

    h.reads.length = 0;
    expect((await answer(await get('?show=outside'))).body.kind).toBeNull();
    expect(h.reads.find((r) => r.table === 'own_numbers')?.eq).toEqual([]);
  });

  it("is only for super admins, the bookkeeper and the CPA, and says what it couldn't read", async () => {
    h.roles = ['admin'];
    expect((await get()).status).toBe(403);
    h.roles = ['bookkeeper'];
    h.failing.add('own_numbers_made_outside');
    expect(await answer(await get())).toEqual({ status: 500, body: { error: "Couldn't read what was made in NetSuite: own_numbers_made_outside said no" } });
  });
});

describe('POST', () => {
  it("changes a kind's letters and next number, and keeps who changed it from what", async () => {
    const res = await answer(await post({ type: 'invoice', prefix: ' bmg ', next: '20001' }));
    expect(res).toEqual({ status: 200, body: { type: 'invoice', prefix: 'BMG', next: 20001, nextNumber: 'BMG20001' } });
    expect(h.rpcs).toEqual([['own_number_series_set', { p_type: 'invoice', p_prefix: 'BMG', p_next: 20001, p_by: PAT }]]);
    expect(h.audits).toEqual([{
      actorId: PAT, table: 'own_number_series', recordId: 'invoice', action: 'change_own_numbers',
      detail: { type: 'invoice', prefix: 'BMG', next: 20001, was: { prefix: 'INV', next: 10003 } },
    }]);
    // The same letters as before are its own.
    expect((await post({ type: 'invoice', prefix: 'INV', next: 10010 })).status).toBe(200);
  });

  it("refuses what isn't a kind, letters or a next number, and letters another kind has", async () => {
    expect(await answer(await post({ type: 'bill', prefix: 'B', next: 1 }))).toEqual({ status: 400, body: { error: "FleetSuite doesn't number that kind." } });
    expect((await answer(await post({ type: 'invoice', prefix: 'IN1', next: 1 }))).body.error).toBe('The letters are one to six letters, A to Z, like INV.');
    expect((await answer(await post({ type: 'invoice', prefix: 'INV', next: 0 }))).body.error).toBe('The next number is a whole number from 1 to 999,999,999.');
    expect(await answer(await post({ type: 'invoice', prefix: 'so', next: 1 })))
      .toEqual({ status: 400, body: { error: 'Sales orders already use SO. Give each kind its own letters.' } });
    expect((await post({ type: 'invoice', next: 1 })).status).toBe(400);
    expect(h.rpcs).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("says when a kind has no numbers, and what it couldn't change", async () => {
    h.series = h.series.filter((s) => s.doc_type !== 'credit_memo');
    expect(await answer(await post({ type: 'credit_memo', prefix: 'CM', next: 1 }))).toEqual({ status: 404, body: { error: 'FleetSuite has no numbers for credit memos.' } });
    h.setAnswer = { data: false, error: null };
    expect((await post({ type: 'invoice', prefix: 'INV', next: 1 })).status).toBe(404);
    h.setAnswer = { data: null, error: { message: 'deadlock detected' } };
    expect(await answer(await post({ type: 'invoice', prefix: 'INV', next: 1 }))).toEqual({ status: 500, body: { error: "Couldn't change the numbers: deadlock detected" } });
    expect(h.audits).toEqual([]);
  });

  it('is for super admins only', async () => {
    h.roles = ['bookkeeper'];
    expect((await post({ type: 'invoice', prefix: 'INV', next: 1 })).status).toBe(403);
    expect(h.rpcs).toEqual([]);
  });
});
