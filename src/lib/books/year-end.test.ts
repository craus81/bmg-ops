import { describe, it, expect } from 'vitest';
import type { MonthCompared, PeriodRow } from './months';
import { monthsBetween } from './netsuite-gl';
import {
  closedYears, closeYearRefusal, defaultYear, liveYear, ownMonths, readYearChecks, readYears, reopenYearRefusal, yearChecks,
  yearsShown, yearView, type BankYear, type CheckKey, type CpaAdjustment, type WaitingEntry, type YearFacts, type YearRow,
} from './year-end';

const MATCHES: MonthCompared = { status: 'matches', differing: 0, notPosted: false };
const DIFFERS: MonthCompared = { status: 'differs', differing: 2, notPosted: false };

const monthsOf = (year: number) => monthsBetween(`${year}-01-01`, `${year}-12-01`);
const closedMonth = (month: string): PeriodRow => ({
  id: `p-${month}`, month, closed: true, closedAt: '2028-01-10T16:00:00Z', closedBy: 'Craig',
  events: [{ action: 'closed', by: 'Craig', reason: null, at: '2028-01-10T16:00:00Z' }],
});
const openMonth = (month: string): PeriodRow => ({ ...closedMonth(month), closed: false, closedAt: null, closedBy: null });
const closedYear = (year: number, over: Partial<YearRow> = {}): YearRow => ({
  year, closed: true, closedAt: `${year + 1}-01-12T16:00:00Z`, closedBy: 'Craig', netIncome: 1250000, retainedEarnings: 4250000,
  events: [{ action: 'closed', by: 'Craig', reason: null, at: `${year + 1}-01-12T16:00:00Z`, netIncome: 1250000, retainedEarnings: 4250000 }],
  ...over,
});

/** A made-up CPA adjustment made in NetSuite: a year's depreciation on the shop truck. */
const adjustment = (date: string, over: Partial<CpaAdjustment> = {}): CpaAdjustment => ({
  id: `a-${date}`,
  date,
  memo: `${date.slice(0, 4)} depreciation`,
  number: 'JE1207',
  lines: [
    { accountId: '610', debitCents: 960000, creditCents: 0, memo: null },
    { accountId: '161', debitCents: 0, creditCents: 960000, memo: 'Shop truck' },
  ],
  ...over,
});

/** Made-up BMG books live from January 2027, with all of 2027 done by January 20, 2028. */
const facts = (over: Partial<YearFacts> = {}): YearFacts => ({
  name: 'BMG',
  liveFrom: '2027-01-01',
  year: 2027,
  today: '2028-01-20',
  periods: monthsOf(2027).map(closedMonth),
  compared: new Map(monthsOf(2027).map((m) => [m, MATCHES])),
  entries: [],
  adjustments: [adjustment('2027-12-31')],
  banks: [],
  returns: monthsOf(2027),
  years: [],
  ...over,
});
const check = (key: CheckKey, f: YearFacts) => yearChecks(f).find((c) => c.key === key)!;
const bank = (over: Partial<BankYear> = {}): BankYear => ({
  account: '11', name: '1010 First Bank checking', firstMonth: '2027-01-01', done: monthsOf(2027), ...over,
});
const entry = (status: WaitingEntry['status'], journal: WaitingEntry['journal'] = 'general'): WaitingEntry => ({ journal, status });

describe('the years and months a year end covers', () => {
  it("closes a year's months from January, or the month the books went live, through December", () => {
    expect(ownMonths(2027, '2027-01-01')).toEqual(monthsOf(2027));
    expect(ownMonths(2027, '2027-03-01')).toEqual(monthsBetween('2027-03-01', '2027-12-01'));
    expect(ownMonths(2027, '2027-03-15')).toHaveLength(10);
    expect(ownMonths(2028, '2027-03-01')).toEqual(monthsOf(2028));
    expect(ownMonths(2026, '2027-01-01')).toEqual([]);
    expect(ownMonths(2027, null)).toEqual([]);
    expect(liveYear('2027-03-01')).toBe(2027);
    expect(liveYear(null)).toBeNull();
  });

  it('lists the years from 2025 through this one, and opens on last year', () => {
    expect(yearsShown('2026-11-02')).toEqual([2025, 2026]);
    expect(yearsShown('2025-03-01')).toEqual([2025]);
    expect(yearsShown('2024-12-31')).toEqual([2025]);
    expect(yearsShown('2028-01-20')).toEqual([2025, 2026, 2027, 2028]);
    expect(defaultYear('2026-11-02')).toBe(2025);
    expect(defaultYear('2025-06-01')).toBe(2025);
    expect(defaultYear('2028-01-20')).toBe(2027);
  });

  it('knows which years are closed, a reopened one not among them', () => {
    expect(closedYears([closedYear(2027), { ...closedYear(2028), closed: false }])).toEqual(new Set([2027]));
    expect(closedYears([])).toEqual(new Set());
  });
});

describe("what's done before a year closes", () => {
  it('lists the checks in the order the page shows them, all done for a finished year', () => {
    expect(yearChecks(facts()).map((c) => [c.key, c.state])).toEqual([
      ['months', 'done'], ['netsuite', 'done'], ['entries', 'done'], ['yearly', 'done'], ['bank', 'none'], ['sales_tax', 'done'],
    ]);
  });

  it('closes every month first, the next one named', () => {
    expect(check('months', facts())).toEqual({ key: 'months', state: 'done', detail: 'All 12 months are closed.' });
    expect(check('months', facts({ liveFrom: '2027-03-01' })).detail).toBe('All 10 months are closed.');
    const twoLeft = facts({ today: '2027-12-15', periods: monthsBetween('2027-01-01', '2027-10-01').map(closedMonth) });
    expect(check('months', twoLeft)).toEqual({
      key: 'months', state: 'todo', detail: '10 of 12 months closed. November 2027 is next.', months: ['2027-11-01'],
    });
    const december = facts({ today: '2027-12-15', periods: monthsBetween('2027-01-01', '2027-11-01').map(closedMonth) });
    expect(check('months', december).detail).toBe("11 of 12 months closed. December 2027 is next, once it's over.");
    // A month is over the day after its last.
    const lastOfNovember = facts({ today: '2027-11-30', periods: monthsBetween('2027-01-01', '2027-10-01').map(closedMonth) });
    expect(check('months', lastOfNovember).detail).toBe("10 of 12 months closed. November 2027 is next, once it's over.");
    expect(check('months', facts({ liveFrom: '2027-12-01', today: '2027-12-15', periods: [] })).detail)
      .toBe("0 of 1 month closed. December 2027 is next, once it's over.");
    // A month reopened since counts as open.
    const reopened = facts({ periods: monthsOf(2027).map((m) => (m === '2027-06-01' ? openMonth(m) : closedMonth(m))) });
    expect(check('months', reopened)).toMatchObject({ state: 'todo', detail: '11 of 12 months closed. June 2027 is next.', months: ['2027-06-01'] });
  });

  it("has no months of its own to close before the books are live, or in a year before they went live", () => {
    expect(check('months', facts({ liveFrom: null }))).toEqual({
      key: 'months', state: 'none', detail: "BMG's books aren't live yet, so 2027's months close in NetSuite.",
    });
    expect(check('months', facts({ year: 2026 }))).toEqual({
      key: 'months', state: 'none', detail: '2026 is before BMG\'s books went live, so its months close in NetSuite.',
    });
  });

  it("names the months that don't match NetSuite", () => {
    expect(check('netsuite', facts())).toEqual({ key: 'netsuite', state: 'done', detail: 'Every month matches NetSuite.' });
    const compared = (off: Record<string, MonthCompared>) => facts({ compared: new Map(monthsOf(2027).map((m) => [m, off[m] ?? MATCHES])) });
    expect(check('netsuite', compared({ '2027-03-01': DIFFERS }))).toEqual({
      key: 'netsuite', state: 'todo', detail: "1 month doesn't match NetSuite: March.", months: ['2027-03-01'],
    });
    expect(check('netsuite', compared({ '2027-03-01': DIFFERS, '2027-07-01': DIFFERS })).detail).toBe("2 months don't match NetSuite: March and July.");
    // A month with documents FleetSuite doesn't post can't match whole either.
    const three = compared({ '2027-03-01': DIFFERS, '2027-07-01': DIFFERS, '2027-09-01': { ...MATCHES, notPosted: true } });
    expect(check('netsuite', three)).toMatchObject({
      detail: "3 months don't match NetSuite: March, July and September.", months: ['2027-03-01', '2027-07-01', '2027-09-01'],
    });
    expect(check('netsuite', facts({ compared: new Map() }))).toEqual({ key: 'netsuite', state: 'none', detail: "Nothing's posted in 2027 yet." });
    expect(check('netsuite', facts({ compared: new Map([['2027-05-01', { ...MATCHES, status: 'none' }]]) })).state).toBe('none');
    // A month posted on one side only still counts.
    expect(check('netsuite', facts({ compared: new Map([['2027-05-01', MATCHES]]) })).state).toBe('done');
  });

  it("counts the year's journal entries typed in FleetSuite that aren't made yet, and whose", () => {
    expect(check('entries', facts())).toEqual({ key: 'entries', state: 'done', detail: 'None dated in 2027 is waiting.' });
    expect(check('entries', facts({ entries: [entry('draft')] }))).toEqual({
      key: 'entries', state: 'todo', detail: "1 journal entry dated in 2027 isn't made yet: 1 still a draft.",
    });
    expect(check('entries', facts({ entries: [entry('waiting', 'cpa_adjustments')] })).detail)
      .toBe("1 journal entry dated in 2027 isn't made yet: 1 waiting for approval, the CPA's.");
    expect(check('entries', facts({ entries: [entry('draft'), entry('waiting'), entry('sending', 'cpa_adjustments')] })).detail)
      .toBe("3 journal entries dated in 2027 aren't made yet: 1 still a draft, 1 waiting for approval and 1 being made in NetSuite, 1 of them the CPA's.");
    expect(check('entries', facts({ entries: [entry('draft', 'cpa_adjustments'), entry('draft', 'cpa_adjustments')] })).detail)
      .toBe("2 journal entries dated in 2027 aren't made yet: 2 still drafts, all the CPA's.");
  });

  it("wants the CPA's adjustments dated in December made: the year's depreciation and loan interest", () => {
    expect(check('yearly', facts())).toEqual({ key: 'yearly', state: 'done', detail: '1 CPA adjustment dated in December 2027 is made.' });
    expect(check('yearly', facts({ adjustments: [adjustment('2027-06-30'), adjustment('2027-12-01'), adjustment('2027-12-31')] })).detail)
      .toBe('2 CPA adjustments dated in December 2027 are made.');
    expect(check('yearly', facts({ adjustments: [] }))).toEqual({
      key: 'yearly',
      state: 'todo',
      detail: "No CPA adjustment dated in December 2027 is made yet. The CPA types the year's depreciation and loan interest on CPA adjustments.",
    });
    // One dated earlier in the year, or in another year's December, isn't the year's.
    expect(check('yearly', facts({ adjustments: [adjustment('2027-11-30')] })).state).toBe('todo');
    expect(check('yearly', facts({ adjustments: [adjustment('2026-12-31')] })).state).toBe('todo');
    // Books live from March still close 2027 themselves.
    expect(check('yearly', facts({ liveFrom: '2027-03-01' })).state).toBe('done');
    expect(check('yearly', facts({ liveFrom: null, adjustments: [] }))).toEqual({
      key: 'yearly', state: 'none', detail: "BMG's books aren't live yet, so the CPA books 2027's depreciation and loan interest in NetSuite.",
    });
    expect(check('yearly', facts({ year: 2026, adjustments: [] }))).toEqual({
      key: 'yearly', state: 'none', detail: "2026 is before BMG's books went live, so the CPA books its depreciation and loan interest in NetSuite.",
    });
  });

  it('wants each bank account reconciled through December, from the month it starts', () => {
    expect(check('bank', facts())).toEqual({ key: 'bank', state: 'none', detail: "BMG's bank accounts aren't reconciled in FleetSuite yet." });
    expect(check('bank', facts({ banks: [bank({ firstMonth: '2028-02-01', done: [] })] }))).toEqual({
      key: 'bank', state: 'none', detail: 'Reconciling starts with February 2028.',
    });
    // With more than one, the earliest.
    const later = [bank({ firstMonth: '2028-03-01', done: [] }), bank({ account: '12', firstMonth: '2028-02-01', done: [] })];
    expect(check('bank', facts({ banks: later })).detail).toBe('Reconciling starts with February 2028.');
    expect(check('bank', facts({ banks: [bank()] }))).toEqual({ key: 'bank', state: 'done', detail: 'The bank account is reconciled through December.' });
    const savings = bank({ account: '12', name: '1020 First Bank savings', firstMonth: '2027-06-01', done: monthsBetween('2027-06-01', '2027-12-01') });
    expect(check('bank', facts({ banks: [bank(), savings] })).detail).toBe('Every bank account is reconciled through December.');
    // One started the year before counts from January; one started in June from June.
    const behind = facts({
      banks: [
        bank({ firstMonth: '2026-06-01', done: monthsBetween('2027-01-01', '2027-11-01') }),
        { ...savings, done: [] },
        bank({ account: '13', name: '1030 Payroll', firstMonth: '2027-12-01', done: [] }),
      ],
    });
    expect(check('bank', behind)).toEqual({
      key: 'bank',
      state: 'todo',
      detail: '1010 First Bank checking: 11 of 12 months reconciled. 1020 First Bank savings: 0 of 7 months reconciled. 1030 Payroll: 0 of 1 month reconciled.',
    });
    // One that starts after the year is left out.
    expect(check('bank', facts({ banks: [bank(), bank({ account: '14', firstMonth: '2028-03-01', done: [] })] })).state).toBe('done');
  });

  it("wants each month's Missouri return typed in once the month's over, for the company that makes sales", () => {
    expect(check('sales_tax', facts())).toEqual({ key: 'sales_tax', state: 'done', detail: "Every month's return is typed in." });
    expect(check('sales_tax', facts({ name: '1084', returns: null }))).toEqual({
      key: 'sales_tax', state: 'none', detail: '1084 makes no sales, so it files no sales tax return.',
    });
    expect(check('sales_tax', facts({ today: '2027-01-15', returns: [] }))).toEqual({ key: 'sales_tax', state: 'none', detail: 'No month of 2027 is over yet.' });
    const july = { today: '2027-07-10' };
    expect(check('sales_tax', facts({ ...july, returns: monthsBetween('2027-01-01', '2027-06-01') })).detail)
      .toBe('The returns for all 6 months so far are typed in.');
    expect(check('sales_tax', facts({ ...july, returns: ['2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01', '2027-06-01'] }))).toEqual({
      key: 'sales_tax', state: 'todo', detail: '5 of 6 months typed in. Not yet: May.', months: ['2027-05-01'],
    });
    expect(check('sales_tax', facts({ ...july, returns: monthsBetween('2027-01-01', '2027-04-01') })).detail)
      .toBe('4 of 6 months typed in. Not yet: May and June.');
    // A month is over the day after its last, and a return typed in before then isn't counted yet.
    expect(check('sales_tax', facts({ today: '2027-06-30', returns: monthsBetween('2027-01-01', '2027-05-01') })).detail)
      .toBe('The returns for all 5 months so far are typed in.');
    expect(check('sales_tax', facts({ today: '2027-12-15', returns: monthsBetween('2027-01-01', '2027-11-01') })).detail)
      .toBe('The returns for all 11 months so far are typed in.');
    expect(check('sales_tax', facts({ ...july, returns: ['2027-01-01', '2027-02-01', '2027-07-01'] })).detail)
      .toBe('2 of 6 months typed in. Not yet: March, April, May and June.');
  });
});

describe('closing and reopening a year', () => {
  it('closes a finished year with nothing left, and needs no reason', () => {
    expect(closeYearRefusal(facts(), '')).toBeNull();
  });

  it("refuses before the books are live, a year before they went live, and one that's closed", () => {
    expect(closeYearRefusal(facts({ liveFrom: null }), 'x')).toEqual({ message: "BMG's books aren't live yet, so there's no year to close.", status: 409 });
    expect(closeYearRefusal(facts({ year: 2026 }), 'x')).toEqual({ message: "2026 is before BMG's books went live, so it closes in NetSuite.", status: 400 });
    expect(closeYearRefusal(facts({ years: [closedYear(2027)] }), 'x')).toEqual({ message: '2027 is already closed.', status: 409 });
  });

  it('closes years in order, each once all its months are', () => {
    const y2028 = facts({
      year: 2028, today: '2029-01-20', periods: monthsOf(2028).map(closedMonth), compared: new Map(), adjustments: [adjustment('2028-12-31')], returns: monthsOf(2028),
    });
    expect(closeYearRefusal(y2028, 'x')).toEqual({ message: 'Close 2027 first: years close in order.', status: 409 });
    expect(closeYearRefusal({ ...y2028, years: [closedYear(2027)] }, '')).toBeNull();
    // A year reopened since is open again.
    expect(closeYearRefusal({ ...y2028, years: [closedYear(2027, { closed: false })] }, 'x')?.message).toBe('Close 2027 first: years close in order.');
    const december = facts({ periods: monthsBetween('2027-01-01', '2027-11-01').map(closedMonth) });
    expect(closeYearRefusal(december, 'Closing anyway')).toEqual({
      message: 'Close December 2027 first: a year closes once all its months are.', status: 409,
    });
    expect(closeYearRefusal(facts({ today: '2027-12-15', periods: monthsBetween('2027-01-01', '2027-11-01').map(closedMonth) }), 'x')?.status).toBe(409);
  });

  it("needs a reason when anything else isn't done, and not for what isn't BMG's to do", () => {
    const entries = facts({ entries: [entry('draft')] });
    expect(closeYearRefusal(entries, '')).toEqual({
      message: "Not everything's done before 2027 closes, so say why it's closed anyway.", status: 400,
    });
    expect(closeYearRefusal(entries, '   ')?.status).toBe(400);
    expect(closeYearRefusal(entries, 'The CPA posts it in NetSuite')).toBeNull();
    const off = facts({ compared: new Map([['2027-03-01', DIFFERS]]) });
    expect(closeYearRefusal(off, '')?.status).toBe(400);
    expect(closeYearRefusal(facts({ returns: ['2027-01-01'] }), '')?.status).toBe(400);
    expect(closeYearRefusal(facts({ banks: [bank({ done: [] })] }), '')?.status).toBe(400);
    expect(closeYearRefusal(facts({ adjustments: [] }), '')?.status).toBe(400);
    expect(closeYearRefusal(facts({ adjustments: [] }), 'The CPA booked depreciation in the general journal')).toBeNull();
    // Nothing posted, no bank accounts and no sales: nothing to say.
    expect(closeYearRefusal(facts({ name: '1084', compared: new Map(), returns: null }), '')).toBeNull();
  });

  it('reopens only the latest year closed, for a reason', () => {
    const both = [closedYear(2027), closedYear(2028)];
    expect(reopenYearRefusal({ year: 2028, years: both }, 'A late Grimco bill')).toBeNull();
    expect(reopenYearRefusal({ year: 2027, years: both }, 'A late Grimco bill')).toEqual({
      message: 'Reopen 2028 first: years reopen from the latest.', status: 409,
    });
    expect(reopenYearRefusal({ year: 2027, years: [closedYear(2027), closedYear(2029), closedYear(2028)] }, 'x')?.message)
      .toBe('Reopen 2029 first: years reopen from the latest.');
    expect(reopenYearRefusal({ year: 2028, years: both }, ' ')).toEqual({ message: 'Say why 2028 is reopened.', status: 400 });
    expect(reopenYearRefusal({ year: 2027, years: [] }, 'x')).toEqual({ message: "2027 isn't closed.", status: 409 });
    expect(reopenYearRefusal({ year: 2027, years: [closedYear(2027, { closed: false })] }, 'x')).toEqual({ message: "2027 isn't closed.", status: 409 });
    // A later year reopened since doesn't stand in the way.
    expect(reopenYearRefusal({ year: 2027, years: [closedYear(2027), closedYear(2028, { closed: false })] }, 'x')).toBeNull();
  });
});

describe('the year as the page shows it', () => {
  const amounts = (netIncome: number, closed: number) => ({ netIncome: { fleetsuite: netIncome, netsuite: 0 }, closed: { fleetsuite: closed, netsuite: 0 } });

  it('offers to close a finished year that is open', () => {
    expect(yearView(facts(), amounts(1250000, 4250000))).toEqual({
      own: true, over: true, checks: yearChecks(facts()), closed: null, changedSince: false, events: [], can: 'close',
    });
  });

  it("offers nothing for a year that isn't over, or that closes in NetSuite", () => {
    const december = facts({ today: '2027-12-15', periods: monthsBetween('2027-01-01', '2027-11-01').map(closedMonth) });
    expect(yearView(december, amounts(0, 0))).toMatchObject({ own: true, over: false, can: null });
    expect(yearView(facts({ today: '2027-12-31' }), amounts(0, 0)).over).toBe(false);
    expect(yearView(facts({ year: 2026 }), amounts(0, 0))).toMatchObject({ own: false, over: true, closed: null, can: null });
    expect(yearView(facts({ liveFrom: null }), amounts(0, 0))).toMatchObject({ own: false, can: null });
  });

  it('shows a closed year with who closed it and what it closed at, and offers to reopen the latest', () => {
    const closed = facts({ years: [closedYear(2027)] });
    expect(yearView(closed, amounts(1250000, 4250000))).toEqual({
      own: true,
      over: true,
      checks: yearChecks(closed),
      closed: { at: '2028-01-12T16:00:00Z', by: 'Craig', netIncome: 1250000, retainedEarnings: 4250000 },
      changedSince: false,
      events: closedYear(2027).events,
      can: 'reopen',
    });
    expect(yearView(facts({ years: [closedYear(2027), closedYear(2028)] }), amounts(1250000, 4250000)).can).toBeNull();
  });

  it("says when FleetSuite's books no longer have what a closed year closed at", () => {
    const closed = facts({ years: [closedYear(2027)] });
    expect(yearView(closed, amounts(1250100, 4250000)).changedSince).toBe(true);
    expect(yearView(closed, amounts(1250000, 4250100)).changedSince).toBe(true);
    // NetSuite's side isn't what was kept.
    expect(yearView(closed, { netIncome: { fleetsuite: 1250000, netsuite: 99 }, closed: { fleetsuite: 4250000, netsuite: 99 } }).changedSince).toBe(false);
    // A reopened year shows its history but isn't closed.
    const reopened = closedYear(2027, {
      closed: false, closedAt: null, closedBy: null, netIncome: null, retainedEarnings: null,
      events: [...closedYear(2027).events, { action: 'reopened', by: 'Craig', reason: 'A late bill', at: '2028-01-15T16:00:00Z', netIncome: null, retainedEarnings: null }],
    });
    expect(yearView(facts({ years: [reopened] }), amounts(1, 2))).toMatchObject({ closed: null, changedSince: false, events: reopened.events, can: 'close' });
  });
});

type Row = Record<string, any>;

/**
 * Just enough of supabase-js for the readers: filters, every table read
 * noted, and a table that fails when told to, or one read of it, named by
 * a filter it has ('typed_journal_entries?journal=cpa_adjustments').
 */
function fakeService(tables: Record<string, Row[]>, errors: Record<string, string> = {}) {
  const read: string[] = [];
  const from = (table: string) => {
    read.push(table);
    const filters: Array<(r: Row) => boolean> = [];
    const named: string[] = [];
    const result = () => {
      const error = errors[table] ?? named.map((n) => errors[`${table}?${n}`]).find(Boolean);
      return error
        ? { data: null, error: { message: error } }
        : { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
    };
    const q: any = {
      select: () => q,
      order: () => q,
      eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); named.push(`${col}=${v}`); return q; },
      neq: (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return q; },
      gte: (col: string, v: string) => { filters.push((r) => r[col] >= v); return q; },
      lte: (col: string, v: string) => { filters.push((r) => r[col] <= v); return q; },
      range: async (lo: number, hi: number) => { const r = result(); return { ...r, data: r.data && r.data.slice(lo, hi + 1) }; },
      then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(result()).then(done, failed),
    };
    return q;
  };
  return { service: { from } as any, read };
}

describe('reading the years', () => {
  const TABLES = {
    gl_year_closes: [
      { company_id: 'c2', year: 2027, status: 'closed', closed_at: '2028-01-12T16:00:00Z', closed_by_name: 'Craig', net_income_cents: '1250000', retained_earnings_cents: '4250000' },
      { company_id: 'c2', year: 2028, status: 'open', closed_at: null, closed_by_name: null, net_income_cents: null, retained_earnings_cents: null },
      { company_id: 'c1', year: 2027, status: 'closed', closed_at: '2028-01-13T16:00:00Z', closed_by_name: 'Craig', net_income_cents: 5, retained_earnings_cents: 6 },
    ],
    gl_year_close_events: [
      { id: 'e1', company_id: 'c2', year: 2027, action: 'closed', actor_name: 'Craig', reason: null, net_income_cents: '1250000', retained_earnings_cents: '4250000', created_at: '2028-01-12T16:00:00Z' },
      { id: 'e2', company_id: 'c2', year: 2028, action: 'closed', actor_name: 'Craig', reason: 'Returns typed in later', net_income_cents: -300, retained_earnings_cents: 4249700, created_at: '2029-01-12T16:00:00Z' },
      { id: 'e3', company_id: 'c2', year: 2028, action: 'reopened', actor_name: 'Harold', reason: 'A late Grimco bill', net_income_cents: null, retained_earnings_cents: null, created_at: '2029-01-14T16:00:00Z' },
      { id: 'e4', company_id: 'c1', year: 2027, action: 'closed', actor_name: 'Craig', reason: null, net_income_cents: 5, retained_earnings_cents: 6, created_at: '2028-01-13T16:00:00Z' },
    ],
  };

  it("reads a company's years with every close and reopen, amounts in whole cents", async () => {
    expect(await readYears(fakeService(TABLES).service, 'c2')).toEqual([
      {
        year: 2027, closed: true, closedAt: '2028-01-12T16:00:00Z', closedBy: 'Craig', netIncome: 1250000, retainedEarnings: 4250000,
        events: [{ action: 'closed', by: 'Craig', reason: null, at: '2028-01-12T16:00:00Z', netIncome: 1250000, retainedEarnings: 4250000 }],
      },
      {
        year: 2028, closed: false, closedAt: null, closedBy: null, netIncome: null, retainedEarnings: null,
        events: [
          { action: 'closed', by: 'Craig', reason: 'Returns typed in later', at: '2029-01-12T16:00:00Z', netIncome: -300, retainedEarnings: 4249700 },
          { action: 'reopened', by: 'Harold', reason: 'A late Grimco bill', at: '2029-01-14T16:00:00Z', netIncome: null, retainedEarnings: null },
        ],
      },
    ]);
    expect(await readYears(fakeService({}).service, 'c2')).toEqual([]);
  });

  it('says what failed', async () => {
    await expect(readYears(fakeService(TABLES, { gl_year_closes: 'down' }).service, 'c2')).rejects.toThrow("Couldn't read the years closed: down");
    await expect(readYears(fakeService(TABLES, { gl_year_close_events: 'down' }).service, 'c2')).rejects.toThrow("Couldn't read when the years were closed: down");
  });
});

describe("reading what's done before a year closes", () => {
  const TABLES = {
    typed_journal_entries: [
      { id: 'j1', company: 'BMG', tran_date: '2027-12-31', journal: 'cpa_adjustments', status: 'draft' },
      { id: 'j2', company: 'BMG', tran_date: '2027-03-15', journal: 'general', status: 'waiting' },
      { id: 'j3', company: 'BMG', tran_date: '2027-06-30', journal: 'general', status: 'made' },
      { id: 'j4', company: 'BMG', tran_date: '2028-01-01', journal: 'general', status: 'draft' },
      { id: 'j5', company: 'BMG', tran_date: '2026-12-31', journal: 'general', status: 'sending' },
      { id: 'j6', company: '1084', tran_date: '2027-05-01', journal: 'general', status: 'draft' },
      {
        id: 'j7', company: 'BMG', tran_date: '2027-06-30T00:00:00+00:00', journal: 'cpa_adjustments', status: 'made', memo: 'Loan interest to June',
        netsuite_number: null,
        lines: [
          { account_netsuite_id: '720', debit_cents: '41250', credit_cents: '0', memo: null },
          { account_netsuite_id: '2370', debit_cents: 0, credit_cents: 41250, memo: 'Apex Commercial printer loan' },
        ],
      },
      {
        id: 'j8', company: 'BMG', tran_date: '2027-12-31', journal: 'cpa_adjustments', status: 'made', memo: '2027 depreciation',
        netsuite_number: 'JE1207', lines: [{ account_netsuite_id: '610', debit_cents: 960000, credit_cents: 0, memo: null }],
      },
      { id: 'j9', company: 'BMG', tran_date: '2028-12-31', journal: 'cpa_adjustments', status: 'made', memo: '2028 depreciation', netsuite_number: 'JE1300', lines: [] },
      { id: 'j10', company: '1084', tran_date: '2027-12-31', journal: 'cpa_adjustments', status: 'made', memo: 'Building depreciation', netsuite_number: 'JE1208', lines: null },
      { id: 'j11', company: 'BMG', tran_date: '2026-12-31', journal: 'cpa_adjustments', status: 'made', memo: '2026 depreciation', netsuite_number: 'JE1100', lines: [] },
    ],
    bank_rec_starts: [
      { company: 'BMG', account: '11', first_month: '2027-01-01' },
      { company: 'BMG', account: '99', first_month: '2027-06-01' },
      { company: '1084', account: '21', first_month: '2027-01-01' },
    ],
    bank_recs: [
      { company: 'BMG', account: '11', month: '2026-12-01', status: 'done' },
      { company: 'BMG', account: '11', month: '2027-01-01', status: 'done' },
      { company: 'BMG', account: '11', month: '2027-02-01', status: 'open' },
      { company: 'BMG', account: '11', month: '2027-12-01', status: 'done' },
      { company: 'BMG', account: '11', month: '2028-01-01', status: 'done' },
      { company: '1084', account: '21', month: '2027-01-01', status: 'done' },
    ],
    sales_tax_returns: [
      { company: 'BMG', month: '2026-12-01' }, { company: 'BMG', month: '2027-01-01' }, { company: 'BMG', month: '2027-12-01' },
      { company: 'BMG', month: '2028-01-01' }, { company: '1084', month: '2027-02-01' },
    ],
  };
  const accountName = (id: string) => (id === '11' ? '1010 First Bank checking' : `NetSuite account ${id}`);

  it("reads the year's waiting journal entries, the CPA's made, each bank account with its months done, and the returns typed in", async () => {
    const { service, read } = fakeService(TABLES);
    expect(await readYearChecks(service, { company: 'BMG', year: 2027, makesSales: true, accountName })).toEqual({
      entries: [{ journal: 'cpa_adjustments', status: 'draft' }, { journal: 'general', status: 'waiting' }],
      adjustments: [
        {
          id: 'j7', date: '2027-06-30', memo: 'Loan interest to June', number: null,
          lines: [
            { accountId: '720', debitCents: 41250, creditCents: 0, memo: null },
            { accountId: '2370', debitCents: 0, creditCents: 41250, memo: 'Apex Commercial printer loan' },
          ],
        },
        { id: 'j8', date: '2027-12-31', memo: '2027 depreciation', number: 'JE1207', lines: [{ accountId: '610', debitCents: 960000, creditCents: 0, memo: null }] },
      ],
      banks: [
        { account: '11', name: '1010 First Bank checking', firstMonth: '2027-01-01', done: ['2027-01-01', '2027-12-01'] },
        { account: '99', name: 'NetSuite account 99', firstMonth: '2027-06-01', done: [] },
      ],
      returns: ['2027-01-01', '2027-12-01'],
    });
    expect(read).toEqual(['typed_journal_entries', 'typed_journal_entries', 'bank_rec_starts', 'bank_recs', 'sales_tax_returns']);
  });

  it("doesn't read returns for a company that makes no sales", async () => {
    const { service, read } = fakeService(TABLES);
    expect(await readYearChecks(service, { company: '1084', year: 2027, makesSales: false, accountName })).toEqual({
      entries: [{ journal: 'general', status: 'draft' }],
      adjustments: [{ id: 'j10', date: '2027-12-31', memo: 'Building depreciation', number: 'JE1208', lines: [] }],
      banks: [{ account: '21', name: 'NetSuite account 21', firstMonth: '2027-01-01', done: ['2027-01-01'] }],
      returns: null,
    });
    expect(read).not.toContain('sales_tax_returns');
  });

  it('says what failed', async () => {
    const opts = { company: 'BMG', year: 2027, makesSales: true, accountName };
    await expect(readYearChecks(fakeService(TABLES, { typed_journal_entries: 'down' }).service, opts))
      .rejects.toThrow("Couldn't read the journal entries: down");
    await expect(readYearChecks(fakeService(TABLES, { 'typed_journal_entries?journal=cpa_adjustments': 'down' }).service, opts))
      .rejects.toThrow("Couldn't read the CPA's adjustments: down");
    for (const table of ['bank_rec_starts', 'bank_recs', 'sales_tax_returns']) {
      await expect(readYearChecks(fakeService(TABLES, { [table]: `${table} down` }).service, opts))
        .rejects.toThrow(`Couldn't read what's done before the year closes: ${table} down`);
    }
  });
});
