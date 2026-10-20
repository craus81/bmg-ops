import { centsOf } from './invoice-check';
import { dayText, MADE_FROM_TEXT, OWN_CHECK_STATUSES, type OwnCheckStatus } from './own-invoice-check';
import type { FulfilledFrom, FulfilUnknown, KeptType, LocationFrom } from './own-fulfillments';

/**
 * FleetSuite's own fulfillments next to NetSuite's (migration 417,
 * docs/books.md "FleetSuite's own fulfillments"; owner decision 2026-10-19,
 * thread "Replacing NetSuite with FleetSuite", "Fulfillments").
 *
 * Each copy FleetSuite kept of a fulfillment it made
 * (src/lib/books/own-fulfillments.ts) is put next to NetSuite's fulfillment
 * as the copy of NetSuite's stock moves has it (migration 401), valued from
 * the copy of its general ledger: its date, where it took stock from, each
 * item and how many, and what it cost.
 *
 * FleetSuite works the cost out itself, from stock by item: an item's cost
 * each is the value FleetSuite counted of it at that location just before
 * the fulfillment over the count (its count and value on December 31, 2024
 * and every NetSuite document since that comes before the fulfillment, by
 * date and then NetSuite's id, as gl_own_fulfillment_pairs adds them up),
 * and each line costs its quantity at that, to the cent. NetSuite's cost is
 * what its fulfillment took off the inventory accounts.
 *
 * A copy:
 *   - waits until the copy of NetSuite's stock moves (every two hours) has
 *     NetSuite's fulfillment and the copy of its general ledger has its
 *     entry. Once the stock copy has run since and doesn't have it,
 *     NetSuite's took nothing from stock (that copy takes only documents
 *     that move stock); once the ledger copy has run since and has no entry,
 *     NetSuite's booked no cost;
 *   - is gone (status 'voided') when NetSuite deleted its fulfillment;
 *   - differs when anything compared differs;
 *   - is incomplete when nothing compared differs but FleetSuite couldn't
 *     work something out, which isn't compared;
 *   - matches otherwise.
 *
 * Pure. Amounts are whole cents, a cost positive.
 */

// ── What gl_own_fulfillment_pairs returns ──────────────────────────────────

export interface OwnFulfilLineData {
  line_no: number;
  item_id: string;
  item_number: string | null;
  description: string | null;
  item_type: KeptType | null;
  quantity: string;
  sales_order_line_id: string | null;
}

export interface OwnFulfillmentData {
  netsuite_id: string;
  number: string | null;
  made_from: FulfilledFrom;
  made_from_id: string | null;
  sales_order_id: string;
  customer_netsuite_id: string | null;
  date: string;
  location_id: string | null;
  location_from: LocationFrom | null;
  unknowns: FulfilUnknown[];
  made_at: string;
  lines: OwnFulfilLineData[];
}

export interface NetsuiteFulfilLineData {
  line_id: string;
  item_id: string;
  location_id: string | null;
  /** Signed, stock out negative. */
  quantity: string;
  moves_stock: boolean;
  /** What NetSuite posted to an inventory account on the line, debit positive; null when the ledger copy has nothing on it. */
  value: string | null;
}

export interface NetsuiteFulfillmentData {
  number: string | null;
  type: string;
  date: string;
  gone: boolean;
  lines: NetsuiteFulfilLineData[];
}

/** What FleetSuite counted of an item at a location just before the fulfillment. */
export interface PlaceData {
  item_id: string;
  location_id: string | null;
  quantity: string;
  value: string;
}

export interface FulfilPairData {
  own: OwnFulfillmentData;
  netsuite: NetsuiteFulfillmentData | null;
  /** Null before the copy of NetSuite's general ledger has the fulfillment. */
  netsuite_gl: { posting_month: string; entry: Array<{ account_id: string; debit: string; credit: string }> } | null;
  before: PlaceData[];
  sales_order: { number: string | null; customer_name: string | null } | null;
  invoice: { netsuite_id: string; number: string | null } | null;
}

export interface FulfilPairsData {
  fulfillments: FulfilPairData[];
  items: Record<string, { number: string; type: string | null; display_name: string | null }>;
  locations: Record<string, string>;
  accounts: Record<string, { number: string | null; name: string }>;
}

/** How far the copies of NetSuite's stock moves and general ledger had come: each one's sync_state last_synced_at. */
export interface CopiesThrough {
  /** Every document NetSuite changed before this is in the copy of its stock moves. */
  stock: string | null;
  /** When the copy of NetSuite's general ledger last finished a whole run. */
  ledger: string | null;
}

// ── What the check says ────────────────────────────────────────────────────

export type FulfilField = 'date' | 'location' | 'items' | 'cost';

export interface FulfilFieldCheck {
  field: FulfilField;
  label: string;
  /** What FleetSuite's copy says, in words; null when it couldn't work it out. */
  fleetsuite: string | null;
  /** What NetSuite's fulfillment says; null when its copies don't say yet. */
  netsuite: string | null;
  /** Null when it isn't compared. */
  same: boolean | null;
  /** Why it differs, or why it isn't compared. */
  why: string | null;
}

export interface FulfilItemPair {
  /** The item's number. */
  item: string;
  itemId: string;
  description: string | null;
  fleetsuite: {
    quantity: number;
    /** Kept in stock, a kit of parts FleetSuite doesn't know, or an item the lists copy doesn't have. */
    kind: 'stock' | 'kit' | 'unknown';
    location: string | null;
    /** What FleetSuite counted of it there just before; null with no location. */
    count: number | null;
    valueCents: number | null;
    /** Cost each, in cents (not rounded); null when it couldn't be worked out. */
    each: number | null;
    cents: number | null;
  } | null;
  netsuite: {
    quantity: number;
    locations: string[];
    each: number | null;
    /** Null before the copy of NetSuite's general ledger values it. */
    cents: number | null;
  } | null;
  same: boolean | null;
  why: string | null;
}

export interface FulfilEntryLine {
  account: string;
  debit: number;
  credit: number;
}

export interface OwnFulfillmentCheck {
  netsuiteId: string;
  number: string;
  date: string;
  madeFrom: FulfilledFrom;
  /** 'a finished vehicle', … */
  madeFromText: string;
  customer: string | null;
  salesOrderId: string;
  salesOrder: string;
  /** Where FleetSuite took stock from, NetSuite's id for it; null when it didn't know. */
  locationId: string | null;
  /** FleetSuite's own invoice off the order made since, when there is one. */
  invoice: { netsuiteId: string; number: string } | null;
  status: OwnCheckStatus;
  /** One sentence for the list. */
  summary: string;
  /** How many of the things compared differ. */
  differing: number;
  /** Null when FleetSuite couldn't work its cost out. */
  fleetsuiteCost: number | null;
  /** Null before NetSuite's copies have it. */
  netsuiteCost: number | null;
  fields: FulfilFieldCheck[];
  items: FulfilItemPair[];
  /** What NetSuite's fulfillment posted, account by account. */
  entry: FulfilEntryLine[];
  /** What FleetSuite couldn't work out, in words. */
  unknowns: string[];
  /** How FleetSuite worked its copy out, a sentence each. */
  workedOut: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => money.format(cents / 100);
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
export const qty = (n: number) => String(Number(n.toFixed(4)));
const sameQuantity = (a: number, b: number) => Math.abs(a - b) < 0.00005;

/** Whole cents, half away from zero (never -0). */
const roundCents = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x)) || 0;

/** A cost each, in cents, as money: to the cent when it is whole cents, else to four places. */
export function eachText(cents: number): string {
  if (Math.abs(cents - Math.round(cents)) < 1e-6) return dollars(Math.round(cents));
  const fixed = (Math.abs(cents) / 100).toFixed(4).replace(/0{1,2}$/, '');
  const [whole, part] = fixed.split('.');
  return `${cents < 0 ? '-' : ''}$${Number(whole).toLocaleString('en-US')}.${part}`;
}

/** What a quantity costs at a count and value just before, in whole cents; null when there was none to cost it from. */
export function costAt(quantity: number, count: number, valueCents: number): number | null {
  if (!(count > 0)) return null;
  return roundCents((quantity * valueCents) / count);
}

const placeKey = (item: string, location: string | null) => `${item}|${location ?? ''}`;

/** The copied lists the check reads names from. */
export interface FulfilLists {
  items: Map<string, { number: string; type: string | null; displayName: string | null }>;
  locations: Map<string, string>;
  accounts: Map<string, { number: string | null; name: string }>;
}

export function fulfilLists(data: Pick<FulfilPairsData, 'items' | 'locations' | 'accounts'>): FulfilLists {
  return {
    items: new Map(Object.entries(data.items ?? {}).map(([id, i]) => [id, { number: i.number, type: i.type, displayName: i.display_name }])),
    locations: new Map(Object.entries(data.locations ?? {})),
    accounts: new Map(Object.entries(data.accounts ?? {})),
  };
}

/** What FleetSuite couldn't work out, in words. */
const UNKNOWN_TEXT: Readonly<Record<FulfilUnknown, string>> = {
  lines: "what it took from stock (FleetSuite's copy of the sales order didn't have the order yet)",
  location: 'where it took stock from, so what it cost',
};

/** What's compared, in a sentence. */
const FIELD_WORDS: Readonly<Record<FulfilField, string>> = {
  date: 'the date',
  location: 'the location',
  items: 'the items',
  cost: 'the cost',
};

/** How far NetSuite's amount is from FleetSuite's, in a sentence. */
const apart = (fleetsuite: number, netsuite: number) =>
  `NetSuite's is ${dollars(Math.abs(netsuite - fleetsuite))} ${netsuite > fleetsuite ? 'more' : 'less'}.`;

// ── One fulfillment ────────────────────────────────────────────────────────

interface OwnItem {
  itemId: string;
  itemNumber: string | null;
  description: string | null;
  kind: 'stock' | 'kit' | 'unknown';
  quantity: number;
  /** Each line costed on its own, then added up; null once one can't be. */
  cents: number | null;
}

interface NetItem {
  itemId: string;
  quantity: number;
  locations: Set<string | null>;
  valueCents: number;
}

/** FleetSuite's own fulfillment next to NetSuite's. */
export function checkOwnFulfillment(pair: FulfilPairData, lists: FulfilLists, copies: CopiesThrough): OwnFulfillmentCheck {
  const own = pair.own;
  const unknowns = new Set(own.unknowns ?? []);
  const gone = !!pair.netsuite?.gone;
  const ns = pair.netsuite && !gone ? pair.netsuite : null;
  const madeAt = Date.parse(own.made_at);
  // The stock copy takes only documents that move stock: one that ran since without it means NetSuite's took none.
  const stockRanSince = !!copies.stock && Date.parse(copies.stock) > madeAt;
  const ledgerRanSince = !!copies.ledger && Date.parse(copies.ledger) > madeAt + LEDGER_RUN_MS;
  const tookNothing = !ns && !gone && stockRanSince;
  // NetSuite's cost is known once its ledger copy has the fulfillment, or has run since without it (no cost booked).
  const nsValued = tookNothing || (!!ns && (!!pair.netsuite_gl || ledgerRanSince));

  const number = own.number || pair.netsuite?.number || `NetSuite ${own.netsuite_id}`;
  const customer = pair.sales_order?.customer_name ?? null;
  const salesOrder = pair.sales_order?.number || `NetSuite ${own.sales_order_id}`;
  const locationName = (id: string | null) => (id ? lists.locations.get(id) ?? `Location ${id}` : 'no location');
  const itemName = (id: string, itemNumber: string | null) => itemNumber || lists.items.get(id)?.number || `NetSuite item ${id}`;
  const before = new Map((pair.before ?? []).map((b) => [placeKey(b.item_id, b.location_id), { count: num(b.quantity) ?? 0, valueCents: centsOf(b.value) ?? 0 }]));
  const ownLocation = own.location_id;
  const ownPlace = (item: string) => (ownLocation ? before.get(placeKey(item, ownLocation)) ?? { count: 0, valueCents: 0 } : null);

  // FleetSuite's side, item by item, each line costed at the item's cost each at its location just before.
  const ownItems = new Map<string, OwnItem>();
  for (const l of own.lines ?? []) {
    const quantity = num(l.quantity) ?? 0;
    const kind: OwnItem['kind'] = l.item_type === 'Kit' ? 'kit' : l.item_type ? 'stock' : 'unknown';
    const place = ownPlace(l.item_id);
    const lineCents = kind === 'stock' && place ? costAt(quantity, place.count, place.valueCents) : null;
    const item = ownItems.get(l.item_id);
    if (item) {
      item.quantity += quantity;
      item.cents = item.cents === null || lineCents === null ? null : item.cents + lineCents;
    } else {
      ownItems.set(l.item_id, {
        itemId: l.item_id, itemNumber: l.item_number, description: l.description, kind, quantity, cents: lineCents,
      });
    }
  }

  // NetSuite's side, item by item: what it took from stock and where, and what that took off the inventory accounts.
  const netItems = new Map<string, NetItem>();
  for (const l of ns?.lines ?? []) {
    const item = netItems.get(l.item_id) ?? { itemId: l.item_id, quantity: 0, locations: new Set<string | null>(), valueCents: 0 };
    if (l.moves_stock) {
      item.quantity -= num(l.quantity) ?? 0;
      item.locations.add(l.location_id);
    }
    if (l.value !== null && l.value !== undefined) item.valueCents += centsOf(l.value) ?? 0;
    netItems.set(l.item_id, item);
  }
  // A line that moved nothing and posted nothing to stock (a non-inventory part, say) isn't stock.
  for (const [id, item] of netItems) if (sameQuantity(item.quantity, 0) && item.valueCents === 0) netItems.delete(id);
  // What it took off the inventory accounts, a cost positive (and never -0, which prints as -$0.00).
  const netCents = (item: NetItem) => (nsValued ? (item.valueCents ? -item.valueCents : 0) : null);
  const netLocations = (item: NetItem) => [...item.locations].map(locationName).sort();

  const kits = [...ownItems.values()].filter((i) => i.kind === 'kit');
  const unlisted = [...ownItems.values()].filter((i) => i.kind === 'unknown');
  const linesKnown = !unknowns.has('lines');
  const nsKnown = !!ns || tookNothing;
  // Where it took stock from matters only when it took something.
  const locationUnknown = !ownLocation && ownItems.size > 0;

  // Each item, FleetSuite's paired with NetSuite's by item.
  const items: FulfilItemPair[] = [];
  const uncosted: string[] = [];
  /** What differs in what was taken, item by item: another quantity, or an item only one side took. */
  const takenDiffers: string[] = [];
  /** Whether some item's taking can't be compared: a kit, what NetSuite took that may be its parts, an item not known to move stock. */
  let takenUnknown = false;
  for (const o of ownItems.values()) {
    const n = o.kind === 'kit' ? undefined : netItems.get(o.itemId);
    const name = itemName(o.itemId, o.itemNumber);
    const place = ownPlace(o.itemId);
    const fleetsuite = {
      quantity: o.quantity,
      kind: o.kind,
      location: ownLocation ? locationName(ownLocation) : null,
      count: o.kind === 'stock' && place ? place.count : null,
      valueCents: o.kind === 'stock' && place ? place.valueCents : null,
      each: o.kind === 'stock' && place && place.count > 0 ? place.valueCents / place.count : null,
      cents: o.cents,
    };
    if (o.kind === 'stock' && ownLocation && o.cents === null) uncosted.push(name);
    const netsuite = n
      ? { quantity: n.quantity, locations: netLocations(n), cents: netCents(n), each: netCents(n) !== null && n.quantity > 0 ? netCents(n)! / n.quantity : null }
      : null;

    let same: boolean | null;
    let why: string | null = null;
    if (o.kind === 'kit') {
      same = null;
      why = `${name} is a kit: FleetSuite doesn't know its parts, so what NetSuite took for it isn't compared.`;
      takenUnknown = true;
    } else if (!nsKnown) {
      same = null;
    } else if (!netsuite) {
      if (o.kind === 'unknown') {
        same = null;
        why = `FleetSuite didn't know whether ${name} is kept in stock (the copy of NetSuite's items doesn't have it yet), and NetSuite's fulfillment took none of it from stock.`;
        takenUnknown = true;
      } else {
        same = false;
        why = `FleetSuite took ${qty(o.quantity)} of ${name} from stock${o.cents !== null ? ` (${dollars(o.cents)})` : ''}, and NetSuite's fulfillment took none.`;
        takenDiffers.push(why);
      }
    } else {
      const quantitySame = sameQuantity(o.quantity, netsuite.quantity);
      const where = [...n!.locations];
      const locationSame = ownLocation && where.length ? where.length === 1 && where[0] === ownLocation : null;
      const costSame = o.cents !== null && netsuite.cents !== null ? o.cents === netsuite.cents : null;
      const parts = [quantitySame, locationSame, costSame];
      same = parts.includes(false) ? false : parts.includes(null) ? null : true;
      const reasons: string[] = [];
      if (!quantitySame) {
        reasons.push(`FleetSuite took ${qty(o.quantity)} of ${name} from stock, and NetSuite ${qty(netsuite.quantity)}.`);
        takenDiffers.push(reasons[0]);
      }
      if (locationSame === false) reasons.push(`FleetSuite took it from ${locationName(ownLocation)}, and NetSuite from ${listed(netsuite.locations)}.`);
      // Another quantity costs another amount, so the cost is told about only for the same quantity.
      if (costSame === false && quantitySame) {
        const at = fleetsuite.each !== null && fleetsuite.count !== null && fleetsuite.valueCents !== null
          ? ` (${qty(o.quantity)} at ${eachText(fleetsuite.each)} each, from the ${qty(fleetsuite.count)} worth ${dollars(fleetsuite.valueCents)} FleetSuite counted at ${locationName(ownLocation)} just before)`
          : '';
        const theirs = netsuite.each !== null ? ` (${eachText(netsuite.each)} each)` : '';
        reasons.push(`FleetSuite's cost is ${dollars(o.cents!)}${at}, and NetSuite's ${dollars(netsuite.cents!)}${theirs}. ${apart(o.cents!, netsuite.cents!)}`);
      }
      if (o.kind === 'unknown') {
        reasons.push(`FleetSuite didn't know ${name} is kept in stock (the copy of NetSuite's items doesn't have it yet), so not what it cost.`);
      } else if (o.cents === null && ownLocation) {
        reasons.push(`FleetSuite counted none of ${name} at ${locationName(ownLocation)} just before, so it can't work out what it cost.`);
      } else if (!ownLocation) {
        reasons.push(`FleetSuite didn't know where it took ${name} from, so not what it cost.`);
      }
      why = reasons.length ? reasons.join(' ') : null;
    }
    items.push({ item: name, itemId: o.itemId, description: o.description, fleetsuite, netsuite, same, why });
  }
  for (const n of netItems.values()) {
    if (ownItems.has(n.itemId) && ownItems.get(n.itemId)!.kind !== 'kit') continue;
    const name = itemName(n.itemId, null);
    const cents = netCents(n);
    const netsuite = { quantity: n.quantity, locations: netLocations(n), cents, each: cents !== null && n.quantity > 0 ? cents / n.quantity : null };
    const took = `NetSuite's fulfillment took ${qty(n.quantity)} of ${name}${cents !== null ? ` (${dollars(cents)})` : ''}`;
    // With a kit in FleetSuite's copy this may be one of its parts, and the kit already leaves what was taken not known.
    if (!kits.length && linesKnown) takenDiffers.push(`${took}, and FleetSuite's copy of the sales order didn't have it still to bill.`);
    items.push(kits.length
      ? { item: name, itemId: n.itemId, description: lists.items.get(n.itemId)?.displayName ?? null, fleetsuite: null, netsuite, same: null,
        why: `${took}, which FleetSuite's copy doesn't have: it may be a part of ${listed(kits.map((k) => itemName(k.itemId, k.itemNumber)))}, a kit FleetSuite doesn't know the parts of.` }
      : { item: name, itemId: n.itemId, description: lists.items.get(n.itemId)?.displayName ?? null, fleetsuite: null, netsuite, same: linesKnown ? false : null,
        why: linesKnown ? `${took}, and FleetSuite's copy of the sales order didn't have it still to bill.` : null });
  }

  const fields: FulfilFieldCheck[] = [];

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
        ? `FleetSuite made it ${dayText(own.date)}, and NetSuite's fulfillment is dated ${plural(Math.abs(days), 'day', 'days')} ${days > 0 ? 'later' : 'earlier'}.`
        : tookNothing ? "NetSuite's fulfillment isn't in the copy of its stock moves, which takes only documents that move stock." : null,
    });
  }

  // Where it took stock from.
  {
    const where = new Set<string | null>();
    for (const n of netItems.values()) for (const l of n.locations) where.add(l);
    const theirs = [...where];
    const same = ownLocation && ns && theirs.length ? theirs.length === 1 && theirs[0] === ownLocation : null;
    let why: string | null = null;
    if (locationUnknown) why = `FleetSuite didn't know where it took stock from: its invoice location rule couldn't tell from ${customer ?? 'the customer'}.`;
    else if (same === false) {
      const rule = own.location_from === 'po_rule' ? "FleetSuite's PO location rule" : "FleetSuite's invoice location rule";
      why = `${rule} puts it in ${locationName(ownLocation)}, and NetSuite took stock from ${listed(theirs.map(locationName).sort())}.`;
    }
    fields.push({
      field: 'location',
      label: 'Location',
      fleetsuite: ownLocation ? locationName(ownLocation) : null,
      netsuite: ns ? (theirs.length ? listed(theirs.map(locationName).sort()) : 'None') : tookNothing ? 'None' : null,
      same,
      why,
    });
  }

  // What it took from stock: each item and how many, whatever it cost and wherever from, which are compared apart.
  {
    const compared = linesKnown && nsKnown;
    const same = !compared ? null : takenDiffers.length ? false : takenUnknown ? null : true;
    let why: string | null = null;
    if (!linesKnown) why = `FleetSuite didn't know ${UNKNOWN_TEXT.lines}.`;
    else if (tookNothing && takenDiffers.length) {
      why = "NetSuite's fulfillment took nothing from stock, or is gone from NetSuite: the copy of NetSuite's stock moves, made since, doesn't have it.";
    } else if (compared && takenDiffers.length) {
      const more = takenDiffers.length - 1;
      why = `${takenDiffers[0]}${more > 0 ? ` ${plural(more, 'other item differs', 'other items differ')}.` : ''}`;
    }
    fields.push({
      field: 'items',
      label: 'Items',
      fleetsuite: linesKnown ? (ownItems.size ? plural(ownItems.size, 'item', 'items') : 'Nothing from stock') : null,
      netsuite: nsKnown ? (netItems.size ? plural(netItems.size, 'item', 'items') : 'Nothing from stock') : null,
      same,
      why,
    });
  }

  // What it cost.
  const ownCostKnown = linesKnown && !locationUnknown && !kits.length && !unlisted.length && !uncosted.length;
  const fleetsuiteCost = ownCostKnown ? [...ownItems.values()].reduce((sum, i) => sum + (i.cents ?? 0), 0) : null;
  const netsuiteCost = nsValued ? [...netItems.values()].reduce((sum, i) => sum - i.valueCents, 0) : null;
  // The ledger copy has run since and has nothing for NetSuite's fulfillment.
  const bookedNothing = !!ns && !pair.netsuite_gl && ledgerRanSince;
  {
    const same = fleetsuiteCost !== null && netsuiteCost !== null ? fleetsuiteCost === netsuiteCost : null;
    let why: string | null = null;
    if (!linesKnown) why = `FleetSuite didn't know ${UNKNOWN_TEXT.lines}.`;
    else if (locationUnknown) why = "FleetSuite didn't know where it took stock from, so not what it cost.";
    else if (kits.length) why = `FleetSuite doesn't know the parts of ${listed(kits.map((k) => itemName(k.itemId, k.itemNumber)))}, so not what they cost.`;
    else if (unlisted.length) why = `FleetSuite didn't know whether ${listed(unlisted.map((i) => itemName(i.itemId, i.itemNumber)))} ${unlisted.length > 1 ? 'are' : 'is'} kept in stock, so not what ${unlisted.length > 1 ? 'they' : 'it'} cost.`;
    else if (uncosted.length) why = `FleetSuite counted none of ${listed(uncosted)} at ${locationName(ownLocation)} just before, so it can't work out what ${uncosted.length > 1 ? 'they' : 'it'} cost.`;
    else if (bookedNothing) why = "NetSuite's fulfillment booked no cost: the copy of its general ledger, made since, has no entry for it.";
    else if (same === false) why = apart(fleetsuiteCost!, netsuiteCost!);
    fields.push({
      field: 'cost',
      label: 'Cost',
      fleetsuite: fleetsuiteCost !== null ? dollars(fleetsuiteCost) : null,
      netsuite: netsuiteCost !== null ? dollars(netsuiteCost) : null,
      same,
      why,
    });
  }

  const differing = fields.filter((f) => f.same === false).length;
  const unknownWords: string[] = [];
  if (!linesKnown) unknownWords.push(UNKNOWN_TEXT.lines);
  if (locationUnknown) unknownWords.push(UNKNOWN_TEXT.location);
  if (kits.length) unknownWords.push(`the parts of ${listed(kits.map((k) => itemName(k.itemId, k.itemNumber)))}, ${kits.length > 1 ? 'kits' : 'a kit'}`);
  if (unlisted.length) {
    unknownWords.push(`whether ${listed(unlisted.map((i) => itemName(i.itemId, i.itemNumber)))} ${unlisted.length > 1 ? 'are' : 'is'} kept in stock (the copy of NetSuite's items doesn't have ${unlisted.length > 1 ? 'them' : 'it'} yet)`);
  }
  if (uncosted.length && ownLocation) unknownWords.push(`what ${listed(uncosted)} cost: it counted none at ${locationName(ownLocation)} just before`);

  let status: OwnCheckStatus;
  let summary: string;
  if (gone) {
    status = 'voided';
    summary = "NetSuite's fulfillment is gone from NetSuite.";
  } else if (!ns && !tookNothing) {
    status = 'waiting';
    summary = "Waiting for NetSuite's fulfillment: the copy of NetSuite's stock moves runs every two hours.";
  } else if (ns && !nsValued) {
    status = 'waiting';
    summary = "Waiting for the copy of NetSuite's general ledger to reach the fulfillment.";
  } else if (differing) {
    status = 'differs';
    const first = fields.find((f) => f.same === false)!;
    const what = first.why ?? `FleetSuite ${first.fleetsuite ?? 'nothing'}, NetSuite ${first.netsuite ?? 'nothing'}.`;
    const differs = (f: FulfilField) => fields.some((x) => x.field === f && x.same === false);
    // The cost follows from what was taken and from where.
    const follows = (f: FulfilField) => f === 'cost' && (differs('items') || differs('location'));
    const others = fields.filter((f) => f.same === false && f !== first && !follows(f.field)).map((f) => f.field);
    const too = listed(others.map((f) => FIELD_WORDS[f]));
    summary = `${first.label}: ${what}${others.length
      ? ` ${too.charAt(0).toUpperCase()}${too.slice(1)} ${others.length > 1 || others[0] === 'items' ? 'differ' : 'differs'} too.`
      : ''}`;
  } else if (unknownWords.length) {
    status = 'incomplete';
    summary = `Matches where it can be checked. FleetSuite didn't know ${listed(unknownWords)}.`;
  } else if (tookNothing) {
    status = 'matches';
    summary = "Took nothing from stock, and nor did NetSuite's fulfillment.";
  } else {
    status = 'matches';
    summary = "Matches NetSuite's fulfillment.";
  }

  const entry = (pair.netsuite_gl?.entry ?? []).map((e) => {
    const account = lists.accounts.get(e.account_id);
    return {
      account: account ? [account.number, account.name].filter(Boolean).join(' ') : `NetSuite account ${e.account_id}`,
      debit: centsOf(e.debit) ?? 0,
      credit: centsOf(e.credit) ?? 0,
    };
  });

  const where = own.location_from === 'po_rule'
    ? `From ${locationName(ownLocation)}, where FleetSuite's PO location rule books the PO's invoice.`
    : own.location_from === 'customer_rule'
      ? `From ${locationName(ownLocation)}, where FleetSuite's invoice location rule books ${customer ?? 'the customer'}'s invoices.`
      : "Where it took stock from isn't known: FleetSuite's invoice location rule couldn't tell from the customer.";
  const workedOut = [
    `Made when FleetSuite invoiced ${MADE_FROM_TEXT[own.made_from] ?? own.made_from} on ${dayText(own.date)}: it fulfils a sales order before it bills it.`,
    `Its items are what FleetSuite's copy of ${salesOrder} still had to bill, of the items NetSuite keeps in stock.`,
    where,
    "Each item costs its average at that location just before the fulfillment: the value FleetSuite counted of it there over the count, "
      + "from its count and value on December 31, 2024 and every NetSuite document since that comes before it, as Stock by item counts them. "
      + 'A line costs its quantity at that average, to the cent.',
  ];

  return {
    netsuiteId: own.netsuite_id,
    number,
    date: own.date,
    madeFrom: own.made_from,
    madeFromText: MADE_FROM_TEXT[own.made_from] ?? own.made_from,
    customer,
    salesOrderId: own.sales_order_id,
    salesOrder,
    locationId: ownLocation,
    invoice: pair.invoice ? { netsuiteId: pair.invoice.netsuite_id, number: pair.invoice.number || `NetSuite ${pair.invoice.netsuite_id}` } : null,
    status,
    summary,
    differing,
    fleetsuiteCost,
    netsuiteCost,
    fields,
    items,
    entry,
    unknowns: unknownWords,
    workedOut,
  };
}

export interface OwnFulfillmentsChecked {
  fulfillments: OwnFulfillmentCheck[];
  counts: Record<OwnCheckStatus, number>;
}

/** Every own fulfillment gl_own_fulfillment_pairs returned, each checked. */
export function checkOwnFulfillments(data: FulfilPairsData, copies: CopiesThrough): OwnFulfillmentsChecked {
  const lists = fulfilLists(data);
  const fulfillments = (data.fulfillments ?? []).map((pair) => checkOwnFulfillment(pair, lists, copies));
  const counts = Object.fromEntries(OWN_CHECK_STATUSES.map((s) => [s, 0])) as Record<OwnCheckStatus, number>;
  for (const f of fulfillments) counts[f.status]++;
  return { fulfillments, counts };
}
