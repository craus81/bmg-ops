/**
 * 1084 Cool Springs' rent and mortgage, month by month (Books part 61,
 * docs/books.md "1084's rent and mortgage"; the NetSuite Exit Checklist's
 * "1084's monthly entries"). 1084 Cool Springs LLC owns the building BMG
 * rents, and its only business is BMG's rent coming in and the mortgage
 * going out (owner, 2026-10-10, thread "Replacing NetSuite with FleetSuite").
 * Each month puts:
 *
 *   - the rent BMG's books have next to the rent 1084's books have from it:
 *     the rent check against BMG's side;
 *   - the lender's statement for the month's payment, typed in, next to what
 *     1084's books have for the mortgage: principal, interest, and the
 *     principal left at the month's end;
 *   - the two entries that book the month, the rent received and the
 *     mortgage payment, made as typed journal entries (Books part 37,
 *     src/lib/typed-journal-entries.ts) in the general journal, for someone to
 *     ask for approval on Journal entries and a super admin to approve, and
 *     sent on to NetSuite once approved. Each is dated its own day, as each
 *     is its own move in 1084's bank.
 *
 * A month is the month the books show it in: the rent received and the
 * payment the statement is for are each dated in it.
 *
 * The rules here are pure and client-safe; /api/admin/books/rent-and-mortgage
 * and its page both use them, the page to say what saving or making the
 * entries would find, the route to check and make them from what's saved.
 */

import {
  formatCents, isDay, linesToKeep, MAX_LINE_CENTS, type TypedEntry, type TypedLine, type TypedStatus,
} from '@/lib/typed-journal-entries';

/** The company that owns the building, and the one that rents it. */
export const LANDLORD = '1084';
export const TENANT = 'BMG';

/** The first month FleetSuite's books post: COPY_FROM in src/lib/books/netsuite-gl.ts, which is server code. */
export const FIRST_MONTH = '2025-01-01';

/** The longest lender's name, as migration 492 keeps it. */
export const LENDER_MAX = 100;

export { formatCents };

/** The accounts a landlord's months are read from and booked to, each by NetSuite's id; null for one not picked yet. */
export interface RentMortgageSetup {
  bankAccount: string | null;
  rentIncomeAccount: string | null;
  /** The tenant's (BMG's) account its rent is booked to. */
  tenantRentAccount: string | null;
  mortgageAccount: string | null;
  interestAccount: string | null;
  /** None when the lender holds no escrow. */
  escrowAccount: string | null;
  lender: string | null;
}

export const NO_SETUP: RentMortgageSetup = {
  bankAccount: null, rentIncomeAccount: null, tenantRentAccount: null, mortgageAccount: null, interestAccount: null, escrowAccount: null, lender: null,
};

export type SetupRole = Exclude<keyof RentMortgageSetup, 'lender'>;

/** Each account the setup picks: whose books it's in, what it's called, and the kinds of account it can be. */
export const SETUP_ACCOUNTS: ReadonlyArray<{ role: SetupRole; company: string; label: string; types: readonly string[]; optional?: true }> = [
  { role: 'bankAccount', company: LANDLORD, label: "1084's bank account", types: ['bank'] },
  { role: 'rentIncomeAccount', company: LANDLORD, label: "1084's rent income", types: ['income', 'other_income'] },
  { role: 'tenantRentAccount', company: TENANT, label: "BMG's rent", types: ['expense', 'other_expense', 'cost_of_goods_sold'] },
  { role: 'mortgageAccount', company: LANDLORD, label: "1084's mortgage", types: ['long_term_liability', 'other_current_liability'] },
  { role: 'interestAccount', company: LANDLORD, label: "The mortgage's interest", types: ['expense', 'other_expense'] },
  { role: 'escrowAccount', company: LANDLORD, label: 'Escrow', types: ['other_current_asset', 'other_asset', 'expense', 'other_expense'], optional: true },
];

/** An account a setup can pick, with the companies a typed line can use it for (readAccounts in src/lib/books/snap-a-bill.ts). */
export interface SetupAccount {
  id: string;
  number: string | null;
  name: string;
  type: string;
  companies: string[];
}

export const accountName = (a: Pick<SetupAccount, 'number' | 'name'>) => [a.number, a.name].filter(Boolean).join(' ');

/** Can the setup pick this account for this? */
export const fits = (role: (typeof SETUP_ACCOUNTS)[number], a: SetupAccount) => a.companies.includes(role.company) && role.types.includes(a.type);

/** Why a setup can't be kept: each account one its company can use, of a kind it can be, and each picked once. */
export function setupProblems(s: RentMortgageSetup, accounts: ReadonlyMap<string, SetupAccount>): string[] {
  const problems: string[] = [];
  const picked = new Map<string, string>();
  for (const role of SETUP_ACCOUNTS) {
    const id = s[role.role];
    if (!id) continue;
    const account = accounts.get(id);
    if (!account || !fits(role, account)) {
      problems.push(`${role.label} isn't an account that can be picked for it.`);
      continue;
    }
    const before = picked.get(id);
    if (before) problems.push(`${before} and ${role.label.charAt(0).toLowerCase()}${role.label.slice(1)} are the same account: pick each once.`);
    else picked.set(id, role.label);
  }
  if ((s.lender ?? '').trim().length > LENDER_MAX) problems.push(`The lender's name takes ${LENDER_MAX} characters at most.`);
  return problems;
}

// ── What the books have ─────────────────────────────────────────────────────

/** One account's journal in one month, as gl_books_totals (migration 396) gives it. */
export interface BooksAmount {
  /** NetSuite's id for the account, or 'fs:<id>'. */
  account: string;
  /** 'YYYY-MM-01'. */
  month: string;
  debit: string;
  credit: string;
}

/** An account's balance before 2025, the starting entry, as gl_netsuite_totals (migration 361) gives it. */
export interface OpeningAmount {
  netsuite_account_id: string;
  debit: string;
  credit: string;
}

/** Whole cents from an amount the database gives as text. */
export function cents(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n)) throw new Error(`The books gave an amount FleetSuite can't read (${String(v).slice(0, 40)})`);
  return n || 0;
}

/** What one month of the books has, each null when its account isn't picked. */
export interface BookMonth {
  /** 'YYYY-MM-01'. */
  month: string;
  /** BMG's rent account: debits less credits. */
  tenantRentCents: number | null;
  /** 1084's rent income: credits less debits. */
  rentCents: number | null;
  /** Paid off the mortgage: debits less credits. */
  principalCents: number | null;
  /** The mortgage's interest: debits less credits. */
  interestCents: number | null;
  /** The mortgage's principal at the month's end, credit positive: the starting entry and every month through this one. */
  balanceCents: number | null;
}

/** The months from `from` through `to`, each 'YYYY-MM-01'. */
export function monthsFrom(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  for (let month = from; month <= to && out.length < 1200;) {
    out.push(month);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    month = `${y}-${String(m).padStart(2, '0')}-01`;
  }
  return out;
}

/** The month before, 'YYYY-MM-01'. */
export function monthBefore(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}

/** Debits less credits, per account and month. */
function moves(rows: readonly BooksAmount[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const byMonth = out.get(r.account) ?? new Map<string, number>();
    byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + cents(r.debit) - cents(r.credit));
    out.set(r.account, byMonth);
  }
  return out;
}

/**
 * Each month's figures from FleetSuite's books: BMG's journal for its rent,
 * 1084's for the rest, and NetSuite's balances before 2025 for where the
 * mortgage started, as Reports reads them (src/lib/books/reports.ts).
 */
export function bookMonths(input: {
  setup: RentMortgageSetup;
  landlord: readonly BooksAmount[];
  tenant: readonly BooksAmount[];
  opening: readonly OpeningAmount[];
  months: readonly string[];
}): BookMonth[] {
  const { setup } = input;
  const landlord = moves(input.landlord);
  const tenant = moves(input.tenant);
  const movedIn = (from: Map<string, Map<string, number>>, account: string | null, month: string) =>
    (account ? from.get(account)?.get(month) ?? 0 : null);
  const mortgage = setup.mortgageAccount;
  const opening = mortgage
    ? input.opening.filter((o) => o.netsuite_account_id === mortgage).reduce((sum, o) => sum + cents(o.debit) - cents(o.credit), 0)
    : 0;
  const mortgageMoves = mortgage ? [...(landlord.get(mortgage) ?? new Map<string, number>()).entries()] : [];
  return input.months.map((month) => {
    const rent = movedIn(landlord, setup.rentIncomeAccount, month);
    const balance = mortgage ? -(opening + mortgageMoves.reduce((sum, [m, c]) => (m <= month ? sum + c : sum), 0)) || 0 : null;
    return {
      month,
      tenantRentCents: movedIn(tenant, setup.tenantRentAccount, month),
      rentCents: rent === null ? null : -rent || 0,
      principalCents: movedIn(landlord, mortgage, month),
      interestCents: movedIn(landlord, setup.interestAccount, month),
      balanceCents: balance,
    };
  });
}

// ── What's typed ────────────────────────────────────────────────────────────

/** The rent received from the tenant in the month, and the day. */
export interface RentReceived {
  date: string;
  cents: number;
}

/** The lender's statement for the payment made in the month. */
export interface Statement {
  paidOn: string;
  principalCents: number;
  interestCents: number;
  escrowCents: number;
  /** The principal left after the payment. */
  balanceAfterCents: number;
}

export interface TypedMonth {
  /** 'YYYY-MM-01'. */
  month: string;
  rent: RentReceived | null;
  statement: Statement | null;
}

/** What the payment comes to: principal, interest and escrow. */
export const paymentCents = (s: Statement) => s.principalCents + s.interestCents + s.escrowCents;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'March 2027'. */
export const monthName = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

const inMonth = (day: string, month: string) => isDay(day) && day.slice(0, 7) === month.slice(0, 7);

const wholeCents = (c: number, atLeast: number) => Number.isSafeInteger(c) && c >= atLeast && c <= MAX_LINE_CENTS;

/** Why a month's figures can't be saved: each to the cent, the rent above $0, and each dated in the month. */
export function typedProblems(t: TypedMonth): string[] {
  const problems: string[] = [];
  const name = monthName(t.month);
  if (t.rent) {
    if (!inMonth(t.rent.date, t.month)) problems.push(`The rent's day isn't in ${name}.`);
    if (!wholeCents(t.rent.cents, 1)) problems.push(`The rent needs an amount above $0 and up to ${formatCents(MAX_LINE_CENTS)}, to the cent.`);
  }
  const s = t.statement;
  if (s) {
    if (!inMonth(s.paidOn, t.month)) problems.push(`The day the payment was made isn't in ${name}.`);
    const parts: Array<[string, number]> = [
      ['principal', s.principalCents], ['interest', s.interestCents], ['escrow', s.escrowCents], ['principal left', s.balanceAfterCents],
    ];
    const bad = parts.filter(([, c]) => !wholeCents(c, 0)).map(([what]) => what);
    if (bad.length) problems.push(`The statement's ${bad.join(', ')} need${bad.length === 1 ? 's' : ''} an amount of $0 or more and up to ${formatCents(MAX_LINE_CENTS)}, to the cent.`);
    else if (paymentCents(s) <= 0) problems.push('The statement needs a payment above $0: its principal, interest and escrow are all $0.');
  }
  return problems;
}

/**
 * What doesn't follow from last month's statement, when both are typed:
 * the principal it left, less this month's principal, is what this one
 * should leave. Said, not refused: a lender can take extra principal, or
 * change the balance for a fee.
 */
export function statementNote(previous: Statement | null, s: Statement | null): string | null {
  if (!previous || !s) return null;
  const expected = previous.balanceAfterCents - s.principalCents;
  if (expected === s.balanceAfterCents) return null;
  return `Last month's statement left ${formatCents(previous.balanceAfterCents)}; less this month's principal of `
    + `${formatCents(s.principalCents)} that's ${formatCents(expected)}, not ${formatCents(s.balanceAfterCents)}.`;
}

/**
 * What the rent received starts as on a month not typed yet: what BMG's
 * books have for the month, else last month's typed rent, else what 1084's
 * books had last month. Null when none of them has any.
 */
export function rentDefault(book: BookMonth, previous: { typed: RentReceived | null; book: BookMonth | null }): number | null {
  if ((book.tenantRentCents ?? 0) > 0) return book.tenantRentCents;
  if (previous.typed) return previous.typed.cents;
  if ((previous.book?.rentCents ?? 0) > 0) return previous.book!.rentCents;
  return null;
}

// ── The checks ──────────────────────────────────────────────────────────────

/**
 * not_set_up: BMG's rent or 1084's rent income isn't picked; none: neither
 * company's books have rent in the month; matches: both have the same;
 * waiting: BMG's have it and 1084's don't yet, while it's this month or the
 * month's rent entry is made and on its way; differs: anything else.
 */
export type RentState = 'not_set_up' | 'none' | 'matches' | 'waiting' | 'differs';

export interface RentCheck {
  state: RentState;
  tenantCents: number;
  landlordCents: number;
  /** How far apart the two are. */
  apartCents: number;
}

export function rentCheck(book: BookMonth, on: { thisMonth: boolean; entry: TypedStatus | null }): RentCheck {
  if (book.tenantRentCents === null || book.rentCents === null) {
    return { state: 'not_set_up', tenantCents: 0, landlordCents: 0, apartCents: 0 };
  }
  const tenantCents = book.tenantRentCents;
  const landlordCents = book.rentCents;
  const apartCents = Math.abs(tenantCents - landlordCents);
  const state: RentState = !tenantCents && !landlordCents ? 'none'
    : tenantCents === landlordCents ? 'matches'
      : !landlordCents && tenantCents > 0 && (on.thisMonth || on.entry !== null) ? 'waiting'
        : 'differs';
  return { state, tenantCents, landlordCents, apartCents };
}

/**
 * not_set_up: the mortgage or its interest account isn't picked;
 * no_statement: nothing's typed for the month; not_booked: the books have
 * nothing paid on the mortgage in the month yet; matches: principal,
 * interest and the principal left at the month's end are the statement's;
 * differs: one of them isn't. Escrow isn't held against the books: what the
 * lender pays out of it (taxes, insurance) moves its account too.
 */
export type MortgageState = 'not_set_up' | 'no_statement' | 'not_booked' | 'matches' | 'differs';

export interface MortgageCheck {
  state: MortgageState;
  /** Each figure that isn't the statement's: the books' and the statement's. */
  differing: Array<{ what: 'principal' | 'interest' | 'balance'; books: number; statement: number }>;
}

export function mortgageCheck(book: BookMonth, s: Statement | null): MortgageCheck {
  if (book.principalCents === null || book.interestCents === null || book.balanceCents === null) return { state: 'not_set_up', differing: [] };
  if (!s) return { state: 'no_statement', differing: [] };
  if (!book.principalCents && !book.interestCents) return { state: 'not_booked', differing: [] };
  const differing: MortgageCheck['differing'] = [];
  if (book.principalCents !== s.principalCents) differing.push({ what: 'principal', books: book.principalCents, statement: s.principalCents });
  if (book.interestCents !== s.interestCents) differing.push({ what: 'interest', books: book.interestCents, statement: s.interestCents });
  if (book.balanceCents !== s.balanceAfterCents) differing.push({ what: 'balance', books: book.balanceCents, statement: s.balanceAfterCents });
  return { state: differing.length ? 'differs' : 'matches', differing };
}

// ── The month's entries ─────────────────────────────────────────────────────

export type EntryKind = 'rent' | 'mortgage';

export interface MonthEntries {
  rent: TypedEntry | null;
  mortgage: TypedEntry | null;
  /** Why they can't be made yet. */
  problems: string[];
}

const debit = (accountId: string, c: number, memo: string | null = null): TypedLine => ({ accountId, debitCents: c, creditCents: 0, memo });
const credit = (accountId: string, c: number, memo: string | null = null): TypedLine => ({ accountId, debitCents: 0, creditCents: c, memo });

/**
 * The entries a month's figures make, each in the general journal: the rent
 * received, the bank debited and rent income credited; and the mortgage
 * payment, principal, interest and escrow each debited (a $0 one left out)
 * and the bank credited with what they come to.
 */
export function monthEntries(input: { setup: RentMortgageSetup; typed: TypedMonth; tenantName: string }): MonthEntries {
  const { setup, typed } = input;
  const name = monthName(typed.month);
  const problems = typedProblems(typed);
  if (!typed.rent && !typed.statement) problems.push("Type the rent received or the lender's statement first.");
  let rent: TypedEntry | null = null;
  if (typed.rent) {
    if (!setup.bankAccount || !setup.rentIncomeAccount) problems.push("Pick 1084's bank account and rent income in the setup to book the rent.");
    else {
      rent = {
        journal: 'general',
        date: typed.rent.date,
        memo: `Rent from ${input.tenantName} for ${name}`,
        lines: [debit(setup.bankAccount, typed.rent.cents), credit(setup.rentIncomeAccount, typed.rent.cents)],
      };
    }
  }
  let mortgage: TypedEntry | null = null;
  const s = typed.statement;
  if (s) {
    const missing = !setup.bankAccount || !setup.mortgageAccount || !setup.interestAccount;
    if (missing) problems.push("Pick 1084's bank account, mortgage and the mortgage's interest in the setup to book the payment.");
    if (s.escrowCents > 0 && !setup.escrowAccount) problems.push('The statement has escrow: pick the escrow account in the setup to book it.');
    if (!missing && (s.escrowCents === 0 || setup.escrowAccount)) {
      const lender = (setup.lender ?? '').trim();
      mortgage = {
        journal: 'general',
        date: s.paidOn,
        memo: `Mortgage payment${lender ? ` to ${lender}` : ''} for ${name}`,
        lines: [
          ...(s.principalCents > 0 ? [debit(setup.mortgageAccount!, s.principalCents, 'Principal')] : []),
          ...(s.interestCents > 0 ? [debit(setup.interestAccount!, s.interestCents, 'Interest')] : []),
          ...(s.escrowCents > 0 ? [debit(setup.escrowAccount!, s.escrowCents, 'Escrow')] : []),
          credit(setup.bankAccount!, paymentCents(s)),
        ],
      };
    }
  }
  return { rent, mortgage, problems };
}

// ── Each month, as the page shows it ────────────────────────────────────────

/** A month as rent_mortgage_months keeps it. */
export interface SavedMonth extends TypedMonth {
  rentEntryId: string | null;
  mortgageEntryId: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/** One of a month's entries, as typed_journal_entries has it. */
export interface EntryRef {
  id: string;
  status: TypedStatus;
  updatedAt: string;
  date: string;
  memo: string | null;
  lines: TypedLine[];
  totalCents: number;
  /** NetSuite's number for it, once made. */
  number: string | null;
  /** Why NetSuite didn't make it, the last time it was approved. */
  error: string | null;
}

export interface EntryView extends EntryRef {
  /** A draft that isn't what the month's figures and the setup make now: making the entries again brings it up to date. */
  stale: boolean;
  /** Its figures were taken off the month since it was made. */
  takenOff: boolean;
}

export interface MonthView {
  /** 'YYYY-MM-01'. */
  month: string;
  book: BookMonth;
  rent: RentReceived | null;
  statement: Statement | null;
  /** When the month's figures were saved, and who by; null for a month never saved. */
  updatedAt: string | null;
  updatedBy: string | null;
  rentCheck: RentCheck;
  mortgageCheck: MortgageCheck;
  note: string | null;
  /** What the rent received starts as while the month has none typed. */
  rentDefaultCents: number | null;
  entries: Record<EntryKind, EntryView | null>;
}

/** Is a kept entry the one these figures make: its day, its memo, and its lines in order? */
export function sameEntry(made: TypedEntry, kept: Pick<EntryRef, 'date' | 'memo' | 'lines'>): boolean {
  const a = linesToKeep(made.lines);
  const b = linesToKeep(kept.lines);
  return made.date === kept.date && (made.memo ?? '').trim() === (kept.memo ?? '').trim() && a.length === b.length
    && a.every((l, i) => l.account_netsuite_id === b[i].account_netsuite_id && Number(l.debit_cents) === Number(b[i].debit_cents)
      && Number(l.credit_cents) === Number(b[i].credit_cents) && l.memo === b[i].memo);
}

/** Every month's figures, checks and entries, newest first. */
export function monthViews(input: {
  setup: RentMortgageSetup;
  /** The tenant's name, as its entries' memos have it. */
  tenantName: string;
  books: readonly BookMonth[];
  saved: readonly SavedMonth[];
  entries: ReadonlyMap<string, EntryRef>;
  /** 'YYYY-MM-01'. */
  thisMonth: string;
}): MonthView[] {
  const saved = new Map(input.saved.map((s) => [s.month, s]));
  const views: MonthView[] = [];
  let previousBook: BookMonth | null = null;
  for (const book of input.books) {
    const s = saved.get(book.month) ?? null;
    const before = saved.get(monthBefore(book.month)) ?? null;
    const made = s ? monthEntries({ setup: input.setup, typed: s, tenantName: input.tenantName }) : null;
    const entry = (kind: EntryKind): EntryView | null => {
      const id = kind === 'rent' ? s?.rentEntryId : s?.mortgageEntryId;
      const ref = id ? input.entries.get(id) : undefined;
      if (!s || !ref) return null;
      const now = made?.[kind] ?? null;
      return { ...ref, stale: ref.status === 'draft' && !!now && !sameEntry(now, ref), takenOff: !(kind === 'rent' ? s.rent : s.statement) };
    };
    const entries = { rent: entry('rent'), mortgage: entry('mortgage') };
    views.push({
      month: book.month,
      book,
      rent: s?.rent ?? null,
      statement: s?.statement ?? null,
      updatedAt: s?.updatedAt ?? null,
      updatedBy: s?.updatedBy ?? null,
      rentCheck: rentCheck(book, { thisMonth: book.month === input.thisMonth, entry: entries.rent?.status ?? null }),
      mortgageCheck: mortgageCheck(book, s?.statement ?? null),
      note: statementNote(before?.statement ?? null, s?.statement ?? null),
      rentDefaultCents: s?.rent ? null : rentDefault(book, { typed: before?.rent ?? null, book: previousBook }),
      entries,
    });
    previousBook = book;
  }
  return views.reverse();
}
