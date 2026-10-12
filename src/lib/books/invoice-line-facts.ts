import { isSuiteqlError } from '@/lib/netsuite';
import { namesField } from './netsuite-lists';
import type { LineFacts, LineFactsRead } from './invoice-check';

/**
 * What the copy of an invoice's lines doesn't keep, asked of NetSuite each
 * time invoices are checked (docs/books.md "Invoices"): which lines NetSuite
 * itself flags as cost of goods, which line is a discount or markup set at
 * the top of the invoice, and each line's own amount.
 *
 * The ledger mirror's line read (src/lib/ledger/netsuite-mirror.ts) doesn't
 * ask for these, and having it ask would mean reading every invoice again.
 * So the check asks for its month's invoices, which also shows whether these
 * are what the invoice rule needs before posting depends on them.
 *
 * Only reads. Nothing here is stored or logged.
 */

type Row = Record<string, unknown>;
type SuiteqlAll = (query: string) => Promise<Row[]>;

type Fact = keyof LineFacts;

/** Each fact and the transactionline column it's read from. */
export const FACT_COLUMNS: ReadonlyArray<{ fact: Fact; column: string }> = [
  { fact: 'cogs', column: 'iscogs' },
  { fact: 'topDiscount', column: 'transactiondiscount' },
  { fact: 'amount', column: 'foreignamount' },
];

/** Transactions per query: their ids ride in the SQL. */
const CHUNK = 100;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const isTrue = (v: unknown): boolean => v === true || text(v).toUpperCase() === 'T';
/** NetSuite refused the query (400), or answered 500 for a column it won't give. */
const refused = (err: unknown) => isSuiteqlError(err) && (err.status === 400 || err.status === 500);

/** Every line but the invoice's own of these transactions, with the given columns. */
export function factsQuery(ids: string[], columns: readonly string[]): string {
  // Never trust a stored string into SQL, even one we wrote ourselves.
  if (!ids.length || ids.some((id) => !/^\d+$/.test(id))) throw new Error('Not NetSuite ids');
  return `
      SELECT tl.transaction AS txn_id, tl.id AS line_id${columns.map((c) => `, tl.${c}`).join('')}
      FROM transactionline tl
      WHERE tl.transaction IN (${ids.join(', ')})
        AND tl.mainline = 'F'
      ORDER BY tl.transaction, tl.id
    `;
}

function put(lines: Map<string, LineFacts>, rows: Row[], read: ReadonlyArray<{ fact: Fact; column: string }>) {
  for (const row of rows) {
    const key = `${text(row.txn_id)}:${text(row.line_id)}`;
    const facts = lines.get(key) ?? {};
    for (const { fact, column } of read) {
      const value = row[column];
      if (fact === 'amount') facts.amount = value === null || value === undefined || value === '' ? null : String(value);
      else facts[fact] = isTrue(value);
    }
    lines.set(key, facts);
  }
}

/**
 * The facts for every line of these NetSuite transactions. When NetSuite
 * refuses the query naming a column, that fact is dropped and the read is
 * tried again; when it refuses without naming one, or answers 500, each fact
 * is read on its own, so only the ones that fail are missing. Any other
 * failure is thrown.
 */
export async function readLineFacts(query: SuiteqlAll, transactionIds: string[]): Promise<LineFactsRead> {
  const ids = [...new Set(transactionIds)].filter((id) => /^\d+$/.test(id));
  const lines = new Map<string, LineFacts>();
  let columns = [...FACT_COLUMNS];
  const missing = new Set<Fact>();
  let oneByOne = false;

  for (let i = 0; i < ids.length && columns.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    while (!oneByOne && columns.length) {
      try {
        put(lines, await query(factsQuery(batch, columns.map((c) => c.column))), columns);
        break;
      } catch (err) {
        if (!refused(err)) throw err;
        const named = isSuiteqlError(err) && err.status === 400 ? columns.filter((c) => namesField(err, c.column)) : [];
        if (named.length === 0) oneByOne = true;
        for (const c of named) missing.add(c.fact);
        columns = columns.filter((c) => !missing.has(c.fact));
      }
    }
    if (!oneByOne) continue;
    for (const c of columns) {
      try {
        put(lines, await query(factsQuery(batch, [c.column])), [c]);
      } catch (err) {
        if (!refused(err)) throw err;
        missing.add(c.fact);
      }
    }
    columns = columns.filter((c) => !missing.has(c.fact));
  }

  return { lines, missing: FACT_COLUMNS.filter((c) => missing.has(c.fact)).map((c) => c.fact) };
}
