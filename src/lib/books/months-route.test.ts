// Books → Months (src/app/api/admin/books/months): a made-up company's months
// since its books went live, how each compares with NetSuite, and closing and
// reopening them in order (src/lib/books/months.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let roles = ['admin', 'super_admin'];
let fullName: string | null = 'Craig';
vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => roles.includes(r));
      return booksAllows(access, need) ? { ...{ user: { id: 'u-craig', email: 'craig@example.com' }, profile: { full_name: fullName } }, access } : { error: new Response('Forbidden', { status: 403 }) };
    }),
  };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET, POST } from '../../app/api/admin/books/months/route';

const JAN = '2027-01-01';
const FEB = '2027-02-01';
const MAR = '2027-03-01';

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let errors: Record<string, { message: string }>;
const rpcs: Array<[string, Record<string, unknown>]> = [];
let audits: Row[];

/**
 * Made-up books: January's invoices match NetSuite, February's are 10.00 short, and March has only an expense report,
 * a kind FleetSuite doesn't post.
 */
const sides = (month: string, cents: number, kind: string) => [
  { month, account: '120', kind, net: (cents / 100).toFixed(2) },
  { month, account: '400', kind, net: (-cents / 100).toFixed(2) },
];
const kinds = (month: string, cents: number, kind: string) => ({ month, kind, documents: 1, moved: (cents / 100).toFixed(2) });
const BMG_DIFFERENCES = {
  netsuite: [...sides(JAN, 10000, 'CustInvc'), ...sides(FEB, 5000, 'CustInvc'), ...sides(MAR, 3000, 'ExpRept')],
  fleetsuite: [...sides(JAN, 10000, 'invoice'), ...sides(FEB, 4000, 'invoice')],
  netsuite_kinds: [kinds(JAN, 10000, 'CustInvc'), kinds(FEB, 5000, 'CustInvc'), kinds(MAR, 3000, 'ExpRept')],
  fleetsuite_kinds: [kinds(JAN, 10000, 'invoice'), kinds(FEB, 4000, 'invoice')],
};

/** Just enough of supabase-js for the route: equality and list filters, ordering left to the rows' order. */
function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const result = () => (errors[table]
    ? { data: null, error: errors[table] }
    : { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (col: string, value: unknown) => { filters.push((r) => r[col] === value); return q; },
    in: (col: string, values: unknown[]) => { filters.push((r) => values.includes(r[col])); return q; },
    insert: async (rows: unknown) => { audits.push(...(Array.isArray(rows) ? rows : [rows]) as Row[]); return { error: null }; },
    range: async (from: number, to: number) => {
      const r = result();
      return { ...r, data: r.data && r.data.slice(from, to + 1) };
    },
    then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(result()).then(done, failed),
  };
  return q;
}

/** gl_set_period_status as migration 359 has it: the month's row made if need be, its status set, and the change logged. */
function setStatus(args: Record<string, any>) {
  const company = tables.gl_companies.find((c) => c.code === args.p_company)!;
  let period = tables.gl_periods.find((p) => p.company_id === company.id && p.period_start === args.p_month);
  if (!period) {
    period = { id: `p${tables.gl_periods.length + 1}`, company_id: company.id, period_start: args.p_month, status: 'open', closed_at: null, closed_by_name: null };
    tables.gl_periods.push(period);
  }
  const at = new Date().toISOString();
  period.status = args.p_status;
  period.closed_at = args.p_status === 'closed' ? at : null;
  period.closed_by_name = args.p_status === 'closed' ? args.p_actor_name : null;
  tables.gl_period_events.push({
    id: `ev${tables.gl_period_events.length + 1}`, period_id: period.id, action: args.p_status === 'closed' ? 'closed' : 'reopened',
    actor_name: args.p_actor_name, reason: args.p_reason, created_at: at,
  });
  return { id: period.id, period_start: period.period_start, status: period.status };
}

const service = {
  from: query,
  rpc: async (name: string, args: Record<string, any>) => {
    rpcs.push([name, args]);
    if (errors[name]) return { data: null, error: errors[name] };
    if (name === 'gl_books_differences') return { data: args.p_company === 'BMG' ? BMG_DIFFERENCES : {}, error: null };
    if (name === 'gl_set_period_status') return { data: setStatus(args), error: null };
    return { data: null, error: { message: `No ${name}` } };
  },
};

const get = async (params = '') => {
  const res = await GET(new NextRequest(`https://go.bmgfleet.com/api/admin/books/months${params ? `?${params}` : ''}`));
  return { status: res.status, body: await res.json() };
};
const post = async (body: unknown) => {
  const res = await POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/months', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};
const statusCalls = () => rpcs.filter(([name]) => name === 'gl_set_period_status');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-03-15T15:00:00Z'));
  roles = ['admin', 'super_admin'];
  fullName = 'Craig';
  tables = {
    gl_companies: [
      { id: 'c1', code: '1084', name: '1084', books_live_from: null },
      { id: 'c2', code: 'BMG', name: 'BMG', books_live_from: '2027-01-01' },
    ],
    gl_periods: [
      { id: 'p1', company_id: 'c2', period_start: JAN, status: 'closed', closed_at: '2027-02-12T21:04:00Z', closed_by_name: 'Craig' },
      { id: 'p2', company_id: 'c2', period_start: FEB, status: 'open', closed_at: null, closed_by_name: null },
      { id: 'p3', company_id: 'c1', period_start: FEB, status: 'open', closed_at: null, closed_by_name: null },
    ],
    gl_period_events: [
      { id: 'ev1', period_id: 'p1', action: 'closed', actor_name: 'Craig', reason: null, created_at: '2027-02-12T21:04:00Z' },
    ],
  };
  errors = {};
  audits = [];
  rpcs.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('Books → Months', () => {
  it('is for whoever opens the books, and not an admin who does not', async () => {
    roles = ['admin'];
    expect((await GET(new NextRequest('https://go.bmgfleet.com/api/admin/books/months'))).status).toBe(403);
    const res = await POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/months', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company: 'BMG', month: '2027-02', action: 'close', reason: 'x' }),
    }));
    expect(res.status).toBe(403);
    expect(rpcs).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("lists BMG's months since its books went live, newest first, each compared with NetSuite", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({
      companies: [{ code: '1084', name: '1084', liveFrom: null }, { code: 'BMG', name: 'BMG', liveFrom: '2027-01-01' }],
      company: 'BMG',
      liveFrom: '2027-01-01',
      plannedLiveFrom: '2027-01-01',
      today: '2027-03-15',
      months: [
        { month: MAR, over: false, closed: null, compared: { status: 'none', differing: 0, notPosted: true }, events: [], can: null },
        { month: FEB, over: true, closed: null, compared: { status: 'differs', differing: 2, notPosted: false }, events: [], can: 'close' },
        {
          month: JAN, over: true, closed: { at: '2027-02-12T21:04:00Z', by: 'Craig' }, compared: { status: 'matches', differing: 0, notPosted: false },
          events: [{ action: 'closed', by: 'Craig', reason: null, at: '2027-02-12T21:04:00Z' }], can: 'reopen',
        },
      ],
    });
    expect(rpcs).toEqual([['gl_books_differences', { p_company: 'BMG' }]]);
  });

  it('shows the company asked for, else BMG; one not live has no months', async () => {
    const { body } = await get('company=1084');
    expect(body).toMatchObject({ company: '1084', liveFrom: null, months: [] });
    expect((await get('company=XYZ')).body.company).toBe('BMG');
    tables.gl_companies = [];
    expect(await get()).toEqual({ status: 500, body: { error: 'No companies set up' } });
  });

  it('says what failed', async () => {
    const said: Record<string, string> = {
      gl_companies: 'gl_companies is down',
      gl_periods: "Couldn't read the months: gl_periods is down",
      gl_period_events: "Couldn't read when the months were closed: gl_period_events is down",
      gl_books_differences: "Couldn't compare the books with NetSuite: gl_books_differences is down",
    };
    for (const [table, error] of Object.entries(said)) {
      errors = { [table]: { message: `${table} is down` } };
      expect(await get()).toEqual({ status: 500, body: { error } });
      expect((await post({ company: 'BMG', month: '2027-02', action: 'close', reason: 'Checked' })).body).toEqual({ error });
    }
    expect(statusCalls()).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('Books → Months: closing and reopening', () => {
  it("closes the first open month that's over, for a reason when it doesn't match NetSuite, and audits it", async () => {
    expect(await post({ company: 'BMG', month: '2027-02', action: 'close', reason: ' The CPA moved a bill in NetSuite ' })).toEqual({
      status: 200, body: { company: 'BMG', month: FEB, status: 'closed' },
    });
    expect(statusCalls()).toEqual([['gl_set_period_status', {
      p_company: 'BMG', p_month: FEB, p_status: 'closed', p_actor_id: 'u-craig', p_actor_name: 'Craig', p_reason: 'The CPA moved a bill in NetSuite',
    }]]);
    expect(audits).toEqual([{
      actor_id: 'u-craig', table_name: 'gl_periods', record_id: 'p2', action: 'close_month',
      detail: { company: 'BMG', month: FEB, reason: 'The CPA moved a bill in NetSuite' },
    }]);
    // Now February is the one to reopen, and January stays closed under it.
    const months = (await get()).body.months;
    expect(months.map((m: any) => [m.month, m.closed?.by ?? null, m.can])).toEqual([[MAR, null, null], [FEB, 'Craig', 'reopen'], [JAN, 'Craig', null]]);
    expect(months[1].events).toEqual([{ action: 'closed', by: 'Craig', reason: 'The CPA moved a bill in NetSuite', at: '2027-03-15T15:00:00.000Z' }]);
  });

  it('closes a month that matches NetSuite with no reason, and makes its row when nothing has posted to it', async () => {
    tables.gl_periods = [];
    tables.gl_period_events = [];
    expect(await post({ company: 'BMG', month: '2027-01', action: 'close' })).toEqual({ status: 200, body: { company: 'BMG', month: JAN, status: 'closed' } });
    expect(statusCalls()[0][1]).toMatchObject({ p_month: JAN, p_status: 'closed', p_reason: null });
    expect(audits[0]).toMatchObject({ record_id: 'p1', action: 'close_month', detail: { company: 'BMG', month: JAN, reason: null } });
  });

  it("reopens the latest month closed, for a reason, and says who when there's no name", async () => {
    fullName = null;
    expect(await post({ company: 'BMG', month: '2027-01', action: 'reopen', reason: ' A late Grimco bill ' })).toEqual({
      status: 200, body: { company: 'BMG', month: JAN, status: 'open' },
    });
    expect(statusCalls()).toEqual([['gl_set_period_status', {
      p_company: 'BMG', p_month: JAN, p_status: 'open', p_actor_id: 'u-craig', p_actor_name: 'craig@example.com', p_reason: 'A late Grimco bill',
    }]]);
    expect(audits).toEqual([{
      actor_id: 'u-craig', table_name: 'gl_periods', record_id: 'p1', action: 'reopen_month', detail: { company: 'BMG', month: JAN, reason: 'A late Grimco bill' },
    }]);
    const months = (await get()).body.months;
    expect(months.map((m: any) => [m.month, m.closed, m.can])).toEqual([[MAR, null, null], [FEB, null, null], [JAN, null, 'close']]);
    expect(months[2].events.map((e: any) => [e.action, e.by, e.reason])).toEqual([
      ['closed', 'Craig', null], ['reopened', 'craig@example.com', 'A late Grimco bill'],
    ]);
  });

  it('lets the bookkeeper close a month but not reopen one, and the CPA do neither', async () => {
    roles = ['bookkeeper'];
    expect(await post({ company: 'BMG', month: '2027-01', action: 'reopen', reason: 'A late Grimco bill' })).toEqual({
      status: 403, body: { error: 'Only a super admin can reopen a month.' },
    });
    roles = ['cpa'];
    expect((await get()).status).toBe(200);
    const refused = await POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/months', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company: 'BMG', month: '2027-02', action: 'close', reason: 'The CPA moved a bill in NetSuite' }),
    }));
    expect(refused.status).toBe(403);
    expect(statusCalls()).toEqual([]);
    roles = ['bookkeeper'];
    expect(await post({ company: 'BMG', month: '2027-02', action: 'close', reason: 'The CPA moved a bill in NetSuite' })).toEqual({
      status: 200, body: { company: 'BMG', month: FEB, status: 'closed' },
    });
    expect(statusCalls().map(([, args]) => args.p_status)).toEqual(['closed']);
  });

  it('refuses out of order, twice, early, without a reason, and for a company not live or not there', async () => {
    const refused: Array<[Record<string, unknown>, number, string]> = [
      [{ company: 'BMG', month: '2027-02', action: 'close' }, 400, "February 2027 doesn't match NetSuite, so say why it's closed anyway."],
      [{ company: 'BMG', month: '2027-02', action: 'close', reason: '  ' }, 400, "February 2027 doesn't match NetSuite, so say why it's closed anyway."],
      [{ company: 'BMG', month: '2027-03', action: 'close', reason: 'Early' }, 409, "March 2027 isn't over yet."],
      [{ company: 'BMG', month: '2027-01', action: 'close' }, 409, 'January 2027 is already closed.'],
      [{ company: 'BMG', month: '2026-12', action: 'close' }, 400, "December 2026 is before BMG's books went live, so nothing posts to it but the opening entry."],
      [{ company: '1084', month: '2027-02', action: 'close' }, 409, "1084's books aren't live yet, so there's no month to close."],
      [{ company: 'XYZ', month: '2027-02', action: 'close' }, 400, "There's no company called XYZ."],
      [{ company: 'BMG', month: '2027-02', action: 'reopen', reason: 'A late bill' }, 409, "February 2027 isn't closed."],
      [{ company: 'BMG', month: '2027-01', action: 'reopen' }, 400, 'Say why January 2027 is reopened.'],
    ];
    for (const [body, status, error] of refused) expect([body, await post(body)]).toEqual([body, { status, body: { error } }]);
    // March only once it's over, with February closed first.
    vi.setSystemTime(new Date('2027-04-02T15:00:00Z'));
    expect(await post({ company: 'BMG', month: '2027-03', action: 'close' })).toEqual({ status: 409, body: { error: 'Close February 2027 first: months close in order.' } });
    expect(statusCalls()).toEqual([]);
    expect(audits).toEqual([]);
    // And the latest one closed reopens first.
    expect((await post({ company: 'BMG', month: '2027-02', action: 'close', reason: 'Checked' })).status).toBe(200);
    expect(await post({ company: 'BMG', month: '2027-01', action: 'reopen', reason: 'A late bill' })).toEqual({
      status: 409, body: { error: 'Reopen February 2027 first: months reopen from the latest.' },
    });
  });

  it("goes by Central time: February isn't over until midnight in O'Fallon", async () => {
    // 11:30 PM on February 28 in O'Fallon, March 1 in UTC.
    vi.setSystemTime(new Date('2027-03-01T05:30:00Z'));
    expect(await post({ company: 'BMG', month: '2027-02', action: 'close', reason: 'Checked' })).toEqual({ status: 409, body: { error: "February 2027 isn't over yet." } });
    vi.setSystemTime(new Date('2027-03-01T06:30:00Z'));
    expect((await post({ company: 'BMG', month: '2027-02', action: 'close', reason: 'Checked' })).status).toBe(200);
  });

  it("turns away a body it can't read", async () => {
    for (const body of [
      { company: 'BMG', month: '2027-13', action: 'close' },
      { company: 'BMG', month: '2027-2', action: 'close' },
      { company: 'BMG', month: '2027-02-01', action: 'close' },
      { company: 'BMG', month: '2027-02', action: 'lock' },
      { month: '2027-02', action: 'close' },
      { company: 'BMG', month: '2027-02', action: 'close', reason: 'x'.repeat(501) },
    ]) expect((await post(body)).status).toBe(400);
    expect(rpcs).toEqual([]);
  });

  it("gives the journal's own refusal in its words, and anything else as a failure", async () => {
    errors = { gl_set_period_status: { message: 'gl: reopening 2027-01 needs a reason' } };
    expect(await post({ company: 'BMG', month: '2027-01', action: 'reopen', reason: 'A late bill' })).toEqual({
      status: 409, body: { error: 'reopening 2027-01 needs a reason' },
    });
    errors = { gl_set_period_status: { message: 'connection reset' } };
    expect(await post({ company: 'BMG', month: '2027-02', action: 'close', reason: 'Checked' })).toEqual({ status: 500, body: { error: 'connection reset' } });
    expect(audits).toEqual([]);
  });
});
