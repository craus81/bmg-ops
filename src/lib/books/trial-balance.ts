import { COPY_FROM, monthsBetween, toCents } from './netsuite-gl';

/**
 * Month-end trial balances from the copy of NetSuite's general ledger
 * (migration 361), next to the same balances worked out from NetSuite's own
 * totals. Both start from the same starting entry, NetSuite's balances
 * before 2025, so a month matches exactly when every account's movements up
 * to it do.
 *
 * Laid out the way NetSuite's Trial Balance report is: balance sheet
 * accounts at their month-end balance, income statement accounts for the
 * year to date, and every earlier year's net income in retained earnings.
 * Amounts are whole cents, debit positive.
 */

export interface TbAccount {
  netsuite_account_id: string | null;
  number: string | null;
  name: string;
  account_type: string;
  statement: string;
  /** The company the account is limited to; null or absent = both. */
  company?: string | null;
}

export interface TbAmount {
  netsuite_account_id: string;
  debit: string;
  credit: string;
  /** 'YYYY-MM-01'; absent on starting balances. */
  month?: string;
}

export interface TbData {
  /** The company these amounts are for; picks its retained earnings account. */
  company?: string;
  accounts: TbAccount[];
  /** The starting entry: NetSuite's balances before 2025. */
  opening: TbAmount[];
  /** NetSuite's own movements per account and month. */
  netsuite: TbAmount[];
  /** The same, worked out from the copied lines. */
  copied: TbAmount[];
}

export interface TbMonth {
  /** 'YYYY-MM-01'. */
  month: string;
  matches: boolean;
  /** Trial balance lines that differ (an account, or the retained earnings line). */
  differing: number;
}

export interface TbRow {
  netsuiteAccountId: string | null;
  number: string | null;
  name: string;
  statement: 'balance_sheet' | 'income_statement';
  /** The line for earlier years' net income, when no single retained earnings account takes it. */
  retained?: true;
  /** False for a NetSuite account the chart doesn't have yet. */
  inChart: boolean;
  copied: number;
  netsuite: number;
}

export interface TbTotals {
  debit: number;
  credit: number;
}

export interface TrialBalance {
  rows: TbRow[];
  totals: { copied: TbTotals; netsuite: TbTotals };
}

/** The month the copy starts, shown as its starting balances. */
export const START = 'start';

const net = (a: TbAmount) => toCents(a.debit) - toCents(a.credit);

function byMonth(rows: TbAmount[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.month) continue;
    const m = out.get(r.month) ?? new Map<string, number>();
    m.set(r.netsuite_account_id, (m.get(r.netsuite_account_id) ?? 0) + net(r));
    out.set(r.month, m);
  }
  return out;
}

function openingBalances(rows: TbAmount[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.netsuite_account_id, (out.get(r.netsuite_account_id) ?? 0) + net(r));
  return out;
}

/** The latest month either side has, but never before `floor`. */
export function lastMonth(data: TbData, floor: string): string {
  let last = floor;
  for (const r of [...data.netsuite, ...data.copied]) if (r.month && r.month > last) last = r.month;
  return last;
}

/**
 * For each month from January 2025 through `through`: does its trial
 * balance, laid out as trialBalance() shows it, match NetSuite's line for
 * line? So the month strip and the table never disagree.
 */
export function monthStatuses(data: TbData, through: string): TbMonth[] {
  return monthsBetween(COPY_FROM, through).map((month) => {
    const differing = trialBalance(data, month).rows.filter((r) => r.copied !== r.netsuite).length;
    return { month, matches: differing === 0, differing };
  });
}

const collator = new Intl.Collator('en', { numeric: true });

/**
 * Where earlier years' net income goes, as on NetSuite's reports: the one
 * equity account named Retained Earnings the company can use, or null when
 * there isn't exactly one (it then goes on a line of its own).
 */
export function retainedEarningsAccount<T extends TbAccount>(accounts: readonly T[], company?: string): T | null {
  const found = accounts.filter((a) => a.account_type === 'equity' && a.netsuite_account_id
    && /retained earnings/i.test(a.name) && (!a.company || !company || a.company === company));
  return found.length === 1 ? found[0] : null;
}

const order = (r: Pick<TbRow, 'statement' | 'retained'>) => (r.statement === 'balance_sheet' ? (r.retained ? 1 : 0) : 2);

/** The trial balance's order: the balance sheet, earlier years' net income, then the income statement; numbered accounts by number, then any without a number by name. */
export function compareRows(a: Pick<TbRow, 'statement' | 'retained' | 'number' | 'name'>, b: Pick<TbRow, 'statement' | 'retained' | 'number' | 'name'>): number {
  return order(a) - order(b)
    || Number(a.number === null) - Number(b.number === null)
    || collator.compare(a.number ?? '', b.number ?? '')
    || collator.compare(a.name, b.name);
}

/** The trial balance at the end of `month` ('YYYY-MM-01'), or the starting balances for START. */
export function trialBalance(data: TbData, month: string): TrialBalance {
  const chart = new Map<string, TbAccount>();
  for (const a of data.accounts) if (a.netsuite_account_id) chart.set(a.netsuite_account_id, a);
  const isIncome = (acct: string) => chart.get(acct)?.statement === 'income_statement';

  const opening = openingBalances(data.opening);
  const sides = { copied: byMonth(data.copied), netsuite: byMonth(data.netsuite) };
  const yearStart = month === START ? COPY_FROM : `${month.slice(0, 4)}-01-01`;

  const values = new Map<string, { copied: number; netsuite: number }>();
  const retained = { copied: 0, netsuite: 0 };
  const accounts = new Set<string>([...opening.keys()]);
  for (const side of [sides.copied, sides.netsuite]) {
    for (const [m, accts] of side) if (month !== START && m <= month) for (const acct of accts.keys()) accounts.add(acct);
  }

  for (const acct of accounts) {
    const v = { copied: 0, netsuite: 0 };
    for (const key of ['copied', 'netsuite'] as const) {
      let thisYear = 0;
      let before = opening.get(acct) ?? 0;
      if (month !== START) {
        for (const [m, accts] of sides[key]) {
          const cents = accts.get(acct);
          if (!cents || m > month) continue;
          if (m >= yearStart) thisYear += cents;
          else before += cents;
        }
      }
      if (isIncome(acct)) {
        v[key] = thisYear;
        retained[key] += before;
      } else {
        v[key] = before + thisYear;
      }
    }
    values.set(acct, v);
  }

  // Earlier years' net income sits in retained earnings, as on NetSuite's
  // report: in the one equity account named that, or on a line of its own.
  const reAccount = retainedEarningsAccount(data.accounts, data.company);
  let retainedRow: TbRow | null = null;
  if (reAccount) {
    const id = reAccount.netsuite_account_id!;
    const v = values.get(id) ?? { copied: 0, netsuite: 0 };
    values.set(id, { copied: v.copied + retained.copied, netsuite: v.netsuite + retained.netsuite });
  } else if (retained.copied || retained.netsuite) {
    retainedRow = {
      netsuiteAccountId: null,
      number: null,
      name: 'Retained earnings (net income of earlier years)',
      statement: 'balance_sheet',
      retained: true,
      inChart: true,
      copied: retained.copied,
      netsuite: retained.netsuite,
    };
  }

  const rows: TbRow[] = [];
  for (const [acct, v] of values) {
    if (!v.copied && !v.netsuite) continue;
    const a = chart.get(acct);
    rows.push({
      netsuiteAccountId: acct,
      number: a?.number ?? null,
      name: a?.name ?? `NetSuite account ${acct}`,
      statement: isIncome(acct) ? 'income_statement' : 'balance_sheet',
      inChart: !!a,
      copied: v.copied,
      netsuite: v.netsuite,
    });
  }
  if (retainedRow) rows.push(retainedRow);
  rows.sort(compareRows);

  const total = (key: 'copied' | 'netsuite'): TbTotals => ({
    debit: rows.reduce((s, r) => s + Math.max(0, r[key]), 0),
    credit: rows.reduce((s, r) => s + Math.max(0, -r[key]), 0),
  });
  return { rows, totals: { copied: total('copied'), netsuite: total('netsuite') } };
}
