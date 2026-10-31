import type { ReportAmount } from './reports';
import { trialBalance, type TbAccount, type TbAmount, type TbData, type TbTotals } from './trial-balance';

/**
 * The entry that opens FleetSuite's books on the day they go live
 * (docs/books.md "Going live"). The books already hold NetSuite's balances
 * before 2025 (the starting entry) and FleetSuite's own journal since, so
 * the entry is what still differs from NetSuite's own totals at the end of
 * the month before, laid out as the trial balance is: a line for each
 * account that differs, bringing it to NetSuite's balance, the year's
 * income and expenses on their own accounts and earlier years' net income
 * on retained earnings. So the books open at NetSuite's numbers line for
 * line, and reports, balances and agings carry on as they are. It is dated
 * that month's last day as an opening balance (source_type
 * 'opening_balance'), the one kind of entry the books take from before the
 * day they went live (migration 359).
 *
 * Nothing is posted here. The Going live page shows the entry for any
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
const longDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

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
 * totals, from the same starting entry. `today` is 'YYYY-MM-DD'.
 */
export function workOutOpeningEntry(data: OpeningData, fleetsuite: readonly ReportAmount[], month: string, today: string): OpeningEntry {
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
  const chart = new Map(accounts.map((a) => [a.netsuite_account_id, a]));
  const lines: OpeningLine[] = [];
  for (const r of tb.rows) {
    const cents = r.netsuite - r.copied;
    if (cents === 0) continue;
    // Earlier years' net income is on a line of its own only when no one account takes it.
    if (!r.netsuiteAccountId) {
      problems.push(`Earlier years' net income differs from NetSuite's by ${dollars(Math.abs(cents))}, but the chart needs `
        + `exactly one equity account named Retained Earnings that ${data.company} can use to take it.`);
      continue;
    }
    const a = chart.get(r.netsuiteAccountId);
    const line: OpeningLine = {
      netsuiteAccountId: r.netsuiteAccountId, accountId: a?.id ?? null, number: r.number, name: r.name, fleetsuite: r.copied, netsuite: r.netsuite, cents,
    };
    if (!a) problems.push(`${label(line)} isn't in FleetSuite's chart yet, but the entry posts ${postOf(cents)} to it: Chart of accounts → Sync now.`);
    else if (a.is_summary) problems.push(`${label(line)} is a heading in NetSuite's chart, which takes no postings, but the entry posts ${postOf(cents)} to it.`);
    else if (a.company && a.company !== data.company) problems.push(`${label(line)} is only for ${a.company}, but ${data.company}'s entry posts ${postOf(cents)} to it.`);
    lines.push(line);
  }

  const debit = lines.reduce((s, l) => s + Math.max(0, l.cents), 0);
  const credit = lines.reduce((s, l) => s + Math.max(0, -l.cents), 0);
  return { company: data.company, month, date, liveFrom: addDays(date, 1), lines, debit, credit, problems };
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
