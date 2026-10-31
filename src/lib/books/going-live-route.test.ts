// Books → Going live (src/app/api/admin/books/going-live): what it reads for
// a made-up company's books, the month it opens on, and the opening entry
// and rehearsal it hands back (src/lib/books/opening-balances.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let superAdmin = true;
vi.mock('@/lib/api-auth', () => ({
  requireSuperAdmin: vi.fn(async () => (superAdmin ? {} : { error: new Response('Forbidden', { status: 403 }) })),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET } from '../../app/api/admin/books/going-live/route';

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });
const account = (id: string, ns: string | null, number: string, name: string, type: string, company: string | null = null) => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: type === 'income' || type === 'expense' ? 'income_statement' : 'balance_sheet', is_summary: false, company_id: company,
});

/**
 * Made-up books: 5,000.00 in the bank and in retained earnings before 2025;
 * a 2,000.00 upfit invoiced and paid in June 2025; September 2026's rent,
 * which FleetSuite's journal has at 750.00 and NetSuite at 800.00.
 */
const MOVES: Array<[string, string, number]> = [
  ['2', '2025-06-01', 200000], ['6', '2025-06-01', -200000], ['1', '2025-06-01', 200000], ['2', '2025-06-01', -200000],
  ['7', '2026-09-01', 80000], ['1', '2026-09-01', -80000],
];
const OPENING = [{ netsuite_account_id: '1', ...sides(500000) }, { netsuite_account_id: '4', ...sides(-500000) }];
const BOOKS_TOTALS = [
  { account: '2', month: '2025-06-01', ...sides(200000) }, { account: '6', month: '2025-06-01', ...sides(-200000) },
  { account: '1', month: '2025-06-01', ...sides(200000) }, { account: '2', month: '2025-06-01', ...sides(-200000) },
  { account: '7', month: '2026-09-01', ...sides(75000) }, { account: '1', month: '2026-09-01', ...sides(-75000) },
];

/** NetSuite's own totals, and the copy's, which match them. */
let netsuiteMoves: Array<{ netsuite_account_id: string; month: string; debit: string; credit: string }>;
let booksTotals: typeof BOOKS_TOTALS;
let tables: Record<string, unknown[]>;
let errors: Record<string, { message: string }>;
let syncState: { last_result: unknown; updated_at: string } | null;
const rpcs: Array<[string, Record<string, unknown>]> = [];

/** Just enough of supabase-js for the route. */
function query(table: string) {
  const result = () => ({ data: errors[table] ? null : tables[table] ?? [], error: errors[table] ?? null });
  const q: any = {
    select: () => q,
    order: () => q,
    eq: () => q,
    range: async (from: number, to: number) => {
      const r = result();
      return { ...r, data: r.data && r.data.slice(from, to + 1) };
    },
    maybeSingle: async () => ({ data: errors[table] ? null : syncState, error: errors[table] ?? null }),
    then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(result()).then(done, failed),
  };
  return q;
}
const service = {
  from: query,
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push([name, args]);
    if (errors[name]) return { data: null, error: errors[name] };
    if (name === 'gl_netsuite_totals') return { data: { opening: OPENING, netsuite: netsuiteMoves, copied: netsuiteMoves }, error: null };
    if (name === 'gl_books_totals') return { data: booksTotals, error: null };
    return { data: null, error: { message: `No ${name}` } };
  },
};

const get = async (params = '') => {
  const res = await GET(new NextRequest(`https://go.bmgfleet.com/api/admin/books/going-live${params ? `?${params}` : ''}`));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T09:12:00Z'));
  superAdmin = true;
  netsuiteMoves = MOVES.map(([a, month, c]) => ({ netsuite_account_id: a, month, ...sides(c) }));
  booksTotals = [...BOOKS_TOTALS];
  tables = {
    gl_companies: [
      { id: 'c1', code: '1084', name: '1084', books_live_from: null },
      { id: 'c2', code: 'BMG', name: 'BMG', books_live_from: null },
    ],
    gl_accounts: [
      account('a1', '1', '1000', 'Checking', 'bank'),
      account('a2', '2', '1200', 'Receivables', 'accounts_receivable'),
      account('a4', '4', '3200', 'Retained Earnings', 'equity'),
      account('a6', '6', '4010', 'Upfit labor', 'income'),
      account('a7', '7', '6000', 'Rent', 'expense'),
      account('a8', '8', '1500', 'Building', 'fixed_asset', 'c1'),
    ],
  };
  errors = {};
  syncState = { last_result: {}, updated_at: '2026-10-31T07:00:00Z' };
  rpcs.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('Going live', () => {
  it('is for super admins only', async () => {
    superAdmin = false;
    const res = await GET(new NextRequest('https://go.bmgfleet.com/api/admin/books/going-live'));
    expect(res.status).toBe(403);
    expect(rpcs).toEqual([]);
  });

  it("opens on December a year before the live date, until the month before it's over", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      company: 'BMG', liveFrom: null, plannedLiveFrom: '2027-01-01', month: '2025-12-01', through: '2026-10-01', today: '2026-10-31',
      lastCopy: { at: '2026-10-31T07:00:00Z', error: null },
    });
    expect(body.companies).toEqual([{ code: '1084', name: '1084', liveFrom: null }, { code: 'BMG', name: 'BMG', liveFrom: null }]);
    expect(body.months).toHaveLength(22);
    expect([body.months[0], body.months[21]]).toEqual(['2025-01-01', '2026-10-01']);
    expect(rpcs).toEqual([['gl_netsuite_totals', { p_company: 'BMG' }], ['gl_books_totals', { p_company: 'BMG' }]]);

    // On December 31, 2025 FleetSuite's books match NetSuite's: nothing to post.
    expect(body.entry).toEqual({
      company: 'BMG', month: '2025-12-01', date: '2025-12-31', liveFrom: '2026-01-01', lines: [], debit: 0, credit: 0, problems: [],
    });

    // Had they gone live then: September 2026's rent differs by 50.00.
    expect(body.rehearsal).toMatchObject({ through: '2026-10-01', date: '2026-10-31', differing: 2 });
    expect(body.rehearsal.rows.map((r: any) => [r.number, r.fleetsuite, r.netsuite])).toEqual([
      ['1000', 625000, 620000], ['3200', -700000, -700000], ['6000', 75000, 80000],
    ]);
  });

  it("opens on the month before the live date once it's over", async () => {
    vi.setSystemTime(new Date('2027-01-20T15:00:00Z'));
    const { body } = await get();
    expect(body).toMatchObject({ month: '2026-12-01', through: '2027-01-01', today: '2027-01-20' });
    // September's rent is the one difference on December 31, 2026, and the entry takes it up.
    expect(body.entry).toMatchObject({ date: '2026-12-31', liveFrom: '2027-01-01', debit: 5000, credit: 5000, problems: [] });
    expect(body.entry.lines).toEqual([
      { netsuiteAccountId: '1', accountId: 'a1', number: '1000', name: 'Checking', fleetsuite: 625000, netsuite: 620000, cents: -5000 },
      { netsuiteAccountId: '7', accountId: 'a7', number: '6000', name: 'Rent', fleetsuite: 75000, netsuite: 80000, cents: 5000 },
    ]);
    expect(body.rehearsal).toMatchObject({ through: '2027-01-01', date: '2027-01-31', differing: 0 });

    vi.setSystemTime(new Date('2026-12-31T23:00:00Z'));
    expect((await get()).body.month).toBe('2025-12-01');
    // Before the copy has a December, the first month it has.
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
    netsuiteMoves = netsuiteMoves.filter((m) => m.month < '2025-07-01');
    booksTotals = booksTotals.filter((m) => m.month < '2025-07-01');
    expect((await get()).body).toMatchObject({ month: '2025-01-01', through: '2025-06-01' });
  });

  it('takes in a month NetSuite has already posted to', async () => {
    // A reversing entry dated November 1, 2026, the day after today.
    netsuiteMoves.push({ netsuite_account_id: '7', month: '2026-11-01', ...sides(-10000) }, { netsuite_account_id: '1', month: '2026-11-01', ...sides(10000) });
    const { body } = await get();
    expect(body).toMatchObject({ month: '2025-12-01', through: '2026-11-01' });
    expect(body.months).toHaveLength(23);
    expect(body.months[22]).toBe('2026-11-01');
    expect(body.rehearsal).toMatchObject({ through: '2026-11-01', date: '2026-11-30' });
  });

  it("opens on the month before the company's own live date once it has one", async () => {
    (tables.gl_companies[1] as any).books_live_from = '2026-07-01';
    const { body } = await get();
    expect(body).toMatchObject({ liveFrom: '2026-07-01', month: '2026-06-01' });
    expect(body.companies[1]).toEqual({ code: 'BMG', name: 'BMG', liveFrom: '2026-07-01' });
    expect(body.entry).toMatchObject({ date: '2026-06-30', liveFrom: '2026-07-01' });
  });

  it('shows the month asked for, when the copy has it', async () => {
    expect((await get('month=2026-03')).body.month).toBe('2026-03-01');
    expect((await get('month=2025-01')).body.month).toBe('2025-01-01');
    expect((await get('month=2026-10')).body.month).toBe('2026-10-01');
    for (const month of ['2024-12', '2026-11', 'March', '2026-03-01']) expect((await get(`month=${month}`)).body.month).toBe('2025-12-01');
    const { body } = await get('month=2026-10');
    expect(body.entry.problems).toEqual(["October 2026 isn't over yet, so its balances are still changing."]);
    expect(body.rehearsal).toBeNull();
  });

  it('shows the company asked for, else BMG, else the first', async () => {
    const { body } = await get('company=1084&month=2026-03');
    expect(body).toMatchObject({ company: '1084', month: '2026-03-01' });
    expect(rpcs).toEqual([['gl_netsuite_totals', { p_company: '1084' }], ['gl_books_totals', { p_company: '1084' }]]);
    expect((await get('company=XYZ')).body.company).toBe('BMG');
    tables.gl_companies = [tables.gl_companies[0]];
    expect((await get()).body.company).toBe('1084');
    tables.gl_companies = [];
    expect(await get()).toEqual({ status: 500, body: { error: 'No companies set up' } });
  });

  it('knows which company an account is limited to', async () => {
    netsuiteMoves.push({ netsuite_account_id: '8', month: '2025-03-01', ...sides(100000) }, { netsuite_account_id: '1', month: '2025-03-01', ...sides(-100000) });
    const { body } = await get();
    expect(body.entry.problems).toEqual(["1500 Building is only for 1084, but BMG's entry posts a debit of $1,000.00 to it."]);
    expect(body.entry.lines).toContainEqual({ netsuiteAccountId: '8', accountId: 'a8', number: '1500', name: 'Building', fleetsuite: 0, netsuite: 100000, cents: 100000 });
  });

  it("says how the last copy of NetSuite's ledger went", async () => {
    syncState = { last_result: { error: 'NetSuite said no' }, updated_at: '2026-10-31T05:00:00Z' };
    expect((await get()).body.lastCopy).toEqual({ at: '2026-10-31T05:00:00Z', error: 'NetSuite said no' });
    syncState = null;
    expect((await get()).body.lastCopy).toBeNull();
  });

  it('says what failed', async () => {
    for (const table of ['gl_companies', 'gl_accounts', 'sync_state', 'gl_netsuite_totals', 'gl_books_totals']) {
      errors = { [table]: { message: `${table} is down` } };
      expect(await get()).toEqual({ status: 500, body: { error: `${table} is down` } });
    }
  });
});
