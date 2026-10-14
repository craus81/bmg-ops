import { describe, it, expect } from 'vitest';
import { DEPOSIT_LINE, PAYMENT_RULE, RECEIVABLE_LINE, paymentEntry } from './payment-rule';

// Made-up accounts: '120' receivable, '110' Undeposited Funds.

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

  it('posts nothing for a payment of $0, one that only applies a credit', () => {
    expect(paymentEntry({ cents: 0, depositAccount: null }, '120')).toEqual({ lines: [], problems: [] });
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
