import { describe, it, expect } from 'vitest';
import { DEPOSITS_LINE, DEPOSIT_RULE, MONEY_LINE, depositEntry } from './deposit-rule';
import { RECEIVABLE_LINE } from './payment-rule';

// Made-up accounts: '120' receivable, '110' Undeposited Funds, '100' a bank account, '230' customer deposits.
const ACCOUNTS = { deposits: '230', receivable: '120' };

describe('depositEntry (deposit@1)', () => {
  it('names its rule with a version', () => {
    expect(DEPOSIT_RULE).toBe('deposit@1');
  });

  it('puts a deposit\'s money where it went and credits customer deposits with it', () => {
    const r = depositEntry({ type: 'CustDep', cents: 50000, moneyAccount: '110' }, ACCOUNTS);
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.lineId, l.account, l.cents, l.division])).toEqual([
      [MONEY_LINE, '110', 50000, null],
      [DEPOSITS_LINE, '230', -50000, null],
    ]);
    expect(r.lines.reduce((sum, l) => sum + l.cents, 0)).toBe(0);
    expect(depositEntry({ type: 'CustDep', cents: 50000, moneyAccount: '100' }, ACCOUNTS).lines[0]).toMatchObject({ account: '100', cents: 50000 });
  });

  it('applies a deposit by debiting customer deposits and crediting receivables', () => {
    const r = depositEntry({ type: 'DepAppl', cents: 30000, moneyAccount: null }, ACCOUNTS);
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.lineId, l.account, l.cents])).toEqual([
      [DEPOSITS_LINE, '230', 30000],
      [RECEIVABLE_LINE, '120', -30000],
    ]);
    // Where the money went is the deposit's; an application has none to say.
    expect(depositEntry({ type: 'DepAppl', cents: 30000, moneyAccount: '110' }, ACCOUNTS).lines.map((l) => l.account)).toEqual(['230', '120']);
  });

  it('posts nothing for a document of $0, a voided one', () => {
    expect(depositEntry({ type: 'CustDep', cents: 0, moneyAccount: null }, { deposits: null, receivable: null })).toEqual({ lines: [], problems: [] });
    expect(depositEntry({ type: 'DepAppl', cents: 0, moneyAccount: null }, ACCOUNTS)).toEqual({ lines: [], problems: [] });
  });

  it('posts nothing and says why when it can\'t be worked out', () => {
    expect(depositEntry({ type: 'CustDep', cents: null, moneyAccount: '110' }, ACCOUNTS)).toEqual({ lines: [], problems: [{ kind: 'unreadable' }] });
    expect(depositEntry({ type: 'CustDep', cents: 500, moneyAccount: null }, { deposits: null, receivable: null })).toEqual({
      lines: [],
      problems: [{ kind: 'no_money_account' }, { kind: 'no_deposits_account' }],
    });
    // A deposit takes nothing off receivables, so it doesn't need one; an application does.
    expect(depositEntry({ type: 'CustDep', cents: 500, moneyAccount: '110' }, { deposits: '230', receivable: null }).problems).toEqual([]);
    expect(depositEntry({ type: 'DepAppl', cents: 500, moneyAccount: null }, { deposits: null, receivable: null })).toEqual({
      lines: [],
      problems: [{ kind: 'no_deposits_account' }, { kind: 'no_receivable' }],
    });
  });
});
