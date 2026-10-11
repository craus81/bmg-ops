import { describe, it, expect } from 'vitest';
import { INVOICE_RULE, MAIN_LINE, invoiceEntry, type InvoiceLine, type RuleAccounts, type RuleItem } from './invoice-rule';

// Made-up items and accounts: '120' receivable, '400' and '410' income,
// '220' sales tax payable, '480' discounts.
const item = (number: string, type: string | null, incomeAccount: string | null): RuleItem =>
  ({ number, type, incomeAccount, assetAccount: null });

const ACCOUNTS: RuleAccounts = {
  items: new Map([
    ['11', item('PART-A', 'InvtPart', '400')],
    ['12', item('3M VINYL', 'NonInvtPart', '410')],
    ['13', item('INSTALL LABOR', 'Service', '400')],
    ['14', item('DISCOUNT', 'Discount', '480')],
    ['15', item('SUBTOTAL', 'Subtotal', null)],
    ['16', item('FREIGHT', 'OthCharge', '400')],
    ['17', item('NO ACCOUNT', 'Service', null)],
  ]),
  taxAccounts: new Map([['900', '220'], ['', '221']]),
  receivable: '120',
};

const line = (lineId: string, itemId: string | null, cents: number | null, fields: Partial<InvoiceLine> = {}): InvoiceLine =>
  ({ lineId, itemId, itemNumber: null, tax: false, cents, ...fields });
const tax = (lineId: string, taxCode: string | null, cents: number | null) => line(lineId, taxCode, cents, { tax: true });

const posted = (lines: InvoiceLine[], accounts = ACCOUNTS) =>
  invoiceEntry(lines, accounts).lines.map((l) => [l.lineId, l.account, l.cents]);

describe('invoiceEntry (invoice@1)', () => {
  it('names its rule with a version', () => {
    expect(INVOICE_RULE).toBe('invoice@1');
  });

  it('debits receivables with the total, credits each line to its item\'s income account and sales tax to its tax code\'s', () => {
    const r = invoiceEntry([line('1', '11', 10000), line('2', '13', 5000), tax('3', '900', 1200)], ACCOUNTS);
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.lineId, l.account, l.cents])).toEqual([
      [MAIN_LINE, '120', 16200],
      ['1', '400', -10000],
      ['2', '400', -5000],
      ['3', '220', -1200],
    ]);
    expect(r.lines.reduce((sum, l) => sum + l.cents, 0)).toBe(0);
  });

  it('debits a discount to its own account and takes it off the receivable', () => {
    expect(posted([line('1', '11', 10000), line('2', '14', -1000)])).toEqual([
      [MAIN_LINE, '120', 9000],
      ['1', '400', -10000],
      ['2', '480', 1000],
    ]);
  });

  it('skips lines of nothing and subtotals, which repeat amounts and post nothing', () => {
    expect(posted([line('1', '11', 10000), line('2', '13', 0), line('3', '15', 10000), tax('4', '900', 0)])).toEqual([
      [MAIN_LINE, '120', 10000],
      ['1', '400', -10000],
    ]);
  });

  it('files each line Upfit or Graphics by the owner\'s rule, and nothing else', () => {
    const r = invoiceEntry([
      line('1', '11', 100), line('2', '12', 100), line('3', '16', 100, { itemNumber: 'FREIGHT' }), line('4', '14', -50), tax('5', '900', 10),
    ], ACCOUNTS);
    expect(r.lines.map((l) => [l.lineId, l.division])).toEqual([
      [MAIN_LINE, null], ['1', 'upfit'], ['2', 'graphics'], ['3', null], ['4', null], ['5', null],
    ]);
  });

  it('uses the item number on the invoice, falling back to the copied item\'s', () => {
    const r = invoiceEntry([line('1', '11', 100, { itemNumber: '06ABC' }), line('2', '11', 100)], ACCOUNTS);
    expect(r.lines.slice(1).map((l) => [l.itemNumber, l.division])).toEqual([['06ABC', 'graphics'], ['PART-A', 'upfit']]);
  });

  it('posts a tax line with no tax code to where such lines post', () => {
    expect(posted([line('1', '11', 1000), tax('2', null, 80)])).toEqual([[MAIN_LINE, '120', 1080], ['1', '400', -1000], ['2', '221', -80]]);
  });

  it('posts nothing for an invoice of nothing, and needs no receivable for it', () => {
    expect(invoiceEntry([line('1', '11', 0)], { ...ACCOUNTS, receivable: null })).toEqual({ lines: [], problems: [] });
  });

  it('posts nothing at all when it can\'t work out a line, and says why for each', () => {
    const r = invoiceEntry([
      line('1', '11', 10000),
      line('2', '11', null),
      line('3', null, 500),
      line('4', '99', 500, { itemNumber: 'NEW PART' }),
      line('5', '17', 500, { itemNumber: 'NO ACCOUNT' }),
      tax('6', '901', 50),
    ], ACCOUNTS);
    expect(r.lines).toEqual([]);
    expect(r.problems).toEqual([
      { kind: 'unreadable', lineId: '2' },
      { kind: 'no_item', lineId: '3' },
      { kind: 'not_copied', lineId: '4', itemId: '99', itemNumber: 'NEW PART' },
      { kind: 'no_income_account', lineId: '5', itemId: '17', itemNumber: 'NO ACCOUNT' },
      { kind: 'no_tax_account', lineId: '6', taxCode: '901' },
    ]);
  });

  it('can\'t post an invoice with a total when there\'s no receivable account', () => {
    expect(invoiceEntry([line('1', '11', 100)], { ...ACCOUNTS, receivable: null })).toEqual({ lines: [], problems: [{ kind: 'no_receivable' }] });
  });
});
