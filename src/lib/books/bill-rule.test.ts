import { describe, it, expect } from 'vitest';
import { BILL_RULE, PAYABLES_LINE, billEntry, type BillAccounts, type BillItem, type BillLine } from './bill-rule';

// Made-up books: '200' payables, '205' received not billed, '130' inventory,
// '530' subcontractors, '610' shop supplies, '520' freight in, '480' vendor
// discounts.
const item = (number: string, type: string, accounts: Partial<Pick<BillItem, 'assetAccount' | 'expenseAccount' | 'incomeAccount'>> = {}): BillItem => ({
  number, type, assetAccount: null, expenseAccount: null, incomeAccount: null, ...accounts,
});
const ITEMS = new Map<string, BillItem>([
  ['901', item('WIDGET-1', 'InvtPart', { assetAccount: '130' })],
  ['902', item('SUPPLY-2', 'NonInvtPart', { expenseAccount: '610' })],
  ['903', item('FREIGHT', 'OthCharge', { expenseAccount: '520' })],
  ['904', item('DISC', 'Discount', { incomeAccount: '480' })],
  ['905', item('NO-ACCT', 'Service')],
  ['906', item('ASSY-6', 'Assembly')],
  ['907', item('SUB', 'Subtotal')],
]);
const ACCOUNTS: BillAccounts = { items: ITEMS, payables: '200', received: '205' };

const expense = (lineId: string, account: string | null, cents: number | null): BillLine => ({ lineId, itemId: null, account, cents, tax: false });
const line = (lineId: string, itemId: string, cents: number | null): BillLine => ({ lineId, itemId, account: null, cents, tax: false });
const entry = (lines: BillLine[], ordered: boolean | null = false, accounts = ACCOUNTS) => billEntry({ lines, ordered }, accounts);
const posted = (r: ReturnType<typeof billEntry>) => r.lines.map((l) => [l.lineId, l.role, l.account, l.cents]);

describe('billEntry (bill@1)', () => {
  it('names its rule with a version', () => {
    expect(BILL_RULE).toBe('bill@1');
  });

  it('credits payables with the total and debits an expense line to its own account', () => {
    const r = entry([expense('1', '530', 50000)]);
    expect(r.problems).toEqual([]);
    expect(posted(r)).toEqual([
      [PAYABLES_LINE, 'payables', '200', -50000],
      ['1', 'expense', '530', 50000],
    ]);
    expect(r.lines.map((l) => [l.itemNumber, l.division])).toEqual([[null, null], [null, null]]);
    expect(r.lines.reduce((sum, l) => sum + l.cents, 0)).toBe(0);
  });

  it('puts a non-stock item to its expense account, and a discount to its own account', () => {
    const r = entry([line('1', '902', 12000), line('2', '903', 1500), line('3', '904', -2000)]);
    expect(r.problems).toEqual([]);
    expect(posted(r)).toEqual([
      [PAYABLES_LINE, 'payables', '200', -11500],
      ['1', 'item', '610', 12000],
      ['2', 'item', '520', 1500],
      ['3', 'item', '480', -2000],
    ]);
    expect(r.lines.map((l) => l.itemNumber)).toEqual([null, 'SUPPLY-2', 'FREIGHT', 'DISC']);
  });

  it('holds ordered stock in the received account, and puts stock bought on the bill itself to its asset account', () => {
    expect(posted(entry([line('1', '901', 30000)], true))).toEqual([[PAYABLES_LINE, 'payables', '200', -30000], ['1', 'received', '205', 30000]]);
    expect(posted(entry([line('1', '901', 30000)], false))).toEqual([[PAYABLES_LINE, 'payables', '200', -30000], ['1', 'stock', '130', 30000]]);
    // With receipts that post nowhere, stock always goes to its asset account, and what the bill came from doesn't matter.
    const noReceipts = { ...ACCOUNTS, received: null };
    expect(posted(entry([line('1', '901', 30000)], true, noReceipts))).toEqual([[PAYABLES_LINE, 'payables', '200', -30000], ['1', 'stock', '130', 30000]]);
    expect(entry([line('1', '901', 30000)], null, noReceipts).problems).toEqual([]);
    // Non-stock items go to their expense account either way.
    expect(posted(entry([line('1', '902', 500)], true))).toEqual([[PAYABLES_LINE, 'payables', '200', -500], ['1', 'item', '610', 500]]);
  });

  it('posts a bill credit the other way round', () => {
    const r = entry([line('1', '902', -12000), expense('2', '530', -3000)]);
    expect(posted(r)).toEqual([
      [PAYABLES_LINE, 'payables', '200', 15000],
      ['1', 'item', '610', -12000],
      ['2', 'expense', '530', -3000],
    ]);
  });

  it('skips $0 lines and lines that never post', () => {
    const r = entry([line('1', '902', 12000), line('2', '-2', 12000), line('3', '907', 12000), line('4', '905', 0), expense('5', null, 0)]);
    expect(r.problems).toEqual([]);
    expect(posted(r)).toEqual([[PAYABLES_LINE, 'payables', '200', -12000], ['1', 'item', '610', 12000]]);
    expect(entry([])).toEqual({ lines: [], problems: [] });
  });

  it('owes nothing on a document that comes to $0, though its lines still post', () => {
    const r = entry([line('1', '902', 5000), line('2', '904', -5000)], false, { ...ACCOUNTS, payables: null });
    expect(r.problems).toEqual([]);
    expect(posted(r)).toEqual([['1', 'item', '610', 5000], ['2', 'item', '480', -5000]]);
  });

  it('says why it can\'t work a document out, and then posts none of it', () => {
    const r = entry([
      line('1', '902', 12000),
      line('2', '902', null),
      { ...expense('3', null, 800), tax: true },
      expense('4', null, 500),
      line('5', '999', 700),
      line('6', '905', 900),
      line('7', '906', 1100),
    ]);
    expect(r.lines).toEqual([]);
    expect(r.problems).toEqual([
      { kind: 'unreadable', lineId: '2' },
      { kind: 'tax', lineId: '3' },
      { kind: 'no_account', lineId: '4' },
      { kind: 'not_copied', lineId: '5', itemId: '999' },
      { kind: 'no_item_account', lineId: '6', itemId: '905', itemNumber: 'NO-ACCT', stock: false },
      { kind: 'no_item_account', lineId: '7', itemId: '906', itemNumber: 'ASSY-6', stock: true },
    ]);
  });

  it('needs to know what ordered stock came from, and a payables account for anything owed', () => {
    expect(entry([line('1', '901', 30000), line('2', '901', 100)], null).problems).toEqual([{ kind: 'no_links' }]);
    // Without stock on it, what it came from doesn't matter.
    expect(entry([line('1', '902', 100)], null).problems).toEqual([]);
    expect(entry([line('1', '902', 100)], false, { ...ACCOUNTS, payables: null })).toEqual({ lines: [], problems: [{ kind: 'no_payables' }] });
    expect(entry([line('1', '902', 0)], false, { ...ACCOUNTS, payables: null }).problems).toEqual([]);
  });
});
