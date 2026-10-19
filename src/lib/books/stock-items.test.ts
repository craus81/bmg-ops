import { describe, it, expect } from 'vitest';
import {
  compareStock, itemMoves, ledgerParts, quantityText, stockSetup, type StockItemMovesData, type StockItemsData,
} from './stock-items';

/** Made-up items and locations: every name and amount here is invented. */
const ITEMS = [
  { netsuite_id: '9001', name: 'LDR-24', display_name: 'Ladder rack 24 in', active: true },
  { netsuite_id: '9002', name: 'LDR-9', display_name: 'LDR-9', active: true },
  { netsuite_id: '9003', name: 'LDR-10', display_name: null, active: false },
];
const LOCATIONS = [{ netsuite_id: '11', name: 'Wentzville' }, { netsuite_id: '12', name: 'Kansas City' }];

const row = (item_id: string, location_id: string | null, quantity: string, value: string, company = 'BMG') => ({
  company, item_id, location_id, opening_quantity: '0', opening_value: '0', quantity, value, documents: 1, last_date: '2026-10-01',
});
const data = (over: Partial<StockItemsData>): StockItemsData => ({
  rows: [], netsuite: [], netsuite_read_at: '2026-10-18T13:45:00Z', items: ITEMS, locations: LOCATIONS, ledger: [], accounts: ['190'], ...over,
});

describe('compareStock', () => {
  it('lists the counts that differ first, then items as people read their names, then locations', () => {
    const compared = compareStock(data({
      rows: [row('9003', '11', '1', '10.00'), row('9002', '11', '2', '20.00'), row('9001', '12', '3', '30.00'), row('9001', '11', '4', '40.00')],
      netsuite: [
        { item_id: '9003', location_id: '11', quantity: '1', value: '10.00' }, { item_id: '9002', location_id: '11', quantity: '2', value: '20.00' },
        { item_id: '9001', location_id: '12', quantity: '3', value: '30.00' }, { item_id: '9001', location_id: '11', quantity: '5', value: '40.00' },
      ],
    }));
    expect(compared.by).toBe('location');
    expect(compared.lines.map((l) => `${l.item} at ${l.location}`)).toEqual([
      'LDR-24 at Wentzville', 'LDR-9 at Wentzville', 'LDR-10 at Wentzville', 'LDR-24 at Kansas City',
    ].sort((a, b) => Number(b === 'LDR-24 at Wentzville') - Number(a === 'LDR-24 at Wentzville')
      || a.localeCompare(b, 'en-US', { numeric: true })));
    expect(compared.lines[0]).toMatchObject({ key: '9001|11', countDiffers: true, valueDiffers: false });
  });

  it('names an item by its number, adds its description only when it says more, and names what the lists lack by id', () => {
    const compared = compareStock(data({
      rows: [row('9001', '11', '1', '1.00'), row('9002', '11', '1', '1.00'), row('9999', '77', '1', '1.00')],
      netsuite: [],
    }));
    const byKey = new Map(compared.lines.map((l) => [l.key, l]));
    expect(byKey.get('9001|11')).toMatchObject({ item: 'LDR-24', description: 'Ladder rack 24 in', location: 'Wentzville' });
    expect(byKey.get('9002|11')).toMatchObject({ item: 'LDR-9', description: null });
    expect(byKey.get('9999|77')).toMatchObject({ item: 'Item 9999', description: null, location: 'Location 77' });
  });

  it('counts a hair apart as the same, and compares values only when NetSuite gives them', () => {
    const compared = compareStock(data({
      rows: [row('9001', '11', '2.0000001', '50.00')],
      netsuite: [{ item_id: '9001', location_id: '11', quantity: '2', value: null }],
    }));
    expect(compared.lines[0]).toMatchObject({ countDiffers: false, valueDiffers: false, netsuite: { quantity: 2, value: null } });
    expect(compared.value).toEqual({ fleetsuite: 5000, netsuite: null });
  });

  it('leaves out what both sides have none of, and counts it', () => {
    const compared = compareStock(data({
      rows: [row('9001', '11', '0', '0'), row('9002', '11', '0', '0')],
      netsuite: [{ item_id: '9002', location_id: '11', quantity: '1', value: '5.00' }],
    }));
    expect(compared.lines.map((l) => l.key)).toEqual(['9002|11']);
    expect(compared.cleared).toBe(1);
  });

  it('labels value left over where neither side has any on hand and NetSuite values it at nothing', () => {
    const compared = compareStock(data({
      rows: [
        // Sold out on both sides, but its shipments left value on the inventory account.
        row('9001', '11', '0', '90.60'),
        // On hand, worth less in NetSuite.
        row('9002', '11', '2', '20.00'),
        // None here, but NetSuite has one.
        row('9003', '11', '0', '5.00'),
      ],
      netsuite: [{ item_id: '9002', location_id: '11', quantity: '2', value: '15.00' }, { item_id: '9003', location_id: '11', quantity: '1', value: '5.00' }],
    }));
    const byKey = new Map(compared.lines.map((l) => [l.key, l]));
    expect(byKey.get('9001|11')).toMatchObject({ countDiffers: false, valueDiffers: true, leftover: true, netsuite: { quantity: 0, value: 0 } });
    expect(byKey.get('9002|11')).toMatchObject({ countDiffers: false, valueDiffers: true, leftover: false });
    expect(byKey.get('9003|11')).toMatchObject({ countDiffers: true, valueDiffers: false, leftover: false });
  });

  it("doesn't label value left over when NetSuite gives no values, or before its counts are read", () => {
    const unvalued = compareStock(data({
      rows: [row('9001', '11', '0', '90.60'), row('9002', '11', '1', '1.00')],
      netsuite: [{ item_id: '9002', location_id: '11', quantity: '1', value: null }],
    }));
    expect(unvalued.lines.find((l) => l.key === '9001|11')).toMatchObject({ valueDiffers: false, leftover: false });
    const unread = compareStock(data({ rows: [row('9001', '11', '0', '90.60')], netsuite_read_at: null }));
    expect(unread.lines[0]).toMatchObject({ valueDiffers: false, leftover: false });
  });

  it("adds each company's items up next to what the copy of NetSuite's ledger holds on the inventory accounts", () => {
    const compared = compareStock(data({
      rows: [row('9001', '11', '1', '100.00'), row('9002', '12', '1', '50.00'), row('9001', '13', '1', '20.00', '1084')],
      ledger: [{ company: 'BMG', balance: '175.00' }, { company: '1084', balance: '20.00' }, { company: 'ACME', balance: '0' }],
    }));
    expect(compared.ledger).toEqual([{ company: 'BMG', balance: 17500, items: 15000 }, { company: '1084', balance: 2000, items: 2000 }]);
  });
});

describe('stockSetup', () => {
  it('names each item and its asset account, says what kind of account that is, and orders them by item number', () => {
    const setup = stockSetup({
      items: [
        { netsuite_id: '9010', name: 'LDR-10', display_name: 'Ladder rack 10 ft', account: { netsuite_id: '580', number: '5000', name: 'Cost of goods sold', type: 'cost_of_goods_sold' } },
        { netsuite_id: '9009', name: 'LDR-9', display_name: 'LDR-9', account: { netsuite_id: '610', number: null, name: 'Shop supplies', type: 'expense' } },
        { netsuite_id: '9011', name: 'BIN-1', display_name: null, account: { netsuite_id: '700', number: null, name: '', type: 'something_new' } },
      ],
      usual: { netsuite_id: '190', number: '1200', name: 'Inventory' },
    });
    expect(setup).toEqual({
      items: [
        { itemId: '9011', item: 'BIN-1', description: null, account: 'NetSuite account 700', accountKind: 'not an asset account' },
        { itemId: '9009', item: 'LDR-9', description: null, account: 'Shop supplies', accountKind: 'an expense account' },
        { itemId: '9010', item: 'LDR-10', description: 'Ladder rack 10 ft', account: '5000 Cost of goods sold', accountKind: 'a cost of goods sold account' },
      ],
      usual: '1200 Inventory',
    });
  });

  it('lists nothing when every stocked item has an asset account, or nothing was read', () => {
    expect(stockSetup({ items: [], usual: null })).toEqual({ items: [], usual: null });
    expect(stockSetup(null)).toEqual({ items: [], usual: null });
  });
});

/** One move as gl_stock_item_moves gives it. */
const move = (document_id: string, type: string, posting_month: string | null) => ({
  document_id, type, number: null, date: '2026-09-02', company: 'BMG', location_id: '11',
  quantity: '1', value: '10.00', quantity_since: '1', value_since: '10.00', posting_month,
});
const moves = (over: Partial<StockItemMovesData>): StockItemMovesData => ({
  item: ITEMS[0], opening: [], netsuite: [], netsuite_read_at: '2026-10-18T13:45:00Z', moves: [], count: 0, totals: [], locations: LOCATIONS, ...over,
});

describe('itemMoves', () => {
  it('links each move to the switch of Invoices vs NetSuite that checks it, and the rest to nothing', () => {
    const page = itemMoves(moves({
      moves: [
        move('1', 'ItemShip', '2026-09-01'), move('2', 'CustInvc', '2026-09-01'), move('3', 'VendBill', '2026-09-01'),
        move('4', 'VendCred', '2026-10-01'), move('5', 'CashSale', '2026-09-01'), move('6', 'ItemRcpt', null),
      ],
      count: 6,
    }));
    expect(page.moves.map((m) => m.check)).toEqual([
      { kind: 'stock', month: '2026-09-01' }, { kind: 'stock', month: '2026-09-01' }, { kind: 'bill', month: '2026-09-01' },
      { kind: 'bill', month: '2026-10-01' }, null, null,
    ]);
    expect(page.moves[0]).toMatchObject({ typeName: 'Item Fulfillment', number: 'NetSuite 1', location: 'Wentzville' });
  });

  it("puts NetSuite's company-wide count beside the item, not beside a location, when that's all NetSuite gives", () => {
    const page = itemMoves(moves({
      opening: [{ company: 'BMG', location_id: '11', quantity: '3', value: '30.00' }],
      totals: [{ company: 'BMG', location_id: '11', quantity: '2', value: '20.00' }],
      netsuite: [{ location_id: null, quantity: '6', value: null }],
    }));
    expect(page.by).toBe('item');
    expect(page.places).toEqual([
      { locationId: '11', location: 'Wentzville', start: { quantity: 3, value: 3000 }, fleetsuite: { quantity: 5, value: 5000 }, netsuite: null },
    ]);
    expect(page.netsuite).toEqual({ quantity: 6, value: null });
  });

  it("compares nothing before NetSuite's counts are read", () => {
    const page = itemMoves(moves({ netsuite_read_at: null }));
    expect(page.by).toBeNull();
    expect(page.netsuite).toBeNull();
    expect(page.leftover).toEqual([]);
  });

  it('marks the moves that moved the count one way and the value the other', () => {
    const page = itemMoves(moves({
      moves: [
        // A receipt that put nothing on the inventory account, then a shipment that put value on it: swapped accounts.
        { ...move('1', 'ItemRcpt', '2026-09-01'), quantity: '2', value: '0' },
        { ...move('2', 'ItemShip', '2026-09-01'), quantity: '-2', value: '90.60' },
        // A return of it the same way round.
        { ...move('3', 'CustCred', '2026-09-01'), quantity: '1', value: '-45.30' },
        // An ordinary shipment, and a cost NetSuite worked out again with nothing moved.
        { ...move('4', 'ItemShip', '2026-09-01'), quantity: '-1', value: '-45.30' },
        { ...move('5', 'InvAdjst', '2026-09-01'), quantity: '0', value: '3.00' },
      ],
      count: 5,
    }));
    expect(page.moves.map((m) => [m.documentId, m.backwards])).toEqual([['1', false], ['2', true], ['3', true], ['4', false], ['5', false]]);
  });

  it('names where the item has value left over: none on hand either side and NetSuite valuing it at nothing', () => {
    const page = itemMoves(moves({
      opening: [{ company: 'BMG', location_id: '11', quantity: '0', value: '0' }],
      totals: [
        { company: 'BMG', location_id: '11', quantity: '0', value: '90.60' },
        { company: 'BMG', location_id: '12', quantity: '1', value: '45.30' },
      ],
      netsuite: [{ location_id: '12', quantity: '1', value: '45.30' }],
    }));
    expect(page.by).toBe('location');
    expect(page.leftover).toEqual([{ locationId: '11', location: 'Wentzville', value: 9060 }]);

    // Counted company-wide, the item everywhere.
    const everywhere = itemMoves(moves({
      totals: [{ company: 'BMG', location_id: '11', quantity: '0', value: '90.60' }],
      netsuite: [{ location_id: null, quantity: '0', value: '0' }],
    }));
    expect(everywhere.by).toBe('item');
    expect(everywhere.leftover).toEqual([{ locationId: null, location: null, value: 9060 }]);
  });
});

describe('quantityText', () => {
  it('writes a quantity as people do: no trailing zeros, thousands grouped, no float noise', () => {
    expect(quantityText(1250.5)).toBe('1,250.5');
    expect(quantityText(0.1 + 0.2)).toBe('0.3');
    expect(quantityText(-0)).toBe('0');
    expect(quantityText(-3)).toBe('-3');
    expect(quantityText(1 / 3)).toBe('0.33333');
  });
});

describe('ledgerParts', () => {
  const part = {
    company: 'BMG', account_id: '190', number: '1200', name: 'Inventory', type: 'other_current_asset',
    ledger_start: '1750.00', ledger_moves: '356.00', items_start: '1860.00', items_moves: '731.00',
    entries: 4, entries_total: '-374.99',
    kinds: [{ type: 'Journal', count: 3, total: '-375.00' }, { type: null, count: 1, total: '0.01' }],
    rows: [
      { doc: '5901', type: 'Journal', number: 'JE77', date: '2025-12-31', month: '2025-12-01', name: null, memo: 'Year-end count', amount: '-400.00' },
      { doc: '5903', type: null, number: null, date: null, month: null, name: null, memo: null, amount: '0.01' },
    ],
    usual: true, named: 3, named_items: [],
  };

  it("puts each account's ledger and items side by side, and says what the documents not sent come to", () => {
    const [p] = ledgerParts({ parts: [part] });
    expect(p).toMatchObject({
      company: 'BMG', accountId: '190', account: '1200 Inventory', fixedAsset: false,
      ledger: { start: 175000, moves: 35600, now: 210600 },
      items: { start: 186000, moves: 73100, now: 259100 },
    });
    expect(p.entries).toEqual({
      count: 4,
      total: -37499,
      kinds: [{ type: 'Journal', count: 3, total: -37500 }, { type: 'Entry', count: 1, total: 1 }],
      rows: [
        { doc: '5901', date: '2025-12-31', type: 'Journal', number: 'JE77', name: null, memo: 'Year-end count', amount: -40000, check: { kind: 'journal_entry', month: '2025-12-01' } },
        // A document the copy has no transaction for: named by its id, with nowhere to check it.
        { doc: '5903', date: null, type: 'Entry', number: 'NetSuite 5903', name: null, memo: null, amount: 1, check: null },
      ],
      more: { count: 2, total: 2500 },
    });
  });

  it('names an account the chart lacks by its NetSuite id, and marks a fixed asset account', () => {
    const [missing, equipment] = ledgerParts({
      parts: [
        { ...part, account_id: '777', number: null, name: null, type: null, entries: 0, entries_total: '0', kinds: [], rows: [] },
        { ...part, account_id: '195', number: '1500', name: 'Equipment', type: 'fixed_asset' },
      ],
    });
    expect(missing).toMatchObject({ account: 'NetSuite account 777', fixedAsset: false, entries: { count: 0, total: 0, more: { count: 0, total: 0 } } });
    expect(equipment).toMatchObject({ account: '1500 Equipment', fixedAsset: true });
    expect(ledgerParts(null)).toEqual([]);
  });

  it('names the stocked items behind any account but the usual one, with the usual account to set them to', () => {
    const [inventory, vehicles, unnamed] = ledgerParts({
      parts: [
        part,
        {
          ...part, account_id: '196', number: '1510', name: 'Vehicles', type: 'fixed_asset', usual: false, named: 22,
          named_items: [
            { netsuite_id: '9500', name: 'VAN-14', display_name: 'Cargo van, unit 14', active: false },
            { netsuite_id: '9501', name: 'VAN-15', display_name: 'VAN-15', active: true },
          ],
        },
        { ...part, account_id: '197', usual: false, named: 0, named_items: [] },
      ],
      usual: { netsuite_id: '190', number: '1200', name: 'Inventory' },
    });
    expect(inventory.namedBy).toBeNull();
    expect(vehicles.namedBy).toEqual({
      count: 22,
      items: [
        { itemId: '9500', item: 'VAN-14', description: 'Cargo van, unit 14', active: false },
        { itemId: '9501', item: 'VAN-15', description: null, active: true },
      ],
      more: 20,
      usual: '1200 Inventory',
    });
    expect(unnamed.namedBy).toBeNull();
  });
});
