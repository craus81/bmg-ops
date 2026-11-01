import type { SupabaseClient } from '@supabase/supabase-js';
import { isSuiteqlError, suiteqlQuery, suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { writeSyncStateCursor } from '@/lib/ledger/write';
import { isoDate } from '@/lib/financials-data';
import type { BooksCompany } from './journal';

/**
 * NetSuite's general ledger from 2025, copied into FleetSuite and checked
 * month by month (migration 361; owner decision 2026-10-11, thread
 * "Replacing NetSuite with FleetSuite").
 *
 * What is copied: every posting GL line NetSuite holds for BMG's and 1084's
 * subsidiaries (TransactionAccountingLine), from the January 2025 accounting
 * period on, with its transaction. Everything before is one starting entry
 * per company: NetSuite's total per account before 2025. So the 2024 entries
 * that didn't reflect real activity stay out as transactions while every
 * balance still starts where NetSuite's does.
 *
 * Each run (/api/cron/books-netsuite-gl at :26 on odd hours, and "Copy now"
 * on the Books trial balance page):
 *
 *   1. reads NetSuite's accounting periods, so a transaction counts in the
 *      month it was posted to, as on NetSuite's own reports;
 *   2. reads NetSuite's own totals per subsidiary, account and month and
 *      stores them: the starting entry, and what the copy is checked against;
 *      and, by name, the part of the starting entry on the receivable and
 *      payable accounts each customer and vendor holds (migration 406, for
 *      Customer and vendor balances);
 *   3. works out the same totals from the copy, and copies again every month
 *      that differs: its lines are read in pages, a transaction whose content
 *      hasn't changed is only marked seen, and once the month is through,
 *      whatever NetSuite no longer has in it is removed;
 *   4. refreshes one more month when there's time, the one copied longest
 *      ago, so an edit that moves no money (a memo) still comes across.
 *
 * The first run finds every month different and works through them oldest
 * first. A month can span runs: the cursor is kept in sync_state.
 *
 * Nothing is written to NetSuite. The run is recorded in sync_state as
 * 'books_netsuite_gl' and deliberately left out of HEALTH_MONITORS, like the
 * account sync: the books are hidden from everyone but the owner. For the
 * same reason no amount goes in that record, in a log line, or in the cron's
 * response; the trial balance page reads the amounts itself.
 */

export const BOOKS_GL_SYNC = 'books_netsuite_gl';

/** The first month copied line by line; everything earlier is the starting entry. */
export const COPY_FROM = '2025-01-01';

/** Lines per SuiteQL page (NetSuite's maximum). */
const PAGE_SIZE = 1000;
/** Seconds a run holds the copy lock: past the route's 300 s limit, so a run that dies lets go soon after. */
const LEASE_SECONDS = 330;
/** A page is only started with this much of the budget left. */
const MIN_LEFT_MS = 20_000;
/** The extra month refreshed after the differing ones needs at least this much left. */
const REFRESH_MIN_LEFT_MS = 60_000;
/** NetSuite throws the odd UNEXPECTED_ERROR that succeeds on re-send. */
const SUITEQL_OPTS = { retries: 2 };

type Row = Record<string, unknown>;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const isTrue = (v: unknown): boolean => v === true || text(v).toUpperCase() === 'T';
const numericId = (v: unknown): string | null => (/^\d+$/.test(text(v)) ? text(v) : null);
const reason = (err: unknown) => String((err as any)?.message || err).slice(0, 300);
const glLines = (n: number) => (n === 1 ? '1 GL line' : `${n.toLocaleString('en-US')} GL lines`);

// ── Money ──────────────────────────────────────────────────────────────────

/** Dollars as NetSuite or Postgres hand them over (number or decimal string) → whole cents. */
export function toCents(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) throw new Error(`NetSuite sent an amount FleetSuite can't read (${String(v).slice(0, 40)})`);
  const cents = Math.round(n * 100);
  return cents === 0 ? 0 : cents;
}

/** Whole cents → '1234.56', the exact form the database takes. */
export function centsToString(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ── Months ─────────────────────────────────────────────────────────────────

const MONTH_RE = /^\d{4}-\d{2}-01$/;

/** 'YYYY-MM-01' of the month after. */
export function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Every month from `from` through `to`, both 'YYYY-MM-01'. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 1200; m = nextMonth(m)) out.push(m);
  return out;
}

export const monthOfDate = (iso: string | null): string | null => (iso ? `${iso.slice(0, 7)}-01` : null);

export const PERIODS_QUERY = 'SELECT ap.id, ap.startdate, ap.enddate, ap.isquarter, ap.isyear FROM accountingperiod ap ORDER BY ap.id';

/**
 * NetSuite accounting period id → the month it posts to. Quarters and years
 * hold no postings and are left out; an adjustment period counts in the
 * month it ends.
 */
export function periodMonths(rows: Row[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const id = numericId(row.id);
    if (!id || isTrue(row.isquarter) || isTrue(row.isyear)) continue;
    const month = monthOfDate(isoDate(row.enddate) ?? isoDate(row.startdate));
    if (month) out.set(id, month);
  }
  return out;
}

/**
 * The month a line counts in: its posting period's, or its date's when the
 * periods couldn't be read or don't include that period. The totals and the
 * month filter both follow this, so the two always agree.
 */
export function postingMonth(periodId: unknown, dateMonth: string | null, periods: Map<string, string> | null): string | null {
  const id = numericId(periodId);
  if (periods && id && periods.has(id)) return periods.get(id)!;
  return dateMonth;
}

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Which posting flags to filter on. Both the transaction's and the line's
 * comes first; only the line's is the fallback if NetSuite won't take the
 * transaction's. Whichever the totals query takes, the line queries use too.
 */
export type PostingFilter = 'transaction_and_line' | 'line';
export const POSTING_FILTERS: readonly PostingFilter[] = ['transaction_and_line', 'line'];

/** Line columns: everything, or just what the balances need if NetSuite refuses the extras. */
export type LineColumns = 'full' | 'basic';
export const LINE_COLUMNS: readonly LineColumns[] = ['full', 'basic'];

const postingWhere = (f: PostingFilter) =>
  f === 'transaction_and_line' ? `t.posting = 'T' AND tal.posting = 'T'` : `tal.posting = 'T'`;

/**
 * The line reads also skip lines with no account. NetSuite has those on
 * posting transactions, for lines that post nowhere, and with no account
 * they're on no balance. The totals still read them, so one that carries
 * an amount gets a note (summarizeTotals).
 */
const linesWhere = (f: PostingFilter) => `${postingWhere(f)}
        AND tal.account IS NOT NULL`;

const GL_FROM = `
      FROM transactionaccountingline tal
      JOIN transaction t ON t.id = tal.transaction
      JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline`;

const BASIC_COLUMNS =
  'tal.transaction AS txn_id, tal.transactionline AS line_id, tal.account AS account_id, tal.debit, tal.credit, '
  + 'tl.subsidiary AS subsidiary_id, t.type AS tran_type, t.tranid, t.trandate, t.postingperiod AS period_id';
const EXTRA_COLUMNS =
  ', tl.memo, tl.entity AS line_entity_id, t.entity AS txn_entity_id, '
  + 'tl.location AS location_id, tl.department AS department_id, tl.class AS class_id';

const lineColumns = (c: LineColumns) => (c === 'full' ? BASIC_COLUMNS + EXTRA_COLUMNS : BASIC_COLUMNS);

/** NetSuite's totals per subsidiary, account, period and date month, over all of its history. */
export function totalsQuery(f: PostingFilter): string {
  return `
      SELECT tl.subsidiary AS subsidiary_id, tal.account AS account_id, t.postingperiod AS period_id,
             TO_CHAR(t.trandate, 'YYYY-MM') AS date_month,
             SUM(NVL(tal.debit, 0)) AS debit, SUM(NVL(tal.credit, 0)) AS credit, COUNT(*) AS line_count${GL_FROM}
      WHERE ${postingWhere(f)}
      GROUP BY tl.subsidiary, tal.account, t.postingperiod, TO_CHAR(t.trandate, 'YYYY-MM')
      ORDER BY tl.subsidiary, tal.account, t.postingperiod, TO_CHAR(t.trandate, 'YYYY-MM')
    `;
}

const suiteqlDate = (month: string) => `TO_DATE('${month.slice(5, 7)}/01/${month.slice(0, 4)}', 'MM/DD/YYYY')`;

/** The lines that count in one month, as postingMonth() places them. */
export function monthFilter(month: string, periods: Map<string, string> | null): string {
  if (!MONTH_RE.test(month)) throw new Error(`Not a month: ${month}`);
  const byDate = `t.trandate >= ${suiteqlDate(month)} AND t.trandate < ${suiteqlDate(nextMonth(month))}`;
  if (!periods || periods.size === 0) return `(${byDate})`;
  const ids = [...periods].filter(([, m]) => m === month).map(([id]) => id);
  const unplaced = `(t.postingperiod IS NULL OR t.postingperiod NOT IN (${[...periods.keys()].join(', ')}))`;
  const parts = ids.length ? [`t.postingperiod IN (${ids.join(', ')})`] : [];
  parts.push(`(${unplaced} AND ${byDate})`);
  return `(${parts.join(' OR ')})`;
}

/** One page of a month's lines, whole transactions after `afterTxn`, in transaction and line order. */
export function monthLinesQuery(
  month: string,
  periods: Map<string, string> | null,
  afterTxn: string | null,
  f: PostingFilter,
  c: LineColumns,
): string {
  // Never trust a stored string into SQL, even one we wrote ourselves.
  const after = afterTxn && /^\d+$/.test(afterTxn) ? `\n        AND tal.transaction > ${afterTxn}` : '';
  return `
      SELECT ${lineColumns(c)}${GL_FROM}
      WHERE ${linesWhere(f)}
        AND ${monthFilter(month, periods)}${after}
      ORDER BY tal.transaction, tal.transactionline
    `;
}

/** Every line of one transaction, for the rare one too big for a page. */
export function transactionLinesQuery(txnId: string, f: PostingFilter, c: LineColumns): string {
  if (!/^\d+$/.test(txnId)) throw new Error(`Not a NetSuite id: ${txnId}`);
  return `
      SELECT ${lineColumns(c)}${GL_FROM}
      WHERE ${linesWhere(f)}
        AND tal.transaction = ${txnId}
      ORDER BY tal.transactionline
    `;
}

/**
 * GL lines in the linked subsidiaries that carry an amount but no account,
 * counted by transaction type, so their note can say where in NetSuite
 * they are.
 */
export function noAccountQuery(f: PostingFilter, subsidiaries: string[]): string {
  const ids = subsidiaries.filter((id) => /^\d+$/.test(id));
  if (!ids.length) throw new Error('No NetSuite subsidiary to count lines in');
  return `
      SELECT t.type AS tran_type, COUNT(*) AS line_count${GL_FROM}
      WHERE ${postingWhere(f)}
        AND tal.account IS NULL
        AND (NVL(tal.debit, 0) <> 0 OR NVL(tal.credit, 0) <> 0)
        AND tl.subsidiary IN (${ids.join(', ')})
      GROUP BY t.type
    `;
}

/**
 * The starting entry by name: NetSuite's lines on the receivable and payable
 * accounts per subsidiary, account, name, period and date month, so
 * summarizePartyOpening places them as summarizeTotals places the whole of
 * it. Only the lines that can count before COPY_FROM are read: those dated
 * before it, and those in a posting period before it.
 */
export function partyOpeningQuery(f: PostingFilter, accounts: string[], periods: Map<string, string> | null): string {
  const ids = [...new Set(accounts.filter((id) => /^\d+$/.test(id)))];
  if (!ids.length) throw new Error('No receivable or payable account to read');
  const early = periods ? [...periods].filter(([, month]) => month < COPY_FROM).map(([id]) => id) : [];
  const before = `t.trandate < ${suiteqlDate(COPY_FROM)}${early.length ? ` OR t.postingperiod IN (${early.join(', ')})` : ''}`;
  return `
      SELECT tl.subsidiary AS subsidiary_id, tal.account AS account_id, tl.entity AS line_entity_id, t.entity AS txn_entity_id,
             t.postingperiod AS period_id, TO_CHAR(t.trandate, 'YYYY-MM') AS date_month,
             SUM(NVL(tal.debit, 0)) AS debit, SUM(NVL(tal.credit, 0)) AS credit, COUNT(*) AS line_count${GL_FROM}
      WHERE ${postingWhere(f)}
        AND tal.account IN (${ids.join(', ')})
        AND (${before})
      GROUP BY tl.subsidiary, tal.account, tl.entity, t.entity, t.postingperiod, TO_CHAR(t.trandate, 'YYYY-MM')
    `;
}

// ── NetSuite's totals ──────────────────────────────────────────────────────

export interface AmountRow {
  company: BooksCompany;
  netsuite_account_id: string;
  debit: string;
  credit: string;
  line_count: number;
}

export interface MonthRow extends AmountRow {
  /** 'YYYY-MM-01'. */
  month: string;
}

export interface NetSuiteTotals {
  /** The starting entry: per company and account, everything before COPY_FROM. */
  opening: AmountRow[];
  /** Per company, account and month from COPY_FROM. */
  months: MonthRow[];
  /** GL lines in subsidiaries no company is linked to, by subsidiary id ('' = none given). */
  unlinked: Record<string, number>;
  /** Lines with no account or no month NetSuite could place, counted only where they carry an amount. */
  unplaced: number;
}

interface Sums { debit: number; credit: number; lines: number }

const add = (map: Map<string, Sums>, key: string, debit: number, credit: number, lines: number) => {
  const s = map.get(key) ?? { debit: 0, credit: 0, lines: 0 };
  s.debit += debit;
  s.credit += credit;
  s.lines += lines;
  map.set(key, s);
};

export function summarizeTotals(
  rows: Row[],
  periods: Map<string, string> | null,
  links: Map<string, BooksCompany>,
): NetSuiteTotals {
  const opening = new Map<string, Sums>();
  const months = new Map<string, Sums>();
  const unlinked: Record<string, number> = {};
  let unplaced = 0;
  for (const row of rows) {
    const lines = Math.max(0, Math.trunc(Number(row.line_count) || 0));
    const sub = numericId(row.subsidiary_id);
    const company = sub ? links.get(sub) : undefined;
    if (!company) {
      unlinked[sub ?? ''] = (unlinked[sub ?? ''] ?? 0) + lines;
      continue;
    }
    const account = numericId(row.account_id);
    const dateMonth = /^\d{4}-\d{2}$/.test(text(row.date_month)) ? `${text(row.date_month)}-01` : null;
    const month = postingMonth(row.period_id, dateMonth, periods);
    const debit = toCents(row.debit);
    const credit = toCents(row.credit);
    if (!account || !month) {
      // With no amount they change no balance, NetSuite's or the copy's.
      if (debit !== 0 || credit !== 0) unplaced += lines;
      continue;
    }
    if (month < COPY_FROM) add(opening, `${company}|${account}`, debit, credit, lines);
    else add(months, `${company}|${account}|${month}`, debit, credit, lines);
  }
  return {
    opening: [...opening].map(([key, s]) => {
      const [company, account] = key.split('|');
      return { company: company as BooksCompany, netsuite_account_id: account, debit: centsToString(s.debit), credit: centsToString(s.credit), line_count: s.lines };
    }),
    months: [...months].map(([key, s]) => {
      const [company, account, month] = key.split('|');
      return { company: company as BooksCompany, netsuite_account_id: account, month, debit: centsToString(s.debit), credit: centsToString(s.credit), line_count: s.lines };
    }),
    unlinked,
    unplaced,
  };
}

/** One company's, account's and name's part of the starting entry, as gl_netsuite_store_opening_parties takes it. */
export interface PartyOpeningRow extends AmountRow {
  /** NetSuite's id for the lines' name, the line's own else its transaction's as the copy keeps it; '' for none. */
  entity_id: string;
}

/**
 * The rows of partyOpeningQuery → the starting entry by name. A line is
 * placed in a month as summarizeTotals places it, and only those before
 * COPY_FROM in a linked subsidiary count, so on each account the names add
 * up to the starting entry itself.
 */
export function summarizePartyOpening(
  rows: Row[],
  periods: Map<string, string> | null,
  links: Map<string, BooksCompany>,
): PartyOpeningRow[] {
  const sums = new Map<string, Sums>();
  for (const row of rows) {
    const sub = numericId(row.subsidiary_id);
    const company = sub ? links.get(sub) : undefined;
    const account = numericId(row.account_id);
    const dateMonth = /^\d{4}-\d{2}$/.test(text(row.date_month)) ? `${text(row.date_month)}-01` : null;
    const month = postingMonth(row.period_id, dateMonth, periods);
    if (!company || !account || !month || month >= COPY_FROM) continue;
    const entity = numericId(row.line_entity_id) ?? numericId(row.txn_entity_id) ?? '';
    add(sums, `${company}|${account}|${entity}`, toCents(row.debit), toCents(row.credit), Math.max(0, Math.trunc(Number(row.line_count) || 0)));
  }
  return [...sums].map(([key, s]) => {
    const [company, account, entity] = key.split('|');
    return {
      company: company as BooksCompany, netsuite_account_id: account, entity_id: entity,
      debit: centsToString(s.debit), credit: centsToString(s.credit), line_count: s.lines,
    };
  });
}

/** NetSuite's transaction type codes, named as its screens name them. Any other code shows as it is. */
export const TRAN_TYPE_NAMES: Record<string, string> = {
  Build: 'Assembly Build', CardChrg: 'Credit Card', CardRfnd: 'Credit Card Refund', CashRfnd: 'Cash Refund',
  CashSale: 'Cash Sale', Check: 'Check', CustCred: 'Credit Memo', CustDep: 'Customer Deposit', CustInvc: 'Invoice',
  CustPymt: 'Payment', CustRfnd: 'Customer Refund', DepAppl: 'Deposit Application', Deposit: 'Deposit',
  ExpRept: 'Expense Report', FxReval: 'Currency Revaluation', InvAdjst: 'Inventory Adjustment',
  InvTrnfr: 'Inventory Transfer', ItemRcpt: 'Item Receipt', ItemShip: 'Item Fulfillment', Journal: 'Journal',
  TaxPymt: 'Sales Tax Payment', Transfer: 'Transfer', Unbuild: 'Assembly Unbuild', VendBill: 'Bill', VendCred: 'Bill Credit',
  VendPymt: 'Bill Payment',
};

/** How many transaction types the note names before it lumps the rest together. */
const NOTE_TYPES = 6;

/**
 * The note about lines in NetSuite with an amount but no account (or
 * month). With noAccountQuery's counts it names the transaction types
 * they're on; without them it gives the totals' count alone.
 */
export function noAccountNote(unplaced: number, byType: Row[] | null): string {
  const types = (byType ?? [])
    .map((r) => ({ type: text(r.tran_type) || 'Unknown', lines: Math.max(0, Math.trunc(Number(r.line_count) || 0)) }))
    .filter((t) => t.lines > 0)
    .sort((a, b) => b.lines - a.lines || a.type.localeCompare(b.type));
  if (!types.length) {
    const one = unplaced === 1;
    return `${glLines(unplaced)} in NetSuite with no account or month ${one ? "isn't" : "aren't"} copied, though ${one ? 'it carries an amount' : 'they carry amounts'}.`;
  }
  const n = types.reduce((sum, t) => sum + t.lines, 0);
  const named = types.slice(0, NOTE_TYPES).map((t) => `${TRAN_TYPE_NAMES[t.type] ?? t.type} ${t.lines.toLocaleString('en-US')}`);
  const rest = types.slice(NOTE_TYPES).reduce((sum, t) => sum + t.lines, 0);
  if (rest) named.push(`other types ${rest.toLocaleString('en-US')}`);
  const one = n === 1;
  return `${glLines(n)} in NetSuite ${one ? 'carries' : 'carry'} an amount but no account, so ${one ? "it isn't" : "they aren't"} copied. `
    + `By transaction type: ${named.join(', ')}.`;
}

/** Months whose totals differ between NetSuite and the copy, oldest first. */
export function monthsThatDiffer(netsuite: MonthRow[], copied: MonthRow[]): string[] {
  const sums = (rows: MonthRow[]) => {
    const m = new Map<string, Sums>();
    for (const r of rows) {
      if (r.month < COPY_FROM) continue;
      add(m, `${r.company}|${r.netsuite_account_id}|${r.month}`, toCents(r.debit), toCents(r.credit), Number(r.line_count) || 0);
    }
    return m;
  };
  const a = sums(netsuite);
  const b = sums(copied);
  const months = new Set<string>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    if (!x || !y || x.debit !== y.debit || x.credit !== y.credit || x.lines !== y.lines) months.add(key.split('|')[2]);
  }
  return [...months].sort();
}

// ── Lines ──────────────────────────────────────────────────────────────────

export interface CopyLine {
  line_id: string;
  company: BooksCompany;
  netsuite_account_id: string;
  debit: string;
  credit: string;
  memo: string | null;
  entity_id: string | null;
  location_id: string | null;
  department_id: string | null;
  class_id: string | null;
}

export interface CopyTransaction {
  netsuite_id: string;
  tran_type: string;
  tranid: string | null;
  trandate: string;
  posting_month: string;
  posting_period_id: string | null;
  lines: CopyLine[];
}

/**
 * A page of NetSuite line rows → whole transactions as gl_netsuite_apply
 * takes them. Lines of subsidiaries no company is linked to are left out
 * (counted in `elsewhere`). Every field is always present, in line order,
 * so unchanged content hashes the same on every run.
 */
export function groupLines(
  rows: Row[],
  periods: Map<string, string> | null,
  links: Map<string, BooksCompany>,
): { transactions: CopyTransaction[]; kept: number; elsewhere: number } {
  const byId = new Map<string, CopyTransaction>();
  const seen = new Set<string>();
  let kept = 0;
  let elsewhere = 0;
  for (const row of rows) {
    const txnId = numericId(row.txn_id);
    const lineId = numericId(row.line_id);
    if (!txnId || !lineId) throw new Error(`NetSuite sent a GL line without a transaction or line id (${text(row.txn_id)}/${text(row.line_id)})`);
    if (seen.has(`${txnId}|${lineId}`)) {
      throw new Error(
        `NetSuite sent more than one GL line for line ${lineId} of transaction ${txnId}. That happens when NetSuite keeps more `
        + 'than one accounting book, and FleetSuite copies one, so nothing from this page was copied.',
      );
    }
    seen.add(`${txnId}|${lineId}`);

    const sub = numericId(row.subsidiary_id);
    const company = sub ? links.get(sub) : undefined;
    if (!company) {
      elsewhere++;
      continue;
    }
    const account = numericId(row.account_id);
    if (!account) throw new Error(`NetSuite sent a GL line with no account (transaction ${txnId}, line ${lineId})`);

    let txn = byId.get(txnId);
    if (!txn) {
      const trandate = isoDate(row.trandate);
      if (!trandate) throw new Error(`NetSuite transaction ${txnId} has a date FleetSuite can't read (${text(row.trandate).slice(0, 20)})`);
      const month = postingMonth(row.period_id, monthOfDate(trandate), periods)!;
      txn = {
        netsuite_id: txnId,
        tran_type: text(row.tran_type) || 'Unknown',
        tranid: text(row.tranid) || null,
        trandate,
        posting_month: month,
        posting_period_id: numericId(row.period_id),
        lines: [],
      };
      byId.set(txnId, txn);
    }
    txn.lines.push({
      line_id: lineId,
      company,
      netsuite_account_id: account,
      debit: centsToString(toCents(row.debit)),
      credit: centsToString(toCents(row.credit)),
      memo: text(row.memo) || null,
      entity_id: numericId(row.line_entity_id) ?? numericId(row.txn_entity_id),
      location_id: numericId(row.location_id),
      department_id: numericId(row.department_id),
      class_id: numericId(row.class_id),
    });
    kept++;
  }
  const transactions = [...byId.values()].sort((a, b) => Number(a.netsuite_id) - Number(b.netsuite_id));
  for (const t of transactions) t.lines.sort((a, b) => Number(a.line_id) - Number(b.line_id));
  return { transactions, kept, elsewhere };
}

// ── State kept between runs ────────────────────────────────────────────────

/** Where a month's copy stopped, when it ran out of time. */
export interface SweepCursor {
  month: string;
  /** Marks every transaction this pass over the month sees. */
  sweep: string;
  /** Continue with NetSuite transaction ids above this one. */
  afterTxn: string | null;
  /** Lines of our companies read so far in this pass. */
  lines: number;
}

export interface GlCopyState {
  resume: SweepCursor | null;
  /** Month → when its last full copy finished. */
  lastSwept: Record<string, string>;
}

/** sync_state.last_result is data, so every field is checked before it's used, and above all before it goes into SQL. */
export function parseGlState(lastResult: unknown): GlCopyState {
  const r = (lastResult ?? {}) as Record<string, any>;
  const state: GlCopyState = { resume: null, lastSwept: {} };
  const c = r.resume;
  if (
    c && typeof c === 'object' && typeof c.month === 'string' && MONTH_RE.test(c.month)
    && typeof c.sweep === 'string' && c.sweep.trim()
    && (c.afterTxn === null || c.afterTxn === undefined || (typeof c.afterTxn === 'string' && /^\d+$/.test(c.afterTxn)))
  ) {
    state.resume = { month: c.month, sweep: c.sweep, afterTxn: c.afterTxn ?? null, lines: Math.max(0, Number(c.lines) || 0) };
  }
  if (r.lastSwept && typeof r.lastSwept === 'object') {
    for (const [month, at] of Object.entries(r.lastSwept)) {
      if (MONTH_RE.test(month) && typeof at === 'string' && !Number.isNaN(Date.parse(at))) state.lastSwept[month] = at;
    }
  }
  return state;
}

// ── The run ────────────────────────────────────────────────────────────────

export interface GlCopyResult {
  /** How months were placed: by NetSuite's posting periods, or by transaction date when those couldn't be read. */
  monthsBy?: 'posting_period' | 'transaction_date';
  /** When NetSuite's totals were read. */
  netsuiteAsOf?: string;
  /** Months from January 2025 through the latest NetSuite has. */
  monthsChecked?: number;
  /** Months ('YYYY-MM-01') that differed from NetSuite before this run copied anything. */
  monthsDiffering?: string[];
  /** Months copied in full this run. */
  swept?: string[];
  transactionsCopied?: number;
  transactionsUnchanged?: number;
  transactionsRemoved?: number;
  linesCopied?: number;
  /** Rows of the starting entry by name stored this run (customers and vendors with lines before 2025). */
  openingNames?: number;
  /** Stopped for time with months still to copy; the next run carries on. */
  partial?: boolean;
  /** What the run couldn't do, in plain words. */
  notes?: string[];
  /** Another copy was running, so this one did nothing. */
  skipped?: string;
  error?: string;
}

type SuiteqlAll = (query: string) => Promise<Row[]>;
type SuiteqlPage = (query: string, limit: number) => Promise<Row[]>;

export interface GlCopyDeps {
  /** Every row of a query (all pages). */
  query?: SuiteqlAll;
  /** The first `limit` rows of a query. */
  page?: SuiteqlPage;
  /** Lines per page; tests use small pages to cross page boundaries. */
  pageSize?: number;
  now?: () => number;
}

const isRejectedQuery = (err: unknown) => isSuiteqlError(err) && err.status === 400;

/** The first variant NetSuite accepts. A 400 moves on to the next; anything else, or the last 400, is thrown. */
async function firstAccepted<T>(variants: readonly T[], run: (v: T) => Promise<Row[]>): Promise<{ variant: T; rows: Row[] }> {
  let lastErr: unknown = new Error('no query variants');
  for (const variant of variants) {
    try {
      return { variant, rows: await run(variant) };
    } catch (err) {
      lastErr = err;
      if (!isRejectedQuery(err)) throw err;
    }
  }
  throw lastErr;
}

const monthLabel = (month: string) =>
  new Date(`${month}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Step 2's second part: the starting entry by name on the receivable and
 * payable accounts, for Customer and vendor balances. Read only when the
 * starting entry has lines on them; with none it's emptied. When NetSuite
 * won't give it, or it can't be stored, the copy carries on and the split
 * stored last time stays, since Customer and vendor balances says when it
 * no longer adds up to the starting entry.
 */
async function storePartyOpening(
  service: SupabaseClient,
  ctx: {
    totals: NetSuiteTotals;
    posting: PostingFilter;
    periods: Map<string, string> | null;
    links: Map<string, BooksCompany>;
    notes: string[];
    query: SuiteqlAll;
    result: GlCopyResult;
  },
): Promise<void> {
  const keep = "so Customer and vendor balances keeps the split by name it had";
  const { data: accountRows, error: accountErr } = await service
    .from('gl_accounts')
    .select('netsuite_account_id')
    .in('account_type', ['accounts_receivable', 'accounts_payable'])
    .not('netsuite_account_id', 'is', null);
  if (accountErr) {
    ctx.notes.push(`The chart's receivable and payable accounts couldn't be read (${accountErr.message}), ${keep}.`);
    return;
  }
  const partyAccounts = new Set(((accountRows || []) as Array<{ netsuite_account_id: string | null }>)
    .map((a) => numericId(a.netsuite_account_id)).filter((id): id is string => !!id));
  const early = [...new Set(ctx.totals.opening
    .filter((r) => partyAccounts.has(r.netsuite_account_id) && r.line_count > 0)
    .map((r) => r.netsuite_account_id))];
  let parties: PartyOpeningRow[] = [];
  if (early.length) {
    try {
      parties = summarizePartyOpening(await ctx.query(partyOpeningQuery(ctx.posting, early, ctx.periods)), ctx.periods, ctx.links);
    } catch (err) {
      ctx.notes.push(`NetSuite wouldn't give the names on its receivable and payable accounts before 2025 (${reason(err)}), ${keep}.`);
      return;
    }
  }
  const saved = await service.rpc('gl_netsuite_store_opening_parties', { p: { parties } });
  if (saved.error) {
    ctx.notes.push(`The starting entry by name couldn't be stored (${saved.error.message}), ${keep}.`);
    return;
  }
  ctx.result.openingNames = Number(saved.data) || 0;
}

export async function copyNetSuiteGl(
  service: SupabaseClient,
  opts: { deadline: number; deps?: GlCopyDeps },
): Promise<GlCopyResult & { heartbeat?: HeartbeatResult }> {
  const now = opts.deps?.now ?? Date.now;
  // A background copy can wait out NetSuite's occasional transient error.
  const query: SuiteqlAll = opts.deps?.query ?? ((q) => suiteqlQueryAll(q, PAGE_SIZE, SUITEQL_OPTS));
  const page: SuiteqlPage = opts.deps?.page
    ?? (async (q, limit) => ((await suiteqlQuery(q, limit, 0, SUITEQL_OPTS))?.items ?? []) as Row[]);
  const pageSize = opts.deps?.pageSize ?? PAGE_SIZE;
  const timeLeft = () => opts.deadline - now();
  const startedAt = now();

  // The state goes into every write of the run's record, so read it first.
  const prev = await service.from('sync_state').select('last_result').eq('sync_type', BOOKS_GL_SYNC).maybeSingle();
  const state = parseGlState(prev.data?.last_result);

  // Invoice posting (invoice-posting.ts) takes the same lock, since it reads the copy.
  const holder = crypto.randomUUID();
  const claim = await service.rpc('gl_netsuite_claim_copy', { p_holder: holder, p_seconds: LEASE_SECONDS });
  if (!claim.error && claim.data !== true) return { skipped: 'Another books job is running.' };

  const result: GlCopyResult = { swept: [], transactionsCopied: 0, transactionsUnchanged: 0, transactionsRemoved: 0, linesCopied: 0 };
  const notes: string[] = [];
  const record = () => ({ ...result, ...(notes.length ? { notes } : {}), resume: state.resume, lastSwept: state.lastSwept });

  try {
    if (claim.error) throw new Error(`Couldn't start the copy: ${claim.error.message}`);

    const { data: companyRows, error: companyErr } = await service
      .from('gl_companies')
      .select('code, name, netsuite_subsidiary_id');
    if (companyErr) throw new Error(companyErr.message);
    const links = new Map<string, BooksCompany>();
    for (const c of (companyRows || []) as Array<{ code: BooksCompany; name: string; netsuite_subsidiary_id: string | null }>) {
      if (c.netsuite_subsidiary_id) links.set(String(c.netsuite_subsidiary_id), c.code);
      else notes.push(`${c.name} isn't linked to a NetSuite subsidiary yet, so none of its lines are copied.`);
    }
    if (links.size === 0) throw new Error('No company is linked to a NetSuite subsidiary yet.');

    // 1. Months follow NetSuite's posting periods when they can be read.
    let periods: Map<string, string> | null = null;
    try {
      periods = periodMonths(await query(PERIODS_QUERY));
      if (periods.size === 0) periods = null;
    } catch (err) {
      const byDate = 'so each transaction counts in the month of its date rather than the month it was posted to';
      // SuiteQL's way of saying the role lacks the permission.
      notes.push(/Record 'accountingperiod' was not found/i.test(String((err as any)?.message || err))
        ? `NetSuite's integration role can't see accounting periods, ${byDate}. Giving the role Manage Accounting Periods (View) on its Setup tab fixes that.`
        : `NetSuite wouldn't list its accounting periods (${reason(err)}), ${byDate}.`);
    }
    result.monthsBy = periods ? 'posting_period' : 'transaction_date';

    // 2. NetSuite's own totals: the starting entry, and what the copy is checked against.
    const { variant: posting, rows: totalRows } = await firstAccepted(POSTING_FILTERS, (f) => query(totalsQuery(f)));
    if (posting === 'line') notes.push("NetSuite wouldn't filter on the transaction's posting flag, so only each line's is used.");
    const totals = summarizeTotals(totalRows, periods, links);
    for (const [sub, n] of Object.entries(totals.unlinked)) {
      notes.push(sub
        ? `NetSuite subsidiary ${sub} has ${glLines(n)} that ${n === 1 ? "isn't" : "aren't"} copied, because no company here is linked to it.`
        : `${glLines(n)} in NetSuite with no subsidiary ${n === 1 ? 'is' : 'are'} not copied.`);
    }
    if (totals.unplaced) {
      // Which transactions they're on, when NetSuite will count them; the note does without otherwise.
      let byType: Row[] | null = null;
      try {
        byType = await query(noAccountQuery(posting, [...links.keys()]));
      } catch {
        byType = null;
      }
      notes.push(noAccountNote(totals.unplaced, byType));
    }
    if (totals.opening.length === 0 && totals.months.length === 0) {
      throw new Error("NetSuite returned no GL lines for BMG or 1084, so nothing was changed. If that's wrong, check that the integration role can still see every transaction type.");
    }
    const stored = await service.rpc('gl_netsuite_store_totals', { p: { opening: totals.opening, months: totals.months } });
    if (stored.error) throw new Error(stored.error.message);
    result.netsuiteAsOf = new Date(now()).toISOString();
    await storePartyOpening(service, { totals, posting, periods, links, notes, query, result });

    // 3. Copy every month that differs, carrying on from a cut-off month first.
    const copiedTotals = await service.rpc('gl_netsuite_totals', { p_company: null });
    if (copiedTotals.error) throw new Error(copiedTotals.error.message);
    const differing = monthsThatDiffer(totals.months, ((copiedTotals.data as any)?.copied ?? []) as MonthRow[]);
    result.monthsDiffering = differing;

    const currentMonth = monthOfDate(new Date(now()).toISOString().slice(0, 10))!;
    const lastMonth = totals.months.reduce((max, r) => (r.month > max ? r.month : max), currentMonth);
    const allMonths = monthsBetween(COPY_FROM, lastMonth);
    result.monthsChecked = allMonths.length;

    const expectedLines = new Map<string, number>();
    for (const r of totals.months) expectedLines.set(r.month, (expectedLines.get(r.month) ?? 0) + r.line_count);

    let columns: LineColumns | null = null;
    const fetchPage = async (month: string, afterTxn: string | null): Promise<Row[]> => {
      if (columns) return page(monthLinesQuery(month, periods, afterTxn, posting, columns), pageSize);
      const first = await firstAccepted(LINE_COLUMNS, (c) => page(monthLinesQuery(month, periods, afterTxn, posting, c), pageSize));
      columns = first.variant;
      if (columns === 'basic') notes.push("NetSuite wouldn't give the lines' memo, name, location, department and class, so the copy has accounts and amounts only.");
      return first.rows;
    };

    // One full pass over a month: 'done', or 'time' when it stopped with the cursor saved.
    const sweepMonth = async (month: string): Promise<'done' | 'time'> => {
      const cursor: SweepCursor = state.resume?.month === month
        ? state.resume
        : { month, sweep: crypto.randomUUID(), afterTxn: null, lines: 0 };
      state.resume = cursor;
      for (;;) {
        if (timeLeft() < MIN_LEFT_MS) {
          await writeSyncStateCursor(service, BOOKS_GL_SYNC, record());
          return 'time';
        }
        let rows = await fetchPage(month, cursor.afterTxn);
        const full = rows.length >= pageSize;
        let after = cursor.afterTxn;
        if (rows.length) {
          const lastTxn = text(rows[rows.length - 1].txn_id);
          if (!full) {
            after = lastTxn;
          } else if (text(rows[0].txn_id) === lastTxn) {
            // One transaction fills the page: read it whole.
            rows = await query(transactionLinesQuery(lastTxn, posting, columns ?? 'basic'));
            after = lastTxn;
          } else {
            // The page may end partway through its last transaction, so that one starts the next page.
            rows = rows.filter((r) => text(r.txn_id) !== lastTxn);
            after = text(rows[rows.length - 1].txn_id);
          }
          const { transactions, kept } = groupLines(rows, periods, links);
          if (transactions.length) {
            const applied = await service.rpc('gl_netsuite_apply', { p: { sweep: cursor.sweep, transactions } });
            if (applied.error) throw new Error(applied.error.message);
            const a = (applied.data ?? {}) as { replaced?: number; unchanged?: number; lines?: number };
            result.transactionsCopied! += a.replaced ?? 0;
            result.transactionsUnchanged! += a.unchanged ?? 0;
            result.linesCopied! += a.lines ?? 0;
          }
          cursor.lines += kept;
        }
        cursor.afterTxn = after;
        if (!full) break;
        await writeSyncStateCursor(service, BOOKS_GL_SYNC, record());
      }

      // Through the month: what NetSuite no longer has in it goes, unless
      // the pass read so much less than NetSuite's totals promised that it
      // looks cut short.
      const expected = expectedLines.get(month) ?? 0;
      if (expected > 0 && cursor.lines * 2 < expected) {
        notes.push(`The copy of ${monthLabel(month)} read ${cursor.lines.toLocaleString('en-US')} of NetSuite's ${glLines(expected)}, so nothing was removed from it this time.`);
      } else {
        const finished = await service.rpc('gl_netsuite_finish_month', { p_month: month, p_sweep: cursor.sweep });
        if (finished.error) throw new Error(finished.error.message);
        result.transactionsRemoved! += Number(finished.data) || 0;
      }
      state.resume = null;
      state.lastSwept[month] = new Date(now()).toISOString();
      result.swept!.push(month);
      await writeSyncStateCursor(service, BOOKS_GL_SYNC, record());
      return 'done';
    };

    const queue = [...new Set([...(state.resume ? [state.resume.month] : []), ...differing])];
    for (const month of queue) {
      if (timeLeft() < MIN_LEFT_MS || (await sweepMonth(month)) === 'time') {
        result.partial = true;
        break;
      }
    }

    // 4. With time to spare, refresh the month copied longest ago.
    if (!result.partial && timeLeft() >= REFRESH_MIN_LEFT_MS) {
      const stale = allMonths
        .filter((m) => !result.swept!.includes(m))
        .sort((a, b) => (state.lastSwept[a] ?? '').localeCompare(state.lastSwept[b] ?? '') || a.localeCompare(b))[0];
      if (stale && (await sweepMonth(stale)) === 'time') result.partial = true;
    }
  } catch (err) {
    result.error = reason(err);
  } finally {
    if (!claim.error) {
      const released = await service.rpc('gl_netsuite_release_copy', { p_holder: holder });
      if (released.error) console.error('[books] could not release the NetSuite GL copy lock:', released.error.message);
    }
  }

  const heartbeat = await recordHeartbeat(service, BOOKS_GL_SYNC, record(), {
    startedAt,
    records: result.linesCopied ?? null,
    touchLastSyncedAt: !result.partial && !result.error,
  });
  return { ...result, ...(notes.length ? { notes } : {}), heartbeat };
}
