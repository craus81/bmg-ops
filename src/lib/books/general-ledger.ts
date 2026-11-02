import { toCents } from './netsuite-gl';
import { detailDocuments, runningBalances, type AccountDocumentsData, type LedgerRow } from './report-detail';
import { lineSpan, yearClosings, type Pair, type ReportData } from './reports';

/**
 * The general ledger in the year-end package (part 76, docs/books.md "The
 * year-end package"): every account with a balance at either end of the
 * months, or anything moving it in them on either side, in the order the
 * trial balance at their end lists accounts, each with the documents that
 * moved it by date and each side's balance after each. Each runs from its
 * balance before the months (a balance sheet account's; income and expenses
 * start the year from nothing), through earlier years' net income coming
 * into retained earnings at each January, to its line on the trial balance.
 * The documents are each account's own download's (gl_books_account_documents,
 * migration 460), read only for the accounts that moved. Amounts are whole
 * cents, debits positive, as the trial balance shows them.
 */

export interface LedgerAccount {
  /** Its NetSuite id, or fs:<id> for one NetSuite doesn't have. */
  key: string;
  number: string | null;
  name: string;
  /** False for a NetSuite account FleetSuite's chart doesn't have yet. */
  inChart: boolean;
  /** Something moved it in the months on either side, so it has documents to read. */
  moved: boolean;
}

export interface LedgerBlock extends LedgerAccount {
  rows: LedgerRow[];
  /** Documents that moved it in the months, and how many of them are listed. */
  documents: number;
  listed: number;
  /** The copy of NetSuite's ledger doesn't hold all NetSuite's own totals say moved it, so NetSuite's balance stops short of its line. */
  short: boolean;
}

type Range = { from: string; to: string };

const collator = new Intl.Collator('en', { numeric: true });
const keyOf = (a: ReportData['accounts'][number]) => a.netsuite_account_id ?? `fs:${a.id}`;
const isZero = (p: Pair | null) => !p || (!p.fleetsuite && !p.netsuite);

/**
 * The accounts the general ledger lists for the months from `from` through
 * `to` ('YYYY-MM-01'): balance sheet accounts, then income and expenses, each
 * by number and name, as the trial balance orders them.
 */
export function ledgerAccounts(data: ReportData, range: Range): LedgerAccount[] {
  const chart = new Map(data.accounts.map((a) => [keyOf(a), a]));
  const within = (month: string | undefined) => !!month && month >= range.from && month <= range.to;
  // A month's debits and credits can come to nothing on an account they still moved.
  const touches = (r: { debit: string; credit: string }) => toCents(r.debit) !== 0 || toCents(r.credit) !== 0;
  const moved = new Set([
    ...data.netsuite.filter((r) => within(r.month) && touches(r)).map((r) => r.netsuite_account_id),
    ...data.fleetsuite.filter((r) => within(r.month) && touches(r)).map((r) => r.account),
  ]);
  const keys = new Set([
    ...chart.keys(),
    ...data.opening.map((r) => r.netsuite_account_id),
    ...data.netsuite.map((r) => r.netsuite_account_id),
    ...data.fleetsuite.map((r) => r.account),
  ]);
  const listed = [...keys].filter((key) => {
    if (moved.has(key)) return true;
    const span = lineSpan(data, 'trial_balance', key, range);
    return !isZero(span.starting) || !isZero(span.ending);
  });
  const incomeStatement = (key: string) => chart.get(key)?.statement === 'income_statement';
  return listed
    .map((key) => {
      const account = chart.get(key);
      return { key, number: account?.number ?? null, name: account?.name ?? `NetSuite account ${key}`, inChart: !!account, moved: moved.has(key) };
    })
    .sort((x, y) => Number(incomeStatement(x.key)) - Number(incomeStatement(y.key))
      || Number(x.number === null) - Number(y.number === null)
      || collator.compare(x.number ?? '', y.number ?? '')
      || collator.compare(x.name, y.name));
}

/**
 * The general ledger for the months, from the documents read for the
 * accounts that moved (`found`, by account key): each account's rows as its
 * own download lists them (runningBalances in report-detail.ts).
 */
export function generalLedger(data: ReportData, range: Range, found: ReadonlyMap<string, AccountDocumentsData>): LedgerBlock[] {
  return ledgerAccounts(data, range).map((account) => {
    const span = lineSpan(data, 'trial_balance', account.key, range);
    const docs = found.get(account.key);
    const copied = span.sign * toCents(docs?.netsuite);
    return {
      ...account,
      rows: runningBalances(span, yearClosings(data, 'trial_balance', account.key, range), docs ? detailDocuments(docs, span.sign) : []),
      documents: docs?.documents ?? 0,
      listed: docs?.rows.length ?? 0,
      short: copied !== span.moved.netsuite,
    };
  });
}
