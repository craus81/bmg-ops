// Books → 1099s (src/app/api/admin/books/1099s): which year and company it
// reads, the year's totals it hands back for a made-up vendor
// (src/lib/books/1099s.ts), how the copies it reads last went, and
// NetSuite's 1099 report kept for the year and held against the totals
// (src/lib/books/1099-report.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let superAdmin = true;
vi.mock('@/lib/api-auth', () => ({
  requireSuperAdmin: vi.fn(async () => (superAdmin ? { user: { id: 'u-craig' } } : { error: new Response('Forbidden', { status: 403 }) })),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET, POST } from '../../app/api/admin/books/1099s/route';
import { BOOKS_ACCOUNTS_SYNC } from './netsuite-accounts';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { BOOKS_GL_SYNC } from './netsuite-gl';
import { BOOKS_BILL_PAYMENTS_SYNC } from './netsuite-bill-payments';
import { BOOKS_SPENDING_SYNC } from './netsuite-spending';
import type { Year1099Data } from './1099s';

type SyncRow = { last_synced_at: string | null; last_result: unknown; updated_at: string };
let companies: Array<{ id: string; code: string; name: string }>;
let syncRows: Record<string, SyncRow>;
let errors: Record<string, { message: string }>;
let year: Year1099Data;
/** Kept reports by `${company id}:${year}`, as migration 482 keeps them. */
let reports: Record<string, Record<string, unknown>>;
let people: Record<string, { full_name: string | null }>;
let replaced: boolean;
let removed: boolean;
const rpcs: Array<[string, Record<string, unknown>]> = [];
const audits: unknown[] = [];

/**
 * Just enough of supabase-js for the route: the companies, one sync_state row by type, the year's kept report, who
 * uploaded it, the audit log, and the year's read, saving and taking off.
 */
function query(table: string) {
  const where: Record<string, unknown> = {};
  const q: any = {
    select: () => q,
    order: async () => (errors[table] ? { data: null, error: errors[table] } : { data: companies, error: null }),
    eq: (col: string, value: unknown) => { where[col] = value; return q; },
    insert: async (rows: unknown) => { audits.push(...(rows as unknown[])); return { error: null }; },
    maybeSingle: async () => {
      if (table === 'gl_netsuite_1099_reports') {
        return errors[table] ? { data: null, error: errors[table] } : { data: reports[`${where.company_id}:${where.year}`] ?? null, error: null };
      }
      if (table === 'profiles') return { data: people[where.id as string] ?? null, error: null };
      const failed = errors[`${table}:${where.sync_type}`];
      return failed ? { data: null, error: failed } : { data: syncRows[where.sync_type as string] ?? null, error: null };
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
    if (name === 'gl_netsuite_1099_report_save') {
      const p = args.p as { company: string; year: number; vendors: unknown[] };
      return { data: { company: p.company, year: p.year, vendors: p.vendors.length, replaced }, error: null };
    }
    if (name === 'gl_netsuite_1099_report_remove') return { data: { removed }, error: null };
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
  companies = [{ id: 'co-1084', code: '1084', name: '1084 Cool Springs' }, { id: 'co-bmg', code: 'BMG', name: 'BMG Fleet Installations' }];
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
  reports = {};
  people = { 'u-sam': { full_name: 'Sam Sample' } };
  replaced = false;
  removed = true;
  rpcs.length = 0;
  audits.length = 0;
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

// NetSuite's report for BMG's 2025 as the page reads it from a made-up export: V-60 Example Electric at 1,200.00.
const REPORT = {
  fileName: '1099 Summary.csv',
  title: ['Sample Fleet Co', 'January 2025 - December 2025'],
  columns: [{ key: 'c1', header: 'Nonemployee Compensation', box: 'Nonemployee Compensation' }, { key: 'c2', header: 'Total', box: null }],
  leftOut: ['Tax ID', 'Address'],
  vendors: [{ label: 'V-60 Example Electric', names: [], amounts: { c1: 120000, c2: 120000 } }],
  skipped: { totals: 1, noName: 0, combined: 0 },
};

const post = async (body: unknown) => {
  const res = await POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/1099s', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};

describe("NetSuite's 1099 report", () => {
  const kept = (fields: Record<string, unknown> = {}) => ({
    file_name: REPORT.fileName, title_lines: REPORT.title, amount_columns: REPORT.columns, left_out: REPORT.leftOut,
    vendors: REPORT.vendors, skipped: { totals: 1, no_name: 0, combined: 0 }, uploaded_by: 'u-sam', uploaded_at: '2026-11-01T13:00:00Z',
    ...fields,
  });

  it('shows none when none is kept for the year', async () => {
    const { body } = await get();
    expect(body).toMatchObject({ report: null, comparison: null });
  });

  it("hands back the company's year's report, who uploaded it, and the two side by side", async () => {
    reports['co-bmg:2025'] = kept();
    reports['co-1084:2025'] = kept({ file_name: "1084's.csv" });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.report).toEqual({
      fileName: '1099 Summary.csv', title: REPORT.title, columns: REPORT.columns, leftOut: ['Tax ID', 'Address'],
      skipped: { totals: 1, noName: 0, combined: 0 }, vendors: 1, uploadedBy: 'Sam Sample', uploadedAt: '2026-11-01T13:00:00Z',
    });
    expect(body.comparison).toMatchObject({
      boxes: ['Nonemployee Compensation'], hasTotal: true, onlyInReport: [], onlyInFleetSuite: [],
      counts: { same: 1, differ: 0, onlyInReport: 0, onlyInFleetSuite: 0 },
    });
    expect(body.comparison.vendors).toEqual([expect.objectContaining({
      payee: '60', name: 'V-60 Example Electric', same: true,
      netsuite: { total: 120000, boxes: { 'Nonemployee Compensation': 120000 } },
      fleetsuite: { total: 120000, boxes: { 'Nonemployee Compensation': 120000 } },
    })]);
    expect((await get('company=1084')).body.report.fileName).toBe("1084's.csv");
    expect((await get('year=2026')).body.report).toBeNull();
  });

  it("works it out afresh, so a difference shows, and leaves the uploader's name out when there's none", async () => {
    reports['co-bmg:2025'] = kept({
      uploaded_by: null, skipped: {},
      vendors: [{ label: 'V-60 Example Electric', names: [], amounts: { c1: 100000, c2: 100000 } }, { label: 'Unknown Co', names: [], amounts: { c2: 500 } }],
    });
    const { body } = await get();
    expect(body.report).toMatchObject({ uploadedBy: null, vendors: 2, skipped: { totals: 0, noName: 0, combined: 0 } });
    expect(body.comparison.counts).toEqual({ same: 0, differ: 1, onlyInReport: 1, onlyInFleetSuite: 0 });
    expect(body.comparison.vendors[0].differences).toEqual({ total: -20000, boxes: { 'Nonemployee Compensation': -20000 } });

    reports['co-bmg:2025'] = kept({ uploaded_by: 'u-gone' });
    expect((await get()).body.report.uploadedBy).toBeNull();
  });

  it("passes on what the database says when the report can't be read", async () => {
    errors.gl_netsuite_1099_reports = { message: 'gl_netsuite_1099_reports is unreadable' };
    expect(await get()).toEqual({ status: 500, body: { error: 'gl_netsuite_1099_reports is unreadable' } });
  });

  it('keeps a report for the year, only its names and amounts, and audits it without amounts', async () => {
    const { status, body } = await post({ company: 'BMG', year: 2025, report: { ...REPORT, extra: 'x' } });
    expect(status).toBe(200);
    expect(body).toEqual({ saved: true, vendors: 1, replaced: false });
    expect(rpcs).toEqual([['gl_netsuite_1099_report_save', {
      p: {
        company: 'BMG', year: 2025, file_name: '1099 Summary.csv', title: REPORT.title, left_out: ['Tax ID', 'Address'],
        columns: REPORT.columns, vendors: REPORT.vendors, skipped: { totals: 1, no_name: 0, combined: 0 }, uploaded_by: 'u-craig',
      },
    }]]);
    expect(audits).toEqual([{
      actor_id: 'u-craig', table_name: 'gl_netsuite_1099_reports', record_id: 'BMG 2025', action: 'upload',
      detail: { company: 'BMG', year: 2025, file_name: '1099 Summary.csv', vendors: 1, columns: ['Nonemployee Compensation', 'Total'] },
    }]);
    expect(JSON.stringify(audits)).not.toMatch(/1200/);

    replaced = true;
    audits.length = 0;
    expect((await post({ company: '1084', year: 2026, report: REPORT })).body).toEqual({ saved: true, vendors: 1, replaced: true });
    expect(audits).toEqual([expect.objectContaining({ record_id: '1084 2026', action: 'replace' })]);
  });

  it('refuses a report with nine digits in a row, a tax ID maybe, keeping and auditing nothing', async () => {
    const vendors = [{ label: 'V-60 Example Electric', names: ['12-3456789'], amounts: { c1: 120000 } }];
    const { status, body } = await post({ company: 'BMG', year: 2025, report: { ...REPORT, vendors } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/nine digits in a row/);
    expect(rpcs).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('turns down a year, a company or a body it has no use for', async () => {
    for (const [sent, error] of [
      ['not json', 'Send the company, the year and the report'],
      [{ company: 'BMG', year: 2024, report: REPORT }, 'Pick a year from 2025 to 2026'],
      [{ company: 'BMG', year: '2025', report: REPORT }, 'Pick a year from 2025 to 2026'],
      [{ company: 'XYZ', year: 2025, report: REPORT }, 'No company XYZ'],
      [{ year: 2025, report: REPORT }, 'No company (none)'],
      [{ company: 'BMG', year: 2025 }, 'No report to keep'],
      [{ company: 'BMG', year: 2025, report: { ...REPORT, columns: [] } }, 'The report needs 1 to 40 columns of amounts'],
    ] as Array<[unknown, string]>) {
      expect(await post(sent), JSON.stringify(sent)).toEqual({ status: 400, body: { error } });
    }
    expect(rpcs).toEqual([]);
  });

  it('takes the year\'s report off, and audits it when there was one', async () => {
    expect(await post({ company: 'BMG', year: 2025, remove: true })).toEqual({ status: 200, body: { removed: true } });
    expect(rpcs).toEqual([['gl_netsuite_1099_report_remove', { p_company: 'BMG', p_year: 2025 }]]);
    expect(audits).toEqual([{
      actor_id: 'u-craig', table_name: 'gl_netsuite_1099_reports', record_id: 'BMG 2025', action: 'remove', detail: { company: 'BMG', year: 2025 },
    }]);

    removed = false;
    audits.length = 0;
    expect((await post({ company: 'BMG', year: 2025, remove: true })).body).toEqual({ removed: false });
    expect(audits).toEqual([]);
  });

  it('passes on what the database says when keeping or taking off fails', async () => {
    errors.gl_netsuite_1099_report_save = { message: 'gl: the report lists no vendors' };
    expect(await post({ company: 'BMG', year: 2025, report: REPORT })).toEqual({ status: 500, body: { error: 'gl: the report lists no vendors' } });
    errors.gl_netsuite_1099_report_remove = { message: 'gl: no company BMG' };
    expect(await post({ company: 'BMG', year: 2025, remove: true })).toEqual({ status: 500, body: { error: 'gl: no company BMG' } });
    errors = { gl_companies: { message: 'gl_companies is unreadable' } };
    expect(await post({ company: 'BMG', year: 2025, remove: true })).toEqual({ status: 500, body: { error: 'gl_companies is unreadable' } });
    expect(audits).toEqual([]);
  });

  it('is for super admins only', async () => {
    superAdmin = false;
    const res = await POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/1099s', {
      method: 'POST', body: JSON.stringify({ company: 'BMG', year: 2025, report: REPORT }),
    }));
    expect(res.status).toBe(403);
    expect(rpcs).toEqual([]);
  });
});
