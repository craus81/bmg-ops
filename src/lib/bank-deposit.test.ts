import { describe, it, expect } from 'vitest';
import {
  MAX_LINES, MEMO_MAX, accountName, bankDepositExternalId, formatCents, netsuiteBankDeposit, workOutBankDeposit,
  type BankAccount, type BankDepositDraft, type WaitingItem,
} from './bank-deposit';

// Customer payments and deposits waiting in Undeposited Funds, worked out as
// one bank deposit into one of the company's bank accounts (Books part 56).
// Made-up data.

const TODAY = '2026-10-31';
const ACCOUNTS: BankAccount[] = [
  { netsuiteId: '211', number: '10100', name: 'Operating Checking' },
  { netsuiteId: '214', number: null, name: 'Payroll Checking' },
];
const item = (netsuiteId: string, cents: number, w: Partial<WaitingItem> = {}): WaitingItem => ({
  netsuiteId, kind: 'payment', number: `PYMT-${netsuiteId}`, date: '2026-10-28', customerName: 'Rivera Plumbing',
  reference: '10442', cents, ...w,
});
const WAITING: WaitingItem[] = [
  item('9001', 125000),
  item('9002', 48050, { customerName: 'Gateway Electric', reference: null, date: '2026-10-29' }),
  item('9003', 250000, { kind: 'deposit', number: 'DEP-77', customerName: 'Ozark Fleet Co', date: '2026-10-30' }),
];
const DRAFT: BankDepositDraft = { date: '2026-10-30', accountId: ' 211 ', memo: '  slip  14 ', lineIds: ['9001', ' 9003 '] };
const work = (d: Partial<BankDepositDraft> = {}, held?: Set<string>, waiting = WAITING) =>
  workOutBankDeposit({ ...DRAFT, ...d }, waiting, ACCOUNTS, { today: TODAY, held });
const problemsOf = (d: Partial<BankDepositDraft> = {}, held?: Set<string>, waiting?: WaitingItem[]) => work(d, held, waiting).problems;

describe('workOutBankDeposit', () => {
  it('works out a bank deposit of the payments and deposits ticked, in the order NetSuite lists them', () => {
    const w = work({ lineIds: ['9003', '9001'] });
    expect(w).toEqual({
      problems: [],
      date: '2026-10-30',
      account: ACCOUNTS[0],
      memo: 'slip 14',
      lines: [WAITING[0], WAITING[2]],
      totalCents: 375000,
    });
  });

  it('takes one with no memo, into an account with no number', () => {
    const w = work({ memo: '   ', accountId: '214', lineIds: ['9002'] });
    expect(w.problems).toEqual([]);
    expect(w).toMatchObject({ memo: null, account: ACCOUNTS[1], totalCents: 48050 });
  });

  it('needs a real day, not after today, not more than a year back', () => {
    expect(problemsOf({ date: '' })).toEqual(['Fill in the day it went to the bank.']);
    expect(problemsOf({ date: ' 2026-02-30 ' })).toEqual(["2026-02-30 isn't a day on the calendar."]);
    expect(problemsOf({ date: '10/30/2026' })).toEqual(["10/30/2026 isn't a day on the calendar."]);
    expect(problemsOf({ date: TODAY })).toEqual([]);
    expect(problemsOf({ date: '2026-11-01' })).toEqual(["A bank deposit can't be dated after today."]);
    const old = [item('9001', 125000, { date: '2025-10-01' })];
    expect(problemsOf({ date: '2025-10-30', lineIds: ['9001'] }, undefined, old)).toEqual([]);
    expect(problemsOf({ date: '2025-10-29', lineIds: ['9001'] }, undefined, old)).toEqual(["A bank deposit can't be dated more than a year back."]);
  });

  it("can't be dated before the payments and deposits in it", () => {
    expect(problemsOf({ date: '2026-10-29' })).toEqual(["A bank deposit can't be dated before the payments and deposits in it."]);
    expect(problemsOf({ date: '2026-10-30' })).toEqual([]);
    expect(problemsOf({ date: '2026-10-28', lineIds: ['9001'] })).toEqual([]);
    // A day that isn't one says only that.
    expect(problemsOf({ date: '2026-13-01' })).toEqual(["2026-13-01 isn't a day on the calendar."]);
  });

  it("goes into one of the company's bank accounts", () => {
    const none = work({ accountId: '  ' });
    expect(none.problems).toEqual(['Pick the bank account it went into.']);
    expect(none.account).toBeNull();
    expect(problemsOf({ accountId: '999' })).toEqual(["That isn't one of the company's bank accounts."]);
    expect(problemsOf({ accountId: '214' })).toEqual([]);
  });

  it('keeps the memo short', () => {
    expect(problemsOf({ memo: 'm'.repeat(MEMO_MAX) })).toEqual([]);
    expect(problemsOf({ memo: 'm'.repeat(MEMO_MAX + 1) })).toEqual([`The memo is ${MEMO_MAX} characters at most.`]);
  });

  it('needs something ticked, and never more than one bank deposit takes', () => {
    // Migration 487 takes 100 at most too.
    expect(MAX_LINES).toBe(100);
    expect(problemsOf({ lineIds: [] })).toEqual(['Tick the payments and deposits that went to the bank together.']);
    expect(problemsOf({ lineIds: [' ', ''] })).toEqual(['Tick the payments and deposits that went to the bank together.']);
    const many = Array.from({ length: MAX_LINES + 1 }, (_, i) => item(String(10000 + i), 100, { date: '2026-10-01' }));
    expect(problemsOf({ lineIds: many.slice(0, MAX_LINES).map((w) => w.netsuiteId) }, undefined, many)).toEqual([]);
    const tooMany = work({ lineIds: many.map((w) => w.netsuiteId) }, undefined, many);
    expect(tooMany.problems).toEqual([`One bank deposit takes ${MAX_LINES} payments and deposits at most.`]);
  });

  it('counts a payment ticked twice once', () => {
    const w = work({ lineIds: ['9001', '9001', ' 9001'], date: '2026-10-28' });
    expect(w.problems).toEqual([]);
    expect(w.lines).toEqual([WAITING[0]]);
    expect(w.totalCents).toBe(125000);
  });

  it("turns away what isn't waiting in Undeposited Funds any more", () => {
    const one = work({ lineIds: ['9001', '8800'] });
    expect(one.problems).toEqual(["One of the ones ticked isn't waiting in Undeposited Funds any more: reload to see what is."]);
    expect(one.lines).toEqual([WAITING[0]]);
    expect(problemsOf({ lineIds: ['9001', '8800', '8801'] }))
      .toEqual(["2 of the ones ticked aren't waiting in Undeposited Funds any more: reload to see what is."]);
  });

  it('turns away what another press is depositing now', () => {
    expect(problemsOf({}, new Set(['9003', '9002']))).toEqual(['DEP-77 is in a bank deposit being made now.']);
    expect(problemsOf({}, new Set(['9001', '9003'])))
      .toEqual(['PYMT-9001 is in a bank deposit being made now.', 'DEP-77 is in a bank deposit being made now.']);
    expect(problemsOf({}, new Set())).toEqual([]);
  });

  it('turns it away when what the page had the ticked ones come to has changed', () => {
    expect(problemsOf({ expectedCents: 375000 })).toEqual([]);
    expect(problemsOf({ expectedCents: 375001 }))
      .toEqual(["What's waiting changed since the page opened: the ones ticked come to $3,750.00 now. Check them and press again."]);
    // When some are gone, that's what it says.
    expect(problemsOf({ lineIds: ['9001', '8800'], expectedCents: 1 }))
      .toEqual(["One of the ones ticked isn't waiting in Undeposited Funds any more: reload to see what is."]);
  });
});

describe('what goes to NetSuite', () => {
  it("names it under the press's own External ID", () => {
    expect(bankDepositExternalId('5d2f6b1e-1c2a-4f7e-9b0a-2b6f3c1d9e00')).toBe('fleetsuite-bd-5d2f6b1e-1c2a-4f7e-9b0a-2b6f3c1d9e00');
  });

  it('sends the account, day, memo and the payments in it', () => {
    expect(netsuiteBankDeposit(work(), { pressId: 'p-1', subsidiaryId: '2' })).toEqual({
      externalId: 'fleetsuite-bd-p-1',
      subsidiaryId: '2',
      accountId: '211',
      tranDate: '2026-10-30',
      memo: 'slip 14',
      paymentIds: ['9001', '9003'],
    });
    expect(netsuiteBankDeposit(work({ accountId: '' }), { pressId: 'p-1', subsidiaryId: '2' }).accountId).toBe('');
  });

  it("names an account with its number in front", () => {
    expect(accountName(ACCOUNTS[0])).toBe('10100 Operating Checking');
    expect(accountName(ACCOUNTS[1])).toBe('Payroll Checking');
    expect(formatCents(375000)).toBe('$3,750.00');
  });
});
