import { describe, it, expect } from 'vitest';
import type { BillItem, BillLine } from './bill-rule';
import { PAID_FROM_LINE } from './bill-payment-rule';
import { SPENDING_RULE, spendingEntry, type SpendingAccounts } from './spending-rule';

// Made-up books: '100' the bank, '220' the Chase card, '130' inventory,
// '610' shop supplies, '640' meals, '520' freight in, '480' vendor discounts.
const item = (number: string, type: string, accounts: Partial<Pick<BillItem, 'assetAccount' | 'expenseAccount' | 'incomeAccount'>> = {}): BillItem => ({
  number, type, assetAccount: null, expenseAccount: null, incomeAccount: null, ...accounts,
});
const ITEMS = new Map<string, BillItem>([
  ['901', item('WIDGET-1', 'InvtPart', { assetAccount: '130' })],
  ['902', item('SUPPLY-2', 'NonInvtPart', { expenseAccount: '610' })],
  ['903', item('FREIGHT', 'OthCharge', { expenseAccount: '520' })],
  ['904', item('DISC', 'Discount', { incomeAccount: '480' })],
  ['905', item('NO-ACCT', 'Service')],
  ['907', item('SUB', 'Subtotal')],
]);
const CARD: SpendingAccounts = { items: ITEMS, paidFrom: '220' };

const expense = (lineId: string, account: string | null, cents: number | null): BillLine => ({ lineId, itemId: null, account, cents, tax: false });
const line = (lineId: string, itemId: string, cents: number | null): BillLine => ({ lineId, itemId, account: null, cents, tax: false });
const entry = (lines: BillLine[], accounts = CARD) => spendingEntry({ lines }, accounts);
const posted = (r: ReturnType<typeof spendingEntry>) => r.lines.map((l) => [l.lineId, l.role, l.account, l.cents]);

describe('spendingEntry (spending@1)', () => {
  it('names its rule with a version', () => {
    expect(SPENDING_RULE).toBe('spending@1');
  });

  it('credits the account the money comes out of with the total and debits each line where a bill\'s would go', () => {
    const r = entry([expense('1', '640', 4512), line('2', '902', 12000), line('3', '903', 1500), line('4', '904', -2000)]);
    expect(r.problems).toEqual([]);
    expect(posted(r)).toEqual([
      [PAID_FROM_LINE, 'paid_from', '220', -16012],
      ['1', 'expense', '640', 4512],
      ['2', 'item', '610', 12000],
      ['3', 'item', '520', 1500],
      ['4', 'item', '480', -2000],
    ]);
    expect(r.lines.map((l) => l.itemNumber)).toEqual([null, null, 'SUPPLY-2', 'FREIGHT', 'DISC']);
    expect(r.lines.reduce((sum, l) => sum + l.cents, 0)).toBe(0);
  });

  it('puts stock to its asset account, as nothing on a check or a card is received first', () => {
    expect(posted(entry([line('1', '901', 30000)], { ...CARD, paidFrom: '100' }))).toEqual([
      [PAID_FROM_LINE, 'paid_from', '100', -30000], ['1', 'stock', '130', 30000],
    ]);
    // Even a line that says it was ordered: nothing on a check or a card was received to post it against.
    expect(posted(entry([{ ...line('1', '901', 30000), ordered: true }]))).toEqual([
      [PAID_FROM_LINE, 'paid_from', '220', -30000], ['1', 'stock', '130', 30000],
    ]);
  });

  it('posts a refund the other way round: its lines credited, the card debited', () => {
    expect(posted(entry([expense('1', '610', -2599), line('2', '901', -1000)]))).toEqual([
      [PAID_FROM_LINE, 'paid_from', '220', 3599], ['1', 'expense', '610', -2599], ['2', 'stock', '130', -1000],
    ]);
  });

  it('posts nothing for a line of $0, a subtotal, or a document of $0', () => {
    expect(posted(entry([expense('1', '640', 2500), expense('2', '610', 0), line('3', '907', 2500)]))).toEqual([
      [PAID_FROM_LINE, 'paid_from', '220', -2500], ['1', 'expense', '640', 2500],
    ]);
    expect(entry([expense('1', '640', 0)])).toEqual({ lines: [], problems: [] });
    expect(entry([])).toEqual({ lines: [], problems: [] });
    // Lines that come to nothing need no account to come out of.
    expect(posted(entry([expense('1', '640', 500), expense('2', '610', -500)], { ...CARD, paidFrom: null }))).toEqual([
      ['1', 'expense', '640', 500], ['2', 'expense', '610', -500],
    ]);
  });

  it('goes where NetSuite posts an item the copy has no account for', () => {
    expect(posted(entry([line('1', '905', 7500)], { ...CARD, posted: new Map([['905', '530']]) }))).toEqual([
      [PAID_FROM_LINE, 'paid_from', '220', -7500], ['1', 'item', '530', 7500],
    ]);
  });

  it('posts nothing, and says why, when a line or the account the money comes out of can\'t be worked out', () => {
    const r = entry([expense('1', null, 100), line('2', '999', 200), line('3', '905', 300), expense('4', '640', null), { ...expense('5', '640', 50), tax: true }]);
    expect(r.lines).toEqual([]);
    expect(r.problems).toEqual([
      { kind: 'no_account', lineId: '1' },
      { kind: 'not_copied', lineId: '2', itemId: '999' },
      { kind: 'no_item_account', lineId: '3', itemId: '905', itemNumber: 'NO-ACCT', stock: false },
      { kind: 'unreadable', lineId: '4' },
      { kind: 'tax', lineId: '5' },
    ]);
    expect(entry([expense('1', '640', 100)], { ...CARD, paidFrom: null })).toEqual({ lines: [], problems: [{ kind: 'no_paid_from' }] });
    expect(entry([line('1', '901', 100)], { ...CARD, items: new Map([['901', item('WIDGET-1', 'InvtPart')]]) }).problems).toEqual([
      { kind: 'no_item_account', lineId: '1', itemId: '901', itemNumber: 'WIDGET-1', stock: true },
    ]);
  });
});
