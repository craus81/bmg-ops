// The rules a journal entry typed in FleetSuite is checked and made by
// (src/lib/typed-journal-entries.ts): the company, date, memo and lines it
// needs, each line an account the company can use and a debit or a credit to
// the cent, never to Accounts Receivable or Payable, debits matching credits;
// how its lines are kept and read back; what's sent to NetSuite; and the
// CPA's own adjustments journal (Books part 53): who types in which journal,
// and a CPA adjustment's memo starting "CPA adjustment:" in NetSuite. Made-up
// data.
import { describe, it, expect } from 'vitest';
import {
  CPA_MEMO_PREFIX, MAX_LINES, MAX_LINE_CENTS, MEMO_MAX, accountName, entryNoun, isDay, journalMemo, journalsFor, keptLines,
  linesToKeep, memoMax, netsuiteTypedEntry, reversalDate, reversed, typedExternalId, workOutTypedEntry,
  type JournalAccount, type TypedEntry, type TypedEntryFacts, type TypedLine,
} from './typed-journal-entries';

const account = (id: string, number: string | null, name: string, type = 'expense', companies = ['BMG']): [string, JournalAccount] =>
  [id, { id, number, name, type, companies }];
const FACTS: TypedEntryFacts = {
  company: { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2' },
  accounts: new Map([
    account('610', '6100', 'Depreciation'),
    account('150', '1590', 'Accumulated depreciation', 'fixed_asset'),
    account('230', '2300', 'Accrued wages', 'other_current_liability', ['BMG', '1084']),
    account('640', '6400', 'Dues', 'expense', ['1084']),
    account('120', '1200', 'Accounts receivable', 'accounts_receivable', []),
    account('200', '2000', 'Accounts payable', 'accounts_payable', []),
    account('699', null, 'Closed out', 'expense', []),
  ]),
};
const line = (accountId: string | null, debitCents: number, creditCents: number, memo: string | null = null): TypedLine =>
  ({ accountId, debitCents, creditCents, memo });
/** January's depreciation: $1,250.00 each side. */
const ENTRY: TypedEntry = {
  date: '2027-01-31',
  memo: '  January depreciation  ',
  lines: [line('610', 125000, 0, ' Shop truck '), line('150', 0, 125000, '   ')],
};
const problemsOf = (e: Partial<TypedEntry>, f: Partial<TypedEntryFacts> = {}) => workOutTypedEntry({ ...ENTRY, ...e }, { ...FACTS, ...f }).problems;

describe('workOutTypedEntry', () => {
  it('makes an entry whole and balanced as typed: its memos trimmed, a blank one none', () => {
    expect(workOutTypedEntry(ENTRY, FACTS)).toEqual({
      date: '2027-01-31',
      memo: 'January depreciation',
      lines: [
        { accountId: '610', debitCents: 125000, creditCents: 0, memo: 'Shop truck' },
        { accountId: '150', debitCents: 0, creditCents: 125000, memo: null },
      ],
      debitCents: 125000,
      creditCents: 125000,
      problems: [],
    });
    // As many lines as balance it, on any account the company can use.
    const accrual = workOutTypedEntry({
      date: '2027-12-31', memo: 'Year-end wages', lines: [line('610', 1000, 0), line('610', 2001, 0), line('230', 0, 3001, null)],
    }, FACTS);
    expect(accrual).toMatchObject({ problems: [], debitCents: 3001, creditCents: 3001 });
    expect(accrual.lines).toHaveLength(3);
  });

  it('needs a company NetSuite can take it for, a real date and a memo', () => {
    expect(problemsOf({}, { company: undefined })).toEqual(['Pick the company.', "Line 1 goes to an account FleetSuite can't use.", "Line 2 goes to an account FleetSuite can't use."]);
    expect(problemsOf({}, { company: { code: 'BMG', name: 'BMG Fleet', subsidiaryId: null } }))
      .toEqual(["BMG Fleet has no NetSuite subsidiary in Books, so NetSuite can't take its journal entries."]);
    for (const date of ['', '2027-02-30', '2027-13-01', '2027-1-31', '31/01/2027']) expect(problemsOf({ date })).toEqual(['Pick the date.']);
    expect(problemsOf({ memo: null })).toEqual(['Say what the entry is for in its memo.']);
    expect(problemsOf({ memo: '   ' })).toEqual(['Say what the entry is for in its memo.']);
    expect(problemsOf({ memo: 'm'.repeat(MEMO_MAX) })).toEqual([]);
    expect(problemsOf({ memo: 'm'.repeat(MEMO_MAX + 1) })).toEqual(['The memo takes 300 characters at most.']);
  });

  it('needs two lines or more, and 200 at most', () => {
    expect(problemsOf({ lines: [] })).toEqual(['A journal entry needs two lines or more.']);
    expect(problemsOf({ lines: [line('610', 0, 0)] })).toEqual(['A journal entry needs two lines or more.', 'Line 1 needs a debit or a credit, not both.']);
    const many = (n: number) => [line('610', n - 1, 0), ...Array.from({ length: n - 1 }, () => line('150', 0, 1))];
    expect(problemsOf({ lines: many(MAX_LINES) })).toEqual([]);
    expect(problemsOf({ lines: many(MAX_LINES + 1) })).toEqual(['One journal entry takes 200 lines at most, not 201.']);
  });

  it("needs each line's amount to the cent, $0 or more and $100,000,000.00 at most", () => {
    const one = (l: TypedLine) => problemsOf({ lines: [l, line('150', 0, 100)] });
    expect(one(line('610', 100.5, 0))).toContain("Line 1's amount isn't to the cent.");
    expect(one(line('610', Number.NaN, 0))).toContain("Line 1's amount isn't to the cent.");
    expect(one(line('610', 0, 0.5))).toContain("Line 1's amount isn't to the cent.");
    expect(one(line('610', -100, 0))).toContain("Line 1's amount can't be below $0.");
    expect(one(line('610', 0, -1))).toContain("Line 1's amount can't be below $0.");
    expect(one(line('610', MAX_LINE_CENTS + 1, 0))).toContain("Line 1's amount is more than $100,000,000.00.");
    expect(one(line('610', 0, MAX_LINE_CENTS + 1))).toContain("Line 1's amount is more than $100,000,000.00.");
    expect(problemsOf({ lines: [line('610', MAX_LINE_CENTS, 0), line('150', 0, MAX_LINE_CENTS)] })).toEqual([]);
    // A line with an amount that isn't one counts nowhere: the other line is all the totals have.
    expect(workOutTypedEntry({ ...ENTRY, lines: [line('610', -100, 0), line('150', 0, 100)] }, FACTS))
      .toMatchObject({ debitCents: 0, creditCents: 100, lines: [{ accountId: '150' }] });
  });

  it('needs each line a debit or a credit, not both and not neither', () => {
    expect(problemsOf({ lines: [line('610', 100, 100), line('150', 0, 0)] }))
      .toEqual(['Line 1 needs a debit or a credit, not both.', 'Line 2 needs a debit or a credit, not both.']);
    // What's typed still counts toward the totals, and they match here.
    expect(workOutTypedEntry({ ...ENTRY, lines: [line('610', 100, 100), line('150', 0, 0)] }, FACTS)).toMatchObject({ debitCents: 100, creditCents: 100, lines: [] });
  });

  it('needs each line an account the company can use, and never Accounts Receivable or Payable', () => {
    expect(problemsOf({ lines: [line(null, 125000, 0), line('150', 0, 125000)] })).toEqual(['Line 1 has no account.']);
    expect(problemsOf({ lines: [line('120', 125000, 0), line('200', 0, 125000)] })).toEqual([
      'Line 1 goes to 1200 Accounts receivable, and NetSuite needs a customer or vendor there: make it an invoice, credit memo, bill or vendor credit instead.',
      'Line 2 goes to 2000 Accounts payable, and NetSuite needs a customer or vendor there: make it an invoice, credit memo, bill or vendor credit instead.',
    ]);
    expect(problemsOf({ lines: [line('640', 125000, 0), line('699', 0, 125000)] }))
      .toEqual(["Line 1 goes to an account BMG Fleet can't use.", "Line 2 goes to an account BMG Fleet can't use."]);
    expect(problemsOf({ lines: [line('999', 125000, 0), line('150', 0, 125000)] })).toEqual(["Line 1 goes to an account BMG Fleet can't use."]);
    // 1084 can use its own accounts and the ones both companies share.
    expect(problemsOf({ lines: [line('640', 500, 0), line('230', 0, 500)] }, { company: { code: '1084', name: '1084 Cool Springs', subsidiaryId: '3' } }))
      .toEqual([]);
  });

  it("needs a line's memo 300 characters at most", () => {
    expect(problemsOf({ lines: [line('610', 125000, 0, 'n'.repeat(MEMO_MAX)), line('150', 0, 125000)] })).toEqual([]);
    expect(problemsOf({ lines: [line('610', 125000, 0, 'n'.repeat(MEMO_MAX + 1)), line('150', 0, 125000)] }))
      .toEqual(["Line 1's memo takes 300 characters at most."]);
  });

  it("says how far apart its debits and credits are when they don't match", () => {
    expect(problemsOf({ lines: [line('610', 125000, 0), line('150', 0, 124999)] }))
      .toEqual(["Its debits ($1,250.00) and credits ($1,249.99) don't match: they're $0.01 apart."]);
    expect(problemsOf({ lines: [line('610', 100, 0), line('150', 0, 25100)] }))
      .toEqual(["Its debits ($1.00) and credits ($251.00) don't match: they're $250.00 apart."]);
  });
});

describe('days', () => {
  it('takes a real day written YYYY-MM-DD, and nothing else', () => {
    expect(isDay('2027-01-31')).toBe(true);
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('2027-02-29')).toBe(false);
    expect(isDay('2027-04-31')).toBe(false);
    expect(isDay('2027-00-10')).toBe(false);
    expect(isDay('2027-1-31')).toBe(false);
    expect(isDay(' 2027-01-31')).toBe(false);
    expect(isDay('')).toBe(false);
  });

  it('dates a reversal the first of the next month', () => {
    expect(reversalDate('2027-01-31')).toBe('2027-02-01');
    expect(reversalDate('2027-09-15')).toBe('2027-10-01');
    expect(reversalDate('2027-12-31')).toBe('2028-01-01');
    expect(reversalDate('2027-02-30')).toBe('');
    expect(reversalDate('')).toBe('');
  });
});

describe('how lines are kept', () => {
  it('keeps each line as typed, its memo trimmed, and reads it back', () => {
    const kept = linesToKeep([line('610', 125000, 0, ' Shop truck '), line(null, 0, 125000, '  '), line('', 0, 0)]);
    expect(kept).toEqual([
      { account_netsuite_id: '610', debit_cents: 125000, credit_cents: 0, memo: 'Shop truck' },
      { account_netsuite_id: null, debit_cents: 0, credit_cents: 125000, memo: null },
      { account_netsuite_id: null, debit_cents: 0, credit_cents: 0, memo: null },
    ]);
    expect(keptLines(kept)).toEqual([line('610', 125000, 0, 'Shop truck'), line(null, 0, 125000), line(null, 0, 0)]);
    // The database's big whole numbers can come back as text.
    expect(keptLines([{ account_netsuite_id: '150', debit_cents: '0', credit_cents: '125000', memo: '' }])).toEqual([line('150', 0, 125000)]);
    expect(keptLines([{ account_netsuite_id: '', debit_cents: 0, credit_cents: 0, memo: null }])).toEqual([line(null, 0, 0)]);
    expect(keptLines(null)).toEqual([]);
    expect(keptLines(undefined)).toEqual([]);
    expect(keptLines({} as never)).toEqual([]);
  });

  it('turns each debit into a credit and each credit into a debit to reverse an entry', () => {
    expect(reversed(ENTRY.lines)).toEqual([line('610', 0, 125000, ' Shop truck '), line('150', 125000, 0, '   ')]);
  });
});

describe('what NetSuite is sent', () => {
  it('sends the lines in dollars, each a debit or a credit, under the entry\'s own External ID', () => {
    const worked = workOutTypedEntry(ENTRY, FACTS);
    expect(netsuiteTypedEntry(worked, '2', 'c0000000-0000-4000-8000-000000000001')).toEqual({
      subsidiaryId: '2',
      tranDate: '2027-01-31',
      memo: 'January depreciation',
      externalId: 'fleetsuite-je-c0000000-0000-4000-8000-000000000001',
      lines: [
        { accountId: '610', debit: 1250, memo: 'Shop truck' },
        { accountId: '150', credit: 1250 },
      ],
    });
    expect(typedExternalId('abc')).toBe('fleetsuite-je-abc');
    const cents = workOutTypedEntry({ ...ENTRY, lines: [line('610', 1, 0), line('150', 0, 1)] }, FACTS);
    expect(netsuiteTypedEntry(cents, '2', 'x').lines).toEqual([{ accountId: '610', debit: 0.01 }, { accountId: '150', credit: 0.01 }]);
  });

  it('names an account by its number and name', () => {
    expect(accountName({ number: '6100', name: 'Depreciation' })).toBe('6100 Depreciation');
    expect(accountName({ number: null, name: 'Closed out' })).toBe('Closed out');
  });
});

describe("the CPA's adjustments journal", () => {
  const holding = (...roles: string[]) => (role: string) => roles.includes(role);

  it('has whoever has Payments type in the general journal, and the CPA and super admins in the CPA adjustments', () => {
    expect(journalsFor({ payments: true, hasRole: holding('admin') })).toEqual(['general']);
    expect(journalsFor({ payments: true, hasRole: holding('finance', 'bookkeeper') })).toEqual(['general']);
    expect(journalsFor({ payments: false, hasRole: holding('cpa') })).toEqual(['cpa_adjustments']);
    expect(journalsFor({ payments: true, hasRole: holding('cpa', 'finance') })).toEqual(['general', 'cpa_adjustments']);
    expect(journalsFor({ payments: true, hasRole: holding('admin', 'super_admin') })).toEqual(['general', 'cpa_adjustments']);
    expect(journalsFor({ payments: false, hasRole: holding('super_admin') })).toEqual(['cpa_adjustments']);
    for (const roles of [['bookkeeper'], ['executive'], ['admin'], []]) {
      expect(journalsFor({ payments: false, hasRole: holding(...roles) }), roles.join()).toEqual([]);
    }
  });

  it("names each journal's entries", () => {
    expect([entryNoun('general'), entryNoun('cpa_adjustments')]).toEqual(['journal entry', 'CPA adjustment']);
  });

  it("starts a CPA adjustment's memo \"CPA adjustment: \" for NetSuite, once, leaving the general journal's as typed", () => {
    expect(CPA_MEMO_PREFIX).toBe('CPA adjustment: ');
    expect(journalMemo('cpa_adjustments', '2026 depreciation')).toBe('CPA adjustment: 2026 depreciation');
    expect(journalMemo('cpa_adjustments', 'CPA adjustment: 2026 depreciation')).toBe('CPA adjustment: 2026 depreciation');
    expect(journalMemo('cpa_adjustments', 'cpa Adjustment:loan interest')).toBe('cpa Adjustment:loan interest');
    expect(journalMemo('cpa_adjustments', 'CPA adjustments for 2026')).toBe('CPA adjustment: CPA adjustments for 2026');
    expect(journalMemo('general', '2026 depreciation')).toBe('2026 depreciation');

    const cpa = workOutTypedEntry({ ...ENTRY, journal: 'cpa_adjustments' }, FACTS);
    expect(cpa).toMatchObject({ memo: 'CPA adjustment: January depreciation', problems: [], debitCents: 125000 });
    expect(netsuiteTypedEntry(cpa, '2', 'e0000000-0000-4000-8000-000000000001').memo).toBe('CPA adjustment: January depreciation');
    expect(workOutTypedEntry(ENTRY, FACTS).memo).toBe('January depreciation');
    expect(workOutTypedEntry({ ...ENTRY, journal: 'general' }, FACTS).memo).toBe('January depreciation');
    // No memo is still no memo, and a problem.
    expect(workOutTypedEntry({ ...ENTRY, journal: 'cpa_adjustments', memo: '  ' }, FACTS)).toMatchObject({
      memo: '', problems: ['Say what the entry is for in its memo.'],
    });
  });

  it("keeps a CPA adjustment's memo short enough to start that way within NetSuite's 300 characters", () => {
    expect([memoMax('general'), memoMax('cpa_adjustments')]).toEqual([MEMO_MAX, MEMO_MAX - 16]);
    expect(problemsOf({ journal: 'cpa_adjustments', memo: 'm'.repeat(284) })).toEqual([]);
    expect(workOutTypedEntry({ ...ENTRY, journal: 'cpa_adjustments', memo: 'm'.repeat(284) }, FACTS).memo).toHaveLength(300);
    expect(problemsOf({ journal: 'cpa_adjustments', memo: 'm'.repeat(285) }))
      .toEqual(['A CPA adjustment\'s memo takes 284 characters at most, as NetSuite\'s starts "CPA adjustment:".']);
    expect(problemsOf({ memo: 'm'.repeat(285) })).toEqual([]);
  });
});
