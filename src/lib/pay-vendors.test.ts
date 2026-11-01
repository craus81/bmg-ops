import { describe, it, expect } from 'vitest';
import {
  AHEAD_DAYS, MAX_BILLS, MAX_PAYMENTS, MAX_PAYMENT_CENTS, MAX_RUN_BILLS, MEMO_MAX, PAY_METHODS, billName, billProblem, byDue, byVendor,
  isPayMethod, keptBills, keptPayments, netsuiteVendorPayment, paymentMemo, paymentProblems, paymentsToKeep, runBillIds,
  vendorNameOf, vendorPaymentExternalId, workOutRun,
  type BankAccount, type BillNow, type RunBill, type RunDraft, type RunPayment,
} from './pay-vendors';

// The company's open bills paid in a payment run, vendor by vendor by check
// or ACH, from one of its bank accounts, checked against what NetSuite has
// open now (Books part 57). Made-up data.

const TODAY = '2026-11-01';
const ACCOUNTS: BankAccount[] = [
  { netsuiteId: '211', number: '10100', name: 'Operating Checking' },
  { netsuiteId: '214', number: null, name: 'Payroll Checking' },
];
const bill = (billId: string, cents: number, b: Partial<RunBill> = {}): RunBill => ({
  billId, number: `B-${billId}`, date: '2026-10-01', dueDate: '2026-10-31', openCents: cents, cents, ...b,
});
const B4410 = bill('7001', 81240, { number: 'B-4410', date: '2026-09-20', dueDate: '2026-10-20' });
const B4471 = bill('7002', 60000, { number: 'B-4471', date: '2026-10-06', dueDate: '2026-11-05', openCents: 110000 });
const GS209 = bill('7003', 245000, { number: 'GS-209', date: '2026-10-11', dueDate: '2026-11-10' });
const OZARK: RunPayment = { vendorId: '31', vendorName: ' Ozark  Hose & Fitting ', method: 'check', bills: [B4471, B4410] };
const GATEWAY: RunPayment = { vendorId: '47', vendorName: 'Gateway Steel', method: 'ach', bills: [GS209] };
const NOW = new Map<string, BillNow>([
  ['7001', { open: true, openCents: 81240, vendorId: '31' }],
  ['7002', { open: true, openCents: 110000, vendorId: '31' }],
  ['7003', { open: true, openCents: 245000, vendorId: '47' }],
]);
const DRAFT: RunDraft = { date: '2026-11-06', accountId: ' 211 ', memo: '  November  run ', payments: [OZARK, GATEWAY] };
const work = (d: Partial<RunDraft> = {}, now: ReadonlyMap<string, BillNow> = NOW, held?: Set<string>) =>
  workOutRun({ ...DRAFT, ...d }, now, ACCOUNTS, { today: TODAY, held });
const problemsOf = (d: Partial<RunDraft> = {}, now?: ReadonlyMap<string, BillNow>, held?: Set<string>) => work(d, now, held).problems;

/** `n` vendors each with one open bill, and NetSuite's answer for them. */
function many(n: number, billsEach = 1) {
  const now = new Map<string, BillNow>();
  const payments: RunPayment[] = Array.from({ length: n }, (_, v) => ({
    vendorId: String(100 + v), vendorName: `Vendor ${100 + v}`, method: 'check' as const,
    bills: Array.from({ length: billsEach }, (_, i) => {
      const id = String(10000 + v * 1000 + i);
      now.set(id, { open: true, openCents: 100, vendorId: String(100 + v) });
      return bill(id, 100);
    }),
  }));
  return { payments, now };
}

describe('workOutRun', () => {
  it('works out one payment per vendor, by vendor name, each paying its bills oldest due first', () => {
    expect(work()).toEqual({
      problems: [],
      date: '2026-11-06',
      account: ACCOUNTS[0],
      memo: 'November run',
      payments: [
        { vendorId: '47', vendorName: 'Gateway Steel', method: 'ach', bills: [GS209], cents: 245000 },
        { vendorId: '31', vendorName: 'Ozark Hose & Fitting', method: 'check', bills: [B4410, B4471], cents: 141240 },
      ],
      totalCents: 386240,
      billCount: 3,
    });
  });

  it('pays part of a bill, from an account with no number, with no memo', () => {
    const w = work({ accountId: '214', memo: '   ', payments: [{ ...OZARK, bills: [{ ...B4410, cents: 1 }] }] });
    expect(w.problems).toEqual([]);
    expect(w).toMatchObject({ account: ACCOUNTS[1], memo: null, totalCents: 1, billCount: 1 });
  });

  it('needs a real day, not more than a month ahead or a year back', () => {
    expect(problemsOf({ date: '' })).toEqual(['Fill in the day the vendors are paid.']);
    expect(problemsOf({ date: '   ' })).toEqual(['Fill in the day the vendors are paid.']);
    expect(problemsOf({ date: '2026-02-30' })).toEqual(["2026-02-30 isn't a day on the calendar."]);
    expect(problemsOf({ date: '11/06/2026' })).toEqual(["11/06/2026 isn't a day on the calendar."]);
    expect(work({ date: ' 2026-11-06 ' }).date).toBe('2026-11-06');
    expect(AHEAD_DAYS).toBe(31);
    expect(problemsOf({ date: '2026-12-02' })).toEqual([]);
    expect(problemsOf({ date: '2026-12-03' })).toEqual(["A payment run can't be dated more than a month ahead."]);
    expect(problemsOf({ date: TODAY })).toEqual([]);
    expect(problemsOf({ date: '2025-10-31' })).toEqual([]);
    expect(problemsOf({ date: '2025-10-30' })).toEqual(["A payment run can't be dated more than a year back."]);
  });

  it("pays from one of the company's bank accounts", () => {
    expect(problemsOf({ accountId: '' })).toEqual(['Pick the bank account it pays from.']);
    expect(problemsOf({ accountId: '  ' })).toEqual(['Pick the bank account it pays from.']);
    expect(problemsOf({ accountId: '999' })).toEqual(["That isn't one of the company's bank accounts."]);
    expect(work({ accountId: '999' }).account).toBeNull();
  });

  it('keeps the memo to what NetSuite takes', () => {
    expect(MEMO_MAX).toBe(300);
    expect(problemsOf({ memo: 'x'.repeat(300) })).toEqual([]);
    expect(problemsOf({ memo: ` ${'x'.repeat(150)}   ${'y'.repeat(149)} ` })).toEqual([]);
    expect(problemsOf({ memo: 'x'.repeat(301) })).toEqual(['The memo is 300 characters at most.']);
  });

  it('needs a bill ticked, and 50 vendors at most', () => {
    expect(problemsOf({ payments: [] })).toEqual(['Tick the bills to pay.']);
    expect(MAX_PAYMENTS).toBe(50);
    const fifty = many(50);
    expect(problemsOf({ payments: fifty.payments }, fifty.now)).toEqual([]);
    const more = many(51);
    expect(problemsOf({ payments: more.payments }, more.now)).toEqual(['One run pays 50 vendors at most: pay the others in another run.']);
  });

  it('pays each vendor once, by check or ACH, with a bill or more and 100 at most', () => {
    const twice = work({ payments: [OZARK, { ...OZARK, vendorName: 'Ozark again', bills: [GS209] }] });
    expect(twice.problems).toEqual(['Ozark again is in the run twice.']);
    // The second isn't counted.
    expect(twice).toMatchObject({ totalCents: 141240, billCount: 2 });

    const wire = work({ payments: [{ ...OZARK, method: 'wire' as never }] });
    expect(wire.problems).toEqual(['Pick check or ACH for Ozark Hose & Fitting.']);
    expect(wire.payments[0].method).toBe('check');

    expect(problemsOf({ payments: [{ ...OZARK, bills: [] }] })).toEqual(['Tick a bill to pay Ozark Hose & Fitting, or take them out of the run.']);
    expect(problemsOf({ payments: [{ ...OZARK, vendorName: null, bills: [] }] })).toEqual(['Tick a bill to pay Vendor 31, or take them out of the run.']);

    expect(MAX_BILLS).toBe(100);
    const hundred = many(1, 100);
    expect(problemsOf({ payments: hundred.payments }, hundred.now)).toEqual([]);
    const over = many(1, 101);
    expect(problemsOf({ payments: over.payments }, over.now)).toEqual(['One payment pays 100 bills at most, and Vendor 100 has 101 ticked.']);
  });

  it('ticks a bill once, and pays more than $0 on it in whole cents', () => {
    const twice = work({ payments: [{ ...OZARK, bills: [B4410, B4410] }, GATEWAY] });
    expect(twice.problems).toEqual(['Bill B-4410 is ticked twice.']);
    expect(twice).toMatchObject({ billCount: 2, totalCents: 81240 + 245000 });
    expect(problemsOf({ payments: [OZARK, { ...GATEWAY, bills: [GS209, B4471] }] })).toEqual(['Bill B-4471 is ticked twice.']);

    for (const cents of [0, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const w = work({ payments: [{ ...OZARK, bills: [{ ...B4410, cents }, B4471] }] });
      expect(w.problems).toEqual(['Fill in what it pays on Bill B-4410, or untick it.']);
      expect(w).toMatchObject({ billCount: 1, totalCents: 60000 });
    }
  });

  it("checks each bill against what NetSuite has open on it now", () => {
    const without = new Map(NOW);
    without.delete('7001');
    expect(problemsOf({}, without)).toEqual(["Bill B-4410 isn't in NetSuite any more, so nothing can be paid on it."]);
    for (const now of [{ open: false, openCents: 81240, vendorId: '31' }, { open: true, openCents: 0, vendorId: '31' }]) {
      expect(problemsOf({}, new Map(NOW).set('7001', now)))
        .toEqual(["Bill B-4410 isn't open in NetSuite now: it's paid, or waiting for approval there."]);
    }
    expect(problemsOf({}, new Map(NOW).set('7001', { open: true, openCents: 81240, vendorId: '47' })))
      .toEqual(["Bill B-4410 isn't Ozark Hose & Fitting's in NetSuite now."]);
    expect(problemsOf({}, new Map(NOW).set('7001', { open: true, openCents: 81240, vendorId: null }))).toEqual([]);
    expect(problemsOf({}, new Map(NOW).set('7001', { open: true, openCents: 50000, vendorId: '31' })))
      .toEqual(['Bill B-4410 has $500.00 open in NetSuite now, less than the $812.40 this pays on it.']);
    // Still counted, so the total is what was ticked.
    expect(work({}, new Map(NOW).set('7001', { open: false, openCents: 0, vendorId: '31' }))).toMatchObject({ billCount: 3, totalCents: 386240 });
  });

  it('leaves out a bill another run holds', () => {
    expect(problemsOf({}, NOW, new Set(['7003', '9999'])))
      .toEqual(['Bill GS-209 is in another payment run, waiting for approval or being paid.']);
    // What NetSuite says comes first.
    expect(problemsOf({}, new Map(NOW).set('7003', { open: false, openCents: 0, vendorId: '47' }), new Set(['7003'])))
      .toEqual(["Bill GS-209 isn't open in NetSuite now: it's paid, or waiting for approval there."]);
  });

  it('pays $10,000,000.00 at most to one vendor, and 500 bills at most in a run', () => {
    expect(MAX_PAYMENT_CENTS).toBe(1_000_000_000);
    const big = new Map(NOW).set('7001', { open: true, openCents: 600_000_000, vendorId: '31' })
      .set('7002', { open: true, openCents: 400_000_001, vendorId: '31' });
    const at = { ...OZARK, bills: [{ ...B4410, cents: 600_000_000 }, { ...B4471, cents: 400_000_000 }] };
    expect(problemsOf({ payments: [at] }, big)).toEqual([]);
    const over = { ...OZARK, bills: [{ ...B4410, cents: 600_000_000 }, { ...B4471, cents: 400_000_001 }] };
    expect(problemsOf({ payments: [over] }, big))
      .toEqual(["One payment is $10,000,000.00 at most, and Ozark Hose & Fitting's comes to $10,000,000.01."]);

    expect(MAX_RUN_BILLS).toBe(500);
    const five = many(5, 100);
    expect(work({ payments: five.payments }, five.now)).toMatchObject({ problems: [], billCount: 500 });
    const six = many(6, 100);
    expect(problemsOf({ payments: six.payments }, six.now)).toEqual(['One run pays 500 bills at most: pay the others in another run.']);
    // One more than 500 is too many.
    const justOver = many(6, 100);
    justOver.payments[5] = { ...justOver.payments[5], bills: justOver.payments[5].bills.slice(0, 1) };
    expect(problemsOf({ payments: justOver.payments }, justOver.now)).toEqual(['One run pays 500 bills at most: pay the others in another run.']);
  });

  it('says every reason at once', () => {
    expect(problemsOf({ date: '', accountId: '', payments: [{ ...OZARK, bills: [{ ...B4410, cents: 0 }] }] })).toEqual([
      'Fill in the day the vendors are paid.',
      'Pick the bank account it pays from.',
      'Fill in what it pays on Bill B-4410, or untick it.',
    ]);
  });
});

describe('billProblem and paymentProblems', () => {
  it("names a bill by its number, or NetSuite's id when it has none", () => {
    expect(billName(B4410)).toBe('Bill B-4410');
    expect(billName({ billId: '7001', number: null })).toBe('Bill 7001');
    expect(billName({ billId: '7001', number: '' })).toBe('Bill 7001');
    expect(billProblem({ ...B4410, number: null }, OZARK, undefined)).toBe("Bill 7001 isn't in NetSuite any more, so nothing can be paid on it.");
  });

  it('says what NetSuite would refuse on each bill of one approved payment, just before it is made', () => {
    expect(paymentProblems(OZARK, NOW)).toEqual([]);
    expect(paymentProblems(OZARK, new Map(NOW).set('7002', { open: true, openCents: 59999, vendorId: '31' }).set('7001', { open: false, openCents: 0, vendorId: '31' }))).toEqual([
      "Bill B-4471 has $599.99 open in NetSuite now, less than the $600.00 this pays on it.",
      "Bill B-4410 isn't open in NetSuite now: it's paid, or waiting for approval there.",
    ]);
    expect(paymentProblems({ ...OZARK, bills: [] }, NOW)).toEqual([]);
  });
});

describe('sorting', () => {
  it('lists bills oldest due first, then oldest, then by number and id', () => {
    const noDue = bill('7004', 1, { number: 'A-1', dueDate: null, date: '2026-10-25' });
    const none = bill('7005', 1, { number: 'A-2', dueDate: null, date: null });
    const sameDay = bill('7006', 1, { number: 'B-1', dueDate: '2026-10-20', date: '2026-09-21' });
    const sameNumber9 = bill('9', 1, { number: 'Z', dueDate: '2026-12-01', date: '2026-11-01' });
    const sameNumber10 = bill('10', 1, { number: 'Z', dueDate: '2026-12-01', date: '2026-11-01' });
    expect(byDue([none, sameNumber10, B4471, noDue, sameDay, sameNumber9, B4410]).map((b) => b.billId))
      .toEqual(['7001', '7006', '7004', '7002', '9', '10', '7005']);
  });

  it('lists vendors by name, whatever its case, then by id', () => {
    const v = (vendorId: string, vendorName: string | null) => ({ vendorId, vendorName });
    expect(byVendor([v('9', 'ozark'), v('31', null), v('10', 'Ozark'), v('2', 'Acme'), v('100', '  ')]).map((p) => p.vendorId))
      .toEqual(['2', '9', '10', '100', '31']);
    expect(vendorNameOf(v('31', '  Ozark   Hose ')).toString()).toBe('Ozark Hose');
    expect(vendorNameOf(v('31', null))).toBe('Vendor 31');
  });
});

describe('what goes to NetSuite', () => {
  it("names each bill payment for the run's payment, so NetSuite never takes it twice", () => {
    expect(vendorPaymentExternalId('f0000000-0000-4000-8000-000000000001')).toBe('fleetsuite-vp-f0000000-0000-4000-8000-000000000001');
  });

  it('pays by check or ACH', () => {
    expect(PAY_METHODS).toEqual({ check: 'Check', ach: 'ACH' });
    expect(['check', 'ach', 'wire', 'Check', '', null, undefined].map(isPayMethod)).toEqual([true, true, false, false, false, false, false]);
  });

  it("keeps a check's memo as typed, and starts an ACH payment's with ACH", () => {
    expect(paymentMemo('check', '  November   run ')).toBe('November run');
    expect(paymentMemo('check', null)).toBe('');
    expect(paymentMemo('check', '  ')).toBe('');
    expect(paymentMemo('ach', 'November run')).toBe('ACH: November run');
    expect(paymentMemo('ach', null)).toBe('ACH');
    expect(paymentMemo('ach', ' ')).toBe('ACH');
    const long = paymentMemo('ach', 'x'.repeat(MEMO_MAX));
    expect(long).toHaveLength(MEMO_MAX);
    expect(long.startsWith('ACH: xxx')).toBe(true);
  });

  it('makes a check To Be Printed, paying each bill what was ticked on it, in dollars', () => {
    const p = { paymentId: 'f0000000-0000-4000-8000-000000000001', subsidiaryId: '2', accountId: '211', date: '2026-11-06', memo: 'November run' };
    expect(netsuiteVendorPayment({ ...OZARK, bills: [B4410, B4471] }, p)).toEqual({
      externalId: 'fleetsuite-vp-f0000000-0000-4000-8000-000000000001',
      vendorId: '31',
      subsidiaryId: '2',
      accountId: '211',
      tranDate: '2026-11-06',
      memo: 'November run',
      toBePrinted: true,
      amount: 1412.4,
      apply: [{ billId: '7001', amount: 812.4 }, { billId: '7002', amount: 600 }],
    });
    expect(netsuiteVendorPayment(GATEWAY, { ...p, memo: null })).toMatchObject({
      vendorId: '47', memo: 'ACH', toBePrinted: false, amount: 2450, apply: [{ billId: '7003', amount: 2450 }],
    });
  });
});

describe('what a run keeps', () => {
  it("reads a run's payments back as the rules take them, whatever the database hands back", () => {
    expect(keptPayments([{
      vendor_netsuite_id: 31, vendor_name: ' Ozark ', method: 'ach',
      bills: [
        { bill_netsuite_id: 7001, number: ' B-4410 ', date: '2026-09-20T00:00:00', due_date: 'soon', open_cents: '81240', cents: 81240 },
        { bill_netsuite_id: '7002', number: '', date: null, due_date: '2026-11-05', open_cents: 1.5, cents: '600.5' },
        null,
      ],
    }, { vendor_netsuite_id: null, vendor_name: '', method: 'wire', bills: 'none' }, null])).toEqual([
      {
        vendorId: '31', vendorName: 'Ozark', method: 'ach',
        bills: [
          { billId: '7001', number: 'B-4410', date: '2026-09-20', dueDate: null, openCents: 81240, cents: 81240 },
          { billId: '7002', number: null, date: null, dueDate: '2026-11-05', openCents: 0, cents: 0 },
          { billId: '', number: null, date: null, dueDate: null, openCents: 0, cents: 0 },
        ],
      },
      { vendorId: '', vendorName: null, method: 'check', bills: [] },
      { vendorId: '', vendorName: null, method: 'check', bills: [] },
    ]);
    expect(keptPayments(null)).toEqual([]);
    expect(keptPayments({})).toEqual([]);
    expect(keptBills('7001')).toEqual([]);
  });

  it('keeps what vendor_payment_run_save takes, and reads it back the same', () => {
    const kept = paymentsToKeep([OZARK, { ...GATEWAY, vendorName: '  ', bills: [{ ...GS209, number: '  ' }] }]);
    expect(kept).toEqual([
      {
        vendor_netsuite_id: '31', vendor_name: 'Ozark Hose & Fitting', method: 'check',
        bills: [
          { bill_netsuite_id: '7002', number: 'B-4471', date: '2026-10-06', due_date: '2026-11-05', open_cents: 110000, cents: 60000 },
          { bill_netsuite_id: '7001', number: 'B-4410', date: '2026-09-20', due_date: '2026-10-20', open_cents: 81240, cents: 81240 },
        ],
      },
      {
        vendor_netsuite_id: '47', vendor_name: null, method: 'ach',
        bills: [{ bill_netsuite_id: '7003', number: null, date: '2026-10-11', due_date: '2026-11-10', open_cents: 245000, cents: 245000 }],
      },
    ]);
    expect(keptPayments(kept)).toEqual([
      { ...OZARK, vendorName: 'Ozark Hose & Fitting' },
      { ...GATEWAY, vendorName: null, bills: [{ ...GS209, number: null }] },
    ]);
    expect(runBillIds(keptPayments(kept))).toEqual(['7002', '7001', '7003']);
    expect(runBillIds([])).toEqual([]);
  });
});
