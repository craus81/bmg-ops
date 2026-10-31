// Books → Reports' Excel downloads (src/app/api/admin/books/reports/download
// and src/app/api/admin/books/reports/detail/download): what each one reads
// for a made-up company's books and hands back, next to the page's own
// routes, which read the same way (loadReports, reportRange and
// loadAccountDetail in src/lib/books/report-data.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import type { AccountDocumentData, AccountDocumentsData } from './report-detail';

let superAdmin = true;
vi.mock('@/lib/api-auth', () => ({
  requireSuperAdmin: vi.fn(async () => (superAdmin ? {} : { error: new Response('Forbidden', { status: 403 }) })),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET as reportJson } from '../../app/api/admin/books/reports/route';
import { GET as reportDownload } from '../../app/api/admin/books/reports/download/route';
import { GET as detailJson } from '../../app/api/admin/books/reports/detail/route';
import { GET as detailDownload } from '../../app/api/admin/books/reports/detail/download/route';
import { XLSX_TYPE } from './report-workbook';

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });
const account = (id: string, ns: string | null, number: string, name: string, type: string, parent: string | null = null) => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: type === 'income' || type === 'expense' ? 'income_statement' : 'balance_sheet', parent_id: parent, company_id: null,
});

/**
 * The made-up books of src/lib/books/report-workbook.test.ts: 5,000.00 in the
 * bank and in retained earnings before 2025; a 2,000.00 upfit invoiced and
 * paid in June 2025; in August 2026 an invoice FleetSuite has at 1,200.00 and
 * NetSuite at 1,250.00; September's rent; shop supplies only FleetSuite has.
 */
const BOTH: Array<[string, string, number]> = [
  ['2', '2025-06-01', 200000], ['6', '2025-06-01', -200000], ['1', '2025-06-01', 200000], ['2', '2025-06-01', -200000],
  ['7', '2026-09-01', 80000], ['1', '2026-09-01', -80000],
];
const TABLES: Record<string, unknown[]> = {
  gl_companies: [
    { id: 'c1', code: '1084', name: '1084', legal_name: null, netsuite_subsidiary_id: '2' },
    { id: 'c2', code: 'BMG', name: 'BMG', legal_name: 'Example Fleet Upfitters LLC', netsuite_subsidiary_id: '1' },
  ],
  gl_accounts: [
    account('a1', '1', '1000', 'Checking', 'bank'),
    account('a2', '2', '1200', 'Receivables', 'accounts_receivable'),
    account('a4', '4', '3200', 'Retained Earnings', 'equity'),
    account('a5', '5', '4000', 'Sales', 'income'),
    account('a6', '6', '4010', 'Upfit labor', 'income', 'a5'),
    account('a7', '7', '6000', 'Rent', 'expense'),
    account('a8', null, '6900', 'Shop supplies', 'expense'),
  ],
};
const NETSUITE_TOTALS = {
  opening: [{ netsuite_account_id: '1', ...sides(500000) }, { netsuite_account_id: '4', ...sides(-500000) }],
  netsuite: [
    ...BOTH.map(([a, month, c]) => ({ netsuite_account_id: a, month, ...sides(c) })),
    { netsuite_account_id: '2', month: '2026-08-01', ...sides(125000) }, { netsuite_account_id: '6', month: '2026-08-01', ...sides(-125000) },
  ],
};
const BOOKS_TOTALS = [
  ...BOTH.map(([a, month, c]) => ({ account: a, month, ...sides(c) })),
  { account: '2', month: '2026-08-01', ...sides(120000) }, { account: '6', month: '2026-08-01', ...sides(-120000) },
  { account: 'fs:a8', month: '2026-09-01', ...sides(2500) }, { account: '1', month: '2026-09-01', ...sides(-2500) },
];

/** The August invoice on Receivables, as migration 400 lists it. */
const INVOICE: AccountDocumentData = {
  doc: '501', netsuite: '1250.00', fleetsuite: '1200.00', kind: 'invoice', type: 'CustInvc', number: 'INV1001',
  month: '2026-08-01', date: '2026-08-14', name: 'Example Fleet Co', memo: null, entry_no: 1, entries: 1,
};

let documents: AccountDocumentsData;
let documentsError: { message: string } | null;
let syncState: Record<string, { last_result: unknown; updated_at: string }>;
const rpcs: Array<[string, Record<string, unknown>]> = [];

/** Just enough of supabase-js for loadReports and loadAccountDetail. */
function query(table: string) {
  let eq: string | null = null;
  const rows = () => TABLES[table] ?? [];
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (_column: string, value: string) => { eq = value; return q; },
    range: async (from: number, to: number) => ({ data: rows().slice(from, to + 1), error: null }),
    maybeSingle: async () => ({ data: (eq && syncState[eq]) ?? null, error: null }),
    then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(done, failed),
  };
  return q;
}
const service = {
  from: query,
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push([name, args]);
    if (name === 'gl_netsuite_totals') return { data: NETSUITE_TOTALS, error: null };
    if (name === 'gl_books_totals') return { data: BOOKS_TOTALS, error: null };
    if (name === 'gl_books_account_documents') return documentsError ? { data: null, error: documentsError } : { data: documents, error: null };
    return { data: null, error: { message: `No ${name}` } };
  },
};

const get = (path: string) => new NextRequest(`https://go.bmgfleet.com${path}`);
const documentReads = () => rpcs.filter(([name]) => name === 'gl_books_account_documents').map(([, args]) => args);

async function sheet(res: Response): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
  return wb.worksheets[0];
}
/** Every row of the sheet, its cells from the first through `last`. */
const rowsOf = (ws: ExcelJS.Worksheet, last: number) =>
  Array.from({ length: ws.rowCount }, (_, r) => Array.from({ length: last }, (_, c) => ws.getRow(r + 1).getCell(c + 1).value ?? null));
/** The rows under the header row, whose first cell is `first`. */
function under(ws: ExcelJS.Worksheet, first: string, last: number) {
  const all = rowsOf(ws, last);
  return all.slice(all.findIndex((r) => r[0] === first) + 1);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T09:12:00Z'));
  superAdmin = true;
  documents = { documents: 1, differing: 1, netsuite: '1250.00', fleetsuite: '1200.00', rows: [INVOICE] };
  documentsError = null;
  syncState = {
    books_invoice_posting: { last_result: { partial: false }, updated_at: '2026-10-31T08:00:00Z' },
    books_netsuite_gl: { last_result: {}, updated_at: '2026-10-31T07:00:00Z' },
  };
  rpcs.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe("a report's Excel download", () => {
  it('is the report the page shows, every line with both sides and the difference, as an .xlsx file', async () => {
    const path = 'company=BMG&report=balance_sheet&from=2026-01&to=2026-09';
    const res = await reportDownload(get(`/api/admin/books/reports/download?${path}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(XLSX_TYPE);
    expect(res.headers.get('content-disposition'))
      .toBe(`attachment; filename="BMG Balance Sheet 2026-09-30.xlsx"; filename*=UTF-8''BMG%20Balance%20Sheet%202026-09-30.xlsx`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const bytes = Number(res.headers.get('content-length'));
    const ws = await sheet(res.clone());
    expect(bytes).toBe((await res.arrayBuffer()).byteLength);

    expect(rowsOf(ws, 1).slice(0, 2).map((r) => r[0])).toEqual(['Example Fleet Upfitters LLC', 'Balance Sheet']);
    // Nothing to warn about: the header follows the download time and a blank row.
    expect(rowsOf(ws, 1).slice(4, 7).map((r) => r[0])).toEqual([expect.stringMatching(/^Downloaded /), null, 'Number']);
    const page = await (await reportJson(get(`/api/admin/books/reports?${path}`))).json();
    expect(page).toMatchObject({ report: 'balance_sheet', from: '2026-01-01', to: '2026-09-01' });
    // Line for line the page's, in dollars.
    const dollars = (cents: number | null) => (cents === null ? null : cents / 100);
    expect(under(ws, 'Number', 3).map((r) => [r[1], r[2]])).toEqual(page.lines.map((l: any) => [
      l.inChart === false ? `${l.label} (not in the chart yet)` : l.label, dollars(l.fleetsuite),
    ]));
    expect(under(ws, 'Number', 5).find((r) => r[1] === 'Total liabilities and equity')).toEqual([null, 'Total liabilities and equity', 7375, 7450, -75]);
  });

  it("says at the top what the page warns about: a posting run that stopped for time, a copy that failed", async () => {
    syncState.books_invoice_posting.last_result = { partial: true };
    syncState.books_netsuite_gl.last_result = { error: 'NetSuite timed out' };
    const ws = await sheet(await reportDownload(get('/api/admin/books/reports/download?company=BMG&report=profit_and_loss')));
    const notes = rowsOf(ws, 1).map((r) => String(r[0] ?? '')).filter((t) => /^Still posting|^The last copy/.test(t));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^Still posting: the last run \(October 31, 2026 at 3:00\sAM Central\) stopped for time, so some documents aren't in this report yet\./);
    expect(notes[1]).toMatch(/^The last copy of NetSuite's ledger failed \(October 31, 2026 at 2:00\sAM Central\): NetSuite timed out$/);
  });

  it("covers last month's profit and loss when no months are asked for, as the page does", async () => {
    const res = await reportDownload(get('/api/admin/books/reports/download'));
    expect(res.headers.get('content-disposition')).toContain('filename="BMG Profit and Loss 2026-09.xlsx"');
    const page = await (await reportJson(get('/api/admin/books/reports'))).json();
    expect(page).toMatchObject({ company: 'BMG', report: 'profit_and_loss', from: '2026-09-01', to: '2026-09-01' });
    // A start after the end is the end's month alone, on both.
    const late = await reportDownload(get('/api/admin/books/reports/download?report=trial_balance&from=2026-09&to=2026-08'));
    expect(late.headers.get('content-disposition')).toContain('filename="BMG Trial Balance 2026-08-31.xlsx"');
    expect(await (await reportJson(get('/api/admin/books/reports?report=trial_balance&from=2026-09&to=2026-08'))).json())
      .toMatchObject({ report: 'trial_balance', from: '2026-08-01', to: '2026-08-01' });
  });

  it('is for super admins alone', async () => {
    superAdmin = false;
    expect((await reportDownload(get('/api/admin/books/reports/download?company=BMG'))).status).toBe(403);
    expect(rpcs).toEqual([]);
  });
});

describe("an account line's Excel download", () => {
  const PATH = 'company=BMG&account=2&report=balance_sheet&from=2026-08&to=2026-09';

  it('lists every document, by date, with each side running from the balance before the months to the line', async () => {
    // Even from the page's "only the ones that differ": a running balance needs them all.
    const res = await detailDownload(get(`/api/admin/books/reports/detail/download?${PATH}&only=differs`));
    expect(res.status).toBe(200);
    expect(documentReads()).toEqual([
      { p_company: 'BMG', p_account: '2', p_from: '2026-08-01', p_to: '2026-09-01', p_differs: false, p_limit: 20000 },
    ]);
    expect(res.headers.get('content-type')).toBe(XLSX_TYPE);
    expect(res.headers.get('content-disposition')).toContain('filename="BMG 1200 Receivables 2026-08 to 2026-09.xlsx"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const ws = await sheet(res);
    expect(rowsOf(ws, 1).slice(0, 2).map((r) => r[0])).toEqual(['Example Fleet Upfitters LLC', '1200 Receivables']);
    expect(rowsOf(ws, 1).slice(4, 7).map((r) => r[0])).toEqual([expect.stringMatching(/^Downloaded /), null, 'Date']);
    expect(under(ws, 'Date', 11).map((r) => [r[1], r[2], r[3], r[5], r[6], r[7], r[8], r[9], r[10]])).toEqual([
      ['Balance at the end of July 2026', null, null, null, null, 0, 0, 0, null],
      ['Invoice', 'INV1001', 'Example Fleet Co', 1200, 1250, -50, 1200, 1250, null],
      ['Balance at the end of September 2026', null, null, null, null, -50, 1200, 1250, null],
    ]);
  });

  it("takes earlier years' net income into retained earnings on January 1, as the balance sheet does", async () => {
    documents = { documents: 0, differing: 0, netsuite: '0', fleetsuite: '0', rows: [] };
    const res = await detailDownload(get('/api/admin/books/reports/detail/download?company=BMG&account=4&report=balance_sheet&from=2026-01&to=2026-01'));
    const ws = await sheet(res);
    // 2025's upfit, 2,000.00, on top of the 5,000.00 both sides started with.
    expect(under(ws, 'Date', 10).map((r) => [r[0], r[1], r[5], r[6], r[8], r[9]])).toEqual([
      [null, 'Balance at the end of December 2025', null, null, 5000, 5000],
      [new Date('2026-01-01T00:00:00Z'), "Earlier years' net income, taken into retained earnings at the year's start", 2000, 2000, 7000, 7000],
      [null, 'Balance at the end of January 2026', null, null, 7000, 7000],
    ]);
  });

  it("reads an income account's documents as the profit and loss shows them, and names an account the chart doesn't have", async () => {
    documents = { documents: 1, differing: 1, netsuite: '-1250.00', fleetsuite: '-1200.00', rows: [{ ...INVOICE, netsuite: '-1250.00', fleetsuite: '-1200.00' }] };
    const income = await (await detailJson(get('/api/admin/books/reports/detail?company=BMG&account=6&report=profit_and_loss&from=2026-08&to=2026-08'))).json();
    expect(income).toMatchObject({ copied: 125000, copyHolds: true, moved: { fleetsuite: 120000, netsuite: 125000 } });
    expect(income.rows[0]).toMatchObject({ fleetsuite: 120000, netsuite: 125000 });

    NETSUITE_TOTALS.netsuite.push({ netsuite_account_id: '99', month: '2026-08-01', ...sides(5000) });
    try {
      const res = await detailDownload(get('/api/admin/books/reports/detail/download?company=BMG&account=99&report=balance_sheet&from=2026-08&to=2026-08'));
      expect(res.headers.get('content-disposition')).toContain('filename="BMG NetSuite account 99 2026-08.xlsx"');
      const page = await (await detailJson(get('/api/admin/books/reports/detail?company=BMG&account=99&report=balance_sheet&from=2026-08&to=2026-08'))).json();
      expect(page.account).toEqual({ key: '99', number: null, name: 'NetSuite account 99', inChart: false });
    } finally {
      NETSUITE_TOTALS.netsuite.pop();
    }
  });

  it('says in red when it lists only part of the documents', async () => {
    documents = { ...documents, documents: 25000, differing: 25000 };
    const ws = await sheet(await detailDownload(get(`/api/admin/books/reports/detail/download?${PATH}`)));
    const note = ws.getRow(rowsOf(ws, 1).findIndex((r) => String(r[0]).startsWith('This file lists')) + 1).getCell(1);
    expect(note.value).toBe('This file lists the first 1 of 25,000 documents, by date, so the running balances stop short of the line. Pick fewer months for the rest.');
    expect(note.font?.color?.argb).toBe('FFC00000');
  });

  it("leaves the page's own detail at 1,000 documents, and its only=differs", async () => {
    const page = await (await detailJson(get(`/api/admin/books/reports/detail?${PATH}&only=differs`))).json();
    expect(documentReads()).toEqual([
      { p_company: 'BMG', p_account: '2', p_from: '2026-08-01', p_to: '2026-09-01', p_differs: true, p_limit: 1000 },
    ]);
    expect(page).toMatchObject({
      company: 'BMG', report: 'balance_sheet', from: '2026-08-01', to: '2026-09-01', only: 'differs',
      account: { key: '2', number: '1200', name: 'Receivables', inChart: true },
      starting: { fleetsuite: 0, netsuite: 0 }, ending: { fleetsuite: 120000, netsuite: 125000 },
      documents: 1, differing: 1, copied: 125000, copyHolds: true,
    });
    expect(page.rows).toEqual([expect.objectContaining({ number: 'INV1001', fleetsuite: 120000, netsuite: 125000, only: null })]);
  });

  it("turns away an account the books don't have, and says when the documents can't be read", async () => {
    for (const route of [detailDownload, detailJson]) {
      const res = await route(get('/api/admin/books/reports/detail/download?company=BMG&account=999&report=balance_sheet'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'That account has nothing in these books' });
    }
    expect(documentReads()).toEqual([]);

    documentsError = { message: 'statement timeout' };
    const failed = await detailDownload(get(`/api/admin/books/reports/detail/download?${PATH}`));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'statement timeout' });
  });

  it('is for super admins alone', async () => {
    superAdmin = false;
    expect((await detailDownload(get(`/api/admin/books/reports/detail/download?${PATH}`))).status).toBe(403);
    expect(rpcs).toEqual([]);
  });
});
