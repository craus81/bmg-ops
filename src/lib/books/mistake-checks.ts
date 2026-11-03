import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { centralDate } from '@/lib/central-day';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { BOOKS_COMPANIES, type BooksCompany } from './journal';
import { centsToString, COPY_FROM, toCents } from './netsuite-gl';
import { BOOKS_BILLS_SYNC } from './netsuite-bills';
import { BOOKS_GL_SYNC } from './netsuite-gl';
import { BOOKS_SPENDING_SYNC } from './netsuite-spending';

/**
 * Mistake checks (owner decision 2026-10-24, thread "Replacing NetSuite with
 * FleetSuite", "Mistake checks"; migration 431, docs/books.md "Mistake
 * checks"): each night Books looks through the bills, checks and card charges
 * it copies from NetSuite (migrations 384 and 391), their bill credits and
 * card refunds, and NetSuite's journal entries from the copy of its general
 * ledger (migrations 361 and 516), for likely mistakes, and lists each one
 * with why, for a super admin to clear.
 *
 *   * Entered twice: two bills from one vendor with the same amount and the
 *     same invoice number (NetSuite's Reference No.); a bill and a check or
 *     card charge for the same vendor and amount a few days apart, which can
 *     be one purchase entered both ways; or two checks or card charges for the
 *     same payee and amount on the same day. Bill credits and card refunds the
 *     same way among themselves, never against a charge: a credit for a bill's
 *     amount is a return. Two journal entries with the same lines a few days
 *     apart, unless another entry undoes one of them.
 *   * Far off usual: an amount ten times, or a tenth of, what a vendor's
 *     steady charges have been, which can be a slipped decimal point, or more
 *     than twice the most the vendor has billed; a bill credit for more than
 *     the vendor billed in the year before it; a journal entry ten times, or a
 *     tenth of, what the entries to the same accounts have steadily been.
 *   * Monthly charge missing: a vendor who has billed every month for six
 *     months hasn't billed this month, a week past their usual day.
 *   * Odd account: an expense line of a charge or credit coded to an account
 *     a vendor's earlier documents never used, when they've used no more than
 *     three.
 *
 * It flags what's dated from LOOK_FROM, so the first list is short, and works
 * out what's usual for a vendor from everything the copies hold, since
 * January 2025. Voided documents aren't looked at.
 * Clearing one as fine can teach the check: an account is fine for a vendor,
 * or a monthly charge isn't watched. One cleared as fixed in NetSuite comes
 * back if the check still finds it once the copies have the fix; one the
 * copies no longer show clears on its own, saying what changed.
 *
 * The look runs at 09:46 UTC (/api/cron/books-mistake-checks), after the
 * copies of NetSuite's ledger (:26 on odd hours), checks and card charges
 * (:33) and bills (:39), and before the daily check (:58), which tells the
 * super admins about new ones. It's recorded in sync_state as
 * 'books_mistake_checks'. Nothing is written to NetSuite or to the books.
 */

export const BOOKS_MISTAKE_CHECKS = 'books_mistake_checks';

/** What's dated from here is flagged (owner decision 2026-10-24: a short first list). */
export const LOOK_FROM = '2026-09-01';
/** What's usual for a vendor comes from everything the copies hold. */
export const USUAL_FROM = COPY_FROM;

/** A bill and a check or card charge this many days apart, or fewer, can be one purchase entered both ways. */
export const BOTH_WAYS_DAYS = 7;
/** Two checks or card charges on the same day smaller than this aren't flagged: tolls and parking. */
export const SAME_DAY_MIN_CENTS = 2_500;
/** Two journal entries with the same lines this many days apart, or fewer, can be one entered twice: under a week, so weekly ones never are. */
export const JOURNAL_TWICE_DAYS = 6;
/** A vendor's amounts are known once it has this many earlier documents. */
export const FAR_OFF_HISTORY = 6;
/** The most of a vendor's latest documents a slipped decimal point is measured against. */
export const STEADY_WINDOW = 12;
/** Charges within this share of their middle one are steady. */
export const STEADY_SPREAD = 0.05;
/** A slipped decimal point is flagged when the larger amount is at least this. */
export const SLIP_MIN_CENTS = 10_000;
/** More than twice the most a vendor has billed is flagged from this amount. */
export const FAR_OFF_MIN_CENTS = 50_000;
/** A bill credit for more than the vendor billed in the year before it is flagged from this amount. */
export const CREDIT_MIN_CENTS = 10_000;
/** A vendor has a monthly charge once it has billed in each of this many months in a row. */
export const MONTHS_IN_A_ROW = 6;
/** Days past a monthly charge's usual day before it's missing. */
export const GRACE_DAYS = 7;
/** A vendor's accounts are known once this many of its earlier documents have expense lines. */
export const ODD_HISTORY = 5;
/** A vendor coded to more accounts than this has no odd one. */
export const ODD_MOST_ACCOUNTS = 3;

export type MistakeKind = 'twice' | 'far_off' | 'missing' | 'odd_account';
/** The list's order: the likeliest kind of mistake first. */
export const MISTAKE_KINDS: readonly MistakeKind[] = ['twice', 'far_off', 'missing', 'odd_account'];

export type MistakeDocType = 'VendBill' | 'VendCred' | 'Check' | 'CardChrg' | 'CardRfnd' | 'Journal';
/** Money going out. */
const CHARGES: ReadonlySet<MistakeDocType> = new Set<MistakeDocType>(['VendBill', 'Check', 'CardChrg']);
/** Money a vendor gives back: bill credits and card refunds. */
const CREDITS: ReadonlySet<MistakeDocType> = new Set<MistakeDocType>(['VendCred', 'CardRfnd']);
/** What a vendor's documents are: charges and credits. */
const PARTY_DOCS: ReadonlySet<MistakeDocType> = new Set<MistakeDocType>([...CHARGES, ...CREDITS]);

/** One line of a NetSuite journal entry, as gl_mistake_journal_entries gives it (migration 516). */
export interface JournalLine {
  /** The company it posts to, by code. */
  company: string;
  /** The account, by NetSuite's id. */
  account: string;
  /** NetSuite's id for the line's name; null when it has none. */
  entity: string | null;
  debit: string;
  credit: string;
}

/** One copied document, as gl_mistake_docs gives it. */
export interface MistakeDoc {
  netsuite_id: string;
  type: MistakeDocType;
  /** NetSuite's tranid: a bill's Reference No., the vendor's invoice number; a check's number. */
  number: string | null;
  date: string;
  /** The vendor or payee, by NetSuite's id. */
  party: string | null;
  name: string | null;
  total: string;
  voided: boolean;
  /** The companies its GL lines post to; none until the copy of NetSuite's ledger has it. */
  companies: string[];
  /** The accounts its expense lines are coded to. */
  accounts: string[];
  lines_known: boolean;
  /** A journal entry's lines; none on the other documents. */
  journal?: JournalLine[];
}

/** A document an item is about, as the page links it. */
export interface MistakeDocRef {
  netsuite_id: string;
  type: MistakeDocType;
  number: string | null;
  date: string;
  total: string;
  label: string;
}

/** What clearing an item as fine can teach the check: accounts fine for a vendor, or a monthly charge not watched. */
export type MistakeLearn = { party: string; accounts: string[] } | { party: string; company: BooksCompany };

/** One likely mistake a look found, as gl_mistake_checks_save takes it. */
export interface Finding {
  key: string;
  kind: MistakeKind;
  company: BooksCompany;
  party: string | null;
  party_name: string | null;
  /** The document's date; for a monthly charge missing, the first of the month. */
  date: string;
  /** The amount, or about what the missing charge comes to. */
  amount: string | null;
  /** How likely a mistake next to others of its kind, the likeliest highest. */
  strength: number;
  why: string;
  docs: MistakeDocRef[];
  learn?: MistakeLearn;
}

/** An item the check keeps (gl_mistake_checks), as the next look reads it. */
export interface KeptItem {
  key: string;
  kind: MistakeKind;
  company: BooksCompany;
  party: string | null;
  party_name: string | null;
  date: string;
  amount: string | null;
  strength: number;
  why: string;
  docs: MistakeDocRef[];
  learn: MistakeLearn | null;
  state: 'open' | 'cleared';
  how: 'fixed' | 'fine' | 'gone' | null;
  learned: boolean;
}

/** What clearing items as fine has taught the check. */
export interface Learned {
  /** Accounts fine for a vendor, by the vendor's NetSuite id. */
  accounts: Map<string, Set<string>>;
  /** Monthly charges not watched, as `<company>|<vendor>`. */
  unwatched: Set<string>;
}

// ── Words ──────────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents: number) => money.format(cents / 100);
const dayText = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1].slice(0, 3)} ${Number(iso.slice(8, 10))}`;
const monthName = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1];
const monthYear = (iso: string) => `${monthName(iso)} ${iso.slice(0, 4)}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** 1st, 2nd, 3rd, 4th, 11th, 21st. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const end = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${end}`;
}

const listed = (items: string[], last: 'and' | 'or') =>
  (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`);

const NOUNS: Record<MistakeDocType, [string, string]> = {
  VendBill: ['bill', 'bills'],
  VendCred: ['bill credit', 'bill credits'],
  Check: ['check', 'checks'],
  CardChrg: ['card charge', 'card charges'],
  CardRfnd: ['card refund', 'card refunds'],
  Journal: ['journal entry', 'journal entries'],
};

/** What some documents are called together: "bills", "card charges", "bills, checks and card charges". */
function nounsOf(docs: Array<{ type: MistakeDocType }>): string {
  const types = new Set(docs.map((d) => d.type));
  return listed((Object.keys(NOUNS) as MistakeDocType[]).filter((t) => types.has(t)).map((t) => NOUNS[t][1]), 'and');
}

/** How a document is named on the page: 'Bill INV-20931, Oct 3', 'Card charge, Oct 16'. */
export function docLabel(d: { type: MistakeDocType; number: string | null; date: string }): string {
  return `${cap(NOUNS[d.type][0])}${d.number ? ` ${d.number}` : ''}, ${dayText(d.date)}`;
}

const refOf = (d: MistakeDoc, prefix = ''): MistakeDocRef =>
  ({ netsuite_id: d.netsuite_id, type: d.type, number: d.number, date: d.date, total: centsToString(toCents(d.total)), label: `${prefix}${docLabel(d)}` });

const TIMES = ['', 'once', 'twice', 'three times', 'four times', 'five times', 'six times', 'seven times', 'eight times', 'nine times', 'ten times', 'eleven times', 'twelve times'];
const times = (n: number) => TIMES[n] ?? `${n} times`;

// ── Dates ──────────────────────────────────────────────────────────────────

const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
const daysApart = (a: string, b: string) => Math.abs(dayNumber(a) - dayNumber(b));
const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`;

/** 'YYYY-MM-01' n months on (or back, when n is negative). */
export function addMonths(month: string, n: number): string {
  const at = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, '0')}-01`;
}

// ── Numbers ────────────────────────────────────────────────────────────────

/** The middle of some amounts: the lower of the middle two when there's an even number of them. */
function middle(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Earlier first: by date, then by NetSuite's id. */
const byDate = (a: MistakeDoc, b: MistakeDoc) => a.date.localeCompare(b.date) || Number(a.netsuite_id) - Number(b.netsuite_id);

/** The documents of some types each vendor or payee has, earlier first, voided ones left out: their charges, unless said. */
function byParty(docs: MistakeDoc[], types: ReadonlySet<MistakeDocType> = CHARGES): Map<string, MistakeDoc[]> {
  const out = new Map<string, MistakeDoc[]>();
  for (const d of docs) {
    if (!d.party || d.voided || !types.has(d.type)) continue;
    const list = out.get(d.party) ?? [];
    list.push(d);
    out.set(d.party, list);
  }
  for (const list of out.values()) list.sort(byDate);
  return out;
}

/**
 * The company an item about a document is for: the first of the books' companies its GL lines post to, else the
 * company most of its vendor's documents post to, else the first company.
 */
export function companyPicker(docs: MistakeDoc[]): (d: MistakeDoc) => BooksCompany {
  const counts = new Map<string, Map<BooksCompany, number>>();
  for (const d of docs) {
    if (!d.party) continue;
    for (const c of BOOKS_COMPANIES) {
      if (!d.companies.includes(c)) continue;
      const of = counts.get(d.party) ?? new Map<BooksCompany, number>();
      of.set(c, (of.get(c) ?? 0) + 1);
      counts.set(d.party, of);
    }
  }
  return (d) => {
    for (const c of BOOKS_COMPANIES) if (d.companies.includes(c)) return c;
    const of = d.party ? counts.get(d.party) : undefined;
    if (of) return [...BOOKS_COMPANIES].sort((a, b) => (of.get(b) ?? 0) - (of.get(a) ?? 0))[0];
    return BOOKS_COMPANIES[0];
  };
}

// ── Entered twice ──────────────────────────────────────────────────────────

/** An invoice number as two people might type it: letters and digits only, in capitals. */
const sameNumber = (n: string | null) => (n ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The two sides entered twice is looked for on, never one against the other, since a credit for a bill's amount is a
 * return: money going out, and money a vendor gives back, each with its bill-like document and what two of its others
 * on one day can also be.
 */
const TWICE_SIDES: ReadonlyArray<{ types: ReadonlySet<MistakeDocType>; bill: MistakeDocType; number: string; two: string }> = [
  { types: CHARGES, bill: 'VendBill', number: 'invoice number', two: 'two purchases' },
  { types: CREDITS, bill: 'VendCred', number: 'number', two: 'two refunds' },
];

/**
 * Pairs of documents that look like one entered twice, the likeliest first: two bills with the same vendor, amount and
 * invoice number; a bill and a check or card charge for the same vendor and amount within BOTH_WAYS_DAYS; two checks or
 * card charges for the same payee and amount on the same day (three or more on a day read as purchases). Bill credits
 * and card refunds the same way among themselves. A pair is flagged when either is dated from LOOK_FROM.
 */
export function findTwice(docs: MistakeDoc[], companyOf: (d: MistakeDoc) => BooksCompany): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const flag = (a: MistakeDoc, b: MistakeDoc, strength: number, why: string) => {
    const [earlier, later] = [a, b].sort(byDate);
    if (later.date < LOOK_FROM) return;
    const ids = [a.netsuite_id, b.netsuite_id].sort((x, y) => Number(x) - Number(y));
    const key = `twice:${ids[0]}+${ids[1]}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      key, kind: 'twice', company: companyOf(later), party: later.party, party_name: later.name ?? earlier.name,
      date: later.date, amount: centsToString(toCents(later.total)), strength, why, docs: [refOf(earlier), refOf(later)],
    });
  };
  const groups = <K>(list: MistakeDoc[], keyOf: (d: MistakeDoc) => K | null) => {
    const map = new Map<K, MistakeDoc[]>();
    for (const d of list) {
      const k = keyOf(d);
      if (k === null) continue;
      map.set(k, [...(map.get(k) ?? []), d]);
    }
    return map;
  };
  for (const side of TWICE_SIDES) {
    const live = docs.filter((d) => d.party && !d.voided && side.types.has(d.type) && toCents(d.total) > 0);
    const bills = live.filter((d) => d.type === side.bill);
    const spending = live.filter((d) => d.type !== side.bill);

    for (const group of groups(bills, (d) => (sameNumber(d.number) ? `${d.party}|${toCents(d.total)}|${sameNumber(d.number)}` : null)).values()) {
      group.sort(byDate);
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const [a, b] = [group[i], group[j]];
          const when = a.date === b.date ? `, both dated ${dayText(a.date)}` : `: one dated ${dayText(a.date)}, the other ${dayText(b.date)}`;
          flag(a, b, 3, `Two ${NOUNS[side.bill][1]} with the same amount and the same ${side.number}, ${a.number}${when}.`);
        }
      }
    }

    const spendingBy = groups(spending, (d) => `${d.party}|${toCents(d.total)}`);
    for (const bill of bills) {
      for (const s of spendingBy.get(`${bill.party}|${toCents(bill.total)}`) ?? []) {
        const apart = daysApart(bill.date, s.date);
        if (apart > BOTH_WAYS_DAYS) continue;
        const gap = apart === 0 ? 'on the same day' : apart === 1 ? 'a day apart' : `${apart} days apart`;
        flag(bill, s, 2, `A ${NOUNS[bill.type][0]} and a ${NOUNS[s.type][0]} for the same amount, ${gap}. It may have been entered both ways.`);
      }
    }

    const sameDay = groups(spending, (d) => (toCents(d.total) >= SAME_DAY_MIN_CENTS ? `${d.party}|${toCents(d.total)}|${d.date}` : null));
    for (const group of sameDay.values()) {
      if (group.length !== 2) continue;
      const [a, b] = group;
      const what = a.type === b.type ? `Two ${NOUNS[a.type][1]}` : `A ${NOUNS[a.type][0]} and a ${NOUNS[b.type][0]}`;
      flag(a, b, 1, `${what} for the same amount on the same day. It may be one entered twice, or ${side.two}.`);
    }
  }
  return out;
}

// ── Journal entries ────────────────────────────────────────────────────────

const moves = (l: JournalLine) => toCents(l.debit) !== 0 || toCents(l.credit) !== 0;

/**
 * A journal entry's lines that move money, in one string the same for two entries with the same lines in any order:
 * company, account, name, debit and credit of each. Turned, every debit is a credit and every credit a debit.
 */
export function journalShape(d: Pick<MistakeDoc, 'journal'>, turned = false): string {
  return (d.journal ?? [])
    .filter(moves)
    .map((l) => {
      const [debit, credit] = turned ? [l.credit, l.debit] : [l.debit, l.credit];
      return `${l.company}|${l.account}|${l.entity ?? ''}|${toCents(debit)}|${toCents(credit)}`;
    })
    .sort()
    .join(';');
}

/**
 * Journal entries that undo each other: one with the lines of an earlier one turned, every debit a credit, as a
 * reversing entry or a void by reversing entry is, takes the latest earlier one with those lines no other has taken.
 * Each of the two, by NetSuite's id, gives the other. The checks leave both out.
 */
export function journalReversals(docs: MistakeDoc[]): Map<string, MistakeDoc> {
  const journals = docs.filter((d) => d.type === 'Journal' && journalShape(d)).sort(byDate);
  const waiting = new Map<string, MistakeDoc[]>(); // lines → earlier entries no other has undone, earlier first
  const out = new Map<string, MistakeDoc>();
  for (const d of journals) {
    const shape = journalShape(d);
    const turned = journalShape(d, true);
    const undone = turned === shape ? undefined : waiting.get(turned)?.pop();
    if (undone) {
      out.set(undone.netsuite_id, d);
      out.set(d.netsuite_id, undone);
      continue;
    }
    waiting.set(shape, [...(waiting.get(shape) ?? []), d]);
  }
  return out;
}

/** The journal entries the checks look at: those with lines that move money, that no other entry undoes. */
function liveJournals(docs: MistakeDoc[]): MistakeDoc[] {
  const undone = journalReversals(docs);
  return docs.filter((d) => d.type === 'Journal' && !undone.has(d.netsuite_id) && journalShape(d)).sort(byDate);
}

/**
 * Pairs of journal entries that look like one entered twice: the same lines (company, account, name, debit and credit
 * of each), dated within JOURNAL_TWICE_DAYS of each other, when there are just the two (three or more that close read as
 * a routine). An entry another undoes isn't looked at, so reversing the extra one clears it. A pair is flagged when
 * either is dated from LOOK_FROM.
 */
export function findJournalTwice(docs: MistakeDoc[], companyOf: (d: MistakeDoc) => BooksCompany): Finding[] {
  const same = new Map<string, MistakeDoc[]>();
  for (const d of liveJournals(docs)) same.set(journalShape(d), [...(same.get(journalShape(d)) ?? []), d]);
  const out: Finding[] = [];
  for (const list of same.values()) {
    // Runs of entries each within JOURNAL_TWICE_DAYS of the one before.
    const runs: MistakeDoc[][] = [];
    list.forEach((d, i) => {
      if (i > 0 && daysApart(list[i - 1].date, d.date) <= JOURNAL_TWICE_DAYS) runs[runs.length - 1].push(d);
      else runs.push([d]);
    });
    for (const run of runs) {
      if (run.length !== 2) continue;
      const [a, b] = run;
      if (b.date < LOOK_FROM) continue;
      const when = a.date === b.date ? `, both dated ${dayText(a.date)}` : `: one dated ${dayText(a.date)}, the other ${dayText(b.date)}`;
      const ids = [a.netsuite_id, b.netsuite_id].sort((x, y) => Number(x) - Number(y));
      out.push({
        key: `twice:${ids[0]}+${ids[1]}`, kind: 'twice', company: companyOf(b), party: null, party_name: null,
        date: b.date, amount: centsToString(toCents(b.total)), strength: 2, docs: [refOf(a), refOf(b)],
        why: `Two journal entries with the same lines, to the same accounts for the same amounts${when}. It may be one entered twice.`,
      });
    }
  }
  return out;
}

// ── Far off usual ──────────────────────────────────────────────────────────

/** A vendor's latest documents when they're steady: at least FAR_OFF_HISTORY of them, each within STEADY_SPREAD of their middle. */
function steadyRun(earlier: MistakeDoc[]): { docs: MistakeDoc[]; middle: number; same: boolean } | null {
  for (let n = Math.min(STEADY_WINDOW, earlier.length); n >= FAR_OFF_HISTORY; n--) {
    const docs = earlier.slice(-n);
    const cents = docs.map((d) => toCents(d.total));
    const mid = middle(cents);
    if (mid > 0 && cents.every((c) => Math.abs(c - mid) <= mid * STEADY_SPREAD)) return { docs, middle: mid, same: cents.every((c) => c === mid) };
  }
  return null;
}

/** How an amount is a slipped decimal point next to a steady one: 'ten times that' or 'a tenth of that', the larger from SLIP_MIN_CENTS; null when it isn't. */
function slipOf(cents: number, steady: number): string | null {
  const ratio = cents / steady;
  return ratio >= 9.5 && ratio <= 10.5 && cents >= SLIP_MIN_CENTS ? 'ten times that'
    : ratio >= 0.095 && ratio <= 0.105 && steady >= SLIP_MIN_CENTS ? 'a tenth of that' : null;
}

/**
 * Documents dated from LOOK_FROM whose amount is far off what their vendor's earlier ones were: ten times, or a tenth
 * of, a run of steady charges (a slipped decimal point, the likelier), or more than twice the most the vendor has
 * billed, from FAR_OFF_MIN_CENTS.
 */
export function findFarOff(docs: MistakeDoc[], companyOf: (d: MistakeDoc) => BooksCompany): Finding[] {
  const out: Finding[] = [];
  for (const list of byParty(docs).values()) {
    list.forEach((d, i) => {
      if (d.date < LOOK_FROM || i < FAR_OFF_HISTORY) return;
      const earlier = list.slice(0, i);
      const cents = toCents(d.total);
      const base = { key: `far_off:${d.netsuite_id}`, kind: 'far_off' as const, company: companyOf(d), party: d.party, party_name: d.name, date: d.date, amount: centsToString(cents), docs: [refOf(d)] };

      const steady = steadyRun(earlier);
      if (steady) {
        const slip = slipOf(cents, steady.middle);
        if (slip) {
          out.push({
            ...base, strength: 2,
            why: `Their last ${steady.docs.length} ${nounsOf(steady.docs)} were ${steady.same ? '' : 'about '}${fmt(steady.middle)} each. `
              + `This one is ${slip}, which can be a slipped decimal point.`,
          });
          return;
        }
      }

      const amounts = earlier.map((e) => toCents(e.total));
      const most = Math.max(...amounts);
      if (cents < FAR_OFF_MIN_CENTS || most <= 0 || cents <= 2 * most) return;
      const n = Math.floor(cents / most);
      const least = Math.min(...amounts);
      const verb = earlier.every((e) => e.type === 'VendBill') ? 'billed' : 'charged';
      out.push({
        ...base, strength: 1,
        why: `Their ${nounsOf(earlier)} have ${least === most ? `all been ${fmt(most)}` : `run ${fmt(least)} to ${fmt(most)}`} `
          + `since ${monthYear(earlier[0].date)}. This one is ${cents === n * most ? '' : 'more than '}${times(n)} the most they've ${verb}.`,
      });
    });
  }
  return out;
}

/** The same day a year earlier, as a string to compare dates by: '2025-10-03' for '2026-10-03'. */
const yearBefore = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;

/**
 * Bill credits dated from LOOK_FROM, from CREDIT_MIN_CENTS, for more than their vendor's bills, checks and card charges
 * in the year up to them came to, or from a vendor with none: a credit for the wrong vendor, or a slipped decimal point.
 * Card refunds aren't looked at this way: what they refund can be on a journal entry of the card's statement.
 */
export function findCreditsFarOff(docs: MistakeDoc[], companyOf: (d: MistakeDoc) => BooksCompany): Finding[] {
  const charges = byParty(docs);
  const out: Finding[] = [];
  for (const d of docs) {
    if (!d.party || d.voided || d.type !== 'VendCred' || d.date < LOOK_FROM) continue;
    const cents = toCents(d.total);
    if (cents < CREDIT_MIN_CENTS) continue;
    const from = yearBefore(d.date);
    const year = (charges.get(d.party) ?? []).filter((c) => c.date > from && c.date <= d.date);
    const billed = year.reduce((sum, c) => sum + toCents(c.total), 0);
    if (cents <= billed) continue;
    out.push({
      key: `far_off:${d.netsuite_id}`, kind: 'far_off', company: companyOf(d), party: d.party, party_name: d.name, date: d.date,
      amount: centsToString(cents), strength: 1, docs: [refOf(d)],
      why: year.length
        ? `Their ${nounsOf(year)} in the year before it came to ${fmt(billed)}, less than this credit. It may be for the wrong vendor, or have a slipped decimal point.`
        : 'No bills, checks or card charges from them in the year before it, so this credit has nothing to take back. It may be for the wrong vendor.',
    });
  }
  return out;
}

/** The accounts a journal entry posts to, each with its company and side: the same for entries made the same way, whatever they come to. */
const journalAccounts = (d: MistakeDoc) =>
  [...new Set((d.journal ?? []).filter(moves).map((l) => `${l.company}|${l.account}|${toCents(l.debit) > 0 ? 'debit' : 'credit'}`))].sort().join(';');

/**
 * Journal entries dated from LOOK_FROM ten times, or a tenth of, what the entries to the same accounts on the same
 * sides have steadily come to: at least FAR_OFF_HISTORY earlier ones, the last of them within STEADY_SPREAD of each
 * other, as a depreciation or rent entry is each month. Entries another undoes aren't looked at.
 */
export function findJournalFarOff(
  docs: MistakeDoc[],
  companyOf: (d: MistakeDoc) => BooksCompany,
  accountName: (id: string) => string,
): Finding[] {
  const made = new Map<string, MistakeDoc[]>();
  for (const d of liveJournals(docs)) made.set(journalAccounts(d), [...(made.get(journalAccounts(d)) ?? []), d]);
  const out: Finding[] = [];
  for (const list of made.values()) {
    list.forEach((d, i) => {
      if (d.date < LOOK_FROM) return;
      const steady = steadyRun(list.slice(0, i));
      const cents = toCents(d.total);
      const slip = steady ? slipOf(cents, steady.middle) : null;
      if (!steady || !slip) return;
      const accounts = [...new Set((d.journal ?? []).filter(moves).map((l) => accountName(l.account)))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      const to = accounts.length > ODD_MOST_ACCOUNTS ? `these ${accounts.length} accounts` : listed(accounts, 'and');
      out.push({
        key: `far_off:${d.netsuite_id}`, kind: 'far_off', company: companyOf(d), party: null, party_name: null, date: d.date,
        amount: centsToString(cents), strength: 2, docs: [refOf(d)],
        why: `The last ${steady.docs.length} journal entries to ${to} were ${steady.same ? '' : 'about '}${fmt(steady.middle)} each. `
          + `This one is ${slip}, which can be a slipped decimal point.`,
      });
    });
  }
  return out;
}

// ── Monthly charge missing ─────────────────────────────────────────────────

interface MonthlyRun {
  /** The first month of the run of months in a row that ends just before the month looked at. */
  from: string;
  /** The day of the month the vendor's first document of a month usually comes. */
  day: number;
  /** About what a month comes to: the middle of the last MONTHS_IN_A_ROW months' totals. */
  cents: number;
  last: MistakeDoc;
  billed: boolean;
}

/**
 * Each company's monthly charges: the vendors with a document in each of the MONTHS_IN_A_ROW months before `month`, as
 * a run, and which months they have documents in. A document the copy of NetSuite's ledger hasn't put in a company yet
 * counts for each company the vendor has others in, or for BMG when it has none, as companyPicker takes it.
 */
function monthlyCharges(docs: MistakeDoc[]) {
  const months = new Map<string, Map<string, MistakeDoc[]>>(); // `<company>|<party>` → month → docs
  const companiesOf = new Map<string, Set<string>>();
  for (const [party, list] of byParty(docs)) {
    const known = new Set<string>();
    for (const d of list) for (const c of BOOKS_COMPANIES) if (d.companies.includes(c)) known.add(c);
    if (!known.size) known.add(BOOKS_COMPANIES[0]);
    companiesOf.set(party, known);
    for (const company of known) {
      const key = `${company}|${party}`;
      const of = new Map<string, MistakeDoc[]>();
      for (const d of list) {
        if (d.companies.length && !d.companies.includes(company)) continue;
        const m = monthOf(d.date);
        of.set(m, [...(of.get(m) ?? []), d]);
      }
      months.set(key, of);
    }
  }
  const runBefore = (key: string, month: string): MonthlyRun | null => {
    const of = months.get(key);
    if (!of) return null;
    const before = Array.from({ length: MONTHS_IN_A_ROW }, (_, i) => addMonths(month, i - MONTHS_IN_A_ROW));
    if (!before.every((m) => of.has(m))) return null;
    let from = before[0];
    while (addMonths(from, -1) >= USUAL_FROM && of.has(addMonths(from, -1))) from = addMonths(from, -1);
    const recent = before.map((m) => of.get(m)!);
    const all = recent.flat();
    return {
      from,
      day: middle(recent.map((list) => Number(list[0].date.slice(8, 10)))),
      cents: middle(recent.map((list) => list.reduce((sum, d) => sum + toCents(d.total), 0))),
      last: all[all.length - 1],
      billed: all.filter((d) => d.type === 'VendBill').length * 2 >= all.length,
    };
  };
  return { months, runBefore };
}

/**
 * Monthly charges that haven't come: a vendor with a document in each of the MONTHS_IN_A_ROW months before this one
 * and none this month, GRACE_DAYS past their usual day; or, before then, none last month after a run before it. Kept
 * items still missing are found again whatever the run, until a document comes for that month. Not for monthly
 * charges a super admin stopped watching, nor for months before LOOK_FROM's.
 */
export function findMissing(docs: MistakeDoc[], today: string, learned: Learned, kept: KeptItem[]): Finding[] {
  const { months, runBefore } = monthlyCharges(docs);
  const thisMonth = monthOf(today);
  const todayDay = Number(today.slice(8, 10));
  const out = new Map<string, Finding>();
  const has = (key: string, month: string) => months.get(key)?.has(month) ?? false;

  const finding = (company: BooksCompany, party: string, month: string, run: MonthlyRun): Finding => {
    const verb = run.billed ? 'Billed' : 'Charged';
    const usually = `usually around the ${ordinal(run.day)}`;
    const why = month === thisMonth
      ? `${verb} every month since ${monthYear(run.from)}, ${usually}. Nothing for ${monthName(month)} yet, and it's the ${ordinal(todayDay)}.`
      : `${verb} every month from ${monthYear(run.from)} to ${monthYear(addMonths(month, -1))}, ${usually}. Nothing came for ${monthYear(month)}.`;
    return {
      key: `missing:${company}:${party}:${month.slice(0, 7)}`, kind: 'missing', company, party, party_name: run.last.name,
      date: month, amount: centsToString(run.cents), strength: 0, why, docs: [refOf(run.last, 'Last: ')], learn: { party, company },
    };
  };

  for (const key of months.keys()) {
    if (learned.unwatched.has(key)) continue;
    const [company, party] = key.split('|') as [BooksCompany, string];
    const now = runBefore(key, thisMonth);
    if (now && !has(key, thisMonth) && todayDay >= now.day + GRACE_DAYS && thisMonth >= LOOK_FROM) {
      out.set(`${key}|${thisMonth}`, finding(company, party, thisMonth, now));
      continue;
    }
    const lastMonth = addMonths(thisMonth, -1);
    const before = runBefore(key, lastMonth);
    if (before && !has(key, lastMonth) && lastMonth >= LOOK_FROM) out.set(`${key}|${lastMonth}`, finding(company, party, lastMonth, before));
  }

  // One already found stays found until a document comes for its month, unless it was cleared as fine.
  for (const item of kept) {
    if (item.kind !== 'missing' || (item.state === 'cleared' && item.how !== 'fixed') || !item.party) continue;
    const key = `${item.company}|${item.party}`;
    if (learned.unwatched.has(key) || has(key, item.date) || out.has(`${key}|${item.date}`)) continue;
    const run = runBefore(key, item.date);
    out.set(`${key}|${item.date}`, run ? finding(item.company, item.party, item.date, run) : {
      key: item.key, kind: 'missing', company: item.company, party: item.party, party_name: item.party_name, date: item.date,
      amount: item.amount, strength: item.strength, why: item.why, docs: item.docs, learn: { party: item.party, company: item.company },
    });
  }
  return [...out.values()];
}

// ── Odd account ────────────────────────────────────────────────────────────

/**
 * Documents dated from LOOK_FROM with an expense line coded to an account none of their vendor's earlier documents
 * used, once ODD_HISTORY of those have expense lines and they've used no more than ODD_MOST_ACCOUNTS accounts. A
 * vendor's documents are their charges and their credits: a credit goes back where their bills went. Accounts a super
 * admin said are fine for the vendor aren't odd.
 */
export function findOddAccounts(
  docs: MistakeDoc[],
  learned: Learned,
  accountName: (id: string) => string,
  companyOf: (d: MistakeDoc) => BooksCompany,
): Finding[] {
  const out: Finding[] = [];
  for (const [party, list] of byParty(docs, PARTY_DOCS)) {
    const coded = list.filter((d) => d.lines_known && d.accounts.length);
    coded.forEach((d, i) => {
      if (d.date < LOOK_FROM || i < ODD_HISTORY) return;
      const earlier = coded.slice(0, i);
      const usual = new Set(earlier.flatMap((e) => e.accounts));
      if (usual.size > ODD_MOST_ACCOUNTS) return;
      const fine = learned.accounts.get(party);
      const odd = d.accounts.filter((a) => !usual.has(a) && !fine?.has(a));
      if (!odd.length) return;
      out.push({
        key: `odd_account:${d.netsuite_id}`, kind: 'odd_account', company: companyOf(d), party, party_name: d.name, date: d.date,
        amount: centsToString(toCents(d.total)), strength: 0, docs: [refOf(d)], learn: { party, accounts: odd },
        why: `Coded to ${listed(odd.map(accountName), 'and')}. Their ${earlier.length} earlier ${nounsOf(earlier)} `
          + `all went to ${listed([...usual].sort().map(accountName), 'or')}.`,
      });
    });
  }
  return out;
}

// ── A look ─────────────────────────────────────────────────────────────────

/** What the kept items cleared as fine have taught the check. */
export function learnedFrom(kept: KeptItem[]): Learned {
  const learned: Learned = { accounts: new Map(), unwatched: new Set() };
  for (const item of kept) {
    if (!item.learned || !item.learn) continue;
    if ('accounts' in item.learn) {
      const fine = learned.accounts.get(item.learn.party) ?? new Set<string>();
      for (const a of item.learn.accounts) fine.add(a);
      learned.accounts.set(item.learn.party, fine);
    } else {
      learned.unwatched.add(`${item.learn.company}|${item.learn.party}`);
    }
  }
  return learned;
}

/** Everything one look finds. */
export function findMistakes(
  docs: MistakeDoc[],
  opts: { today: string; kept: KeptItem[]; accountName: (id: string) => string },
): Finding[] {
  const learned = learnedFrom(opts.kept);
  const companyOf = companyPicker(docs);
  return [
    ...findTwice(docs, companyOf),
    ...findJournalTwice(docs, companyOf),
    ...findFarOff(docs, companyOf),
    ...findCreditsFarOff(docs, companyOf),
    ...findJournalFarOff(docs, companyOf, opts.accountName),
    ...findMissing(docs, opts.today, learned, opts.kept),
    ...findOddAccounts(docs, learned, opts.accountName, companyOf),
  ];
}

/** Why an open item the look no longer finds has cleared on its own: what changed in the copies. */
export function goneWhy(
  item: KeptItem,
  docs: MistakeDoc[],
  opts: { kept: KeptItem[]; accountName: (id: string) => string },
): string {
  const byId = new Map(docs.map((d) => [d.netsuite_id, d]));
  if (item.kind === 'missing') {
    const learned = learnedFrom(opts.kept);
    const came = docs
      .filter((d) => d.party === item.party && !d.voided && CHARGES.has(d.type) && monthOf(d.date) === item.date
        && (!d.companies.length || d.companies.includes(item.company)))
      .sort(byDate)[0];
    if (came) return `The ${monthName(item.date)} ${NOUNS[came.type][0]} came in, dated the ${ordinal(Number(came.date.slice(8, 10)))}.`;
    if (learned.unwatched.has(`${item.company}|${item.party}`)) return 'This monthly charge isn\'t watched now.';
    return 'It no longer looks like a monthly charge.';
  }
  for (const ref of item.docs) {
    const now = byId.get(ref.netsuite_id);
    if (!now) return `${ref.label} is gone from NetSuite.`;
    if (now.voided) return `${ref.label} was voided in NetSuite.`;
  }
  const undone = journalReversals(docs);
  for (const ref of item.docs) {
    const other = undone.get(ref.netsuite_id);
    if (other) return `${ref.label} and ${docLabel(other).charAt(0).toLowerCase()}${docLabel(other).slice(1)} undo each other.`;
    const now = byId.get(ref.netsuite_id)!;
    if (item.party && now.party && now.party !== item.party) return `${ref.label} is for ${now.name ?? 'another vendor'} now.`;
  }
  const [first] = item.docs;
  const now = first ? byId.get(first.netsuite_id) : undefined;
  if (item.kind === 'twice') {
    const changed = item.docs.find((r) => toCents(byId.get(r.netsuite_id)!.total) !== toCents(r.total));
    if (changed) return `${changed.label} is now ${fmt(toCents(byId.get(changed.netsuite_id)!.total))}, so they no longer match.`;
    const [a, b] = item.docs.map((r) => byId.get(r.netsuite_id)!);
    if (a?.type === 'Journal' && b?.type === 'Journal' && journalShape(a) !== journalShape(b)) return 'Their lines no longer match.';
    return 'They no longer look entered twice.';
  }
  if (item.kind === 'far_off') {
    if (now && first && toCents(now.total) !== toCents(first.total)) return `It's now ${fmt(toCents(now.total))}.`;
    if (now?.type === 'VendCred') return 'It no longer takes back more than they billed.';
    return now?.type === 'Journal' ? 'It no longer looks far off the usual.' : 'It no longer looks far off their usual.';
  }
  const odd = item.learn && 'accounts' in item.learn ? item.learn.accounts : [];
  const fine = item.party ? learnedFrom(opts.kept).accounts.get(item.party) : undefined;
  if (odd.length && odd.every((a) => fine?.has(a))) {
    return `${listed(odd.map(opts.accountName), 'and')} ${odd.length === 1 ? 'is' : 'are'} fine for ${item.party_name ?? 'this vendor'} now.`;
  }
  if (now && !odd.some((a) => now.accounts.includes(a))) {
    return now.accounts.length ? `It's now coded to ${listed(now.accounts.map(opts.accountName), 'and')}.` : 'It no longer has an expense line.';
  }
  return 'It no longer looks odd.';
}

// ── The nightly look ───────────────────────────────────────────────────────

export interface MistakeRunResult {
  /** Copied documents looked through. */
  docs: number;
  found: number;
  added: number;
  back: number;
  gone: number;
  error?: string;
}

const MISTAKE_KEY_RE = /^(twice|far_off|missing|odd_account):/;

/** A gl_mistake_checks row → a kept item; null for one that doesn't read, which the look then leaves alone. */
export function keptItem(row: Record<string, any>, companyCode: (id: string) => BooksCompany | null): KeptItem | null {
  const company = companyCode(String(row.company_id ?? ''));
  if (!company || !MISTAKE_KEY_RE.test(String(row.key ?? '')) || !MISTAKE_KINDS.includes(row.kind)) return null;
  const learn = row.learn && typeof row.learn === 'object' && typeof row.learn.party === 'string'
    ? (Array.isArray(row.learn.accounts) ? { party: row.learn.party, accounts: row.learn.accounts.map(String) }
      : BOOKS_COMPANIES.includes(row.learn.company) ? { party: row.learn.party, company: row.learn.company as BooksCompany } : null)
    : null;
  return {
    key: row.key, kind: row.kind, company, party: row.party_netsuite_id ?? null, party_name: row.party_name ?? null,
    date: String(row.doc_date).slice(0, 10), amount: row.amount === null || row.amount === undefined ? null : String(row.amount),
    strength: Number(row.strength) || 0, why: String(row.why ?? ''), docs: Array.isArray(row.docs) ? row.docs : [], learn,
    state: row.state === 'cleared' ? 'cleared' : 'open', how: row.cleared_how ?? null, learned: row.learned === true,
  };
}

/** The account a page names: its number and name from the chart of accounts, else NetSuite's id for it. */
export function accountNamer(accounts: Array<{ netsuite_account_id: string | null; number: string | null; name: string }>) {
  const names = new Map<string, string>();
  for (const a of accounts) if (a.netsuite_account_id) names.set(a.netsuite_account_id, [a.number, a.name].filter(Boolean).join(' '));
  return (id: string) => names.get(id) ?? `NetSuite account ${id}`;
}

// ── The page ───────────────────────────────────────────────────────────────

/** One item as Books → Mistake checks shows it. */
export interface MistakeView {
  id: string;
  kind: MistakeKind;
  company: BooksCompany;
  party: string | null;
  date: string;
  cents: number | null;
  strength: number;
  why: string;
  docs: Array<{ label: string; url: string | null }>;
  state: 'open' | 'cleared';
  how: 'fixed' | 'fine' | 'gone' | null;
  /** Who cleared it, by name. */
  by: string | null;
  at: string | null;
  note: string | null;
  goneWhy: string | null;
  learned: boolean;
  /** What clearing it as fine can also do, as its checkbox says it; null when it teaches nothing. */
  learnText: string | null;
  backAt: string | null;
  foundAt: string;
}

/** What clearing an item as fine can also do, in its checkbox's words. */
export function learnText(item: Pick<KeptItem, 'learn' | 'party_name'>, accountName: (id: string) => string): string | null {
  if (!item.learn) return null;
  if ('accounts' in item.learn) {
    return `Fine for ${item.party_name ?? 'this vendor'} from now on: don't flag ${listed(item.learn.accounts.map(accountName), 'and')} for them again`;
  }
  return 'Stop watching for this monthly charge';
}

/**
 * Who or what an item is about, as the page and the daily check name it: its vendor or payee, else for one about
 * journal entries the last of them ('Journal entry JE-1042'), else no one.
 */
export function mistakeSubject(item: { party_name: string | null; docs: unknown }): { name: string | null; journal: boolean } {
  if (item.party_name) return { name: item.party_name, journal: false };
  const docs = Array.isArray(item.docs) ? (item.docs as Array<Partial<MistakeDocRef>>) : [];
  const last = docs[docs.length - 1];
  if (!last || !docs.every((d) => d?.type === 'Journal')) return { name: null, journal: false };
  return { name: `Journal entry${last.number ? ` ${last.number}` : ''}`, journal: true };
}

/** A gl_mistake_checks row → what the page shows; null for one that doesn't read. */
export function mistakeView(
  row: Record<string, any>,
  opts: {
    companyCode: (id: string) => BooksCompany | null;
    accountName: (id: string) => string;
    /** Who cleared it, by FleetSuite user id. */
    names: Map<string, string>;
    /** NetSuite's page for a document, when FleetSuite knows NetSuite's address. */
    link: (type: MistakeDocType, netsuiteId: string) => string | null;
  },
): MistakeView | null {
  const item = keptItem(row, opts.companyCode);
  if (!item || typeof row.id !== 'string') return null;
  return {
    id: row.id, kind: item.kind, company: item.company, party: mistakeSubject(item).name, date: item.date,
    cents: item.amount === null ? null : toCents(item.amount), strength: item.strength, why: item.why,
    docs: item.docs.map((d) => ({ label: String(d.label ?? ''), url: NOUNS[d.type] && /^\d+$/.test(String(d.netsuite_id)) ? opts.link(d.type, d.netsuite_id) : null })),
    state: item.state, how: item.how, by: row.cleared_by ? opts.names.get(row.cleared_by) ?? null : null, at: row.cleared_at ?? null,
    note: row.cleared_note ?? null, goneWhy: row.gone_why ?? null, learned: item.learned, learnText: learnText(item, opts.accountName),
    backAt: row.back_at ?? null, foundAt: String(row.found_at ?? ''),
  };
}

/** One NetSuite journal entry, as gl_mistake_journal_entries gives it (migration 516). */
export interface JournalRow {
  netsuite_id: string;
  number: string | null;
  date: string;
  lines: JournalLine[] | null;
}

/** A journal entry as the checks look at it: no vendor, its total its debits, its companies those its lines post to. */
export function journalDoc(row: JournalRow): MistakeDoc {
  const lines = Array.isArray(row.lines) ? row.lines : [];
  return {
    netsuite_id: row.netsuite_id, type: 'Journal', number: row.number ?? null, date: row.date, party: null, name: null,
    total: centsToString(lines.reduce((sum, l) => sum + toCents(l.debit), 0)), voided: false,
    companies: [...new Set(lines.map((l) => l.company))].sort(), accounts: [], lines_known: true, journal: lines,
  };
}

/** The copied documents and journal entries from USUAL_FROM to today, a quarter at a time so no answer gets too big. */
async function readDocs(service: SupabaseClient, today: string): Promise<MistakeDoc[]> {
  const docs: MistakeDoc[] = [];
  const end = addMonths(monthOf(today), 1);
  for (let from = USUAL_FROM; from < end; from = addMonths(from, 3)) {
    const to = addMonths(from, 3) < end ? addMonths(from, 3) : end;
    const [copied, journals] = await Promise.all([
      service.rpc('gl_mistake_docs', { p_from: from, p_to: to }),
      service.rpc('gl_mistake_journal_entries', { p_from: from, p_to: to }),
    ]);
    if (copied.error) throw new Error(`reading the copied documents from ${monthYear(from)}: ${copied.error.message}`);
    if (journals.error) throw new Error(`reading the copied journal entries from ${monthYear(from)}: ${journals.error.message}`);
    docs.push(...((copied.data ?? []) as MistakeDoc[]), ...((journals.data ?? []) as JournalRow[]).map(journalDoc));
  }
  return docs;
}

/**
 * One look: reads the copies and what the check keeps, finds what looks like a mistake now, and saves it with why each
 * open one no longer found has cleared on its own (gl_mistake_checks_save). Recorded in sync_state.
 */
export async function runMistakeChecks(
  service: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<MistakeRunResult & { heartbeat?: HeartbeatResult }> {
  const startedAt = Date.now();
  const today = centralDate(opts.now ?? new Date());
  const result: MistakeRunResult = { docs: 0, found: 0, added: 0, back: 0, gone: 0 };
  try {
    const read = (syncType: string) => service.from('sync_state').select('last_synced_at').eq('sync_type', syncType).maybeSingle();
    const [bills, spending, ledger, companies, rows, accounts] = await Promise.all([
      read(BOOKS_BILLS_SYNC),
      read(BOOKS_SPENDING_SYNC),
      read(BOOKS_GL_SYNC),
      service.from('gl_companies').select('id, code'),
      fetchAllRows<Record<string, any>>((from, to) => service
        .from('gl_mistake_checks')
        .select('key, kind, company_id, party_netsuite_id, party_name, doc_date, amount, strength, why, docs, learn, state, cleared_how, learned')
        .order('id', { ascending: true })
        .range(from, to)),
      fetchAllRows<{ netsuite_account_id: string | null; number: string | null; name: string }>((from, to) => service
        .from('gl_accounts')
        .select('netsuite_account_id, number, name')
        .order('id', { ascending: true })
        .range(from, to)),
    ]);
    const failed = bills.error || spending.error || ledger.error || companies.error || rows.error || accounts.error;
    if (failed) throw new Error(failed.message);

    const codes = new Map((companies.data ?? []).map((c: { id: string; code: string }) => [c.id, c.code]));
    const companyCode = (id: string) => {
      const code = codes.get(id);
      return code && (BOOKS_COMPANIES as readonly string[]).includes(code) ? (code as BooksCompany) : null;
    };
    const kept = rows.data.map((r) => keptItem(r, companyCode)).filter((k): k is KeptItem => k !== null);
    const accountName = accountNamer(accounts.data);
    const docs = await readDocs(service, today);
    result.docs = docs.length;

    const found = findMistakes(docs, { today, kept, accountName });
    const foundKeys = new Set(found.map((f) => f.key));
    const gone = kept
      .filter((k) => k.state === 'open' && !foundKeys.has(k.key))
      .map((k) => ({ key: k.key, why: goneWhy(k, docs, { kept, accountName }) }));
    // The copies have every change NetSuite had by the oldest of the three, so a fix made before then is in them.
    const through = [bills.data?.last_synced_at, spending.data?.last_synced_at, ledger.data?.last_synced_at];
    const copiedThrough = through.every(Boolean) ? (through as string[]).sort((a, b) => Date.parse(a) - Date.parse(b))[0] : null;

    const saved = await service.rpc('gl_mistake_checks_save', { p: { found, gone, copied_through: copiedThrough } });
    if (saved.error) throw new Error(`saving what it found: ${saved.error.message}`);
    const s = (saved.data ?? {}) as Partial<Record<'found' | 'added' | 'back' | 'gone', number>>;
    Object.assign(result, { found: Number(s.found) || 0, added: Number(s.added) || 0, back: Number(s.back) || 0, gone: Number(s.gone) || 0 });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.error('[books] mistake checks:', result.error);
  }
  const heartbeat = await recordHeartbeat(service, BOOKS_MISTAKE_CHECKS, result, {
    startedAt,
    records: result.docs,
    touchLastSyncedAt: !result.error,
  });
  return { ...result, heartbeat };
}
