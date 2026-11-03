import { MADE_FROM_TEXT, OWN_CHECK_STATUSES, type OwnCheckStatus } from './own-invoice-check';
import {
  checkTaken, fulfilLists, locationNameIn,
  type CopiesThrough, type FulfilLists, type FulfilPairData, type NetsuiteFulfillmentData, type OwnFulfilLineData,
  type PlaceData, type TakenCheck, type TakenWords,
} from './own-fulfillment-check';
import { keptType, kitPartsOf, kitStockParts, type FulfilUnknown, type ListedItem } from './own-fulfillments';
import type { MadeFrom } from './own-invoices';

/**
 * What FleetSuite's own invoices took from stock, next to NetSuite's invoices
 * (migration 517, docs/books.md "Posting FleetSuite's own invoices' cost";
 * NetSuite Exit Checklist, "Gaps in what's built", thread "Replacing NetSuite
 * with FleetSuite", 2026-11-03).
 *
 * An invoice FleetSuite makes without a sales order (from the Scan Log, a
 * PO's open quantities, a graphics job, or typed in FleetSuite) takes its
 * stock itself: NetSuite takes each item it bills that NetSuite keeps in
 * stock, and each part of a kit it bills, from the invoice's location, and
 * books what that cost on the invoice. An invoice off a sales order takes
 * nothing: the order's fulfillment did (own-fulfillment-check.ts).
 *
 * Each own copy of such an invoice (src/lib/books/own-invoices.ts) is put
 * next to NetSuite's invoice as the copy of NetSuite's stock moves has it
 * (migration 401), valued from the copy of its general ledger, and checked
 * the way a fulfillment is (checkTaken in own-fulfillment-check.ts): its
 * date, where it took stock from, each item and how many, and what it cost.
 * The copy's items are the ones it bills that NetSuite keeps in stock, a kit
 * taken apart into its parts as the copy of NetSuite's items has them; an
 * item the copy of NetSuite's items doesn't have may be one, and leaves the
 * copy incomplete. Each is taken from the invoice's location, and costs its
 * average there just before the invoice, as Stock by item counts it.
 *
 * A copy waits, is gone, differs, is incomplete or matches as a
 * fulfillment's does. A copy FleetSuite fixed since it made it (migration
 * 471) waits for the copies of NetSuite made since the fix.
 *
 * Pure. Amounts are whole cents, a cost positive.
 */

// ── What gl_own_invoice_cost_pairs returns ─────────────────────────────────

/** A line of the copy that bills an item NetSuite may keep in stock. */
export interface OwnInvoiceCostLineData {
  line_no: number;
  item_id: string;
  item_number: string | null;
  description: string | null;
  /** Its type in the copy of NetSuite's items ('InvtPart', 'Assembly' or 'Kit'); null when the copy doesn't have it, or doesn't type it. */
  item_type: string | null;
  quantity: string;
}

export interface OwnInvoiceCostData {
  netsuite_id: string;
  number: string | null;
  made_from: MadeFrom;
  made_from_id: string | null;
  customer_netsuite_id: string | null;
  date: string;
  /** Where the invoice books; null when FleetSuite didn't know. */
  location_id: string | null;
  location_from: 'sent' | 'rule' | null;
  /** What FleetSuite couldn't work out of the invoice (own-invoices.ts Unknown). */
  unknowns: string[];
  made_at: string;
  /** When FleetSuite last fixed it (migration 471); null when it never did. */
  fixed_at: string | null;
  lines: OwnInvoiceCostLineData[];
}

export interface InvoiceCostPairData {
  own: OwnInvoiceCostData;
  /** NetSuite's invoice as the copy of its stock moves has it; null when the copy doesn't have it. */
  netsuite: NetsuiteFulfillmentData | null;
  /** Its cost lines in the copy of NetSuite's general ledger; null before that copy has the invoice. */
  netsuite_gl: FulfilPairData['netsuite_gl'];
  before: PlaceData[];
  customer_name: string | null;
}

export interface InvoiceCostPairsData {
  invoices: InvoiceCostPairData[];
  /** A kit's parts as the copy of NetSuite's items keeps them; null for any other item. */
  items: Record<string, { number: string; type: string | null; display_name: string | null; parts: unknown }>;
  locations: Record<string, string>;
  accounts: Record<string, { number: string | null; name: string }>;
}

// ── What the check says ────────────────────────────────────────────────────

export interface OwnInvoiceCostCheck extends Omit<TakenCheck, 'places' | 'tookApart'> {
  netsuiteId: string;
  number: string;
  date: string;
  madeFrom: MadeFrom;
  /** 'the Scan Log', … */
  madeFromText: string;
  customer: string | null;
  /** Where the invoice books, NetSuite's id for it; null when FleetSuite didn't know. */
  locationId: string | null;
  /** How FleetSuite worked out what its copy took, a sentence each, to follow how it worked the invoice out. */
  workedOut: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** A quantity to the four places the copies keep. */
const fourPlaces = (n: number) => Math.round(n * 10_000) / 10_000;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The copied lists the check reads names from, and each item as the copy of NetSuite's items has it, for taking kits apart. */
export interface InvoiceCostLists extends FulfilLists {
  /** Null for a kit's part the copy of NetSuite's items doesn't have. */
  listed: Map<string, ListedItem | null>;
}

export function invoiceCostLists(data: Pick<InvoiceCostPairsData, 'items' | 'locations' | 'accounts'>): InvoiceCostLists {
  const listed = new Map<string, ListedItem | null>();
  for (const [id, i] of Object.entries(data.items ?? {})) {
    listed.set(id, {
      number: i.number,
      type: i.type,
      displayName: i.display_name,
      parts: i.type === 'Kit' ? kitPartsOf({ parts: i.parts }) : null,
    });
  }
  // gl_own_invoice_cost_pairs gives every part of a kit the copy of NetSuite's items has, kits inside kits too, so
  // one it doesn't give is one the copy doesn't have: it may be kept in stock.
  for (const item of [...listed.values()]) for (const p of item?.parts ?? []) if (!listed.has(p.item)) listed.set(p.item, null);
  return { ...fulfilLists(data), listed };
}

/**
 * What the copy took from stock, line by line, as checkTaken takes it: each line that bills an item NetSuite may keep
 * in stock, a kit taken apart into its parts as the copy of NetSuite's items has them (each the kit's quantity times
 * what one kit holds), and whether it took one apart. A kit whose parts aren't known stays whole, for the check to say.
 */
export function invoiceTakenLines(lines: readonly OwnInvoiceCostLineData[], listed: ReadonlyMap<string, ListedItem | null>): OwnFulfilLineData[] {
  const out: OwnFulfilLineData[] = [];
  for (const l of lines) {
    const type = keptType(l.item_type);
    // Not kept in stock, a service say: gl_own_invoice_cost_pairs leaves those out already.
    if (type === undefined) continue;
    const parts = type === 'Kit' ? kitStockParts(l.item_id, listed) : null;
    if (!parts) {
      out.push({
        line_no: l.line_no, item_id: l.item_id, item_number: l.item_number, description: l.description, item_type: type,
        quantity: l.quantity, sales_order_line_id: null, kit_id: null, location_id: null,
      });
      continue;
    }
    const quantity = num(l.quantity) ?? 0;
    for (const p of parts) {
      out.push({
        line_no: l.line_no, item_id: p.itemId, item_number: p.itemNumber, description: p.description, item_type: p.itemType,
        quantity: String(fourPlaces(quantity * p.quantity)), sales_order_line_id: null, kit_id: l.item_id, location_id: null,
      });
    }
  }
  return out;
}

/** The words an invoice's check uses. */
function invoiceWords(own: OwnInvoiceCostData): TakenWords {
  return {
    theirs: "NetSuite's invoice",
    the: 'the invoice',
    notOnCopy: "FleetSuite's copy of the invoice doesn't bill it",
    linesUnknown: "what it took from stock (FleetSuite didn't know what the invoice billed)",
    // FleetSuite's invoice location rule goes by a sales order's customer, so an invoice made without one books where it
    // was told, or nowhere FleetSuite knows.
    whereUnknown: "FleetSuite didn't know where it took stock from: it didn't tell NetSuite where to book the invoice.",
    whereDiffers: (ours, theirs) => (own.location_from === 'rule'
      ? `FleetSuite's invoice location rule puts it in ${ours}, and NetSuite took stock from ${theirs}.`
      : `FleetSuite told NetSuite to book the invoice at ${ours}, and NetSuite took stock from ${theirs}.`),
  };
}

// ── One invoice ────────────────────────────────────────────────────────────

/** What FleetSuite's own invoice made without a sales order took from stock, next to what NetSuite's invoice took. */
export function checkOwnInvoiceCost(pair: InvoiceCostPairData, lists: InvoiceCostLists, copies: CopiesThrough): OwnInvoiceCostCheck {
  const own = pair.own;
  const number = own.number || pair.netsuite?.number || `NetSuite ${own.netsuite_id}`;
  const customer = pair.customer_name ?? null;
  // A copy FleetSuite fixed since is the invoice as fixed: NetSuite's copies have to have caught up with the fix.
  const madeAt = own.fixed_at && Date.parse(own.fixed_at) > Date.parse(own.made_at) ? own.fixed_at : own.made_at;
  const lines = invoiceTakenLines(own.lines ?? [], lists.listed);
  const { places, tookApart, ...taken } = checkTaken({
    own: {
      netsuite_id: own.netsuite_id,
      date: own.date,
      location_id: own.location_id,
      unknowns: (own.unknowns ?? []).filter((u): u is FulfilUnknown => u === 'lines' || u === 'location'),
      made_at: madeAt,
      lines,
    },
    netsuite: pair.netsuite,
    netsuite_gl: pair.netsuite_gl,
    before: pair.before,
  }, lists, copies, invoiceWords(own));

  const locationUnknown = !own.location_id || places.includes(null);
  const madeFromText = MADE_FROM_TEXT[own.made_from] ?? own.made_from;
  const at = locationNameIn(lists, own.location_id);
  const where = locationUnknown
    ? "Where it took stock from isn't known: FleetSuite didn't tell NetSuite where to book the invoice."
    : own.location_from === 'rule'
      ? `From ${at}, where FleetSuite's invoice location rule books ${customer ?? 'the customer'}'s invoices.`
      : `From ${at}, where FleetSuite told NetSuite to book the invoice.`;
  const workedOut = [
    "Made without a sales order, so the invoice takes its stock itself, as NetSuite's does.",
    "Its items are the ones it bills that NetSuite keeps in stock, as the copy of NetSuite's items has them.",
    ...(tookApart
      ? ["A kit is taken apart into its parts, each the kit's quantity times what one kit holds, as the copy of NetSuite's items has them. "
        + "NetSuite takes a kit's parts from stock, not the kit."]
      : []),
    where,
    "Each item costs its average at the invoice's location just before the invoice: the value FleetSuite counted of it there over the count, "
      + "from its count and value on December 31, 2024 and every NetSuite document since that comes before it, as Stock by item counts them. "
      + 'A line costs its quantity at that average, to the cent.',
  ];

  return {
    netsuiteId: own.netsuite_id,
    number,
    date: own.date,
    madeFrom: own.made_from,
    madeFromText,
    customer,
    locationId: own.location_id,
    ...taken,
    workedOut,
  };
}

export interface OwnInvoiceCostsChecked {
  invoices: OwnInvoiceCostCheck[];
  counts: Record<OwnCheckStatus, number>;
}

/** Every own invoice gl_own_invoice_cost_pairs returned, each checked. */
export function checkOwnInvoiceCosts(data: InvoiceCostPairsData, copies: CopiesThrough): OwnInvoiceCostsChecked {
  const lists = invoiceCostLists(data);
  const invoices = (data.invoices ?? []).map((pair) => checkOwnInvoiceCost(pair, lists, copies));
  const counts = Object.fromEntries(OWN_CHECK_STATUSES.map((s) => [s, 0])) as Record<OwnCheckStatus, number>;
  for (const c of invoices) counts[c.status]++;
  return { invoices, counts };
}
