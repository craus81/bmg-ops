import { BUCKETS, bucketOf, daysLate, type AgingBucketKey } from './aging-buckets';
import { toCents } from './netsuite-gl';
import { partyName, signOf, type PartyBalances, type PartyKind } from './party-balances';

/**
 * AR and AP agings (migration 458, docs/books.md "AR and AP agings"; the
 * NetSuite Exit Checklist, thread "Replacing NetSuite with FleetSuite",
 * 2026-10-31): who owes BMG and who BMG owes, by how late, FleetSuite's
 * books next to NetSuite's.
 *
 * Each open document is aged from its due date, or its date when it has
 * none (a credit memo, a bill credit), to today in Central time, in
 * Financials' buckets (src/lib/books/aging-buckets.ts): current (not yet
 * due), 1 to 30 days past due, 31 to 60, 61 to 90, and over 90. NetSuite's
 * side is what NetSuite has open on each document, with its due date.
 * FleetSuite's books don't yet record which payment paid which invoice, so
 * FleetSuite's side is NetSuite's open amount plus whatever FleetSuite's
 * books have more on the document (gl_party_open_documents), due when
 * FleetSuite's own copy of an invoice says it is, else when NetSuite says.
 * What a customer's or vendor's open documents leave of its balance, each
 * side (Customer and vendor balances, migration 406), is "not in an open
 * invoice": a payment not applied to one yet, a journal entry, or a
 * difference on a document that doesn't age, a payment say.
 * So each side's buckets and what's not in an open invoice add up to its
 * balance, and its every customer or vendor to the receivable (payable)
 * accounts.
 *
 * Amounts are whole cents as a balance reads: what a customer owes, what a
 * vendor is owed.
 */

/** One open document, as gl_party_open_documents returns it: amounts are decimal strings, debit positive. */
export interface OpenDocumentData {
  party: string;
  doc: string;
  type: string;
  number: string | null;
  date: string | null;
  netsuite_due: string | null;
  fleetsuite_due: string | null;
  netsuite: string;
  fleetsuite: string;
  netsuite_lines: boolean;
  fleetsuite_lines: boolean;
}

export interface OpenDocumentsData {
  linked: boolean | null;
  documents: number;
  parties: Array<{ party: string; name: string | null; netsuite_ids: string[] }>;
  rows: OpenDocumentData[];
}

export interface Sides<T> {
  fleetsuite: T;
  netsuite: T;
}

export type Buckets = Record<AgingBucketKey, Sides<number>>;

export interface AgedDocument {
  /** NetSuite's id for it. */
  doc: string;
  type: string;
  number: string | null;
  date: string | null;
  due: Sides<string | null>;
  /** Days past due today, from its due date or else its date; null with neither. */
  days: Sides<number | null>;
  bucket: Sides<AgingBucketKey>;
  /** What's open on it. */
  open: Sides<number>;
  /** Only this side's ledger has lines of it since 2025; null when both or neither do. */
  onlyIn: keyof Sides<number> | null;
  /** Its two sides differ: what's open, or how late it is. */
  differs: boolean;
}

export interface PartyAging {
  /** A customer's FleetSuite id, a vendor's NetSuite id; '' for the lines FleetSuite can't name. */
  party: string;
  name: string;
  netsuiteIds: string[];
  buckets: Buckets;
  /** What its open documents leave of its balance. */
  notOpen: Sides<number>;
  balance: Sides<number>;
  /** A bucket, or what's not in an open invoice, differs. */
  differs: boolean;
  /** Its open documents, the most overdue in FleetSuite's books first. */
  documents: AgedDocument[];
}

export interface Agings {
  kind: PartyKind;
  /** The day it's aged to, Central time. */
  today: string;
  /**
   * Every customer (vendor) with something open or a balance on either side: those that differ first, then the
   * largest balance in FleetSuite's books first, then by name, the lines FleetSuite can't name last.
   */
  parties: PartyAging[];
  totals: {
    buckets: Buckets;
    notOpen: Sides<number>;
    /** What of the starting entry isn't split by name, the same on both sides (Customer and vendor balances). */
    unsplit: number;
    balance: Sides<number>;
  };
  differing: number;
  /** The company is linked to a NetSuite subsidiary, which NetSuite's open documents are read from. */
  linked: boolean;
  /** How many documents NetSuite has open in it. */
  netsuiteDocuments: number;
}

const emptyBuckets = (): Buckets =>
  Object.fromEntries(BUCKETS.map((b) => [b, { fleetsuite: 0, netsuite: 0 }])) as Buckets;

/** One of gl_party_open_documents' rows, aged to `today`, amounts as the balance reads (`sign`). */
export function ageDocument(row: OpenDocumentData, today: string, sign: 1 | -1): AgedDocument {
  const open = { fleetsuite: sign * toCents(row.fleetsuite) || 0, netsuite: sign * toCents(row.netsuite) || 0 };
  const due = { fleetsuite: row.fleetsuite_due ?? null, netsuite: row.netsuite_due ?? null };
  const days = { fleetsuite: daysLate(due.fleetsuite ?? row.date, today), netsuite: daysLate(due.netsuite ?? row.date, today) };
  const bucket = { fleetsuite: bucketOf(days.fleetsuite ?? 0), netsuite: bucketOf(days.netsuite ?? 0) };
  return {
    doc: row.doc,
    type: row.type,
    number: row.number ?? null,
    date: row.date ?? null,
    due,
    days,
    bucket,
    open,
    onlyIn: row.fleetsuite_lines === row.netsuite_lines ? null : row.fleetsuite_lines ? 'fleetsuite' : 'netsuite',
    // How late it is matters only on a side with something open: a bucket on a side at nothing is no difference.
    differs: open.fleetsuite !== open.netsuite || (open.fleetsuite !== 0 && bucket.fleetsuite !== bucket.netsuite),
  };
}

const byName = (a: PartyAging, b: PartyAging) =>
  Number(a.party === '') - Number(b.party === '') || a.name.localeCompare(b.name, 'en-US', { sensitivity: 'base' }) || a.party.localeCompare(b.party);

/** Customer and vendor balances' answer and gl_party_open_documents' for one kind, aged to `today` (Central time). */
export function buildAgings(balances: PartyBalances, data: OpenDocumentsData | null, kind: PartyKind, today: string): Agings {
  const sign = signOf(kind);
  const names = new Map<string, { name: string; netsuiteIds: string[] }>();
  for (const p of balances.parties) names.set(p.party, { name: p.name, netsuiteIds: p.netsuiteIds });
  for (const p of data?.parties ?? []) {
    names.set(p.party, { name: partyName(kind, p.party, p.name), netsuiteIds: p.netsuite_ids ?? [] });
  }
  const rows = new Map<string, OpenDocumentData[]>();
  for (const r of data?.rows ?? []) rows.set(r.party, [...(rows.get(r.party) ?? []), r]);
  const balanceOf = new Map(balances.parties.map((p) => [p.party, { fleetsuite: p.fleetsuite, netsuite: p.netsuite }]));

  const parties: PartyAging[] = [];
  for (const party of new Set([...balanceOf.keys(), ...rows.keys()])) {
    const documents = (rows.get(party) ?? []).map((r) => ageDocument(r, today, sign));
    const buckets = emptyBuckets();
    for (const d of documents) {
      buckets[d.bucket.fleetsuite].fleetsuite += d.open.fleetsuite;
      buckets[d.bucket.netsuite].netsuite += d.open.netsuite;
    }
    const balance = balanceOf.get(party) ?? { fleetsuite: 0, netsuite: 0 };
    const opened = (side: keyof Sides<number>) => documents.reduce((sum, d) => sum + d.open[side], 0);
    const notOpen = { fleetsuite: balance.fleetsuite - opened('fleetsuite'), netsuite: balance.netsuite - opened('netsuite') };
    const anything = notOpen.fleetsuite || notOpen.netsuite || BUCKETS.some((b) => buckets[b].fleetsuite || buckets[b].netsuite);
    if (!anything) continue;
    documents.sort((a, b) => (b.days.fleetsuite ?? 0) - (a.days.fleetsuite ?? 0)
      || (a.number ?? '').localeCompare(b.number ?? '', 'en-US', { numeric: true }) || a.doc.localeCompare(b.doc));
    const named = names.get(party);
    parties.push({
      party,
      name: named?.name ?? partyName(kind, party, null),
      netsuiteIds: named?.netsuiteIds ?? [],
      buckets,
      notOpen,
      balance,
      differs: notOpen.fleetsuite !== notOpen.netsuite || BUCKETS.some((b) => buckets[b].fleetsuite !== buckets[b].netsuite),
      documents,
    });
  }
  parties.sort((a, b) => Number(b.differs) - Number(a.differs) || b.balance.fleetsuite - a.balance.fleetsuite || byName(a, b));

  const buckets = emptyBuckets();
  const notOpen = { fleetsuite: 0, netsuite: 0 };
  for (const p of parties) {
    for (const b of BUCKETS) {
      buckets[b].fleetsuite += p.buckets[b].fleetsuite;
      buckets[b].netsuite += p.buckets[b].netsuite;
    }
    notOpen.fleetsuite += p.notOpen.fleetsuite;
    notOpen.netsuite += p.notOpen.netsuite;
  }
  return {
    kind,
    today,
    parties,
    totals: { buckets, notOpen, unsplit: balances.unsplit, balance: balances.totals },
    differing: parties.filter((p) => p.differs).length,
    linked: data?.linked ?? false,
    netsuiteDocuments: Number(data?.documents) || 0,
  };
}
