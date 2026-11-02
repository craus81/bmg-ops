// Books → Reports → Report builder's routes (src/app/api/admin/books/reports/builder
// and its download): what each one reads for a made-up company's books and
// hands back, the page's report and its Excel file alike, lines by account
// or by customer or vendor, months picked or moving with the calendar
// (loadBuilder and builderAsk in src/lib/books/report-data.ts), and the
// reports saved by name: listed, saved and deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';

const ME = '00000000-0000-4000-8000-0000000000a1';
const BEN = '00000000-0000-4000-8000-0000000000b2';
let roles = ['admin', 'super_admin'];
vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => roles.includes(r));
      return booksAllows(access, need)
        ? { access, user: { id: ME, email: 'ann@example.com' }, profile: { full_name: 'Ann Example' } }
        : { error: new Response('Forbidden', { status: 403 }) };
    }),
  };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET as builderJson, POST as builderPost } from '../../app/api/admin/books/reports/builder/route';
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
  books_saved_reports: [
    {
      id: 's2', company: 'BMG', name: 'all vendors last quarter', rows: 'vendor', columns: 'total', division: null, location: null,
      months: 'last_quarter', from_month: null, to_month: null, saved_by: BEN, saved_by_name: 'Ben Example',
      updated_at: '2026-10-30T10:00:00.123456+00:00',
    },
    {
      id: 's1', company: 'BMG', name: 'Graphics by month', rows: 'account', columns: 'month', division: 'graphics', location: '1',
      months: 'picked', from_month: '2026-01-01', to_month: '2026-09-01', saved_by: ME, saved_by_name: 'Ann Example',
      updated_at: '2026-10-29T09:00:00.654321+00:00',
    },
    {
      id: 's3', company: '1084', name: 'Rent by month', rows: 'account', columns: 'month', division: null, location: null,
      months: 'year_to_date', from_month: null, to_month: null, saved_by: null, saved_by_name: null,
      updated_at: '2026-10-28T08:00:00+00:00',
    },
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
/** The split by customer: Example Fleet's graphics sale in August and upfit sale in September, Example Rentals' upfit sale and its cost; the rent names none. */
const CUSTOMER_SPLIT = [
  { ...SPLIT[0], party: '301' }, { ...SPLIT[1], party: '302' }, { ...SPLIT[2], party: '302' }, { ...SPLIT[3], party: '301' },
  { ...SPLIT[4], party: null },
];
/** The split by vendor: the rent is Example Properties'. */
const VENDOR_SPLIT = SPLIT.map((r) => ({ ...r, party: r.account === '7' ? '401' : null }));
const BOOKS_TOTALS = [
  { account: '5', month: '2026-08-01', ...sides(-400000) }, { account: '6', month: '2026-08-01', ...sides(120000) },
  { account: '2', month: '2026-08-01', ...sides(400000) }, { account: '5', month: '2026-09-01', ...sides(-50000) },
  { account: '7', month: '2026-09-01', ...sides(80000) },
];

let split: unknown[];
let splitError: { message: string } | null;
let partyError: { message: string } | null;
let savedError: { message: string } | null;
let answer: { data: unknown; error: { message: string; code?: string } | null };
const inserted: Array<[string, unknown]> = [];
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
    insert: async (row: unknown) => { inserted.push([table, row]); return { error: null }; },
    then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(
      table === 'books_saved_reports' && savedError ? { data: null, error: savedError } : { data: rows(), error: null },
    ).then(done, failed),
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
    if (name === 'gl_books_party_totals') {
      if (partyError) return { data: null, error: partyError };
      return args.p_kind === 'customer'
        ? { data: { rows: CUSTOMER_SPLIT, names: { 301: 'Example Fleet Co', 302: 'Example Rentals' } }, error: null }
        : { data: { rows: VENDOR_SPLIT, names: { 401: 'Example Properties' } }, error: null };
    }
    if (name === 'books_saved_report_save' || name === 'books_saved_report_remove') return answer;
    return { data: null, error: { message: `No ${name}` } };
  },
};

const get = (path: string) => new NextRequest(`https://go.bmgfleet.com${path}`);
const post = (body: unknown) => builderPost(new NextRequest('https://go.bmgfleet.com/api/admin/books/reports/builder', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
}));
/** The page's save of a new report by name, as it sends it. */
const SAVE = {
  action: 'save', id: null, seen: null, name: '  Upfit by customer  ', company: 'BMG', rows: 'customer', by: 'month',
  division: 'upfit', location: '3', months: 'picked', from: '2026-01', to: '2026-09',
};
const saves = () => rpcs.filter(([name]) => name.startsWith('books_saved_report_')).map(([name, args]) => [name, args.p]);

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
  partyError = null;
  savedError = null;
  answer = { data: { state: 'saved', id: 's9', updated_at: '2026-10-31T09:12:00.111111+00:00' }, error: null };
  inserted.length = 0;
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
      company: 'BMG', posts: true, rows: 'account', months: 'year_to_date', from: '2026-01-01', to: '2026-09-01', by: 'division',
      division: null, location: null, ties: true, copied: true,
    });
    expect(page.monthList[0]).toBe('2025-01-01');
    expect(page.monthList.at(-1)).toBe('2026-10-01');
    // Lines by account read no split by name.
    expect(rpcs.map(([name]) => name)).not.toContain('gl_books_party_totals');
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
    expect(page).toMatchObject({ months: 'picked', by: 'month', from: '2026-08-01', to: '2026-09-01', division: null, location: '1' });
    expect(page.columns.map((c: any) => c.label)).toEqual(['Aug 2026', 'Sep 2026', 'Total']);
    expect(page.lines.find((l: any) => l.label === 'Net income').amounts).toEqual([100000, -80000, 20000]);
    // A start after the end is January of the end's year; columns and filters it doesn't know are every one, by division.
    expect(await (await builderJson(get('/api/admin/books/reports/builder?rows=items&by=weeks&from=2026-09&to=2026-08&division=nope&location=9'))).json())
      .toMatchObject({ rows: 'account', months: 'picked', by: 'division', from: '2026-01-01', to: '2026-08-01', division: null, location: null });
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
      "NetSuite's ledger hasn't been copied yet, so lines from its documents have no location, customer or vendor.",
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
    expect((await post(SAVE)).status).toBe(403);
    expect(rpcs).toEqual([]);
    roles = ['cpa'];
    expect((await builderJson(get('/api/admin/books/reports/builder'))).status).toBe(200);
  });
});

describe('the report builder by customer or vendor', () => {
  it('reads the split by name for the months asked for and lays the lines out by customer', async () => {
    const page = await (await builderJson(get('/api/admin/books/reports/builder?rows=customer&by=total&from=2026-08&to=2026-09'))).json();
    expect(rpcs.filter(([name]) => name === 'gl_books_party_totals')).toEqual([
      ['gl_books_party_totals', { p_company: 'BMG', p_kind: 'customer', p_from: '2026-08-01', p_to: '2026-09-01' }],
    ]);
    expect(page).toMatchObject({ rows: 'customer', by: 'total', ties: true });
    // The other company's, for months that move with the calendar.
    rpcs.length = 0;
    split = [];
    await builderJson(get('/api/admin/books/reports/builder?company=1084&rows=vendor&months=last_month'));
    expect(rpcs.filter(([name]) => name === 'gl_books_party_totals')).toEqual([
      ['gl_books_party_totals', { p_company: '1084', p_kind: 'vendor', p_from: '2026-09-01', p_to: '2026-09-01' }],
    ]);
    expect(page.lines.map((l: any) => [l.label, l.party ?? null, l.amounts])).toEqual([
      ['Income', null, null],
      ['Example Rentals', '302', [300000]],
      ['Example Fleet Co', '301', [150000]],
      ['Total income', null, [450000]],
      ['Cost of sales', null, null],
      ['Example Rentals', '302', [120000]],
      ['Total cost of sales', null, [120000]],
      ['Gross profit', null, [330000]],
      ['Expense', null, null],
      ['No customer', 'none', [80000]],
      ['Total expense', null, [80000]],
      ['Net ordinary income', null, [250000]],
      ['Net income', null, [250000]],
    ]);
  });

  it('is the lines by vendor as an Excel file, a vendor in the first column and no number column', async () => {
    const res = await builderDownload(get('/api/admin/books/reports/builder/download?rows=vendor&by=month&from=2026-08&to=2026-09'));
    expect(res.headers.get('content-disposition')).toContain('filename="BMG Profit and Loss by Vendor and Month 2026-08 to 2026-09.xlsx"');
    const ws = await sheet(res);
    expect(ws.name).toBe('P&L by Vendor and Month');
    const rows = rowsOf(ws, 4);
    expect(rows.slice(1, 4).map((r) => r[0])).toEqual([
      'Profit and Loss by Vendor and Month',
      'August 1, 2026 to September 30, 2026',
      "FleetSuite's own books laid out as NetSuite's income statement, a line for each vendor, a column for each month and a Total.",
    ]);
    const head = rows.findIndex((r) => r[0] === 'Vendor');
    expect(rows[head]).toEqual(['Vendor', 'Aug 2026', 'Sep 2026', 'Total']);
    expect(rows.slice(head + 1).filter((r) => r[0] === 'Example Properties' || r[0] === 'No vendor')).toEqual([
      ['No vendor', 4000, 500, 4500],
      ['No vendor', 1200, 0, 1200],
      ['Example Properties', 0, 800, 800],
    ]);
    expect(rows.slice(head + 1).find((r) => r[0] === 'Net income')).toEqual(['Net income', 2800, -300, 2500]);
    // A customer's report by itself.
    expect((await builderDownload(get('/api/admin/books/reports/builder/download?rows=customer&by=total&from=2026-09&to=2026-09')))
      .headers.get('content-disposition')).toContain('filename="BMG Profit and Loss by Customer 2026-09.xlsx"');
  });

  it('says what went wrong reading the split by name', async () => {
    partyError = { message: 'canceling statement due to statement timeout' };
    const res = await builderJson(get('/api/admin/books/reports/builder?rows=vendor'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'canceling statement due to statement timeout' });
    expect((await builderJson(get('/api/admin/books/reports/builder'))).status).toBe(200);
  });
});

describe('the report builder’s months that move with the calendar', () => {
  const monthsOf = async (query: string) => {
    const page = await (await builderJson(get(`/api/admin/books/reports/builder?${query}`))).json();
    return [page.months, page.from, page.to];
  };

  it('works them out from last month, whatever months are picked with them', async () => {
    // It's October 31, 2026: last month is September.
    expect(await monthsOf('months=year_to_date')).toEqual(['year_to_date', '2026-01-01', '2026-09-01']);
    expect(await monthsOf('months=last_month')).toEqual(['last_month', '2026-09-01', '2026-09-01']);
    expect(await monthsOf('months=last_quarter&from=2025-02&to=2025-03')).toEqual(['last_quarter', '2026-07-01', '2026-09-01']);
    expect(await monthsOf('months=last_year')).toEqual(['last_year', '2025-01-01', '2025-12-01']);
    expect(await monthsOf('months=last_12_months')).toEqual(['last_12_months', '2025-10-01', '2026-09-01']);
    // Picked, or not one it knows: the months picked; nothing at all, the year to date.
    expect(await monthsOf('months=picked&from=2026-02&to=2026-04')).toEqual(['picked', '2026-02-01', '2026-04-01']);
    expect(await monthsOf('months=fortnight&to=2026-04')).toEqual(['picked', '2026-01-01', '2026-04-01']);
    expect(await monthsOf('')).toEqual(['year_to_date', '2026-01-01', '2026-09-01']);
    expect(await monthsOf('months=picked')).toEqual(['picked', '2026-01-01', '2026-09-01']);
  });
});

describe('reports saved by name', () => {
  it("lists the company's saved reports by name, saying which this login can change", async () => {
    const page = await (await builderJson(get('/api/admin/books/reports/builder'))).json();
    // In name order whatever the case.
    expect(page.saved).toEqual([
      {
        id: 's2', name: 'all vendors last quarter', rows: 'vendor', by: 'total', division: null, location: null, months: 'last_quarter',
        from: null, to: null, savedBy: 'Ben Example', updatedAt: '2026-10-30T10:00:00.123456+00:00', canChange: true,
      },
      {
        id: 's1', name: 'Graphics by month', rows: 'account', by: 'month', division: 'graphics', location: '1', months: 'picked',
        from: '2026-01-01', to: '2026-09-01', savedBy: 'Ann Example', updatedAt: '2026-10-29T09:00:00.654321+00:00', canChange: true,
      },
    ]);
    // The bookkeeper changes only the ones they saved; 1084 has its own.
    roles = ['bookkeeper'];
    expect((await (await builderJson(get('/api/admin/books/reports/builder'))).json()).saved.map((r: any) => [r.id, r.canChange]))
      .toEqual([['s2', false], ['s1', true]]);
    expect((await (await builderJson(get('/api/admin/books/reports/builder?company=1084'))).json()).saved.map((r: any) => [r.id, r.savedBy, r.canChange]))
      .toEqual([['s3', null, false]]);
  });

  it('says what went wrong reading the saved reports', async () => {
    savedError = { message: 'permission denied for table books_saved_reports' };
    const res = await builderJson(get('/api/admin/books/reports/builder'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'permission denied for table books_saved_reports' });
  });

  it('saves a new report as whoever saves it, the months only when picked', async () => {
    const res = await post(SAVE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, id: 's9', updatedAt: '2026-10-31T09:12:00.111111+00:00' });
    expect(saves()).toEqual([['books_saved_report_save', {
      id: null, seen: null, company: 'BMG', name: 'Upfit by customer', rows: 'customer', columns: 'month', division: 'upfit', location: '3',
      months: 'picked', from: '2026-01-01', to: '2026-09-01', by: ME, by_name: 'Ann Example', owner: true,
    }]]);
    expect(inserted).toEqual([['audit_log', [{
      actor_id: ME, table_name: 'books_saved_reports', record_id: 's9', action: 'saved',
      detail: { company: 'BMG', name: 'Upfit by customer', rows: 'customer', columns: 'month', months: 'picked' },
    }]]]);

    // Months that move with the calendar keep none; the CPA saves one too, and changes one as the page saw it.
    roles = ['cpa'];
    rpcs.length = 0;
    inserted.length = 0;
    const changed = await post({ ...SAVE, id: '00000000-0000-4000-8000-000000000001', seen: '2026-10-29T09:00:00.654321+00:00', months: 'last_12_months' });
    expect(changed.status).toBe(200);
    expect(saves()[0][1]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001', seen: '2026-10-29T09:00:00.654321+00:00', months: 'last_12_months', from: null, to: null, owner: false,
    });
    expect((inserted[0][1] as any)[0]).toMatchObject({ action: 'changed' });
  });

  it("says why a report wasn't saved, in words", async () => {
    const refused = async (body: unknown) => {
      const res = await post(body);
      return [res.status, (await res.json()).error];
    };
    answer = { data: { state: 'name_taken' }, error: null };
    expect(await refused(SAVE)).toEqual([409, 'There\'s a saved report called "Upfit by customer" already: pick another name.']);
    const id = { id: '00000000-0000-4000-8000-000000000001', seen: '2026-10-29T09:00:00Z' };
    answer = { data: { state: 'changed' }, error: null };
    expect(await refused({ ...SAVE, ...id })).toEqual([409, 'That saved report was changed since you opened it: open it again.']);
    answer = { data: { state: 'gone' }, error: null };
    expect(await refused({ ...SAVE, ...id })).toEqual([409, 'That saved report was deleted since you opened it: save it as a new report.']);
    answer = { data: { state: 'not_yours' }, error: null };
    expect(await refused({ ...SAVE, ...id })).toEqual([
      403, 'Only whoever saved that report, or a super admin, can change or delete it. Save it as a new report instead.',
    ]);
    answer = { data: null, error: { message: 'insert or update violates foreign key constraint', code: '23503' } };
    expect(await refused({ ...SAVE, company: 'NOPE' })).toEqual([400, 'The books have no company NOPE.']);
    answer = { data: null, error: { message: 'duplicate key value', code: '23505' } };
    expect(await refused(SAVE)).toEqual([409, 'There\'s a saved report called "Upfit by customer" already: pick another name.']);
    answer = { data: null, error: { message: 'canceling statement due to statement timeout' } };
    expect(await refused(SAVE)).toEqual([500, "Couldn't save the report: canceling statement due to statement timeout"]);
    answer = { data: { state: 'odd' }, error: null };
    expect(await refused(SAVE)).toEqual([500, 'Couldn\'t save the report: the books answered {"state":"odd"}']);
    expect(inserted).toEqual([]);
  });

  it('refuses what a saved report can’t be before asking the books', async () => {
    const status = async (body: unknown) => (await post(body)).status;
    expect(await (await post({ ...SAVE, months: 'picked', from: null })).json()).toEqual({ error: 'Pick the months the report covers.' });
    expect(await (await post({ ...SAVE, months: 'picked', to: null })).json()).toEqual({ error: 'Pick the months the report covers.' });
    expect(await (await post({ ...SAVE, from: '2024-12' })).json()).toEqual({ error: "Reports start from January 2025, when FleetSuite's copy of NetSuite starts." });
    expect(await (await post({ ...SAVE, from: '2026-10', to: '2026-09' })).json()).toEqual({ error: "The report's first month comes after its last." });
    expect(await (await post({ ...SAVE, id: '00000000-0000-4000-8000-000000000001' })).json())
      .toEqual({ error: 'Open the saved report again before saving changes to it.' });
    for (const body of [
      { ...SAVE, name: '   ' }, { ...SAVE, name: 'x'.repeat(61) }, { ...SAVE, rows: 'items' }, { ...SAVE, by: 'week' }, { ...SAVE, months: 'soon' },
      { ...SAVE, division: 'paint' }, { ...SAVE, location: 'O Fallon' }, { ...SAVE, from: '2026-13' },
      { ...SAVE, id: 'abc', seen: '2026-10-29T09:00:00Z' },
      { action: 'rename' }, 'not json',
    ]) expect(await status(body)).toBe(400);
    expect(await status({ ...SAVE, name: 'x'.repeat(60), months: 'last_year', from: null, to: null, division: null, location: 'own:denver' })).toBe(200);
    // One month alone.
    expect(await status({ ...SAVE, from: '2026-09', to: '2026-09' })).toBe(200);
    expect(saves()).toHaveLength(2);
    expect(saves()[1][1]).toMatchObject({ from: '2026-09-01', to: '2026-09-01' });
  });

  it('deletes a saved report as the page saw it, only its saver or a super admin', async () => {
    answer = { data: { state: 'removed', name: 'Graphics by month' }, error: null };
    const body = { action: 'remove', id: '00000000-0000-4000-8000-000000000001', seen: '2026-10-29T09:00:00.654321+00:00' };
    roles = ['bookkeeper'];
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true, name: 'Graphics by month' });
    expect(saves()).toEqual([['books_saved_report_remove', { id: body.id, seen: body.seen, by: ME, owner: false }]]);
    expect(inserted).toEqual([['audit_log', [{
      actor_id: ME, table_name: 'books_saved_reports', record_id: body.id, action: 'deleted', detail: { name: 'Graphics by month' },
    }]]]);

    const refused = async () => {
      const r = await post(body);
      return [r.status, (await r.json()).error];
    };
    inserted.length = 0;
    answer = { data: { state: 'changed' }, error: null };
    expect(await refused()).toEqual([409, 'That saved report was changed since you opened it: open it again.']);
    answer = { data: { state: 'gone' }, error: null };
    expect(await refused()).toEqual([409, 'That saved report was deleted already.']);
    answer = { data: { state: 'not_yours' }, error: null };
    expect(await refused()).toEqual([403, 'Only whoever saved that report, or a super admin, can change or delete it.']);
    answer = { data: null, error: { message: 'canceling statement due to statement timeout' } };
    expect(await refused()).toEqual([500, "Couldn't delete the report: canceling statement due to statement timeout"]);
    answer = { data: {}, error: null };
    expect(await refused()).toEqual([500, "Couldn't delete the report: the books answered {}"]);
    expect(inserted).toEqual([]);
    expect((await post({ action: 'remove', id: body.id })).status).toBe(400);

    roles = ['super_admin'];
    answer = { data: { state: 'removed', name: 'Graphics by month' }, error: null };
    rpcs.length = 0;
    expect((await post(body)).status).toBe(200);
    expect(saves()[0][1]).toMatchObject({ owner: true });
  });
});
