// The year-end package (yearEndWorkbook in src/lib/books/report-workbook.ts):
// a made-up company's year built into one file for the CPA, then read back
// the way Excel would, sheet by sheet.
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { generalLedger, type LedgerBlock } from './general-ledger';
import { monthEndValue, type MonthEndPartData } from './inventory-value';
import { buildReport, type BuilderAsk, type SplitAmount } from './report-builder';
import type { AccountDocumentData, AccountDocumentsData } from './report-detail';
import { report, yearCloseAmounts, type ReportAccount, type ReportAmount, type ReportData } from './reports';
import type { TbAmount } from './trial-balance';
import type { YearCheck, YearEvent } from './year-end';
import {
  ledgerNotes, XLSX_TYPE, yearEndFileName, yearEndNotes, yearEndWorkbook,
  type WorkbookFile, type WorkbookNote, type YearEndView, type YearEndWorkbookInput,
} from './report-workbook';

const INCOME_STATEMENT = new Set(['income', 'expense']);
const account = (id: string, ns: string, number: string, name: string, type: string): ReportAccount => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: INCOME_STATEMENT.has(type) ? 'income_statement' : 'balance_sheet', parent_id: null,
});
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });
const ns = (acct: string, month: string | undefined, cents: number): TbAmount => ({ netsuite_account_id: acct, ...sides(cents), ...(month ? { month } : {}) });
const fs = (acct: string, month: string, cents: number): ReportAmount => ({ account: acct, month, ...sides(cents) });
const split = (acct: string, month: string, cents: number): SplitAmount => ({
  account: acct, month, division: 'upfit', location: 'ofallon', netsuite_location: null, ...sides(cents),
});

/**
 * Made-up books for BMG, live from January 2027: 4,000.00 of retained
 * earnings from before, 10,000.00 of sales in March 2027 and April's rent,
 * 2,000.00 in NetSuite's books and 2,100.00 in FleetSuite's.
 */
const DATA: ReportData = {
  company: 'BMG',
  accounts: [
    account('a10', '10', '1010', 'First Bank checking', 'bank'),
    account('a39', '39', '3900', 'Retained Earnings', 'equity'),
    account('a40', '40', '4000', 'Sales', 'income'),
    account('a60', '60', '6000', 'Rent', 'expense'),
  ],
  opening: [ns('10', undefined, 400000), ns('39', undefined, -400000)],
  netsuite: [ns('10', '2027-03-01', 1000000), ns('40', '2027-03-01', -1000000), ns('60', '2027-04-01', 200000), ns('10', '2027-04-01', -200000)],
  fleetsuite: [fs('10', '2027-03-01', 1000000), fs('40', '2027-03-01', -1000000), fs('60', '2027-04-01', 210000), fs('10', '2027-04-01', -210000)],
};
const SPLIT = [split('40', '2027-03-01', -1000000), split('60', '2027-04-01', 210000)];

/** The documents behind them, as gl_books_account_documents gives each account's: March's sale and April's rent. */
const docOf = (doc: string, amounts: Pick<AccountDocumentData, 'netsuite' | 'fleetsuite'>, over: Partial<AccountDocumentData>): AccountDocumentData => ({
  doc, kind: null, type: null, number: null, month: null, date: null, name: null, memo: null, entry_no: null, entries: 1, ...amounts, ...over,
});
const SALE = { type: 'CashSale', number: 'CS100', month: '2027-03-01', date: '2027-03-10', name: 'Example Fleet Co' };
const RENT = { type: 'Check', number: '1001', month: '2027-04-01', date: '2027-04-01', name: 'Example Landlord LLC', memo: 'April rent' };
const documents = (rows: AccountDocumentData[]): AccountDocumentsData => ({
  documents: rows.length,
  differing: rows.filter((r) => r.netsuite !== r.fleetsuite).length,
  netsuite: rows.reduce((s, r) => s + Number(r.netsuite), 0).toFixed(2),
  fleetsuite: rows.reduce((s, r) => s + Number(r.fleetsuite), 0).toFixed(2),
  rows,
});
const FOUND = new Map([
  ['10', documents([docOf('501', { netsuite: '10000.00', fleetsuite: '10000.00' }, SALE), docOf('502', { netsuite: '-2000.00', fleetsuite: '-2100.00' }, RENT)])],
  ['40', documents([docOf('501', { netsuite: '-10000.00', fleetsuite: '-10000.00' }, SALE)])],
  ['60', documents([docOf('502', { netsuite: '2000.00', fleetsuite: '2100.00' }, RENT)])],
]);

/** BMG's stock at the end of December 2027: four ladder racks, and a journal entry on the inventory account with no item. */
const zero = {
  ledger_start: '0', ledger_moves: '0', items_start: '0', items_moves_before: '0', items_moves: '0', netsuite_moves: '0', books_moves: '0',
  moves: [], entries: 0, entries_total: '0', month_entries: 0, month_entries_total: '0', kinds: [], rows: [], usual: true,
};
const INVENTORY: MonthEndPartData = {
  company: 'BMG', account_id: '190', number: '1200', name: 'Inventory', type: 'other_current_asset', ...zero,
  ledger_start: '400.00', ledger_moves: '-20.00', items_start: '400.00', netsuite_moves: '-20.00', books_moves: '-20.00',
  entries: 1, entries_total: '-20.00', month_entries: 1, month_entries_total: '-20.00', kinds: [{ type: 'Journal', count: 1, total: '-20.00' }],
  rows: [{ doc: '6900', type: 'Journal', number: 'JE12', date: '2027-12-10', month: '2027-12-01', name: null, memo: 'Shrink written off', amount: '-20.00' }],
};
const stock = (part: MonthEndPartData = INVENTORY) => monthEndValue({
  month: '2027-12-01',
  rows: [{ company: 'BMG', item_id: '9001', location_id: '11', quantity: '4', value: '400.00' }],
  items: [{ netsuite_id: '9001', name: 'LDR-24', display_name: 'Ladder rack 24 in', active: true }],
  locations: [{ netsuite_id: '11', name: 'Wentzville' }],
  parts: [part],
  netsuite_through: [{ company: 'BMG', month: '2027-12-01' }],
}).companies[0];

const CHECKS: YearCheck[] = [
  { key: 'months', state: 'done', detail: 'All 12 months are closed.' },
  { key: 'netsuite', state: 'todo', detail: "1 month doesn't match NetSuite: April.", months: ['2027-04-01'] },
  { key: 'entries', state: 'done', detail: 'None dated in 2027 is waiting.' },
  { key: 'bank', state: 'none', detail: "BMG's bank accounts aren't reconciled in FleetSuite yet." },
  { key: 'sales_tax', state: 'done', detail: "Every month's return is typed in." },
];
const EVENTS: YearEvent[] = [
  { action: 'closed', by: 'Craig', reason: 'The CPA posts it in NetSuite', at: '2028-01-15T16:12:00Z', netIncome: 790000, retainedEarnings: 1190000 },
  { action: 'reopened', by: 'Craig', reason: 'A late Grimco bill', at: '2028-01-16T15:00:00Z', netIncome: null, retainedEarnings: null },
  { action: 'closed', by: null, reason: null, at: '2028-01-17T15:30:00Z', netIncome: 790000, retainedEarnings: 1190000 },
];
const CLOSED: YearEndView = {
  own: true, over: true, checks: CHECKS, events: EVENTS, changedSince: false,
  closed: { at: '2028-01-17T15:30:00Z', by: 'Craig', netIncome: 790000, retainedEarnings: 1190000 },
};

const NOW = new Date('2028-01-20T15:00:00Z');
const COMPANY = { code: 'BMG', name: 'BMG', legal_name: 'Example Fleet Upfitters LLC' };
const RED = 'FFC00000';
const AMBER = 'FF9C5700';
const GREEN = 'FF006100';
const REPORT_NOTE: WorkbookNote = { tone: 'amber', text: "NetSuite's totals haven't been read yet, so NetSuite's side is empty." };
const BUILDER_NOTE: WorkbookNote = { tone: 'red', text: 'Download it again.' };
const STOCK_NOTE: WorkbookNote = { tone: 'amber', text: "NetSuite's stock moves haven't been copied yet, so no item has a count or value." };
const LEDGER_NOTE: WorkbookNote = { tone: 'red', text: '1 account has more than 20,000 documents in these months.' };

/** The package for BMG's 2027 as the download makes it, through `to`, with what's asked changed. */
function input(over: Partial<YearEndWorkbookInput> = {}, to = '2027-12-01'): YearEndWorkbookInput {
  const ask: BuilderAsk = { rows: 'account', months: 'picked', from: '2027-01-01', to, by: 'month', division: null, location: null };
  return {
    company: COMPANY,
    year: 2027,
    to,
    liveFrom: '2027-01-01',
    view: CLOSED,
    close: yearCloseAmounts(DATA, 2027),
    reports: {
      trial_balance: report(DATA, 'trial_balance', { to }),
      balance_sheet: report(DATA, 'balance_sheet', { to }),
      profit_and_loss: report(DATA, 'profit_and_loss', { from: '2027-01-01', to }),
      cash_flow: report(DATA, 'cash_flow', { from: '2027-01-01', to }),
    },
    reportNotes: [REPORT_NOTE],
    byMonth: { ask, built: buildReport(DATA, SPLIT, new Map(), ask), notes: [BUILDER_NOTE] },
    ledger: { accounts: generalLedger(DATA, { from: '2027-01-01', to }, FOUND), notes: [LEDGER_NOTE] },
    inventory: { value: stock(), notes: [STOCK_NOTE] },
    now: NOW,
    ...over,
  };
}

async function sheets(file: WorkbookFile): Promise<ExcelJS.Worksheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(file.bytes) as any);
  return wb.worksheets;
}
const sheet = (all: ExcelJS.Worksheet[], name: string) => all.find((s) => s.name === name)!;

/** A row's cells from the first through `last`, as Excel holds them: numbers, text, links, else null. */
const cells = (ws: ExcelJS.Worksheet, row: number, last: number) =>
  Array.from({ length: last }, (_, i) => ws.getRow(row).getCell(i + 1).value ?? null);

/** The header row's number: the first row whose first cell is `first`. */
function headerRow(ws: ExcelJS.Worksheet, first: string): number {
  for (let r = 1; r <= ws.rowCount; r += 1) if (ws.getRow(r).getCell(1).value === first) return r;
  throw new Error(`no header starting ${first} on ${ws.name}`);
}

/** Every row under the header. */
const body = (ws: ExcelJS.Worksheet, first: string, last: number) => {
  const head = headerRow(ws, first);
  return Array.from({ length: ws.rowCount - head }, (_, i) => cells(ws, head + 1 + i, last));
};

/** The notes written above a sheet's table: the rows after its download time, up to the blank row over the header. */
function notesOf(ws: ExcelJS.Worksheet): Array<[string, string | undefined]> {
  const notes: Array<[string, string | undefined]> = [];
  for (let r = 6; r <= ws.rowCount && ws.getRow(r).getCell(1).value; r += 1) {
    const c = ws.getRow(r).getCell(1);
    notes.push([String(c.value), c.font?.color?.argb]);
  }
  return notes;
}

const CLOSED_NOTE = '2027 is closed by Craig, January 17, 2028 at 9:30 AM Central.';

describe('the year-end package file', () => {
  it("is named for the company's code and the year", async () => {
    expect(yearEndFileName('BMG', 2027)).toBe('BMG Year-end package 2027.xlsx');
    expect(yearEndFileName('A/B', 2028)).toBe('A-B Year-end package 2028.xlsx');
    const file = await yearEndWorkbook(input({ company: { code: 'BMG', name: 'BMG Fleet Installations', legal_name: null } }));
    expect(file.name).toBe('BMG Year-end package 2027.xlsx');
  });

  it('opens on its contents: each sheet linked with what it holds, then what is done before the year closes', async () => {
    const file = await yearEndWorkbook(input());
    expect(file).toMatchObject({ name: 'BMG Year-end package 2027.xlsx', type: XLSX_TYPE });
    const all = await sheets(file);
    expect(all.map((s) => s.name)).toEqual([
      'Contents', 'Trial Balance', 'Balance Sheet', 'Profit and Loss', 'Profit and Loss by Month', 'Statement of Cash Flows',
      'Retained Earnings', 'General Ledger', 'Inventory value', 'Inventory ties to accounts', 'Inventory documents, no item',
    ]);
    const ws = all[0];
    expect([1, 2, 3, 4, 5].map((r) => cells(ws, r, 1)[0])).toEqual([
      'Example Fleet Upfitters LLC',
      'Year-end package 2027',
      'January 1, 2027 to December 31, 2027',
      "FleetSuite's books at the year's end for the CPA, a sheet for each report as Books shows it, with what to know about it at its top.",
      'Downloaded January 20, 2028 at 9:00 AM Central.',
    ]);
    expect(notesOf(ws)).toEqual([[CLOSED_NOTE, GREEN]]);
    const head = headerRow(ws, 'Sheet');
    expect(cells(ws, head, 2)).toEqual(['Sheet', 'What it holds']);
    // Nothing in it is an amount: its header reads from the left.
    expect(ws.getRow(head).getCell(2).alignment).toMatchObject({ horizontal: 'left' });
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: head });
    const link = (name: string) => ({ text: name, hyperlink: `#'${name}'!A1` });
    expect(body(ws, 'Sheet', 2)).toEqual([
      [link('Trial Balance'), "Each account at December 31, 2027, income and expenses for the year, FleetSuite's books next to NetSuite's."],
      [link('Balance Sheet'), "At December 31, 2027, FleetSuite's books next to NetSuite's."],
      [link('Profit and Loss'), "January 1, 2027 to December 31, 2027, FleetSuite's books next to NetSuite's."],
      [link('Profit and Loss by Month'), "The profit and loss with a column for each month and a Total, FleetSuite's books."],
      [link('Statement of Cash Flows'), "January 1, 2027 to December 31, 2027, FleetSuite's books next to NetSuite's."],
      [link('Retained Earnings'), 'How 2027 closes into retained earnings, both sides, and each time it was closed or reopened.'],
      [
        link('General Ledger'),
        "Each account's documents, January 1, 2027 to December 31, 2027, by date, with each side's balance after each: "
          + 'from where the account stood at the start of 2027 to its line on the trial balance.',
      ],
      [link('Inventory value'), 'Each item at each location at December 31, 2027: on hand, average cost and value.'],
      [link('Inventory ties to accounts'), 'How the items come to each inventory account on the balance sheet at December 31, 2027.'],
      [link('Inventory documents, no item'), 'Documents on the inventory accounts with no stocked item, from January 1, 2025 to December 31, 2027.'],
      [null, null],
      ['Before 2027 closes', null],
      ['Months closed: Done', 'All 12 months are closed.'],
      ['Matches NetSuite: Not yet', "1 month doesn't match NetSuite: April."],
      ['Journal entries: Done', 'None dated in 2027 is waiting.'],
      ['Bank reconciliations: Not here', "BMG's bank accounts aren't reconciled in FleetSuite yet."],
      ['Sales tax returns: Done', "Every month's return is typed in."],
    ]);
    const at = (i: number) => ws.getRow(head + 1 + i);
    // Links look like links; each line's text wraps under its sheet's name.
    expect(at(0).getCell(1).font).toMatchObject({ color: { argb: 'FF0563C1' }, underline: true });
    expect(at(0).getCell(1).alignment).toMatchObject({ vertical: 'top' });
    expect(at(0).getCell(2).alignment).toMatchObject({ vertical: 'top', wrapText: true });
    expect(at(11).getCell(1).font).toMatchObject({ bold: true, size: 12 });
    // What's not done yet stands out; the rest is plain.
    expect(at(13).getCell(1).font).toMatchObject({ bold: true, color: { argb: AMBER } });
    expect(at(13).getCell(2).font).toMatchObject({ bold: true, color: { argb: AMBER } });
    // Done, or not here at all: Excel's own text color.
    expect(at(12).getCell(1).font?.color?.argb).toBeUndefined();
    expect(at(15).getCell(1).font?.color?.argb).toBeUndefined();
    expect(at(15).getCell(2).alignment).toMatchObject({ vertical: 'top', wrapText: true });
    expect(ws.getColumn(1).width).toBe(30);
    expect(ws.getColumn(2).width).toBe(100);
  });

  it('has the trial balance and balance sheet at December 31 and the year’s profit and loss and cash flows as Reports does, each under the year’s notes and Reports’', async () => {
    const all = await sheets(await yearEndWorkbook(input()));
    const titles = (name: string) => [2, 3].map((r) => cells(sheet(all, name), r, 1)[0]);
    expect(titles('Trial Balance')).toEqual(['Trial Balance', 'As of December 31, 2027']);
    expect(titles('Balance Sheet')).toEqual(['Balance Sheet', 'As of December 31, 2027']);
    expect(titles('Profit and Loss')).toEqual(['Profit and Loss', 'January 1, 2027 to December 31, 2027']);
    expect(titles('Statement of Cash Flows')).toEqual(['Statement of Cash Flows', 'January 1, 2027 to December 31, 2027']);
    for (const name of ['Trial Balance', 'Balance Sheet', 'Profit and Loss', 'Statement of Cash Flows', 'Retained Earnings']) {
      expect([name, notesOf(sheet(all, name))]).toEqual([name, [[CLOSED_NOTE, GREEN], [REPORT_NOTE.text, AMBER]]]);
    }
    const pl = body(sheet(all, 'Profit and Loss'), 'Number', 5);
    expect(pl.find((r) => r[1] === 'Sales')).toEqual(['4000', 'Sales', 10000, 10000, 0]);
    expect(pl.find((r) => r[1] === 'Rent')).toEqual(['6000', 'Rent', 2100, 2000, 100]);
    expect(pl.find((r) => r[1] === 'Net income')).toEqual([null, 'Net income', 7900, 8000, -100]);
    const tb = body(sheet(all, 'Trial Balance'), 'Number', 7);
    expect(tb.find((r) => r[1] === 'First Bank checking')).toEqual(['1010', 'First Bank checking', 11900, null, 12000, null, -100]);
    expect(tb.find((r) => r[1] === 'Total')).toEqual([null, 'Total', 14000, 14000, 14000, 14000, null]);
  });

  it("lays the profit and loss out by month, FleetSuite's own, under the year's notes and the report builder's", async () => {
    const ws = sheet(await sheets(await yearEndWorkbook(input())), 'Profit and Loss by Month');
    expect([2, 3].map((r) => cells(ws, r, 1)[0])).toEqual(['Profit and Loss by Month', 'January 1, 2027 to December 31, 2027']);
    expect(notesOf(ws)).toEqual([[CLOSED_NOTE, GREEN], [BUILDER_NOTE.text, RED]]);
    const head = headerRow(ws, 'Number');
    expect(cells(ws, head, 15)).toEqual([
      'Number', 'Account', 'Jan 2027', 'Feb 2027', 'Mar 2027', 'Apr 2027', 'May 2027', 'Jun 2027', 'Jul 2027', 'Aug 2027', 'Sep 2027',
      'Oct 2027', 'Nov 2027', 'Dec 2027', 'Total',
    ]);
    const rows = body(ws, 'Number', 15);
    expect(rows.find((r) => r[1] === 'Sales')).toEqual(['4000', 'Sales', 0, 0, 10000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10000]);
    expect(rows.find((r) => r[1] === 'Net income')).toEqual([null, 'Net income', 0, 0, 10000, -2100, 0, 0, 0, 0, 0, 0, 0, 0, 7900]);
  });

  it('shows how the year closes into retained earnings, both sides, which account, and each close and reopen', async () => {
    const ws = sheet(await sheets(await yearEndWorkbook(input())), 'Retained Earnings');
    expect([2, 3, 4].map((r) => cells(ws, r, 1)[0])).toEqual([
      'Retained earnings',
      'January 1, 2027 to December 31, 2027',
      "How the year closes into retained earnings, FleetSuite's books next to NetSuite's own totals. Nothing is posted to close a year: "
        + "the balance sheet takes its net income into retained earnings on January 1, as NetSuite's does.",
    ]);
    const head = headerRow(ws, '');
    expect(cells(ws, head, 4)).toEqual(['', 'FleetSuite', 'NetSuite', 'Difference']);
    expect([2, 3, 4].map((c) => ws.getRow(head).getCell(c).alignment?.horizontal)).toEqual(['right', 'right', 'right']);
    expect(body(ws, '', 4)).toEqual([
      ['Retained earnings, January 1, 2027', 4000, 4000, 0],
      ['Posted to retained earnings in 2027', 0, 0, 0],
      ['Net income for 2027', 7900, 8000, -100],
      ['Retained earnings once 2027 closes, January 1, 2028', 11900, 12000, -100],
      [null, null, null, null],
      ['Retained earnings is 3900 Retained Earnings.', null, null, null],
      [null, null, null, null],
      ['2027 closed and reopened', null, null, null],
      ['Closed by Craig, January 15, 2028 at 10:12 AM Central, at $7,900.00 of net income: The CPA posts it in NetSuite', null, null, null],
      ['Reopened by Craig, January 16, 2028 at 9:00 AM Central: A late Grimco bill', null, null, null],
      ['Closed, January 17, 2028 at 9:30 AM Central, at $7,900.00 of net income', null, null, null],
    ]);
    const at = (i: number) => ws.getRow(head + 1 + i);
    expect(at(0).getCell(4).font?.color?.argb).toBeUndefined();
    expect(at(2).getCell(4).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(at(2).getCell(1).font?.bold).toBeFalsy();
    // Where it ends up: bold over a double line, the difference still red.
    expect(at(3).getCell(1).font).toMatchObject({ bold: true });
    expect([2, 3, 4].map((c) => at(3).getCell(c).border)).toEqual([2, 3, 4].map(() => ({ top: { style: 'double' } })));
    expect(at(3).getCell(4).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(at(2).getCell(2).border?.top).toBeUndefined();
    // Each amount, the difference too, in Excel's own Accounting format.
    expect([2, 3, 4].map((c) => at(0).getCell(c).numFmt)).toEqual([2, 3, 4].map(() => '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'));
    expect(at(5).getCell(1).font).toMatchObject({ color: { argb: 'FF595959' } });
    expect(at(7).getCell(1).font).toMatchObject({ bold: true, size: 12 });
    expect(ws.getColumn(1).width).toBe(62);
  });

  it('says when the chart has no retained earnings account, and leaves out a history the year has none of', async () => {
    const accounts = DATA.accounts.filter((a) => a.id !== 'a39');
    const ws = sheet(await sheets(await yearEndWorkbook(input({
      close: yearCloseAmounts({ ...DATA, accounts }, 2027),
      view: { ...CLOSED, closed: null, events: [] },
    }))), 'Retained Earnings');
    const rows = body(ws, '', 1).map((r) => r[0]);
    expect(rows.slice(4)).toEqual([null, "The chart has no retained earnings account, so they're the balance sheet's own line of earlier years' net income."]);
  });

  it("adds the company's stock at the year's end under the year's notes, the documents with no item only when there are some", async () => {
    const all = await sheets(await yearEndWorkbook(input()));
    const items = sheet(all, 'Inventory value');
    expect([2, 3].map((r) => cells(items, r, 1)[0])).toEqual(['Inventory value', 'As of December 31, 2027']);
    expect(body(items, 'Item', 6)).toEqual([['LDR-24', 'Ladder rack 24 in', 'Wentzville', 4, 100, 400], ['Total', null, null, null, null, 400]]);
    for (const name of ['Inventory value', 'Inventory ties to accounts']) {
      expect([name, notesOf(sheet(all, name))]).toEqual([name, [[CLOSED_NOTE, GREEN], [STOCK_NOTE.text, AMBER]]]);
    }
    expect(cells(sheet(all, 'Inventory ties to accounts'), 2, 1)).toEqual(['Inventory value: how it ties to the accounts']);
    expect(body(sheet(all, 'Inventory documents, no item'), 'Account', 7)[0]).toEqual([
      '1200 Inventory', new Date('2027-12-10T00:00:00Z'), 'Journal', 'JE12', null, 'Shrink written off', -20,
    ]);

    const none = { ...INVENTORY, entries: 0, entries_total: '0', month_entries: 0, month_entries_total: '0', kinds: [], rows: [], ledger_moves: '0', netsuite_moves: '0', books_moves: '0' };
    const without = await sheets(await yearEndWorkbook(input({ inventory: { value: stock(none), notes: [] } })));
    expect(without.slice(8).map((s) => s.name)).toEqual(['Inventory value', 'Inventory ties to accounts']);
    expect(body(without[0], 'Sheet', 1).map((r) => (r[0] as { text: string } | null)?.text ?? r[0]).slice(7, 10)).toEqual([
      'Inventory value', 'Inventory ties to accounts', null,
    ]);
  });

  it('has no stock sheets for a company with none', async () => {
    const all = await sheets(await yearEndWorkbook(input({ inventory: null })));
    expect(all.map((s) => s.name)).toEqual([
      'Contents', 'Trial Balance', 'Balance Sheet', 'Profit and Loss', 'Profit and Loss by Month', 'Statement of Cash Flows', 'Retained Earnings',
      'General Ledger',
    ]);
    expect(body(all[0], 'Sheet', 1)[8]).toEqual(['Before 2027 closes']);
  });

  it("runs a year that isn't over through this month and says so on each sheet, once on the stock's, which says it of its month", async () => {
    const view: YearEndView = { ...CLOSED, over: false, closed: null, events: [] };
    const stockNote: WorkbookNote = { tone: 'amber', text: "November 2027 isn't over yet, so this is where it stood when the file was made." };
    const all = await sheets(await yearEndWorkbook(input({ view, inventory: { value: stock(), notes: [stockNote] } }, '2027-11-01')));
    const over: [string, string] = ["2027 isn't over yet, so this is where it stood when the file was made.", AMBER];
    expect(cells(all[0], 3, 1)).toEqual(['January 1, 2027 to November 30, 2027']);
    expect(notesOf(all[0])).toEqual([over]);
    expect(notesOf(sheet(all, 'Trial Balance'))).toEqual([over, [REPORT_NOTE.text, AMBER]]);
    expect(cells(sheet(all, 'Trial Balance'), 3, 1)).toEqual(['As of November 30, 2027']);
    expect(cells(sheet(all, 'Profit and Loss'), 3, 1)).toEqual(['January 1, 2027 to November 30, 2027']);
    expect(notesOf(sheet(all, 'Profit and Loss by Month'))).toEqual([over, [BUILDER_NOTE.text, RED]]);
    // The year's close is the year's, whatever the month.
    expect(cells(sheet(all, 'Retained Earnings'), 3, 1)).toEqual(['January 1, 2027 to December 31, 2027']);
    expect(cells(sheet(all, 'Inventory value'), 3, 1)).toEqual(['As of November 30, 2027']);
    for (const name of ['Inventory value', 'Inventory ties to accounts', 'Inventory documents, no item']) {
      expect([name, notesOf(sheet(all, name))]).toEqual([name, name === 'Inventory documents, no item' ? [] : [[stockNote.text, AMBER]]]);
    }
    expect(body(all[0], 'Sheet', 2)[0][1]).toBe("Each account at November 30, 2027, income and expenses for the year, FleetSuite's books next to NetSuite's.");
    const ledger = sheet(all, 'General Ledger');
    expect(cells(ledger, 3, 1)).toEqual(['January 1, 2027 to November 30, 2027']);
    expect(notesOf(ledger)).toEqual([over, [REPORT_NOTE.text, AMBER], [LEDGER_NOTE.text, RED]]);
    expect(body(ledger, 'Account', 3).filter((r) => r[0] === '1010 First Bank checking').at(-1)).toEqual([
      '1010 First Bank checking', null, 'Balance at the end of November 2027',
    ]);
    expect(body(ledger, 'Account', 3).at(-1)).toEqual(['6000 Rent', null, 'Total, January to November 2027']);
  });

  it("lists every account's documents in the general ledger, each row with its account, under the year's notes, Reports' and its own", async () => {
    const ws = sheet(await sheets(await yearEndWorkbook(input())), 'General Ledger');
    expect([2, 3, 4].map((r) => cells(ws, r, 1)[0])).toEqual([
      'General Ledger',
      'January 1, 2027 to December 31, 2027',
      "Every account with a balance or a document in these months (4 accounts), in the trial balance's order, each document by date with each side's "
        + "balance after it: FleetSuite's journal next to the copy of NetSuite's general ledger. "
        + 'Amounts read as the trial balance shows them: debits positive, credits negative.',
    ]);
    expect(notesOf(ws)).toEqual([[CLOSED_NOTE, GREEN], [REPORT_NOTE.text, AMBER], [LEDGER_NOTE.text, RED]]);
    const head = headerRow(ws, 'Account');
    expect(cells(ws, head, 12)).toEqual([
      'Account', 'Date', 'Type', 'Number', 'Name', 'Memo', 'FleetSuite', 'NetSuite', 'Difference', 'FleetSuite balance', 'NetSuite balance', 'Note',
    ]);
    expect(Array.from({ length: 12 }, (_, i) => ws.getRow(head).getCell(i + 1).alignment?.horizontal)).toEqual([
      'left', 'left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left',
    ]);
    const bank = '1010 First Bank checking';
    const march = new Date('2027-03-10T00:00:00Z');
    const april = new Date('2027-04-01T00:00:00Z');
    expect(body(ws, 'Account', 12)).toEqual([
      [bank, null, 'Balance at the end of December 2026', null, null, null, null, null, 0, 4000, 4000, null],
      [bank, march, 'Cash Sale', 'CS100', 'Example Fleet Co', null, 10000, 10000, 0, 14000, 14000, null],
      [bank, april, 'Check', '1001', 'Example Landlord LLC', 'April rent', -2100, -2000, -100, 11900, 12000, null],
      [bank, null, 'Balance at the end of December 2027', null, null, null, null, null, -100, 11900, 12000, null],
      ['3900 Retained Earnings', null, 'Balance at the end of December 2026', null, null, null, null, null, 0, -4000, -4000, null],
      ['3900 Retained Earnings', null, 'Balance at the end of December 2027', null, null, null, null, null, 0, -4000, -4000, null],
      ['4000 Sales', march, 'Cash Sale', 'CS100', 'Example Fleet Co', null, -10000, -10000, 0, -10000, -10000, null],
      ['4000 Sales', null, 'Total, January to December 2027', null, null, null, null, null, 0, -10000, -10000, null],
      ['6000 Rent', april, 'Check', '1001', 'Example Landlord LLC', 'April rent', 2100, 2000, 100, 2100, 2000, null],
      ['6000 Rent', null, 'Total, January to December 2027', null, null, null, null, null, 100, 2100, 2000, null],
    ]);
    const at = (i: number) => ws.getRow(head + 1 + i);
    // An account's balance before the year in bold, account and all; a document that differs, its difference in red.
    expect([1, 3].map((c) => at(0).getCell(c).font?.bold)).toEqual([true, true]);
    expect(at(1).getCell(9).font?.color?.argb).toBeUndefined();
    expect(at(2).getCell(9).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(at(2).getCell(7).font?.color?.argb).toBeUndefined();
    // Its line at December 31 in bold over a double line, the difference red.
    expect(at(3).getCell(3).font).toMatchObject({ bold: true });
    expect([8, 9, 10, 11].map((c) => at(3).getCell(c).border?.top)).toEqual([undefined, { style: 'double' }, { style: 'double' }, { style: 'double' }]);
    expect(at(3).getCell(9).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(at(3).getCell(10).font?.color?.argb).toBeUndefined();
    expect(at(5).getCell(9).font?.color?.argb).toBeUndefined();
    // Dates as dates, amounts in Excel's own Accounting format; a filter on every column.
    expect(at(1).getCell(2).numFmt).toBe('m/d/yyyy');
    expect([7, 9, 11].map((c) => at(1).getCell(c).numFmt)).toEqual([7, 9, 11].map(() => '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'));
    expect(ws.autoFilter).toBe(`A${head}:L${head + 10}`);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: head });
    expect([1, 2, 6, 7, 9, 10, 11, 12].map((c) => ws.getColumn(c).width)).toEqual([32, 11, 40, 16, 16, 18, 18, 30]);
  });

  it("names an account the chart doesn't have yet, and marks what only one side has, what isn't posted, and a line its documents don't reach", async () => {
    const one = (only: 'fleetsuite' | 'not_posted', fleetsuite: number, netsuite: number) => ({
      doc: only, date: '2027-06-30', type: only === 'fleetsuite' ? 'Entry' : 'Customer Refund', number: only === 'fleetsuite' ? 'Entry 7' : 'RF2',
      name: null, memo: null, fleetsuite, netsuite, only, check: null,
    });
    const block: LedgerBlock = {
      key: '77', number: null, name: 'NetSuite account 77', inChart: false, moved: true, documents: 2, listed: 2, short: true,
      rows: [
        { kind: 'starting', balance: { fleetsuite: -100000, netsuite: -100000 } },
        { kind: 'closing', month: '2027-01-01', amount: { fleetsuite: -5000, netsuite: -6000 }, balance: { fleetsuite: -105000, netsuite: -106000 } },
        { kind: 'document', document: one('fleetsuite', 2500, 0), balance: { fleetsuite: -102500, netsuite: -106000 } },
        { kind: 'document', document: one('not_posted', 0, 1500), balance: { fleetsuite: -102500, netsuite: -104500 } },
        { kind: 'ending', balance: { fleetsuite: -102500, netsuite: -104000 }, reached: { fleetsuite: -102500, netsuite: -104500 } },
      ],
    };
    // Apart when the year began, and a FleetSuite document past the most listed.
    const other: LedgerBlock = {
      key: '1450', number: '1450', name: 'Deposits paid', inChart: true, moved: true, documents: 1, listed: 0, short: false,
      rows: [
        { kind: 'starting', balance: { fleetsuite: 5000, netsuite: 4000 } },
        { kind: 'ending', balance: { fleetsuite: 7000, netsuite: 4000 }, reached: { fleetsuite: 5000, netsuite: 4000 } },
      ],
    };
    const ws = sheet(await sheets(await yearEndWorkbook(input({ ledger: { accounts: [block, other], notes: [] } }))), 'General Ledger');
    expect(notesOf(ws)).toEqual([[CLOSED_NOTE, GREEN], [REPORT_NOTE.text, AMBER]]);
    const name = 'NetSuite account 77 (not in the chart yet)';
    const june = new Date('2027-06-30T00:00:00Z');
    expect(body(ws, 'Account', 12)).toEqual([
      [name, null, 'Balance at the end of December 2026', null, null, null, null, null, 0, -1000, -1000, null],
      [name, new Date('2027-01-01T00:00:00Z'), "Earlier years' net income, taken into retained earnings at the year's start", null, null, null, -50, -60, 10, -1050, -1060, null],
      [name, june, 'Entry', 'Entry 7', null, null, 25, 0, 25, -1025, -1060, 'Only in FleetSuite'],
      [name, june, 'Customer Refund', 'RF2', null, null, 0, 15, -15, -1025, -1045, "FleetSuite doesn't post these yet"],
      [name, null, 'Balance at the end of December 2027', null, null, null, null, null, 15, -1025, -1040, "The documents above come to ($1,045.00) on NetSuite's side"],
      ['1450 Deposits paid', null, 'Balance at the end of December 2026', null, null, null, null, null, 10, 50, 40, null],
      ['1450 Deposits paid', null, 'Balance at the end of December 2027', null, null, null, null, null, 30, 70, 40, "The documents above come to $50.00 on FleetSuite's side"],
    ]);
    const at = (i: number) => ws.getRow(headerRow(ws, 'Account') + 1 + i);
    expect(at(1).getCell(3).font).toMatchObject({ italic: true });
    expect(at(1).getCell(9).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(at(2).getCell(12).font).toMatchObject({ color: { argb: RED } });
    expect(at(3).getCell(12).font).toMatchObject({ color: { argb: AMBER } });
    // Only NetSuite's side falls short of the line.
    expect(at(4).getCell(10).font?.color?.argb).toBeUndefined();
    expect(at(4).getCell(11).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(at(4).getCell(12).font).toMatchObject({ bold: true, color: { argb: RED } });
    // Each side's balance apart before the year, its difference red; then only FleetSuite's side short of the line.
    expect(at(5).getCell(9).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(at(5).getCell(8).font?.color?.argb).toBeUndefined();
    expect(at(6).getCell(10).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect([9, 11].map((c) => at(6).getCell(c).font)).toEqual([{ bold: true, color: { argb: RED } }, { bold: true }]);
  });

  it('says so when no account has a balance or a document, with nothing to filter', async () => {
    const ws = sheet(await sheets(await yearEndWorkbook(input({ ledger: { accounts: [], notes: [] } }))), 'General Ledger');
    expect(cells(ws, 4, 1)[0]).toContain('in these months (0 accounts)');
    expect(body(ws, 'Account', 2)).toEqual([['No account has a balance or a document in these months.', null]]);
    expect(ws.getRow(headerRow(ws, 'Account') + 1).getCell(1).font).toMatchObject({ color: { argb: 'FF595959' } });
    expect(ws.autoFilter).toBeUndefined();
  });

  it("says a year before the books went live is the rehearsal, and when FleetSuite's books have changed since it closed", async () => {
    const rehearsal = await sheets(await yearEndWorkbook(input({ year: 2026, view: { ...CLOSED, own: false, closed: null, events: [] } })));
    expect(notesOf(rehearsal[0])).toEqual([["2026 is before BMG's books went live, so it closes in NetSuite: FleetSuite's side here is the rehearsal.", AMBER]]);
    expect(notesOf(sheet(rehearsal, 'Inventory value'))[0]).toEqual(notesOf(rehearsal[0])[0]);

    const changed = await sheets(await yearEndWorkbook(input({ view: { ...CLOSED, changedSince: true } })));
    const red = "FleetSuite's books have changed since 2027 closed: it closed at $7,900.00 of net income and $11,900.00 of retained earnings. "
      + "An account's type may have changed in the chart.";
    expect(notesOf(changed[0])).toEqual([[CLOSED_NOTE, GREEN], [red, RED]]);
    expect(notesOf(sheet(changed, 'Balance Sheet'))).toEqual([[CLOSED_NOTE, GREEN], [red, RED], [REPORT_NOTE.text, AMBER]]);
  });
});

describe('what Year end says about the year, in its package', () => {
  const view: Pick<YearEndView, 'own' | 'over' | 'closed' | 'changedSince'> = { own: true, over: true, closed: null, changedSince: false };
  const notes = (over: Partial<typeof view>, liveFrom: string | null = '2027-01-01', year = 2027) =>
    yearEndNotes({ name: 'BMG', year, liveFrom, view: { ...view, ...over } });

  it('says nothing of a year of its own that is over and open', () => {
    expect(notes({})).toEqual([]);
  });

  it("says when the year isn't over, closes in NetSuite, is closed, and has changed since, in that order", () => {
    expect(notes({ over: false })).toEqual([{ tone: 'amber', text: "2027 isn't over yet, so this is where it stood when the file was made." }]);
    expect(notes({ own: false }, '2027-01-01', 2026)).toEqual([
      { tone: 'amber', text: "2026 is before BMG's books went live, so it closes in NetSuite: FleetSuite's side here is the rehearsal." },
    ]);
    expect(notes({ own: false, over: false }, null, 2028)).toEqual([
      { tone: 'amber', text: "2028 isn't over yet, so this is where it stood when the file was made." },
      { tone: 'amber', text: "BMG's books aren't live yet, so 2028 closes in NetSuite: FleetSuite's side here is the rehearsal." },
    ]);
    const closed = { at: '2028-01-17T15:30:00Z', by: 'Craig', netIncome: 790000, retainedEarnings: -1190000 };
    expect(notes({ closed })).toEqual([{ tone: 'green', text: CLOSED_NOTE }]);
    expect(notes({ closed: { ...closed, at: null, by: null } })).toEqual([{ tone: 'green', text: '2027 is closed.' }]);
    expect(notes({ closed: { ...closed, netIncome: null, retainedEarnings: null }, changedSince: true })).toEqual([
      { tone: 'green', text: CLOSED_NOTE },
      {
        tone: 'red',
        text: "FleetSuite's books have changed since 2027 closed: it closed at $0.00 of net income and $0.00 of retained earnings. "
          + "An account's type may have changed in the chart.",
      },
    ]);
    expect(notes({ closed, changedSince: true })[1].text).toContain('at $7,900.00 of net income and ($11,900.00) of retained earnings.');
    // Only a closed year has changed since it closed.
    expect(notes({ changedSince: true })).toEqual([]);
  });
});

describe("what the general ledger warns about, beyond Reports' notes", () => {
  const block = (over: Partial<Pick<LedgerBlock, 'short' | 'documents' | 'listed'>> = {}) => ({ short: false, documents: 3, listed: 3, ...over });
  const SHORT = "the copy of NetSuite's ledger doesn't hold everything NetSuite's own totals say moved in these months yet, "
    + "so some of NetSuite's documents may be missing there and its running balance won't reach the account's line. The next copy catches up.";

  it('says nothing when every account comes to its line', () => {
    expect(ledgerNotes({ ledger: [block(), block({ documents: 0, listed: 0 })], checked: true })).toEqual([]);
    expect(ledgerNotes({ ledger: [], checked: true })).toEqual([]);
  });

  it("says on how many accounts the copy of NetSuite's ledger is short, once NetSuite's totals are read", () => {
    const ledger = [block({ short: true }), block(), block({ short: true })];
    expect(ledgerNotes({ ledger, checked: true })).toEqual([{ tone: 'amber', text: `On 2 accounts ${SHORT}` }]);
    expect(ledgerNotes({ ledger: ledger.slice(0, 1), checked: true })).toEqual([{ tone: 'amber', text: `On 1 account ${SHORT}` }]);
    // Until they are, NetSuite's side is empty, which Reports' note says.
    expect(ledgerNotes({ ledger, checked: false })).toEqual([]);
  });

  it('says in red how many accounts have more documents than it lists', () => {
    const cut = (n: string) => `${n} more than 20,000 documents in these months, so only the first are listed, by date, `
      + 'and the running balances stop short of the line. Download those accounts from Reports a few months at a time.';
    expect(ledgerNotes({ ledger: [block({ documents: 20001, listed: 20000 }), block({ short: true })], checked: true })).toEqual([
      { tone: 'amber', text: `On 1 account ${SHORT}` },
      { tone: 'red', text: cut('1 account has') },
    ]);
    expect(ledgerNotes({ ledger: [block({ documents: 25000, listed: 20000 }), block({ documents: 20002, listed: 20000 }), block()], checked: false })).toEqual([
      { tone: 'red', text: cut('2 accounts have') },
    ]);
  });
});
