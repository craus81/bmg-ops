import { describe, it, expect } from 'vitest';
import { fillCostsFromDiscount, parsePastedPrices, planPriceUpdates, priceRowsFromCells, sameMoney } from './price-update-import';

describe('priceRowsFromCells', () => {
  it('finds the header under title lines and reads price and cost', () => {
    const out = priceRowsFromCells([
      ['2026 DISTRIBUTOR PRICE BOOK'],
      [''],
      ['Part Number', 'Description', 'List Price', 'Our Cost'],
      ['020711kp', 'VENTED GAS TANK CABINET', '$633', '$443.10'],
      ['02P142KP', 'UPLYFT', '5,477', ''],
    ]);
    expect(out.error).toBeNull();
    expect(out.rows).toEqual([
      { line: 4, partNumber: '020711KP', price: 633, cost: 443.1, problem: null },
      { line: 5, partNumber: '02P142KP', price: 5477, cost: null, problem: null },
    ]);
  });

  it('takes a cost-only sheet', () => {
    const out = priceRowsFromCells([['Item', 'Cost'], ['025527KP', '30.80']]);
    expect(out.rows[0]).toMatchObject({ partNumber: '025527KP', price: null, cost: 30.8, problem: null });
  });

  it('flags junk, a $0 price, empty rows and repeats', () => {
    const out = priceRowsFromCells([
      ['SKU', 'Price', 'Cost'],
      ['A1', 'call', ''],
      ['A2', '0', ''],
      ['A3', '', ''],
      ['A4', '10', ''],
      ['A4', '12', ''],
    ]);
    expect(out.rows.map(r => r.problem)).toEqual([
      'Price “call” isn’t a dollar amount',
      'Price is $0. Leave the cell blank to keep the part’s price.',
      'No price or cost on this row',
      'Listed again on row 6; that row is used',
      null,
    ]);
  });

  it('says so when there is no header', () => {
    expect(priceRowsFromCells([['foo', 'bar']]).error).toMatch(/header row/);
  });

  it('reads rows pasted from Excel', () => {
    expect(parsePastedPrices('Part Number\tPrice\n02D715KP\t64\n').rows[0]).toMatchObject({ partNumber: '02D715KP', price: 64 });
  });
});

describe('fillCostsFromDiscount', () => {
  const rows = priceRowsFromCells([['Part', 'Price', 'Cost'], ['A', '100', ''], ['B', '200', '150'], ['C', '', '5']]).rows;

  it('fills only rows with a price and no cost of their own', () => {
    const out = fillCostsFromDiscount(rows, 30);
    expect(out.map(r => [r.cost, !!r.costFromDiscount])).toEqual([[70, true], [150, false], [5, false]]);
  });

  it('a blank or silly percent fills nothing, and changing it refills', () => {
    expect(fillCostsFromDiscount(rows, null)[0].cost).toBeNull();
    expect(fillCostsFromDiscount(rows, 100)[0].cost).toBeNull();
    const once = fillCostsFromDiscount(rows, 30);
    expect(fillCostsFromDiscount(once, 25)[0].cost).toBe(75);
    expect(fillCostsFromDiscount(once, null)[0].cost).toBeNull();
  });

  it('rounds to the cent', () => {
    const r = priceRowsFromCells([['Part', 'Price'], ['A', '633']]).rows;
    expect(fillCostsFromDiscount(r, 33.3)[0].cost).toBe(422.21);
  });
});

describe('planPriceUpdates', () => {
  const catalog = [
    { id: '1', item_number: '020711KP', display_name: 'Cabinet', is_active: true, sales_price: '612.00', purchase_price: '400' },
    { id: '2', item_number: '02D715KP', display_name: 'Light', is_active: true, sales_price: 64, purchase_price: 30 },
    { id: '3', item_number: '02d715kp', display_name: 'Light (old)', is_active: false, sales_price: 64, purchase_price: 30 },
  ];

  it('says what changes, what stays, and what is missing', () => {
    const out = planPriceUpdates([
      { partNumber: '020711KP', price: 633, cost: null },
      { partNumber: '02D715KP', price: 64 },
      { partNumber: 'NOPE', price: 5 },
    ], catalog);
    expect(out.map(r => [r.partNumber, r.status])).toEqual([['020711KP', 'change'], ['02D715KP', 'same'], ['NOPE', 'not_found']]);
    expect(out[0].current).toEqual({ price: 612, cost: 400 });
    expect(out[0].next).toEqual({ price: 633, cost: 400 });
    expect(out[1].partIds).toEqual(['2', '3']);
    expect(out[1].displayName).toBe('Light');
  });

  it('a cost alone is a change', () => {
    expect(planPriceUpdates([{ partNumber: '02d715kp', cost: 31 }], catalog)[0]).toMatchObject({ status: 'change', next: { price: 64, cost: 31 } });
  });
});

describe('sameMoney', () => {
  it('compares to the cent', () => {
    expect(sameMoney(10, 10.001)).toBe(true);
    expect(sameMoney(10, 10.01)).toBe(false);
    expect(sameMoney(null, 0)).toBe(false);
    expect(sameMoney(null, undefined)).toBe(true);
  });
});
