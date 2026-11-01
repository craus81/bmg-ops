import { describe, it, expect } from 'vitest';
import {
  MAX_OUTSTANDING, balanceOn, draftFor, lastDay, longDate, monthAfter, monthViews, nextMonth, nextView, openEntries, recProblems,
  startProblems, startView, startingFor,
  type BankDoc, type RecBooks, type RecStart, type SavedRec, type RecTick,
} from './bank-reconciliation';

// Made-up data: 1084's bank account from September to December 2026.
const doc = (d: string, date: string, cents: number, type = 'Journal', number = `JE${d}`): BankDoc =>
  ({ doc: d, date, type, number, name: null, memo: null, cents });
const TYPED = 'entry:e0000000-0000-4000-8000-000000000007';
const DOCS: BankDoc[] = [
  doc('4999', '2026-09-01', 850000, 'Deposit', 'DEP88'),
  doc('5001', '2026-09-28', -45000, 'Check', '1001'),
  doc('5002', '2026-10-01', 850000),
  doc('5003', '2026-10-05', -641500),
  doc('5004', '2026-10-31', -12000, 'Check', '1002'),
  doc('5005', '2026-11-02', 850000),
  doc(TYPED, '2026-11-05', -641500, 'Typed entry (FleetSuite only)', 'Entry 41'),
];
const OPENING = 1000000;
// The books have $18,050.00 on September 30; check 1001 hadn't cleared, so the bank had $18,500.00.
const START: RecStart = { firstMonth: '2026-10-01', asOf: '2026-09-30', balanceCents: 1850000, outstanding: ['5001'] };

const rec = (month: string, over: Partial<SavedRec> = {}): SavedRec => ({
  month, endsOn: lastDay(month), endingCents: null, status: 'open', updatedAt: `${month}T12:00:00Z`, updatedBy: 'Valarie',
  doneAt: null, doneBy: null, ...over,
});
const tick = (d: string, month: string, cents: number): RecTick => ({ doc: d, month, cents });

const books = (over: Partial<RecBooks> = {}): RecBooks => ({
  start: START, recs: [], ticks: [], events: [], docs: DOCS, openingCents: OPENING, ...over,
});

const OCTOBER_DONE: Partial<RecBooks> = {
  recs: [rec('2026-10-01', { endingCents: 2013500, status: 'done', doneAt: '2026-11-03T15:00:00Z', doneBy: 'Valarie' })],
  ticks: [tick('5001', '2026-10-01', -45000), tick('5002', '2026-10-01', 850000), tick('5003', '2026-10-01', -641500)],
};

describe('months and days', () => {
  it('names the last day, the month after and a long date', () => {
    expect(lastDay('2026-02-01')).toBe('2026-02-28');
    expect(lastDay('2028-02-01')).toBe('2028-02-29');
    expect(lastDay('2026-12-01')).toBe('2026-12-31');
    expect(monthAfter('2026-11-01')).toBe('2026-12-01');
    expect(monthAfter('2026-12-01')).toBe('2027-01-01');
    expect(longDate('2026-09-05')).toBe('September 5, 2026');
  });

  it('reconciles next the month after the last one done, else the month reconciling starts with', () => {
    expect(nextMonth(START, [])).toBe('2026-10-01');
    expect(nextMonth(START, [rec('2026-10-01')])).toBe('2026-10-01');
    expect(nextMonth(START, [rec('2026-11-01', { status: 'done' }), rec('2026-10-01', { status: 'done' }), rec('2026-12-01')])).toBe('2026-12-01');
  });
});

describe('where reconciling starts', () => {
  const on = { thisMonth: '2026-11-01', docs: DOCS };

  it('takes a month from January 2025 through this one, from a day in the month before', () => {
    expect(startProblems(START, on)).toEqual([]);
    expect(startProblems({ ...START, asOf: '2026-09-25', outstanding: [] }, on)).toEqual([]);
    expect(startProblems({ ...START, firstMonth: '2026-11-01', asOf: '2026-10-31' }, on)).toEqual([]);
    const month = 'Reconciling starts with a month from January 2025 through November 2026.';
    expect(startProblems({ ...START, firstMonth: '2024-12-01' }, on)).toEqual([month]);
    expect(startProblems({ ...START, firstMonth: '2026-12-01' }, on)).toEqual([month]);
    expect(startProblems({ ...START, firstMonth: '2026-10-02' }, on)).toEqual([month]);
    expect(startProblems({ ...START, firstMonth: '2026-13-01' }, on)).toEqual([month]);
    expect(startProblems({ ...START, firstMonth: '2026-00-01' }, on)).toEqual([month]);
    const day = "The starting balance is the bank's on the last day of the statement before October 2026's, a day in September 2026.";
    expect(startProblems({ ...START, asOf: '2026-10-01', outstanding: [] }, on)).toEqual([day]);
    expect(startProblems({ ...START, asOf: '2026-08-31', outstanding: [] }, on)).toEqual([day]);
    expect(startProblems({ ...START, asOf: '2026-09-31', outstanding: [] }, on)).toEqual([day]);
    // FleetSuite's books start on January 1, 2025.
    const january = { ...START, firstMonth: '2025-01-01', outstanding: [] };
    expect(startProblems({ ...january, asOf: '2024-12-31' }, on)).toEqual([]);
    expect(startProblems({ ...january, asOf: '2024-12-30' }, on))
      .toEqual(["FleetSuite's books start on January 1, 2025, so reconciling January 2025 starts from December 31, 2024."]);
  });

  it('takes a balance either way to the cent, and each entry picked as not cleared once, from the books by then', () => {
    expect(startProblems({ ...START, balanceCents: -10_000_000_000 }, on)).toEqual([]);
    const balance = 'The starting balance needs an amount up to $100,000,000.00 either way, to the cent.';
    expect(startProblems({ ...START, balanceCents: 10_000_000_001 }, on)).toEqual([balance]);
    expect(startProblems({ ...START, balanceCents: 0.5 }, on)).toEqual([balance]);
    expect(startProblems({ ...START, outstanding: ['5001', '5001'] }, on)).toEqual(['An entry is picked twice as not cleared.']);
    expect(startProblems({ ...START, outstanding: ['5001', '5002'] }, on))
      .toEqual(["An entry picked as not cleared by September 30, 2026 isn't in the books by then."]);
    expect(startProblems({ ...START, outstanding: ['5001', '5002', '6000'] }, on))
      .toEqual(["2 entries picked as not cleared by September 30, 2026 aren't in the books by then."]);
    const many = Array.from({ length: MAX_OUTSTANDING + 1 }, () => '5001');
    expect(startProblems({ ...START, outstanding: many }, on))
      .toEqual(['Pick 500 entries at most as not cleared.', 'An entry is picked twice as not cleared.']);
    const checks = Array.from({ length: MAX_OUTSTANDING }, (_, i) => doc(String(7000 + i), '2026-09-15', -100, 'Check', String(2000 + i)));
    expect(startProblems({ ...START, outstanding: checks.map((d) => d.doc) }, { ...on, docs: [...DOCS, ...checks] })).toEqual([]);
    // One dated the day of the starting balance was in the books by then.
    expect(startProblems({ ...START, asOf: '2026-09-28' }, on)).toEqual([]);
    // A day that isn't one says so, and nothing about what was in the books by then.
    expect(startProblems({ ...START, asOf: '2026-09-31', outstanding: ['5002'] }, on))
      .toEqual(["The starting balance is the bank's on the last day of the statement before October 2026's, a day in September 2026."]);
  });

  it('holds the starting balance against the books less what had not cleared', () => {
    expect(startView(books())).toEqual({
      booksCents: 1805000, outstanding: [DOCS[1]], outstandingCents: -45000, apartCents: 0, missing: 0,
    });
    // Nothing picked: the books and the bank are the check apart.
    expect(startView(books({ start: { ...START, outstanding: [] } }))).toMatchObject({ booksCents: 1805000, outstandingCents: 0, apartCents: -45000 });
    // A picked entry gone from the books, or dated after the day now, isn't counted.
    expect(startView(books({ start: { ...START, outstanding: ['5001', '6000', '5002'] } }))).toMatchObject({ outstandingCents: -45000, missing: 2 });
    expect(startView(books({ docs: DOCS.slice(2) }))).toMatchObject({ booksCents: OPENING, outstanding: [], apartCents: -850000, missing: 1 });
  });
});

describe("a month's statement", () => {
  it('ends on a day in its month, with an ending balance either way to the cent', () => {
    expect(recProblems({ month: '2026-10-01', endsOn: '2026-10-31', endingCents: null })).toEqual([]);
    expect(recProblems({ month: '2026-10-01', endsOn: '2026-10-01', endingCents: -5 })).toEqual([]);
    expect(recProblems({ month: '2026-10-01', endsOn: '2026-11-01', endingCents: 0 })).toEqual(["The statement's last day isn't in October 2026."]);
    expect(recProblems({ month: '2026-10-01', endsOn: '2026-10-32', endingCents: 0 })).toEqual(["The statement's last day isn't in October 2026."]);
    expect(recProblems({ month: '2026-10-01', endsOn: '2026-10-31', endingCents: 10_000_000_001 }))
      .toEqual(['The ending balance needs an amount up to $100,000,000.00 either way, to the cent.']);
  });

  it("has the books' balance at a day's end, and the entries that can clear by then", () => {
    expect(balanceOn(books(), '2026-08-31')).toBe(OPENING);
    expect(balanceOn(books(), '2026-09-01')).toBe(1850000);
    expect(balanceOn(books(), '2026-10-31')).toBe(2001500);
    const docs = (rows: BankDoc[]) => rows.map((d) => d.doc);
    // Before reconciling starts, only the check picked as not cleared; after it, each by the day.
    expect(docs(openEntries(books(), '2026-10-01', '2026-10-31'))).toEqual(['5001', '5002', '5003', '5004']);
    // One dated the day of the starting balance cleared before it, unless it was picked.
    expect(docs(openEntries(books({ docs: [...DOCS, doc('7000', '2026-09-30', 100)] }), '2026-10-01', '2026-10-31')))
      .toEqual(['5001', '5002', '5003', '5004']);
    // On the same day, by number as numbers, then by entry.
    const sameDay = [doc('7003', '2026-10-10', -100, 'Check', '1010'), doc('7002', '2026-10-10', -100, 'Check', '999'), doc('7001', '2026-10-10', -100, 'Check', '999')];
    expect(docs(openEntries(books({ docs: sameDay }), '2026-10-01', '2026-10-31'))).toEqual(['7001', '7002', '7003']);
    expect(docs(openEntries(books(), '2026-10-01', '2026-10-04'))).toEqual(['5001', '5002']);
    // Cleared on October, it isn't November's; ticked on November, it's still November's.
    const b = books({ ...OCTOBER_DONE, ticks: [...OCTOBER_DONE.ticks!, tick('5005', '2026-11-01', 850000)] });
    expect(docs(openEntries(b, '2026-11-01', '2026-11-30'))).toEqual(['5004', '5005', TYPED]);
  });

  it('starts from where reconciling starts, else the month before once it is done', () => {
    expect(startingFor(books(), '2026-10-01')).toBe(1850000);
    expect(startingFor(books(), '2026-11-01')).toBeNull();
    expect(startingFor(books({ recs: [rec('2026-10-01', { endingCents: 2013500 })] }), '2026-11-01')).toBeNull();
    expect(startingFor(books(OCTOBER_DONE), '2026-11-01')).toBe(2013500);
  });

  it("is saved, else ends on the month's last day with nothing ticked", () => {
    expect(draftFor(books(), '2026-10-01')).toEqual({ month: '2026-10-01', endsOn: '2026-10-31', endingCents: null, ticked: new Set() });
    const saved = books({ recs: [rec('2026-10-01', { endsOn: '2026-10-28', endingCents: 5 })], ticks: [tick('5002', '2026-10-01', 850000)] });
    expect(draftFor(saved, '2026-10-01')).toEqual({ month: '2026-10-01', endsOn: '2026-10-28', endingCents: 5, ticked: new Set(['5002']) });
  });
});

describe('the month being reconciled', () => {
  const october = (ticked: string[], endingCents: number | null, endsOn = '2026-10-31') =>
    nextView(books(), { month: '2026-10-01', endsOn, endingCents, ticked: new Set(ticked) });

  it("adds up what's ticked from the starting balance, and holds it against the ending balance and the books", () => {
    const v = october(['5001', '5002', '5003'], 2013500);
    expect(v).toMatchObject({
      month: '2026-10-01', state: 'next', saved: null, endsOn: '2026-10-31', startingCents: 1850000, endingCents: 2013500,
      inCents: 850000, outCents: 686500, clearedCents: 2013500, differenceCents: 0,
      booksCents: 2001500, notClearedCents: -12000, tieCents: 0, changed: [], dropped: 0, events: [],
    });
    expect(v.items.map((i) => [i.doc, i.ticked])).toEqual([['5001', true], ['5002', true], ['5003', true], ['5004', false]]);
    expect(v.items[3]).toEqual({ ...DOCS[4], ticked: false });
    // A cent apart, and the books a cent off the bank.
    expect(october(['5001', '5002', '5003'], 2013499)).toMatchObject({ differenceCents: -1, tieCents: 1 });
    // Nothing typed yet.
    expect(october([], null)).toMatchObject({ inCents: 0, outCents: 0, clearedCents: 1850000, differenceCents: null, notClearedCents: 151500, tieCents: null });
    // A statement ending earlier leaves out what's dated after it.
    const early = october(['5001', '5002'], 2655000, '2026-10-04');
    expect(early).toMatchObject({ differenceCents: 0, booksCents: 2655000, notClearedCents: 0, tieCents: 0 });
    expect(early.items.map((i) => i.doc)).toEqual(['5001', '5002']);
  });

  it('has no starting balance, so no difference, until the month before is done', () => {
    const v = nextView(books(), { month: '2026-11-01', endsOn: '2026-11-30', endingCents: 2013500, ticked: new Set(['5005']) });
    expect(v).toMatchObject({ startingCents: null, inCents: 850000, clearedCents: null, differenceCents: null });
  });

  it('starts from the month before, and leaves out a tick saved on an entry it can no longer clear', () => {
    const b = books({
      ...OCTOBER_DONE,
      recs: [...OCTOBER_DONE.recs!, rec('2026-11-01', { endingCents: 2210000 })],
      ticks: [...OCTOBER_DONE.ticks!, tick('5004', '2026-11-01', -12000), tick('5005', '2026-11-01', 850000), tick('6000', '2026-11-01', 100)],
      events: [{ month: '2026-10-01', action: 'done', reason: null, by: 'Valarie', at: '2026-11-03T15:00:00Z' }],
    });
    const v = nextView(b, { ...draftFor(b, '2026-11-01'), ticked: new Set(['5004', '5005', TYPED, '6000']) });
    expect(v).toMatchObject({
      startingCents: 2013500, inCents: 850000, outCents: 653500, clearedCents: 2210000, differenceCents: 0, tieCents: 0, dropped: 1, events: [],
    });
    expect(v.saved).toEqual(b.recs[1]);
    expect(v.items.map((i) => i.doc)).toEqual(['5004', '5005', TYPED]);
  });
});

describe('each month', () => {
  const base = books({
    ...OCTOBER_DONE,
    recs: [...OCTOBER_DONE.recs!, rec('2026-11-01', { endingCents: 2210000 }), rec('2026-12-01', { endingCents: 1 })],
    ticks: [...OCTOBER_DONE.ticks!, tick('5005', '2026-11-01', 850000)],
    events: [
      { month: '2026-10-01', action: 'done', reason: null, by: 'Craig', at: '2026-11-02T15:00:00Z' },
      { month: '2026-10-01', action: 'undone', reason: 'Missed the fee', by: 'Craig', at: '2026-11-02T16:00:00Z' },
      { month: '2026-10-01', action: 'done', reason: null, by: 'Valarie', at: '2026-11-03T15:00:00Z' },
    ],
  });

  it('runs newest first: the months done, the one to reconcile, and those that wait for it', () => {
    const views = monthViews(base, '2027-01-01');
    expect(views.map((v) => [v.month, v.state])).toEqual([
      ['2027-01-01', 'later'], ['2026-12-01', 'later'], ['2026-11-01', 'next'], ['2026-10-01', 'done'],
    ]);
    expect(views[1]).toEqual({
      month: '2026-12-01', state: 'later', saved: base.recs[2], endsOn: '2026-12-31', startingCents: null, endingCents: 1,
      items: [], inCents: 0, outCents: 0, clearedCents: null, differenceCents: null, booksCents: null, notClearedCents: null, tieCents: null,
      changed: [], dropped: 0, events: [],
    });
    expect(views[0]).toMatchObject({ saved: null, endsOn: '2027-01-31', endingCents: null });
    expect(views[2]).toMatchObject({ startingCents: 2013500, inCents: 850000, outCents: 0, differenceCents: -653500 });
    expect(views[2].items.map((i) => [i.doc, i.ticked])).toEqual([['5004', false], ['5005', true], [TYPED, false]]);
    // Each month done through this one: none to reconcile.
    expect(monthViews(base, '2026-10-01').map((v) => v.state)).toEqual(['done']);
    expect(monthViews(books(), '2026-11-01').map((v) => [v.month, v.state])).toEqual([['2026-11-01', 'later'], ['2026-10-01', 'next']]);
  });

  it('shows a month done as it cleared, and each entry the books have changed since', () => {
    const october = monthViews(base, '2026-11-01')[1];
    expect(october).toMatchObject({
      state: 'done', saved: base.recs[0], startingCents: 1850000, endingCents: 2013500, inCents: 850000, outCents: 686500,
      clearedCents: 2013500, differenceCents: 0, booksCents: 2001500, notClearedCents: -12000, tieCents: 0, changed: [], dropped: 0,
    });
    expect(october.events.map((e) => e.action)).toEqual(['done', 'undone', 'done']);
    expect(october.items.map((i) => [i.doc, i.cents, i.ticked])).toEqual([['5001', -45000, true], ['5002', 850000, true], ['5003', -641500, true]]);

    // The mortgage payment is $10.00 more in the books now, and the rent gone from them.
    const docs = DOCS.filter((d) => d.doc !== '5002').map((d) => (d.doc === '5003' ? { ...d, cents: -642500 } : d));
    const changed = monthViews({ ...base, docs }, '2026-11-01')[1];
    expect(changed.changed).toEqual([
      { doc: '5002', number: 'NetSuite 5002', clearedCents: 850000, nowCents: 0 },
      { doc: '5003', number: 'JE5003', clearedCents: -641500, nowCents: -642500 },
    ]);
    expect(changed).toMatchObject({ differenceCents: 0, booksCents: 1150500, tieCents: -851000 });
    expect(changed.items[0]).toEqual({
      doc: '5002', date: '', type: 'No longer in the books', number: 'NetSuite 5002', name: null, memo: null, cents: 850000, ticked: true,
    });
    const typedGone = monthViews({ ...base, ticks: [...base.ticks, tick(TYPED, '2026-10-01', -1)], docs: DOCS.filter((d) => d.doc !== TYPED) }, '2026-11-01')[1];
    expect(typedGone.items[0]).toMatchObject({ doc: TYPED, number: 'FleetSuite entry', cents: -1 });
  });
});
