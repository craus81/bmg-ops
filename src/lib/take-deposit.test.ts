import { describe, it, expect } from 'vitest';
import { MAX_PAYMENT_CENTS } from './receive-payment';
import {
  DEPOSIT_STATUSES, depositExternalId, depositsOnOrder, formatCents, netsuiteDeposit, takesDeposits, workOutDeposit,
  type DepositDraft, type DepositOnOrder, type DepositOrder,
} from './take-deposit';

// A customer's check or ACH deposit worked out against the sales order it goes
// on, as NetSuite has the order now, and the deposits on it already (Books part
// 55). Made-up data.

const ORDER: DepositOrder = { id: '4521', number: 'SO1450', status: 'B', statusName: 'Pending Fulfillment', totalCents: 1250040 };
const TODAY = '2026-10-31';
const DRAFT: DepositDraft = { date: '2026-10-30', method: 'check', reference: ' 10442 ', memo: '  half  down ', amountCents: 250050 };
const on = (cents: number, d: Partial<DepositOnOrder> = {}): DepositOnOrder => ({
  netsuiteId: '7301', number: 'DEP-41', date: '2026-10-20', cents, inFleetSuite: true, making: false, ...d,
});
const work = (d: Partial<DepositDraft>, order: Partial<DepositOrder> = {}, onOrder: DepositOnOrder[] = []) =>
  workOutDeposit({ ...DRAFT, ...d }, { ...ORDER, ...order }, onOrder, { today: TODAY });
const problemsOf = (d: Partial<DepositDraft>, order?: Partial<DepositOrder>, onOrder?: DepositOnOrder[]) => work(d, order, onOrder).problems;

describe('workOutDeposit', () => {
  it('works out a check deposit on an open order', () => {
    expect(work({})).toEqual({
      problems: [],
      date: '2026-10-30',
      method: 'check',
      reference: '10442',
      memo: 'half down',
      netsuiteMemo: 'Check 10442 · half down',
      amountCents: 250050,
      onOrderCents: 0,
      leftCents: 1250040,
    });
  });

  it('takes an ACH deposit with no reference or memo', () => {
    const w = work({ method: 'ach', reference: '  ', memo: '' });
    expect(w.problems).toEqual([]);
    expect(w).toMatchObject({ method: 'ach', reference: null, memo: null, netsuiteMemo: 'ACH', amountCents: 250050 });
  });

  it('needs a real day, not after today and not more than a year back', () => {
    expect(problemsOf({ date: '' })).toEqual(['Fill in the day it was received.']);
    expect(problemsOf({ date: ' 2026-02-30 ' })).toEqual(["2026-02-30 isn't a day on the calendar."]);
    expect(problemsOf({ date: '10/30/2026' })).toEqual(["10/30/2026 isn't a day on the calendar."]);
    expect(problemsOf({ date: TODAY })).toEqual([]);
    expect(problemsOf({ date: '2026-11-01' })).toEqual(["A deposit can't be dated after today."]);
    expect(problemsOf({ date: '2025-10-30' })).toEqual([]);
    expect(problemsOf({ date: '2025-10-29' })).toEqual(["A deposit can't be dated more than a year back."]);
  });

  it("needs check or ACH, a check's number, and a short reference and memo", () => {
    const cash = work({ method: 'cash' });
    expect(cash.problems).toEqual(['Pick check or ACH.']);
    expect(cash.method).toBe('check');
    expect(cash.netsuiteMemo).toBe('Check 10442 · half down');
    expect(problemsOf({ reference: '' })).toEqual(["Fill in the check's number."]);
    expect(problemsOf({ method: 'ach', reference: '' })).toEqual([]);
    expect(problemsOf({ reference: '1'.repeat(40) })).toEqual([]);
    expect(problemsOf({ reference: '1'.repeat(41) })).toEqual(['The check number is 40 characters at most.']);
    expect(problemsOf({ method: 'ach', reference: '1'.repeat(41) })).toEqual(['The reference is 40 characters at most.']);
    expect(problemsOf({ method: '', reference: '1'.repeat(41) })).toEqual(['Pick check or ACH.', 'The reference is 40 characters at most.']);
    expect(problemsOf({ memo: `${'m'.repeat(300)}   ` })).toEqual([]);
    expect(problemsOf({ memo: 'm'.repeat(301) })).toEqual(['The memo is 300 characters at most.']);
  });

  it('needs an amount in whole cents above $0 and no more than $10,000,000', () => {
    for (const amountCents of [0, -500, 2500.5, Number.NaN]) {
      const w = work({ amountCents });
      expect(w.problems).toEqual(["Fill in the deposit's amount."]);
      expect(w.amountCents).toBe(0);
    }
    const big = work({ amountCents: MAX_PAYMENT_CENTS + 1 }, { totalCents: MAX_PAYMENT_CENTS + 1 });
    expect(big.problems).toEqual(['One deposit is $10,000,000.00 at most.']);
    expect(big.amountCents).toBe(0);
    expect(problemsOf({ amountCents: MAX_PAYMENT_CENTS }, { totalCents: MAX_PAYMENT_CENTS })).toEqual([]);
    expect(problemsOf({ amountCents: 1 })).toEqual([]);
  });

  it('goes only on an order NetSuite still has open', () => {
    for (const status of ['A', 'B', 'D', 'E', 'F']) expect(problemsOf({}, { status })).toEqual([]);
    expect(problemsOf({}, { status: 'G', statusName: 'Billed' }))
      .toEqual(['SO1450 is billed in NetSuite already: receive the payment on its invoice instead.']);
    expect(problemsOf({}, { status: 'C', statusName: 'Cancelled' })).toEqual(["SO1450 is cancelled in NetSuite, so a deposit can't go on it."]);
    expect(problemsOf({}, { status: 'H', statusName: 'Closed' })).toEqual(["SO1450 is closed in NetSuite, so a deposit can't go on it."]);
    expect(problemsOf({}, { status: '', statusName: '' })).toEqual(["SO1450 is not open in NetSuite, so a deposit can't go on it."]);
    expect(problemsOf({}, { status: 'b' })).toEqual(["SO1450 is pending fulfillment in NetSuite, so a deposit can't go on it."]);
    // A closed order says only that, however much the deposit is.
    expect(problemsOf({ amountCents: 9_999_999 }, { status: 'H', statusName: 'Closed' }, [on(1250040)]))
      .toEqual(["SO1450 is closed in NetSuite, so a deposit can't go on it."]);
  });

  it("is never more than what's left of the order after the deposits on it", () => {
    expect(problemsOf({ amountCents: 1250040 })).toEqual([]);
    expect(problemsOf({ amountCents: 1250041 })).toEqual(['SO1450 comes to $12,500.40, less than the $12,500.41 deposit.']);
    const some = work({ amountCents: 250041 }, {}, [on(600000), on(400000, { netsuiteId: '7200', number: 'DEP-30' })]);
    expect(some.problems).toEqual(['SO1450 has $2,500.40 left after the $10,000.00 in deposits on it, less than the $2,500.41 deposit.']);
    expect(some).toMatchObject({ onOrderCents: 1000000, leftCents: 250040, amountCents: 250041 });
    expect(problemsOf({ amountCents: 250040 }, {}, [on(1000000)])).toEqual([]);
    const all = work({ amountCents: 1 }, {}, [on(1250040)]);
    expect(all.problems).toEqual(['SO1450 has deposits for all $12,500.40 of it already.']);
    expect(all.leftCents).toBe(0);
    const over = work({ amountCents: 1 }, {}, [on(1300000)]);
    expect(over.problems).toEqual(['SO1450 has deposits for all $12,500.40 of it already.']);
    expect(over).toMatchObject({ onOrderCents: 1300000, leftCents: 0 });
    // An order of $0 takes none.
    expect(problemsOf({ amountCents: 1 }, { totalCents: 0 })).toEqual(['SO1450 comes to $0.00, less than the $0.01 deposit.']);
    // An amount that isn't one says only that.
    expect(problemsOf({ amountCents: 0 }, {}, [on(1250040)])).toEqual(["Fill in the deposit's amount."]);
    expect(problemsOf({ amountCents: MAX_PAYMENT_CENTS + 1 })).toEqual(['One deposit is $10,000,000.00 at most.']);
  });
});

describe('takesDeposits', () => {
  it('takes a deposit while the order is pending approval, fulfillment or billing, and not once cancelled, billed or closed', () => {
    expect(DEPOSIT_STATUSES).toEqual(['A', 'B', 'D', 'E', 'F']);
    expect(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', ''].filter((status) => takesDeposits({ status }))).toEqual(['A', 'B', 'D', 'E', 'F']);
  });
});

describe('depositsOnOrder', () => {
  it("lists FleetSuite's deposits and NetSuite's, each once, oldest first", () => {
    const making = on(5000, { netsuiteId: null, number: null, date: '2026-10-29', making: true });
    const ours = on(100000);
    const theirs = { ...ours, inFleetSuite: false };
    const older = on(20000, { netsuiteId: '7200', number: 'DEP-30', date: '2026-10-05', inFleetSuite: false });
    const sameDay = on(1, { netsuiteId: '7210', number: 'DEP-31', inFleetSuite: false });
    const unnumbered = on(2, { netsuiteId: '7220', number: null, inFleetSuite: false });
    expect(depositsOnOrder([making, ours], [theirs, sameDay, older, unnumbered])).toEqual([older, unnumbered, sameDay, ours, making]);
    // A copied deposit without NetSuite's id is never taken for one of FleetSuite's being made.
    const noId = { ...making, inFleetSuite: false, making: false };
    expect(depositsOnOrder([making], [noId])).toEqual([making, noId]);
    expect(depositsOnOrder([], [])).toEqual([]);
  });
});

describe('what is sent', () => {
  const PRESS = '6b0c1d2e-0000-4000-8000-000000000001';

  it('names a deposit in NetSuite by the press it came from', () => {
    expect(depositExternalId(PRESS)).toBe(`fleetsuite-cd-${PRESS}`);
    expect(formatCents(250050)).toBe('$2,500.50');
  });

  it('sends dollars, the order it goes on, and the check number only for a check', () => {
    const p = { pressId: PRESS, customerId: '501', subsidiaryId: '2', salesOrderId: '4521' };
    expect(netsuiteDeposit(work({}), p)).toEqual({
      externalId: `fleetsuite-cd-${PRESS}`,
      customerId: '501',
      subsidiaryId: '2',
      salesOrderId: '4521',
      tranDate: '2026-10-30',
      amount: 2500.5,
      checkNumber: '10442',
      memo: 'Check 10442 · half down',
    });
    expect(netsuiteDeposit(work({ method: 'ach', reference: 'ACH-0187', memo: '' }), p)).toMatchObject({
      checkNumber: null, memo: 'ACH ACH-0187', amount: 2500.5,
    });
  });
});
