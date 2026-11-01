import { describe, it, expect } from 'vitest';
import { COPY_FROM } from './netsuite-gl';
import { workOutTypedEntry, type TypedEntryFacts } from '@/lib/typed-journal-entries';
import {
  FIRST_MONTH, LANDLORD, NO_SETUP, SETUP_ACCOUNTS, TENANT,
  accountName, bookMonths, cents, monthBefore, monthEntries, monthName, monthViews, monthsFrom, mortgageCheck, paymentCents, rentCheck,
  rentDefault, sameEntry, setupProblems, statementNote, typedProblems,
  type BookMonth, type EntryRef, type RentMortgageSetup, type SavedMonth, type SetupAccount, type Statement,
} from './rent-and-mortgage';

// Made-up accounts: 1084's bank, rent income, mortgage, interest and escrow, and BMG's rent.
const ACCOUNTS = new Map<string, SetupAccount>([
  ['910', { id: '910', number: '10100', name: 'Ozark Federal Checking', type: 'bank', companies: ['1084'] }],
  ['930', { id: '930', number: '40000', name: 'Rent Income', type: 'income', companies: ['1084'] }],
  ['640', { id: '640', number: '64000', name: 'Rent', type: 'expense', companies: ['BMG'] }],
  ['920', { id: '920', number: '25000', name: 'Building Mortgage', type: 'long_term_liability', companies: ['1084'] }],
  ['950', { id: '950', number: '68000', name: 'Mortgage Interest', type: 'expense', companies: ['1084'] }],
  ['960', { id: '960', number: '13000', name: 'Escrow', type: 'other_current_asset', companies: ['1084'] }],
  ['500', { id: '500', number: '60100', name: 'Bank Fees', type: 'expense', companies: ['BMG', '1084'] }],
  ['110', { id: '110', number: '10000', name: 'First Bank Operating', type: 'bank', companies: ['BMG'] }],
]);

const SETUP: RentMortgageSetup = {
  bankAccount: '910', rentIncomeAccount: '930', tenantRentAccount: '640', mortgageAccount: '920', interestAccount: '950',
  escrowAccount: '960', lender: 'Ozark Federal',
};

const STATEMENT: Statement = { paidOn: '2027-03-05', principalCents: 312040, interestCents: 287960, escrowCents: 41500, balanceAfterCents: 72118833 };

const book = (over: Partial<BookMonth> = {}): BookMonth => ({
  month: '2027-03-01', tenantRentCents: 850000, rentCents: 850000, principalCents: 312040, interestCents: 287960, balanceCents: 72118833, ...over,
});

describe('rent and mortgage', () => {
  it("starts where FleetSuite's books start", () => {
    expect(FIRST_MONTH).toBe(COPY_FROM);
    expect([LANDLORD, TENANT]).toEqual(['1084', 'BMG']);
  });

  it('counts months across a year, and the month before', () => {
    expect(monthsFrom('2026-11-01', '2027-02-01')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
    expect(monthsFrom('2027-02-01', '2027-02-01')).toEqual(['2027-02-01']);
    expect(monthsFrom('2027-03-01', '2027-02-01')).toEqual([]);
    expect(monthsFrom(FIRST_MONTH, '2026-11-01')).toHaveLength(23);
    expect(monthBefore('2027-01-01')).toBe('2026-12-01');
    expect(monthBefore('2027-10-01')).toBe('2027-09-01');
    expect(monthName('2027-03-01')).toBe('March 2027');
    expect(monthName('2026-12-01')).toBe('December 2026');
  });

  it('reads amounts as whole cents', () => {
    expect(cents('8500.00')).toBe(850000);
    expect(cents('0.1')).toBe(10);
    expect(cents('19.99')).toBe(1999);
    expect(cents('0.29')).toBe(29);
    expect(cents(null)).toBe(0);
    expect(cents('')).toBe(0);
    expect(cents('-0.004')).toBe(0);
    expect(Object.is(cents('-0.004'), 0)).toBe(true);
    expect(() => cents('lots')).toThrow("The books gave an amount FleetSuite can't read (lots)");
  });

  describe('the setup', () => {
    it('takes each account its company can use, of a kind it can be', () => {
      expect(setupProblems(SETUP, ACCOUNTS)).toEqual([]);
      expect(setupProblems({ ...SETUP, escrowAccount: null, lender: null }, ACCOUNTS)).toEqual([]);
      expect(setupProblems(NO_SETUP, ACCOUNTS)).toEqual([]);
      // Open to both companies, so either can pick it.
      expect(setupProblems({ ...NO_SETUP, tenantRentAccount: '500' }, ACCOUNTS)).toEqual([]);
      expect(setupProblems({ ...NO_SETUP, interestAccount: '500' }, ACCOUNTS)).toEqual([]);
    });

    it("refuses an account of the other company's, of another kind, or not in the chart", () => {
      expect(setupProblems({ ...SETUP, bankAccount: '110' }, ACCOUNTS)).toEqual(["1084's bank account isn't an account that can be picked for it."]);
      expect(setupProblems({ ...SETUP, tenantRentAccount: '950' }, ACCOUNTS)).toEqual(["BMG's rent isn't an account that can be picked for it."]);
      expect(setupProblems({ ...SETUP, mortgageAccount: '960' }, ACCOUNTS)).toEqual(["1084's mortgage isn't an account that can be picked for it."]);
      expect(setupProblems({ ...SETUP, escrowAccount: '999' }, ACCOUNTS)).toEqual(["Escrow isn't an account that can be picked for it."]);
      expect(setupProblems({ ...SETUP, rentIncomeAccount: '910' }, ACCOUNTS)).toEqual(["1084's rent income isn't an account that can be picked for it."]);
    });

    it('takes each account once, and a lender of 100 characters at most', () => {
      expect(setupProblems({ ...SETUP, escrowAccount: '950' }, ACCOUNTS))
        .toEqual(["The mortgage's interest and escrow are the same account: pick each once."]);
      expect(setupProblems({ ...SETUP, tenantRentAccount: '500', interestAccount: '500' }, ACCOUNTS))
        .toEqual(["BMG's rent and the mortgage's interest are the same account: pick each once."]);
      expect(setupProblems({ ...SETUP, lender: 'O'.repeat(100) }, ACCOUNTS)).toEqual([]);
      expect(setupProblems({ ...SETUP, lender: ` ${'O'.repeat(100)} ` }, ACCOUNTS)).toEqual([]);
      expect(setupProblems({ ...SETUP, lender: 'O'.repeat(101) }, ACCOUNTS)).toEqual(["The lender's name takes 100 characters at most."]);
    });

    it('names an account by its number and name, or its name alone', () => {
      expect(accountName(ACCOUNTS.get('910')!)).toBe('10100 Ozark Federal Checking');
      expect(accountName({ number: null, name: 'Escrow' })).toBe('Escrow');
    });

    it('picks each account from its own company, escrow alone being optional', () => {
      expect(SETUP_ACCOUNTS.map((a) => [a.role, a.company, !!a.optional])).toEqual([
        ['bankAccount', '1084', false], ['rentIncomeAccount', '1084', false], ['tenantRentAccount', 'BMG', false],
        ['mortgageAccount', '1084', false], ['interestAccount', '1084', false], ['escrowAccount', '1084', true],
      ]);
    });
  });

  describe("what the books have", () => {
    const amount = (account: string, month: string, debit: string, credit = '0') => ({ account, month, debit, credit });
    const landlord = [
      amount('930', '2027-02-01', '0', '8500.00'), amount('910', '2027-02-01', '8500.00'),
      amount('920', '2027-02-01', '3108.00'), amount('950', '2027-02-01', '2891.60'),
      amount('920', '2027-03-01', '3120.40'), amount('950', '2027-03-01', '2879.60'),
      // A correction: a reversed line and its new one, in the same month.
      amount('930', '2027-03-01', '8500.00', '17000.00'),
      amount('fs:7d1e', '2027-03-01', '10.00'),
    ];
    const tenant = [amount('640', '2027-02-01', '8500.00'), amount('640', '2027-03-01', '8600.00', '100.00'), amount('110', '2027-03-01', '0', '8500.00')];
    // What NetSuite had before 2025: $730,000.00 owed on 1084's mortgage and $1,500.00 in its bank.
    const opening = [{ netsuite_account_id: '920', debit: '0', credit: '730000.00' }, { netsuite_account_id: '910', debit: '1500.00', credit: '0' }];
    const months = ['2027-01-01', '2027-02-01', '2027-03-01'];

    it("reads BMG's rent and 1084's month by month, with the mortgage from where it started", () => {
      expect(bookMonths({ setup: SETUP, landlord, tenant, opening, months })).toEqual([
        { month: '2027-01-01', tenantRentCents: 0, rentCents: 0, principalCents: 0, interestCents: 0, balanceCents: 73000000 },
        { month: '2027-02-01', tenantRentCents: 850000, rentCents: 850000, principalCents: 310800, interestCents: 289160, balanceCents: 72689200 },
        { month: '2027-03-01', tenantRentCents: 850000, rentCents: 850000, principalCents: 312040, interestCents: 287960, balanceCents: 72377160 },
      ]);
    });

    it("counts a month's moves before the months shown", () => {
      const earlier = [...landlord, amount('920', '2026-06-01', '1234.56')];
      expect(bookMonths({ setup: SETUP, landlord: earlier, tenant, opening, months: ['2027-01-01'] })[0].balanceCents).toBe(72876544);
    });

    it("has nothing for an account not picked, and no -$0", () => {
      const [m] = bookMonths({ setup: NO_SETUP, landlord, tenant, opening, months: ['2027-03-01'] });
      expect(m).toEqual({ month: '2027-03-01', tenantRentCents: null, rentCents: null, principalCents: null, interestCents: null, balanceCents: null });
      const [empty] = bookMonths({ setup: SETUP, landlord: [], tenant: [], opening: [], months: ['2027-03-01'] });
      expect(empty).toEqual({ month: '2027-03-01', tenantRentCents: 0, rentCents: 0, principalCents: 0, interestCents: 0, balanceCents: 0 });
      expect(Object.is(empty.rentCents, 0) && Object.is(empty.balanceCents, 0)).toBe(true);
    });
  });

  describe("what's typed", () => {
    it('takes the rent and statement to the cent, each dated in the month', () => {
      expect(typedProblems({ month: '2027-03-01', rent: { date: '2027-03-01', cents: 850000 }, statement: STATEMENT })).toEqual([]);
      expect(typedProblems({ month: '2027-03-01', rent: null, statement: null })).toEqual([]);
      expect(typedProblems({ month: '2027-03-01', rent: { date: '2027-03-31', cents: 1 }, statement: { ...STATEMENT, escrowCents: 0, interestCents: 0 } }))
        .toEqual([]);
      expect(typedProblems({ month: '2027-03-01', rent: { date: '2027-04-01', cents: 0 }, statement: null })).toEqual([
        "The rent's day isn't in March 2027.",
        'The rent needs an amount above $0 and up to $100,000,000.00, to the cent.',
      ]);
      expect(typedProblems({ month: '2027-02-01', rent: { date: '2027-02-30', cents: 8500.5 }, statement: null })).toEqual([
        "The rent's day isn't in February 2027.",
        'The rent needs an amount above $0 and up to $100,000,000.00, to the cent.',
      ]);
      expect(typedProblems({ month: '2027-03-01', rent: { date: '2027-03-01', cents: 10_000_000_001 }, statement: null }))
        .toEqual(['The rent needs an amount above $0 and up to $100,000,000.00, to the cent.']);
      expect(typedProblems({ month: '2027-03-01', rent: { date: '2027-03-01', cents: 10_000_000_000 }, statement: null })).toEqual([]);
    });

    it("says which of the statement's figures aren't to the cent, and refuses a payment of $0", () => {
      expect(typedProblems({ month: '2027-03-01', rent: null, statement: { ...STATEMENT, paidOn: '2027-02-28', interestCents: -1 } })).toEqual([
        "The day the payment was made isn't in March 2027.",
        "The statement's interest needs an amount of $0 or more and up to $100,000,000.00, to the cent.",
      ]);
      expect(typedProblems({ month: '2027-03-01', rent: null, statement: { ...STATEMENT, principalCents: 1.5, balanceAfterCents: 10_000_000_001 } }))
        .toEqual(["The statement's principal, principal left need an amount of $0 or more and up to $100,000,000.00, to the cent."]);
      expect(typedProblems({ month: '2027-03-01', rent: null, statement: { ...STATEMENT, escrowCents: Number.NaN } }))
        .toEqual(["The statement's escrow needs an amount of $0 or more and up to $100,000,000.00, to the cent."]);
      expect(typedProblems({ month: '2027-03-01', rent: null, statement: { ...STATEMENT, principalCents: 0, interestCents: 0, escrowCents: 0 } }))
        .toEqual(['The statement needs a payment above $0: its principal, interest and escrow are all $0.']);
      expect(typedProblems({ month: '2027-03-01', rent: null, statement: { ...STATEMENT, principalCents: -1, interestCents: 0, escrowCents: 0 } }))
        .toEqual(["The statement's principal needs an amount of $0 or more and up to $100,000,000.00, to the cent."]);
      expect(typedProblems({ month: '2027-03-01', rent: null, statement: { ...STATEMENT, principalCents: 0, interestCents: 0, escrowCents: 1, balanceAfterCents: 0 } }))
        .toEqual([]);
      expect(paymentCents(STATEMENT)).toBe(641500);
    });

    it("says when a statement's principal left doesn't follow from last month's", () => {
      const february: Statement = { ...STATEMENT, paidOn: '2027-02-05', balanceAfterCents: 72430873 };
      expect(statementNote(february, STATEMENT)).toBeNull();
      expect(statementNote(february, { ...STATEMENT, balanceAfterCents: 72118834 })).toBe(
        "Last month's statement left $724,308.73; less this month's principal of $3,120.40 that's $721,188.33, not $721,188.34.",
      );
      expect(statementNote(null, STATEMENT)).toBeNull();
      expect(statementNote(february, null)).toBeNull();
    });

    it("starts the rent at BMG's for the month, else last month's", () => {
      expect(rentDefault(book({ tenantRentCents: 860000 }), { typed: { date: '2027-02-01', cents: 850000 }, book: book() })).toBe(860000);
      expect(rentDefault(book({ tenantRentCents: 0 }), { typed: { date: '2027-02-01', cents: 840000 }, book: book() })).toBe(840000);
      expect(rentDefault(book({ tenantRentCents: -100 }), { typed: null, book: book({ rentCents: 830000 }) })).toBe(830000);
      expect(rentDefault(book({ tenantRentCents: null }), { typed: null, book: book({ rentCents: 0 }) })).toBeNull();
      expect(rentDefault(book({ tenantRentCents: null }), { typed: null, book: null })).toBeNull();
      expect(rentDefault(book({ tenantRentCents: 0 }), { typed: null, book: book({ rentCents: -5 }) })).toBeNull();
    });
  });

  describe('the checks', () => {
    const quiet = { thisMonth: false, entry: null };

    it("holds BMG's rent against 1084's", () => {
      expect(rentCheck(book(), quiet)).toEqual({ state: 'matches', tenantCents: 850000, landlordCents: 850000, apartCents: 0 });
      expect(rentCheck(book({ rentCents: 840000 }), quiet)).toEqual({ state: 'differs', tenantCents: 850000, landlordCents: 840000, apartCents: 10000 });
      expect(rentCheck(book({ tenantRentCents: 840000 }), quiet)).toMatchObject({ state: 'differs', apartCents: 10000 });
      expect(rentCheck(book({ tenantRentCents: 0, rentCents: 0 }), quiet)).toMatchObject({ state: 'none', apartCents: 0 });
      expect(rentCheck(book({ tenantRentCents: 0 }), quiet)).toMatchObject({ state: 'differs', apartCents: 850000 });
      expect(rentCheck(book({ tenantRentCents: null }), quiet)).toEqual({ state: 'not_set_up', tenantCents: 0, landlordCents: 0, apartCents: 0 });
      expect(rentCheck(book({ rentCents: null }), quiet)).toMatchObject({ state: 'not_set_up' });
    });

    it("waits on 1084's side this month, or while the month's rent entry is on its way", () => {
      expect(rentCheck(book({ rentCents: 0 }), quiet)).toMatchObject({ state: 'differs' });
      expect(rentCheck(book({ rentCents: 0 }), { thisMonth: true, entry: null })).toMatchObject({ state: 'waiting', apartCents: 850000 });
      for (const entry of ['draft', 'waiting', 'sending', 'made'] as const) {
        expect(rentCheck(book({ rentCents: 0 }), { thisMonth: false, entry })).toMatchObject({ state: 'waiting' });
      }
      // Only while 1084's books have none of it, and BMG's have some.
      expect(rentCheck(book({ rentCents: 1 }), { thisMonth: true, entry: 'made' })).toMatchObject({ state: 'differs' });
      expect(rentCheck(book({ tenantRentCents: -850000, rentCents: 0 }), { thisMonth: true, entry: 'made' })).toMatchObject({ state: 'differs' });
    });

    it("holds the mortgage against the lender's statement", () => {
      expect(mortgageCheck(book(), STATEMENT)).toEqual({ state: 'matches', differing: [] });
      expect(mortgageCheck(book(), null)).toEqual({ state: 'no_statement', differing: [] });
      expect(mortgageCheck(book({ principalCents: 0, interestCents: 0 }), STATEMENT)).toEqual({ state: 'not_booked', differing: [] });
      expect(mortgageCheck(book({ principalCents: 0 }), STATEMENT)).toMatchObject({ state: 'differs', differing: [{ what: 'principal' }] });
      expect(mortgageCheck(book({ interestCents: 0 }), STATEMENT)).toMatchObject({ state: 'differs', differing: [{ what: 'interest' }] });
      expect(mortgageCheck(book({ principalCents: 287960, interestCents: 312040, balanceCents: 72118834 }), STATEMENT)).toEqual({
        state: 'differs',
        differing: [
          { what: 'principal', books: 287960, statement: 312040 },
          { what: 'interest', books: 312040, statement: 287960 },
          { what: 'balance', books: 72118834, statement: 72118833 },
        ],
      });
      // Escrow isn't held against the books.
      expect(mortgageCheck(book(), { ...STATEMENT, escrowCents: 99999 })).toMatchObject({ state: 'matches' });
      for (const over of [{ principalCents: null }, { interestCents: null }, { balanceCents: null }]) {
        expect(mortgageCheck(book(over), STATEMENT)).toEqual({ state: 'not_set_up', differing: [] });
      }
    });
  });

  describe("the month's entries", () => {
    const typed = { month: '2027-03-01', rent: { date: '2027-03-03', cents: 850000 }, statement: STATEMENT };

    it('books the rent received and the mortgage payment, each on its own day', () => {
      expect(monthEntries({ setup: SETUP, typed, tenantName: 'BMG Fleet Installations' })).toEqual({
        rent: {
          journal: 'general', date: '2027-03-03', memo: 'Rent from BMG Fleet Installations for March 2027',
          lines: [
            { accountId: '910', debitCents: 850000, creditCents: 0, memo: null },
            { accountId: '930', debitCents: 0, creditCents: 850000, memo: null },
          ],
        },
        mortgage: {
          journal: 'general', date: '2027-03-05', memo: 'Mortgage payment to Ozark Federal for March 2027',
          lines: [
            { accountId: '920', debitCents: 312040, creditCents: 0, memo: 'Principal' },
            { accountId: '950', debitCents: 287960, creditCents: 0, memo: 'Interest' },
            { accountId: '960', debitCents: 41500, creditCents: 0, memo: 'Escrow' },
            { accountId: '910', debitCents: 0, creditCents: 641500, memo: null },
          ],
        },
        problems: [],
      });
    });

    it('leaves out a $0 part of the payment, and a lender not named', () => {
      const { mortgage } = monthEntries({
        setup: { ...SETUP, escrowAccount: null, lender: '  ' }, typed: { ...typed, statement: { ...STATEMENT, escrowCents: 0, principalCents: 0 } }, tenantName: 'BMG',
      });
      expect(mortgage).toEqual({
        journal: 'general', date: '2027-03-05', memo: 'Mortgage payment for March 2027',
        lines: [
          { accountId: '950', debitCents: 287960, creditCents: 0, memo: 'Interest' },
          { accountId: '910', debitCents: 0, creditCents: 287960, memo: null },
        ],
      });
      const onlyPrincipal = monthEntries({ setup: SETUP, typed: { ...typed, rent: null, statement: { ...STATEMENT, interestCents: 0, escrowCents: 0 } }, tenantName: 'BMG' });
      expect(onlyPrincipal.mortgage?.lines.map((l) => l.accountId)).toEqual(['920', '910']);
      expect(onlyPrincipal.rent).toBeNull();
    });

    it("says what's missing before they can be made", () => {
      expect(monthEntries({ setup: SETUP, typed: { month: '2027-03-01', rent: null, statement: null }, tenantName: 'BMG' }))
        .toEqual({ rent: null, mortgage: null, problems: ["Type the rent received or the lender's statement first."] });
      expect(monthEntries({ setup: { ...SETUP, rentIncomeAccount: null }, typed: { ...typed, statement: null }, tenantName: 'BMG' }))
        .toEqual({ rent: null, mortgage: null, problems: ["Pick 1084's bank account and rent income in the setup to book the rent."] });
      expect(monthEntries({ setup: { ...SETUP, bankAccount: null }, typed, tenantName: 'BMG' }).problems).toEqual([
        "Pick 1084's bank account and rent income in the setup to book the rent.",
        "Pick 1084's bank account, mortgage and the mortgage's interest in the setup to book the payment.",
      ]);
      for (const missing of ['mortgageAccount', 'interestAccount'] as const) {
        const made = monthEntries({ setup: { ...SETUP, [missing]: null }, typed, tenantName: 'BMG' });
        expect(made.mortgage).toBeNull();
        expect(made.rent).not.toBeNull();
        expect(made.problems).toEqual(["Pick 1084's bank account, mortgage and the mortgage's interest in the setup to book the payment."]);
      }
      const escrow = monthEntries({ setup: { ...SETUP, escrowAccount: null }, typed, tenantName: 'BMG' });
      expect(escrow.mortgage).toBeNull();
      expect(escrow.problems).toEqual(['The statement has escrow: pick the escrow account in the setup to book it.']);
      // Its figures' own problems come first.
      expect(monthEntries({ setup: SETUP, typed: { ...typed, rent: { date: '2027-04-01', cents: 850000 } }, tenantName: 'BMG' }).problems)
        .toEqual(["The rent's day isn't in March 2027."]);
    });

    it('makes entries Journal entries takes for 1084, each balanced', () => {
      const facts: TypedEntryFacts = {
        company: { code: '1084', name: '1084 Cool Springs', subsidiaryId: '5' },
        accounts: new Map([...ACCOUNTS.values()].map((a) => [a.id, { id: a.id, number: a.number, name: a.name, type: a.type, companies: a.companies }])),
      };
      const made = monthEntries({ setup: SETUP, typed, tenantName: 'BMG Fleet Installations' });
      for (const e of [made.rent!, made.mortgage!]) {
        const worked = workOutTypedEntry(e, facts);
        expect(worked.problems).toEqual([]);
        expect(worked.debitCents).toBe(worked.creditCents);
      }
      expect(workOutTypedEntry(made.mortgage!, facts).debitCents).toBe(641500);
    });
  });

  describe('each month, as the page shows it', () => {
    const TENANT_NAME = 'BMG Fleet Installations';
    const saved = (over: Partial<SavedMonth> = {}): SavedMonth => ({
      month: '2027-03-01', rent: { date: '2027-03-01', cents: 850000 }, statement: STATEMENT,
      rentEntryId: 'e1', mortgageEntryId: 'e2', updatedAt: '2027-03-06T15:00:00.000Z', updatedBy: 'Craig', ...over,
    });
    const made = monthEntries({ setup: SETUP, typed: saved(), tenantName: TENANT_NAME });
    // Each draft as March's figures make it.
    const ref = (id: string, over: Partial<EntryRef> = {}): EntryRef => {
      const e = id === 'e1' ? made.rent! : made.mortgage!;
      return {
        id, status: 'draft', updatedAt: '2027-03-06T15:00:01.000Z', date: e.date, memo: e.memo, lines: e.lines,
        totalCents: e.lines.reduce((sum, l) => sum + l.debitCents, 0), number: null, error: null, ...over,
      };
    };
    const views = (over: Partial<Parameters<typeof monthViews>[0]>) => monthViews({
      setup: SETUP, tenantName: TENANT_NAME, books: [book()], saved: [saved()],
      entries: new Map([['e1', ref('e1')], ['e2', ref('e2')]]), thisMonth: '2027-04-01', ...over,
    });
    const books = [book({ month: '2027-02-01' }), book(), book({ month: '2027-04-01', tenantRentCents: 0, rentCents: 0, principalCents: 0, interestCents: 0 })];

    it('lists them newest first, each with its checks and entries', () => {
      const [april, march, february] = views({
        books,
        saved: [saved(), saved({ month: '2027-02-01', rent: null, statement: { ...STATEMENT, paidOn: '2027-02-05', balanceAfterCents: 72430873 }, rentEntryId: null, mortgageEntryId: null })],
        entries: new Map([['e1', ref('e1')], ['e2', ref('e2', { status: 'made', number: 'JE88' })]]),
      });
      expect([april, march, february].map((v) => v.month)).toEqual(['2027-04-01', '2027-03-01', '2027-02-01']);
      expect(march).toMatchObject({
        rent: { date: '2027-03-01', cents: 850000 }, statement: STATEMENT, updatedAt: '2027-03-06T15:00:00.000Z', updatedBy: 'Craig',
        rentCheck: { state: 'matches' }, mortgageCheck: { state: 'matches' }, note: null, rentDefaultCents: null,
        entries: {
          rent: { id: 'e1', status: 'draft', date: '2027-03-01', totalCents: 850000, stale: false, takenOff: false },
          mortgage: { id: 'e2', status: 'made', number: 'JE88', date: '2027-03-05', totalCents: 641500, stale: false, takenOff: false },
        },
      });
      expect(february).toMatchObject({ rent: null, entries: { rent: null, mortgage: null }, rentDefaultCents: 850000, updatedBy: 'Craig' });
      expect(april).toMatchObject({
        rent: null, statement: null, updatedAt: null, updatedBy: null, entries: { rent: null, mortgage: null },
        rentCheck: { state: 'none' }, mortgageCheck: { state: 'no_statement' },
        // Nothing in BMG's books for April yet, so March's rent as typed.
        rentDefaultCents: 850000,
      });
    });

    it("says when a draft isn't what the month makes now, or its figures were taken off", () => {
      // The statement fixed since: only the payment's draft is behind.
      expect(views({ saved: [saved({ statement: { ...STATEMENT, interestCents: 287961 } })] })[0].entries)
        .toMatchObject({ rent: { stale: false }, mortgage: { stale: true } });
      // Another bank account picked: both are.
      expect(views({ setup: { ...SETUP, bankAccount: '500' } })[0].entries).toMatchObject({ rent: { stale: true }, mortgage: { stale: true } });
      // The lender renamed, or BMG: the memo that says it.
      expect(views({ setup: { ...SETUP, lender: 'Ozark Federal Bank' } })[0].entries).toMatchObject({ rent: { stale: false }, mortgage: { stale: true } });
      expect(views({ tenantName: 'BMG' })[0].entries).toMatchObject({ rent: { stale: true }, mortgage: { stale: false } });
      // The rent taken off: its draft is left for someone to delete, not brought up to date.
      expect(views({ saved: [saved({ rent: null })] })[0].entries).toMatchObject({ rent: { stale: false, takenOff: true }, mortgage: { stale: false, takenOff: false } });
      // A setup that can't make it now isn't a draft behind: making the entries says what's missing.
      expect(views({ setup: { ...SETUP, escrowAccount: null } })[0].entries).toMatchObject({ mortgage: { stale: false } });
      // Only a draft goes stale: one asked for approval, or made, is left as it is.
      expect(views({
        saved: [saved({ statement: { ...STATEMENT, interestCents: 287961 }, rent: { date: '2027-03-02', cents: 850000 } })],
        entries: new Map([['e1', ref('e1', { status: 'waiting' })], ['e2', ref('e2', { status: 'made', number: 'JE88' })]]),
      })[0].entries).toMatchObject({ rent: { status: 'waiting', stale: false }, mortgage: { status: 'made', stale: false } });
      // An entry no longer there is none.
      expect(views({ entries: new Map() })[0].entries).toEqual({ rent: null, mortgage: null });
    });

    it("starts a month's rent at BMG's books, else last month's as typed, else as 1084's books had it", () => {
      const april = book({ month: '2027-04-01', tenantRentCents: 0, rentCents: 0, principalCents: 0, interestCents: 0 });
      // March's rent typed, though 1084's books don't have it yet: March's as typed.
      expect(views({ books: [book({ rentCents: 0 }), april] })[0]).toMatchObject({ month: '2027-04-01', rentDefaultCents: 850000 });
      // Nothing typed for March: what 1084's books had for it.
      expect(views({ books: [book({ rentCents: 845000 }), april], saved: [] })[0]).toMatchObject({ month: '2027-04-01', rentDefaultCents: 845000 });
      // BMG's books have April's: theirs.
      expect(views({ books: [book(), { ...april, tenantRentCents: 860000 }] })[0].rentDefaultCents).toBe(860000);
    });

    it('holds a kept entry against what the figures make: its day, memo and lines in order', () => {
      const kept = { date: made.rent!.date, memo: made.rent!.memo, lines: made.rent!.lines };
      expect(sameEntry(made.rent!, kept)).toBe(true);
      // Kept with its memo trimmed and its amounts as text, as the database gives them back.
      expect(sameEntry(made.rent!, { ...kept, memo: ` ${kept.memo} `, lines: kept.lines.map((l) => ({ ...l, memo: l.memo ?? '' })) })).toBe(true);
      expect(sameEntry(made.rent!, { ...kept, date: '2027-03-02' })).toBe(false);
      expect(sameEntry(made.rent!, { ...kept, memo: 'Rent' })).toBe(false);
      expect(sameEntry(made.rent!, { ...kept, lines: [...kept.lines].reverse() })).toBe(false);
      expect(sameEntry(made.rent!, { ...kept, lines: kept.lines.slice(0, 1) })).toBe(false);
      expect(sameEntry(made.rent!, { ...kept, lines: kept.lines.map((l, i) => (i ? { ...l, creditCents: l.creditCents + 1 } : l)) })).toBe(false);
      expect(sameEntry(made.rent!, { ...kept, lines: kept.lines.map((l, i) => (i ? l : { ...l, debitCents: l.debitCents - 1 })) })).toBe(false);
      expect(sameEntry(made.mortgage!, { ...made.mortgage!, lines: made.mortgage!.lines.map((l, i) => (i ? l : { ...l, memo: 'Interest' })) })).toBe(false);
      expect(sameEntry(made.mortgage!, { ...made.mortgage!, lines: made.mortgage!.lines.map((l, i) => (i ? l : { ...l, accountId: '950' })) })).toBe(false);
    });

    it("waits on 1084's rent while the month's entry is on its way, and notes a statement that doesn't follow", () => {
      const [march, february] = views({
        books: [book({ month: '2027-02-01' }), book({ rentCents: 0 })],
        saved: [
          saved({ month: '2027-02-01', statement: { ...STATEMENT, paidOn: '2027-02-05', balanceAfterCents: 72430000 }, rentEntryId: null, mortgageEntryId: null }),
          saved({ mortgageEntryId: null }),
        ],
        entries: new Map([['e1', ref('e1', { status: 'waiting' })]]),
        thisMonth: '2027-05-01',
      });
      expect(march).toMatchObject({
        rentCheck: { state: 'waiting' },
        note: "Last month's statement left $724,300.00; less this month's principal of $3,120.40 that's $721,179.60, not $721,188.33.",
        entries: { rent: { status: 'waiting' }, mortgage: null },
      });
      expect(february).toMatchObject({ rentCheck: { state: 'matches' }, note: null });
      // The same month with no entry on its way, and not this month: they differ.
      expect(views({ books: [book({ rentCents: 0 })], saved: [], entries: new Map(), thisMonth: '2027-05-01' })[0].rentCheck.state).toBe('differs');
      expect(views({ books: [book({ rentCents: 0 })], saved: [], entries: new Map(), thisMonth: '2027-03-01' })[0].rentCheck.state).toBe('waiting');
    });
  });
});
