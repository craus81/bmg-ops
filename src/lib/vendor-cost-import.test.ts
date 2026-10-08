import { describe, expect, it } from 'vitest';
import { parseMarginCell, parseMoneyCell, vendorCostRowsFromCells } from './vendor-cost-import';

describe('cell parsing', () => {
  it('reads dollar amounts', () => {
    expect(parseMoneyCell('$1,234.50')).toBe(1234.5);
    expect(parseMoneyCell(' 12 ')).toBe(12);
    expect(parseMoneyCell('')).toBeNull();
    expect(parseMoneyCell('n/a')).toBeNaN();
  });

  it('reads margins as percents, including Excel percent cells stored as fractions', () => {
    expect(parseMarginCell('35%')).toBe(35);
    expect(parseMarginCell('35')).toBe(35);
    expect(parseMarginCell('0.35')).toBe(35);
    expect(parseMarginCell('0.425')).toBe(42.5);
    expect(parseMarginCell('')).toBeNull();
    expect(parseMarginCell('high')).toBeNaN();
  });
});

describe('vendorCostRowsFromCells', () => {
  it('finds the header under a title row and reads columns in any order', () => {
    const out = vendorCostRowsFromCells([
      ['Outsourced parts 2026'],
      ['Margin %', 'Part #', 'Description', 'Vendor', 'Vendor Cost'],
      ['0.4', '02t278', 'Orkin kit', 'Acme Signs', '$300'],
      ['', '06T278', 'Install', '', '120'],
    ]);
    expect(out.error).toBeNull();
    expect(out.rows).toEqual([
      { line: 3, partNumber: '02T278', vendor: 'Acme Signs', vendorCost: 300, marginPct: 40, problem: null },
      { line: 4, partNumber: '06T278', vendor: null, vendorCost: 120, marginPct: null, problem: null },
    ]);
  });

  it('flags bad values, empty rows and repeats (the later row wins)', () => {
    const out = vendorCostRowsFromCells([
      ['Part Number', 'Cost', 'Margin'],
      ['A1', 'abc', '30'],
      ['A2', '', ''],
      ['A3', '10', '150'],
      ['A4', '10', '30'],
      ['A4', '11', '30'],
    ]);
    expect(out.rows.map(r => [r.partNumber, r.problem && r.problem.split(' ')[0]])).toEqual([
      ['A1', 'Vendor'],
      ['A2', 'No'],
      ['A3', 'Margin'],
      ['A4', 'Listed'],
      ['A4', null],
    ]);
  });

  it('needs a part number column and a cost or margin column', () => {
    expect(vendorCostRowsFromCells([['Part', 'Description'], ['A1', 'x']]).error).toMatch(/header row/);
  });
});
