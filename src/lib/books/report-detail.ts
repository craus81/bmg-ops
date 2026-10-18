import { toCents, TRAN_TYPE_NAMES } from './netsuite-gl';
import { COST, kindName, kindOf, listKindOf, listMonthOf, NETSUITE_TYPE } from './differences';

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
