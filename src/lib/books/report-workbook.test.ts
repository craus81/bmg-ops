// Books → Reports and an account line's detail as Excel files
// (src/lib/books/report-workbook.ts): made-up books built into each workbook,
// then read back the way Excel would, cell by cell.
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { lineSpan, report, yearClosings, type ReportAccount, type ReportAmount, type ReportData, type ReportKind } from './reports';
import { runningBalances, type DetailDocument } from './report-detail';
import type { TbAmount } from './trial-balance';
import {
  accountFileName, accountWorkbook, detailNotes, reportFileName, reportNotes, reportWorkbook, sheetName, XLSX_TYPE,
  type WorkbookFile, type WorkbookNote,
} from './report-workbook';

const INCOME_STATEMENT = new Set(['income', 'expense']);
const account = (id: string, ns: string | null, number: string, name: string, type: string, parent: string | null = null): ReportAccount => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: INCOME_STATEMENT.has(type) ? 'income_statement' : 'balance_sheet', parent_id: parent,
});
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });
const ns = (acct: string, month: string | undefined, cents: number): TbAmount => ({ netsuite_account_id: acct, ...sides(cents), ...(month ? { month } : {}) });
const fs = (acct: string, month: string, cents: number): ReportAmount => ({ account: acct, month, ...sides(cents) });

/**
 * Made-up books: 5,000.00 in the bank and in retained earnings before 2025; a
 * 2,000.00 upfit invoiced and paid in June 2025; in August 2026 an invoice
 * FleetSuite has at 1,200.00 and NetSuite at 1,250.00; September's rent; and
 * shop supplies only FleetSuite has.
 */
const SHOP = 'fs:a8';
function books(): ReportData {
  const both: Array<[string, string, number]> = [
    ['2', '2025-06-01', 200000], ['6', '2025-06-01', -200000], ['1', '2025-06-01', 200000], ['2', '2025-06-01', -200000],
    ['7', '2026-09-01', 80000], ['1', '2026-09-01', -80000],
  ];
  return {
    company: 'BMG',
    accounts: [
      account('a1', '1', '1000', 'Checking', 'bank'),
      account('a2', '2', '1200', 'Receivables', 'accounts_receivable'),
      account('a4', '4', '3200', 'Retained Earnings', 'equity'),
      account('a5', '5', '4000', 'Sales', 'income'),
      account('a6', '6', '4010', 'Upfit labor', 'income', 'a5'),
      account('a7', '7', '6000', 'Rent', 'expense'),
      account('a8', null, '6900', 'Shop supplies', 'expense'),
    ],
    opening: [ns('1', undefined, 500000), ns('4', undefined, -500000)],
    netsuite: [...both.map(([a, m, c]) => ns(a, m, c)), ns('2', '2026-08-01', 125000), ns('6', '2026-08-01', -125000)],
    fleetsuite: [
      ...both.map(([a, m, c]) => fs(a, m, c)), fs('2', '2026-08-01', 120000), fs('6', '2026-08-01', -120000),
      fs(SHOP, '2026-09-01', 2500), fs('1', '2026-09-01', -2500),
    ],
  };
}

const NOW = new Date('2026-10-31T09:12:00Z');
const COMPANY = { code: 'BMG', name: 'BMG', legal_name: 'Example Fleet Upfitters LLC' };
const RED = 'FFC00000';
const AMBER = 'FF9C5700';

async function read(file: WorkbookFile): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(file.bytes) as any);
  expect(wb.worksheets).toHaveLength(1);
  return wb.worksheets[0];
}

/** A row's cells from the first through `last`, as Excel holds them: numbers, text, dates, else null. */
const cells = (ws: ExcelJS.Worksheet, row: number, last: number) =>
  Array.from({ length: last }, (_, i) => ws.getRow(row).getCell(i + 1).value ?? null);

/** The header row's number: the first row whose first cell is `first`. */
function headerRow(ws: ExcelJS.Worksheet, first: string): number {
  for (let r = 1; r <= ws.rowCount; r += 1) if (ws.getRow(r).getCell(1).value === first) return r;
  throw new Error(`no header starting ${first}`);
}

/** Every row under the header. */
const body = (ws: ExcelJS.Worksheet, first: string, last: number) => {
  const head = headerRow(ws, first);
  return Array.from({ length: ws.rowCount - head }, (_, i) => cells(ws, head + 1 + i, last));
};

const reportFile = (kind: ReportKind, from: string, to: string, notes: WorkbookNote[] = []) =>
  reportWorkbook({ company: COMPANY, kind, from, to, report: report(books(), kind, { from, to }), notes, now: NOW });

describe('a report as an Excel file', () => {
  it("lays the profit and loss out as Reports does: each line's number, its name indented under its parent, both sides and the difference", async () => {
    const file = await reportFile('profit_and_loss', '2026-01-01', '2026-09-01');
    expect(file.name).toBe('BMG Profit and Loss 2026-01 to 2026-09.xlsx');
    expect(file.type).toBe(XLSX_TYPE);
    const ws = await read(file);
    expect(ws.name).toBe('Profit and Loss');
    expect(cells(ws, 1, 1)).toEqual(['Example Fleet Upfitters LLC']);
    expect(cells(ws, 2, 1)).toEqual(['Profit and Loss']);
    expect(cells(ws, 3, 1)).toEqual(['January 1, 2026 to September 30, 2026']);
    expect(cells(ws, 5, 1)).toEqual(['Downloaded October 31, 2026 at 4:12 AM Central.']);
    const head = headerRow(ws, 'Number');
    expect(cells(ws, head, 5)).toEqual(['Number', 'Account', 'FleetSuite', 'NetSuite', 'Difference']);
    expect(body(ws, 'Number', 5)).toEqual([
      [null, 'Income', null, null, null],
      ['4000', 'Sales', null, null, null],
      ['4010', 'Upfit labor', 1200, 1250, -50],
      [null, 'Total Sales', 1200, 1250, -50],
      [null, 'Total income', 1200, 1250, -50],
      [null, 'Gross profit', 1200, 1250, -50],
      [null, 'Expense', null, null, null],
      ['6000', 'Rent', 800, 800, 0],
      ['6900', 'Shop supplies', 25, 0, 25],
      [null, 'Total expense', 825, 800, 25],
      [null, 'Net ordinary income', 375, 450, -75],
      [null, 'Net income', 375, 450, -75],
    ]);
    // The header stays on screen and on every printed page.
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: head });
    expect(ws.pageSetup).toMatchObject({ orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${head}:${head}` });
  });

  it('styles each line as the page does: parts and totals bold, a line over each total, two over a grand one, a difference in red', async () => {
    const ws = await read(await reportFile('profit_and_loss', '2026-01-01', '2026-09-01'));
    const head = headerRow(ws, 'Number');
    const at = (label: string) => ws.getRow(body(ws, 'Number', 2).findIndex((r) => r[1] === label) + head + 1);
    expect(at('Income').getCell(2).font).toMatchObject({ bold: true });
    expect(at('Sales').getCell(2)).toMatchObject({ font: expect.objectContaining({ bold: true }), alignment: { indent: 1 } });
    expect(at('Upfit labor').getCell(2).alignment).toEqual({ indent: 2 });
    expect(at('Upfit labor').getCell(2).font?.bold).toBeFalsy();
    expect(at('Upfit labor').getCell(3).numFmt).toBe('_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)');
    expect(at('Upfit labor').getCell(5).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(at('Rent').getCell(5).font?.color).toBeUndefined();
    expect(at('Total Sales').getCell(3).border).toEqual({ top: { style: 'thin' } });
    expect(at('Total Sales').getCell(2).border ?? {}).toEqual({});
    expect(at('Net income').getCell(5).border).toEqual({ top: { style: 'double' } });
    expect(at('Rent').getCell(3).border ?? {}).toEqual({});
    // Amount headings sit over their amounts.
    expect(ws.getRow(head).getCell(2).alignment).toMatchObject({ horizontal: 'left' });
    expect(ws.getRow(head).getCell(3).alignment).toMatchObject({ horizontal: 'right' });
  });

  it("names a one-month profit and loss by its month, the balance sheet and trial balance by their day, and italicizes what's no account", async () => {
    expect((await reportFile('profit_and_loss', '2026-09-01', '2026-09-01')).name).toBe('BMG Profit and Loss 2026-09.xlsx');
    const file = await reportFile('balance_sheet', '2026-09-01', '2026-09-01');
    expect(file.name).toBe('BMG Balance Sheet 2026-09-30.xlsx');
    const ws = await read(file);
    expect(cells(ws, 3, 1)).toEqual(['As of September 30, 2026']);
    const rows = body(ws, 'Number', 5);
    expect(rows.find((r) => r[1] === 'Receivables')).toEqual(['1200', 'Receivables', 1200, 1250, -50]);
    expect(rows.find((r) => r[1] === 'Total liabilities and equity')).toEqual([null, 'Total liabilities and equity', 7375, 7450, -75]);
    const income = body(ws, 'Number', 2).findIndex((r) => r[1] === 'Net income') + headerRow(ws, 'Number') + 1;
    expect(ws.getRow(income).getCell(2).font).toMatchObject({ italic: true });
    expect(ws.getRow(income).getCell(3).font).toMatchObject({ italic: true });
  });

  it('splits the trial balance into debits and credits each side, with their totals, across a landscape page', async () => {
    const file = await reportFile('trial_balance', '2026-09-01', '2026-09-01');
    expect(file.name).toBe('BMG Trial Balance 2026-09-30.xlsx');
    const ws = await read(file);
    expect(ws.pageSetup.orientation).toBe('landscape');
    expect(cells(ws, 4, 1)[0]).toMatch(/^FleetSuite's own books next to NetSuite's own totals: balance sheet accounts at their month-end balance, income and expenses for the year to date/);
    expect(cells(ws, headerRow(ws, 'Number'), 7)).toEqual(['Number', 'Account', 'FleetSuite debit', 'FleetSuite credit', 'NetSuite debit', 'NetSuite credit', 'Difference']);
    expect(body(ws, 'Number', 7)).toEqual([
      ['1000', 'Checking', 6175, null, 6200, null, -25],
      ['1200', 'Receivables', 1200, null, 1250, null, -50],
      ['3200', 'Retained Earnings', null, 7000, null, 7000, 0],
      ['4010', 'Upfit labor', null, 1200, null, 1250, 50],
      ['6000', 'Rent', 800, null, 800, null, 0],
      ['6900', 'Shop supplies', 25, null, null, null, 25],
      [null, 'Total', 8200, 8200, 8250, 8250, null],
    ]);
    const total = ws.getRow(ws.rowCount);
    expect(total.getCell(2).font).toMatchObject({ bold: true });
    expect(total.getCell(3).border).toEqual({ top: { style: 'double' } });
    expect(total.getCell(2).border ?? {}).toEqual({});
  });

  it("marks a NetSuite account the chart doesn't have yet", async () => {
    const data = books();
    data.netsuite.push(ns('77', '2026-09-01', 700), ns('1', '2026-09-01', -700));
    const ws = await read(await reportWorkbook({
      company: COMPANY, kind: 'profit_and_loss', from: '2026-09-01', to: '2026-09-01',
      report: report(data, 'profit_and_loss', { from: '2026-09-01', to: '2026-09-01' }), notes: [], now: NOW,
    }));
    expect(body(ws, 'Number', 5).slice(-2)).toEqual([
      [null, 'Not in the chart of accounts yet', null, null, null],
      [null, 'NetSuite account 77 (not in the chart yet)', 0, 7, -7],
    ]);
  });

  it('writes what the page warns about above the table, a failure in red and a gap in amber', async () => {
    const ws = await read(await reportFile('profit_and_loss', '2026-09-01', '2026-09-01', [
      { tone: 'red', text: 'The last posting run failed.' },
      { tone: 'amber', text: 'Still posting.' },
    ]));
    expect(cells(ws, 6, 1)).toEqual(['The last posting run failed.']);
    expect(ws.getRow(6).getCell(1).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(cells(ws, 7, 1)).toEqual(['Still posting.']);
    expect(ws.getRow(7).getCell(1).font).toMatchObject({ bold: true, color: { argb: AMBER } });
    expect(headerRow(ws, 'Number')).toBe(9);
  });
});

describe("what Reports warns about, in a report's file", () => {
  const base = { companyName: 'BMG', posts: true, checked: true, lastPosting: { at: '2026-10-31T07:41:00Z', error: null, partial: false }, lastCopy: null };

  it('says nothing when the last run posted everything and NetSuite has been read', () => {
    expect(reportNotes(base)).toEqual([]);
  });

  it('says when a company posts nothing, nothing has posted, a run failed or stopped for time, or NetSuite is unread', () => {
    expect(reportNotes({ ...base, companyName: '1084', posts: false, lastPosting: null })).toEqual([
      { tone: 'amber', text: "1084 doesn't post to FleetSuite's books yet, so its side holds only the starting balances from NetSuite." },
    ]);
    expect(reportNotes({ ...base, lastPosting: null })).toEqual([{ tone: 'amber', text: "Nothing has posted to FleetSuite's books yet." }]);
    expect(reportNotes({ ...base, lastPosting: { at: '2026-10-31T07:41:00Z', error: 'NetSuite timed out', partial: true } })).toEqual([
      { tone: 'red', text: 'The last posting run failed (October 31, 2026 at 2:41 AM Central): NetSuite timed out' },
    ]);
    expect(reportNotes({ ...base, lastPosting: { at: '2026-10-31T07:41:00Z', error: null, partial: true } })).toEqual([{
      tone: 'amber',
      text: "Still posting: the last run (October 31, 2026 at 2:41 AM Central) stopped for time, so some documents aren't in this report yet. It carries on at the next run.",
    }]);
    expect(reportNotes({ ...base, checked: false, lastCopy: { at: '2026-10-31T06:29:00Z', error: 'Login failed' } })).toEqual([
      { tone: 'amber', text: "NetSuite's totals haven't been read yet, so NetSuite's side is empty." },
      { tone: 'red', text: "The last copy of NetSuite's ledger failed (October 31, 2026 at 1:29 AM Central): Login failed" },
    ]);
  });
});

describe("an account's documents as an Excel file", () => {
  const doc = (d: Partial<DetailDocument> & Pick<DetailDocument, 'doc' | 'fleetsuite' | 'netsuite'>): DetailDocument => ({
    date: '2026-08-14', type: 'Invoice', number: `INV${d.doc}`, name: 'Acme Fleet', memo: null, only: null, check: null, ...d,
  });
  const receivables = (documents: DetailDocument[], count = documents.length, notes: WorkbookNote[] = []) => {
    const range = { from: '2026-08-01', to: '2026-09-01' };
    const span = lineSpan(books(), 'balance_sheet', '2', range);
    return accountWorkbook({
      company: COMPANY, kind: 'balance_sheet', ...range, account: { number: '1200', name: 'Receivables' },
      rows: runningBalances(span, yearClosings(books(), 'balance_sheet', '2', range), documents), documents: count, notes, now: NOW,
    });
  };

  it("lists each document by date with each side's running balance, from the balance before the months to the line", async () => {
    const file = await receivables([
      doc({ doc: '1001', date: '2026-08-03', fleetsuite: 120000, netsuite: 125000, memo: 'Upfit labor' }),
      doc({ doc: '1002', date: '2026-08-20', fleetsuite: 40000, netsuite: 0, only: 'fleetsuite' }),
      doc({ doc: '2001', date: '2026-09-02', type: 'Payment', number: 'PMT2001', fleetsuite: -40000, netsuite: 0, only: 'fleetsuite' }),
    ]);
    expect(file.name).toBe('BMG 1200 Receivables 2026-08 to 2026-09.xlsx');
    const ws = await read(file);
    expect(ws.name).toBe('1200 Receivables');
    expect(cells(ws, 2, 1)).toEqual(['1200 Receivables']);
    expect(cells(ws, 3, 1)).toEqual(['August 1, 2026 to September 30, 2026']);
    expect(cells(ws, 4, 1)[0]).toMatch(/^Every document that moved this account in these months \(3 documents\), by date, .*Amounts read as the balance sheet shows them\.$/);
    expect(cells(ws, headerRow(ws, 'Date'), 11)).toEqual([
      'Date', 'Type', 'Number', 'Name', 'Memo', 'FleetSuite', 'NetSuite', 'Difference', 'FleetSuite balance', 'NetSuite balance', 'Note',
    ]);
    const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
    expect(body(ws, 'Date', 11)).toEqual([
      [null, 'Balance at the end of July 2026', null, null, null, null, null, 0, 0, 0, null],
      [d('2026-08-03'), 'Invoice', 'INV1001', 'Acme Fleet', 'Upfit labor', 1200, 1250, -50, 1200, 1250, null],
      [d('2026-08-20'), 'Invoice', 'INV1002', 'Acme Fleet', null, 400, 0, 400, 1600, 1250, 'Only in FleetSuite'],
      [d('2026-09-02'), 'Payment', 'PMT2001', 'Acme Fleet', null, -400, 0, -400, 1200, 1250, 'Only in FleetSuite'],
      [null, 'Balance at the end of September 2026', null, null, null, null, null, -50, 1200, 1250, null],
    ]);
    const head = headerRow(ws, 'Date');
    const header = ws.getRow(head);
    expect(header.getCell(1)).toMatchObject({ font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } } });
    expect([1, 5, 6, 10, 11].map((c) => header.getCell(c).alignment?.horizontal)).toEqual(['left', 'left', 'right', 'right', 'left']);
    expect(ws.getRow(head + 1).getCell(2).font).toMatchObject({ bold: true });
    expect(ws.getRow(head + 1).getCell(8).font?.color).toBeUndefined();
    expect(ws.getRow(head + 2).getCell(1).numFmt).toBe('m/d/yyyy');
    expect(ws.getRow(head + 2).getCell(8).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(ws.getRow(head + 3).getCell(11).font).toMatchObject({ color: { argb: RED } });
    const ending = ws.getRow(head + 5);
    expect(ending.getCell(2).font).toMatchObject({ bold: true });
    expect(ending.getCell(9).border).toEqual({ top: { style: 'double' } });
    expect(ending.getCell(9).font?.color).toBeUndefined();
    // Sortable and filterable, header frozen, across a landscape page.
    expect(ws.autoFilter).toBe(`A${head}:K${head + 5}`);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: head });
    expect(ws.pageSetup).toMatchObject({ orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${head}:${head}` });
  });

  it("keeps a document both sides agree on plain, and says when the balance before already differs and both sides fall short", async () => {
    const range = { from: '2026-09-01', to: '2026-09-01' };
    const span = lineSpan(books(), 'balance_sheet', '2', range);
    const ws = await read(await accountWorkbook({
      company: COMPANY, kind: 'balance_sheet', ...range, account: { number: '1200', name: 'Receivables' },
      rows: runningBalances(span, [], [doc({ doc: '2001', date: '2026-09-02', type: 'Payment', number: 'PMT2001', fleetsuite: -40000, netsuite: -40000 })]),
      documents: 1, notes: [], now: NOW,
    }));
    const head = headerRow(ws, 'Date');
    expect(body(ws, 'Date', 11).map((r) => [r[1], ...r.slice(5)])).toEqual([
      ['Balance at the end of August 2026', null, null, -50, 1200, 1250, null],
      ['Payment', -400, -400, 0, 800, 850, null],
      ['Balance at the end of September 2026', null, null, -50, 1200, 1250,
        "The documents above come to $800.00 on FleetSuite's side and $850.00 on NetSuite's side"],
    ]);
    // The line already differed at the end of August.
    expect(ws.getRow(head + 1).getCell(8).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(ws.getRow(head + 2).getCell(8).font?.color?.argb).not.toBe(RED);
    const ending = ws.getRow(head + 3);
    expect(ending.getCell(9).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(ending.getCell(10).font).toMatchObject({ bold: true, color: { argb: RED } });
  });

  it("says in red where the documents come to when they don't reach the line, on the side that falls short", async () => {
    const ws = await read(await receivables([doc({ doc: '1001', fleetsuite: 120000, netsuite: 100000 })], 2));
    const ending = ws.getRow(ws.rowCount);
    expect(cells(ws, ws.rowCount, 11).slice(7)).toEqual([-50, 1200, 1250, "The documents above come to $1,000.00 on NetSuite's side"]);
    expect(ending.getCell(9).font?.color).toBeUndefined();
    expect(ending.getCell(10).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(ending.getCell(11).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(cells(ws, 4, 1)[0]).toContain('(2 documents)');
  });

  it("takes earlier years' net income into retained earnings on its January, and income and expenses from nothing", async () => {
    const range = { from: '2025-12-01', to: '2026-02-01' };
    const span = lineSpan(books(), 'balance_sheet', '4', range);
    const ws = await read(await accountWorkbook({
      company: COMPANY, kind: 'balance_sheet', ...range, account: { number: '3200', name: 'Retained Earnings' },
      rows: runningBalances(span, yearClosings(books(), 'balance_sheet', '4', range), []), documents: 0, notes: [], now: NOW,
    }));
    expect(body(ws, 'Date', 10)).toEqual([
      [null, 'Balance at the end of November 2025', null, null, null, null, null, 0, 5000, 5000],
      [new Date('2026-01-01T00:00:00.000Z'), "Earlier years' net income, taken into retained earnings at the year's start", null, null, null, 2000, 2000, 0, 7000, 7000],
      [null, 'Balance at the end of February 2026', null, null, null, null, null, 0, 7000, 7000],
    ]);
    expect(ws.getRow(ws.rowCount - 1).getCell(2).font).toMatchObject({ italic: true });
    expect(ws.getRow(ws.rowCount - 1).getCell(8).font?.color).toBeUndefined();
    // Nothing listed, so nothing to filter.
    expect(ws.autoFilter).toBeUndefined();

    // A year whose net income the two sides disagree on.
    const apart = await read(await accountWorkbook({
      company: COMPANY, kind: 'balance_sheet', from: '2026-01-01', to: '2026-01-01', account: { number: '3200', name: 'Retained Earnings' },
      rows: runningBalances(
        { starting: { fleetsuite: 500000, netsuite: 500000 }, ending: { fleetsuite: 700000, netsuite: 750000 } },
        [{ month: '2026-01-01', closed: { fleetsuite: 200000, netsuite: 250000 } }], [],
      ),
      documents: 0, notes: [], now: NOW,
    }));
    expect(body(apart, 'Date', 10)[1].slice(5)).toEqual([2000, 2500, -500, 7000, 7500]);
    expect(apart.getRow(apart.rowCount - 1).getCell(8).font).toMatchObject({ bold: true, color: { argb: RED } });

    const sales = lineSpan(books(), 'profit_and_loss', '6', { from: '2026-08-01', to: '2026-08-01' });
    const pl = await read(await accountWorkbook({
      company: COMPANY, kind: 'profit_and_loss', from: '2026-08-01', to: '2026-08-01', account: { number: '4010', name: 'Upfit labor' },
      rows: runningBalances(sales, [], [doc({ doc: '1001', fleetsuite: 120000, netsuite: 125000 })]), documents: 1, notes: [], now: NOW,
    }));
    expect(cells(pl, 3, 1)).toEqual(['August 1, 2026 to August 31, 2026']);
    expect(cells(pl, 4, 1)[0]).toMatch(/in the month \(1 document\).*Amounts read as the profit and loss shows them\.$/);
    expect(body(pl, 'Date', 10).map((r) => [r[1], ...r.slice(5)])).toEqual([
      ['Invoice', 1200, 1250, -50, 1200, 1250],
      ['Total, August 2026', null, null, -50, 1200, 1250],
    ]);
    const total = async (from: string, to: string) => {
      const ws = await read(await accountWorkbook({
        company: COMPANY, kind: 'profit_and_loss', from, to, account: { number: '4010', name: 'Upfit labor' },
        rows: runningBalances(lineSpan(books(), 'profit_and_loss', '6', { from, to }), [], []), documents: 0, notes: [], now: NOW,
      }));
      return ws.getRow(ws.rowCount).getCell(2).value;
    };
    expect(await total('2026-08-01', '2026-09-01')).toBe('Total, August to September 2026');
    expect(await total('2025-12-01', '2026-01-01')).toBe('Total, December 2025 to January 2026');
  });

  it('says how the trial balance reads its amounts, and marks a kind FleetSuite does not post yet in amber', async () => {
    const span = lineSpan(books(), 'trial_balance', '7', { from: '2026-01-01', to: '2026-09-01' });
    const ws = await read(await accountWorkbook({
      company: COMPANY, kind: 'trial_balance', from: '2026-01-01', to: '2026-09-01', account: { number: '6000', name: 'Rent' },
      rows: runningBalances(span, [], [doc({ doc: '3001', type: 'Expense Report', fleetsuite: 0, netsuite: 80000, only: 'not_posted' })]),
      documents: 1, notes: [], now: NOW,
    }));
    expect(cells(ws, 4, 1)[0]).toMatch(/Amounts read as the trial balance shows them: debits positive, credits negative\.$/);
    const listed = ws.getRow(headerRow(ws, 'Date') + 1);
    expect(listed.getCell(11).value).toBe("FleetSuite doesn't post these yet");
    expect(listed.getCell(11).font).toMatchObject({ color: { argb: AMBER } });
  });
});

describe("what an account line's detail warns about, in its file", () => {
  const base = { lastPosting: null, moved: 125000, copied: 125000, listed: 3, documents: 3, from: '2026-08-01', to: '2026-09-01' };

  it('says nothing when the copy holds everything and every document is listed', () => {
    expect(detailNotes(base)).toEqual([]);
  });

  it("says when the copy of NetSuite's ledger holds less than NetSuite's totals, and when the file stops short", () => {
    expect(detailNotes({ ...base, copied: 100000 })).toEqual([{
      tone: 'amber',
      text: "NetSuite's own totals say this account moved $1,250.00 in these months, but the copy of its ledger holds $1,000.00 of it so far, "
        + "so some of NetSuite's documents may be missing below and NetSuite's running balance won't reach its line. The next copy catches up.",
    }]);
    expect(detailNotes({ ...base, from: '2026-09-01', moved: -500, copied: 0 })[0].text).toMatch(/moved \(\$5\.00\) in this month, .* holds \$0\.00 of it/);
    expect(detailNotes({ ...base, listed: 20000, documents: 23456 })).toEqual([{
      tone: 'red',
      text: 'This file lists the first 20,000 of 23,456 documents, by date, so the running balances stop short of the line. Pick fewer months for the rest.',
    }]);
    expect(detailNotes({ ...base, lastPosting: { at: '2026-10-31T07:41:00Z', error: null, partial: true } })[0].text)
      .toBe("Still posting: the last run (October 31, 2026 at 2:41 AM Central) stopped for time, so some documents aren't in this account yet. It carries on at the next run.");
  });
});

describe('file and sheet names', () => {
  it('keeps out what a file system or Excel refuses', () => {
    expect(accountFileName('BMG', { number: null, name: 'A/R: Trade "old"' }, '2026-09-01', '2026-09-01')).toBe('BMG A-R- Trade -old- 2026-09.xlsx');
    expect(accountFileName('1084', { number: '2000', name: 'Payables' }, '2026-01-01', '2026-09-01')).toBe('1084 2000 Payables 2026-01 to 2026-09.xlsx');
    expect(sheetName('1200 A/R [trade]: customers and fleets*')).toBe('1200 A R trade customers and fl');
    expect(sheetName('???')).toBe('Sheet');
    expect(reportFileName('1084', 'balance_sheet', '2026-01-01', '2026-02-01')).toBe('1084 Balance Sheet 2026-02-28.xlsx');
  });
});
