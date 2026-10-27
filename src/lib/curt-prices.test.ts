import { describe, expect, it } from 'vitest';
import { marginPct, parseCurtPriceRows } from './curt-prices';

const sheet: unknown[][] = [
  [null, 'Customer Item Prices\nBMG FLEET INSTALLATIONS (10729901)', null, null, null, null, null, null, null, 'Report Generated: 2026-10-26'],
  ['Brand Name', 'Item Number', 'Item Description', 'PB', 'Price Code', 'Price', 'Jobber', 'MAP', 'List', 'Weight', 'UPC'],
  ['CURT Manufacturing     ', '13193', 'CLASS III RECEIVER HITCH  ', 'ID', '     ', 194.36, 242.95, null, 285.95, 52, '612314131938   '],
  ['CURT Manufacturing', 51146, 'BRK CNTRL, TRIFLEX NEXT, PKG', 'ID', 'E21', '102.31', '131.17', '141.95', '156.95', 2.1, null],
  ['CURT Manufacturing', '99999', 'NO PRICE', 'ID', '', null, null, null, null, null, null],
  [],
];

describe('parseCurtPriceRows', () => {
  it('finds the header under the title row and reads every priced part', () => {
    const p = parseCurtPriceRows(sheet);
    expect(p.reportDate).toBe('2026-10-26');
    expect(p.skipped).toBe(2);
    expect(p.rows).toEqual([
      { item_number: '13193', brand: 'CURT Manufacturing', description: 'CLASS III RECEIVER HITCH', price_code: null, cost: 194.36, jobber: 242.95, map: null, list_price: 285.95, weight_lb: 52, upc: '612314131938' },
      { item_number: '51146', brand: 'CURT Manufacturing', description: 'BRK CNTRL, TRIFLEX NEXT, PKG', price_code: 'E21', cost: 102.31, jobber: 131.17, map: 141.95, list_price: 156.95, weight_lb: 2.1, upc: null },
    ]);
  });

  it('reads the report date from Excel rich text', () => {
    const p = parseCurtPriceRows([
      [{ richText: [{ text: 'Report Generated: ' }, { text: '2026-10-26' }] }],
      ['Item Number', 'Price'], ['13193', 194.36],
    ]);
    expect(p.reportDate).toBe('2026-10-26');
  });

  it('reads columns by title, in any order', () => {
    const p = parseCurtPriceRows([['List', 'Price', 'Item Number'], [10, 6, 'A1']]);
    expect(p.rows[0]).toMatchObject({ item_number: 'A1', cost: 6, list_price: 10, brand: null });
  });

  it('refuses a file that is not the price file', () => {
    expect(() => parseCurtPriceRows([['Part', 'Qty'], ['1', 2]])).toThrow(/Curt price file/);
  });
});

describe('marginPct', () => {
  it('is the margin on the sell price', () => {
    expect(marginPct(285.95, 194.36)).toBe(32);
    expect(marginPct(100, null)).toBeNull();
    expect(marginPct(0, 5)).toBeNull();
  });
});
