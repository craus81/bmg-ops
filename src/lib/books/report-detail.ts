import { toCents, TRAN_TYPE_NAMES } from './netsuite-gl';
import { COST, kindName, kindOf, listKindOf, listMonthOf, NETSUITE_TYPE } from './differences';
import type { LineSpan, Pair } from './reports';

/**
 * The detail behind one account line on Reports (migration 400,
 * docs/books.md "Report detail"; owner decision 2026-10-18, thread
 * "Replacing NetSuite with FleetSuite"): every document that moved the
 * account in the months picked, FleetSuite's journal next to the copy of
 * NetSuite's general ledger, so the owner or the CPA can trace any number on
 * a report back to the documents behind it. The line's two ends come from
 * the report itself (lineSpan in reports.ts); the documents between them
 * from gl_books_account_documents. Amounts are whole cents, as the report
 * the line is on shows them.
 */

/** One document as gl_books_account_documents returns it: amounts are decimal strings, debit positive. */
export interface AccountDocumentData {
  doc: string;
  netsuite: string;
  fleetsuite: string;
  kind: string | null;
  type: string | null;
  number: string | null;
  month: string | null;
  date: string | null;
  name: string | null;
  memo: string | null;
  entry_no: number | null;
  entries: number;
}

export interface AccountDocumentsData {
  documents: number;
  differing: number;
  netsuite: string;
  fleetsuite: string;
  rows: AccountDocumentData[];
}

/** One document on the detail page. */
export interface DetailDocument {
  doc: string;
  date: string | null;
  /** What kind of document it is, as NetSuite names it, or FleetSuite's own ("Typed entry (FleetSuite only)"). */
  type: string;
  number: string;
  name: string | null;
  memo: string | null;
  fleetsuite: number;
  netsuite: number;
  /** Which side alone has it; 'not_posted' when that's NetSuite's, of a kind FleetSuite doesn't post yet. */
  only: 'netsuite' | 'fleetsuite' | 'not_posted' | null;
  /** Where Invoices vs NetSuite opens its line by line check: the page's switch and month. */
  check: { kind: string; month: string } | null;
}

/** The FleetSuite kind that copies each NetSuite transaction type. */
const SOURCE_TYPE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NETSUITE_TYPE).filter(([, type]) => type !== COST).map(([kind, type]) => [type, kind]),
);

const isNetSuiteId = (doc: string) => /^[0-9]+$/.test(doc);

/** Where Invoices vs NetSuite checks a NetSuite document of this type line by line, when FleetSuite posts the type. */
export function netsuiteCheck(type: string | null, month: string | null, date: string | null): { kind: string; month: string } | null {
  const kind = type ? SOURCE_TYPE[type] ?? null : null;
  const listMonth = kind ? listMonthOf(kind, month, date) : null;
  return kind && listMonth ? { kind: listKindOf(kind), month: listMonth } : null;
}

/** The documents, amounts as the line shows them (`sign`, from lineSpan), each named and linked to its check. */
export function detailDocuments(data: AccountDocumentsData, sign: 1 | -1): DetailDocument[] {
  return data.rows.map((r) => {
    const fleetsuite = sign * toCents(r.fleetsuite) || 0;
    const netsuite = sign * toCents(r.netsuite) || 0;
    const kind = r.kind ?? (r.type ? SOURCE_TYPE[r.type] ?? null : null);
    const fromNetSuite = isNetSuiteId(r.doc);
    const listMonth = kind && fromNetSuite ? listMonthOf(kind, r.month, r.date) : null;
    return {
      doc: r.doc,
      date: r.date,
      type: r.type ? TRAN_TYPE_NAMES[r.type] ?? r.type : kind ? kindName(kindOf(kind)) : 'Entry',
      number: r.number || (fromNetSuite ? `NetSuite ${r.doc}` : `Entry ${r.entry_no ?? ''}`.trim()),
      name: r.name,
      memo: r.memo,
      fleetsuite,
      netsuite,
      only: !fleetsuite && netsuite ? (kind ? 'netsuite' : 'not_posted') : fleetsuite && !netsuite ? 'fleetsuite' : null,
      check: kind && kind in NETSUITE_TYPE && listMonth ? { kind: listKindOf(kind), month: listMonth } : null,
    };
  });
}

/** One row of an account line's documents with each side's running balance. */
export type LedgerRow =
  | { kind: 'starting'; balance: Pair }
  | { kind: 'document'; document: DetailDocument; balance: Pair }
  | { kind: 'closing'; month: string; amount: Pair; balance: Pair }
  | { kind: 'ending'; balance: Pair; reached: Pair };

/**
 * An account line's documents with each side's balance after each one, as
 * the Excel download lists them (docs/books.md "Excel downloads"): from the
 * line's balance before its months (a balance sheet account's; income and
 * expenses start from nothing), through each document in the order given
 * (by date), and on retained earnings each year's net income at the January
 * it comes in (yearClosings in reports.ts), to the line itself. `reached` is
 * where the rows come to, each side: short of the line when some documents
 * aren't listed, more than the download takes or not in the copy of
 * NetSuite's ledger yet.
 */
export function runningBalances(
  span: Pick<LineSpan, 'starting' | 'ending'>,
  closings: Array<{ month: string; closed: Pair }>,
  documents: DetailDocument[],
): LedgerRow[] {
  let balance: Pair = span.starting ?? { fleetsuite: 0, netsuite: 0 };
  const step = (amount: Pair): Pair => (balance = {
    fleetsuite: balance.fleetsuite + amount.fleetsuite,
    netsuite: balance.netsuite + amount.netsuite,
  });
  const rows: LedgerRow[] = span.starting ? [{ kind: 'starting', balance }] : [];
  const waiting = [...closings].sort((x, y) => x.month.localeCompare(y.month));
  // A year's net income comes in on January 1, before anything dated that day or later.
  const close = (until: string | null) => {
    while (waiting.length && (until === null || waiting[0].month <= until)) {
      const c = waiting.shift()!;
      rows.push({ kind: 'closing', month: c.month, amount: c.closed, balance: step(c.closed) });
    }
  };
  for (const d of documents) {
    if (d.date) close(d.date);
    rows.push({ kind: 'document', document: d, balance: step(d) });
  }
  close(null);
  rows.push({ kind: 'ending', balance: span.ending, reached: balance });
  return rows;
}
