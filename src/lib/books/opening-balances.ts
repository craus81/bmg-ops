import { centsToAmount, type BooksCompany, type JournalEntryInput, type JournalLineInput } from './journal';
import { toCents } from './netsuite-gl';
import type { ReportAmount } from './reports';
import { compareRows, trialBalance, type TbAccount, type TbAmount, type TbData, type TbRow, type TbTotals } from './trial-balance';

/**
 * The entry that opens FleetSuite's books on the day they go live
 * (docs/books.md "Going live"). The books already hold NetSuite's balances
 * before 2025 (the starting entry) and FleetSuite's own journal since, so
 * the entry is what still differs from NetSuite's own totals at the end of
 * the month before, laid out as the trial balance is: a line for each
 * account that differs, bringing it to NetSuite's balance, the year's
 * income and expenses on their own accounts and earlier years' net income
 * on retained earnings. So the books open at NetSuite's numbers line for
 * line, and reports, balances and agings carry on as they are. On the
 * receivable and payable accounts it goes customer by customer and vendor by
 * vendor (gl_opening_parties, migration 476), so each one's balance opens at
 * NetSuite's too. It is dated that month's last day as an opening balance
 * (source_type 'opening_balance'), the one kind of entry the books take from
 * before the day they went live (migration 359).
 *
 * Nothing is posted here: the posting run posts it once the books are live
 * (src/lib/books/going-live.ts). The Going live page shows the entry for any
 * month's end, what would stop it posting, and a rehearsal: had the books
 * gone live after that month, FleetSuite's balances since next to
 * NetSuite's. Amounts are whole cents, debit positive.
 */

/** The day the books are planned to go live (owner decision 2026-10-10). */
export const PLANNED_LIVE_FROM = '2027-01-01';

export interface OpeningAccount extends TbAccount {
  /** FleetSuite's id for the account. */
  id: string;
  /** A heading in NetSuite's chart, which takes no postings. */
  is_summary: boolean;
}

export interface OpeningData extends TbData {
  company: string;
  accounts: OpeningAccount[];
}

export type PartyKind = 'customer' | 'vendor';

/** Who the lines on a receivable or payable account name, by the account's type. */
const PARTY_KIND: Readonly<Record<string, PartyKind>> = { accounts_receivable: 'customer', accounts_payable: 'vendor' };

/** A customer's or vendor's part of a receivable or payable account through the day, as gl_opening_parties gives it (migration 476). */
export interface OpeningPartyData {
  /** The account, as the journal's totals name it: NetSuite's id, or 'fs:<id>'. */
  account: string;
  kind: PartyKind;
  /** A FleetSuite customer's id, a vendor's NetSuite id, or '' for the lines that name neither. */
  party: string;
  name: string | null;
  /** What each side moved for them since the starting entry, dollars debit positive. */
  netsuite: string;
  fleetsuite: string;
}

/** One customer's or vendor's line of the entry on a receivable or payable account. */
export interface OpeningPartyLine {
  kind: PartyKind;
  party: string;
  name: string | null;
  /** NetSuite's less FleetSuite's. */
  cents: number;
}

export interface OpeningLine {
  /** NetSuite's id for the account, or 'fs:<id>' for one NetSuite doesn't have. */
  netsuiteAccountId: string;
  /** FleetSuite's id for it; null when the chart doesn't have it yet. */
  accountId: string | null;
  number: string | null;
  name: string;
  /** The account on the day, as the trial balance shows it, in FleetSuite's books and in NetSuite's. */
  fleetsuite: number;
  netsuite: number;
  /** What the entry posts to it: NetSuite's less FleetSuite's. */
  cents: number;
  /**
   * On a receivable or payable account, when the entry is worked out with its customers and vendors: a line for each
   * one whose balance differs, together coming to `cents`. Present even when the account's own balance doesn't differ.
   */
  parties?: OpeningPartyLine[];
}

export interface OpeningEntry {
  company: string;
  /** The month whose end it's at, 'YYYY-MM-01'. */
  month: string;
  /** Its last day, the entry's date. */
  date: string;
  /** The books' first live day, the day after. */
  liveFrom: string;
  lines: OpeningLine[];
  /** What it posts in all, a line for each customer and vendor where it goes by them. */
  debit: number;
  credit: number;
  /** What would stop it posting as it is; none means it would post. */
  problems: string[];
}

export interface RehearsalRow {
  /** NetSuite's id for the account, 'fs:<id>' for one NetSuite doesn't have, null for retained earnings with no account. */
  netsuiteAccountId: string | null;
  number: string | null;
  name: string;
  statement: 'balance_sheet' | 'income_statement';
  retained?: true;
  inChart: boolean;
  fleetsuite: number;
  netsuite: number;
}

export interface Rehearsal {
  /** The month whose end it compares, 'YYYY-MM-01'. */
  through: string;
  /** Its last day. */
  date: string;
  rows: RehearsalRow[];
  totals: { fleetsuite: TbTotals; netsuite: TbTotals };
  /** How many lines differ. */
  differing: number;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => money.format(cents / 100);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 'December 31, 2026' from '2026-12-31'. */
export const longDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

/** The last day of a month ('YYYY-MM-01'), as 'YYYY-MM-DD'. */
export function lastDay(month: string): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
}

/** A day ('YYYY-MM-DD') moved by `days`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const label = (a: { number: string | null; name: string }) => [a.number, a.name].filter(Boolean).join(' ');
const postOf = (cents: number) => `a ${cents < 0 ? 'credit' : 'debit'} of ${dollars(Math.abs(cents))}`;

/** The chart with each account NetSuite doesn't have named by FleetSuite's id, as the journal's totals name it. */
const named = (accounts: readonly OpeningAccount[]) =>
  accounts.map((a) => (a.netsuite_account_id ? a : { ...a, netsuite_account_id: `fs:${a.id}` }));
const journal = (rows: readonly ReportAmount[]): TbAmount[] =>
  rows.map((a) => ({ netsuite_account_id: a.account, debit: a.debit, credit: a.credit, month: a.month }));

/**
 * The entry that would open the books the day after `month` ends: FleetSuite's
 * journal (`fleetsuite`, as gl_books_totals gives it) against NetSuite's own
 * totals, from the same starting entry. With `parties` (gl_opening_parties
 * through the day), it goes customer by customer and vendor by vendor on the
 * receivable and payable accounts. `today` is 'YYYY-MM-DD'.
 */
export function workOutOpeningEntry(
  data: OpeningData,
  fleetsuite: readonly ReportAmount[],
  month: string,
  today: string,
  parties?: readonly OpeningPartyData[],
): OpeningEntry {
  const date = lastDay(month);
  const problems: string[] = [];
  if (today <= date) problems.push(`${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)} isn't over yet, so its balances are still changing.`);
  if (data.opening.length === 0 && data.netsuite.length === 0) {
    problems.push("Nothing has been copied from NetSuite's ledger yet: Trial balance vs NetSuite → Copy now.");
  }
  // The entry is NetSuite's own totals, and it's split by customer and vendor from the copy's lines, so the two have to agree.
  const unmatched = trialBalance(data, month).rows.filter((r) => r.copied !== r.netsuite).length;
  if (unmatched > 0) {
    problems.push(`On ${longDate(date)} the copy of NetSuite's ledger differs from NetSuite's own totals on ${unmatched} `
      + `account${unmatched === 1 ? '' : 's'}: copy it again (Trial balance vs NetSuite → Copy now), or find what differs there.`);
  }

  const accounts = named(data.accounts);
  const tb = trialBalance({ company: data.company, accounts, opening: data.opening, netsuite: data.netsuite, copied: journal(fleetsuite) }, month);
  if (tb.totals.netsuite.debit !== tb.totals.netsuite.credit) {
    problems.push(`NetSuite's balances on ${longDate(date)} don't balance: debits and credits differ by `
      + `${dollars(Math.abs(tb.totals.netsuite.debit - tb.totals.netsuite.credit))}.`);
  }
  const chart = new Map(accounts.map((a) => [a.netsuite_account_id!, a]));

  // What each customer's and vendor's balance differs by, account by account.
  const byAccount = new Map<string, OpeningPartyLine[]>();
  for (const p of parties ?? []) {
    const cents = toCents(p.netsuite) - toCents(p.fleetsuite);
    if (cents === 0) continue;
    byAccount.set(p.account, [...(byAccount.get(p.account) ?? []), { kind: p.kind, party: p.party, name: p.name, cents }]);
  }
  // A receivable or payable account can have customers or vendors that differ when its own balance doesn't, on either side.
  const rows: TbRow[] = [...tb.rows];
  for (const account of byAccount.keys()) {
    if (rows.some((r) => r.netsuiteAccountId === account)) continue;
    const a = chart.get(account);
    rows.push({
      netsuiteAccountId: account, number: a?.number ?? null, name: a?.name ?? `NetSuite account ${account}`, statement: 'balance_sheet',
      inChart: !!a, copied: 0, netsuite: 0,
    });
  }
  rows.sort(compareRows);

  const lines: OpeningLine[] = [];
  for (const r of rows) {
    const cents = r.netsuite - r.copied;
    const a = r.netsuiteAccountId ? chart.get(r.netsuiteAccountId) : undefined;
    const kind = a ? PARTY_KIND[a.account_type] : undefined;
    const split = parties && kind ? byAccount.get(r.netsuiteAccountId!) ?? [] : null;
    if (cents === 0 && !split?.length) continue;
    // Earlier years' net income is on a line of its own only when no one account takes it.
    if (!r.netsuiteAccountId) {
      problems.push(`Earlier years' net income differs from NetSuite's by ${dollars(Math.abs(cents))}, but the chart needs `
        + `exactly one equity account named Retained Earnings that ${data.company} can use to take it.`);
      continue;
    }
    const line: OpeningLine = {
      netsuiteAccountId: r.netsuiteAccountId, accountId: a?.id ?? null, number: r.number, name: r.name, fleetsuite: r.copied, netsuite: r.netsuite, cents,
      ...(split ? { parties: split } : {}),
    };
    if (!a) problems.push(`${label(line)} isn't in FleetSuite's chart yet, but the entry posts ${postOf(cents)} to it: Chart of accounts → Sync now.`);
    else if (a.is_summary) problems.push(`${label(line)} is a heading in NetSuite's chart, which takes no postings, but the entry posts ${postOf(cents)} to it.`);
    else if (a.company && a.company !== data.company) problems.push(`${label(line)} is only for ${a.company}, but ${data.company}'s entry posts ${postOf(cents)} to it.`);
    if (split && kind) {
      // The copy's lines name who each is for, so they add up to NetSuite's own balance only when the copy matches it.
      const total = split.reduce((s, p) => s + p.cents, 0);
      if (total !== cents) {
        problems.push(`${label(line)} takes ${cents ? postOf(cents) : 'nothing'}, but its ${kind}s' lines come to ${total ? postOf(total) : 'nothing'}, `
          + `so it can't go ${kind} by ${kind}: copy NetSuite's ledger again (Trial balance vs NetSuite → Copy now).`);
      }
    }
    lines.push(line);
  }

  const posted = lines.flatMap((l) => (l.parties ? l.parties.map((p) => p.cents) : [l.cents]));
  const debit = posted.reduce((s, c) => s + Math.max(0, c), 0);
  const credit = posted.reduce((s, c) => s + Math.max(0, -c), 0);
  return { company: data.company, month, date, liveFrom: addDays(date, 1), lines, debit, credit, problems };
}

/** The rule opening entries post by. */
export const OPENING_RULE = 'opening_balance@1';

/** The idempotency key of a company's `n`th opening entry: 1 opens the books, each after it trues them up. */
export const openingKey = (company: string, liveFrom: string, n: number) => `opening_balance:${company}:${liveFrom}:${n}`;

/**
 * The entry as the journal takes it (src/lib/books/journal.ts), as a company's
 * `n`th opening entry: 1 opens the books, each after it trues them up to
 * NetSuite's numbers for the day again. Only for an entry with lines and no
 * problems.
 */
export function openingJournalEntry(entry: OpeningEntry, n: number): JournalEntryInput {
  const side = (cents: number) => (cents > 0 ? { debit: centsToAmount(cents) } : { credit: centsToAmount(-cents) });
  const lines: JournalLineInput[] = entry.lines.flatMap((l): JournalLineInput[] => (l.parties
    ? l.parties.map((p) => ({
      accountId: l.accountId!,
      ...side(p.cents),
      memo: p.name,
      customerId: p.kind === 'customer' && p.party ? p.party : null,
      vendorRef: p.kind === 'vendor' && p.party ? p.party : null,
    }))
    : [{ accountId: l.accountId!, ...side(l.cents) }]));
  return {
    company: entry.company as BooksCompany,
    entryDate: entry.date,
    sourceType: 'opening_balance',
    sourceId: null,
    postingRule: OPENING_RULE,
    idempotencyKey: openingKey(entry.company, entry.liveFrom, n),
    memo: `${n === 1 ? 'Opening balances' : 'Opening balances trued up'}: NetSuite's on ${longDate(entry.date)}`,
    lines,
  };
}

/**
 * Had the books gone live after `month`: FleetSuite's balances at the end of
 * `through`, NetSuite's numbers up to then and FleetSuite's own journal
 * since, next to NetSuite's own, laid out as the trial balance is. The
 * entry makes the two agree on the day, so a line differs only where
 * FleetSuite has posted something differently since. Null until a month
 * has ended since.
 */
export function rehearse(data: OpeningData, fleetsuite: readonly ReportAmount[], month: string, through: string): Rehearsal | null {
  if (through <= month) return null;
  const tb = trialBalance({
    company: data.company,
    accounts: named(data.accounts),
    opening: data.opening,
    netsuite: data.netsuite,
    copied: [...data.netsuite.filter((a) => a.month! <= month), ...journal(fleetsuite).filter((a) => a.month! > month)],
  }, through);
  const rows = tb.rows.map(({ copied, ...r }): RehearsalRow => ({ ...r, fleetsuite: copied }));
  return {
    through,
    date: lastDay(through),
    rows,
    totals: { fleetsuite: tb.totals.copied, netsuite: tb.totals.netsuite },
    differing: rows.filter((r) => r.fleetsuite !== r.netsuite).length,
  };
}
