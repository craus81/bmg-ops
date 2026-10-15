import { describe, it, expect } from 'vitest';
import type { ChartAccount, NetSuitePosting } from './invoice-check';
import { checkDeposit, checkDepositMonth, depositReasons, pickDepositsAccount, type DepositMonthData, type WorkedDeposit } from './deposit-check';

// Made-up books: '120' and '121' receivables, '110' Undeposited Funds, '100'
// a bank account, '230' customer deposits, '231' an older deposits account,
// '400' sales.
const TYPES = new Map([
  ['120', 'accounts_receivable'], ['121', 'accounts_receivable'], ['110', 'other_current_asset'], ['100', 'bank'],
  ['230', 'other_current_liability'], ['231', 'other_current_liability'], ['400', 'income'],
]);
const NAME: Record<string, string> = {
  '120': '1200 Receivables', '121': '1210 Receivables Other', '110': '1100 Undeposited Funds', '100': '1000 Checking',
  '230': '2300 Customer Deposits', '231': '2310 Old Deposits', '400': '4000 Sales',
};
const account = (id: string) => NAME[id] ?? `NetSuite account ${id}`;
const CTX: { deposits: string | null; receivable: string | null; accountTypes: Map<string, string> } = { deposits: '230', receivable: '120', accountTypes: TYPES };

const ns = (lineId: string, acct: string, cents: number): NetSuitePosting => ({ lineId, account: acct, cents });

// A $500.00 deposit as NetSuite posts it: the main line puts the money in Undeposited Funds, customer deposits are credited.
const DEPOSITED = [ns('0', '110', 50000), ns('1', '230', -50000)];
// $300.00 of it applied to an invoice: customer deposits debited, receivables credited.
const APPLIED = [ns('0', '120', -30000), ns('1', '230', 30000)];

const deposit = (cents: number | null, netsuite = DEPOSITED, ctx = CTX) => checkDeposit({ type: 'CustDep', cents, netsuite }, ctx);
const application = (cents: number | null, netsuite = APPLIED, ctx = CTX) => checkDeposit({ type: 'DepAppl', cents, netsuite }, ctx);
const rows = (c: ReturnType<typeof checkDeposit>) =>
  c.rows.map((r) => [r.lineId, r.role, r.fleetsuite && [r.fleetsuite.account, r.fleetsuite.cents], r.netsuite && [r.netsuite.account, r.netsuite.cents], r.same]);

describe('pickDepositsAccount', () => {
  it('is the one account the company\'s deposits and applications use', () => {
    expect(pickDepositsAccount([{ account: '230', documents: 12 }], 'BMG', TYPES, account)).toEqual({ account: '230', note: null });
  });

  it('takes the one most of them use when there are more, and says so', () => {
    expect(pickDepositsAccount([{ account: '231', documents: 2 }, { account: '230', documents: 12 }], 'BMG', TYPES, account)).toEqual({
      account: '230',
      note: "NetSuite's customer deposits for BMG use 2 accounts, so FleetSuite took 2300 Customer Deposits, the one most of them use.",
    });
    // The lower NetSuite id on a tie, so the pick never wavers.
    expect(pickDepositsAccount([{ account: '231', documents: 3 }, { account: '230', documents: 3 }], 'BMG', TYPES, account).account).toBe('230');
  });

  it('is never a receivable, income or expense account, and none when nothing else is used', () => {
    expect(pickDepositsAccount([{ account: '120', documents: 40 }, { account: '400', documents: 9 }, { account: '230', documents: 1 }], 'BMG', TYPES, account))
      .toEqual({ account: '230', note: null });
    expect(pickDepositsAccount([{ account: '120', documents: 4 }, { account: '230', documents: 0 }], 'BMG', TYPES, account)).toEqual({ account: null, note: null });
    expect(pickDepositsAccount([], 'BMG', TYPES, account)).toEqual({ account: null, note: null });
  });
});

describe('checkDeposit', () => {
  it('matches a deposit NetSuite puts where the money went and credits to customer deposits', () => {
    const c = deposit(50000);
    expect(c.status).toBe('matches');
    expect(rows(c)).toEqual([
      ['money', 'money', ['110', 50000], ['110', 50000], true],
      ['deposits', 'deposits', ['230', -50000], ['230', -50000], true],
    ]);
    // Paid straight into the bank, and found without its main line too.
    expect(deposit(50000, [ns('1', '230', -50000), ns('2', '100', 50000)]).rows[0].fleetsuite).toEqual({ account: '100', cents: 50000 });
  });

  it('matches an application NetSuite takes out of customer deposits and off receivables', () => {
    const c = application(30000);
    expect(c.status).toBe('matches');
    expect(rows(c)).toEqual([
      ['deposits', 'deposits', ['230', 30000], ['230', 30000], true],
      ['receivable', 'receivable', ['120', -30000], ['120', -30000], true],
    ]);
    // A receivable line for each invoice it pays adds up.
    expect(application(30000, [ns('0', '120', -10000), ns('1', '120', -20000), ns('2', '230', 30000)]).status).toBe('matches');
  });

  it('waits for the GL copy when NetSuite has posted nothing for it yet, and matches $0 with nothing on either side', () => {
    expect(deposit(50000, [])).toEqual({ status: 'waiting', waiting: 'gl', problems: [], rows: [] });
    expect(deposit(0, [])).toEqual({ status: 'matches', problems: [], rows: [] });
    expect(application(0, [])).toEqual({ status: 'matches', problems: [], rows: [] });
  });

  it('differs when the copy\'s total isn\'t what NetSuite posted', () => {
    const c = deposit(50000, [ns('0', '110', 45000), ns('1', '230', -45000)]);
    expect(c.status).toBe('differs');
    expect(depositReasons(c, 'CustDep', account).map((r) => r.text)).toEqual([
      "The deposit's total differs from what NetSuite put in 1100 Undeposited Funds.",
      "The deposit's total differs from what NetSuite credited to 2300 Customer Deposits.",
    ]);
    const a = application(30000, [ns('0', '120', -25000), ns('1', '230', 25000)]);
    expect(depositReasons(a, 'DepAppl', account).map((r) => r.text)).toEqual([
      "The application's total differs from what NetSuite took out of 2300 Customer Deposits.",
      'What FleetSuite takes off receivables differs from what NetSuite took off.',
    ]);
  });

  it('says which deposits account each side used when NetSuite booked a deposit to another', () => {
    const c = deposit(50000, [ns('0', '110', 50000), ns('1', '231', -50000)]);
    expect(c.status).toBe('differs');
    expect(rows(c)).toEqual([
      ['money', 'money', ['110', 50000], ['110', 50000], true],
      ['deposits', 'deposits', ['230', -50000], null, false],
      ['account:231', 'other', null, ['231', -50000], false],
    ]);
    expect(depositReasons(c, 'CustDep', account)).toEqual([
      { key: 'deposits|230|231', text: 'Customer deposits: FleetSuite used 2300 Customer Deposits, NetSuite 2310 Old Deposits.' },
    ]);
    // An application taking it out of another account reads the same.
    expect(depositReasons(application(30000, [ns('0', '120', -30000), ns('1', '231', 30000)]), 'DepAppl', account).map((r) => r.key))
      .toEqual(['deposits|230|231']);
  });

  it('says which receivable each side used when an application\'s differ', () => {
    const c = application(30000, [ns('0', '121', -30000), ns('1', '230', 30000)]);
    expect(rows(c)).toEqual([
      ['deposits', 'deposits', ['230', 30000], ['230', 30000], true],
      ['receivable', 'receivable', ['120', -30000], null, false],
      ['account:121', 'receivable', null, ['121', -30000], false],
    ]);
    expect(depositReasons(c, 'DepAppl', account)).toEqual([
      { key: 'receivable|120|121', text: 'Receivables: FleetSuite used 1200 Receivables, NetSuite 1210 Receivables Other.' },
    ]);
  });

  it('names a line NetSuite posts that the rule doesn\'t, and one it doesn\'t post', () => {
    const c = deposit(50000, [ns('0', '110', 50000), ns('1', '230', -45000), ns('2', '400', -5000)]);
    expect(depositReasons(c, 'CustDep', account).map((r) => r.text)).toEqual([
      "The deposit's total differs from what NetSuite credited to 2300 Customer Deposits.",
      "NetSuite also posts to 4000 Sales, which the deposit rule doesn't.",
    ]);
    expect(depositReasons(deposit(50000, [ns('0', '110', 50000), ns('1', '120', -50000)]), 'CustDep', account).map((r) => r.text)).toEqual([
      'NetSuite credited nothing to 2300 Customer Deposits for the deposit.',
      "NetSuite also posts to 1200 Receivables, which the deposit rule doesn't.",
    ]);
    expect(depositReasons(application(30000, [ns('0', '230', 30000), ns('1', '110', -30000)]), 'DepAppl', account).map((r) => r.text)).toEqual([
      'NetSuite took nothing off receivables for the application.',
      "NetSuite also posts to 1100 Undeposited Funds, which the deposit rule doesn't.",
    ]);
  });

  it('says so when the copy comes to $0 and NetSuite posts it', () => {
    expect(depositReasons(deposit(0), 'CustDep', account).map((r) => r.text)).toEqual(['The copy of the deposit comes to $0, yet NetSuite posts it.']);
    expect(depositReasons(application(0), 'DepAppl', account).map((r) => r.text)).toEqual(['The copy of the application comes to $0, yet NetSuite posts it.']);
  });

  it('can\'t be worked out without a deposits account or a receivable, or when NetSuite doesn\'t say where the money went', () => {
    const none = deposit(50000, DEPOSITED, { ...CTX, deposits: null });
    expect(none.status).toBe('unworkable');
    // What NetSuite posted still shows.
    expect(rows(none)).toEqual([
      ['money', 'money', null, ['110', 50000], false],
      ['account:230', 'other', null, ['230', -50000], false],
    ]);
    expect(depositReasons(none, 'CustDep', account).map((r) => r.text)).toEqual([
      "FleetSuite can't tell which account holds customer deposits: the copy of NetSuite's GL has no deposit of this company's yet.",
    ]);
    expect(application(30000, APPLIED, { ...CTX, receivable: null }).problems).toEqual([{ kind: 'no_receivable' }]);
    const nowhere = deposit(50000, [ns('1', '230', -50000), ns('2', '110', 30000), ns('3', '100', 20000)]);
    expect(depositReasons(nowhere, 'CustDep', account).map((r) => r.text)).toEqual([
      "NetSuite's posting of the deposit doesn't say which account the money went to.",
    ]);
    expect(depositReasons(deposit(null), 'CustDep', account).map((r) => r.text)).toEqual(["The deposit's amount couldn't be read from the copy of it."]);
  });
});

describe('checkDepositMonth', () => {
  const CHART: ChartAccount[] = Object.entries(NAME).map(([id, label]) => ({
    netsuite_account_id: id,
    number: label.split(' ')[0],
    name: label.split(' ').slice(1).join(' '),
    account_type: TYPES.get(id)!,
    company: null,
    active: true,
    is_summary: false,
  }));

  type Doc = DepositMonthData['deposits'][number];
  const doc = (type: Doc['type'], number: string | null, ref: string, total: string, lines: Array<[string, string, string, string]>, fields: Partial<Doc> = {}): Doc => ({
    netsuite_id: ref,
    type,
    number,
    date: '2026-09-10',
    total,
    voided: false,
    status: null,
    customer: 'A Customer',
    companies: lines.length ? ['BMG'] : [],
    links: [],
    applications: [],
    netsuite: lines.map(([line_id, acct, debit, credit]) => ({ line_id, account: acct, debit, credit })),
    ...fields,
  });

  const DATA: DepositMonthData = {
    deposits: [
      doc('CustDep', 'DEP1', '301', '500.00', [['0', '110', '500.00', '0.00'], ['1', '230', '0.00', '500.00']], {
        status: 'Fully Applied',
        links: [{ netsuite_id: '90', type: 'SalesOrd', number: 'SO90', amount: '500.00' }],
        applications: [
          { netsuite_id: '311', number: 'DA11', date: '2026-09-20', links: [
            { netsuite_id: '301', type: 'CustDep', number: 'DEP1', amount: '300.00' },
            { netsuite_id: '501', type: 'CustInvc', number: 'INV501', amount: '300.00' },
          ] },
          { netsuite_id: '312', number: null, date: '2026-10-02', links: [
            { netsuite_id: '301', type: 'CustDep', number: 'DEP1', amount: '200.00' },
            { netsuite_id: '502', type: 'CustInvc', number: null, amount: null },
          ] },
        ],
      }),
      doc('DepAppl', 'DA11', '311', '300.00', [['0', '120', '0.00', '300.00'], ['1', '230', '300.00', '0.00']], {
        date: '2026-09-20',
        links: [
          { netsuite_id: '301', type: 'CustDep', number: 'DEP1', amount: '300.00' },
          { netsuite_id: '501', type: 'CustInvc', number: 'INV501', amount: '300.00' },
        ],
      }),
      doc('CustDep', null, '303', '80.00', [['0', '110', '70.00', '0.00'], ['1', '230', '0.00', '70.00']]),
      // In neither company's GL copy.
      doc('CustDep', 'DEP4', '304', '75.00', []),
      // Voided: $0, and nothing on either side.
      doc('CustDep', 'DEP5', '305', '0.00', [], { voided: true, status: 'Voided' }),
    ],
    accounts: [{ account: '230', documents: 40 }, { account: '231', documents: 2 }, { account: '120', documents: 30 }],
    not_copied: [{ netsuite_id: '320', type: 'DepAppl', number: 'DA20' }, { netsuite_id: '321', type: 'CustDep', number: null }],
  };

  it('checks every deposit and application the company posted, and says what it applies', () => {
    const m = checkDepositMonth(DATA, { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 3, matches: 2, differs: 1, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.reasons.map((r) => [r.text, r.invoices, r.examples])).toEqual([
      ["The deposit's total differs from what NetSuite credited to 2300 Customer Deposits.", 1, ['NetSuite 303']],
      ["The deposit's total differs from what NetSuite put in 1100 Undeposited Funds.", 1, ['NetSuite 303']],
    ]);
    expect(m.invoices.map((d) => [d.number, d.type, d.status, d.total])).toEqual([
      ['DEP1', 'CustDep', 'matches', 50000], ['DA11', 'DepAppl', 'matches', 30000], ['NetSuite 303', 'CustDep', 'differs', 8000],
    ]);
    expect(m.invoices[0]).toMatchObject({
      netsuiteId: '301',
      customer: 'A Customer',
      netsuiteStatus: 'Fully Applied',
      order: 'SO90',
      // What its applications applied it to, each on its date; one with no number goes by NetSuite's id.
      applied: [{ number: 'INV501', cents: 30000, date: '2026-09-20' }, { number: 'NetSuite invoice 502', cents: null, date: '2026-10-02' }],
    });
    expect(m.invoices[0].deposit).toBeUndefined();
    expect(m.invoices[1]).toMatchObject({ deposit: 'DEP1', applied: [{ number: 'INV501', cents: 30000 }] });
    expect(m.invoices[1].order).toBeUndefined();
    expect(m.invoices[2].applied).toEqual([]);
    expect(m.invoices[1].rows.map((r) => [r.label, r.fleetsuite, r.netsuite, r.same])).toEqual([
      ['Customer deposits', { account: '230', cents: 30000 }, { account: '230', cents: 30000 }, true],
      ['Receivable', { account: '120', cents: -30000 }, { account: '120', cents: -30000 }, true],
    ]);
    expect(m.accounts).toEqual({ '110': '1100 Undeposited Funds', '120': '1200 Receivables', '230': '2300 Customer Deposits' });
  });

  it('says what FleetSuite\'s books hold for each when the company\'s deposits post', () => {
    const seen: string[] = [];
    const books = (w: WorkedDeposit) => {
      seen.push(w.number);
      return w.deposit.netsuite_id === '301'
        ? { entryNo: 4, next: null, earlier: [] }
        : { entryNo: null, next: w.checked.status === 'differs' ? null : 'post' as const, earlier: [] };
    };
    const m = checkDepositMonth(DATA, { company: 'BMG', chart: CHART }, books);
    // Only for the ones listed: not DEP4 or DEP5, in neither company's GL copy.
    expect(seen).toEqual(['DEP1', 'DA11', 'NetSuite 303']);
    expect(m.summary).toEqual({ invoices: 3, matches: 2, differs: 1, unworkable: 0, waiting: 0, withCost: 0, posted: 1, pending: 1 });
    expect(m.invoices.map((d) => [d.number, d.books])).toEqual([
      ['DEP1', { entryNo: 4, next: null, earlier: [] }],
      ['DA11', { entryNo: null, next: 'post', earlier: [] }],
      ['NetSuite 303', { entryNo: null, next: null, earlier: [] }],
    ]);
    // A company whose deposits don't post says nothing of the books.
    const plain = checkDepositMonth(DATA, { company: 'BMG', chart: CHART });
    expect(plain.summary.posted).toBeUndefined();
    expect(plain.invoices.every((d) => d.books === undefined)).toBe(true);
  });

  it('says which accounts it took and names the documents it couldn\'t check', () => {
    expect(checkDepositMonth(DATA, { company: 'BMG', chart: CHART }).notes).toEqual([
      "NetSuite's customer deposits for BMG use 2 accounts, so FleetSuite took 2300 Customer Deposits, the one most of them use.",
      "BMG can use 2 receivable accounts, so FleetSuite used 1200 Receivables, the one NetSuite's deposit applications used most this month.",
      "1 more deposit or application dated this month isn't in the copy of NetSuite's GL for either company: DEP4. NetSuite may have "
        + "deleted it, or the copy, which runs every two hours, hasn't reached it yet.",
      "The copy of NetSuite's GL has 2 deposits and applications of this company's dated this month that the copy of the deposits "
        + "doesn't: DA20, NetSuite 321. The deposits copy runs every two hours and may not have reached them yet, or NetSuite deleted "
        + "them and the GL copy hasn't caught up.",
    ]);
  });

  it('says nothing about the accounts in a month with no deposits or applications', () => {
    const m = checkDepositMonth({ deposits: [], accounts: DATA.accounts, not_copied: [] }, { company: 'BMG', chart: CHART });
    expect(m).toEqual({
      summary: { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 }, reasons: [], notes: [], invoices: [], accounts: {},
    });
  });
});
