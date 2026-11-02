// Books → Reports → Report builder's routes (src/app/api/admin/books/reports/builder
// and its download): what each one reads for a made-up company's books and
// hands back, the page's report and its Excel file alike (loadBuilder and
// builderAsk in src/lib/books/report-data.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';

let roles = ['admin', 'super_admin'];
vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => roles.includes(r));
      return booksAllows(access, need) ? { access } : { error: new Response('Forbidden', { status: 403 }) };
    }),
  };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET as builderJson } from '../../app/api/admin/books/reports/builder/route';
import { GET as builderDownload } from '../../app/api/admin/books/reports/builder/download/route';
import { XLSX_TYPE } from './report-workbook';

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });
const account = (id: string, ns: string | null, number: string, name: string, type: string) => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: type === 'income' || type === 'cost_of_goods_sold' || type === 'expense' ? 'income_statement' : 'balance_sheet',
  parent_id: null, company_id: null,
});

const TABLES: Record<string, unknown[]> = {
  gl_companies: [
    { id: 'c1', code: '1084', name: '1084', legal_name: null, netsuite_subsidiary_id: '2' },
    { id: 'c2', code: 'BMG', name: 'BMG', legal_name: 'Example Fleet Upfitters LLC', netsuite_subsidiary_id: '1' },
    { id: 'c3', code: 'NEW', name: 'Example New Co', legal_name: null, netsuite_subsidiary_id: '4' },
  ],
  gl_accounts: [
    account('a2', '2', '1200', 'Receivables', 'accounts_receivable'),
    account('a5', '5', '4000', 'Sales', 'income'),
    account('a6', '6', '5000', 'Cost of goods sold', 'cost_of_goods_sold'),
    account('a7', '7', '6000', 'Rent', 'expense'),
  ],
  gl_netsuite_lists: [
    { kind: 'location', netsuite_id: '1', name: "O'Fallon" }, { kind: 'location', netsuite_id: '3', name: 'Kansas City' },
    { kind: 'vendor', netsuite_id: '3', name: 'Example Vinyl Supply' },
  ],
};

/**
 * Made-up journal: in August 2026 a graphics sale at O'Fallon and an upfit
 * sale at Kansas City with its cost, in September another upfit sale at
 * Kansas City and the rent, which FleetSuite has at O'Fallon by its own key.
 */
const SPLIT = [
  { account: '5', month: '2026-08-01', division: 'graphics', location: null, netsuite_location: '1', ...sides(-100000) },
  { account: '5', month: '2026-08-01', division: 'upfit', location: null, netsuite_location: '3', ...sides(-300000) },
  { account: '6', month: '2026-08-01', division: 'upfit', location: null, netsuite_location: '3', ...sides(120000) },
  { account: '5', month: '2026-09-01', division: 'upfit', location: null, netsuite_location: '3', ...sides(-50000) },
  { account: '7', month: '2026-09-01', division: 'shared', location: 'ofallon', netsuite_location: null, ...sides(80000) },
];
const BOOKS_TOTALS = [
  { account: '5', month: '2026-08-01', ...sides(-400000) }, { account: '6', month: '2026-08-01', ...sides(120000) },
  { account: '2', month: '2026-08-01', ...sides(400000) }, { account: '5', month: '2026-09-01', ...sides(-50000) },
  { account: '7', month: '2026-09-01', ...sides(80000) },
];

let split: unknown[];
let splitError: { message: string } | null;
let netsuiteTotals: { opening: unknown[]; netsuite: unknown[] };
let syncState: Record<string, { last_result: unknown; updated_at: string }>;
const rpcs: Array<[string, Record<string, unknown>]> = [];

/** Just enough of supabase-js for loadBuilder: a table's rows, only those with the values asked for where they have the column. */
function query(table: string) {
  const eqs: Array<[string, string]> = [];
  const rows = () => (TABLES[table] ?? []).filter((row: any) => eqs.every(([column, value]) => !(column in row) || row[column] === value));
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (column: string, value: string) => { eqs.push([column, value]); return q; },
    range: async (from: number, to: number) => ({ data: rows().slice(from, to + 1), error: null }),
    maybeSingle: async () => ({ data: syncState[eqs.at(-1)?.[1] ?? ''] ?? null, error: null }),
    then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(done, failed),
  };
  return q;
}
const service = {
  from: query,
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push([name, args]);
    if (name === 'gl_netsuite_totals') return { data: netsuiteTotals, error: null };
    if (name === 'gl_books_totals') return { data: BOOKS_TOTALS, error: null };
    if (name === 'gl_books_split_totals') return splitError ? { data: null, error: splitError } : { data: split, error: null };
    return { data: null, error: { message: `No ${name}` } };
  },
};

const get = (path: string) => new NextRequest(`https://go.bmgfleet.com${path}`);

async function sheet(res: Response): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
  return wb.worksheets[0];
}
/** Every row of the sheet, its cells from the first through `last`. */
const rowsOf = (ws: ExcelJS.Worksheet, last: number) =>
  Array.from({ length: ws.rowCount }, (_, r) => Array.from({ length: last }, (_, c) => ws.getRow(r + 1).getCell(c + 1).value ?? null));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T09:12:00Z'));
  roles = ['admin', 'super_admin'];
  split = SPLIT;
  splitError = null;
  netsuiteTotals = { opening: [{ netsuite_account_id: '2', ...sides(1000) }], netsuite: [] };
  syncState = {
    books_invoice_posting: { last_result: { partial: false }, updated_at: '2026-10-31T08:00:00Z' },
    books_netsuite_gl: { last_result: {}, updated_at: '2026-10-31T07:00:00Z' },
  };
  rpcs.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('the report builder', () => {
  it("opens on the year to date by division: a column for each, a Total, and NetSuite's names for the locations", async () => {
    const res = await builderJson(get('/api/admin/books/reports/builder'));
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(page).toMatchObject({
      company: 'BMG', posts: true, from: '2026-01-01', to: '2026-09-01', by: 'division', division: null, location: null, ties: true, copied: true,
    });
    expect(page.months[0]).toBe('2025-01-01');
    expect(page.months.at(-1)).toBe('2026-10-01');
    expect([page.lastPosting, page.lastCopy]).toEqual([
      { at: '2026-10-31T08:00:00Z', error: null, partial: false }, { at: '2026-10-31T07:00:00Z', error: null },
    ]);
    expect(rpcs.filter(([name]) => name === 'gl_books_split_totals')).toEqual([['gl_books_split_totals', { p_company: 'BMG' }]]);
    expect(page.columns.map((c: any) => c.label)).toEqual(['Upfit', 'Graphics', 'Shared', 'Total']);
    expect(page.locations).toEqual([{ key: '1', label: "O'Fallon" }, { key: '3', label: 'Kansas City' }]);
    expect(page.lines.map((l: any) => [l.label, l.amounts])).toEqual([
      ['Income', null],
      ['Sales', [350000, 100000, 0, 450000]],
      ['Total income', [350000, 100000, 0, 450000]],
      ['Cost of sales', null],
      ['Cost of goods sold', [120000, 0, 0, 120000]],
      ['Total cost of sales', [120000, 0, 0, 120000]],
      ['Gross profit', [230000, 100000, 0, 330000]],
      ['Expense', null],
      ['Rent', [0, 0, 80000, 80000]],
      ['Total expense', [0, 0, 80000, 80000]],
      ['Net ordinary income', [230000, 100000, -80000, 250000]],
      ['Net income', [230000, 100000, -80000, 250000]],
    ]);
  });

  it('takes the columns, months and filters asked for, and falls back for what it has none of', async () => {
    const page = await (await builderJson(get('/api/admin/books/reports/builder?company=BMG&by=month&from=2026-08&to=2026-09&location=1'))).json();
    expect(page).toMatchObject({ by: 'month', from: '2026-08-01', to: '2026-09-01', division: null, location: '1' });
    expect(page.columns.map((c: any) => c.label)).toEqual(['Aug 2026', 'Sep 2026', 'Total']);
    expect(page.lines.find((l: any) => l.label === 'Net income').amounts).toEqual([100000, -80000, 20000]);
    // A start after the end is January of the end's year; columns and filters it doesn't know are every one, by division.
    expect(await (await builderJson(get('/api/admin/books/reports/builder?by=weeks&from=2026-09&to=2026-08&division=nope&location=9'))).json())
      .toMatchObject({ by: 'division', from: '2026-01-01', to: '2026-08-01', division: null, location: null });
    // The other company's own books.
    split = [];
    expect(await (await builderJson(get('/api/admin/books/reports/builder?company=1084'))).json())
      .toMatchObject({ company: '1084', columns: [{ key: 'total', label: 'Total' }], divisions: [], locations: [] });
    expect(rpcs.filter(([name]) => name === 'gl_books_split_totals').at(-1)).toEqual(['gl_books_split_totals', { p_company: '1084' }]);
  });

  it('says when the split no longer comes to the profit and loss on Reports, and when no location can be read yet', async () => {
    split = SPLIT.slice(1);
    netsuiteTotals = { opening: [], netsuite: [] };
    const page = await (await builderJson(get('/api/admin/books/reports/builder'))).json();
    expect(page).toMatchObject({ ties: false, copied: false });
    // NetSuite's ledger read, with nothing before 2025 in it.
    netsuiteTotals = { opening: [], netsuite: [{ netsuite_account_id: '5', month: '2026-08-01', ...sides(-400000) }] };
    expect(await (await builderJson(get('/api/admin/books/reports/builder'))).json()).toMatchObject({ copied: true });
  });

  it("says nothing above the table when there's nothing to warn about", async () => {
    netsuiteTotals = { opening: [], netsuite: [{ netsuite_account_id: '5', month: '2026-08-01', ...sides(-400000) }] };
    const rows = rowsOf(await sheet(await builderDownload(get('/api/admin/books/reports/builder/download'))), 1).map((r) => r[0]);
    expect(rows.slice(4, 7)).toEqual(['Downloaded October 31, 2026 at 4:12 AM Central.', null, 'Number']);
  });

  it("says when a company doesn't post, nothing has posted, or the last run stopped for time", async () => {
    const notes = async (path: string) => rowsOf(await sheet(await builderDownload(get(`/api/admin/books/reports/builder/download${path}`))), 1)
      .map((r) => String(r[0] ?? ''))
      .filter((t) => /posted|post to|Still posting/.test(t));
    expect(await (await builderJson(get('/api/admin/books/reports/builder?company=NEW'))).json()).toMatchObject({ company: 'NEW', posts: false });
    expect(await notes('?company=NEW')).toEqual(["Example New Co doesn't post to FleetSuite's books yet, so nothing is in this report."]);
    syncState.books_invoice_posting.last_result = { partial: true };
    expect(await notes('')).toEqual([
      expect.stringMatching(/^Still posting: the last run \(October 31, 2026 at 3:00\sAM Central\) stopped for time, so some documents aren't in this report yet\./),
    ]);
    delete (syncState as Partial<typeof syncState>).books_invoice_posting;
    expect(await (await builderJson(get('/api/admin/books/reports/builder'))).json()).toMatchObject({ lastPosting: null });
    expect(await notes('')).toEqual(["Nothing has posted to FleetSuite's books yet."]);
  });

  it("is the page's report as an Excel file, an amount for each column, its filters in its name", async () => {
    const path = 'company=BMG&by=month&from=2026-08&to=2026-09&division=upfit&location=3';
    const res = await builderDownload(get(`/api/admin/books/reports/builder/download?${path}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(XLSX_TYPE);
    expect(res.headers.get('content-disposition')).toContain('filename="BMG Profit and Loss by Month (Upfit, Kansas City) 2026-08 to 2026-09.xlsx"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const ws = await sheet(res);
    const rows = rowsOf(ws, 5);
    expect(rows.slice(0, 4).map((r) => r[0])).toEqual([
      'Example Fleet Upfitters LLC',
      'Profit and Loss by Month',
      'August 1, 2026 to September 30, 2026',
      "FleetSuite's own books laid out as NetSuite's income statement, a column for each month and a Total. Only Upfit lines at Kansas City.",
    ]);
    const head = rows.findIndex((r) => r[0] === 'Number');
    expect(rows[head]).toEqual(['Number', 'Account', 'Aug 2026', 'Sep 2026', 'Total']);
    // Line for line the page's, in dollars.
    const page = await (await builderJson(get(`/api/admin/books/reports/builder?${path}`))).json();
    expect(rows.slice(head + 1).map((r) => [r[1], r[2], r[3], r[4]])).toEqual(page.lines.map((l: any) => [
      l.label, ...(l.amounts ? l.amounts.map((c: number) => c / 100) : [null, null, null]),
    ]));
    expect(rows.slice(head + 1).find((r) => r[1] === 'Net income')).toEqual([null, 'Net income', 1800, 500, 2300]);
  });

  it("says at the top what the page warns about", async () => {
    split = SPLIT.slice(1);
    netsuiteTotals = { opening: [], netsuite: [] };
    syncState.books_netsuite_gl.last_result = { error: 'NetSuite timed out' };
    const res = await builderDownload(get('/api/admin/books/reports/builder/download?by=total'));
    expect(res.headers.get('content-disposition')).toContain('filename="BMG Profit and Loss 2026-01 to 2026-09.xlsx"');
    const rows = rowsOf(await sheet(res), 1).map((r) => String(r[0] ?? ''));
    expect(rows.slice(1, 4)).toEqual([
      'Profit and Loss', 'January 1, 2026 to September 30, 2026', "FleetSuite's own books laid out as NetSuite's income statement.",
    ]);
    expect(rows.filter((t) => /^Something posted|^NetSuite's ledger|^The last copy/.test(t))).toEqual([
      "Something posted to FleetSuite's books while this was read, so its columns may not come to the profit and loss on Reports. Download it again.",
      "NetSuite's ledger hasn't been copied yet, so lines from its documents have no location.",
      expect.stringMatching(/^The last copy of NetSuite's ledger failed \(October 31, 2026 at 2:00\sAM Central\): NetSuite timed out$/),
    ]);
    // One month alone is named by it.
    expect((await builderDownload(get('/api/admin/books/reports/builder/download?from=2026-09&to=2026-09'))).headers.get('content-disposition'))
      .toContain('filename="BMG Profit and Loss by Division 2026-09.xlsx"');
  });

  it('says what went wrong reading the books', async () => {
    splitError = { message: 'canceling statement due to statement timeout' };
    const res = await builderJson(get('/api/admin/books/reports/builder'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'canceling statement due to statement timeout' });
    expect((await builderDownload(get('/api/admin/books/reports/builder/download'))).status).toBe(500);
  });

  it('is for whoever opens the books, the CPA too', async () => {
    roles = ['admin'];
    expect((await builderJson(get('/api/admin/books/reports/builder'))).status).toBe(403);
    expect((await builderDownload(get('/api/admin/books/reports/builder/download'))).status).toBe(403);
    expect(rpcs).toEqual([]);
    roles = ['cpa'];
    expect((await builderJson(get('/api/admin/books/reports/builder'))).status).toBe(200);
  });
});
