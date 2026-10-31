// Books → Going live (src/app/api/admin/books/going-live): what it reads for
// a made-up company's books, the month it opens on, the opening entry and
// rehearsal it hands back (src/lib/books/opening-balances.ts), and the tap
// that sets the books live (src/lib/books/going-live.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let superAdmin = true;
vi.mock('@/lib/api-auth', () => ({
  requireSuperAdmin: vi.fn(async () => (superAdmin ? { user: { id: 'u-craig' } } : { error: new Response('Forbidden', { status: 403 }) })),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET, POST } from '../../app/api/admin/books/going-live/route';

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
let syncState: { last_result: unknown; last_synced_at?: string | null; updated_at: string } | null;
let parties: unknown[];
let openingEntries: unknown[];
const rpcs: Array<[string, Record<string, unknown>]> = [];
/** What the route wrote: each update with what it was limited to, and each audit row. */
let updates: Array<{ table: string; values: unknown; eq: Array<[string, unknown]>; is: Array<[string, unknown]> }>;
let audits: unknown[];
/** How many rows an update finds: none when another tap got there first. */
let updatedRows: number;

/** Just enough of supabase-js for the route. */
function query(table: string) {
  const result = () => ({ data: errors[table] ? null : tables[table] ?? [], error: errors[table] ?? null });
  let update: (typeof updates)[number] | null = null;
  const q: any = {
    select: () => (update
      ? { then: (done: (v: unknown) => unknown) => Promise.resolve(errors[`${table}:update`]
        ? { data: null, error: errors[`${table}:update`] }
        : { data: Array.from({ length: updatedRows }, () => ({ id: 'c2' })), error: null }).then(done) }
      : q),
    order: () => q,
    eq: (col: string, value: unknown) => { update?.eq.push([col, value]); return q; },
    is: (col: string, value: unknown) => { update?.is.push([col, value]); return q; },
    update: (values: unknown) => { update = { table, values, eq: [], is: [] }; updates.push(update); return q; },
    insert: async (rows: unknown) => { audits.push(...(Array.isArray(rows) ? rows : [rows])); return { error: null }; },
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
    if (name === 'gl_opening_parties') return { data: { parties }, error: null };
    if (name === 'gl_opening_entries') return { data: { entries: openingEntries }, error: null };
    return { data: null, error: { message: `No ${name}` } };
  },
};

const get = async (params = '') => {
  const res = await GET(new NextRequest(`https://go.bmgfleet.com/api/admin/books/going-live${params ? `?${params}` : ''}`));
  return { status: res.status, body: await res.json() };
};
const post = async (body: unknown) => {
  const res = await POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/going-live', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};
/** The reads every look at the page makes, for one company and the last day of the month it shows. */
const reads = (company: string, through: string) => [
  ['gl_netsuite_totals', { p_company: company }], ['gl_books_totals', { p_company: company }],
  ['gl_opening_parties', { p_company: company, p_through: through }], ['gl_opening_entries', { p_company: company }],
];

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
  syncState = { last_result: {}, last_synced_at: '2026-10-31T07:00:00Z', updated_at: '2026-10-31T07:00:00Z' };
  parties = [];
  openingEntries = [];
  updates = [];
  audits = [];
  updatedRows = 1;
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
      company: 'BMG', liveFrom: null, plannedLiveFrom: '2027-01-01', goLiveFrom: '2026-12-01', month: '2025-12-01', through: '2026-10-01',
      today: '2026-10-31', openingEntries: [], waiting: null,
      lastCopy: { at: '2026-10-31T07:00:00Z', syncedAt: '2026-10-31T07:00:00Z', error: null },
    });
    expect(body.companies).toEqual([{ code: '1084', name: '1084', liveFrom: null }, { code: 'BMG', name: 'BMG', liveFrom: null }]);
    expect(body.months).toHaveLength(22);
    expect([body.months[0], body.months[21]]).toEqual(['2025-01-01', '2026-10-01']);
    expect(rpcs).toEqual(reads('BMG', '2025-12-31'));

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
    // 9 PM on December 31 in O'Fallon, which is January 1 in UTC: the books keep Central time's days.
    vi.setSystemTime(new Date('2027-01-01T03:00:00Z'));
    expect((await get()).body).toMatchObject({ month: '2025-12-01', today: '2026-12-31' });
    vi.setSystemTime(new Date('2027-01-01T06:00:00Z'));
    expect((await get()).body).toMatchObject({ month: '2026-12-01', today: '2027-01-01' });
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
    expect(rpcs).toEqual(reads('1084', '2026-03-31'));
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
    syncState = { last_result: { error: 'NetSuite said no' }, last_synced_at: '2026-10-30T07:00:00Z', updated_at: '2026-10-31T05:00:00Z' };
    expect((await get()).body.lastCopy).toEqual({ at: '2026-10-31T05:00:00Z', syncedAt: '2026-10-30T07:00:00Z', error: 'NetSuite said no' });
    syncState = { last_result: null, updated_at: '2026-10-31T05:00:00Z' };
    expect((await get()).body.lastCopy).toEqual({ at: '2026-10-31T05:00:00Z', syncedAt: null, error: null });
    syncState = null;
    expect((await get()).body.lastCopy).toBeNull();
  });

  it('says what failed', async () => {
    for (const table of ['gl_companies', 'gl_accounts', 'sync_state', 'gl_netsuite_totals', 'gl_books_totals', 'gl_opening_parties', 'gl_opening_entries']) {
      errors = { [table]: { message: `${table} is down` } };
      expect(await get()).toEqual({ status: 500, body: { error: `${table} is down` } });
    }
  });

  it('splits the receivable customer by customer', async () => {
    vi.setSystemTime(new Date('2027-01-20T15:00:00Z'));
    parties = [
      { account: '2', kind: 'customer', party: 'cust-acme', name: 'Acme Fleet', netsuite: '2000.00', fleetsuite: '0.00' },
      { account: '2', kind: 'customer', party: 'cust-bolt', name: 'Bolt Leasing', netsuite: '0.00', fleetsuite: '2000.00' },
    ];
    const { body } = await get();
    expect(rpcs).toEqual(reads('BMG', '2026-12-31'));
    expect(body.entry.lines.map((l: any) => [l.number, l.cents, l.parties?.map((p: any) => [p.name, p.cents])])).toEqual([
      ['1000', -5000, undefined],
      ['1200', 0, [['Acme Fleet', 200000], ['Bolt Leasing', -200000]]],
      ['6000', 5000, undefined],
    ]);
    expect(body.entry).toMatchObject({ debit: 205000, credit: 205000, problems: [] });
  });

  it("once the books are live, lists the opening entries posted and says why the next one waits", async () => {
    vi.setSystemTime(new Date('2027-01-20T15:00:00Z'));
    (tables.gl_companies[1] as any).books_live_from = '2027-01-01';
    syncState = { last_result: {}, last_synced_at: '2027-01-01T05:00:00Z', updated_at: '2027-01-20T14:00:00Z' };
    openingEntries = [{ id: 'e1', entry_no: 812, entry_date: '2026-12-31', memo: 'Opening balances', posted_at: '2027-01-02T08:00:00Z', debit: '50.00', lines: 2, reversed_by: null }];
    const { body } = await get();
    expect(body).toMatchObject({ liveFrom: '2027-01-01', month: '2026-12-01' });
    expect(body.openingEntries).toEqual([
      { id: 'e1', entryNo: 812, date: '2026-12-31', memo: 'Opening balances', postedAt: '2027-01-02T08:00:00Z', debit: 5000, lines: 2, reversedBy: null },
    ]);
    // The rent still differs, and the last whole copy finished at 11 PM on December 31 in O'Fallon.
    expect(body.waiting).toBe("No whole copy of NetSuite's ledger has been made since December 31, 2026 ended.");
    syncState.last_synced_at = '2027-01-20T13:00:00Z';
    expect((await get()).body.waiting).toBeNull();
    // Another month's entry isn't the one the posting run posts.
    syncState.last_synced_at = null;
    expect((await get('month=2026-11')).body.waiting).toBeNull();
  });
});

describe('Going live: the tap', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-12-28T16:00:00Z')); });

  it('is for super admins only', async () => {
    superAdmin = false;
    const res = await POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/going-live', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company: 'BMG', confirm: 'BMG' }),
    }));
    expect(res.status).toBe(403);
    expect(updates).toEqual([]);
  });

  it("sets the company's books live on January 1, 2027, once, and audits it", async () => {
    expect(await post({ company: 'BMG', confirm: ' bmg ' })).toEqual({ status: 200, body: { company: 'BMG', liveFrom: '2027-01-01' } });
    expect(updates).toEqual([{ table: 'gl_companies', values: { books_live_from: '2027-01-01' }, eq: [['id', 'c2']], is: [['books_live_from', null]] }]);
    expect(audits).toEqual([{
      actor_id: 'u-craig', table_name: 'gl_companies', record_id: 'c2', action: 'go_live', detail: { company: 'BMG', live_from: '2027-01-01' },
    }]);
  });

  it('wants the code typed, from December 1, for a company not yet live', async () => {
    expect(await post({ company: 'BMG', confirm: 'yes' })).toEqual({ status: 400, body: { error: 'Type BMG to go live.' } });
    vi.setSystemTime(new Date('2026-12-01T05:30:00Z'));
    expect(await post({ company: 'BMG', confirm: 'BMG' })).toEqual({ status: 400, body: { error: "BMG's books can go live from December 1, 2026." } });
    vi.setSystemTime(new Date('2026-12-28T16:00:00Z'));
    (tables.gl_companies[0] as any).books_live_from = '2027-01-01';
    expect(await post({ company: '1084', confirm: '1084' })).toEqual({ status: 409, body: { error: "1084's books already went live on January 1, 2027." } });
    expect(await post({ company: 'XYZ', confirm: 'XYZ' })).toEqual({ status: 400, body: { error: "There's no company called XYZ." } });
    expect(updates).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("turns away a body it can't read", async () => {
    expect((await post({ company: 'BMG' })).status).toBe(400);
    expect((await post({ company: '', confirm: 'BMG' })).status).toBe(400);
    expect((await post({ company: 'BMG', confirm: 7 })).status).toBe(400);
    expect(updates).toEqual([]);
  });

  it('says so when another tap got there first, or the write fails', async () => {
    updatedRows = 0;
    expect(await post({ company: 'BMG', confirm: 'BMG' })).toEqual({ status: 409, body: { error: "BMG's books have already gone live." } });
    expect(audits).toEqual([]);
    updatedRows = 1;
    errors = { 'gl_companies:update': { message: "gl: BMG went live on 2027-01-01, and that date can't change" } };
    expect(await post({ company: 'BMG', confirm: 'BMG' })).toEqual({
      status: 500, body: { error: "gl: BMG went live on 2027-01-01, and that date can't change" },
    });
    errors = { gl_companies: { message: 'companies are down' } };
    expect(await post({ company: 'BMG', confirm: 'BMG' })).toEqual({ status: 500, body: { error: 'companies are down' } });
    expect(audits).toEqual([]);
  });
});
