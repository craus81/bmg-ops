// Books → Inventory value (src/app/api/admin/books/inventory-value and its
// download): what each reads for made-up stock and inventory accounts and
// hands back, the month asked for or last month, and the Excel file for one
// company with what the page warns about at the top.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import type { MonthEndData } from './inventory-value';

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

import { GET as valueJson } from '../../app/api/admin/books/inventory-value/route';
import { GET as valueDownload } from '../../app/api/admin/books/inventory-value/download/route';
import { ENTRIES_SHOWN, valueMonth } from './inventory-value-data';
import { XLSX_TYPE } from './report-workbook';

const zero = {
  number: null, name: null, type: 'other_current_asset', ledger_start: '0', ledger_moves: '0', items_start: '0', items_moves_before: '0',
  items_moves: '0', netsuite_moves: '0', books_moves: '0', moves: [], entries: 0, entries_total: '0', month_entries: 0,
  month_entries_total: '0', kinds: [], rows: [], usual: true,
};

/**
 * Made-up stock at a month's end: BMG has two ladder racks at Wentzville
 * worth 400.00 on its 1200 Inventory account, which FleetSuite's books and
 * NetSuite's both have at 400.00; 1084 has one bin worth 50.00.
 */
const READ = (month: string): MonthEndData => ({
  month,
  rows: [
    { company: 'BMG', item_id: '9001', location_id: '11', quantity: '2', value: '400.00' },
    { company: '1084', item_id: '9002', location_id: '21', quantity: '1', value: '50.00' },
  ],
  items: [
    { netsuite_id: '9001', name: 'LDR-24', display_name: 'Ladder rack 24 in', active: true },
    { netsuite_id: '9002', name: 'BIN-1', display_name: null, active: true },
  ],
  locations: [{ netsuite_id: '11', name: 'Wentzville' }, { netsuite_id: '21', name: 'Cool Springs' }],
  parts: [
    { ...zero, company: 'BMG', account_id: '190', number: '1200', name: 'Inventory', items_moves: '400.00', ledger_moves: '400.00', netsuite_moves: '400.00', books_moves: '400.00' },
    { ...zero, company: '1084', account_id: '290', items_moves: '50.00', ledger_moves: '50.00', netsuite_moves: '50.00', books_moves: '50.00' },
  ],
  netsuite_through: [{ company: 'BMG', month: '2026-10-01' }, { company: '1084', month: '2026-10-01' }],
});

let read: (month: string) => { data: MonthEndData | null; error: { message: string } | null };
/** A table whose read fails. */
let failing: string | null = null;
let syncState: Record<string, { last_result: unknown; updated_at: string }>;
const rpcs: Array<[string, Record<string, unknown>]> = [];
const COMPANIES = [
  { code: '1084', name: '1084 Cool Springs', legal_name: null },
  { code: 'BMG', name: 'BMG', legal_name: 'Example Fleet Upfitters LLC' },
];

/** Just enough of supabase-js for loadInventoryValue. */
function query(table: string) {
  let eq: string | null = null;
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (_column: string, value: string) => { eq = value; return q; },
    maybeSingle: async () => (failing === table
      ? { data: null, error: { message: `Couldn't read ${table}` } }
      : { data: (eq && syncState[eq]) ?? null, error: null }),
    then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(failing === table
      ? { data: null, error: { message: `Couldn't read ${table}` } }
      : { data: table === 'gl_companies' ? COMPANIES : [], error: null }).then(done, failed),
  };
  return q;
}
const service = {
  from: query,
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push([name, args]);
    if (name === 'gl_stock_month_end') return read(args.p_month as string);
    return { data: null, error: { message: `No ${name}` } };
  },
};

const get = (path: string) => new NextRequest(`https://go.bmgfleet.com${path}`);
const months = () => rpcs.map(([name, args]) => [name, args.p_month, args.p_limit]);

async function sheets(res: Response): Promise<ExcelJS.Worksheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
  return wb.worksheets;
}
const firstCells = (ws: ExcelJS.Worksheet) => Array.from({ length: ws.rowCount }, (_, r) => ws.getRow(r + 1).getCell(1).value ?? null);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T09:12:00Z'));
  roles = ['admin', 'super_admin'];
  read = (month) => ({ data: READ(month), error: null });
  failing = null;
  syncState = {
    books_netsuite_stock: { last_result: { read: 3, added: 0, changed: 0, unchanged: 3, lines: 6 }, updated_at: '2026-10-31T06:29:00Z' },
    books_invoice_posting: { last_result: { partial: false }, updated_at: '2026-10-31T07:41:00Z' },
  };
  rpcs.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('Inventory value', () => {
  it("reads last month when none is asked for, every company's stock and accounts, and how the runs it rests on went", async () => {
    const res = await valueJson(get('/api/admin/books/inventory-value'));
    expect(res.status).toBe(200);
    // The month's first and then the biggest hundred documents with no stocked item on each account.
    expect(ENTRIES_SHOWN).toBe(100);
    expect(months()).toEqual([['gl_stock_month_end', '2026-09-01', 100]]);
    const page = await res.json();
    expect(page).toMatchObject({
      month: '2026-09-01', first: '2025-01-01', through: '2026-10-01',
      names: COMPANIES,
      lastCopy: { at: '2026-10-31T06:29:00Z', error: null, partial: false },
      lastPosting: { at: '2026-10-31T07:41:00Z', error: null, partial: false },
    });
    expect(page.value.companies.map((c: any) => [c.company, c.value, c.accounts.map((a: any) => [a.account, a.items.end, a.books, a.apart])])).toEqual([
      ['BMG', 40000, [['1200 Inventory', 40000, 40000, 0]]],
      ['1084', 5000, [['NetSuite account 290', 5000, 5000, 0]]],
    ]);
    expect(page.value.companies[0].lines).toEqual([expect.objectContaining({ item: 'LDR-24', location: 'Wentzville', quantity: 2, value: 40000, averageCost: 20000 })]);
  });

  it('reads the month asked for from January 2025 through this one, and last month for any other', async () => {
    for (const [asked, month] of [
      ['2026-03', '2026-03-01'], ['2025-01', '2025-01-01'], ['2026-10', '2026-10-01'],
      ['2024-12', '2026-09-01'], ['2026-11', '2026-09-01'], ['March', '2026-09-01'], ['2026-3', '2026-09-01'],
    ]) {
      rpcs.length = 0;
      const page = await (await valueJson(get(`/api/admin/books/inventory-value?month=${asked}`))).json();
      expect([asked, page.month, months()[0][1]]).toEqual([asked, month, month]);
    }
    // In January 2025 there's no month before it to read.
    expect(valueMonth(new URLSearchParams(), '2025-01-15')).toEqual({ month: '2025-01-01', through: '2025-01-01' });
    expect(valueMonth(new URLSearchParams(), '2026-01-02')).toEqual({ month: '2025-12-01', through: '2026-01-01' });
  });

  it("says when the read or either run's record fails, and takes a run that failed or stopped for time from its record", async () => {
    syncState.books_netsuite_stock.last_result = { error: 'Login failed', partial: true };
    syncState.books_invoice_posting.last_result = { error: 'Deadlock', partial: true };
    const page = await (await valueJson(get('/api/admin/books/inventory-value'))).json();
    expect(page.lastCopy).toEqual({ at: '2026-10-31T06:29:00Z', error: 'Login failed', partial: true });
    expect(page.lastPosting).toEqual({ at: '2026-10-31T07:41:00Z', error: 'Deadlock', partial: true });
    syncState.books_invoice_posting.last_result = null;
    delete syncState.books_netsuite_stock;
    const later = await (await valueJson(get('/api/admin/books/inventory-value'))).json();
    expect(later.lastCopy).toBeNull();
    expect(later.lastPosting).toEqual({ at: '2026-10-31T07:41:00Z', error: null, partial: false });
    delete syncState.books_invoice_posting;
    expect((await (await valueJson(get('/api/admin/books/inventory-value'))).json()).lastPosting).toBeNull();

    for (const table of ['gl_companies', 'sync_state']) {
      failing = table;
      const res = await valueJson(get('/api/admin/books/inventory-value'));
      expect([table, res.status, await res.json()]).toEqual([table, 500, { error: `Couldn't read ${table}` }]);
    }
    failing = null;

    read = () => ({ data: null, error: { message: 'gl: month must be from January 2025, when the stock copy starts' } });
    for (const route of [valueJson, valueDownload]) {
      const res = await route(get('/api/admin/books/inventory-value'));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'gl: month must be from January 2025, when the stock copy starts' });
    }
  });

  it('is for whoever opens the books, the CPA too, and no one else', async () => {
    roles = ['admin'];
    expect((await valueJson(get('/api/admin/books/inventory-value'))).status).toBe(403);
    expect((await valueDownload(get('/api/admin/books/inventory-value/download'))).status).toBe(403);
    expect(rpcs).toEqual([]);
    roles = ['cpa'];
    expect((await valueJson(get('/api/admin/books/inventory-value'))).status).toBe(200);
    expect((await valueDownload(get('/api/admin/books/inventory-value/download'))).status).toBe(200);
  });
});

describe("Inventory value's Excel download", () => {
  it("is one company's month as an .xlsx file: BMG's last month when none is asked for", async () => {
    const res = await valueDownload(get('/api/admin/books/inventory-value/download'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(XLSX_TYPE);
    expect(res.headers.get('content-disposition'))
      .toBe(`attachment; filename="BMG Inventory value 2026-09-30.xlsx"; filename*=UTF-8''BMG%20Inventory%20value%202026-09-30.xlsx`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const bytes = Number(res.headers.get('content-length'));
    const files = await sheets(res.clone());
    expect(bytes).toBe((await res.arrayBuffer()).byteLength);
    expect(files.map((s) => s.name)).toEqual(['Inventory value', 'Ties to the accounts']);
    const [items] = files;
    // Nothing to warn about: the header follows the download time and a blank row.
    expect(firstCells(items).slice(0, 8)).toEqual([
      'Example Fleet Upfitters LLC', 'Inventory value', 'As of September 30, 2026', expect.stringMatching(/^Each item at each location/),
      expect.stringMatching(/^Downloaded October 31, 2026 at 4:12\sAM Central\.$/), null, 'Item', 'LDR-24',
    ]);
  });

  it('is the month and company asked for, named by its name when it has no legal name, else BMG', async () => {
    const res = await valueDownload(get('/api/admin/books/inventory-value/download?month=2026-03&company=1084'));
    expect(months()).toEqual([['gl_stock_month_end', '2026-03-01', ENTRIES_SHOWN]]);
    expect(res.headers.get('content-disposition')).toContain('filename="1084 Inventory value 2026-03-31.xlsx"');
    const [items] = await sheets(res);
    expect(firstCells(items).slice(0, 3)).toEqual(['1084 Cool Springs', 'Inventory value', 'As of March 31, 2026']);
    expect(firstCells(items).at(-2)).toBe('BIN-1');

    const other = await valueDownload(get('/api/admin/books/inventory-value/download?company=ACME'));
    expect(other.headers.get('content-disposition')).toContain('filename="BMG Inventory value 2026-09-30.xlsx"');
  });

  it("says at the top what the page warns about: this month isn't over, the stock copy stopped for time, NetSuite read short", async () => {
    syncState.books_netsuite_stock.last_result = { partial: true };
    const res = await valueDownload(get('/api/admin/books/inventory-value/download?month=2026-10'));
    const [items, ties] = await sheets(res);
    const notes = (ws: ExcelJS.Worksheet) => firstCells(ws).slice(5, 7);
    expect(notes(items)).toEqual([
      "October 2026 isn't over yet, so this is where it stood when the file was made.",
      expect.stringMatching(/^Still copying NetSuite's stock moves: the last run \(October 31, 2026 at 1:29\sAM Central\) stopped for time/),
    ]);
    expect(notes(ties)).toEqual(notes(items));

    read = (month) => ({ data: { ...READ(month), netsuite_through: [{ company: 'BMG', month: '2026-08-01' }] }, error: null });
    syncState.books_netsuite_stock.last_result = {};
    const short = await sheets(await valueDownload(get('/api/admin/books/inventory-value/download')));
    expect(firstCells(short[0])[5]).toBe("NetSuite's own totals for BMG are read through August 2026, so NetSuite's balance sheet stops there.");
  });

  it('says so when no company has stock or an inventory account that month', async () => {
    read = (month) => ({ data: { ...READ(month), rows: [], parts: [] }, error: null });
    const res = await valueDownload(get('/api/admin/books/inventory-value/download?month=2025-01'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No company has stock or an inventory account that month.' });
    // The page shows it empty.
    expect((await (await valueJson(get('/api/admin/books/inventory-value?month=2025-01'))).json()).value).toEqual({ month: '2025-01-01', companies: [] });
  });
});
