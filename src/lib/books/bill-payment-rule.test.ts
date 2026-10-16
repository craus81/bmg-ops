import { describe, it, expect } from 'vitest';
import { PAYABLES_LINE } from './bill-rule';
import { BILL_PAYMENT_RULE, DISCOUNT_LINE, PAID_FROM_LINE, billPaymentEntry } from './bill-payment-rule';

// Made-up accounts: '200' payables, '100' a bank account, '220' a credit card, '485' purchase discounts.

describe('billPaymentEntry (bill_payment@1)', () => {
  it('names its rule with a version', () => {
    expect(BILL_PAYMENT_RULE).toBe('bill_payment@1');
  });

  it('takes what it paid off payables and the money out of the account it was paid from', () => {
    const r = billPaymentEntry({ cents: 65000, paidFrom: '100' }, '200');
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.lineId, l.account, l.cents, l.itemNumber, l.division])).toEqual([
      [PAYABLES_LINE, '200', 65000, null, null],
      [PAID_FROM_LINE, '100', -65000, null, null],
    ]);
    expect(r.lines.reduce((sum, l) => sum + l.cents, 0)).toBe(0);
    // Paid by credit card, the card's account is what it comes out of.
    expect(billPaymentEntry({ cents: 65000, paidFrom: '220' }, '200').lines[1]).toMatchObject({ account: '220', cents: -65000 });
  });

  it('books a discount BMG took and takes the money plus the discount off payables', () => {
    // $650.00 of bills paid with $13.00 off: $637.00 went out.
    const r = billPaymentEntry({ cents: 63700, paidFrom: '100', discount: { account: '485', cents: 1300 } }, '200');
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.lineId, l.account, l.cents])).toEqual([
      [PAYABLES_LINE, '200', 65000],
      [PAID_FROM_LINE, '100', -63700],
      [DISCOUNT_LINE, '485', -1300],
    ]);
    expect(r.lines.reduce((sum, l) => sum + l.cents, 0)).toBe(0);
    // A discount of $0 is no discount.
    expect(billPaymentEntry({ cents: 63700, paidFrom: '100', discount: { account: '485', cents: 0 } }, '200').lines.map((l) => l.lineId))
      .toEqual([PAYABLES_LINE, PAID_FROM_LINE]);
  });

  it('posts nothing for a payment of $0, one that only applies a bill credit to a bill', () => {
    expect(billPaymentEntry({ cents: 0, paidFrom: null }, '200')).toEqual({ lines: [], problems: [] });
  });

  it('posts just the discount for a payment of $0 that takes one, with no money to say where it came from', () => {
    const r = billPaymentEntry({ cents: 0, paidFrom: null, discount: { account: '485', cents: 1300 } }, '200');
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.lineId, l.account, l.cents])).toEqual([[PAYABLES_LINE, '200', 1300], [DISCOUNT_LINE, '485', -1300]]);
  });

  it('posts nothing and says why when it can\'t be worked out', () => {
    expect(billPaymentEntry({ cents: null, paidFrom: '100' }, '200')).toEqual({ lines: [], problems: [{ kind: 'unreadable' }] });
    expect(billPaymentEntry({ cents: 500, paidFrom: null }, null)).toEqual({
      lines: [],
      problems: [{ kind: 'no_paid_from' }, { kind: 'no_payables' }],
    });
    expect(billPaymentEntry({ cents: 500, paidFrom: '100' }, null).problems).toEqual([{ kind: 'no_payables' }]);
    expect(billPaymentEntry({ cents: 0, paidFrom: null, discount: { account: '485', cents: 1300 } }, null).problems).toEqual([{ kind: 'no_payables' }]);
  });
});
