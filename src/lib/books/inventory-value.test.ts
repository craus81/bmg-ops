// Inventory value at a month's end (src/lib/books/inventory-value.ts) and its
// Excel file (inventoryWorkbook in src/lib/books/report-workbook.ts): made-up
// stock and inventory accounts worked into each item's value and each
// account's tie-out, then read back from the file the way Excel would.
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { accountTie, monthEndValue, type MonthEndData, type MonthEndPartData } from './inventory-value';
import { netsuiteCheck } from './report-detail';
import { inventoryFileName, inventoryNotes, inventoryWorkbook, XLSX_TYPE, type WorkbookFile, type WorkbookNote } from './report-workbook';

/** Made-up items and locations: every name and amount here is invented. */
const ITEMS = [
  { netsuite_id: '9001', name: 'LDR-24', display_name: 'Ladder rack 24 in', active: true },
  { netsuite_id: '9002', name: 'LDR-9', display_name: 'LDR-9', active: true },
  { netsuite_id: '9003', name: 'LDR-10', display_name: null, active: false },
];
const LOCATIONS = [{ netsuite_id: '11', name: 'Wentzville' }, { netsuite_id: '12', name: 'Kansas City' }];

const MARCH = '2026-03-01';
const zero = {
  ledger_start: '0', ledger_moves: '0', items_start: '0', items_moves_before: '0', items_moves: '0', netsuite_moves: '0', books_moves: '0',
  moves: [], entries: 0, entries_total: '0', month_entries: 0, month_entries_total: '0', kinds: [], rows: [], usual: false,
};
const part = (over: Partial<MonthEndPartData> & Pick<MonthEndPartData, 'company' | 'account_id'>): MonthEndPartData => ({
  number: null, name: null, type: 'other_current_asset', ...zero, ...over,
});

/**
 * BMG's inventory account at the end of March 2026: the items stood at
 * 1,300.00 when the copies start, 100.00 short of NetSuite's ledger; 200.00
 * moved them before March and 150.00 in it; three documents since posted
 * -50.00 to it on no stocked item; NetSuite's own totals hold 25.00 the copy
 * of its ledger doesn't yet, and FleetSuite's books are 5.00 under NetSuite's.
 */
const INVENTORY = part({
  company: 'BMG', account_id: '190', number: '1200', name: 'Inventory', usual: true,
  ledger_start: '1400.00', ledger_moves: '300.00', items_start: '1300.00', items_moves_before: '200.00', items_moves: '350.00',
  netsuite_moves: '325.00', books_moves: '320.00',
  moves: [{ type: 'ItemRcpt', documents: 2, total: '250.00' }, { type: 'ItemShip', documents: 3, total: '-100.00' }],
  entries: 3, entries_total: '-50.00', month_entries: 1, month_entries_total: '-20.00',
  kinds: [{ type: 'Journal', count: 2, total: '-60.00' }, { type: 'InvAdjst', count: 1, total: '10.00' }],
  rows: [
    { doc: '6900', type: 'Journal', number: 'JE12', date: '2026-03-10', month: MARCH, name: null, memo: 'Shrink written off', amount: '-20.00' },
    { doc: '6901', type: null, number: null, date: '2025-11-03', month: '2025-11-01', name: 'Example Supply Co', memo: null, amount: '-40.00' },
  ],
});
/** A fixed asset account a stocked item names, holding only what NetSuite started with. */
const EQUIPMENT = part({ company: 'BMG', account_id: '195', name: 'Equipment', type: 'fixed_asset', ledger_start: '5000.00', books_moves: '0' });

const data = (over: Partial<MonthEndData> = {}): MonthEndData => ({
  month: MARCH,
  rows: [
    { company: 'BMG', item_id: '9001', location_id: '11', quantity: '4', value: '400.00' },
    { company: 'BMG', item_id: '9002', location_id: '11', quantity: '3', value: '25.00' },
    // Sold out, but its shipments left value on the account.
    { company: 'BMG', item_id: '9003', location_id: '12', quantity: '0', value: '12.34' },
    // Shipped before it was received.
    { company: 'BMG', item_id: '9003', location_id: '11', quantity: '-2', value: '-30.00' },
    { company: 'BMG', item_id: '9999', location_id: '77', quantity: '1', value: '5.00' },
    { company: 'BMG', item_id: '9001', location_id: null, quantity: '1', value: '100.00' },
    { company: '1084', item_id: '9001', location_id: '21', quantity: '2', value: '50.00' },
  ],
  items: ITEMS,
  locations: LOCATIONS,
  parts: [
    INVENTORY, EQUIPMENT,
    part({ company: '1084', account_id: '290', ledger_start: '12.50', ledger_moves: '37.50', items_start: '12.50', items_moves: '37.50' }),
    part({ company: 'ZED', account_id: '390', books_moves: '12.00' }),
  ],
  netsuite_through: [{ company: 'BMG', month: MARCH }, { company: '1084', month: '2026-02-01' }],
  ...over,
});

describe('monthEndValue', () => {
  it("names each item by its number, adds its description only when it says more, and names what the lists lack by id", () => {
    const bmg = monthEndValue(data()).companies[0];
    const byKey = new Map(bmg.lines.map((l) => [l.key, l]));
    expect(byKey.get('9001|11')).toMatchObject({ itemId: '9001', item: 'LDR-24', description: 'Ladder rack 24 in', locationId: '11', location: 'Wentzville' });
    expect(byKey.get('9002|11')).toMatchObject({ item: 'LDR-9', description: null });
    expect(byKey.get('9003|12')).toMatchObject({ item: 'LDR-10', description: null, location: 'Kansas City' });
    expect(byKey.get('9999|77')).toMatchObject({ item: 'Item 9999', description: null, location: 'Location 77' });
    expect(byKey.get('9001|')).toMatchObject({ locationId: null, location: null });
  });

  it('works out what one cost on average, and marks fewer than none on hand and value left with none', () => {
    const lines = new Map(monthEndValue(data()).companies[0].lines.map((l) => [l.key, l]));
    expect(lines.get('9001|11')).toMatchObject({ quantity: 4, value: 40000, averageCost: 10000, belowZero: false, leftover: false });
    expect(lines.get('9002|11')!.averageCost).toBeCloseTo(833.3333, 4);
    expect(lines.get('9003|12')).toMatchObject({ quantity: 0, value: 1234, averageCost: null, belowZero: false, leftover: true });
    expect(lines.get('9003|11')).toMatchObject({ quantity: -2, value: -3000, averageCost: null, belowZero: true, leftover: false });
    // A hair either side of none is none: no average, not below zero, and value on it is left over.
    const hair = monthEndValue(data({ rows: [
      { company: 'BMG', item_id: '9001', location_id: '11', quantity: '0.0000001', value: '1.00' },
      { company: 'BMG', item_id: '9002', location_id: '11', quantity: '-0.0000001', value: '0' },
      { company: 'BMG', item_id: '9003', location_id: '11', quantity: 'not a number', value: '' },
    ] })).companies[0].lines;
    expect(hair.map((l) => [l.item, l.quantity, l.averageCost, l.belowZero, l.leftover])).toEqual([
      ['LDR-9', -0.0000001, null, false, false],
      ['LDR-10', 0, null, false, false],
      ['LDR-24', 0.0000001, null, false, true],
    ]);
  });

  it('lists items as people read their names, then by id, then by location, and adds them up', () => {
    const bmg = monthEndValue(data()).companies[0];
    expect(bmg.lines.map((l) => `${l.item} at ${l.location ?? 'no location'}`)).toEqual([
      'Item 9999 at Location 77', 'LDR-9 at Wentzville', 'LDR-10 at Kansas City', 'LDR-10 at Wentzville',
      'LDR-24 at no location', 'LDR-24 at Wentzville',
    ]);
    expect(bmg.value).toBe(40000 + 2500 + 1234 - 3000 + 500 + 10000);
    // Two items named alike fall back to their ids.
    const twins = monthEndValue(data({
      rows: [{ company: 'BMG', item_id: '9011', location_id: '11', quantity: '1', value: '1.00' }, { company: 'BMG', item_id: '9010', location_id: '11', quantity: '1', value: '1.00' }],
      items: [{ netsuite_id: '9010', name: 'BIN-1', display_name: null, active: true }, { netsuite_id: '9011', name: 'bin-1', display_name: null, active: true }],
    })).companies[0];
    expect(twins.lines.map((l) => l.itemId)).toEqual(['9010', '9011']);
  });

  it('puts BMG first, then the rest by code, each with its accounts and whether NetSuite has been read to the month', () => {
    const value = monthEndValue(data());
    expect(value.month).toBe(MARCH);
    expect(value.companies.map((c) => [c.company, c.lines.length, c.accounts.map((a) => a.accountId), c.netsuiteThrough, c.netsuiteShort])).toEqual([
      ['BMG', 6, ['190', '195'], MARCH, false],
      ['1084', 1, ['290'], '2026-02-01', true],
      ['ZED', 0, ['390'], null, true],
    ]);
    expect(value.companies[1]).toMatchObject({ value: 5000, lines: [{ item: 'LDR-24', location: 'Location 21' }] });
    expect(value.companies[2].value).toBe(0);
    // Read past the month is read to it.
    expect(monthEndValue(data({ netsuite_through: [{ company: 'BMG', month: '2026-06-01' }] })).companies[0].netsuiteShort).toBe(false);
    // Nothing at all: no companies.
    expect(monthEndValue({ month: MARCH, rows: [], items: [], locations: [], parts: [], netsuite_through: [] })).toEqual({ month: MARCH, companies: [] });
  });
});

describe('accountTie', () => {
  it('rolls the stocked items forward through the month and takes the balance sheet apart from them, every cent named', () => {
    const tie = accountTie(INVENTORY, MARCH);
    expect(tie).toMatchObject({
      accountId: '190', account: '1200 Inventory', fixedAsset: false, usual: true,
      items: {
        before: 150000,
        moves: [{ type: 'Item Receipt', documents: 2, total: 25000 }, { type: 'Item Fulfillment', documents: 3, total: -10000 }],
        end: 165000,
      },
      ledger: 170000, netsuite: 172500, books: 172000,
      apart: 7000, start: 10000, unexplained: 0, notCopied: 2500, booksApart: -500,
    });
    expect(tie.items.before + tie.items.moves.reduce((s, m) => s + m.total, 0)).toBe(tie.items.end);
    expect(tie.start + tie.entries.total + tie.unexplained + tie.notCopied + tie.booksApart).toBe(tie.apart);
  });

  it("lists the documents with no stocked item as sent, the month's marked, and counts the rest", () => {
    const { entries } = accountTie(INVENTORY, MARCH);
    expect(entries).toMatchObject({
      count: 3, total: -5000, month: { count: 1, total: -2000 },
      kinds: [{ type: 'Journal', count: 2, total: -6000 }, { type: 'Inventory Adjustment', count: 1, total: 1000 }],
      more: { count: 1, total: 1000 },
    });
    expect(entries.rows).toEqual([
      {
        doc: '6900', date: '2026-03-10', type: 'Journal', number: 'JE12', name: null, memo: 'Shrink written off', amount: -2000,
        check: netsuiteCheck('Journal', MARCH, '2026-03-10'), inMonth: true,
      },
      { doc: '6901', date: '2025-11-03', type: 'Entry', number: 'NetSuite 6901', name: 'Example Supply Co', memo: null, amount: -4000, check: null, inMonth: false },
    ]);
    expect(entries.rows[0].check).not.toBeNull();
    // Every one sent: none more.
    expect(accountTie({ ...INVENTORY, entries: 2, entries_total: '-60.00' }, MARCH).entries.more).toEqual({ count: 0, total: 0 });
  });

  it("says what the copy of NetSuite's ledger holds that nothing explains, and names an account by its id when it has no number or name", () => {
    const tie = accountTie({ ...INVENTORY, ledger_moves: '301.00' }, MARCH);
    expect(tie).toMatchObject({ ledger: 170100, unexplained: 100, notCopied: 2400 });
    expect(tie.start + tie.entries.total + tie.unexplained + tie.notCopied + tie.booksApart).toBe(tie.apart);

    const bare = accountTie(part({ company: '1084', account_id: '290', moves: [{ type: null, documents: 1, total: '5.00' }] }), MARCH);
    expect(bare).toMatchObject({ account: 'NetSuite account 290', usual: false, items: { moves: [{ type: 'Entry', documents: 1, total: 500 }] } });
    expect(accountTie(EQUIPMENT, MARCH)).toMatchObject({
      account: 'Equipment', fixedAsset: true, items: { before: 0, moves: [], end: 0 }, ledger: 500000, netsuite: 500000, books: 500000,
      start: 500000, apart: 500000, unexplained: 0, notCopied: 0, booksApart: 0,
    });
  });
});

const NOW = new Date('2026-10-31T09:12:00Z');
const COMPANY = { code: 'BMG', name: 'BMG', legal_name: 'Example Fleet Upfitters LLC' };
const RED = 'FFC00000';
const AMBER = 'FF9C5700';

describe("what Inventory value warns about, in its file", () => {
  const run = (over: { error?: string; partial?: boolean } = {}) => ({ at: '2026-10-31T06:29:00Z', error: null, partial: false, ...over });
  const base = {
    month: MARCH, through: '2026-10-01', company: { company: 'BMG', netsuiteThrough: MARCH, netsuiteShort: false }, lastCopy: run(), lastPosting: run(),
  };

  it('says nothing when the month is over, both runs went through and NetSuite is read to it', () => {
    expect(inventoryNotes(base)).toEqual([]);
  });

  it("says when the month isn't over, the stock moves were never copied, failed or stopped for time, and when posting did", () => {
    expect(inventoryNotes({ ...base, month: '2026-10-01' })).toEqual([
      { tone: 'amber', text: "October 2026 isn't over yet, so this is where it stood when the file was made." },
    ]);
    expect(inventoryNotes({ ...base, lastCopy: null })).toEqual([
      { tone: 'amber', text: "NetSuite's stock moves haven't been copied yet, so no item has a count or value." },
    ]);
    expect(inventoryNotes({ ...base, lastCopy: run({ error: 'Login failed', partial: true }) })).toEqual([
      { tone: 'red', text: "The last copy of NetSuite's stock moves failed (October 31, 2026 at 1:29 AM Central): Login failed" },
    ]);
    expect(inventoryNotes({ ...base, lastCopy: run({ partial: true }) })).toEqual([{
      tone: 'amber',
      text: "Still copying NetSuite's stock moves: the last run (October 31, 2026 at 1:29 AM Central) stopped for time, so some items' moves aren't in yet. "
        + 'It carries on at the next run.',
    }]);
    expect(inventoryNotes({ ...base, lastPosting: run({ error: 'NetSuite timed out' }) })).toEqual([
      { tone: 'red', text: 'The last posting run failed (October 31, 2026 at 1:29 AM Central): NetSuite timed out' },
    ]);
    expect(inventoryNotes({ ...base, lastPosting: run({ partial: true }) })[0].text)
      .toBe("Still posting: the last run (October 31, 2026 at 1:29 AM Central) stopped for time, so some documents aren't in FleetSuite's books yet. It carries on at the next run.");
    expect(inventoryNotes({ ...base, lastPosting: null })).toEqual([]);
  });

  it("says how far NetSuite's own totals are read when they stop short of the month", () => {
    expect(inventoryNotes({ ...base, company: { company: '1084', netsuiteThrough: '2026-02-01', netsuiteShort: true } })).toEqual([
      { tone: 'amber', text: "NetSuite's own totals for 1084 are read through February 2026, so NetSuite's balance sheet stops there." },
    ]);
    expect(inventoryNotes({ ...base, company: { company: 'ZED', netsuiteThrough: null, netsuiteShort: true } })).toEqual([
      { tone: 'amber', text: "NetSuite's own totals for ZED haven't been read yet, so NetSuite's balance sheet holds only its starting entry." },
    ]);
  });
});

async function sheets(file: WorkbookFile): Promise<ExcelJS.Worksheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(file.bytes) as any);
  return wb.worksheets;
}
const cells = (ws: ExcelJS.Worksheet, row: number, last: number) =>
  Array.from({ length: last }, (_, i) => ws.getRow(row).getCell(i + 1).value ?? null);
function headerRow(ws: ExcelJS.Worksheet, first: string): number {
  for (let r = 1; r <= ws.rowCount; r += 1) if (ws.getRow(r).getCell(1).value === first) return r;
  throw new Error(`no header starting ${first}`);
}
const body = (ws: ExcelJS.Worksheet, first: string, last: number) => {
  const head = headerRow(ws, first);
  return Array.from({ length: ws.rowCount - head }, (_, i) => cells(ws, head + 1 + i, last));
};
const workbook = (company = 0, notes: WorkbookNote[] = []) =>
  inventoryWorkbook({ company: COMPANY, month: MARCH, value: monthEndValue(data()).companies[company], notes, now: NOW });

describe("inventory value as an Excel file", () => {
  it("names the file by the month's last day", () => {
    expect(inventoryFileName('BMG', MARCH)).toBe('BMG Inventory value 2026-03-31.xlsx');
    expect(inventoryFileName('1084', '2028-02-01')).toBe('1084 Inventory value 2028-02-29.xlsx');
  });

  it('lists each item at each location with its count, average cost and value, and their total', async () => {
    const file = await workbook();
    expect(file).toMatchObject({ name: 'BMG Inventory value 2026-03-31.xlsx', type: XLSX_TYPE });
    const [ws, ...rest] = await sheets(file);
    expect([ws.name, ...rest.map((s) => s.name)]).toEqual(['Inventory value', 'Ties to the accounts', 'Documents with no item']);
    expect([1, 2, 3, 5].map((r) => cells(ws, r, 1)[0])).toEqual([
      'Example Fleet Upfitters LLC', 'Inventory value', 'As of March 31, 2026', 'Downloaded October 31, 2026 at 4:12 AM Central.',
    ]);
    const head = headerRow(ws, 'Item');
    expect(cells(ws, head, 7)).toEqual(['Item', 'Description', 'Location', 'On hand', 'Average cost', 'Value', 'Note']);
    const rows = body(ws, 'Item', 7);
    expect(rows[1][4]).toBeCloseTo(8.3333, 4);
    expect(rows.map((r, i) => (i === 1 ? [...r.slice(0, 4), 'about 8.33', ...r.slice(5)] : r))).toEqual([
      ['Item 9999', null, 'Location 77', 1, 5, 5, null],
      ['LDR-9', null, 'Wentzville', 3, 'about 8.33', 25, null],
      ['LDR-10', null, 'Kansas City', 0, null, 12.34, 'None on hand, but value on its lines'],
      ['LDR-10', null, 'Wentzville', -2, null, -30, 'Fewer than none on hand'],
      ['LDR-24', 'Ladder rack 24 in', null, 1, 100, 100, null],
      ['LDR-24', 'Ladder rack 24 in', 'Wentzville', 4, 100, 400, null],
      ['Total', null, null, null, null, 512.34, null],
    ]);
    const at = (i: number) => ws.getRow(head + 1 + i);
    expect(at(0).getCell(4).numFmt).toBe('#,##0.#####');
    expect(at(0).getCell(5).numFmt).toBe('_($* #,##0.00##_);_($* (#,##0.00##);_($* "-"??_);_(@_)');
    expect(at(0).getCell(6).numFmt).toBe('_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)');
    expect(at(2).getCell(7).font).toMatchObject({ color: { argb: AMBER } });
    expect(at(3).getCell(4).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(at(3).getCell(7).font).toMatchObject({ color: { argb: RED } });
    // Unstyled: Excel's own text color.
    expect(at(0).getCell(4).font?.color?.argb).toBeUndefined();
    expect(at(6).getCell(1).font).toMatchObject({ bold: true });
    expect(at(6).getCell(6).border).toEqual({ top: { style: 'double' } });
    // Sortable and filterable over the items, not the total; header frozen and on every printed page.
    expect(ws.autoFilter).toBe(`A${head}:G${head + 6}`);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: head });
    expect(ws.pageSetup).toMatchObject({ orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${head}:${head}` });
  });

  it("ties each inventory account from the stocked items to FleetSuite's balance sheet, a line for every cent between them", async () => {
    const ties = (await sheets(await workbook()))[1];
    expect(cells(ties, 2, 1)).toEqual(['Inventory value: how it ties to the accounts']);
    expect(cells(ties, headerRow(ties, 'Inventory account'), 2)).toEqual(['Inventory account', 'Amount']);
    expect(body(ties, 'Inventory account', 2)).toEqual([
      ['1200 Inventory', null],
      ['Stocked items at the end of February 2026', 1500],
      ['Item Receipt, 2 documents in March', 250],
      ['Item Fulfillment, 3 documents in March', -100],
      ['Stocked items at the end of March 2026', 1650],
      ["Where NetSuite's ledger and the items stood apart on December 31, 2024", 100],
      ['3 documents since with no stocked item, 1 of them in March', -50],
      ["NetSuite's ledger, as FleetSuite copies it", 1700],
      ["In NetSuite's own totals, not in FleetSuite's copy of its ledger yet", 25],
      ["NetSuite's balance sheet", 1725],
      ["FleetSuite's books apart from NetSuite's", -5],
      ["FleetSuite's balance sheet", 1720],
      ["FleetSuite's books less the stocked items", 70],
      [null, null],
      ['Equipment, a fixed asset account', null],
      ['Stocked items at the end of February 2026', 0],
      ['Stocked items at the end of March 2026', 0],
      ["Where NetSuite's ledger and the items stood apart on December 31, 2024", 5000],
      ["NetSuite's ledger, as FleetSuite copies it", 5000],
      ["NetSuite's balance sheet", 5000],
      ["FleetSuite's balance sheet", 5000],
      ["FleetSuite's books less the stocked items", 5000],
    ]);
    const head = headerRow(ties, 'Inventory account');
    const at = (i: number) => ties.getRow(head + 1 + i);
    expect(at(0).getCell(1).font).toMatchObject({ bold: true, size: 12 });
    expect(at(2).getCell(1).alignment).toEqual({ indent: 1 });
    expect(at(4).getCell(1).font).toMatchObject({ bold: true });
    expect(at(1).getCell(1).font?.bold).toBeFalsy();
    expect(at(10).getCell(2).font).toMatchObject({ bold: true, color: { argb: RED } });
    expect(at(8).getCell(2).font?.color?.argb).toBeUndefined();
    expect(at(1).getCell(2).numFmt).toBe('_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)');
  });

  it("says in red what nothing explains, and leaves out the lines that come to nothing", async () => {
    // NetSuite's ledger, its own totals and FleetSuite's books all 1.00 over what the items and the start explain.
    const value = monthEndValue(data({ parts: [{ ...INVENTORY, ledger_moves: '351.00', netsuite_moves: '351.00', books_moves: '351.00', entries: 0, entries_total: '0', rows: [], kinds: [] }] })).companies[0];
    const files = await sheets(await inventoryWorkbook({ company: COMPANY, month: MARCH, value, notes: [], now: NOW }));
    // No documents with no item, so no sheet of them.
    expect(files.map((s) => s.name)).toEqual(['Inventory value', 'Ties to the accounts']);
    const ties = files[1];
    const rows = body(ties, 'Inventory account', 2);
    expect(rows.map((r) => r[0])).toEqual([
      '1200 Inventory', 'Stocked items at the end of February 2026', 'Item Receipt, 2 documents in March', 'Item Fulfillment, 3 documents in March',
      'Stocked items at the end of March 2026', "Where NetSuite's ledger and the items stood apart on December 31, 2024",
      "Not accounted for: FleetSuite's copy of NetSuite's ledger is off", "NetSuite's ledger, as FleetSuite copies it", "NetSuite's balance sheet",
      "FleetSuite's balance sheet", "FleetSuite's books less the stocked items",
    ]);
    const off = ties.getRow(headerRow(ties, 'Inventory account') + 7);
    expect(off.getCell(2).value).toBe(1);
    expect(off.getCell(2).font).toMatchObject({ bold: true, color: { argb: RED } });
  });

  it("lists each account's documents with no stocked item, the month's marked, then what the smaller ones not listed come to", async () => {
    const docs = (await sheets(await workbook()))[2];
    expect(docs.pageSetup.orientation).toBe('landscape');
    expect(cells(docs, 3, 1)).toEqual(['January 1, 2025 to March 31, 2026']);
    expect(cells(docs, headerRow(docs, 'Account'), 8)).toEqual(['Account', 'Date', 'Type', 'Number', 'Name', 'Memo', 'Amount', 'In March']);
    expect(body(docs, 'Account', 8)).toEqual([
      ['1200 Inventory', new Date('2026-03-10T00:00:00Z'), 'Journal', 'JE12', null, 'Shrink written off', -20, 'Yes'],
      ['1200 Inventory', new Date('2025-11-03T00:00:00Z'), 'Entry', 'NetSuite 6901', 'Example Supply Co', null, -40, null],
      ['1200 Inventory', null, null, null, '1 smaller document not listed', null, 10, null],
    ]);
    const head = headerRow(docs, 'Account');
    expect(docs.getRow(head + 1).getCell(2).numFmt).toBe('m/d/yyyy');
    expect(docs.getRow(head + 3).getCell(5).font).toMatchObject({ italic: true });
    expect(docs.autoFilter).toBe(`A${head}:H${head + 3}`);
  });

  it('writes what the page warns about above the items and the tie-out, a failure in red and a gap in amber', async () => {
    const [items, ties, docs] = await sheets(await workbook(0, [
      { tone: 'red', text: "The last copy of NetSuite's stock moves failed." },
      { tone: 'amber', text: "NetSuite's own totals stop short." },
    ]));
    for (const ws of [items, ties]) {
      expect(cells(ws, 6, 1)).toEqual(["The last copy of NetSuite's stock moves failed."]);
      expect(ws.getRow(6).getCell(1).font).toMatchObject({ bold: true, color: { argb: RED } });
      expect(ws.getRow(7).getCell(1).font).toMatchObject({ bold: true, color: { argb: AMBER } });
    }
    expect(headerRow(items, 'Item')).toBe(9);
    expect(headerRow(docs, 'Account')).toBe(7);
  });

  it('makes a file for a company with no stock lines, its total nothing', async () => {
    const [items, ties] = await sheets(await workbook(2));
    expect(body(items, 'Item', 7)).toEqual([['Total', null, null, null, null, 0, null]]);
    expect(items.autoFilter).toBeUndefined();
    expect(body(ties, 'Inventory account', 2).map((r) => r[0])).toEqual([
      'NetSuite account 390', 'Stocked items at the end of February 2026', 'Stocked items at the end of March 2026',
      "NetSuite's ledger, as FleetSuite copies it", "NetSuite's balance sheet", "FleetSuite's books apart from NetSuite's",
      "FleetSuite's balance sheet", "FleetSuite's books less the stocked items",
    ]);
  });
});
