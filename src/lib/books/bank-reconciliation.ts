/**
 * 1084 Cool Springs' bank reconciliation, statement by statement (Books part
 * 62, docs/books.md "1084's bank reconciliation"; the NetSuite Exit
 * Checklist's "1084's monthly entries"). Each month's bank statement is held
 * against 1084's books: each entry on its bank account (the one Rent and
 * mortgage's setup picks) is ticked as it clears the bank, until the
 * statement's starting balance and what cleared come to its ending balance.
 * Then the month is done, and the next one starts from that ending balance.
 *
 * An entry is a document on the account as Reports' detail names it
 * (gl_books_account_documents, migrations 400 and 460): NetSuite's internal
 * id, or 'entry:<id>' for one only FleetSuite's journal has, with what it
 * comes to in FleetSuite's books, money in (a debit) positive.
 *
 * Where reconciling starts is the first month whose statement is reconciled
 * here and the bank's balance on the day before that statement starts. The
 * entries the books had by that day count as cleared already, but for those
 * picked as not cleared by then.
 *
 * The rules here are pure and client-safe; /api/admin/books/bank-reconciliation
 * and its page both use them, the page to show what the ticks come to as
 * they're made, the route to check what's saved.
 */

import { formatCents, isDay, MAX_LINE_CENTS } from '@/lib/typed-journal-entries';
import { FIRST_MONTH, monthBefore, monthName, monthsFrom } from './rent-and-mortgage';

export { formatCents, monthName };

/** An entry on the bank account, as FleetSuite's books have it. */
export interface BankDoc {
  /** NetSuite's internal id, or 'entry:<id>' for one only FleetSuite's journal has. */
  doc: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  /** What kind of document it is, as NetSuite names it: 'Deposit', 'Check', 'Journal'. */
  type: string;
  number: string;
  name: string | null;
  memo: string | null;
  /** Whole cents, money in (a debit) positive. */
  cents: number;
}

/** Where reconciling starts. */
export interface RecStart {
  /** The first month whose statement is reconciled here, 'YYYY-MM-01'. */
  firstMonth: string;
  /** The day the bank had balanceCents: the statement before's last day. */
  asOf: string;
  balanceCents: number;
  /** The entries the books had by asOf that hadn't cleared the bank then. */
  outstanding: string[];
}

/** A month's statement, as saved. */
export interface SavedRec {
  /** 'YYYY-MM-01'. */
  month: string;
  /** The statement's last day. */
  endsOn: string;
  endingCents: number | null;
  status: 'open' | 'done';
  updatedAt: string;
  updatedBy: string | null;
  doneAt: string | null;
  doneBy: string | null;
}

/** An entry that cleared on a month's statement, with what it came to in the books when it was ticked. */
export interface RecTick {
  doc: string;
  month: string;
  cents: number;
}

/** A month reconciled or undone. */
export interface RecEvent {
  month: string;
  action: 'done' | 'undone';
  reason: string | null;
  by: string | null;
  at: string;
}

/** Everything a reconciliation is worked out from. */
export interface RecBooks {
  start: RecStart;
  recs: readonly SavedRec[];
  ticks: readonly RecTick[];
  events: readonly RecEvent[];
  docs: readonly BankDoc[];
  /** The account's balance where FleetSuite's books start: NetSuite's at the end of 2024. */
  openingCents: number;
}

/** An entry's name as gl_books_account_documents gives it, and migration 493 keeps it. */
export const DOC_PATTERN = /^([0-9]{1,20}|entry:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The most entries picked as not cleared where reconciling starts, as migration 493 keeps them. */
export const MAX_OUTSTANDING = 500;

/** The longest reason for undoing a month, as migration 493 keeps it. */
export const REASON_MAX = 300;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'March 5, 2027'. */
export const longDate = (day: string) => `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}, ${day.slice(0, 4)}`;

/** The month's last day, 'YYYY-MM-DD'. */
export function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The month after, 'YYYY-MM-01'. */
export function monthAfter(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** The month to reconcile next: the one after the last one done, else the month reconciling starts with. */
export function nextMonth(start: Pick<RecStart, 'firstMonth'>, recs: readonly Pick<SavedRec, 'month' | 'status'>[]): string {
  const done = recs.filter((r) => r.status === 'done').map((r) => r.month).sort();
  return done.length ? monthAfter(done[done.length - 1]) : start.firstMonth;
}

const amountOk = (c: number) => Number.isSafeInteger(c) && Math.abs(c) <= MAX_LINE_CENTS;
const AMOUNT = `an amount up to ${formatCents(MAX_LINE_CENTS)} either way, to the cent`;

/**
 * Why where reconciling starts can't be kept: a month from January 2025
 * through this one, the day of its balance in the month before (December 31,
 * 2024 for January 2025, as FleetSuite's books start the day after), and each
 * entry picked as not cleared one the books had by then, once.
 */
export function startProblems(s: RecStart, on: { thisMonth: string; docs: readonly BankDoc[] }): string[] {
  const problems: string[] = [];
  const first = s.firstMonth;
  if (!isDay(first) || !first.endsWith('-01') || first < FIRST_MONTH || first > on.thisMonth) {
    problems.push(`Reconciling starts with a month from ${monthName(FIRST_MONTH)} through ${monthName(on.thisMonth)}.`);
  } else {
    const before = monthBefore(first);
    if (!isDay(s.asOf) || s.asOf.slice(0, 7) !== before.slice(0, 7)) {
      problems.push(`The starting balance is the bank's on the last day of the statement before ${monthName(first)}'s, a day in ${monthName(before)}.`);
    } else if (first === FIRST_MONTH && s.asOf !== lastDay(before)) {
      problems.push(`FleetSuite's books start on ${longDate(FIRST_MONTH)}, so reconciling ${monthName(FIRST_MONTH)} starts from ${longDate(lastDay(before))}.`);
    }
  }
  if (!amountOk(s.balanceCents)) problems.push(`The starting balance needs ${AMOUNT}.`);
  if (s.outstanding.length > MAX_OUTSTANDING) problems.push(`Pick ${MAX_OUTSTANDING} entries at most as not cleared.`);
  if (new Set(s.outstanding).size !== s.outstanding.length) problems.push('An entry is picked twice as not cleared.');
  const had = new Set(on.docs.filter((d) => d.date <= s.asOf).map((d) => d.doc));
  const notHad = s.outstanding.filter((doc) => !had.has(doc)).length;
  if (notHad && isDay(s.asOf)) {
    problems.push(`${notHad === 1 ? 'An entry' : `${notHad} entries`} picked as not cleared by ${longDate(s.asOf)} `
      + `${notHad === 1 ? "isn't" : "aren't"} in the books by then.`);
  }
  return problems;
}

/** Why a month's statement can't be saved: its last day in the month, and its ending balance to the cent. */
export function recProblems(r: { month: string; endsOn: string; endingCents: number | null }): string[] {
  const problems: string[] = [];
  if (!isDay(r.endsOn) || r.endsOn.slice(0, 7) !== r.month.slice(0, 7)) problems.push(`The statement's last day isn't in ${monthName(r.month)}.`);
  if (r.endingCents !== null && !amountOk(r.endingCents)) problems.push(`The ending balance needs ${AMOUNT}.`);
  return problems;
}

// ── What the books have ─────────────────────────────────────────────────────

/** The books' balance at the end of a day: where they start, and each entry dated by then. */
export function balanceOn(b: Pick<RecBooks, 'docs' | 'openingCents'>, day: string): number {
  return b.docs.reduce((sum, d) => (d.date <= day ? sum + d.cents : sum), b.openingCents);
}

const byDate = (a: BankDoc, b: BankDoc) =>
  a.date.localeCompare(b.date) || a.number.localeCompare(b.number, 'en', { numeric: true }) || a.doc.localeCompare(b.doc);

/**
 * The entries that can clear on a month's statement ending on endsOn, by
 * date: each the books have by then that didn't clear on a month before.
 * One the books had by where reconciling starts cleared before it, unless
 * it was picked as not cleared then.
 */
export function openEntries(b: Pick<RecBooks, 'start' | 'ticks' | 'docs'>, month: string, endsOn: string): BankDoc[] {
  const cleared = new Set(b.ticks.filter((t) => t.month < month).map((t) => t.doc));
  const outstanding = new Set(b.start.outstanding);
  return b.docs
    .filter((d) => d.date <= endsOn && !cleared.has(d.doc) && (d.date > b.start.asOf || outstanding.has(d.doc)))
    .sort(byDate);
}

/** Where reconciling starts, held against the books. */
export interface StartView {
  /** The books' balance on the day of the starting balance. */
  booksCents: number;
  /** The entries picked as not cleared by then, as the books have them now. */
  outstanding: BankDoc[];
  outstandingCents: number;
  /** The books less what hadn't cleared, less the bank's balance: $0 when they tie. */
  apartCents: number;
  /** Picked as not cleared, but not in the books by then now. */
  missing: number;
}

export function startView(b: Pick<RecBooks, 'start' | 'docs' | 'openingCents'>): StartView {
  const { start } = b;
  const picked = new Set(start.outstanding);
  const outstanding = b.docs.filter((d) => picked.has(d.doc) && d.date <= start.asOf).sort(byDate);
  const booksCents = balanceOn(b, start.asOf);
  const outstandingCents = outstanding.reduce((sum, d) => sum + d.cents, 0);
  return {
    booksCents,
    outstanding,
    outstandingCents,
    apartCents: booksCents - outstandingCents - start.balanceCents,
    missing: picked.size - outstanding.length,
  };
}

// ── Each month ──────────────────────────────────────────────────────────────

/** done: reconciled; next: the one to reconcile now; later: waits for the one before it. */
export type RecState = 'done' | 'next' | 'later';

/** An entry on a month's statement: ticked when it cleared on it. */
export interface RecItem extends BankDoc {
  ticked: boolean;
}

/** An entry that cleared on a month done whose amount in the books isn't what cleared any more. */
export interface ChangedEntry {
  doc: string;
  number: string;
  /** What it came to when it cleared. */
  clearedCents: number;
  /** What the books have now: $0 when it's gone from them. */
  nowCents: number;
}

export interface MonthView {
  month: string;
  state: RecState;
  saved: SavedRec | null;
  endsOn: string;
  /** The bank's balance at the statement's start: the month before's ending balance, or where reconciling starts. */
  startingCents: number | null;
  endingCents: number | null;
  /** next: each entry that can clear on it; done: the ones that cleared, as they were then; later: none. */
  items: RecItem[];
  /** What's ticked: money in, and money out, each $0 or more. */
  inCents: number;
  outCents: number;
  /** The starting balance with what's ticked. */
  clearedCents: number | null;
  /** The ending balance less what cleared: $0 when the month's reconciled. */
  differenceCents: number | null;
  /** The books' balance at the statement's last day. */
  booksCents: number | null;
  /** What the books have by then that hasn't cleared. */
  notClearedCents: number | null;
  /** The books less what hasn't cleared, less the ending balance: $0 when the books tie to the bank. */
  tieCents: number | null;
  changed: ChangedEntry[];
  /** Entries ticked on it before that it can't clear now: gone from the books, or dated after it. */
  dropped: number;
  events: RecEvent[];
}

/** How a month being ticked stands, as it's typed. */
export interface RecDraft {
  month: string;
  endsOn: string;
  endingCents: number | null;
  ticked: ReadonlySet<string>;
}

/** The bank's balance at the start of a month's statement, or null until the month before is done. */
export function startingFor(b: Pick<RecBooks, 'start' | 'recs'>, month: string): number | null {
  if (month === b.start.firstMonth) return b.start.balanceCents;
  const before = b.recs.find((r) => r.month === monthBefore(month));
  return before?.status === 'done' ? before.endingCents : null;
}

/** The month's statement as saved, else its last day with no ending balance and nothing ticked. */
export function draftFor(b: Pick<RecBooks, 'recs' | 'ticks'>, month: string): RecDraft {
  const saved = b.recs.find((r) => r.month === month);
  return {
    month,
    endsOn: saved?.endsOn ?? lastDay(month),
    endingCents: saved?.endingCents ?? null,
    ticked: new Set(b.ticks.filter((t) => t.month === month).map((t) => t.doc)),
  };
}

function figures(items: readonly RecItem[], startingCents: number | null, endingCents: number | null) {
  const ticked = items.filter((i) => i.ticked);
  const inCents = ticked.reduce((sum, i) => (i.cents > 0 ? sum + i.cents : sum), 0);
  const outCents = ticked.reduce((sum, i) => (i.cents < 0 ? sum - i.cents : sum), 0);
  const clearedCents = startingCents === null ? null : startingCents + inCents - outCents;
  return {
    inCents,
    outCents,
    clearedCents,
    differenceCents: endingCents === null || clearedCents === null ? null : endingCents - clearedCents,
  };
}

const eventsOf = (b: Pick<RecBooks, 'events'>, month: string) => b.events.filter((e) => e.month === month);

/** The month to reconcile now, as it's being ticked: each entry with what the books have for it now. */
export function nextView(b: RecBooks, draft: RecDraft): MonthView {
  const open = openEntries(b, draft.month, draft.endsOn);
  const items = open.map((d) => ({ ...d, ticked: draft.ticked.has(d.doc) }));
  const startingCents = startingFor(b, draft.month);
  const booksCents = balanceOn(b, draft.endsOn);
  const notClearedCents = items.reduce((sum, i) => (i.ticked ? sum : sum + i.cents), 0);
  const openDocs = new Set(open.map((d) => d.doc));
  return {
    month: draft.month,
    state: 'next',
    saved: b.recs.find((r) => r.month === draft.month) ?? null,
    endsOn: draft.endsOn,
    startingCents,
    endingCents: draft.endingCents,
    items,
    ...figures(items, startingCents, draft.endingCents),
    booksCents,
    notClearedCents,
    tieCents: draft.endingCents === null ? null : booksCents - notClearedCents - draft.endingCents,
    changed: [],
    dropped: b.ticks.filter((t) => t.month === draft.month && !openDocs.has(t.doc)).length,
    events: eventsOf(b, draft.month),
  };
}

/** What's left of an entry that's gone from the books: its name. */
const goneEntry = (doc: string): BankDoc => ({
  doc, date: '', type: 'No longer in the books', number: doc.startsWith('entry:') ? 'FleetSuite entry' : `NetSuite ${doc}`,
  name: null, memo: null, cents: 0,
});

/** A month done: what cleared on it as it was then, held against the books as they are now. */
function doneView(b: RecBooks, saved: SavedRec): MonthView {
  const docs = new Map(b.docs.map((d) => [d.doc, d]));
  const cleared = b.ticks.filter((t) => t.month === saved.month);
  const items = cleared
    .map((t) => ({ ...(docs.get(t.doc) ?? goneEntry(t.doc)), cents: t.cents, ticked: true }))
    .sort(byDate);
  const startingCents = startingFor(b, saved.month);
  const booksCents = balanceOn(b, saved.endsOn);
  const clearedHere = new Set(cleared.map((t) => t.doc));
  const notClearedCents = openEntries(b, saved.month, saved.endsOn)
    .reduce((sum, d) => (clearedHere.has(d.doc) ? sum : sum + d.cents), 0);
  return {
    month: saved.month,
    state: 'done',
    saved,
    endsOn: saved.endsOn,
    startingCents,
    endingCents: saved.endingCents,
    items,
    ...figures(items, startingCents, saved.endingCents),
    booksCents,
    notClearedCents,
    tieCents: saved.endingCents === null ? null : booksCents - notClearedCents - saved.endingCents,
    changed: items
      .map((i) => ({ doc: i.doc, number: i.number, clearedCents: i.cents, nowCents: docs.get(i.doc)?.cents ?? 0 }))
      .filter((c) => c.nowCents !== c.clearedCents),
    dropped: 0,
    events: eventsOf(b, saved.month),
  };
}

/** A month that waits for the one before it. */
function laterView(b: RecBooks, month: string): MonthView {
  const saved = b.recs.find((r) => r.month === month) ?? null;
  return {
    month, state: 'later', saved, endsOn: saved?.endsOn ?? lastDay(month), startingCents: null, endingCents: saved?.endingCents ?? null,
    items: [], inCents: 0, outCents: 0, clearedCents: null, differenceCents: null, booksCents: null, notClearedCents: null, tieCents: null,
    changed: [], dropped: 0, events: eventsOf(b, month),
  };
}

/** Each month from the one reconciling starts with through this one, newest first. */
export function monthViews(b: RecBooks, thisMonth: string): MonthView[] {
  const next = nextMonth(b.start, b.recs);
  return monthsFrom(b.start.firstMonth, thisMonth).reverse().map((month) => {
    const saved = b.recs.find((r) => r.month === month);
    if (saved?.status === 'done') return doneView(b, saved);
    if (month === next) return nextView(b, draftFor(b, month));
    return laterView(b, month);
  });
}
