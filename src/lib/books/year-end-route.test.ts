// Books → Year end (src/app/api/admin/books/year-end): a made-up company's
// year closing into retained earnings next to NetSuite's, what's done before
// it closes, closing and reopening it in order (src/lib/books/year-end.ts),
// and its year-end package for the CPA (the download).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';

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
import { GET as DOWNLOAD } from '../../app/api/admin/books/year-end/download/route';
import { PLANNED_LIVE_FROM } from './opening-balances';
import { lastDay, monthAfter } from './bank-reconciliation';
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
 * BMG's First Bank checking reconciled in FleetSuite from January 2027,
 * each statement typed in by Jessie and reconciled by Valarie on the 5th of
 * the month after: 4,000.00 until March's sale cleared, 14,000.00 until
 * April's rent did, then 11,900.00.
 */
const BANK_START = {
  company: 'BMG', account: '10', first_month: '2027-01-01', as_of: '2026-12-31', balance_cents: 400000, outstanding: [],
  updated_by: 'u-valarie', updated_at: '2027-01-05T15:00:00Z',
};
const statement = (month: string) => {
  const at = `${monthAfter(month).slice(0, 8)}05T15:00:00Z`;
  return {
    company: 'BMG', account: '10', month, ends_on: lastDay(month), ending_cents: month < '2027-03-01' ? 400000 : month < '2027-04-01' ? 1400000 : 1190000,
    status: 'done', done_by: 'u-valarie', done_at: at, updated_by: 'u-jessie', updated_at: at,
  };
};
const CLEARED = [
  { company: 'BMG', account: '10', doc: '501', month: '2027-03-01', cents: 1000000 },
  { company: 'BMG', account: '10', doc: '502', month: '2027-04-01', cents: -210000 },
];

/** FleetSuite's journal on BMG's income and expense accounts by division and location, as gl_books_split_totals has it. */
const split = (acct: string, month: string, cents: number) => ({
  account: acct, month, division: 'upfit', location: 'ofallon', netsuite_location: null, ...sides(cents),
});
const BMG_SPLIT = [split('40', '2027-03-01', -1000000), split('60', '2027-04-01', 210000)];

/** BMG's four ladder racks at any month's end, as gl_stock_month_end has them; 1084 has no stock. */
const stockAt = (month: string) => ({
  month,
  rows: [{ company: 'BMG', item_id: '9001', location_id: '11', quantity: '4', value: '400.00' }],
  items: [{ netsuite_id: '9001', name: 'LDR-24', display_name: 'Ladder rack 24 in', active: true }],
  locations: [{ netsuite_id: '11', name: 'Wentzville' }],
  parts: [{
    company: 'BMG', account_id: '19', number: '1200', name: 'Inventory', type: 'other_current_asset',
    ledger_start: '400.00', ledger_moves: '0', items_start: '400.00', items_moves_before: '0', items_moves: '0', netsuite_moves: '0', books_moves: '0',
    moves: [], entries: 0, entries_total: '0', month_entries: 0, month_entries_total: '0', kinds: [], rows: [], usual: true,
  }],
  netsuite_through: [{ company: 'BMG', month }],
});

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

/** BMG's documents in 2027 on each account they moved, as gl_books_account_documents has them: March's sale and April's rent. */
const docOf = (doc: string, netsuite: string, fleetsuite: string, over: Row) => ({
  doc, netsuite, fleetsuite, kind: null, type: null, number: null, month: null, date: null, name: null, memo: null, entry_no: null, entries: 1, ...over,
});
const SALE = { type: 'CashSale', number: 'CS100', month: '2027-03-01', date: '2027-03-10', name: 'Example Fleet Co' };
const RENT = { type: 'VendBill', number: 'B-1001', month: '2027-04-01', date: '2027-04-01', name: 'Example Landlord LLC', memo: 'April rent' };
const BMG_DOCUMENTS: Record<string, Row[]> = {
  10: [docOf('501', '10000.00', '10000.00', SALE), docOf('502', '-2000.00', '-2100.00', RENT)],
  40: [docOf('501', '-10000.00', '-10000.00', SALE)],
  60: [docOf('502', '2000.00', '2100.00', RENT)],
};
function accountDocuments(args: Record<string, any>) {
  const rows = (args.p_company === 'BMG' && BMG_DOCUMENTS[args.p_account]) || [];
  const total = (side: string) => rows.reduce((sum, r) => sum + Number(r[side]), 0).toFixed(2);
  return { documents: rows.length, differing: rows.filter((r) => r.netsuite !== r.fleetsuite).length, netsuite: total('netsuite'), fleetsuite: total('fleetsuite'), rows };
}

/** The CPA's 2027 depreciation for BMG, made in NetSuite on its adjustments journal, as typed_journal_entries keeps it. */
const DEPRECIATION = {
  id: 'j3', company: 'BMG', tran_date: '2027-12-31', journal: 'cpa_adjustments', status: 'made', memo: '2027 depreciation', netsuite_number: 'JE1207',
  lines: [
    { account_netsuite_id: '610', debit_cents: 960000, credit_cents: 0, memo: null },
    { account_netsuite_id: '159', debit_cents: 0, credit_cents: 960000, memo: 'Shop truck' },
  ],
};

/** BMG's customers and vendors at a month's end, as gl_party_balances_through has them: nobody, unless a test says otherwise. */
const NOBODY = { accounts: [], opening: { total: '0', named: '0', complete: true }, parties: [] };
let partyData: Record<string, unknown>;

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
    maybeSingle: async () => { const r = result(); return { data: r.data?.[0] ?? null, error: r.error }; },
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
    if (name === 'gl_books_split_totals') return { data: bmg ? BMG_SPLIT : [], error: null };
    if (name === 'gl_stock_month_end') return { data: stockAt(args.p_month), error: null };
    if (name === 'gl_books_account_documents') return { data: accountDocuments(args), error: null };
    if (name === 'gl_party_balances_through') return { data: bmg ? partyData[args.p_kind] : NOBODY, error: null };
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
    bank_rec_starts: [{ ...BANK_START }],
    bank_recs: MONTHS_2027.slice(0, 11).map(statement),
    bank_rec_ticks: CLEARED.map((t) => ({ ...t })),
    bank_rec_events: [],
    profiles: [{ id: 'u-valarie', full_name: 'Valarie' }, { id: 'u-jessie', full_name: 'Jessie' }],
    sales_tax_returns: MONTHS_2027.map((month) => ({ company: 'BMG', month })),
  };
  partyData = { customer: NOBODY, vendor: NOBODY };
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
        {
          key: 'yearly', state: 'todo',
          detail: "No CPA adjustment dated in December 2027 is made yet. The CPA types the year's depreciation and loan interest on CPA adjustments.",
        },
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
      ['yearly', 'none', "1084's books aren't live yet, so the CPA books 2027's depreciation and loan interest in NetSuite."],
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
    expect((await get()).body.checks[4].detail).toBe('1010 First Bank checking: 11 of 12 months reconciled. NetSuite account 77: 0 of 7 months reconciled.');
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
    // The CPA's year-end entries made, nothing else waiting.
    tables.typed_journal_entries = [DEPRECIATION];
    tables.bank_recs = MONTHS_2027.map(statement);
    // April matches once the books do.
    const matched = { ...BMG_DIFFERENCES, fleetsuite: BMG_DIFFERENCES.netsuite };
    const real = service.rpc;
    service.rpc = async (name, args) => (name === 'gl_books_differences' ? { data: matched, error: null } : real(name, args));
    try {
      expect((await get()).body.checks.map((c: any) => c.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
      // As of today, with December over, its sales tax return is due: without it, closing needs a reason.
      const returns = tables.sales_tax_returns;
      tables.sales_tax_returns = returns.slice(0, 11);
      expect(await post({ company: 'BMG', year: 2027, action: 'close' })).toEqual({
        status: 400, body: { error: "Not everything's done before 2027 closes, so say why it's closed anyway." },
      });
      tables.sales_tax_returns = returns;
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

describe('Books → Year end: the year-end package', () => {
  const download = (params = '') => DOWNLOAD(new NextRequest(`https://go.bmgfleet.com/api/admin/books/year-end/download${params ? `?${params}` : ''}`));
  const sheetsOf = async (res: Response) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
    return wb.worksheets;
  };
  /** A sheet's first column from the top, as Excel holds it. */
  const column = (ws: ExcelJS.Worksheet) => Array.from({ length: ws.rowCount }, (_, i) => {
    const v = ws.getRow(i + 1).getCell(1).value;
    return v && typeof v === 'object' && 'text' in v ? v.text : v ?? null;
  });
  const row = (ws: ExcelJS.Worksheet, first: string) => {
    const at = column(ws).indexOf(first);
    return Array.from({ length: ws.getRow(at + 1).cellCount }, (_, i) => ws.getRow(at + 1).getCell(i + 1).value ?? null);
  };
  const named = (all: ExcelJS.Worksheet[], name: string) => all.find((s) => s.name === name)!;
  /** A line's amounts on a report's sheet, by its label in the second column. */
  const amounts = (ws: ExcelJS.Worksheet, label: string) => {
    for (let r = 1; r <= ws.rowCount; r += 1) {
      const cells = Array.from({ length: ws.getRow(r).cellCount }, (_, i) => ws.getRow(r).getCell(i + 1).value ?? null);
      if (cells[1] === label) return cells.slice(2);
    }
    throw new Error(`no ${label} on ${ws.name}`);
  };
  /** The notes above a sheet's table: the rows after its download time, up to the blank row over the header. */
  const notesOf = (ws: ExcelJS.Worksheet) => {
    const col = column(ws);
    return col.slice(5, col.indexOf(null, 5));
  };
  /** The rows under a sheet's header, the first `width` cells of each, as Excel holds them. */
  const under = (ws: ExcelJS.Worksheet, header: string, width: number) => {
    const at = column(ws).indexOf(header) + 1;
    return Array.from({ length: ws.rowCount - at }, (_, i) => Array.from({ length: width }, (_, c) => ws.getRow(at + 1 + i).getCell(c + 1).value ?? null));
  };
  const documentReads = () => rpcs.filter(([name]) => name === 'gl_books_account_documents');
  /** The general ledger's reads, from January of the year; the bank reconciliations read from where FleetSuite's books start. */
  const ledgerReads = (january: string) => documentReads().filter(([, args]) => args.p_from === january);
  const NOT_POSTED = "Nothing has posted to FleetSuite's books yet.";

  it("gives BMG's last year as one Excel file: its reports at December 31, how it closes, its ledger, its stock and what's done before it closes", async () => {
    const res = await download();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers.get('content-disposition')).toContain('filename="BMG Year-end package 2027.xlsx"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const all = await sheetsOf(res);
    expect(all.map((s) => s.name)).toEqual([
      'Contents', 'Trial Balance', 'Balance Sheet', 'Profit and Loss', 'Profit and Loss by Month', 'Statement of Cash Flows',
      'Retained Earnings', 'General Ledger', 'Customer Balances', 'Vendor Balances', 'Bank Reconciliations', 'Bank Reconciliations by Month',
      'Inventory value', 'Inventory ties to accounts', 'CPA Adjustments',
    ]);
    const contents = column(all[0]);
    expect(contents.slice(0, 3)).toEqual(['Example Fleet Upfitters LLC', 'Year-end package 2027', 'January 1, 2027 to December 31, 2027']);
    // What's done before it closes, as the page has it.
    expect(contents.slice(-6)).toEqual([
      'Months closed: Done', 'Matches NetSuite: Not yet', 'Journal entries: Not yet', "CPA's yearly entries: Not yet", 'Bank reconciliations: Not yet',
      'Sales tax returns: Done',
    ]);
    expect(row(all[0], 'Bank reconciliations: Not yet')).toEqual(['Bank reconciliations: Not yet', '1010 First Bank checking: 11 of 12 months reconciled.']);
    // Nothing about the year to say, only what Reports says.
    expect(column(named(all, 'Trial Balance')).slice(1, 6)).toEqual([
      'Trial Balance', 'As of December 31, 2027', expect.any(String), 'Downloaded January 20, 2028 at 9:00 AM Central.', NOT_POSTED,
    ]);
    expect(row(named(all, 'Profit and Loss'), '4000')).toEqual(['4000', 'Sales', 10000, 10000, 0]);
    // The trial balance and balance sheet at December 31, the cash flows for the whole year.
    expect(amounts(named(all, 'Trial Balance'), 'First Bank checking')).toEqual([11900, null, 12000, null, -100]);
    expect(amounts(named(all, 'Balance Sheet'), 'First Bank checking')).toEqual([11900, 12000, -100]);
    expect(amounts(named(all, 'Statement of Cash Flows'), 'Cash at the beginning of the period')).toEqual([4000, 4000, 0]);
    expect(amounts(named(all, 'Statement of Cash Flows'), 'Net change in cash for the period')).toEqual([7900, 8000, -100]);
    expect(row(named(all, 'Retained Earnings'), 'Retained earnings once 2027 closes, January 1, 2028')).toEqual([
      'Retained earnings once 2027 closes, January 1, 2028', 11900, 12000, -100,
    ]);
    // The builder's split, by month, comes to Reports: no red note.
    expect(column(named(all, 'Profit and Loss by Month'))[5]).toBe(NOT_POSTED);
    expect(row(named(all, 'Profit and Loss by Month'), '4000').slice(4, 5)).toEqual([10000]);
    expect(row(named(all, 'Inventory value'), 'LDR-24')).toEqual(['LDR-24', 'Ladder rack 24 in', 'Wentzville', 4, 100, 400]);
    expect(rpcs.filter(([name]) => name === 'gl_books_split_totals' || name === 'gl_stock_month_end')).toEqual([
      ['gl_books_split_totals', { p_company: 'BMG' }], ['gl_stock_month_end', { p_month: '2027-12-01', p_limit: 100 }],
    ]);
    // The general ledger: every account from where it stood when 2027 began, through each document, to its line on the trial balance.
    const ledger = named(all, 'General Ledger');
    expect(notesOf(ledger)).toEqual([NOT_POSTED]);
    const bank = '1010 First Bank checking';
    const march = new Date('2027-03-10T00:00:00Z');
    const april = new Date('2027-04-01T00:00:00Z');
    expect(under(ledger, 'Account', 12)).toEqual([
      [bank, null, 'Balance at the end of December 2026', null, null, null, null, null, 0, 4000, 4000, null],
      [bank, march, 'Cash Sale', 'CS100', 'Example Fleet Co', null, 10000, 10000, 0, 14000, 14000, null],
      [bank, april, 'Bill', 'B-1001', 'Example Landlord LLC', 'April rent', -2100, -2000, -100, 11900, 12000, null],
      [bank, null, 'Balance at the end of December 2027', null, null, null, null, null, -100, 11900, 12000, null],
      ['3900 Retained Earnings', null, 'Balance at the end of December 2026', null, null, null, null, null, 0, -4000, -4000, null],
      ['3900 Retained Earnings', null, 'Balance at the end of December 2027', null, null, null, null, null, 0, -4000, -4000, null],
      ['4000 Sales', march, 'Cash Sale', 'CS100', 'Example Fleet Co', null, -10000, -10000, 0, -10000, -10000, null],
      ['4000 Sales', null, 'Total, January to December 2027', null, null, null, null, null, 0, -10000, -10000, null],
      ['6000 Rent', april, 'Bill', 'B-1001', 'Example Landlord LLC', 'April rent', 2100, 2000, 100, 2100, 2000, null],
      ['6000 Rent', null, 'Total, January to December 2027', null, null, null, null, null, 100, 2100, 2000, null],
    ]);
    // Documents read only for the accounts that moved, over the year, as each account's own download reads them.
    expect(ledgerReads('2027-01-01')).toEqual(['10', '40', '60'].map((acct) => ['gl_books_account_documents', {
      p_company: 'BMG', p_account: acct, p_from: '2027-01-01', p_to: '2027-12-01', p_differs: false, p_limit: 20000,
    }]));
    // No customer or vendor had a balance, and the chart has no receivable or payable account.
    expect(under(named(all, 'Customer Balances'), 'Customer', 2)).toEqual([
      ['No customer had a balance at December 31, 2027.', null],
      ['Every customer', 0],
      ['On the trial balance: no receivable account in the chart', 0],
      ['Every customer less the trial balance', 0],
    ]);
    expect(notesOf(named(all, 'Vendor Balances'))).toEqual([NOT_POSTED]);
    // No fixed asset or loan account in the chart, so no sheet for them; the CPA's draft isn't made, so nothing is listed.
    const cpa = named(all, 'CPA Adjustments');
    expect(notesOf(cpa)).toEqual(["1 of the CPA's adjustments dated in 2027 isn't made yet, so it isn't here."]);
    expect(under(cpa, 'Date', 3)).toEqual([[null, null, 'No CPA adjustment dated in 2027 is made yet.']]);
  });

  it("rolls BMG's fixed assets and loans forward over the year and lists the CPA's adjustments made, each line's account as the chart names it", async () => {
    tables.gl_accounts.push(
      account('a150', '150', '1500', 'Shop truck', 'fixed_asset'),
      account('a159', '159', '1590', 'Accumulated depreciation', 'fixed_asset'),
      account('a270', '270', '2700', 'Truck loan', 'long_term_liability'),
      account('a610', '610', '6100', 'Depreciation', 'expense'),
    );
    // A 5,000.00 lift gate put on the shop truck in June on the truck loan, then December's depreciation, both sides.
    const moves = (side: typeof ns | typeof fs) => [
      side('150', '2027-06-01', 500000), side('270', '2027-06-01', -500000), side('159', '2027-12-01', -960000), side('610', '2027-12-01', 960000),
    ];
    netsuiteTotals = {
      opening: [ns('10', undefined, 700000), ns('39', undefined, -400000), ns('150', undefined, 4500000), ns('159', undefined, -1800000), ns('270', undefined, -3000000)],
      netsuite: [...netsuiteTotals.netsuite, ...moves(ns)],
    };
    booksTotals = [...booksTotals, ...moves(fs)];
    // The CPA's depreciation made, next year's, and a general entry still a draft, which the CPA's sheet doesn't count.
    tables.typed_journal_entries.push(
      DEPRECIATION, { ...DEPRECIATION, id: 'j4', tran_date: '2028-12-31', memo: '2028 depreciation' },
      { id: 'j5', company: 'BMG', tran_date: '2027-03-31', journal: 'general', status: 'draft' },
    );
    const all = await sheetsOf(await download());
    expect(all.map((s) => s.name).slice(-3)).toEqual(['Inventory ties to accounts', 'Fixed Assets and Loans', 'CPA Adjustments']);
    expect(row(all[0], "CPA's yearly entries: Done")).toEqual(["CPA's yearly entries: Done", '1 CPA adjustment dated in December 2027 is made.']);

    const assets = named(all, 'Fixed Assets and Loans');
    expect(column(assets).slice(1, 3)).toEqual(['Fixed Assets and Loans', 'January 1, 2027 to December 31, 2027']);
    expect(notesOf(assets)).toEqual([NOT_POSTED]);
    const none = [null, null, null, null, null, null];
    expect(under(assets, 'Account', 7)).toEqual([
      ['Fixed assets', ...none],
      ['1500 Shop truck', 45000, 5000, 0, 50000, 50000, 0],
      ['1590 Accumulated depreciation', -18000, 0, 9600, -27600, -27600, 0],
      ['Total fixed assets', 27000, 5000, 9600, 22400, 22400, 0],
      [null, ...none],
      ['Long term liabilities', ...none],
      ['2700 Truck loan', 30000, 0, 5000, 35000, 35000, 0],
      ['Total long term liabilities', 30000, 0, 5000, 35000, 35000, 0],
    ]);
    // Each part comes to the balance sheet's.
    expect(amounts(named(all, 'Balance Sheet'), 'Total fixed assets')).toEqual([22400, 22400, 0]);
    expect(amounts(named(all, 'Balance Sheet'), 'Total long term liabilities')).toEqual([35000, 35000, 0]);

    const cpa = named(all, 'CPA Adjustments');
    expect(notesOf(cpa)).toEqual(["1 of the CPA's adjustments dated in 2027 isn't made yet, so it isn't here."]);
    const december = new Date('2027-12-31T00:00:00Z');
    expect(under(cpa, 'Date', 7)).toEqual([
      [december, 'JE1207', '2027 depreciation', '6100 Depreciation', null, 9600, null],
      [december, 'JE1207', '2027 depreciation', '1590 Accumulated depreciation', 'Shop truck', null, 9600],
      [null, null, 'Total, 1 CPA adjustment', null, null, 9600, 9600],
    ]);
  });

  it('lists what each customer owed and each vendor was owed at December 31, both sides, and how they come to the trial balance', async () => {
    tables.gl_accounts.push(
      account('a12', '12', '1200', 'Accounts receivable', 'accounts_receivable'),
      account('a20', '20', '2000', 'Accounts payable', 'accounts_payable'),
    );
    // Where they stood before 2025, Bravo's December invoice both sides, and a January one, after the year's end.
    const invoices = (side: typeof ns | typeof fs) => [
      side('12', '2027-12-01', 30000), side('40', '2027-12-01', -30000), side('12', '2028-01-01', 10000), side('40', '2028-01-01', -10000),
    ];
    netsuiteTotals.opening.push(ns('12', undefined, 50000), ns('20', undefined, -50000));
    netsuiteTotals.netsuite.push(...invoices(ns));
    booksTotals.push(...invoices(fs));
    const balance = (party: string, name: string, opening: string, moved: { netsuite: string; fleetsuite: string }) => ({
      party, name, netsuite_ids: [party === '7001' ? '7001' : '9001'], opening, ...moved, documents: moved.netsuite === '0' ? 0 : 1, differing: 0,
      members: null, members_count: null,
    });
    const acme = balance('c0000000-0000-4000-8000-00000000000a', 'Acme Fleet', '500.00', { netsuite: '0', fleetsuite: '0' });
    const bravo = balance('c0000000-0000-4000-8000-00000000000b', 'Bravo Transit', '0', { netsuite: '300.00', fleetsuite: '300.00' });
    const customers = (parties: unknown[], opening = '500.00') => ({
      accounts: [{ netsuite_account_id: '12', number: '1200', name: 'Accounts receivable' }],
      opening: { total: opening, named: opening, complete: true },
      parties,
    });
    const landlord = balance('7001', 'Example Landlord LLC', '-500.00', { netsuite: '0', fleetsuite: '0' });
    const vendors = (parties: unknown[]) => ({
      accounts: [{ netsuite_account_id: '20', number: '2000', name: 'Accounts payable' }],
      opening: { total: '-500.00', named: '-500.00', complete: true },
      parties,
    });
    partyData = { customer: customers([acme, bravo]), vendor: vendors([landlord]) };
    const all = await sheetsOf(await download());
    expect(all.map((s) => s.name).slice(7, 10)).toEqual(['General Ledger', 'Customer Balances', 'Vendor Balances']);
    const tie = "The receivable account's line on the Trial Balance sheet.";
    expect(notesOf(named(all, 'Customer Balances'))).toEqual([NOT_POSTED]);
    expect(under(named(all, 'Customer Balances'), 'Customer', 5)).toEqual([
      ['Acme Fleet', 500, 500, 0, null],
      ['Bravo Transit', 300, 300, 0, null],
      ['Every customer', 800, 800, 0, null],
      ['On the trial balance: 1200 Accounts receivable', 800, 800, 0, tie],
      ['Every customer less the trial balance', 0, 0, null, null],
    ]);
    expect(amounts(named(all, 'Trial Balance'), 'Accounts receivable')).toEqual([800, null, 800, null, 0]);
    expect(under(named(all, 'Vendor Balances'), 'Vendor', 5)).toEqual([
      ['Example Landlord LLC', 500, 500, 0, null],
      ['Every vendor', 500, 500, 0, null],
      ['On the trial balance: 2000 Accounts payable', 500, 500, 0, "The payable account's line on the Trial Balance sheet."],
      ['Every vendor less the trial balance', 0, 0, null, null],
    ]);
    expect(rpcs.filter(([name]) => name === 'gl_party_balances_through')).toEqual(['customer', 'vendor'].map((kind) => [
      'gl_party_balances_through', { p_company: 'BMG', p_kind: kind, p_month: '2027-12-01' },
    ]));

    // The copy of NetSuite's ledger without Bravo's invoice yet, and a FleetSuite posting between the reads; a landlord's payment only in the copy.
    partyData = {
      customer: customers([acme, { ...bravo, netsuite: '0', fleetsuite: '250.00' }]),
      vendor: vendors([{ ...landlord, netsuite: '50.00', documents: 1, differing: 1 }]),
    };
    const both = await sheetsOf(await download());
    expect(notesOf(named(both, 'Vendor Balances'))).toEqual([
      NOT_POSTED,
      "NetSuite's vendors don't come to its payable accounts on the trial balance: the copy of NetSuite's ledger doesn't hold everything "
        + "NetSuite's own totals say moved them yet, so some of its documents may be missing here. The next copy catches up.",
    ]);
    const apart = named(both, 'Customer Balances');
    expect(notesOf(apart)).toEqual([
      NOT_POSTED,
      "Something posted to FleetSuite's books while this was read, so its customers don't come to the receivable accounts on the trial balance. "
        + 'Download it again.',
      "NetSuite's customers don't come to its receivable accounts on the trial balance: the copy of NetSuite's ledger doesn't hold everything "
        + "NetSuite's own totals say moved them yet, so some of its documents may be missing here. The next copy catches up.",
    ]);
    expect(under(apart, 'Customer', 5).slice(-3)).toEqual([
      ['Every customer', 750, 500, 250, null],
      ['On the trial balance: 1200 Accounts receivable', 800, 800, 0, tie],
      ['Every customer less the trial balance', -50, -300, null, null],
    ]);

    // Until NetSuite's totals are read its side of the trial balance is empty, which Reports' note says, not the balances'.
    netsuiteTotals = { opening: [], netsuite: [] };
    partyData.customer = customers([bravo], '0');
    const unread = named(await sheetsOf(await download()), 'Customer Balances');
    expect(notesOf(unread)).toEqual([NOT_POSTED, "NetSuite's totals haven't been read yet, so NetSuite's side is empty."]);
    expect(under(unread, 'Customer', 5).slice(-3)).toEqual([
      ['Every customer', 300, 300, 0, null],
      ['On the trial balance: 1200 Accounts receivable', 300, 0, 300, tie],
      ['Every customer less the trial balance', 0, 300, null, null],
    ]);
  });

  it("says when the copy of NetSuite's ledger doesn't hold all NetSuite's totals say, and when an account lists only its first documents", async () => {
    // April's rent bill isn't in the copy yet, and Sales has more documents than a file lists.
    const real = service.rpc;
    service.rpc = async (name, args) => {
      const read = await real(name, args);
      if (name !== 'gl_books_account_documents') return read;
      const data = read.data as Row;
      if (args.p_account === '40') return { data: { ...data, documents: 20001 }, error: null };
      const rows = data.rows.map((r: Row) => (r.doc === '502' ? { ...r, netsuite: '0.00' } : r));
      return { data: { ...data, rows, netsuite: rows.reduce((sum: number, r: Row) => sum + Number(r.netsuite), 0).toFixed(2) }, error: null };
    };
    try {
      const ledger = named(await sheetsOf(await download()), 'General Ledger');
      expect(notesOf(ledger)).toEqual([
        NOT_POSTED,
        "On 2 accounts the copy of NetSuite's ledger doesn't hold everything NetSuite's own totals say moved in these months yet, so some of "
          + "NetSuite's documents may be missing there and its running balance won't reach the account's line. The next copy catches up.",
        '1 account has more than 20,000 documents in these months, so only the first are listed, by date, and the running balances stop short '
          + 'of the line. Download those accounts from Reports a few months at a time.',
      ]);
      expect(under(ledger, 'Account', 12).slice(2, 4)).toEqual([
        ['1010 First Bank checking', new Date('2027-04-01T00:00:00Z'), 'Bill', 'B-1001', 'Example Landlord LLC', 'April rent', -2100, 0, -2100, 11900, 14000, 'Only in FleetSuite'],
        ['1010 First Bank checking', null, 'Balance at the end of December 2027', null, null, null, null, null, -100, 11900, 12000, "The documents above come to $14,000.00 on NetSuite's side"],
      ]);
    } finally {
      service.rpc = real;
    }
    // Until NetSuite's totals are read, Reports' note says its side is empty, and the copy isn't short of anything.
    netsuiteTotals = { opening: [], netsuite: [] };
    expect(notesOf(named(await sheetsOf(await download()), 'General Ledger'))).toEqual([
      NOT_POSTED, "NetSuite's totals haven't been read yet, so NetSuite's side is empty.",
    ]);
    expect(ledgerReads('2027-01-01').slice(-3).map(([, args]) => args.p_account)).toEqual(['10', '40', '60']);
  });

  it("holds BMG's bank account at December 31 against its books and lists each month of the year, as Books' bank reconciliation reads them", async () => {
    const bank = '1010 First Bank checking';
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
    // 1084's own reconciliation of the same NetSuite account, from June, which BMG's reads leave alone.
    tables.bank_rec_starts.unshift({ ...BANK_START, company: '1084', first_month: '2027-06-01', as_of: '2027-05-31', balance_cents: 250000 });
    tables.bank_recs.push({ ...statement('2027-12-01'), company: '1084' });
    tables.bank_rec_ticks.push({ company: '1084', account: '10', doc: '503', month: '2027-06-01', cents: 50000 });
    let all = await sheetsOf(await download());
    // December isn't reconciled yet: nothing typed for it.
    const unreconciled = "1010 First Bank checking: December 2027's statement isn't reconciled yet.";
    expect(notesOf(named(all, 'Bank Reconciliations'))).toEqual([unreconciled]);
    expect(under(named(all, 'Bank Reconciliations'), 'Account', 8)).toEqual([
      [bank, day('2027-12-31'), 'Ending balance on the bank statement', null, null, null, null, "December 2027 isn't reconciled yet"],
      [bank, null, 'Every entry the books had by December 31, 2027 had cleared.', null, null, null, null, null],
      [bank, null, "The bank with what hadn't cleared", null, null, null, null, null],
      [bank, day('2027-12-31'), "FleetSuite's books", null, null, null, 11900, null],
      [bank, null, 'The books less the bank', null, null, null, null, "The statement's ending balance isn't typed yet."],
    ]);
    const months = under(named(all, 'Bank Reconciliations by Month'), 'Account', 9);
    expect(notesOf(named(all, 'Bank Reconciliations by Month'))).toEqual([unreconciled]);
    expect(months).toHaveLength(13);
    expect([0, 1, 3, 4, 12].map((i) => months[i])).toEqual([
      [bank, 'Where reconciling starts', day('2026-12-31'), null, null, null, 4000, null, null],
      [bank, 'January 2027', day('2027-01-31'), 4000, 0, 0, 4000, 0, 'By Valarie, February 5, 2027 at 9:00 AM Central'],
      [bank, 'March 2027', day('2027-03-31'), 4000, 10000, 0, 14000, 0, 'By Valarie, April 5, 2027 at 10:00 AM Central'],
      [bank, 'April 2027', day('2027-04-30'), 14000, 0, 2100, 11900, 0, 'By Valarie, May 5, 2027 at 10:00 AM Central'],
      [bank, 'December 2027', day('2027-12-31'), 11900, 0, 0, null, null, 'Not yet'],
    ]);
    // Read as Books' bank reconciliation reads the account: each entry on it from where FleetSuite's books start through this month.
    expect(documentReads().filter(([, args]) => args.p_from === '2025-01-01')).toEqual([['gl_books_account_documents', {
      p_company: 'BMG', p_account: '10', p_from: '2025-01-01', p_to: '2028-01-01', p_differs: false, p_limit: 20000,
    }]]);

    // December reconciled, with a deposit that hadn't cleared by its last day and one NetSuite has that hasn't posted yet; more entries than
    // are read at once, and the last posting run failed.
    tables.bank_recs.push(statement('2027-12-01'));
    tables.sync_state = [{ sync_type: 'books_invoice_posting', last_result: { error: 'NetSuite timed out' }, updated_at: '2028-01-20T14:00:00Z' }];
    const real = service.rpc;
    service.rpc = async (name, args) => {
      const read = await real(name, args);
      if (name !== 'gl_books_account_documents' || args.p_from !== '2025-01-01') return read;
      const data = read.data as Row;
      const rows = [
        ...data.rows,
        docOf('503', '0.00', '500.00', { type: 'Deposit', number: 'D9', month: '2027-12-01', date: '2027-12-30', name: 'Example Fleet Co' }),
        docOf('504', '75.00', '0.00', { type: 'Deposit', number: 'D10', month: '2027-12-01', date: '2027-12-29' }),
      ];
      return { data: { ...data, rows, documents: 20001 }, error: null };
    };
    try {
      all = await sheetsOf(await download());
    } finally {
      service.rpc = real;
    }
    expect(notesOf(named(all, 'Bank Reconciliations'))).toEqual([
      'The last posting run failed (January 20, 2028 at 8:00 AM Central): NetSuite timed out',
      '1010 First Bank checking has more than 20,000 entries, more than FleetSuite reads at once, so its books here stop short.',
      "1010 First Bank checking: 1 entry NetSuite has isn't posted to FleetSuite's books yet, so it isn't here.",
    ]);
    expect(under(named(all, 'Bank Reconciliations'), 'Account', 8)).toEqual([
      [bank, day('2027-12-31'), 'Ending balance on the bank statement', null, null, null, 11900, 'December 2027 reconciled by Valarie, January 5, 2028 at 9:00 AM Central'],
      [bank, day('2027-12-30'), 'Deposit', 'D9', 'Example Fleet Co', null, 500, 'Not cleared by December 31, 2027'],
      [bank, null, "The bank with what hadn't cleared", null, null, null, 12400, null],
      [bank, day('2027-12-31'), "FleetSuite's books", null, null, null, 12400, null],
      [bank, null, 'The books less the bank', null, null, null, 0, null],
    ]);
    expect(under(named(all, 'Bank Reconciliations by Month'), 'Account', 9).at(-1)).toEqual([
      bank, 'December 2027', day('2027-12-31'), 11900, 0, 0, 11900, 0, 'By Valarie, January 5, 2028 at 9:00 AM Central',
    ]);

    // An account no longer reconciled by the time it's read is left out, with its sheets when it's the only one.
    const from = service.from;
    service.from = (table: string) => {
      const q = from(table);
      if (table === 'bank_rec_starts') q.maybeSingle = async () => ({ data: null, error: null });
      return q;
    };
    try {
      all = await sheetsOf(await download());
    } finally {
      service.from = from;
    }
    expect(all.map((s) => s.name)).not.toContain('Bank Reconciliations');
    expect(all.map((s) => s.name)).not.toContain('Bank Reconciliations by Month');

    // 1084's package has its own, from June, with no entry in its books on the account.
    tables.sync_state = [];
    const theirs = await sheetsOf(await download('company=1084&year=2027'));
    expect(under(named(theirs, 'Bank Reconciliations by Month'), 'Account', 9).slice(0, 2)).toEqual([
      [bank, 'Where reconciling starts', day('2027-05-31'), null, null, null, 2500, null, null],
      [bank, 'June 2027', null, null, null, null, null, null, 'Not yet'],
    ]);
    expect(under(named(theirs, 'Bank Reconciliations'), 'Account', 8).at(-2)).toEqual([bank, day('2027-12-31'), "FleetSuite's books", null, null, null, 0, null]);
    // A company reconciling no bank account in FleetSuite has no bank sheets.
    tables.bank_rec_starts = tables.bank_rec_starts.filter((r) => r.company !== '1084');
    expect((await sheetsOf(await download('company=1084&year=2027'))).map((s) => s.name)).not.toContain('Bank Reconciliations');
  });

  it('says on every sheet that the year is closed, by whom and when', async () => {
    expect((await post({ company: 'BMG', year: 2027, action: 'close', reason: 'Checked' })).status).toBe(200);
    const all = await sheetsOf(await download('company=BMG&year=2027'));
    for (const ws of all) expect([ws.name, column(ws)[5]]).toEqual([ws.name, '2027 is closed by Craig, January 20, 2028 at 9:00 AM Central.']);
    expect(column(named(all, 'Retained Earnings')).at(-1)).toBe('Closed by Craig, January 20, 2028 at 9:00 AM Central, at $7,900.00 of net income: Checked');
  });

  it("runs this year through this month, and gives the company asked for, with no stock sheets when it has none", async () => {
    const now = await sheetsOf(await download('year=2028'));
    expect(column(now[0]).slice(2, 6)).toEqual([
      'January 1, 2028 to January 31, 2028', expect.any(String), 'Downloaded January 20, 2028 at 9:00 AM Central.',
      "2028 isn't over yet, so this is where it stood when the file was made.",
    ]);
    expect(rpcs.filter(([name]) => name === 'gl_stock_month_end').at(-1)).toEqual(['gl_stock_month_end', { p_month: '2028-01-01', p_limit: 100 }]);
    expect(rpcs.filter(([name]) => name === 'gl_party_balances_through').map(([, args]) => args.p_month)).toEqual(['2028-01-01', '2028-01-01']);
    expect(column(named(now, 'Customer Balances'))[2]).toBe('As of January 31, 2028');
    expect(column(named(now, 'Inventory value')).slice(2, 6)).toEqual([
      'As of January 31, 2028', expect.any(String), 'Downloaded January 20, 2028 at 9:00 AM Central.',
      "January 2028 isn't over yet, so this is where it stood when the file was made.",
    ]);
    // Nothing has moved this year yet: no documents to read, each balance carried through the month, 2027 coming into retained earnings.
    expect(ledgerReads('2028-01-01')).toEqual([]);
    expect(documentReads().map(([, args]) => [args.p_account, args.p_from, args.p_to])).toEqual([['10', '2025-01-01', '2028-01-01']]);
    expect(column(named(now, 'General Ledger'))[3]).toMatch(/^Every account with a balance or a document in the month \(2 accounts\),/);
    expect(under(named(now, 'General Ledger'), 'Account', 3)).toEqual([
      ['1010 First Bank checking', null, 'Balance at the end of December 2027'],
      ['1010 First Bank checking', null, 'Balance at the end of January 2028'],
      ['3900 Retained Earnings', null, 'Balance at the end of December 2027'],
      ['3900 Retained Earnings', new Date('2028-01-01T00:00:00Z'), "Earlier years' net income, taken into retained earnings at the year's start"],
      ['3900 Retained Earnings', null, 'Balance at the end of January 2028'],
    ]);

    const res = await download('company=1084&year=2026');
    expect(res.headers.get('content-disposition')).toContain('filename="1084 Year-end package 2026.xlsx"');
    const other = await sheetsOf(res);
    expect(other.map((s) => s.name).slice(-3)).toEqual(['Customer Balances', 'Vendor Balances', 'CPA Adjustments']);
    expect(rpcs.filter(([name]) => name === 'gl_party_balances_through').slice(-2).map(([, args]) => [args.p_company, args.p_month])).toEqual([
      ['1084', '2026-12-01'], ['1084', '2026-12-01'],
    ]);
    expect(under(named(other, 'General Ledger'), 'Account', 1)).toEqual([['No account has a balance or a document in these months.']]);
    expect(notesOf(named(other, 'General Ledger'))).toEqual(notesOf(named(other, 'Trial Balance')));
    expect(column(other[0]).slice(0, 6)).toEqual([
      '1084', 'Year-end package 2026', 'January 1, 2026 to December 31, 2026', expect.any(String),
      'Downloaded January 20, 2028 at 9:00 AM Central.',
      "1084's books aren't live yet, so 2026 closes in NetSuite: FleetSuite's side here is the rehearsal.",
    ]);
    expect(rpcs.filter(([name]) => name === 'gl_books_split_totals').at(-1)).toEqual(['gl_books_split_totals', { p_company: '1084' }]);
    // Nothing of 1084's has posted, and NetSuite's totals and ledger for it haven't been read.
    const rehearsal = "1084's books aren't live yet, so 2026 closes in NetSuite: FleetSuite's side here is the rehearsal.";
    expect(notesOf(named(other, 'Trial Balance'))).toEqual([rehearsal, NOT_POSTED, "NetSuite's totals haven't been read yet, so NetSuite's side is empty."]);
    expect(notesOf(named(other, 'Profit and Loss by Month'))).toEqual([
      rehearsal, NOT_POSTED, "NetSuite's ledger hasn't been copied yet, so lines from its documents have no location, customer or vendor.",
    ]);

    // A year before BMG's books went live.
    const before = await sheetsOf(await download('company=BMG&year=2026'));
    expect(notesOf(before[0])).toEqual(["2026 is before BMG's books went live, so it closes in NetSuite: FleetSuite's side here is the rehearsal."]);
  });

  it("says when the profit and loss by month doesn't come to Reports", async () => {
    const real = service.rpc;
    service.rpc = async (name, args) => (name === 'gl_books_split_totals' ? { data: [], error: null } : real(name, args));
    try {
      const all = await sheetsOf(await download());
      expect(notesOf(named(all, 'Profit and Loss by Month'))).toEqual([
        "Something posted to FleetSuite's books while this was read, so its columns may not come to the profit and loss on Reports. Download it again.",
        NOT_POSTED,
      ]);
      // Reports' own statements don't read the split.
      expect(notesOf(named(all, 'Profit and Loss'))).toEqual([NOT_POSTED]);
    } finally {
      service.rpc = real;
    }
  });

  it('is for whoever opens the books: the bookkeeper and the CPA too, not an admin who does not', async () => {
    for (const r of [['bookkeeper'], ['cpa']]) {
      roles = r;
      expect([r, (await download()).status]).toEqual([r, 200]);
    }
    roles = ['admin'];
    rpcs.length = 0;
    expect((await download()).status).toBe(403);
    expect(rpcs).toEqual([]);
  });

  it('says what failed', async () => {
    const said: Record<string, string> = {
      gl_companies: 'gl_companies is down',
      gl_year_closes: "Couldn't read the years closed: gl_year_closes is down",
      gl_books_split_totals: 'gl_books_split_totals is down',
      gl_netsuite_lists: 'gl_netsuite_lists is down',
      gl_stock_month_end: 'gl_stock_month_end is down',
      gl_books_account_documents: 'gl_books_account_documents is down',
      gl_party_balances_through: 'gl_party_balances_through is down',
    };
    // The ledger's reads, with no bank account reconciled to read too.
    const starts = tables.bank_rec_starts;
    tables.bank_rec_starts = [];
    for (const [table, error] of Object.entries(said)) {
      errors = { [table]: { message: `${table} is down` } };
      const res = await download();
      expect([table, res.status, await res.json()]).toEqual([table, 500, { error }]);
    }
    // The bank account's, in 2028, when nothing has moved for the ledger to read.
    tables.bank_rec_starts = starts;
    const bank: Record<string, string> = {
      gl_books_account_documents: "Couldn't read the account's entries: gl_books_account_documents is down",
      bank_rec_ticks: "Couldn't read what cleared: bank_rec_ticks is down",
      bank_rec_events: "Couldn't read what was reconciled: bank_rec_events is down",
      profiles: 'profiles is down',
    };
    for (const [table, error] of Object.entries(bank)) {
      errors = { [table]: { message: `${table} is down` } };
      const res = await download('year=2028');
      expect([table, res.status, await res.json()]).toEqual([table, 500, { error }]);
    }
    errors = {};
    tables.gl_companies = [];
    const res = await download();
    expect([res.status, await res.json()]).toEqual([500, { error: 'No companies set up' }]);
  });
});
