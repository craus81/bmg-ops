// Books → 1099s (src/app/api/admin/books/1099s): which year and company it
// reads, the year's totals it hands back for a made-up vendor
// (src/lib/books/1099s.ts), and how the copies it reads last went.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let superAdmin = true;
vi.mock('@/lib/api-auth', () => ({
  requireSuperAdmin: vi.fn(async () => (superAdmin ? { user: { id: 'u-craig' } } : { error: new Response('Forbidden', { status: 403 }) })),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET } from '../../app/api/admin/books/1099s/route';
import { BOOKS_ACCOUNTS_SYNC } from './netsuite-accounts';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { BOOKS_GL_SYNC } from './netsuite-gl';
import { BOOKS_BILL_PAYMENTS_SYNC } from './netsuite-bill-payments';
import { BOOKS_SPENDING_SYNC } from './netsuite-spending';
import type { Year1099Data } from './1099s';

type SyncRow = { last_synced_at: string | null; last_result: unknown; updated_at: string };
let companies: Array<{ code: string; name: string }>;
let syncRows: Record<string, SyncRow>;
let errors: Record<string, { message: string }>;
let year: Year1099Data;
const rpcs: Array<[string, Record<string, unknown>]> = [];

/** Just enough of supabase-js for the route: the companies, one sync_state row by type, and the year's read. */
function query(table: string) {
  let syncType: unknown = null;
  const q: any = {
    select: () => q,
    order: async () => (errors[table] ? { data: null, error: errors[table] } : { data: companies, error: null }),
    eq: (col: string, value: unknown) => { if (col === 'sync_type') syncType = value; return q; },
    maybeSingle: async () => {
      const failed = errors[`${table}:${syncType}`];
      return failed ? { data: null, error: failed } : { data: syncRows[syncType as string] ?? null, error: null };
    },
  };
  return q;
}
const service = {
  from: query,
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push([name, args]);
    if (errors[name]) return { data: null, error: errors[name] };
    if (name === 'gl_1099_year') return { data: year, error: null };
    return { data: null, error: { message: `No ${name}` } };
  },
};

const get = async (params = '') => {
  const res = await GET(new NextRequest(`https://go.bmgfleet.com/api/admin/books/1099s${params ? `?${params}` : ''}`));
  return { status: res.status, body: await res.json() };
};

/**
 * A made-up year: V-60 Example Electric, marked for a 1099, paid 1,200.00 by check on contract labor, which counts as
 * nonemployee compensation; and a 45.00 card charge from it, which is left to the card company's 1099-K.
 */
const YEAR: Year1099Data = {
  payments: [
    {
      netsuite_id: '9101', type: 'Check', number: 'CHK3001', date: '2025-03-14', payee: '60', payee_name: 'V-60 Example Electric', total: '1200.00',
      lines: [{ account: '10', debit: '0.00', credit: '1200.00' }, { account: '530', debit: '1200.00', credit: '0.00' }], links: null,
    },
    {
      netsuite_id: '9102', type: 'CardChrg', number: null, date: '2025-05-02', payee: '60', payee_name: 'V-60 Example Electric', total: '45.00',
      lines: [{ account: '20', debit: '0.00', credit: '45.00' }, { account: '530', debit: '45.00', credit: '0.00' }], links: null,
    },
  ],
  payees: [{ netsuite_id: '60', name: 'V-60 Example Electric', entity_id: 'V-60', legal_name: null, is_1099: 'T' }],
  accounts: [
    { netsuite_id: '10', number: '1000', name: 'Checking', type: 'bank' },
    { netsuite_id: '20', number: '2100', name: 'Company card', type: 'credit_card' },
    { netsuite_id: '530', number: '6530', name: 'Contract labor', type: 'expense' },
  ],
  categories: [{ netsuite_id: '530', category: 'Nonemployee Compensation' }],
  flags_copied: true,
  not_copied: [],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T15:00:00Z'));
  superAdmin = true;
  companies = [{ code: '1084', name: '1084 Cool Springs' }, { code: 'BMG', name: 'BMG Fleet Installations' }];
  const ran = (last_result: unknown): SyncRow => ({ last_synced_at: '2026-11-01T14:00:00Z', last_result, updated_at: '2026-11-01T14:00:00Z' });
  syncRows = {
    [BOOKS_ACCOUNTS_SYNC]: ran({ received: 3, accounts1099: { received: 1, added: 0, changed: 0, removed: 0 } }),
    [BOOKS_LISTS_SYNC]: ran({ lists: { vendor: { received: 1, added: 0, changed: 0, gone: 0 } } }),
    [BOOKS_GL_SYNC]: ran({ received: 40 }),
    [BOOKS_BILL_PAYMENTS_SYNC]: ran({ received: 0 }),
    [BOOKS_SPENDING_SYNC]: ran({ received: 2 }),
  };
  errors = {};
  year = structuredClone(YEAR);
  rpcs.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('1099s', () => {
  it('is for super admins only', async () => {
    superAdmin = false;
    const res = await GET(new NextRequest('https://go.bmgfleet.com/api/admin/books/1099s'));
    expect(res.status).toBe(403);
    expect(rpcs).toEqual([]);
  });

  it("shows last year for BMG when nothing's picked, with each vendor's totals by category", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(rpcs).toEqual([['gl_1099_year', { p_company: 'BMG', p_year: 2025 }]]);
    expect(body).toMatchObject({
      companies: [{ code: '1084', name: '1084 Cool Springs' }, { code: 'BMG', name: 'BMG Fleet Installations' }],
      company: 'BMG', year: 2025, years: [2026, 2025],
      categories: ['Nonemployee Compensation'],
      totals: { boxes: { 'Nonemployee Compensation': 120000 }, total: 120000 },
      flagsCopied: true, notMarked: [], unsplit: [], notCopied: [],
    });
    expect(body.forms.map((f: any) => [f.name, f.marked, f.boxes, f.total, f.byCard])).toEqual([
      ['V-60 Example Electric', true, { 'Nonemployee Compensation': 120000 }, 120000, 4500],
    ]);
    expect(body.byCard.map((f: any) => [f.name, f.byCard])).toEqual([['V-60 Example Electric', 4500]]);
    expect(body.accounts).toEqual([{ netsuiteId: '530', number: '6530', name: 'Contract labor', category: 'Nonemployee Compensation' }]);
  });

  it('takes any year from 2025 to this one, and the company asked for', async () => {
    const { body } = await get('company=1084&year=2026');
    expect(body).toMatchObject({ company: '1084', year: 2026 });
    expect(rpcs).toEqual([['gl_1099_year', { p_company: '1084', p_year: 2026 }]]);

    // A company that isn't set up falls back to BMG.
    expect((await get('company=XYZ&year=2025')).body.company).toBe('BMG');
  });

  // Only four digits: Number() alone would read ' 2025' and '2.025e3' as 2025.
  it.each(['2024', '2027', '25', '2025.5', ' 2025', '2.025e3', 'last', ''])('turns down the year %j', async (asked) => {
    const { status, body } = await get(`year=${encodeURIComponent(asked)}`);
    expect(status).toBe(400);
    expect(body.error).toBe('Pick a year from 2025 to 2026');
    expect(rpcs).toEqual([]);
  });

  it("goes by Central time, so New Year's Eve evening there is still the old year", async () => {
    vi.setSystemTime(new Date('2026-01-01T03:00:00Z'));
    const { body } = await get();
    // It's 2025 in Chicago, and the copy starts with 2025, so 2025 is both the only year and the one shown.
    expect(body).toMatchObject({ year: 2025, years: [2025] });
    expect((await get('year=2026')).status).toBe(400);

    vi.setSystemTime(new Date('2026-01-01T07:00:00Z'));
    expect((await get()).body).toMatchObject({ year: 2025, years: [2026, 2025] });
  });

  it('says how each copy it reads last went', async () => {
    syncRows[BOOKS_ACCOUNTS_SYNC] = {
      last_synced_at: '2026-11-01T14:00:00Z', updated_at: '2026-11-01T14:00:00Z',
      last_result: { received: 3, accounts1099: { error: "Field 'category1099misc' for record 'account' was not found" } },
    };
    syncRows[BOOKS_LISTS_SYNC] = {
      last_synced_at: '2026-11-01T14:00:00Z', updated_at: '2026-11-01T14:00:00Z',
      last_result: { lists: { vendor: { received: 1, missing: ['is_1099', 'legal_name'] } } },
    };
    syncRows[BOOKS_SPENDING_SYNC] = { last_synced_at: '2026-10-30T14:00:00Z', updated_at: '2026-11-01T14:00:00Z', last_result: { error: 'NetSuite timed out' } };
    delete syncRows[BOOKS_BILL_PAYMENTS_SYNC];

    const { body } = await get();
    expect(body.copies).toEqual({
      chart: { at: '2026-11-01T14:00:00Z', tried: '2026-11-01T14:00:00Z', error: null },
      accounts1099: { error: "Field 'category1099misc' for record 'account' was not found" },
      lists: { at: '2026-11-01T14:00:00Z', tried: '2026-11-01T14:00:00Z', error: null },
      vendors: { error: null, missing: ['is_1099', 'legal_name'] },
      ledger: { at: '2026-11-01T14:00:00Z', tried: '2026-11-01T14:00:00Z', error: null },
      billPayments: null,
      spending: { at: '2026-10-30T14:00:00Z', tried: '2026-11-01T14:00:00Z', error: 'NetSuite timed out' },
    });
  });

  it("says nothing about the 1099 accounts or the vendors when those copies haven't run", async () => {
    syncRows = {};
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.copies).toEqual({ chart: null, accounts1099: null, lists: null, vendors: null, ledger: null, billPayments: null, spending: null });

    // A chart copy from before the 1099 read says it hasn't read them yet, rather than nothing.
    syncRows[BOOKS_ACCOUNTS_SYNC] = { last_synced_at: '2026-11-01T14:00:00Z', updated_at: '2026-11-01T14:00:00Z', last_result: { received: 3 } };
    syncRows[BOOKS_LISTS_SYNC] = { last_synced_at: '2026-11-01T14:00:00Z', updated_at: '2026-11-01T14:00:00Z', last_result: { lists: {} } };
    const before = (await get()).body.copies;
    expect(before.accounts1099).toBeNull();
    expect(before.vendors).toBeNull();
  });

  it("passes on what the database says when a read fails", async () => {
    errors.gl_1099_year = { message: 'gl: something broke' };
    expect(await get()).toEqual({ status: 500, body: { error: 'gl: something broke' } });

    errors = { [`sync_state:${BOOKS_GL_SYNC}`]: { message: 'sync_state is unreadable' } };
    rpcs.length = 0;
    expect(await get()).toEqual({ status: 500, body: { error: 'sync_state is unreadable' } });
    expect(rpcs).toEqual([]);

    errors = { gl_companies: { message: 'gl_companies is unreadable' } };
    expect((await get()).body.error).toBe('gl_companies is unreadable');
  });

  it('says so when no company is set up', async () => {
    companies = [];
    expect(await get()).toEqual({ status: 500, body: { error: 'No companies set up' } });
    expect(rpcs).toEqual([]);
  });
});
