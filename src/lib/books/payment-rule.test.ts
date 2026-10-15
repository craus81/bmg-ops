import { describe, it, expect } from 'vitest';
import { DEPOSIT_LINE, DISCOUNT_LINE, PAYMENT_RULE, RECEIVABLE_LINE, paymentEntry } from './payment-rule';

// Made-up accounts: '120' receivable, '110' Undeposited Funds, '480' sales discounts.

describe('paymentEntry (payment@1)', () => {
  it('names its rule with a version', () => {
    expect(PAYMENT_RULE).toBe('payment@1');
  });

  it('puts the money in the account it was deposited to and credits receivables with the total', () => {
    const r = paymentEntry({ cents: 16200, depositAccount: '110' }, '120');
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.lineId, l.account, l.cents, l.division])).toEqual([
      [DEPOSIT_LINE, '110', 16200, null],
      [RECEIVABLE_LINE, '120', -16200, null],
    ]);
    expect(r.lines.reduce((sum, l) => sum + l.cents, 0)).toBe(0);
  });

  it('books a discount the customer took and credits receivables with the money plus the discount', () => {
    // $162.00 of invoices paid with $3.24 off: $158.76 came in.
    const r = paymentEntry({ cents: 15876, depositAccount: '110', discount: { account: '480', cents: 324 } }, '120');
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.lineId, l.account, l.cents])).toEqual([
      [DEPOSIT_LINE, '110', 15876],
      [DISCOUNT_LINE, '480', 324],
      [RECEIVABLE_LINE, '120', -16200],
    ]);
    expect(r.lines.reduce((sum, l) => sum + l.cents, 0)).toBe(0);
    // A discount of $0 is no discount.
    expect(paymentEntry({ cents: 15876, depositAccount: '110', discount: { account: '480', cents: 0 } }, '120').lines.map((l) => l.lineId))
      .toEqual([DEPOSIT_LINE, RECEIVABLE_LINE]);
  });

  it('posts nothing for a payment of $0, one that only applies a credit', () => {
    expect(paymentEntry({ cents: 0, depositAccount: null }, '120')).toEqual({ lines: [], problems: [] });
  });

  it('posts just the discount for a payment of $0 that takes one, with no money to say where it went', () => {
    const r = paymentEntry({ cents: 0, depositAccount: null, discount: { account: '480', cents: 324 } }, '120');
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.lineId, l.account, l.cents])).toEqual([[DISCOUNT_LINE, '480', 324], [RECEIVABLE_LINE, '120', -324]]);
  });

  it('posts nothing and says why when it can\'t be worked out', () => {
    expect(paymentEntry({ cents: null, depositAccount: '110' }, '120')).toEqual({ lines: [], problems: [{ kind: 'unreadable' }] });
    expect(paymentEntry({ cents: 500, depositAccount: null }, null)).toEqual({
      lines: [],
      problems: [{ kind: 'no_deposit_account' }, { kind: 'no_receivable' }],
    });
    expect(paymentEntry({ cents: 500, depositAccount: '110' }, null).problems).toEqual([{ kind: 'no_receivable' }]);
  });
});
