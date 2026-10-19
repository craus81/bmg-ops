import { TRAN_TYPE_NAMES, toCents } from './netsuite-gl';

/**
 * Each item's count and value at each location, FleetSuite's next to
 * NetSuite's own (owner decision 2026-10-18, thread "Replacing NetSuite with
 * FleetSuite", "Stock by item"; docs/books.md "Stock by item"), for the Stock
 * by item page and the daily check (daily-check.ts). FleetSuite's count is
 * where the item stood on December 31, 2024 plus every NetSuite document
 * since that moved it, copied by netsuite-stock.ts; its value adds what
 * NetSuite posted to an inventory account on the item's lines. NetSuite's is
 * its own count of the item now. Pure; values are whole cents.
 */

/** One company's item at one location, as gl_stock_items (migration 401) gives it; quantities and amounts are decimal strings. */
export interface StockRowData {
  company: string;
  item_id: string;
  location_id: string | null;
  opening_quantity: string;
  opening_value: string;
  quantity: string;
  value: string;
  documents: number;
  last_date: string | null;
}

/** NetSuite's own count of an item at a location; location_id null when NetSuite gave only its company-wide count. */
export interface NetSuiteCountData {
  item_id: string;
  location_id: string | null;
  quantity: string;
  value: string | null;
}

export interface ItemNameData {
  netsuite_id: string;
  name: string;
  display_name: string | null;
  active: boolean;
}

export interface LocationNameData {
  netsuite_id: string;
  name: string;
  subsidiary_id?: string | null;
}

/** What gl_stock_items (migration 401) returns. */
export interface StockItemsData {
  rows: StockRowData[];
  netsuite: NetSuiteCountData[];
  netsuite_read_at: string | null;
  items: ItemNameData[];
  locations: LocationNameData[];
  /** Per company, what the copy of NetSuite's general ledger holds on the inventory accounts. */
  ledger: Array<{ company: string; balance: string }>;
  /** The inventory accounts, as NetSuite ids. */
  accounts: string[];
}

/** How NetSuite's counts were read: each item at each location, or each item company-wide. */
export type CountsBy = 'location' | 'item';

/** An item at a location (or everywhere, when NetSuite counts it company-wide), both sides. */
export interface StockLine {
  /** `<item>|<location>`, or `<item>` when NetSuite counts the item company-wide: what the daily check remembers it by. */
  key: string;
  itemId: string;
  /** NetSuite's item name (its number), else its id. */
  item: string;
  /** Its display name, when NetSuite has one apart from the name. */
  description: string | null;
  locationId: string | null;
  /** The location's name; null for no location, or every location when NetSuite counts the item company-wide. */
  location: string | null;
  /** The companies FleetSuite's count is from. */
  companies: string[];
  /** Where FleetSuite's count started, December 31, 2024. */
  start: { quantity: number; value: number };
  fleetsuite: { quantity: number; value: number };
  /** NetSuite's own; value null when NetSuite doesn't give one. */
  netsuite: { quantity: number; value: number | null };
  countDiffers: boolean;
  valueDiffers: boolean;
  /**
   * Neither side has any of it on hand, and NetSuite values it at nothing,
   * but FleetSuite's value isn't nothing: NetSuite's ledger still holds that
   * on the item's lines (owner decision 2026-10-19, "Flag them"). Its value
   * differs too.
   */
  leftover: boolean;
  /** How many documents moved it since its starting count, and the latest one's date. */
  documents: number;
  lastDate: string | null;
}

export interface StockComparison {
  /** null until NetSuite's counts have been read. */
  by: CountsBy | null;
  readAt: string | null;
  /** Every item and location either side holds anything of, the ones whose count differs first, then by item. */
  lines: StockLine[];
  /** Items and locations both sides have nothing of now, left out of lines. */
  cleared: number;
  /** The value of every line: FleetSuite's, and NetSuite's when it gives each one. */
  value: { fleetsuite: number; netsuite: number | null };
  /** Per company: what the GL copy holds on the inventory accounts, next to the value of its items. */
  ledger: Array<{ company: string; balance: number; items: number }>;
}

/** Quantities as NetSuite keeps them can carry decimals; anything closer than this is the same count. */
const SAME = 1e-6;

const quantity = (v: string | null | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const cents = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? 0 : toCents(v));

/** Sorts item names as people read them, so LDR-9 comes before LDR-10. */
const byName = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });

/** Every item and location FleetSuite counts, next to NetSuite's own count. */
export function compareStock(data: StockItemsData): StockComparison {
  const counts = data.netsuite ?? [];
  const by: CountsBy | null = !data.netsuite_read_at
    ? null
    : counts.length && counts.every((c) => c.location_id === null) ? 'item' : 'location';
  const keyOf = (item: string, location: string | null) => (by === 'item' ? item : `${item}|${location ?? ''}`);

  const items = new Map((data.items ?? []).map((i) => [i.netsuite_id, i]));
  const locations = new Map((data.locations ?? []).map((l) => [l.netsuite_id, l.name]));

  interface Side {
    itemId: string;
    locationId: string | null;
    companies: Set<string>;
    start: { quantity: number; value: number };
    fleetsuite: { quantity: number; value: number };
    netsuite: { quantity: number; value: number | null } | null;
    documents: number;
    lastDate: string | null;
  }
  const sides = new Map<string, Side>();
  const sideOf = (item: string, location: string | null): Side => {
    const key = keyOf(item, location);
    let side = sides.get(key);
    if (!side) {
      side = {
        itemId: item, locationId: by === 'item' ? null : location, companies: new Set(),
        start: { quantity: 0, value: 0 }, fleetsuite: { quantity: 0, value: 0 }, netsuite: null, documents: 0, lastDate: null,
      };
      sides.set(key, side);
    }
    return side;
  };

  for (const r of data.rows ?? []) {
    const side = sideOf(r.item_id, r.location_id);
    side.companies.add(r.company);
    side.start.quantity += quantity(r.opening_quantity);
    side.start.value += cents(r.opening_value);
    side.fleetsuite.quantity += quantity(r.quantity);
    side.fleetsuite.value += cents(r.value);
    side.documents += Number(r.documents) || 0;
    if (r.last_date && (!side.lastDate || r.last_date > side.lastDate)) side.lastDate = r.last_date;
  }
  const valued = by !== null && counts.every((c) => c.value !== null);
  for (const c of counts) {
    const side = sideOf(c.item_id, c.location_id);
    const was = side.netsuite ?? { quantity: 0, value: 0 };
    side.netsuite = {
      quantity: was.quantity + quantity(c.quantity),
      value: c.value === null || was.value === null ? null : was.value + cents(c.value),
    };
  }

  const lines: StockLine[] = [];
  let cleared = 0;
  for (const [key, s] of sides) {
    const netsuite = s.netsuite ?? { quantity: 0, value: valued ? 0 : null };
    const empty = Math.abs(s.fleetsuite.quantity) < SAME && s.fleetsuite.value === 0
      && Math.abs(netsuite.quantity) < SAME && !netsuite.value;
    if (empty) {
      cleared++;
      continue;
    }
    const named = items.get(s.itemId);
    const valueDiffers = netsuite.value !== null && s.fleetsuite.value !== netsuite.value;
    lines.push({
      key,
      itemId: s.itemId,
      item: named?.name ?? `Item ${s.itemId}`,
      description: named?.display_name && named.display_name !== named.name ? named.display_name : null,
      locationId: s.locationId,
      location: s.locationId ? locations.get(s.locationId) ?? `Location ${s.locationId}` : null,
      companies: [...s.companies].sort(),
      start: s.start,
      fleetsuite: s.fleetsuite,
      netsuite,
      // Before NetSuite's counts are read there's nothing to differ from.
      countDiffers: by !== null && Math.abs(s.fleetsuite.quantity - netsuite.quantity) >= SAME,
      valueDiffers,
      leftover: valueDiffers && netsuite.value === 0
        && Math.abs(s.fleetsuite.quantity) < SAME && Math.abs(netsuite.quantity) < SAME,
      documents: s.documents,
      lastDate: s.lastDate,
    });
  }
  lines.sort((a, b) => Number(b.countDiffers) - Number(a.countDiffers)
    || byName.compare(a.item, b.item) || Number(a.itemId) - Number(b.itemId)
    || byName.compare(a.location ?? '', b.location ?? ''));

  const companyValue = new Map<string, number>();
  for (const r of data.rows ?? []) companyValue.set(r.company, (companyValue.get(r.company) ?? 0) + cents(r.value));
  const ledger = (data.ledger ?? [])
    .map((l) => ({ company: l.company, balance: cents(l.balance), items: companyValue.get(l.company) ?? 0 }))
    .filter((l) => l.balance !== 0 || l.items !== 0);

  return {
    by,
    readAt: data.netsuite_read_at ?? null,
    lines,
    cleared,
    value: {
      fleetsuite: lines.reduce((total, l) => total + l.fleetsuite.value, 0),
      netsuite: valued ? lines.reduce((total, l) => total + (l.netsuite.value ?? 0), 0) : null,
    },
    ledger,
  };
}

// ── Items set up wrong ─────────────────────────────────────────────────────

/** What gl_stock_item_setup (migration 403) returns. */
export interface StockSetupData {
  /** The active stocked items whose asset account the chart has as anything but an asset account. */
  items: Array<{
    netsuite_id: string;
    name: string;
    display_name: string | null;
    account: { netsuite_id: string; number: string | null; name: string; type: string };
  }>;
  /** The asset account most stocked items use; null when none has one. */
  usual: { netsuite_id: string; number: string | null; name: string } | null;
}

/** A stocked item NetSuite has set up with an asset account that isn't an asset account. */
export interface StockSetupItem {
  itemId: string;
  /** NetSuite's item name (its number). */
  item: string;
  /** Its display name, when NetSuite has one apart from the name. */
  description: string | null;
  /** Its asset account as people read it: number and name. */
  account: string;
  /** What kind of account the chart has it as, as people say it: 'a cost of goods sold account'. */
  accountKind: string;
}

export interface StockSetup {
  items: StockSetupItem[];
  /** The asset account most stocked items use, as people read it; null when none has one. */
  usual: string | null;
}

/** The chart's kinds of account (migration 359) that an asset account isn't, as people say them. */
const NOT_ASSET: Readonly<Record<string, string>> = {
  bank: 'a bank account', accounts_receivable: 'an accounts receivable account', unbilled_receivable: 'an unbilled receivable account',
  deferred_expense: 'a deferred expense account', accounts_payable: 'an accounts payable account', credit_card: 'a credit card account',
  other_current_liability: 'a liability account', long_term_liability: 'a long-term liability account',
  deferred_revenue: 'a deferred revenue account', equity: 'an equity account', income: 'an income account',
  other_income: 'an other income account', cost_of_goods_sold: 'a cost of goods sold account', expense: 'an expense account',
  other_expense: 'an other expense account',
};

const accountText = (a: { netsuite_id: string; number: string | null; name: string }) =>
  [a.number, a.name].filter(Boolean).join(' ') || `NetSuite account ${a.netsuite_id}`;

/** The stocked items NetSuite has set up with an asset account that isn't an asset account, by item number. */
export function stockSetup(data: StockSetupData | null): StockSetup {
  const items = (data?.items ?? []).map((i) => ({
    itemId: i.netsuite_id,
    item: i.name,
    description: i.display_name && i.display_name !== i.name ? i.display_name : null,
    account: accountText(i.account),
    accountKind: NOT_ASSET[i.account.type] ?? 'not an asset account',
  }));
  items.sort((a, b) => byName.compare(a.item, b.item) || Number(a.itemId) - Number(b.itemId));
  return { items, usual: data?.usual ? accountText(data.usual) : null };
}

// ── One item's moves ───────────────────────────────────────────────────────

/** One document's move of the item at one location, as gl_stock_item_moves (migration 401) gives it. */
export interface StockMoveData {
  document_id: string;
  type: string;
  number: string | null;
  date: string;
  company: string;
  location_id: string | null;
  quantity: string;
  value: string;
  /** What the item's moves at the location come to since 2025, through this one. */
  quantity_since: string;
  value_since: string;
  /** The month NetSuite posted it to, from the copy of its general ledger; null when the copy doesn't have it. */
  posting_month: string | null;
}

/** What gl_stock_item_moves (migration 401) returns. */
export interface StockItemMovesData {
  item: ItemNameData | null;
  opening: Array<{ company: string; location_id: string | null; quantity: string; value: string }>;
  netsuite: Array<{ location_id: string | null; quantity: string; value: string | null }>;
  netsuite_read_at: string | null;
  moves: StockMoveData[];
  count: number;
  /** What all of the item's moves come to at each location, the ones not sent too. */
  totals: Array<{ company: string; location_id: string | null; quantity: string; value: string }>;
  locations: LocationNameData[];
}

/** A move on the item's page: what it moved and left at its location. */
export interface StockMove {
  documentId: string;
  type: string;
  /** NetSuite's type as its screens name it. */
  typeName: string;
  number: string;
  date: string;
  company: string;
  locationId: string | null;
  location: string | null;
  quantity: number;
  value: number;
  /** The count and value it left at its location: the starting count plus every move through it. */
  after: { quantity: number; value: number };
  /**
   * It moved the count one way and the value the other: took stock out and
   * put value into inventory, or the reverse. NetSuite posts a shipment that
   * way when the item's cost of goods sold account is an inventory account,
   * as when it's swapped with its asset account.
   */
  backwards: boolean;
  /** Where Invoices vs NetSuite checks the document line by line: its switch (CHECKED_KIND) and the month it lists it under. */
  check: { kind: string; month: string } | null;
}

/** The item at one location: where it started, where FleetSuite has it now, and NetSuite's own count. */
export interface StockPlace {
  locationId: string | null;
  location: string | null;
  start: { quantity: number; value: number };
  fleetsuite: { quantity: number; value: number };
  /** NetSuite's own count there; null when it has none there, or counts the item company-wide. */
  netsuite: { quantity: number; value: number | null } | null;
}

/** One item's page: the item at each location, its moves oldest first, and NetSuite's count of it. */
export interface ItemMoves {
  places: StockPlace[];
  moves: StockMove[];
  /** Moves older than the ones sent. */
  more: number;
  /** null until NetSuite's counts have been read. */
  by: CountsBy | null;
  /** NetSuite's count of the item everywhere: its company-wide count, or its counts at each location added up. */
  netsuite: { quantity: number; value: number | null } | null;
  /**
   * Where neither side has any of the item on hand and NetSuite values it at
   * nothing, but FleetSuite's value isn't nothing (StockLine.leftover): each
   * such location, or the item everywhere (location null) when NetSuite
   * counts it company-wide.
   */
  leftover: Array<{ locationId: string | null; location: string | null; value: number }>;
}

/**
 * The switch of Invoices vs NetSuite that checks a NetSuite type of document: Stock and cost for the stock documents
 * and invoices' and credit memos' cost lines (gl_stock_month, migration 395), Bills for bills and bill credits, which
 * can take stock in themselves. FleetSuite doesn't post the rest.
 */
const CHECKED_KIND: Readonly<Record<string, string>> = {
  ItemShip: 'stock', ItemRcpt: 'stock', InvAdjst: 'stock', InvTrnfr: 'stock', Build: 'stock', Unbuild: 'stock',
  CustInvc: 'stock', CustCred: 'stock', VendBill: 'bill', VendCred: 'bill',
};

/**
 * The item's moves, oldest first, each with what it left at its location, and
 * the item at each location. When there are more moves than were sent, the
 * ones sent are the newest and still carry the full count after them. A
 * location belongs to one company, so the item is shown by location.
 */
export function itemMoves(data: StockItemMovesData): ItemMoves {
  const locations = new Map((data.locations ?? []).map((l) => [l.netsuite_id, l.name]));
  const nameOf = (location: string | null) => (location ? locations.get(location) ?? `Location ${location}` : null);
  const startKey = (company: string, location: string | null) => `${company}|${location ?? ''}`;
  const starts = new Map<string, { quantity: number; value: number }>();
  for (const o of data.opening ?? []) {
    const k = startKey(o.company, o.location_id);
    const was = starts.get(k) ?? { quantity: 0, value: 0 };
    starts.set(k, { quantity: was.quantity + quantity(o.quantity), value: was.value + cents(o.value) });
  }

  const moves: StockMove[] = (data.moves ?? []).map((m) => {
    const start = starts.get(startKey(m.company, m.location_id)) ?? { quantity: 0, value: 0 };
    return {
      documentId: m.document_id,
      type: m.type,
      typeName: TRAN_TYPE_NAMES[m.type] ?? m.type,
      number: m.number || `NetSuite ${m.document_id}`,
      date: m.date,
      company: m.company,
      locationId: m.location_id,
      location: nameOf(m.location_id),
      quantity: quantity(m.quantity),
      value: cents(m.value),
      after: { quantity: start.quantity + quantity(m.quantity_since), value: start.value + cents(m.value_since) },
      backwards: (quantity(m.quantity) <= -SAME && cents(m.value) > 0) || (quantity(m.quantity) >= SAME && cents(m.value) < 0),
      check: CHECKED_KIND[m.type] && m.posting_month ? { kind: CHECKED_KIND[m.type], month: m.posting_month } : null,
    };
  });

  const places = new Map<string, StockPlace>();
  const placeOf = (location: string | null) => {
    const k = location ?? '';
    let p = places.get(k);
    if (!p) {
      p = { locationId: location, location: nameOf(location), start: { quantity: 0, value: 0 }, fleetsuite: { quantity: 0, value: 0 }, netsuite: null };
      places.set(k, p);
    }
    return p;
  };
  // A place's count now is its start plus all of its moves.
  for (const o of data.opening ?? []) {
    const p = placeOf(o.location_id);
    p.start = { quantity: p.start.quantity + quantity(o.quantity), value: p.start.value + cents(o.value) };
    p.fleetsuite = { quantity: p.fleetsuite.quantity + quantity(o.quantity), value: p.fleetsuite.value + cents(o.value) };
  }
  for (const t of data.totals ?? []) {
    const p = placeOf(t.location_id);
    p.fleetsuite = { quantity: p.fleetsuite.quantity + quantity(t.quantity), value: p.fleetsuite.value + cents(t.value) };
  }

  const counts = data.netsuite ?? [];
  const by: CountsBy | null = !data.netsuite_read_at ? null : counts.length && counts.every((c) => c.location_id === null) ? 'item' : 'location';
  if (by === 'location') {
    for (const c of counts) placeOf(c.location_id).netsuite = { quantity: quantity(c.quantity), value: c.value === null ? null : cents(c.value) };
  }
  const netsuite = by === null ? null : {
    quantity: counts.reduce((total, c) => total + quantity(c.quantity), 0),
    value: counts.every((c) => c.value !== null) ? counts.reduce((total, c) => total + cents(c.value), 0) : null,
  };

  const sorted = [...places.values()].sort((a, b) => byName.compare(a.location ?? '', b.location ?? ''));
  const left = (ours: { quantity: number; value: number }, theirs: { quantity: number; value: number | null }) =>
    theirs.value === 0 && ours.value !== 0 && Math.abs(ours.quantity) < SAME && Math.abs(theirs.quantity) < SAME;
  let leftover: ItemMoves['leftover'] = [];
  if (by === 'location' && netsuite) {
    // A location NetSuite counts none of the item at has nothing there, valued at nothing when NetSuite gives values.
    leftover = sorted
      .filter((p) => left(p.fleetsuite, p.netsuite ?? { quantity: 0, value: netsuite.value === null ? null : 0 }))
      .map((p) => ({ locationId: p.locationId, location: p.location, value: p.fleetsuite.value }));
  } else if (by === 'item' && netsuite) {
    const ours = sorted.reduce((sum, p) => ({ quantity: sum.quantity + p.fleetsuite.quantity, value: sum.value + p.fleetsuite.value }), { quantity: 0, value: 0 });
    if (left(ours, netsuite)) leftover = [{ locationId: null, location: null, value: ours.value }];
  }

  return {
    places: sorted,
    moves,
    more: Math.max(0, (Number(data.count) || 0) - moves.length),
    by,
    netsuite,
    leftover,
  };
}

/** A quantity as people write one: no trailing zeros, thousands grouped. */
export function quantityText(n: number): string {
  const rounded = Math.round(n * 1e5) / 1e5;
  return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString('en-US', { maximumFractionDigits: 5 });
}
