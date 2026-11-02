// Books → Year end (src/app/api/admin/books/year-end): a made-up company's
// year closing into retained earnings next to NetSuite's, what's done before
// it closes, and closing and reopening it in order (src/lib/books/year-end.ts).
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
      return booksAllows(access, need)
        ? { user: { id: 'u-craig', email: 'craig@example.com' }, profile: { full_name: fullName }, access }
        : { error: new Response('Forbidden', { status: 403 }) };
    }),
  };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET, POST } from '../../app/api/admin/books/year-end/route';
import { PLANNED_LIVE_FROM } from './opening-balances';
import { monthsBetween } from './netsuite-gl';

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let errors: Record<string, { message: string }>;
const rpcs: Array<[string, Record<string, unknown>]> = [];
let audits: Row[];

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });
const ns = (acct: string, month: string | undefined, cents: number) => ({ netsuite_account_id: acct, ...sides(cents), ...(month ? { month } : {}) });
const fs = (acct: string, month: string, cents: number) => ({ account: acct, month, ...sides(cents) });
const account = (id: string, nsId: string, number: string, name: string, type: string) => ({
  id, netsuite_account_id: nsId, number, name, account_type: type,
  statement: type === 'income' || type === 'expense' ? 'income_statement' : 'balance_sheet', parent_id: null, company_id: null,
});

const MONTHS_2027 = monthsBetween('2027-01-01', '2027-12-01');

/**
 * Made-up books for BMG, live from January 2027: 4,000.00 of retained
 * earnings from before, 10,000.00 of sales in March 2027 and April's rent,
 * 2,000.00 in NetSuite's books and 2,100.00 in FleetSuite's.
 */
let netsuiteTotals: { opening: unknown[]; netsuite: unknown[] };
let booksTotals: unknown[];
const BMG_DIFFERENCES = {
  netsuite: [{ month: '2027-04-01', account: '60', kind: 'VendBill', net: '2000.00' }, { month: '2027-04-01', account: '10', kind: 'VendBill', net: '-2000.00' }],
  fleetsuite: [{ month: '2027-04-01', account: '60', kind: 'bill', net: '2100.00' }, { month: '2027-04-01', account: '10', kind: 'bill', net: '-2100.00' }],
  netsuite_kinds: [{ month: '2027-04-01', kind: 'VendBill', documents: 1, moved: '2000.00' }],
  fleetsuite_kinds: [{ month: '2027-04-01', kind: 'bill', documents: 1, moved: '2100.00' }],
};

/** Just enough of supabase-js for the route: filters, a table that fails when told to, audit rows kept. */
function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const result = () => (errors[table]
    ? { data: null, error: errors[table] }
    : { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return q; },
    neq: (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return q; },
    gte: (col: string, v: string) => { filters.push((r) => r[col] >= v); return q; },
    lte: (col: string, v: string) => { filters.push((r) => r[col] <= v); return q; },
    in: (col: string, values: unknown[]) => { filters.push((r) => values.includes(r[col])); return q; },
    range: async (from: number, to: number) => { const r = result(); return { ...r, data: r.data && r.data.slice(from, to + 1) }; },
    maybeSingle: async () => ({ data: null, error: null }),
    insert: async (rows: unknown) => { audits.push(...(Array.isArray(rows) ? rows : [rows]) as Row[]); return { error: null }; },
    then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(result()).then(done, failed),
  };
  return q;
}

/** gl_set_year_status as migration 502 has it: the year's row made if need be, its status set, and the change logged. */
function setYearStatus(args: Record<string, any>) {
  const company = tables.gl_companies.find((c) => c.code === args.p_company)!;
  let row = tables.gl_year_closes.find((y) => y.company_id === company.id && y.year === args.p_year);
  if (!row) {
    row = { company_id: company.id, year: args.p_year };
    tables.gl_year_closes.push(row);
  }
  const at = new Date().toISOString();
  const closing = args.p_status === 'closed';
  Object.assign(row, {
    status: args.p_status,
    closed_at: closing ? at : null,
    closed_by_name: closing ? args.p_actor_name : null,
    net_income_cents: closing ? args.p_net_income_cents : null,
    retained_earnings_cents: closing ? args.p_retained_earnings_cents : null,
  });
  tables.gl_year_close_events.push({
    id: `ye${tables.gl_year_close_events.length + 1}`, company_id: company.id, year: args.p_year, action: closing ? 'closed' : 'reopened',
    actor_name: args.p_actor_name, reason: args.p_reason, net_income_cents: row.net_income_cents, retained_earnings_cents: row.retained_earnings_cents,
    created_at: at,
  });
  return { year: args.p_year, status: args.p_status, closed_at: row.closed_at };
}

const service = {
  from: query,
  rpc: async (name: string, args: Record<string, any>) => {
    rpcs.push([name, args]);
    if (errors[name]) return { data: null, error: errors[name] };
    const bmg = args.p_company === 'BMG';
    if (name === 'gl_netsuite_totals') return { data: bmg ? netsuiteTotals : {}, error: null };
    if (name === 'gl_books_totals') return { data: bmg ? booksTotals : [], error: null };
    if (name === 'gl_books_differences') return { data: bmg ? BMG_DIFFERENCES : {}, error: null };
    if (name === 'gl_set_year_status') return { data: setYearStatus(args), error: null };
    return { data: null, error: { message: `No ${name}` } };
  },
};

const get = async (params = '') => {
  const res = await GET(new NextRequest(`https://go.bmgfleet.com/api/admin/books/year-end${params ? `?${params}` : ''}`));
  return { status: res.status, body: await res.json() };
};
const postRaw = (body: unknown) => POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/year-end', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const post = async (body: unknown) => {
  const res = await postRaw(body);
  return { status: res.status, body: await res.json() };
};
const statusCalls = () => rpcs.filter(([name]) => name === 'gl_set_year_status');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2028-01-20T15:00:00Z'));
  roles = ['admin', 'super_admin'];
  fullName = 'Craig';
  netsuiteTotals = {
    opening: [ns('10', undefined, 400000), ns('39', undefined, -400000)],
    netsuite: [ns('10', '2027-03-01', 1000000), ns('40', '2027-03-01', -1000000), ns('60', '2027-04-01', 200000), ns('10', '2027-04-01', -200000)],
  };
  booksTotals = [fs('10', '2027-03-01', 1000000), fs('40', '2027-03-01', -1000000), fs('60', '2027-04-01', 210000), fs('10', '2027-04-01', -210000)];
  tables = {
    gl_companies: [
      { id: 'c1', code: '1084', name: '1084', books_live_from: null, legal_name: null, netsuite_subsidiary_id: '2' },
      { id: 'c2', code: 'BMG', name: 'BMG', books_live_from: '2027-01-01', legal_name: 'Example Fleet Upfitters LLC', netsuite_subsidiary_id: '1' },
      { id: 'c3', code: 'NEW', name: 'Example New Co', books_live_from: null, legal_name: null, netsuite_subsidiary_id: '4' },
    ],
    gl_accounts: [
      account('a10', '10', '1010', 'First Bank checking', 'bank'),
      account('a39', '39', '3900', 'Retained Earnings', 'equity'),
      account('a40', '40', '4000', 'Sales', 'income'),
      account('a60', '60', '6000', 'Rent', 'expense'),
    ],
    gl_periods: MONTHS_2027.map((month, i) => ({
      id: `p${i + 1}`, company_id: 'c2', period_start: month, status: 'closed', closed_at: '2028-01-10T16:00:00Z', closed_by_name: 'Craig',
    })),
    gl_period_events: [],
    gl_year_closes: [],
    gl_year_close_events: [],
    typed_journal_entries: [
      { id: 'j1', company: 'BMG', tran_date: '2027-12-31', journal: 'cpa_adjustments', status: 'draft' },
      { id: 'j2', company: 'BMG', tran_date: '2027-06-30', journal: 'general', status: 'made' },
    ],
    bank_rec_starts: [{ company: 'BMG', account: '10', first_month: '2027-01-01' }],
    bank_recs: MONTHS_2027.slice(0, 11).map((month) => ({ company: 'BMG', account: '10', month, status: 'done' })),
    sales_tax_returns: MONTHS_2027.map((month) => ({ company: 'BMG', month })),
  };
  errors = {};
  audits = [];
  rpcs.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('Books → Year end', () => {
  it('is for whoever opens the books, and not an admin who does not', async () => {
    roles = ['admin'];
    expect((await GET(new NextRequest('https://go.bmgfleet.com/api/admin/books/year-end'))).status).toBe(403);
    expect((await postRaw({ company: 'BMG', year: 2027, action: 'close', reason: 'x' })).status).toBe(403);
    expect(statusCalls()).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("opens on BMG's last year: what closes into retained earnings both sides, and what's done before it closes", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({
      companies: [{ code: '1084', name: '1084', liveFrom: null }, { code: 'BMG', name: 'BMG', liveFrom: '2027-01-01' }],
      company: 'BMG',
      liveFrom: '2027-01-01',
      plannedLiveFrom: PLANNED_LIVE_FROM,
      today: '2028-01-20',
      years: [2025, 2026, 2027, 2028],
      year: 2027,
      close: {
        account: { key: '39', number: '3900', name: 'Retained Earnings' },
        starting: { fleetsuite: 400000, netsuite: 400000 },
        posted: { fleetsuite: 0, netsuite: 0 },
        netIncome: { fleetsuite: 790000, netsuite: 800000 },
        closed: { fleetsuite: 1190000, netsuite: 1200000 },
      },
      checked: true,
      own: true,
      over: true,
      checks: [
        { key: 'months', state: 'done', detail: 'All 12 months are closed.' },
        { key: 'netsuite', state: 'todo', detail: "1 month doesn't match NetSuite: April.", months: ['2027-04-01'] },
        { key: 'entries', state: 'todo', detail: "1 journal entry dated in 2027 isn't made yet: 1 still a draft, the CPA's." },
        { key: 'bank', state: 'todo', detail: '1010 First Bank checking: 11 of 12 months reconciled.' },
        { key: 'sales_tax', state: 'done', detail: "Every month's return is typed in." },
      ],
      closed: null,
      changedSince: false,
      events: [],
      can: 'close',
    });
    expect(rpcs.map(([name, args]) => [name, args.p_company])).toEqual([
      ['gl_netsuite_totals', 'BMG'], ['gl_books_totals', 'BMG'], ['gl_books_differences', 'BMG'],
    ]);
  });

  it('shows the year and company asked for, else last year and BMG', async () => {
    const y2026 = (await get('year=2026')).body;
    expect(y2026).toMatchObject({ year: 2026, own: false, closed: null, can: null });
    expect(y2026.checks[0]).toEqual({ key: 'months', state: 'none', detail: "2026 is before BMG's books went live, so its months close in NetSuite." });
    for (const asked of ['year=2031', 'year=2024', 'year=abc', 'year=']) expect((await get(asked)).body.year).toBe(2027);
    expect((await get('year=2028')).body).toMatchObject({ year: 2028, over: false, can: null });

    const notLive = (await get('company=1084')).body;
    expect(notLive).toMatchObject({ company: '1084', liveFrom: null, year: 2027, own: false, checked: false, can: null });
    expect(notLive.checks.map((c: any) => [c.key, c.state, c.detail])).toEqual([
      ['months', 'none', "1084's books aren't live yet, so 2027's months close in NetSuite."],
      ['netsuite', 'none', "Nothing's posted in 2027 yet."],
      ['entries', 'done', 'None dated in 2027 is waiting.'],
      ['bank', 'none', "1084's bank accounts aren't reconciled in FleetSuite yet."],
      ['sales_tax', 'none', '1084 makes no sales, so it files no sales tax return.'],
    ]);
    expect((await get('company=XYZ')).body.company).toBe('BMG');
    expect((await get('company=NEW')).body.company).toBe('BMG');
    tables.gl_companies = [];
    expect(await get()).toEqual({ status: 500, body: { error: 'No companies set up' } });
  });

  it("shows NetSuite's side when its copy has the year's movements but no opening balances", async () => {
    netsuiteTotals = { ...netsuiteTotals, opening: [] };
    expect((await get()).body.checked).toBe(true);
    netsuiteTotals = { opening: [], netsuite: [] };
    expect((await get()).body.checked).toBe(false);
  });

  it("names a bank account NetSuite's chart doesn't", async () => {
    tables.bank_rec_starts.push({ company: 'BMG', account: '77', first_month: '2027-06-01' });
    expect((await get()).body.checks[3].detail).toBe('1010 First Bank checking: 11 of 12 months reconciled. NetSuite account 77: 0 of 7 months reconciled.');
  });

  it('says what failed', async () => {
    const said: Record<string, string> = {
      gl_companies: 'gl_companies is down',
      gl_accounts: 'gl_accounts is down',
      gl_netsuite_totals: 'gl_netsuite_totals is down',
      gl_periods: "Couldn't read the months: gl_periods is down",
      gl_books_differences: "Couldn't compare the books with NetSuite: gl_books_differences is down",
      gl_year_closes: "Couldn't read the years closed: gl_year_closes is down",
      gl_year_close_events: "Couldn't read when the years were closed: gl_year_close_events is down",
      typed_journal_entries: "Couldn't read the journal entries: typed_journal_entries is down",
      bank_recs: "Couldn't read what's done before the year closes: bank_recs is down",
      sales_tax_returns: "Couldn't read what's done before the year closes: sales_tax_returns is down",
    };
    for (const [table, error] of Object.entries(said)) {
      errors = { [table]: { message: `${table} is down` } };
      expect([table, await get()]).toEqual([table, { status: 500, body: { error } }]);
      expect([table, (await post({ company: 'BMG', year: 2027, action: 'close', reason: 'Checked' })).body]).toEqual([table, { error }]);
    }
    expect(statusCalls()).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('Books → Year end: closing and reopening', () => {
  it("closes the year, for a reason when anything isn't done, keeps what FleetSuite's books closed it at, and audits it", async () => {
    expect(await post({ company: 'BMG', year: 2027, action: 'close' })).toEqual({
      status: 400, body: { error: "Not everything's done before 2027 closes, so say why it's closed anyway." },
    });
    expect(await post({ company: 'BMG', year: 2027, action: 'close', reason: ' The CPA posts it in NetSuite ' })).toEqual({
      status: 200, body: { company: 'BMG', year: 2027, status: 'closed' },
    });
    expect(statusCalls()).toEqual([['gl_set_year_status', {
      p_company: 'BMG', p_year: 2027, p_status: 'closed', p_actor_id: 'u-craig', p_actor_name: 'Craig', p_reason: 'The CPA posts it in NetSuite',
      p_net_income_cents: 790000, p_retained_earnings_cents: 1190000,
    }]]);
    // No amounts in the audit.
    expect(audits).toEqual([{
      actor_id: 'u-craig', table_name: 'gl_year_closes', record_id: 'BMG 2027', action: 'close_year',
      detail: { company: 'BMG', year: 2027, reason: 'The CPA posts it in NetSuite' },
    }]);
    const body = (await get()).body;
    expect(body).toMatchObject({
      closed: { at: '2028-01-20T15:00:00.000Z', by: 'Craig', netIncome: 790000, retainedEarnings: 1190000 },
      changedSince: false,
      can: 'reopen',
    });
    expect(body.events).toEqual([{
      action: 'closed', by: 'Craig', reason: 'The CPA posts it in NetSuite', at: '2028-01-20T15:00:00.000Z', netIncome: 790000, retainedEarnings: 1190000,
    }]);
    // Closed twice: no.
    expect(await post({ company: 'BMG', year: 2027, action: 'close', reason: 'Again' })).toEqual({ status: 409, body: { error: '2027 is already closed.' } });
  });

  it('closes a year with everything done with no reason, and says who when there is no name', async () => {
    fullName = null;
    booksTotals = [fs('10', '2027-03-01', 1000000), fs('40', '2027-03-01', -1000000), fs('60', '2027-04-01', 200000), fs('10', '2027-04-01', -200000)];
    tables.typed_journal_entries = [];
    tables.bank_recs = MONTHS_2027.map((month) => ({ company: 'BMG', account: '10', month, status: 'done' }));
    // April matches once the books do.
    const matched = { ...BMG_DIFFERENCES, fleetsuite: BMG_DIFFERENCES.netsuite };
    const real = service.rpc;
    service.rpc = async (name, args) => (name === 'gl_books_differences' ? { data: matched, error: null } : real(name, args));
    try {
      expect((await get()).body.checks.map((c: any) => c.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
      expect(await post({ company: 'BMG', year: 2027, action: 'close' })).toEqual({ status: 200, body: { company: 'BMG', year: 2027, status: 'closed' } });
    } finally {
      service.rpc = real;
    }
    expect(statusCalls()[0][1]).toMatchObject({ p_actor_name: 'craig@example.com', p_reason: null, p_net_income_cents: 800000, p_retained_earnings_cents: 1200000 });
    expect(audits[0]).toMatchObject({ action: 'close_year', detail: { company: 'BMG', year: 2027, reason: null } });
  });

  it("says when FleetSuite's books no longer have what a closed year closed at", async () => {
    expect((await post({ company: 'BMG', year: 2027, action: 'close', reason: 'Checked' })).status).toBe(200);
    // A 50.00 expense posted in 2027 after the close, in a month reopened since the year was.
    booksTotals = [...booksTotals, fs('60', '2027-12-01', 5000), fs('10', '2027-12-01', -5000)];
    expect((await get()).body).toMatchObject({
      close: { netIncome: { fleetsuite: 785000 }, closed: { fleetsuite: 1185000 } },
      closed: { netIncome: 790000, retainedEarnings: 1190000 },
      changedSince: true,
    });
  });

  it('reopens the latest year closed, for a reason, and then the year can close again', async () => {
    expect((await post({ company: 'BMG', year: 2027, action: 'close', reason: 'Checked' })).status).toBe(200);
    expect(await post({ company: 'BMG', year: 2027, action: 'reopen' })).toEqual({ status: 400, body: { error: 'Say why 2027 is reopened.' } });
    expect(await post({ company: 'BMG', year: 2027, action: 'reopen', reason: ' A late Grimco bill ' })).toEqual({
      status: 200, body: { company: 'BMG', year: 2027, status: 'open' },
    });
    expect(statusCalls()[1]).toEqual(['gl_set_year_status', {
      p_company: 'BMG', p_year: 2027, p_status: 'open', p_actor_id: 'u-craig', p_actor_name: 'Craig', p_reason: 'A late Grimco bill',
      p_net_income_cents: null, p_retained_earnings_cents: null,
    }]);
    expect(audits[1]).toEqual({
      actor_id: 'u-craig', table_name: 'gl_year_closes', record_id: 'BMG 2027', action: 'reopen_year',
      detail: { company: 'BMG', year: 2027, reason: 'A late Grimco bill' },
    });
    const body = (await get()).body;
    expect(body).toMatchObject({ closed: null, changedSince: false, can: 'close' });
    expect(body.events.map((e: any) => [e.action, e.reason, e.netIncome])).toEqual([['closed', 'Checked', 790000], ['reopened', 'A late Grimco bill', null]]);
  });

  it('lets only a super admin close or reopen a year; the bookkeeper and the CPA see it', async () => {
    roles = ['bookkeeper'];
    expect((await get()).status).toBe(200);
    expect(await post({ company: 'BMG', year: 2027, action: 'close', reason: 'Checked' })).toEqual({
      status: 403, body: { error: 'Only a super admin closes or reopens a year.' },
    });
    roles = ['cpa'];
    expect((await get()).status).toBe(200);
    expect((await postRaw({ company: 'BMG', year: 2027, action: 'close', reason: 'Checked' })).status).toBe(403);
    expect(statusCalls()).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('refuses years out of order, before the books went live, early, and for a company not live or not there', async () => {
    const refused: Array<[Record<string, unknown>, number, string]> = [
      [{ company: 'BMG', year: 2028, action: 'close', reason: 'x' }, 409, 'Close 2027 first: years close in order.'],
      [{ company: 'BMG', year: 2026, action: 'close', reason: 'x' }, 400, "2026 is before BMG's books went live, so it closes in NetSuite."],
      [{ company: 'BMG', year: 2025, action: 'close', reason: 'x' }, 400, "2025 is before BMG's books went live, so it closes in NetSuite."],
      [{ company: '1084', year: 2027, action: 'close', reason: 'x' }, 409, "1084's books aren't live yet, so there's no year to close."],
      [{ company: 'XYZ', year: 2027, action: 'close', reason: 'x' }, 400, "There's no company called XYZ."],
      [{ company: 'NEW', year: 2027, action: 'close', reason: 'x' }, 400, "There's no company called NEW."],
      [{ company: 'BMG', year: 2027, action: 'reopen', reason: 'x' }, 409, "2027 isn't closed."],
    ];
    for (const [body, status, error] of refused) expect([body, await post(body)]).toEqual([body, { status, body: { error } }]);
    // December reopened: the year waits for it.
    tables.gl_periods[11].status = 'open';
    expect(await post({ company: 'BMG', year: 2027, action: 'close', reason: 'x' })).toEqual({
      status: 409, body: { error: 'Close December 2027 first: a year closes once all its months are.' },
    });
    expect(statusCalls()).toEqual([]);
    expect(audits).toEqual([]);
    // With 2027 closed, 2028 waits for its own months, and 2027 for 2028 to reopen first.
    tables.gl_periods[11].status = 'closed';
    expect((await post({ company: 'BMG', year: 2027, action: 'close', reason: 'Checked' })).status).toBe(200);
    expect(await post({ company: 'BMG', year: 2028, action: 'close', reason: 'x' })).toEqual({
      status: 409, body: { error: 'Close January 2028 first: a year closes once all its months are.' },
    });
    tables.gl_year_closes.push({ company_id: 'c2', year: 2028, status: 'closed', closed_at: '2029-01-12T16:00:00Z', closed_by_name: 'Craig', net_income_cents: 0, retained_earnings_cents: 1190000 });
    expect(await post({ company: 'BMG', year: 2027, action: 'reopen', reason: 'A late bill' })).toEqual({
      status: 409, body: { error: 'Reopen 2028 first: years reopen from the latest.' },
    });
  });

  it("turns away a body it can't read", async () => {
    for (const body of [
      { company: 'BMG', year: 2024, action: 'close' },
      { company: 'BMG', year: 2201, action: 'close' },
      { company: 'BMG', year: 2027.5, action: 'close' },
      { company: 'BMG', year: '2027', action: 'close' },
      { company: 'BMG', year: 2027, action: 'lock' },
      { year: 2027, action: 'close' },
      { company: '', year: 2027, action: 'close' },
      { company: 'BMG', year: 2027, action: 'close', reason: 'x'.repeat(501) },
    ]) expect([body, (await post(body)).status]).toEqual([body, 400]);
    expect(rpcs).toEqual([]);
  });

  it("gives the journal's own refusal in its words, and anything else as a failure", async () => {
    errors = { gl_set_year_status: { message: 'gl: December 2027 has to close before 2027 does' } };
    expect(await post({ company: 'BMG', year: 2027, action: 'close', reason: 'Checked' })).toEqual({
      status: 409, body: { error: 'December 2027 has to close before 2027 does' },
    });
    errors = { gl_set_year_status: { message: 'connection reset' } };
    expect(await post({ company: 'BMG', year: 2027, action: 'close', reason: 'Checked' })).toEqual({ status: 500, body: { error: 'connection reset' } });
    expect(audits).toEqual([]);
  });
});
