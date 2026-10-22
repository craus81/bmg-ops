import { describe, it, expect } from 'vitest';
import { salesReport, splitLine, stateOf, NO_LOCATION, type SalesLine } from './sales-report';

const line = (over: Partial<SalesLine>): SalesLine => ({
  tran_type: 'CustInvc', account: '40', account_number: '4000', account_name: 'Installation Income',
  location_id: '1', location: "O'Fallon", class_id: '7', class: 'Upfit',
  debit: '0', credit: '0', lines: 1, ...over,
});

describe('stateOf', () => {
  it("puts BMG's locations in their states", () => {
    expect(stateOf("O'Fallon")).toBe('MO');
    expect(stateOf('Wentzville')).toBe('MO');
    expect(stateOf('Kansas City')).toBe('MO');
    expect(stateOf('Social Circle')).toBe('GA');
    expect(stateOf('Somewhere new')).toBe('—');
    expect(stateOf(null)).toBe('—');
  });
});

describe('splitLine', () => {
  it("counts an invoice's credits as gross sales and its debits as discounts", () => {
    expect(splitLine(line({ credit: '1000.00', debit: '50.00' }))).toEqual({ gross: 100000, discounts: -5000 });
  });
  it('counts credit memos and refunds as returns, whatever the account', () => {
    expect(splitLine(line({ tran_type: 'CustCred', debit: '200.00' }))).toEqual({ returns: -20000 });
    expect(splitLine(line({ tran_type: 'CashRfnd', account_name: 'Freight Income', debit: '10.00' }))).toEqual({ returns: -1000 });
  });
  it('sorts discount and freight accounts by their names', () => {
    expect(splitLine(line({ account_name: 'Sales Discounts', debit: '30.00' }))).toEqual({ discounts: -3000 });
    expect(splitLine(line({ account_name: 'Shipping & Freight Income', credit: '75.00' }))).toEqual({ transportation: 7500 });
  });
  it("counts a payment's discount as a discount and a journal entry as other", () => {
    expect(splitLine(line({ tran_type: 'CustPymt', debit: '12.00' }))).toEqual({ discounts: -1200 });
    expect(splitLine(line({ tran_type: 'Journal', credit: '5.00', debit: '1.00' }))).toEqual({ other: 400 });
  });
});

describe('salesReport', () => {
  const report = salesReport([
    line({ credit: '1000.00' }),
    line({ class_id: '8', class: 'Graphics', credit: '500.00', debit: '20.00' }),
    line({ location_id: '5', location: 'Social Circle', credit: '300.00' }),
    line({ location_id: '2', location: 'Wentzville', tran_type: 'CustCred', debit: '100.00' }),
    line({ location_id: null, location: null, class_id: null, class: null, tran_type: 'Journal', credit: '10.00' }),
    line({ account: '41', account_number: '4100', account_name: 'Freight Income', credit: '40.00' }),
    line({ tran_type: 'Journal', credit: '5.00', debit: '5.00' }),
  ]);

  it('nets to the income on the profit and loss', () => {
    expect(report.total).toEqual({ gross: 180000, returns: -10000, discounts: -2000, transportation: 4000, other: 1000, net: 173000 });
    expect(report.rows.reduce((s, r) => s + r.net, 0)).toBe(report.total.net);
    expect(report.states.reduce((s, r) => s + r.net, 0)).toBe(report.total.net);
    expect(report.accounts.reduce((s, r) => s + r.net, 0)).toBe(report.total.net);
  });

  it('lists states, then locations and classes, with no location last and empty rows left out', () => {
    expect(report.states.map((s) => s.state)).toEqual(['GA', 'MO', '—']);
    expect(report.rows.map((r) => `${r.location}/${r.class}`)).toEqual([
      'Social Circle/Upfit', "O'Fallon/Graphics", "O'Fallon/Upfit", 'Wentzville/Upfit', `${NO_LOCATION}/No class`,
    ]);
    expect(report.rows.find((r) => r.location === "O'Fallon" && r.class === 'Upfit')).toMatchObject({ gross: 100000, transportation: 4000, net: 104000 });
  });

  it('keeps each account with its own amounts', () => {
    expect(report.accounts.map((a) => [a.number, a.net])).toEqual([['4000', 169000], ['4100', 4000]]);
  });
});
