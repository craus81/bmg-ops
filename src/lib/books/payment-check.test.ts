import { describe, it, expect } from 'vitest';
import type { ChartAccount, NetSuitePosting } from './invoice-check';
import { checkPayment, checkPaymentMonth, depositAccount, paymentDiscount, paymentReasons, type PaymentMonthData } from './payment-check';

// Made-up books: '120' and '121' receivables, '110' Undeposited Funds, '100'
// a bank account, '480' sales discounts, '400' sales, '690' bank fees.
const TYPES = new Map([
  ['120', 'accounts_receivable'], ['121', 'accounts_receivable'], ['110', 'other_current_asset'], ['100', 'bank'], ['480', 'income'],
  ['400', 'income'], ['690', 'expense'],
]);
const CTX: { receivable: string | null; accountTypes: Map<string, string> } = { receivable: '120', accountTypes: TYPES };
const NAME: Record<string, string> = {
  '120': '1200 Receivables', '121': '1210 Receivables Other', '110': '1100 Undeposited Funds', '100': '1000 Checking', '480': '4800 Discounts',
  '400': '4000 Sales', '690': '6900 Bank Fees',
};
const account = (id: string) => NAME[id] ?? `NetSuite account ${id}`;

const ns = (lineId: string, acct: string, cents: number): NetSuitePosting => ({ lineId, account: acct, cents });

// A $162.00 payment, as NetSuite posts it: the main line puts the money in Undeposited Funds, receivables take it off.
const POSTED = [ns('0', '110', 16200), ns('1', '120', -16200)];
// $162.00 of invoices paid with $3.24 off: $158.76 came in, and receivables take off the money and the discount.
const DISCOUNTED = [ns('0', '110', 15876), ns('1', '120', -16200), ns('2', '480', 324)];

const check = (cents: number | null, netsuite = POSTED, ctx = CTX) => checkPayment({ cents, netsuite }, ctx);
const rows = (c: ReturnType<typeof check>) =>
  c.rows.map((r) => [r.lineId, r.role, r.fleetsuite && [r.fleetsuite.account, r.fleetsuite.cents], r.netsuite && [r.netsuite.account, r.netsuite.cents], r.same]);

describe('depositAccount', () => {
  it('is the account the main line debits, or the one account outside receivables, income and expenses NetSuite debits', () => {
    expect(depositAccount(POSTED, TYPES)).toBe('110');
    expect(depositAccount(DISCOUNTED, TYPES)).toBe('110');
    expect(depositAccount([ns('0', '120', -16200), ns('1', '100', 16200)], TYPES)).toBe('100');
    // No main line: a discount isn't where the money went.
    expect(depositAccount([ns('0', '120', -16200), ns('1', '110', 15876), ns('2', '480', 324)], TYPES)).toBe('110');
    expect(depositAccount([ns('0', '120', -16200), ns('1', '110', 10000), ns('2', '100', 6200)], TYPES)).toBeNull();
    expect(depositAccount([], TYPES)).toBeNull();
  });
});

describe('paymentDiscount', () => {
  it('is what NetSuite debits to the one income or expense account it debits for the payment', () => {
    expect(paymentDiscount(DISCOUNTED, TYPES, '110')).toEqual({ account: '480', cents: 324 });
    // Its lines on the account together.
    expect(paymentDiscount([ns('0', '110', 15876), ns('1', '120', -16200), ns('2', '480', 200), ns('3', '480', 124)], TYPES, '110'))
      .toEqual({ account: '480', cents: 324 });
    expect(paymentDiscount([ns('0', '110', 15876), ns('1', '120', -16200), ns('2', '690', 324)], TYPES, '110')).toEqual({ account: '690', cents: 324 });
  });

  it('is none when NetSuite debits no income or expense account, credits one, or debits more than one', () => {
    expect(paymentDiscount(POSTED, TYPES, '110')).toBeNull();
    expect(paymentDiscount([ns('0', '110', 16200), ns('1', '120', -15876), ns('2', '400', -324)], TYPES, '110')).toBeNull();
    expect(paymentDiscount([ns('0', '110', 15876), ns('1', '120', -16200), ns('2', '480', 224), ns('3', '690', 100)], TYPES, '110')).toBeNull();
    // Nor is where the money went, however odd an account that is.
    expect(paymentDiscount([ns('0', '480', 16200), ns('1', '120', -16200)], TYPES, '480')).toBeNull();
  });
});

describe('checkPayment', () => {
  it('matches when NetSuite puts the total where the money went and takes it off receivables', () => {
    const c = check(16200);
    expect(c.status).toBe('matches');
    expect(rows(c)).toEqual([
      ['deposit', 'deposit', ['110', 16200], ['110', 16200], true],
      ['receivable', 'receivable', ['120', -16200], ['120', -16200], true],
    ]);
  });

  it('adds up NetSuite\'s lines on one account, a receivable line for each invoice paid say', () => {
    expect(check(16200, [ns('0', '110', 16200), ns('1', '120', -10000), ns('2', '120', -6200)]).status).toBe('matches');
  });

  it('finds where the money went when the main line is the receivable', () => {
    const c = check(16200, [ns('0', '120', -16200), ns('1', '100', 16200)]);
    expect(c.status).toBe('matches');
    expect(c.rows[0].fleetsuite).toEqual({ account: '100', cents: 16200 });
  });

  it('matches when NetSuite also books a discount the customer took, taking the money and the discount off receivables', () => {
    const c = check(15876, DISCOUNTED);
    expect(c.status).toBe('matches');
    expect(rows(c)).toEqual([
      ['deposit', 'deposit', ['110', 15876], ['110', 15876], true],
      ['discount', 'discount', ['480', 324], ['480', 324], true],
      ['receivable', 'receivable', ['120', -16200], ['120', -16200], true],
    ]);
    // Without its main line too.
    expect(check(15876, [ns('1', '120', -16200), ns('2', '110', 15876), ns('3', '480', 324)]).status).toBe('matches');
    // A $0 payment that only takes a discount.
    expect(rows(check(0, [ns('1', '120', -324), ns('2', '480', 324)]))).toEqual([
      ['discount', 'discount', ['480', 324], ['480', 324], true],
      ['receivable', 'receivable', ['120', -324], ['120', -324], true],
    ]);
  });

  it('differs when the discount and the money don\'t add up to what NetSuite took off receivables', () => {
    const c = check(15876, [ns('0', '110', 15876), ns('1', '120', -16300), ns('2', '480', 324), ns('3', '121', 100)]);
    expect(c.status).toBe('differs');
    expect(paymentReasons(c, account).map((r) => r.key)).toEqual(['receivable_amount', 'other|121']);
  });

  it('differs, and names the lines, when NetSuite debits more than one income or expense account for the payment', () => {
    const c = check(15876, [ns('0', '110', 15876), ns('1', '120', -16200), ns('2', '480', 224), ns('3', '690', 100)]);
    expect(c.status).toBe('differs');
    expect(rows(c)).toEqual([
      ['deposit', 'deposit', ['110', 15876], ['110', 15876], true],
      ['receivable', 'receivable', ['120', -15876], ['120', -16200], false],
      ['account:480', 'other', null, ['480', 224], false],
      ['account:690', 'other', null, ['690', 100], false],
    ]);
    expect(paymentReasons(c, account).map((r) => r.text)).toEqual([
      'What FleetSuite takes off receivables differs from what NetSuite took off.',
      'NetSuite also posts to 4800 Discounts, which the payment rule doesn\'t.',
      'NetSuite also posts to 6900 Bank Fees, which the payment rule doesn\'t.',
    ]);
  });

  it('says so when FleetSuite\'s discount isn\'t what NetSuite booked', () => {
    const c = {
      status: 'differs' as const,
      problems: [],
      rows: [{ lineId: 'discount', role: 'discount' as const, fleetsuite: { account: '480', cents: 324 }, netsuite: { account: '480', cents: 300 }, same: false }],
    };
    expect(paymentReasons(c, account)).toEqual([{ key: 'discount|480', text: 'The discount differs from what NetSuite booked to 4800 Discounts.' }]);
  });

  it('says which receivable each side used when they differ', () => {
    const c = check(16200, [ns('0', '110', 16200), ns('1', '121', -16200)]);
    expect(c.status).toBe('differs');
    expect(rows(c)).toEqual([
      ['deposit', 'deposit', ['110', 16200], ['110', 16200], true],
      ['receivable', 'receivable', ['120', -16200], null, false],
      ['account:121', 'receivable', null, ['121', -16200], false],
    ]);
    expect(paymentReasons(c, account)).toEqual([
      { key: 'receivable|120|121', text: 'Receivables: FleetSuite used 1200 Receivables, NetSuite 1210 Receivables Other.' },
    ]);
  });

  it('differs when the copy\'s total isn\'t what NetSuite posted', () => {
    const c = check(16200, [ns('0', '110', 16000), ns('1', '120', -16000)]);
    expect(c.status).toBe('differs');
    expect(paymentReasons(c, account).map((r) => r.key)).toEqual(['deposit_amount', 'receivable_amount']);
    expect(paymentReasons(c, account)[0].text).toBe('The payment\'s total differs from what NetSuite put in 1100 Undeposited Funds.');
  });

  it('waits for the GL copy when NetSuite has posted nothing for it yet, and matches a $0 payment with nothing on either side', () => {
    expect(check(16200, [])).toEqual({ status: 'waiting', waiting: 'gl', problems: [], rows: [] });
    expect(check(0, [])).toEqual({ status: 'matches', problems: [], rows: [] });
  });

  it('can\'t be worked out without a receivable, or when NetSuite\'s posting doesn\'t say where the money went', () => {
    const noReceivable = check(16200, POSTED, { receivable: null, accountTypes: TYPES });
    expect(noReceivable.status).toBe('unworkable');
    expect(noReceivable.problems).toEqual([{ kind: 'no_receivable' }]);
    // What NetSuite posted still shows.
    expect(rows(noReceivable)).toEqual([
      ['deposit', 'deposit', null, ['110', 16200], false],
      ['account:120', 'receivable', null, ['120', -16200], false],
    ]);
    expect(paymentReasons(noReceivable, account).map((r) => r.text)).toEqual(['The chart of accounts has no receivable account this company can use.']);

    const nowhere = check(16200, [ns('0', '120', -16200), ns('1', '110', 10000), ns('2', '100', 6200)]);
    expect(nowhere.status).toBe('unworkable');
    expect(paymentReasons(nowhere, account).map((r) => r.text)).toEqual(["NetSuite's posting of the payment doesn't say which account the money went to."]);
    expect(check(null).problems).toEqual([{ kind: 'unreadable' }]);
  });

  it('says so when the copy comes to $0 and NetSuite posts it', () => {
    const c = check(0);
    expect(c.status).toBe('differs');
    expect(paymentReasons(c, account).map((r) => r.text)).toEqual(['The copy of the payment comes to $0, yet NetSuite posts it.']);
  });
});

describe('checkPaymentMonth', () => {
  const CHART: ChartAccount[] = Object.entries(NAME).map(([id, label]) => ({
    netsuite_account_id: id,
    number: label.split(' ')[0],
    name: label.split(' ').slice(1).join(' '),
    account_type: TYPES.get(id)!,
    company: null,
    active: true,
    is_summary: false,
  }));

  const payment = (number: string | null, ref: string, total: string, lines: Array<[string, string, string, string]>, fields: Partial<PaymentMonthData['payments'][number]> = {}) => ({
    id: `p${ref}`,
    netsuite_id: ref,
    number,
    date: '2026-09-10',
    total,
    voided: false,
    customer: 'A Customer',
    customer_id: null,
    companies: lines.length ? ['BMG'] : [],
    applied: [],
    netsuite: lines.map(([line_id, acct, debit, credit]) => ({ line_id, account: acct, debit, credit })),
    ...fields,
  });

  const DATA: PaymentMonthData = {
    payments: [
      payment('PMT1', '201', '162.00', [['0', '110', '162.00', '0.00'], ['1', '120', '0.00', '162.00']], {
        applied: [{ kind: 'invoice', number: 'INV101', amount: '100.00' }, { kind: 'invoice', number: 'CustInvc/999', amount: '62.00' }],
      }),
      payment('PMT2', '202', '158.76', [['0', '110', '158.76', '0.00'], ['1', '120', '0.00', '162.00'], ['2', '480', '3.24', '0.00']]),
      payment(null, '203', '50.00', [['0', '100', '50.00', '0.00'], ['1', '120', '0.00', '50.00']]),
      payment('PMT4', '204', '75.00', []),
      payment('PMT5', '205', '0.00', [], { applied: [{ kind: 'credit_memo', number: 'CM105', amount: '20.00' }] }),
      payment('PMT6', '206', '80.00', [['0', '110', '70.00', '0.00'], ['1', '120', '0.00', '70.00']]),
    ],
  };

  it('checks every payment the company posted and names the rest', () => {
    // Two receivables to choose from: NetSuite's payments used 1200 this month.
    const m = checkPaymentMonth(DATA, { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 4, matches: 3, differs: 1, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.reasons.map((r) => [r.text, r.invoices, r.examples])).toEqual([
      ['The payment\'s total differs from what NetSuite put in 1100 Undeposited Funds.', 1, ['PMT6']],
      ['What FleetSuite takes off receivables differs from what NetSuite took off.', 1, ['PMT6']],
    ]);
    expect(m.notes).toEqual([
      'BMG can use 2 receivable accounts, so FleetSuite used 1200 Receivables, the one NetSuite\'s payments used most this month.',
      '1 more payment dated this month isn\'t in the copy of NetSuite\'s GL for either company: PMT4. NetSuite may have deleted it, '
        + 'or the copy, which runs every two hours, hasn\'t reached it yet.',
    ]);
    expect(m.invoices.map((p) => [p.number, p.status, p.total])).toEqual([
      ['PMT1', 'matches', 16200], ['PMT2', 'matches', 15876], ['NetSuite 203', 'matches', 5000], ['PMT6', 'differs', 8000],
    ]);
    expect(m.invoices[0]).toMatchObject({
      netsuiteId: '201',
      date: '2026-09-10',
      customer: 'A Customer',
      reasons: [],
      // One not copied yet goes by NetSuite's id.
      applied: [{ number: 'INV101', cents: 10000 }, { number: 'NetSuite invoice 999', cents: 6200 }],
    });
    expect(m.invoices[1].rows.map((r) => [r.label, r.fleetsuite, r.netsuite, r.same])).toEqual([
      ['Deposited to', { account: '110', cents: 15876 }, { account: '110', cents: 15876 }, true],
      ['Discount', { account: '480', cents: 324 }, { account: '480', cents: 324 }, true],
      ['Receivable', { account: '120', cents: -16200 }, { account: '120', cents: -16200 }, true],
    ]);
    expect(m.accounts).toEqual({ '100': '1000 Checking', '110': '1100 Undeposited Funds', '120': '1200 Receivables', '480': '4800 Discounts' });
  });

  it('says what FleetSuite\'s books hold for each payment when the company\'s payments post', () => {
    const m = checkPaymentMonth(DATA, { company: 'BMG', chart: CHART }, (w) => (w.payment.netsuite_id === '201'
      ? { entryNo: 7, next: null, earlier: [] }
      : { entryNo: null, next: 'post', earlier: [] }));
    expect(m.summary).toMatchObject({ invoices: 4, posted: 1, pending: 3 });
    expect(m.invoices.map((p) => [p.number, p.books?.entryNo, p.books?.next])).toEqual([
      ['PMT1', 7, null], ['PMT2', null, 'post'], ['NetSuite 203', null, 'post'], ['PMT6', null, 'post'],
    ]);
    expect(checkPaymentMonth(DATA, { company: 'BMG', chart: CHART }).invoices[0].books).toBeUndefined();
  });
});
