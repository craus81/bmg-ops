import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import {
  centsToString,
  groupLines,
  monthFilter,
  monthLinesQuery,
  monthsBetween,
  monthsThatDiffer,
  nextMonth,
  noAccountNote,
  noAccountQuery,
  parseGlState,
  partyOpeningQuery,
  periodMonths,
  postingMonth,
  summarizePartyOpening,
  summarizeTotals,
  toCents,
  totalsQuery,
  transactionLinesQuery,
  type MonthRow,
} from './netsuite-gl';

const LINKS = new Map([['2', 'BMG' as const], ['5', '1084' as const]]);

// NetSuite's periods as SuiteQL lists them: months, a quarter, a year, and
// an adjustment period that ends with December.
const PERIOD_ROWS = [
  { id: 101, startdate: '12/1/2024', enddate: '12/31/2024', isquarter: 'F', isyear: 'F' },
  { id: 102, startdate: '1/1/2025', enddate: '1/31/2025', isquarter: 'F', isyear: 'F' },
  { id: '103', startdate: '2/1/2025', enddate: '2/28/2025', isquarter: 'F', isyear: 'F' },
  { id: 110, startdate: '1/1/2025', enddate: '3/31/2025', isquarter: 'T', isyear: 'F' },
  { id: 120, startdate: '1/1/2025', enddate: '12/31/2025', isquarter: 'F', isyear: 'T' },
  { id: 130, startdate: '12/31/2025', enddate: '12/31/2025', isquarter: 'F', isyear: 'F' },
  { id: 'x', startdate: '3/1/2025', enddate: '3/31/2025', isquarter: 'F', isyear: 'F' },
];
const PERIODS = periodMonths(PERIOD_ROWS);

describe('money', () => {
  it('reads dollars as whole cents without float noise', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents('1234.56')).toBe(123456);
    expect(toCents(' -12.05 ')).toBe(-1205);
    expect(toCents(-0.001)).toBe(0);
    expect(Object.is(toCents(-0.001), 0)).toBe(true);
    expect(toCents(null)).toBe(0);
    expect(toCents('')).toBe(0);
    expect(toCents(undefined)).toBe(0);
  });

  it('refuses an amount it can\'t read', () => {
    expect(() => toCents('12,50')).toThrow(/can't read/);
    expect(() => toCents('abc')).toThrow(/can't read/);
  });

  it('writes cents back the way the database takes them', () => {
    expect(centsToString(0)).toBe('0.00');
    expect(centsToString(5)).toBe('0.05');
    expect(centsToString(123456)).toBe('1234.56');
    expect(centsToString(-1205)).toBe('-12.05');
  });
});

describe('months', () => {
  it('steps over the year end', () => {
    expect(nextMonth('2025-12-01')).toBe('2026-01-01');
    expect(nextMonth('2025-09-01')).toBe('2025-10-01');
    expect(monthsBetween('2025-11-01', '2026-02-01')).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
    expect(monthsBetween('2026-02-01', '2026-01-01')).toEqual([]);
  });

  it('places each posting period in the month it ends, leaving out quarters, years and bad ids', () => {
    expect(Object.fromEntries(PERIODS)).toEqual({
      101: '2024-12-01',
      102: '2025-01-01',
      103: '2025-02-01',
      130: '2025-12-01',
    });
  });

  it('counts a line in its period\'s month, or its date\'s when the period is unknown', () => {
    expect(postingMonth(102, '2024-12-01', PERIODS)).toBe('2025-01-01');
    expect(postingMonth('999', '2025-03-01', PERIODS)).toBe('2025-03-01');
    expect(postingMonth(null, '2025-03-01', PERIODS)).toBe('2025-03-01');
    expect(postingMonth(102, '2024-12-01', null)).toBe('2024-12-01');
  });
});

describe('queries', () => {
  it('filters a month by date alone when there are no periods', () => {
    expect(monthFilter('2025-12-01', null)).toBe(
      "(t.trandate >= TO_DATE('12/01/2025', 'MM/DD/YYYY') AND t.trandate < TO_DATE('01/01/2026', 'MM/DD/YYYY'))",
    );
  });

  it('filters a month by its periods, and by date for lines in no known period', () => {
    const f = monthFilter('2025-12-01', PERIODS);
    expect(f).toContain('t.postingperiod IN (130)');
    expect(f).toContain('t.postingperiod IS NULL OR t.postingperiod NOT IN (101, 102, 103, 130)');
    expect(f).toContain("t.trandate >= TO_DATE('12/01/2025', 'MM/DD/YYYY')");
    // A month no period ends in still picks up dated lines with no period.
    const march = monthFilter('2025-03-01', PERIODS);
    expect(march).not.toMatch(/postingperiod IN/);
    expect(march).toContain("TO_DATE('03/01/2025', 'MM/DD/YYYY')");
  });

  it('refuses anything but a month', () => {
    expect(() => monthFilter('2025-03-15', null)).toThrow(/Not a month/);
    expect(() => monthFilter("2025-03-01') OR 1=1 --", null)).toThrow(/Not a month/);
    expect(() => transactionLinesQuery('12 OR 1=1', 'line', 'basic')).toThrow(/Not a NetSuite id/);
  });

  it('pages after a transaction id only when it is a number', () => {
    expect(monthLinesQuery('2025-01-01', null, '4500', 'line', 'full')).toContain('AND tal.transaction > 4500');
    expect(monthLinesQuery('2025-01-01', null, '1; DROP', 'line', 'full')).not.toContain('tal.transaction >');
    expect(monthLinesQuery('2025-01-01', null, null, 'line', 'full')).not.toContain('tal.transaction >');
  });

  it('uses the posting filter and columns it is given', () => {
    const both = monthLinesQuery('2025-01-01', null, null, 'transaction_and_line', 'full');
    expect(both).toContain("t.posting = 'T' AND tal.posting = 'T'");
    expect(both).toContain('tl.memo');
    expect(both).toContain('ORDER BY tal.transaction, tal.transactionline');
    const lineOnly = monthLinesQuery('2025-01-01', null, null, 'line', 'basic');
    expect(lineOnly).not.toContain("t.posting = 'T'");
    expect(lineOnly).toContain("tal.posting = 'T'");
    expect(lineOnly).not.toContain('tl.memo');
    expect(totalsQuery('line')).toContain('GROUP BY tl.subsidiary, tal.account, t.postingperiod');
    expect(transactionLinesQuery('77', 'line', 'basic')).toContain('tal.transaction = 77');
  });

  it('reads only lines with an account, while the totals count every line', () => {
    expect(monthLinesQuery('2025-01-01', PERIODS, '12', 'transaction_and_line', 'full')).toContain('AND tal.account IS NOT NULL');
    expect(transactionLinesQuery('77', 'line', 'basic')).toContain('AND tal.account IS NOT NULL');
    expect(totalsQuery('transaction_and_line')).not.toContain('tal.account IS');
  });
});

describe('summarizeTotals', () => {
  const rows = [
    // Before 2025: the starting entry, whether placed by period or by date.
    { subsidiary_id: 2, account_id: 10, period_id: 101, date_month: '2024-12', debit: '500.00', credit: null, line_count: 2 },
    { subsidiary_id: '2', account_id: '10', period_id: null, date_month: '2023-06', debit: 100, credit: 0, line_count: 1 },
    { subsidiary_id: 2, account_id: 30, period_id: 101, date_month: '2024-12', debit: 0, credit: '600.00', line_count: 3 },
    // Dated December 2024 but posted to January 2025: January.
    { subsidiary_id: 2, account_id: 10, period_id: 102, date_month: '2024-12', debit: '50.00', credit: 0, line_count: 1 },
    { subsidiary_id: 2, account_id: 10, period_id: 102, date_month: '2025-01', debit: '25.10', credit: '0.10', line_count: 2 },
    { subsidiary_id: 5, account_id: 40, period_id: 103, date_month: '2025-02', debit: 0, credit: '75.00', line_count: 1 },
    // Elsewhere: another subsidiary, none, and lines NetSuite can't place.
    { subsidiary_id: 9, account_id: 10, period_id: 102, date_month: '2025-01', debit: 10, credit: 0, line_count: 4 },
    { subsidiary_id: null, account_id: 10, period_id: 102, date_month: '2025-01', debit: 10, credit: 0, line_count: 1 },
    { subsidiary_id: 2, account_id: null, period_id: 102, date_month: '2025-01', debit: 10, credit: 0, line_count: 2 },
    { subsidiary_id: 2, account_id: 10, period_id: null, date_month: null, debit: 10, credit: 0, line_count: 3 },
    // Lines that post nowhere: no account (or month) and no amount.
    { subsidiary_id: 2, account_id: null, period_id: 103, date_month: '2025-02', debit: 0, credit: 0, line_count: 40 },
    { subsidiary_id: 5, account_id: null, period_id: 101, date_month: '2024-12', line_count: 7 },
    { subsidiary_id: 5, account_id: 40, period_id: null, date_month: null, debit: '0.00', credit: '0.00', line_count: 6 },
  ];

  it('splits NetSuite\'s totals into the starting entry and months from 2025', () => {
    const t = summarizeTotals(rows, PERIODS, LINKS);
    expect(t.opening).toEqual([
      { company: 'BMG', netsuite_account_id: '10', debit: '600.00', credit: '0.00', line_count: 3 },
      { company: 'BMG', netsuite_account_id: '30', debit: '0.00', credit: '600.00', line_count: 3 },
    ]);
    expect(t.months).toEqual([
      { company: 'BMG', netsuite_account_id: '10', month: '2025-01-01', debit: '75.10', credit: '0.10', line_count: 3 },
      { company: '1084', netsuite_account_id: '40', month: '2025-02-01', debit: '0.00', credit: '75.00', line_count: 1 },
    ]);
    expect(t.unlinked).toEqual({ 9: 4, '': 1 });
    // Only the unplaced lines that carry an amount count.
    expect(t.unplaced).toBe(5);
  });

  it('places by date when the periods couldn\'t be read', () => {
    const t = summarizeTotals(rows, null, LINKS);
    expect(t.opening.find((r) => r.netsuite_account_id === '10')).toMatchObject({ debit: '650.00', line_count: 4 });
    expect(t.months.find((r) => r.netsuite_account_id === '10')).toMatchObject({ debit: '25.10', line_count: 2 });
    // With no periods, a line with no date month has nowhere to go.
    expect(t.unplaced).toBe(5);
  });
});

describe('the starting entry by name', () => {
  it('reads the receivable and payable accounts by name, only the lines that can count before 2025', () => {
    const q = partyOpeningQuery('transaction_and_line', ['20', '25', '20', '7 OR 1=1'], PERIODS);
    expect(q).toContain("t.posting = 'T' AND tal.posting = 'T'");
    expect(q).toContain('AND tal.account IN (20, 25)');
    // December 2024's period, and anything dated before 2025.
    expect(q).toContain("AND (t.trandate < TO_DATE('01/01/2025', 'MM/DD/YYYY') OR t.postingperiod IN (101))");
    expect(q).toContain('GROUP BY tl.subsidiary, tal.account, tl.entity, t.entity, t.postingperiod');
    expect(partyOpeningQuery('line', ['20'], null)).toContain("AND (t.trandate < TO_DATE('01/01/2025', 'MM/DD/YYYY'))");
    expect(() => partyOpeningQuery('line', ['x'], null)).toThrow(/No receivable or payable account/);
  });

  it('adds up each name\'s lines before 2025, placed as the starting entry places them', () => {
    const rows = [
      // The line's own name stands before its transaction's.
      { subsidiary_id: 2, account_id: 20, line_entity_id: 900, txn_entity_id: 301, period_id: 101, date_month: '2024-12', debit: '500.00', credit: 0, line_count: 1 },
      { subsidiary_id: 2, account_id: 20, line_entity_id: null, txn_entity_id: 900, period_id: null, date_month: '2023-06', debit: 0, credit: '25.00', line_count: 2 },
      // No name at all.
      { subsidiary_id: 2, account_id: 20, line_entity_id: '', txn_entity_id: null, period_id: 101, date_month: '2024-12', debit: '0', credit: '40.00', line_count: 1 },
      // Dated December 2024 but posted to January 2025: not in the starting entry.
      { subsidiary_id: 2, account_id: 20, line_entity_id: 901, txn_entity_id: 302, period_id: 102, date_month: '2024-12', debit: '75.00', credit: 0, line_count: 1 },
      // Dated January 2025 but posted to December 2024: in it.
      { subsidiary_id: 5, account_id: 25, line_entity_id: null, txn_entity_id: 7001, period_id: 101, date_month: '2025-01', debit: 0, credit: '60.00', line_count: 1 },
      // Elsewhere, and lines it can't place.
      { subsidiary_id: 9, account_id: 20, line_entity_id: 900, period_id: 101, date_month: '2024-12', debit: 10, credit: 0, line_count: 1 },
      { subsidiary_id: 2, account_id: 20, line_entity_id: 900, period_id: null, date_month: null, debit: 10, credit: 0, line_count: 1 },
    ];
    expect(summarizePartyOpening(rows, PERIODS, LINKS)).toEqual([
      { company: 'BMG', netsuite_account_id: '20', entity_id: '900', debit: '500.00', credit: '25.00', line_count: 3 },
      { company: 'BMG', netsuite_account_id: '20', entity_id: '', debit: '0.00', credit: '40.00', line_count: 1 },
      { company: '1084', netsuite_account_id: '25', entity_id: '7001', debit: '0.00', credit: '60.00', line_count: 1 },
    ]);
    // By date when the periods couldn't be read: the January bill is 2025's, the December-dated invoice the starting entry's.
    const byDate = summarizePartyOpening(rows, null, LINKS);
    expect(byDate.find((r) => r.entity_id === '901')).toMatchObject({ debit: '75.00' });
    expect(byDate.some((r) => r.entity_id === '7001')).toBe(false);
  });

  it('comes to the starting entry itself on each account', () => {
    const rows = [
      { subsidiary_id: 2, account_id: 20, line_entity_id: 900, period_id: 101, date_month: '2024-12', debit: '500.00', credit: 0, line_count: 2 },
      { subsidiary_id: 2, account_id: 20, txn_entity_id: 901, period_id: 101, date_month: '2024-12', debit: 0, credit: '80.00', line_count: 1 },
      { subsidiary_id: 2, account_id: 20, line_entity_id: 902, period_id: 102, date_month: '2025-01', debit: '9.00', credit: 0, line_count: 1 },
    ];
    const byName = summarizePartyOpening(rows, PERIODS, LINKS);
    const whole = summarizeTotals(rows, PERIODS, LINKS).opening;
    const sum = (key: 'debit' | 'credit') => byName.reduce((s, r) => s + toCents(r[key]), 0);
    expect(whole).toEqual([{ company: 'BMG', netsuite_account_id: '20', debit: centsToString(sum('debit')), credit: centsToString(sum('credit')), line_count: 3 }]);
  });
});

describe('lines with an amount but no account', () => {
  it('counts them by transaction type in the linked subsidiaries', () => {
    const q = noAccountQuery('transaction_and_line', ['2', '5', 'x']);
    expect(q).toContain("t.posting = 'T' AND tal.posting = 'T'");
    expect(q).toContain('AND tal.account IS NULL');
    expect(q).toContain('AND (NVL(tal.debit, 0) <> 0 OR NVL(tal.credit, 0) <> 0)');
    expect(q).toContain('AND tl.subsidiary IN (2, 5)');
    expect(q).toContain('GROUP BY t.type');
    expect(() => noAccountQuery('line', ['1 OR 1=1'])).toThrow(/No NetSuite subsidiary/);
  });

  it('names the transaction types they are on, most first', () => {
    expect(noAccountNote(45, [
      { tran_type: 'CustInvc', line_count: '8' },
      { tran_type: 'ItemShip', line_count: 1200 },
      { tran_type: 'Zzz', line_count: 2 },
      { tran_type: 'VendBill', line_count: 0 },
    ])).toBe("1,210 GL lines in NetSuite carry an amount but no account, so they aren't copied. By transaction type: Item Fulfillment 1,200, Invoice 8, Zzz 2.");
    expect(noAccountNote(3, [{ tran_type: 'Journal', line_count: 1 }]))
      .toBe("1 GL line in NetSuite carries an amount but no account, so it isn't copied. By transaction type: Journal 1.");
  });

  it('lumps together the types past the sixth', () => {
    const rows = ['CustInvc', 'ItemShip', 'VendBill', 'Journal', 'Check', 'Deposit', 'CashSale', 'ItemRcpt']
      .map((tran_type, i) => ({ tran_type, line_count: 10 - i }));
    expect(noAccountNote(60, rows)).toMatch(/: Invoice 10, Item Fulfillment 9, Bill 8, Journal 7, Check 6, Deposit 5, other types 7\.$/);
  });

  it('gives the count alone when NetSuite wouldn\'t break it down', () => {
    expect(noAccountNote(40, null)).toBe("40 GL lines in NetSuite with no account or month aren't copied, though they carry amounts.");
    expect(noAccountNote(1, [])).toBe("1 GL line in NetSuite with no account or month isn't copied, though it carries an amount.");
  });
});

describe('monthsThatDiffer', () => {
  const row = (month: string, debit: string, lines = 1, account = '10', company: 'BMG' | '1084' = 'BMG'): MonthRow =>
    ({ company, netsuite_account_id: account, month, debit, credit: '0.00', line_count: lines });

  it('finds months whose amounts, line counts or accounts differ, oldest first', () => {
    const netsuite = [row('2025-03-01', '10.00'), row('2025-01-01', '10.00'), row('2025-02-01', '10.00', 2), row('2025-04-01', '5.00', 1, '20')];
    const copied = [row('2025-01-01', '10.0'), row('2025-02-01', '10.00', 1), row('2025-03-01', '10.01'), row('2025-04-01', '5.00', 1, '20', '1084')];
    expect(monthsThatDiffer(netsuite, copied)).toEqual(['2025-02-01', '2025-03-01', '2025-04-01']);
  });

  it('finds a month only one side has, and ignores anything before the copy starts', () => {
    expect(monthsThatDiffer([row('2025-05-01', '1.00')], [])).toEqual(['2025-05-01']);
    expect(monthsThatDiffer([], [row('2025-06-01', '1.00')])).toEqual(['2025-06-01']);
    expect(monthsThatDiffer([row('2024-12-01', '1.00')], [])).toEqual([]);
    expect(monthsThatDiffer([row('2025-01-01', '1.00')], [row('2025-01-01', '1.00')])).toEqual([]);
  });
});

describe('groupLines', () => {
  const line = (txn: number | string, ln: number | string, extra: Record<string, unknown> = {}) => ({
    txn_id: txn, line_id: ln, account_id: 10, debit: '10.00', credit: null, subsidiary_id: 2,
    tran_type: 'Journal', tranid: `JE${txn}`, trandate: '1/15/2025', period_id: 102, ...extra,
  });

  it('groups lines into whole transactions, in id order, with every field present', () => {
    const { transactions, kept, elsewhere } = groupLines([
      line(20, 3, { debit: null, credit: '10.00', account_id: 30 }),
      line(20, 0, { memo: '  Monthly accrual ', line_entity_id: '', txn_entity_id: 44, location_id: 1, department_id: 'x', class_id: 3 }),
      line(9, 1, { subsidiary_id: 5, trandate: '2025-02-03', period_id: null }),
      line(9, 2, { subsidiary_id: 5, debit: '-5.5', tran_type: null, tranid: '' }),
      line(20, 1, { subsidiary_id: 9 }),
    ], PERIODS, LINKS);
    expect(kept).toBe(4);
    expect(elsewhere).toBe(1);
    expect(transactions).toEqual([
      {
        netsuite_id: '9', tran_type: 'Journal', tranid: 'JE9', trandate: '2025-02-03', posting_month: '2025-02-01', posting_period_id: null,
        lines: [
          { line_id: '1', company: '1084', netsuite_account_id: '10', debit: '10.00', credit: '0.00', memo: null, entity_id: null, location_id: null, department_id: null, class_id: null },
          { line_id: '2', company: '1084', netsuite_account_id: '10', debit: '-5.50', credit: '0.00', memo: null, entity_id: null, location_id: null, department_id: null, class_id: null },
        ],
      },
      {
        netsuite_id: '20', tran_type: 'Journal', tranid: 'JE20', trandate: '2025-01-15', posting_month: '2025-01-01', posting_period_id: '102',
        lines: [
          { line_id: '0', company: 'BMG', netsuite_account_id: '10', debit: '10.00', credit: '0.00', memo: 'Monthly accrual', entity_id: '44', location_id: '1', department_id: null, class_id: '3' },
          { line_id: '3', company: 'BMG', netsuite_account_id: '30', debit: '0.00', credit: '10.00', memo: null, entity_id: null, location_id: null, department_id: null, class_id: null },
        ],
      },
    ]);
  });

  it('takes the transaction\'s posting period over its date', () => {
    const { transactions } = groupLines([line(1, 1, { trandate: '12/31/2024', period_id: 102 })], PERIODS, LINKS);
    expect(transactions[0]).toMatchObject({ trandate: '2024-12-31', posting_month: '2025-01-01' });
  });

  it('stops on a second line with the same number: more than one accounting book', () => {
    expect(() => groupLines([line(1, 1), line(1, 1, { debit: '12.00' })], PERIODS, LINKS)).toThrow(/more than one accounting book/);
  });

  it('stops on lines it can\'t place', () => {
    expect(() => groupLines([line(null as any, 1)], PERIODS, LINKS)).toThrow(/without a transaction or line id/);
    expect(() => groupLines([line(1, 1, { account_id: null })], PERIODS, LINKS)).toThrow(/no account/);
    expect(() => groupLines([line(1, 1, { trandate: 'soon' })], PERIODS, LINKS)).toThrow(/date FleetSuite can't read/);
  });
});

describe('parseGlState', () => {
  it('keeps a valid cursor and the months already swept', () => {
    expect(parseGlState({
      resume: { month: '2025-03-01', sweep: 'abc', afterTxn: '900', lines: 12 },
      lastSwept: { '2025-01-01': '2026-10-11T01:00:00.000Z', '2025-02-01': '2026-10-11T02:00:00.000Z' },
      swept: ['ignored'],
    })).toEqual({
      resume: { month: '2025-03-01', sweep: 'abc', afterTxn: '900', lines: 12 },
      lastSwept: { '2025-01-01': '2026-10-11T01:00:00.000Z', '2025-02-01': '2026-10-11T02:00:00.000Z' },
    });
  });

  it('drops anything that isn\'t what the job itself writes', () => {
    expect(parseGlState(null)).toEqual({ resume: null, lastSwept: {} });
    expect(parseGlState({ resume: { month: '2025-03', sweep: 'abc', afterTxn: null } }).resume).toBeNull();
    expect(parseGlState({ resume: { month: '2025-03-01', sweep: ' ', afterTxn: null } }).resume).toBeNull();
    expect(parseGlState({ resume: { month: '2025-03-01', sweep: 'abc', afterTxn: '1 OR 1=1' } }).resume).toBeNull();
    expect(parseGlState({ resume: { month: '2025-03-01', sweep: 'abc', afterTxn: 900 } }).resume).toBeNull();
    expect(parseGlState({ resume: { month: '2025-03-01', sweep: 'abc' } }).resume).toEqual({ month: '2025-03-01', sweep: 'abc', afterTxn: null, lines: 0 });
    expect(parseGlState({ lastSwept: { '2025-01-01': 'not a time', 'January': '2026-10-11T01:00:00.000Z', '2025-02-01': 5 } }).lastSwept).toEqual({});
  });
});
