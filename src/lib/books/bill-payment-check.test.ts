import { describe, it, expect } from 'vitest';
import type { ChartAccount, InvoiceBooks, NetSuitePosting } from './invoice-check';
import {
  billPaymentDiscount, billPaymentReasons, checkBillPayment, checkBillPaymentMonth, paidFromAccount, type BillPaymentMonthData,
  type WorkedBillPayment,
} from './bill-payment-check';

// Made-up books: '200' and '201' payables (BMG's), '210' 1084's, '100' a
// bank account, '220' a company credit card, '485' purchase discounts, '530'
// subcontractors, '690' bank fees.
const TYPES = new Map([
  ['200', 'accounts_payable'], ['201', 'accounts_payable'], ['210', 'accounts_payable'], ['100', 'bank'], ['220', 'credit_card'],
  ['485', 'other_income'], ['530', 'expense'], ['690', 'expense'],
]);
const CTX: { payables: string | null; accountTypes: Map<string, string> } = { payables: '200', accountTypes: TYPES };
const NAME: Record<string, string> = {
  '200': '2000 Accounts Payable', '201': '2010 Accounts Payable Other', '210': '2100 Accounts Payable', '100': '1000 Checking',
  '220': '2200 Company Card', '485': '4850 Purchase Discounts', '530': '5300 Subcontractors', '690': '6900 Bank Fees',
};
const account = (id: string) => NAME[id] ?? `NetSuite account ${id}`;

const ns = (lineId: string, acct: string, cents: number): NetSuitePosting => ({ lineId, account: acct, cents });

// A $650.00 bill payment, as NetSuite posts it: the main line takes the money out of checking, payables take off what it paid.
const POSTED = [ns('0', '100', -65000), ns('1', '200', 65000)];
// $650.00 of bills paid with $13.00 off: $637.00 went out, and payables take off the money and the discount.
const DISCOUNTED = [ns('0', '100', -63700), ns('1', '200', 65000), ns('2', '485', -1300)];

const check = (cents: number | null, netsuite = POSTED, ctx = CTX) => checkBillPayment({ cents, netsuite }, ctx);
const rows = (c: ReturnType<typeof check>) =>
  c.rows.map((r) => [r.lineId, r.role, r.fleetsuite && [r.fleetsuite.account, r.fleetsuite.cents], r.netsuite && [r.netsuite.account, r.netsuite.cents], r.same]);

describe('paidFromAccount', () => {
  it('is the account the main line credits, or the one account outside payables, income and expenses NetSuite credits', () => {
    expect(paidFromAccount(POSTED, TYPES)).toBe('100');
    expect(paidFromAccount(DISCOUNTED, TYPES)).toBe('100');
    // Paid by card, with payables on the main line.
    expect(paidFromAccount([ns('0', '200', 65000), ns('1', '220', -65000)], TYPES)).toBe('220');
    // No main line: a discount isn't where the money came from.
    expect(paidFromAccount([ns('1', '200', 65000), ns('2', '100', -63700), ns('3', '485', -1300)], TYPES)).toBe('100');
    expect(paidFromAccount([ns('1', '200', 65000), ns('2', '100', -40000), ns('3', '220', -25000)], TYPES)).toBeNull();
    // With its main line, that line says, whatever else NetSuite credits.
    expect(paidFromAccount([ns('0', '100', -40000), ns('1', '200', 65000), ns('2', '220', -25000)], TYPES)).toBe('100');
    // Payables taken off one account and put in another isn't money paid.
    expect(paidFromAccount([ns('1', '200', 65000), ns('2', '201', -65000)], TYPES)).toBeNull();
    expect(paidFromAccount([], TYPES)).toBeNull();
  });
});

describe('billPaymentDiscount', () => {
  it('is what NetSuite credits to the one income or expense account it credits for the payment', () => {
    expect(billPaymentDiscount(DISCOUNTED, TYPES, '100')).toEqual({ account: '485', cents: 1300 });
    // Its lines on the account together.
    expect(billPaymentDiscount([ns('0', '100', -63700), ns('1', '200', 65000), ns('2', '485', -800), ns('3', '485', -500)], TYPES, '100'))
      .toEqual({ account: '485', cents: 1300 });
    expect(billPaymentDiscount([ns('0', '100', -63700), ns('1', '200', 65000), ns('2', '530', -1300)], TYPES, '100'))
      .toEqual({ account: '530', cents: 1300 });
  });

  it('is none when NetSuite credits no income or expense account, debits one, or credits more than one', () => {
    expect(billPaymentDiscount(POSTED, TYPES, '100')).toBeNull();
    expect(billPaymentDiscount([ns('0', '100', -65000), ns('1', '200', 63700), ns('2', '690', 1300)], TYPES, '100')).toBeNull();
    expect(billPaymentDiscount([ns('0', '100', -63700), ns('1', '200', 65000), ns('2', '485', -800), ns('3', '530', -500)], TYPES, '100'))
      .toBeNull();
    // Nor is where the money came from, however odd an account that is.
    expect(billPaymentDiscount([ns('0', '485', -65000), ns('1', '200', 65000)], TYPES, '485')).toBeNull();
    // Nor money taken out of a second account: a discount is income or an expense.
    expect(billPaymentDiscount([ns('0', '100', -40000), ns('1', '200', 65000), ns('2', '220', -25000)], TYPES, '100')).toBeNull();
  });
});

describe('checkBillPayment', () => {
  it('matches when NetSuite takes the total off payables and out of the account it was paid from', () => {
    const c = check(65000);
    expect(c.status).toBe('matches');
    expect(rows(c)).toEqual([
      ['payables', 'payables', ['200', 65000], ['200', 65000], true],
      ['paid_from', 'paid_from', ['100', -65000], ['100', -65000], true],
    ]);
    expect(c.lines.map((l) => [l.lineId, l.account, l.cents])).toEqual([['payables', '200', 65000], ['paid_from', '100', -65000]]);
  });

  it('adds up NetSuite\'s lines on one account, a payables line for each bill paid say', () => {
    expect(check(65000, [ns('0', '100', -65000), ns('1', '200', 40000), ns('2', '200', 25000)]).status).toBe('matches');
  });

  it('takes the money off the card a bill was paid by', () => {
    const c = check(65000, [ns('0', '220', -65000), ns('1', '200', 65000)]);
    expect(c.status).toBe('matches');
    expect(c.rows[1].fleetsuite).toEqual({ account: '220', cents: -65000 });
  });

  it('matches when NetSuite also books a discount BMG took, taking the money and the discount off payables', () => {
    const c = check(63700, DISCOUNTED);
    expect(c.status).toBe('matches');
    expect(rows(c)).toEqual([
      ['payables', 'payables', ['200', 65000], ['200', 65000], true],
      ['paid_from', 'paid_from', ['100', -63700], ['100', -63700], true],
      ['discount', 'discount', ['485', -1300], ['485', -1300], true],
    ]);
    // Without its main line too.
    expect(check(63700, [ns('1', '200', 65000), ns('2', '100', -63700), ns('3', '485', -1300)]).status).toBe('matches');
    // A $0 payment that only takes a discount.
    expect(rows(check(0, [ns('1', '200', 1300), ns('2', '485', -1300)]))).toEqual([
      ['payables', 'payables', ['200', 1300], ['200', 1300], true],
      ['discount', 'discount', ['485', -1300], ['485', -1300], true],
    ]);
  });

  it('differs when the money and the discount don\'t add up to what NetSuite took off payables', () => {
    const c = check(63700, [ns('0', '100', -63700), ns('1', '200', 65100), ns('2', '485', -1300), ns('3', '201', -100)]);
    expect(c.status).toBe('differs');
    expect(billPaymentReasons(c, account).map((r) => r.key)).toEqual(['payables_amount', 'other|201']);
  });

  it('differs, and names the lines, when NetSuite credits more than one income or expense account for the payment', () => {
    const c = check(63700, [ns('0', '100', -63700), ns('1', '200', 65000), ns('2', '485', -800), ns('3', '530', -500)]);
    expect(c.status).toBe('differs');
    expect(rows(c)).toEqual([
      ['payables', 'payables', ['200', 63700], ['200', 65000], false],
      ['paid_from', 'paid_from', ['100', -63700], ['100', -63700], true],
      ['account:485', 'other', null, ['485', -800], false],
      ['account:530', 'other', null, ['530', -500], false],
    ]);
    expect(billPaymentReasons(c, account).map((r) => r.text)).toEqual([
      'What FleetSuite takes off payables differs from what NetSuite took off.',
      'NetSuite also posts to 4850 Purchase Discounts, which the bill payment rule doesn\'t.',
      'NetSuite also posts to 5300 Subcontractors, which the bill payment rule doesn\'t.',
    ]);
  });

  it('differs when the money came out of two accounts, naming the second as a line the rule doesn\'t have', () => {
    const c = check(65000, [ns('0', '100', -40000), ns('1', '200', 65000), ns('2', '220', -25000)]);
    expect(c.status).toBe('differs');
    expect(rows(c)).toEqual([
      ['payables', 'payables', ['200', 65000], ['200', 65000], true],
      ['paid_from', 'paid_from', ['100', -65000], ['100', -40000], false],
      ['account:220', 'other', null, ['220', -25000], false],
    ]);
    expect(billPaymentReasons(c, account).map((r) => r.key)).toEqual(['paid_from_amount', 'other|220']);
  });

  it('says so when FleetSuite\'s discount isn\'t what NetSuite booked', () => {
    const c = {
      status: 'differs' as const,
      problems: [],
      rows: [{ lineId: 'discount', role: 'discount' as const, fleetsuite: { account: '485', cents: -1300 }, netsuite: { account: '485', cents: -1200 }, same: false }],
      lines: [],
    };
    expect(billPaymentReasons(c, account)).toEqual([{ key: 'discount|485', text: 'The discount differs from what NetSuite booked to 4850 Purchase Discounts.' }]);
  });

  it('says which payables each side used when they differ', () => {
    const c = check(65000, [ns('0', '100', -65000), ns('1', '201', 65000)]);
    expect(c.status).toBe('differs');
    expect(rows(c)).toEqual([
      ['payables', 'payables', ['200', 65000], null, false],
      ['paid_from', 'paid_from', ['100', -65000], ['100', -65000], true],
      ['account:201', 'payables', null, ['201', 65000], false],
    ]);
    expect(billPaymentReasons(c, account)).toEqual([
      { key: 'payables|200|201', text: 'Payables: FleetSuite used 2000 Accounts Payable, NetSuite 2010 Accounts Payable Other.' },
    ]);
  });

  it('differs when the copy\'s total isn\'t what NetSuite posted', () => {
    const c = check(65000, [ns('0', '100', -60000), ns('1', '200', 60000)]);
    expect(c.status).toBe('differs');
    expect(billPaymentReasons(c, account).map((r) => r.key)).toEqual(['payables_amount', 'paid_from_amount']);
    expect(billPaymentReasons(c, account)[1].text).toBe('The payment\'s total differs from what NetSuite took out of 1000 Checking.');
    // NetSuite took the money out of no account FleetSuite's entry has, only payables'.
    const none = { ...c, rows: [{ ...c.rows[1], netsuite: null }] };
    expect(billPaymentReasons(none, account)).toEqual([{ key: 'paid_from_none', text: 'NetSuite took nothing out of 1000 Checking for the bill payment.' }]);
    expect(billPaymentReasons({ ...c, rows: [{ ...c.rows[0], netsuite: null }] }, account))
      .toEqual([{ key: 'payables_none', text: 'NetSuite took nothing off payables for the bill payment.' }]);
  });

  it('waits for the GL copy when NetSuite has posted nothing for it yet, and matches a $0 payment with nothing on either side', () => {
    expect(check(65000, [])).toEqual({ status: 'waiting', waiting: 'gl', problems: [], rows: [], lines: [] });
    expect(check(0, [])).toEqual({ status: 'matches', problems: [], rows: [], lines: [] });
  });

  it('can\'t be worked out without payables, or when NetSuite\'s posting doesn\'t say where the money came from', () => {
    const noPayables = check(65000, POSTED, { payables: null, accountTypes: TYPES });
    expect(noPayables.status).toBe('unworkable');
    expect(noPayables.problems).toEqual([{ kind: 'no_payables' }]);
    expect(noPayables.lines).toEqual([]);
    // What NetSuite posted still shows.
    expect(rows(noPayables)).toEqual([
      ['paid_from', 'paid_from', null, ['100', -65000], false],
      ['account:200', 'payables', null, ['200', 65000], false],
    ]);
    expect(billPaymentReasons(noPayables, account).map((r) => r.text)).toEqual(['The chart of accounts has no payables account this company can use.']);

    const nowhere = check(65000, [ns('1', '200', 65000), ns('2', '100', -40000), ns('3', '220', -25000)]);
    expect(nowhere.status).toBe('unworkable');
    expect(billPaymentReasons(nowhere, account).map((r) => r.text))
      .toEqual(["NetSuite's posting of the bill payment doesn't say which account the money came from."]);
    expect(check(null).problems).toEqual([{ kind: 'unreadable' }]);
    expect(billPaymentReasons(check(null), account).map((r) => r.text)).toEqual(["The payment's total couldn't be read from the copy of the bill payment."]);
  });

  it('says so when the copy comes to $0 and NetSuite posts it', () => {
    const c = check(0);
    expect(c.status).toBe('differs');
    expect(billPaymentReasons(c, account).map((r) => r.text)).toEqual(['The copy of the bill payment comes to $0, yet NetSuite posts it.']);
  });
});

describe('checkBillPaymentMonth', () => {
  const CHART: ChartAccount[] = Object.entries(NAME).map(([id, label]) => ({
    netsuite_account_id: id,
    number: label.split(' ')[0],
    name: label.split(' ').slice(1).join(' '),
    account_type: TYPES.get(id)!,
    company: id === '210' ? '1084' : id === '200' || id === '201' ? 'BMG' : null,
    active: true,
    is_summary: false,
  }));

  const payment = (
    number: string | null, ref: string, total: string, lines: Array<[string, string, string, string]>,
    fields: Partial<BillPaymentMonthData['payments'][number]> = {},
  ): BillPaymentMonthData['payments'][number] => ({
    netsuite_id: ref,
    number,
    date: '2026-09-10',
    posting_month: lines.length ? '2026-09-01' : null,
    total,
    voided: false,
    status: 'Online Bill Pay',
    vendor: 'Sample Supply Co',
    vendor_netsuite_id: '50',
    vendor_payables: null,
    companies: lines.length ? ['BMG'] : [],
    links: [],
    netsuite: lines.map(([line_id, acct, debit, credit]) => ({ line_id, account: acct, debit, credit })),
    ...fields,
  });

  const DATA: BillPaymentMonthData = {
    payments: [
      // Dated in August, booked by NetSuite into September.
      payment('CHK1007', '807', '20.00', [['0', '100', '0.00', '20.00'], ['1', '200', '20.00', '0.00']], { date: '2026-08-31' }),
      payment('CHK1001', '801', '650.00', [['0', '100', '0.00', '650.00'], ['1', '200', '650.00', '0.00']], {
        vendor_payables: '200',
        links: [
          { netsuite_id: '701', type: 'VendBill', number: 'B-701', amount: '400.00' },
          { netsuite_id: '702', type: 'VendBill', number: null, amount: '250.00' },
        ],
      }),
      payment('CHK1002', '802', '637.00', [['0', '100', '0.00', '637.00'], ['1', '200', '650.00', '0.00'], ['2', '485', '0.00', '13.00']], {
        links: [
          { netsuite_id: '703', type: 'VendBill', number: 'B-703', amount: '637.00' },
          { netsuite_id: '704', type: 'VendCred', number: 'VC-704', amount: null },
        ],
      }),
      // Paid by card, its vendor's payables 1084's: BMG's own go instead.
      payment(null, '803', '50.00', [['0', '220', '0.00', '50.00'], ['1', '200', '50.00', '0.00']], { vendor_payables: '210' }),
      payment('CHK1004', '804', '75.00', []),
      payment('CHK1005', '805', '0.00', [], { links: [{ netsuite_id: '705', type: 'VendCred', number: 'VC-705', amount: '20.00' }] }),
      payment('CHK1006', '806', '80.00', [['0', '100', '0.00', '70.00'], ['1', '200', '70.00', '0.00']]),
      // Its vendor's own payables, which NetSuite didn't use.
      payment('CHK1008', '808', '30.00', [['0', '100', '0.00', '30.00'], ['1', '200', '30.00', '0.00']], { vendor_payables: '201' }),
    ],
    not_copied: [{ netsuite_id: '809', type: 'VendPymt', number: 'CHK1009' }],
  };

  it('checks every bill payment the company posted and names the rest', () => {
    const m = checkBillPaymentMonth(DATA, { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 6, matches: 4, differs: 2, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.reasons.map((r) => [r.text, r.invoices, r.examples])).toEqual([
      ['Payables: FleetSuite used 2010 Accounts Payable Other, NetSuite 2000 Accounts Payable.', 1, ['CHK1008']],
      ['The payment\'s total differs from what NetSuite took out of 1000 Checking.', 1, ['CHK1006']],
      ['What FleetSuite takes off payables differs from what NetSuite took off.', 1, ['CHK1006']],
    ]);
    expect(m.notes).toEqual([
      'BMG can use 2 payables accounts, so for a vendor with none of its own FleetSuite used 2000 Accounts Payable, '
        + 'the one NetSuite\'s bill payments used most this month.',
      '1 bill payment dated in another month is here because NetSuite booked it into this month: CHK1007.',
      '1 more bill payment dated this month isn\'t in the copy of NetSuite\'s GL for either company: CHK1004. NetSuite may have voided '
        + 'or deleted it, or the copy, which runs every two hours, hasn\'t reached it yet.',
      'The copy of NetSuite\'s GL has 1 bill payment of this company\'s booked into this month that the copy of the bill payments '
        + 'doesn\'t: CHK1009. The bill payments copy runs every two hours and may not have reached it yet, or NetSuite deleted it and '
        + 'the GL copy hasn\'t caught up.',
    ]);
    expect(m.invoices.map((p) => [p.number, p.status, p.total, p.booked])).toEqual([
      ['CHK1007', 'matches', 2000, { month: '2026-09-01', date: '2026-09-01' }],
      ['CHK1001', 'matches', 65000, undefined],
      ['CHK1002', 'matches', 63700, undefined],
      ['NetSuite 803', 'matches', 5000, undefined],
      ['CHK1006', 'differs', 8000, undefined],
      ['CHK1008', 'differs', 3000, undefined],
    ]);
    expect(m.invoices[1]).toMatchObject({
      netsuiteId: '801',
      date: '2026-09-10',
      customer: 'Sample Supply Co',
      type: 'VendPymt',
      netsuiteStatus: 'Online Bill Pay',
      reasons: [],
      // A bill the copy has no number for goes by NetSuite's id.
      applied: [{ number: 'B-701', cents: 40000 }, { number: 'NetSuite bill 702', cents: 25000 }],
    });
    // A bill credit is said to be one; an amount the copy couldn't read is none.
    expect(m.invoices[2].applied).toEqual([{ number: 'B-703', cents: 63700 }, { number: 'bill credit VC-704', cents: null }]);
    expect(m.invoices[2].rows.map((r) => [r.label, r.fleetsuite, r.netsuite, r.same])).toEqual([
      ['Payables', { account: '200', cents: 65000 }, { account: '200', cents: 65000 }, true],
      ['Paid from', { account: '100', cents: -63700 }, { account: '100', cents: -63700 }, true],
      ['Discount', { account: '485', cents: -1300 }, { account: '485', cents: -1300 }, true],
    ]);
    expect(m.invoices[3].rows.map((r) => [r.label, r.fleetsuite?.account, r.same])).toEqual([['Payables', '200', true], ['Paid from', '220', true]]);
    expect(m.invoices[5].rows.map((r) => [r.label, r.fleetsuite?.account ?? null, r.netsuite?.account ?? null])).toEqual([
      ['Payables', '201', null], ['Paid from', '100', '100'], ['Payables', null, '200'],
    ]);
    expect(m.accounts).toEqual({
      '100': '1000 Checking', '200': '2000 Accounts Payable', '201': '2010 Accounts Payable Other', '220': '2200 Company Card',
      '485': '4850 Purchase Discounts',
    });
  });

  it('says what FleetSuite\'s books hold for each of the company\'s and what the next run does, when its bill payments post', () => {
    const asked: string[] = [];
    const books = (w: WorkedBillPayment): InvoiceBooks => {
      asked.push(w.number);
      if (w.number === 'CHK1001') return { entryNo: 21, next: null, earlier: [{ entryNo: 14, reversedBy: 20 }] };
      return { entryNo: null, next: 'post', earlier: [] };
    };
    const m = checkBillPaymentMonth(DATA, { company: 'BMG', chart: CHART }, books);
    // Not CHK1004 or CHK1005, which neither company's GL copy has.
    expect(asked).toEqual(['CHK1007', 'CHK1001', 'CHK1002', 'NetSuite 803', 'CHK1006', 'CHK1008']);
    expect(m.invoices.map((p) => [p.number, p.books?.entryNo, p.books?.next])).toEqual([
      ['CHK1007', null, 'post'], ['CHK1001', 21, null], ['CHK1002', null, 'post'], ['NetSuite 803', null, 'post'],
      ['CHK1006', null, 'post'], ['CHK1008', null, 'post'],
    ]);
    expect(m.invoices[1].books?.earlier).toEqual([{ entryNo: 14, reversedBy: 20 }]);
    expect(m.summary).toMatchObject({ posted: 1, pending: 5 });
    // A company whose bill payments don't post yet gets neither.
    const without = checkBillPaymentMonth(DATA, { company: 'BMG', chart: CHART });
    expect(without.invoices.map((p) => p.books)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect([without.summary.posted, without.summary.pending]).toEqual([undefined, undefined]);
  });

  it('counts the bill payments with nothing to post apart from the ones in FleetSuite\'s books', () => {
    const books = (w: WorkedBillPayment): InvoiceBooks => (w.number === 'CHK1001' ? { entryNo: 21, next: null, earlier: [] }
      : w.number === 'CHK1002' ? { entryNo: null, next: null, earlier: [], nothingToPost: 'voided' }
        : { entryNo: null, next: null, earlier: [], nothingToPost: 'zero' });
    expect(checkBillPaymentMonth(DATA, { company: 'BMG', chart: CHART }, books).summary)
      .toMatchObject({ invoices: 6, posted: 1, pending: 0, nothingToPost: { voided: 1, zero: 4 } });
  });

  it('takes the company\'s only payables account without a word, and says nothing of a month with no payments', () => {
    const only = CHART.filter((a) => a.netsuite_account_id !== '201');
    const m = checkBillPaymentMonth({ payments: DATA.payments.slice(1, 2), not_copied: [] }, { company: 'BMG', chart: only });
    expect(m.notes).toEqual([]);
    expect(m.invoices.map((p) => p.status)).toEqual(['matches']);
    expect(checkBillPaymentMonth({ payments: [], not_copied: [] }, { company: 'BMG', chart: CHART })).toEqual({
      summary: { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 }, reasons: [], notes: [], invoices: [], accounts: {},
    });
  });
});
