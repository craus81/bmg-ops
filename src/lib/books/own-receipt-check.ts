import { centsOf } from './invoice-check';
import { STOCK_TYPES } from './bill-rule';
import { dayText, type OwnCheckStatus } from './own-invoice-check';
import { toCents } from './own-bills';
import type { ReceiptUnknown } from './own-receipts';

/**
 * Books' own receipts next to NetSuite's item receipts (migration 435,
 * docs/books.md "FleetSuite's own bills and receipts"; owner decision
 * 2026-10-24, thread "Replacing NetSuite with FleetSuite", "Shared bills").
 *
 * Each copy Books kept of a Receive on the Receiving page
 * (src/lib/books/own-receipts.ts) is put next to NetSuite's item receipt as
 * the copy of NetSuite's stock moves has it (migration 401, every two
 * hours), valued from the copy of its general ledger: its date, the company
 * it's for, each item and how many, and what it added to stock. Books values
 * what it received at the purchase order's prices, an item NetSuite keeps in
 * stock adding its quantity at the PO's price to the cent; NetSuite's value
 * is what its item receipt posted to the inventory accounts. Where NetSuite
 * put it is shown, not compared: FleetSuite doesn't say, and NetSuite takes
 * each PO line's location.
 *
 * A copy:
 *   - is not in NetSuite (status 'not_in_netsuite') when NetSuite didn't
 *     take the Receive and it's still on Receiving's list to enter by hand;
 *   - is incomplete when there's no item receipt to put it next to: entered
 *     by hand (Receiving doesn't say which one it is), or NetSuite didn't say
 *     which it made;
 *   - waits until the copy of NetSuite's stock moves has the item receipt and
 *     the copy of its general ledger has its entry. Once the stock copy has
 *     run since and doesn't have it, it's gone (status 'voided'), as it is
 *     when NetSuite deleted it; the stock copy takes only documents that move
 *     stock, so one with nothing kept in stock on it is never there, and is
 *     incomplete;
 *   - differs when anything compared differs;
 *   - is incomplete when nothing compared differs but FleetSuite couldn't
 *     work something out, which isn't compared;
 *   - matches otherwise.
 *
 * Pure. Amounts are whole cents.
 */

// ── What gl_own_receipt_pairs returns ──────────────────────────────────────

export interface OwnReceiptLineData {
  line_no: number;
  item_id: string | null;
  item_number: string | null;
  description: string | null;
  quantity: string;
  rate: string | null;
  po_line_id: string | null;
  po_receipt_id: string | null;
}

export interface OwnReceiptData {
  receipt_key: string;
  netsuite_id: string | null;
  number: string | null;
  company: string;
  po_id: string | null;
  po_number: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  date: string;
  netsuite_error: string | null;
  unknowns: ReceiptUnknown[];
  made_at: string;
  lines: OwnReceiptLineData[];
}

export interface NetsuiteReceiptLineData {
  line_id: string;
  company: string;
  item_id: string;
  location_id: string | null;
  /** Signed, stock in positive. */
  quantity: string;
  moves_stock: boolean;
  /** What NetSuite posted to an inventory account on the line, debit positive; null when the ledger copy has nothing on it. */
  value: string | null;
}

export interface NetsuiteReceiptData {
  number: string | null;
  type: string;
  date: string;
  gone: boolean;
  lines: NetsuiteReceiptLineData[];
}

export interface ReceiptPairData {
  own: OwnReceiptData;
  /** Null when NetSuite didn't take it, or before the copy of its stock moves has it. */
  netsuite: NetsuiteReceiptData | null;
  /** Whether the copy of NetSuite's general ledger has the item receipt. */
  in_ledger: boolean;
  /** How many of Receiving's rows for it stand where. */
  receiving: { posted: number; manual_needed: number; manual_done: number } | null;
}

export interface ReceiptPairsData {
  receipts: ReceiptPairData[];
  items: Record<string, { number: string; type: string | null; display_name: string | null }>;
  locations: Record<string, string>;
}

/** How far the copies of NetSuite's stock moves and general ledger had come: each one's sync_state last_synced_at. */
export interface ReceiptCopiesThrough {
  /** Every document NetSuite changed before this is in the copy of its stock moves. */
  stock: string | null;
  /** When the copy of NetSuite's general ledger last finished a whole run. */
  ledger: string | null;
}

// ── What the check says ────────────────────────────────────────────────────

/** How an own receipt compares: as an own invoice, or not in NetSuite at all yet. */
export type ReceiptStatus = OwnCheckStatus | 'not_in_netsuite';

/** Every status, the ones to look at first first. */
export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['differs', 'not_in_netsuite', 'incomplete', 'waiting', 'matches', 'voided'];

export type ReceiptField = 'date' | 'company' | 'items' | 'cost';

export interface ReceiptFieldCheck {
  field: ReceiptField;
  label: string;
  /** What Books' copy says, in words; null when FleetSuite couldn't work it out. */
  fleetsuite: string | null;
  /** What NetSuite's item receipt says; null when its copies don't say yet. */
  netsuite: string | null;
  /** Null when it isn't compared. */
  same: boolean | null;
  /** Why it differs, or why it isn't compared. */
  why: string | null;
}

export interface ReceiptItemPair {
  /** The item's number. */
  item: string;
  itemId: string | null;
  description: string | null;
  fleetsuite: {
    quantity: number;
    /** The PO's price each when every line of it has the same one; null when they differ or one has none. */
    rate: number | null;
    /** At the PO's prices; null when a line has no price. */
    cents: number | null;
    /** Whether NetSuite keeps it in stock, from the copy of its items or else its receipt; null when neither says. */
    stock: boolean | null;
  } | null;
  netsuite: {
    quantity: number;
    locations: string[];
    movesStock: boolean;
    /** What it posted to the inventory accounts; null before the copy of NetSuite's general ledger values it. */
    cents: number | null;
  } | null;
  same: boolean | null;
  why: string | null;
}

export interface OwnReceiptCheck {
  receiptKey: string;
  /** NetSuite's id for the item receipt; null when NetSuite didn't take it, or didn't say. */
  netsuiteId: string | null;
  /** NetSuite's number for the item receipt; null without one. */
  number: string | null;
  date: string;
  company: string;
  poId: string | null;
  poNumber: string;
  vendor: string | null;
  /** Where NetSuite put it, from its item receipt; null before that's known. */
  location: string | null;
  /** What came in, in a few words: '12 RACK-48', '3 items'. */
  what: string;
  status: ReceiptStatus;
  /** One sentence for the list. */
  summary: string;
  /** How many of the things compared differ. */
  differing: number;
  /** What Books' copy added to stock: the items NetSuite keeps in stock at the PO's prices; null when that isn't known. */
  fleetsuiteCents: number | null;
  /** What NetSuite's item receipt added to the inventory accounts; null before its copies have it. */
  netsuiteCents: number | null;
  fields: ReceiptFieldCheck[];
  items: ReceiptItemPair[];
  /** What NetSuite said when it didn't take it. */
  netsuiteError: string | null;
  /** How many of Receiving's rows for it are in NetSuite, still to enter by hand there, and entered by hand. */
  receiving: { posted: number; manualNeeded: number; manualDone: number };
  /** What FleetSuite couldn't work out, in words. */
  unknowns: string[];
  /** How Books worked its copy out, a sentence each. */
  workedOut: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => money.format(cents / 100);
/** A price each, as the purchase order has it, to four places when it has them. */
const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const DAY_MS = 86_400_000;
/** The ledger copy runs at most five minutes, so one that finished this long after a copy was made began after it. */
const LEDGER_RUN_MS = 10 * 60_000;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** A quantity as people write it: 3, 1.5. */
const qty = (n: number) => String(Number(n.toFixed(4)));
const sameQuantity = (a: number, b: number) => Math.abs(a - b) < 0.00005;
/** An item number as the Receiving page keeps it: the last part after a colon, in capitals. */
const itemNumberKey = (s: string | null | undefined) => String(s ?? '').split(':').pop()!.trim().toUpperCase();

/** How far NetSuite's amount is from Books', in a sentence. */
const apart = (fleetsuite: number, netsuite: number) =>
  `NetSuite's is ${dollars(Math.abs(netsuite - fleetsuite))} ${netsuite > fleetsuite ? 'more' : 'less'}.`;

/** What's compared, in a sentence. */
const FIELD_WORDS: Readonly<Record<ReceiptField, string>> = {
  date: 'the date',
  company: 'the company',
  items: 'the items',
  cost: 'what it added to stock',
};

/** The copied lists the check reads names from. */
export interface ReceiptLists {
  items: Map<string, { number: string; type: string | null; displayName: string | null }>;
  locations: Map<string, string>;
}

export function receiptLists(data: Pick<ReceiptPairsData, 'items' | 'locations'>): ReceiptLists {
  return {
    items: new Map(Object.entries(data.items ?? {}).map(([id, i]) => [id, { number: i.number, type: i.type, displayName: i.display_name }])),
    locations: new Map(Object.entries(data.locations ?? {})),
  };
}

interface OwnItem {
  key: string;
  itemId: string | null;
  itemNumber: string | null;
  description: string | null;
  quantity: number;
  rates: Set<number | null>;
  /** Each line at its price, added up; null once one has none. */
  cents: number | null;
}

interface NetItem {
  key: string;
  itemId: string;
  /** How many came in: what its lines that move stock brought in, or, when none does, what its lines name. */
  quantity: number;
  /** What its lines that don't move stock name: a non-inventory item's, or a line kept for its cost. */
  named: number;
  locations: Set<string | null>;
  movesStock: boolean;
  valueCents: number;
}

// ── One receipt ────────────────────────────────────────────────────────────

/** Books' own receipt next to NetSuite's item receipt. */
export function checkOwnReceipt(pair: ReceiptPairData, lists: ReceiptLists, copies: ReceiptCopiesThrough): OwnReceiptCheck {
  const own = pair.own;
  const madeAt = Date.parse(own.made_at);
  // The stock copy takes every document that moves stock changed before its window: one that ran since has it, if it's there.
  const stockRanSince = !!copies.stock && Date.parse(copies.stock) > madeAt;
  const ledgerRanSince = !!copies.ledger && Date.parse(copies.ledger) > madeAt + LEDGER_RUN_MS;
  const gone = !!pair.netsuite?.gone;
  const ns = own.netsuite_id && pair.netsuite && !gone ? pair.netsuite : null;
  // NetSuite's value is known once its ledger copy has the item receipt, or has run since without it (nothing booked).
  const valued = !!ns && (pair.in_ledger || ledgerRanSince);
  const receiving = {
    posted: pair.receiving?.posted ?? 0,
    manualNeeded: pair.receiving?.manual_needed ?? 0,
    manualDone: pair.receiving?.manual_done ?? 0,
  };

  const poNumber = own.po_number || (own.po_id ? `NetSuite PO ${own.po_id}` : 'A purchase order');
  const number = own.number || ns?.number || null;
  const locationName = (id: string | null) => (id ? lists.locations.get(id) ?? `Location ${id}` : 'no location');
  const itemName = (id: string | null, itemNumber: string | null) =>
    itemNumber || (id ? lists.items.get(id)?.number : null) || (id ? `NetSuite item ${id}` : 'An item');
  const stockOf = (id: string | null): boolean | null => {
    const type = id ? lists.items.get(id)?.type : null;
    return type ? STOCK_TYPES.has(type) : null;
  };

  // NetSuite's side, item by item: what its item receipt brought in, where, and what that added to the inventory accounts.
  const netItems = new Map<string, NetItem>();
  for (const l of ns?.lines ?? []) {
    const key = `item:${l.item_id}`;
    const item = netItems.get(key)
      ?? { key, itemId: l.item_id, quantity: 0, named: 0, locations: new Set<string | null>(), movesStock: false, valueCents: 0 };
    if (l.moves_stock) {
      item.quantity += num(l.quantity) ?? 0;
      item.movesStock = true;
      item.locations.add(l.location_id);
    } else {
      item.named += num(l.quantity) ?? 0;
    }
    if (l.value !== null && l.value !== undefined) item.valueCents += centsOf(l.value) ?? 0;
    netItems.set(key, item);
  }
  // A line that names an item it doesn't move, kept for its cost, isn't another of it; an item no line moves (a non-inventory
  // item) came in as many as its lines name.
  for (const n of netItems.values()) if (!n.movesStock) n.quantity = n.named;
  // A line with no item id is the PO line's item number; NetSuite's line for it, when it has one, by that number.
  const netByNumber = new Map<string, string>();
  for (const n of netItems.values()) {
    const name = lists.items.get(n.itemId)?.number;
    if (name) netByNumber.set(itemNumberKey(name), n.key);
  }

  // Books' side, item by item, each line at the PO's price.
  const ownItems = new Map<string, OwnItem>();
  for (const l of own.lines ?? []) {
    const key = l.item_id ? `item:${l.item_id}` : netByNumber.get(itemNumberKey(l.item_number)) ?? `number:${itemNumberKey(l.item_number)}`;
    const quantity = num(l.quantity) ?? 0;
    const rate = num(l.rate);
    const lineCents = rate === null ? null : toCents(quantity * rate);
    const item = ownItems.get(key);
    if (item) {
      item.quantity += quantity;
      item.rates.add(rate);
      item.cents = item.cents === null || lineCents === null ? null : item.cents + lineCents;
    } else {
      ownItems.set(key, {
        key,
        itemId: l.item_id ?? (key.startsWith('item:') ? key.slice(5) : null),
        itemNumber: l.item_number,
        description: l.description,
        quantity,
        rates: new Set([rate]),
        cents: lineCents,
      });
    }
  }
  // Each item, Books' paired with NetSuite's.
  const items: ReceiptItemPair[] = [];
  const itemsDiffer: string[] = [];
  /** Items whose value adds to stock on Books' side, and whether each is known. */
  const unpriced: string[] = [];
  const unlisted: string[] = [];
  let ownStockCents: number | null = 0;
  const theirs = number ? `NetSuite's receipt ${number}` : "NetSuite's receipt";
  for (const o of ownItems.values()) {
    const n = netItems.get(o.key);
    const name = itemName(o.itemId, o.itemNumber);
    // Whether NetSuite keeps it in stock: as the copy of its items says, or else as its receipt has it, moving it or not.
    const stock = stockOf(o.itemId) ?? (n ? n.movesStock : null);
    const rate = o.rates.size === 1 ? [...o.rates][0] : null;
    if (stock === null) unlisted.push(name);
    if (stock !== false && o.cents === null) unpriced.push(name);
    if (stock === true) ownStockCents = ownStockCents === null || o.cents === null ? null : ownStockCents + o.cents;
    else if (stock === null) ownStockCents = null;

    let same: boolean | null = null;
    let why: string | null = null;
    if (ns && !n) {
      same = false;
      why = `${theirs} has none of ${name}. FleetSuite received ${qty(o.quantity)}.`;
      itemsDiffer.push(why);
    } else if (ns && n) {
      const quantitySame = sameQuantity(o.quantity, n.quantity);
      const reasons: string[] = [];
      if (!quantitySame) {
        reasons.push(`${theirs} has ${qty(n.quantity)} of ${name}. FleetSuite received ${qty(o.quantity)}.`);
        itemsDiffer.push(reasons[0]);
      }
      // What it added to stock, for an item either side keeps in stock, once NetSuite's value is known. Another
      // quantity adds another amount, so that's told about only for the same quantity.
      const kept = stock === true || n.movesStock;
      const costSame = !kept ? true : !valued || o.cents === null ? null : o.cents === n.valueCents;
      if (kept && costSame === false && quantitySame) {
        const at = rate !== null ? ` (${qty(o.quantity)} at the PO's ${price.format(rate)})` : '';
        reasons.push(`${name} added ${dollars(o.cents!)} to stock in FleetSuite${at}, and ${dollars(n.valueCents)} in NetSuite. ${apart(o.cents!, n.valueCents)}`);
      }
      if (o.cents === null) reasons.push(`FleetSuite's copy of the purchase order had no price for ${name}${kept ? ", so what it added to stock isn't compared" : ''}.`);
      if (!kept && stock === false) reasons.push(`${name} isn't kept in stock, so it adds nothing to stock on either side.`);
      same = !quantitySame || costSame === false ? false : costSame === null ? null : true;
      why = reasons.length ? reasons.join(' ') : null;
    }
    items.push({
      item: name,
      itemId: o.itemId,
      description: o.description,
      fleetsuite: { quantity: o.quantity, rate, cents: o.cents, stock },
      netsuite: n ? {
        quantity: n.quantity,
        locations: [...n.locations].map(locationName).sort(),
        movesStock: n.movesStock,
        cents: valued ? n.valueCents : null,
      } : null,
      same,
      why,
    });
  }
  for (const n of netItems.values()) {
    if (ownItems.has(n.key)) continue;
    const name = itemName(n.itemId, null);
    const why = `${theirs} has ${qty(n.quantity)} of ${name}${valued && n.valueCents ? ` (${dollars(n.valueCents)})` : ''}. FleetSuite received none.`;
    itemsDiffer.push(why);
    items.push({
      item: name,
      itemId: n.itemId,
      description: lists.items.get(n.itemId)?.displayName ?? null,
      fleetsuite: null,
      netsuite: { quantity: n.quantity, locations: [...n.locations].map(locationName).sort(), movesStock: n.movesStock, cents: valued ? n.valueCents : null },
      same: false,
      why,
    });
  }
  const netsuiteCents = valued ? [...netItems.values()].reduce((sum, i) => sum + i.valueCents, 0) : null;
  const where = new Set<string | null>();
  for (const n of netItems.values()) for (const l of n.locations) where.add(l);
  const location = where.size ? listed([...where].map(locationName).sort()) : null;

  const fields: ReceiptFieldCheck[] = [];

  // Its date.
  {
    const same = ns ? own.date === ns.date : null;
    const days = ns ? Math.round((Date.parse(ns.date) - Date.parse(own.date)) / DAY_MS) : 0;
    fields.push({
      field: 'date',
      label: 'Date',
      fleetsuite: dayText(own.date),
      netsuite: ns ? dayText(ns.date) : null,
      same,
      why: same === false
        ? `FleetSuite dated it ${dayText(own.date)}, and NetSuite's receipt is dated ${plural(Math.abs(days), 'day', 'days')} ${days > 0 ? 'later' : 'earlier'}.`
        : null,
    });
  }

  // The company it's for.
  const companies = [...new Set((ns?.lines ?? []).map((l) => l.company))].sort();
  {
    const same = ns && companies.length ? companies.length === 1 && companies[0] === own.company : null;
    fields.push({
      field: 'company',
      label: 'Company',
      fleetsuite: own.company,
      netsuite: ns ? (companies.length ? listed(companies) : null) : null,
      same,
      why: same === false
        ? `FleetSuite kept it for ${own.company}, as its copy of the purchase order doesn't say the company, and NetSuite's receipt is ${listed(companies)}'s.`
        : null,
    });
  }

  // What came in: each item and how many.
  {
    const same = !ns ? null : itemsDiffer.length ? false : true;
    const more = itemsDiffer.length - 1;
    fields.push({
      field: 'items',
      label: 'Items',
      fleetsuite: plural(ownItems.size, 'item', 'items'),
      netsuite: ns ? plural(netItems.size, 'item', 'items') : null,
      same,
      why: same === false ? `${itemsDiffer[0]}${more > 0 ? ` ${plural(more, 'other item differs', 'other items differ')}.` : ''}` : null,
    });
  }

  // What it added to stock.
  {
    const same = ns && valued && ownStockCents !== null ? ownStockCents === netsuiteCents : null;
    let why: string | null = null;
    if (unlisted.length) {
      why = `FleetSuite didn't know whether ${listed(unlisted)} ${unlisted.length > 1 ? 'are' : 'is'} kept in stock (the copy of NetSuite's items doesn't have ${unlisted.length > 1 ? 'them' : 'it'} yet).`;
    } else if (unpriced.length) {
      why = `FleetSuite's copy of the purchase order had no price for ${listed(unpriced)}.`;
    } else if (ns && valued && !pair.in_ledger) {
      why = "NetSuite's receipt added nothing to stock: the copy of its general ledger, made since, has no entry for it.";
    } else if (same === false) {
      why = apart(ownStockCents!, netsuiteCents!);
    }
    fields.push({
      field: 'cost',
      label: 'Added to stock',
      fleetsuite: ownStockCents !== null ? dollars(ownStockCents) : null,
      netsuite: netsuiteCents !== null ? dollars(netsuiteCents) : null,
      same,
      why,
    });
  }

  const differing = fields.filter((f) => f.same === false).length;
  const unknownWords: string[] = [];
  if (unpriced.length) {
    unknownWords.push(`the price of ${listed(unpriced)} (FleetSuite's copy of the purchase order had none), so what it added to stock`);
  }
  if (unlisted.length) {
    unknownWords.push(`whether ${listed(unlisted)} ${unlisted.length > 1 ? 'are' : 'is'} kept in stock (the copy of NetSuite's items doesn't have ${unlisted.length > 1 ? 'them' : 'it'} yet)`);
  }

  let status: ReceiptStatus;
  let summary: string;
  if (!own.netsuite_id) {
    if (receiving.manualNeeded > 0) {
      status = 'not_in_netsuite';
      summary = "NetSuite didn't take it, so it's on Receiving's list to enter by hand there.";
    } else if (receiving.manualDone > 0) {
      status = 'incomplete';
      summary = "Entered in NetSuite by hand. Receiving doesn't say which item receipt that is, so it isn't checked.";
    } else if (receiving.posted > 0) {
      status = 'incomplete';
      summary = "NetSuite took it but didn't say which item receipt it made, so it isn't checked.";
    } else {
      status = 'incomplete';
      summary = "NetSuite didn't say which item receipt it made, and Receiving no longer has it, so it isn't checked.";
    }
  } else if (gone) {
    status = 'voided';
    summary = "NetSuite's receipt is gone from NetSuite.";
  } else if (!ns && stockRanSince) {
    // The stock copy takes only documents that move stock, so one with nothing kept in stock on it is never there.
    if ([...ownItems.values()].some((o) => stockOf(o.itemId) === true)) {
      status = 'voided';
      summary = "NetSuite's receipt is gone from NetSuite: the copy of its stock moves, made since, doesn't have it.";
    } else {
      status = 'incomplete';
      summary = "Nothing on it is known to be kept in stock, so NetSuite's receipt isn't in the copy of its stock moves to check against.";
    }
  } else if (!ns) {
    status = 'waiting';
    summary = "Waiting for NetSuite's receipt: the copy of NetSuite's stock moves runs every two hours.";
  } else if (differing) {
    status = 'differs';
    const first = fields.find((f) => f.same === false)!;
    const what = first.why ?? `FleetSuite ${first.fleetsuite ?? 'nothing'}, NetSuite ${first.netsuite ?? 'nothing'}.`;
    // What it added to stock follows from what came in.
    const others = fields
      .filter((f) => f.same === false && f !== first && !(f.field === 'cost' && fields.some((x) => x.field === 'items' && x.same === false)))
      .map((f) => f.field);
    const too = listed(others.map((f) => FIELD_WORDS[f]));
    summary = `${first.field === 'items' ? '' : `${first.label}: `}${what}${others.length
      ? ` ${too.charAt(0).toUpperCase()}${too.slice(1)} ${others.length > 1 || others[0] === 'items' ? 'differ' : 'differs'} too.`
      : ''}`;
  } else if (!valued) {
    status = 'waiting';
    summary = "Waiting for the copy of NetSuite's general ledger to reach the receipt.";
  } else if (unknownWords.length) {
    status = 'incomplete';
    summary = `Matches where it can be checked. FleetSuite didn't know ${listed(unknownWords)}.`;
  } else {
    status = 'matches';
    summary = `${theirs} has the same items, counts and cost.`;
  }

  const one = ownItems.size === 1 ? [...ownItems.values()][0] : null;
  const what = one ? `${qty(one.quantity)} ${itemName(one.itemId, one.itemNumber)}` : plural(ownItems.size, 'item', 'items');

  const workedOut = [
    `Made by Receive on the Receiving page on ${dayText(own.date)}, against ${poNumber}${own.vendor_name ? ` from ${own.vendor_name}` : ''}.`,
    "Its lines are what was received, each at the price FleetSuite's copy of the purchase order has for its line.",
    "What it added to stock is the items NetSuite keeps in stock, each its quantity at that price, to the cent. NetSuite's is what its receipt posted to the inventory accounts.",
    'Dated as FleetSuite dated it for NetSuite: the day it was received in UTC, which in the evening, Central time, is already the next day.',
    `It's kept for ${own.company}: FleetSuite's copy of the purchase order doesn't say the company, and NetSuite makes the receipt in the PO's.`,
  ];

  return {
    receiptKey: own.receipt_key,
    netsuiteId: own.netsuite_id,
    number,
    date: own.date,
    company: own.company,
    poId: own.po_id,
    poNumber,
    vendor: own.vendor_name,
    location,
    what,
    status,
    summary,
    differing,
    fleetsuiteCents: ownStockCents,
    netsuiteCents: ns ? netsuiteCents : null,
    fields,
    items,
    netsuiteError: own.netsuite_id ? null : own.netsuite_error,
    receiving,
    unknowns: unknownWords,
    workedOut,
  };
}

export interface OwnReceiptsChecked {
  receipts: OwnReceiptCheck[];
  counts: Record<ReceiptStatus, number>;
}

/** Every own receipt gl_own_receipt_pairs returned, each checked. */
export function checkOwnReceipts(data: ReceiptPairsData, copies: ReceiptCopiesThrough): OwnReceiptsChecked {
  const lists = receiptLists(data);
  const receipts = (data.receipts ?? []).map((pair) => checkOwnReceipt(pair, lists, copies));
  const counts = Object.fromEntries(RECEIPT_STATUSES.map((s) => [s, 0])) as Record<ReceiptStatus, number>;
  for (const r of receipts) counts[r.status]++;
  return { receipts, counts };
}
