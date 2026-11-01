import { TRAN_TYPE_NAMES, toCents } from './netsuite-gl';
import { netsuiteCheck } from './report-detail';
import type { ItemNameData, LedgerEntry, LedgerEntryData, LocationNameData } from './stock-items';

/**
 * Inventory value at a month's end (part 64, migration 495, docs/books.md
 * "Inventory value at a month's end"; the NetSuite Exit Checklist's
 * "Inventory moves and value", thread "Replacing NetSuite with FleetSuite"):
 * what each stocked item was worth at the end of a month, item by item, and
 * how that comes to each inventory account on the balance sheet that day,
 * every cent between them named, so a month can be closed with stock that
 * ties. Built from the same copies as Stock by item (stock-items.ts), each
 * document counted in the month NetSuite posted it to. Pure; amounts are
 * whole cents.
 *
 * On each inventory account, what FleetSuite's books hold beyond the
 * stocked items on it is made of, in order:
 *   start       where NetSuite's ledger and the items stood apart on
 *               December 31, 2024, before FleetSuite's copies begin;
 *   entries     the documents since that posted to it on no stocked item's
 *               stock line (a journal entry, say);
 *   unexplained anything else on the copy of NetSuite's ledger, which is
 *               none unless the copy is off;
 *   notCopied   what NetSuite's own totals hold that the copy of its ledger
 *               doesn't yet;
 *   booksApart  how far FleetSuite's books are from NetSuite's own totals.
 */

/** What gl_stock_month_end (migration 495) gives for one company's inventory account; amounts are decimal strings, debit positive. */
export interface MonthEndPartData {
  company: string;
  account_id: string;
  number: string | null;
  name: string | null;
  type: string | null;
  ledger_start: string;
  ledger_moves: string;
  items_start: string;
  items_moves_before: string;
  items_moves: string;
  netsuite_moves: string;
  books_moves: string;
  moves: Array<{ type: string | null; documents: number; total: string }>;
  entries: number;
  entries_total: string;
  month_entries: number;
  month_entries_total: string;
  kinds: Array<{ type: string | null; count: number; total: string }>;
  rows: LedgerEntryData[];
  usual: boolean;
}

/** What gl_stock_month_end (migration 495) returns. */
export interface MonthEndData {
  month: string;
  /** Each company's item at each location at the month's end; quantities and amounts are decimal strings. */
  rows: Array<{ company: string; item_id: string; location_id: string | null; quantity: string; value: string }>;
  items: ItemNameData[];
  locations: LocationNameData[];
  parts: MonthEndPartData[];
  /** Per company, the latest month NetSuite's own totals have been read for. */
  netsuite_through: Array<{ company: string; month: string }>;
}

/** An item at a location at the month's end. */
export interface ValueLine {
  key: string;
  itemId: string;
  /** NetSuite's item name (its number), else its id. */
  item: string;
  /** Its display name, when NetSuite has one apart from the name. */
  description: string | null;
  locationId: string | null;
  location: string | null;
  quantity: number;
  value: number;
  /** What one cost on average, in cents and fractions of one; null with none on hand. */
  averageCost: number | null;
  /** Fewer than none on hand. */
  belowZero: boolean;
  /** None on hand, but value still on its lines (Stock by item's value left over, at the month's end). */
  leftover: boolean;
}

/** A document with no stocked item on the account, and whether it posted in the month. */
export interface MonthEntry extends LedgerEntry {
  inMonth: boolean;
}

/** One company's inventory account at the month's end, the stocked items on it next to the balance sheet. */
export interface AccountTie {
  accountId: string;
  /** Its number and name. */
  account: string;
  /** The chart has it as a fixed asset account: equipment or vehicles rather than stock. */
  fixedAsset: boolean;
  /** It's the inventory account most stocked items name. */
  usual: boolean;
  /** The stocked items on it: at the end of the month before, the month's moves by kind (the biggest first), at the month's end. */
  items: { before: number; moves: Array<{ type: string; documents: number; total: number }>; end: number };
  /** The account at the month's end: the copy of NetSuite's ledger, NetSuite's own totals and FleetSuite's books. */
  ledger: number;
  netsuite: number;
  books: number;
  /** What FleetSuite's books hold beyond the items, and what it's made of; together they come to it. */
  apart: number;
  start: number;
  entries: {
    count: number;
    total: number;
    /** The ones posted in the month. */
    month: { count: number; total: number };
    kinds: Array<{ type: string; count: number; total: number }>;
    /** The month's first, then the biggest, as many as were sent. */
    rows: MonthEntry[];
    /** The ones not sent: how many, and what they come to. */
    more: { count: number; total: number };
  };
  unexplained: number;
  notCopied: number;
  booksApart: number;
}

/** One company at the month's end. */
export interface CompanyValue {
  company: string;
  /** Every item and location with any on hand or any value, by item number. */
  lines: ValueLine[];
  /** What they come to. */
  value: number;
  accounts: AccountTie[];
  /** The latest month NetSuite's own totals are read for; null when none are. */
  netsuiteThrough: string | null;
  /** They don't reach the month, so NetSuite's side stops short of it. */
  netsuiteShort: boolean;
}

export interface MonthEndValue {
  month: string;
  /** BMG first, then by code; only the companies with stock or an inventory account. */
  companies: CompanyValue[];
}

/** Quantities closer to none than this are none (compareStock's). */
const SAME = 1e-6;

const quantity = (v: string | null | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const cents = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? 0 : toCents(v));
const typeName = (type: string | null) => (type ? TRAN_TYPE_NAMES[type] ?? type : 'Entry');
const accountText = (p: Pick<MonthEndPartData, 'account_id' | 'number' | 'name'>) =>
  [p.number, p.name].filter(Boolean).join(' ') || `NetSuite account ${p.account_id}`;

/** Sorts item names as people read them, so LDR-9 comes before LDR-10. */
const byName = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });

/** One company's inventory account at the month's end. */
export function accountTie(p: MonthEndPartData, month: string): AccountTie {
  const ledgerStart = cents(p.ledger_start);
  const itemsStart = cents(p.items_start);
  const end = itemsStart + cents(p.items_moves);
  const ledger = ledgerStart + cents(p.ledger_moves);
  // The balance sheet's starting entry is the same on every side, as on Reports.
  const netsuite = ledgerStart + cents(p.netsuite_moves);
  const books = ledgerStart + cents(p.books_moves);
  const start = ledgerStart - itemsStart;
  const total = cents(p.entries_total);
  const count = Number(p.entries) || 0;
  const rows: MonthEntry[] = (p.rows ?? []).map((r) => ({
    doc: r.doc,
    date: r.date,
    type: typeName(r.type),
    number: r.number || `NetSuite ${r.doc}`,
    name: r.name,
    memo: r.memo,
    amount: cents(r.amount),
    check: netsuiteCheck(r.type, r.month, r.date),
    inMonth: r.month === month,
  }));
  return {
    accountId: p.account_id,
    account: accountText(p),
    fixedAsset: p.type === 'fixed_asset',
    usual: !!p.usual,
    items: {
      before: itemsStart + cents(p.items_moves_before),
      moves: (p.moves ?? []).map((m) => ({ type: typeName(m.type), documents: Number(m.documents) || 0, total: cents(m.total) })),
      end,
    },
    ledger,
    netsuite,
    books,
    apart: books - end,
    start,
    entries: {
      count,
      total,
      month: { count: Number(p.month_entries) || 0, total: cents(p.month_entries_total) },
      kinds: (p.kinds ?? []).map((k) => ({ type: typeName(k.type), count: Number(k.count) || 0, total: cents(k.total) })),
      rows,
      more: { count: Math.max(0, count - rows.length), total: total - rows.reduce((sum, r) => sum + r.amount, 0) },
    },
    unexplained: ledger - end - start - total,
    notCopied: netsuite - ledger,
    booksApart: books - netsuite,
  };
}

/** Every company's stock and inventory accounts at the month's end. */
export function monthEndValue(data: MonthEndData): MonthEndValue {
  const items = new Map((data.items ?? []).map((i) => [i.netsuite_id, i]));
  const locations = new Map((data.locations ?? []).map((l) => [l.netsuite_id, l.name]));
  const through = new Map((data.netsuite_through ?? []).map((t) => [t.company, t.month]));

  const lines = new Map<string, ValueLine[]>();
  for (const r of data.rows ?? []) {
    const named = items.get(r.item_id);
    const q = quantity(r.quantity);
    const value = cents(r.value);
    const none = Math.abs(q) < SAME;
    const list = lines.get(r.company) ?? [];
    list.push({
      key: `${r.item_id}|${r.location_id ?? ''}`,
      itemId: r.item_id,
      item: named?.name ?? `Item ${r.item_id}`,
      description: named?.display_name && named.display_name !== named.name ? named.display_name : null,
      locationId: r.location_id,
      location: r.location_id ? locations.get(r.location_id) ?? `Location ${r.location_id}` : null,
      quantity: q,
      value,
      averageCost: q >= SAME ? value / q : null,
      belowZero: q <= -SAME,
      leftover: none && value !== 0,
    });
    lines.set(r.company, list);
  }

  const parts = new Map<string, AccountTie[]>();
  for (const p of data.parts ?? []) {
    const list = parts.get(p.company) ?? [];
    list.push(accountTie(p, data.month));
    parts.set(p.company, list);
  }

  const codes = [...new Set([...lines.keys(), ...parts.keys()])]
    .sort((a, b) => Number(b === 'BMG') - Number(a === 'BMG') || a.localeCompare(b));
  return {
    month: data.month,
    companies: codes.map((company) => {
      const list = (lines.get(company) ?? []).sort((a, b) => byName.compare(a.item, b.item)
        || Number(a.itemId) - Number(b.itemId) || byName.compare(a.location ?? '', b.location ?? ''));
      const read = through.get(company) ?? null;
      return {
        company,
        lines: list,
        value: list.reduce((total, l) => total + l.value, 0),
        accounts: parts.get(company) ?? [],
        netsuiteThrough: read,
        netsuiteShort: read === null || read < data.month,
      };
    }),
  };
}
