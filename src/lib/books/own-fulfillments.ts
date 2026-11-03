import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { STOCK_TYPES } from './bill-rule';
import type { KitPart } from './netsuite-lists';
import { chicagoDate, OWN_COMPANY, ruleLocation, type MadeFrom, type SaveResult } from './own-invoices';

/**
 * FleetSuite's own copy of each fulfillment it makes (migration 416; owner
 * decision 2026-10-19, thread "Replacing NetSuite with FleetSuite",
 * "Fulfillments"; docs/books.md "FleetSuite's own fulfillments").
 *
 * FleetSuite fulfils a sales order before it invoices it, every open line
 * (fulfillSalesOrder in src/lib/netsuite.ts), from a finished vehicle or a
 * sales order's installed quantities. Right after NetSuite makes the
 * fulfillment, FleetSuite keeps its own copy of what it took from stock,
 * worked out from what it knows rather than read back from NetSuite:
 *
 *   - the lines are what FleetSuite's copy of the sales order
 *     (netsuite_sales_order_lines, copied every two hours) still had to
 *     bill, which FleetSuite fulfils before it bills, of the items NetSuite
 *     keeps in stock (inventory items and assemblies, as the lists copy has
 *     them). NetSuite takes a kit's parts from stock, not the kit, so a kit
 *     is taken apart into its parts (since 2026-11-03, migration 512), each
 *     the kit's quantity times what one kit holds and saying which kit it
 *     was taken for: the parts NetSuite's sales order lists for it, as lines
 *     of their own, which NetSuite keeps on the order from when it's entered
 *     (it won't fulfil a kit whose parts changed since) and FleetSuite's copy
 *     of the order doesn't mark, so which lines they are is read from
 *     NetSuite's order as the copy is made (a read: nothing is written); or,
 *     for a kit the order lists none for, its parts as the lists copy has
 *     them. A kit whose parts can't be known that way, and an item the lists
 *     copy doesn't have yet, are kept as they are, so the check can say so;
 *   - the location is where FleetSuite books the invoice: its PO location
 *     rule's for a sales order's installed quantities, its invoice location
 *     rule's from the customer for a finished vehicle;
 *   - the date is the day FleetSuite made it, in Central time.
 *
 * What it cost isn't kept on the copy: the check works it out from stock by
 * item, FleetSuite's own count and value of each item at each location, as
 * they stood just before the fulfillment
 * (src/lib/books/own-fulfillment-check.ts). So a document NetSuite dates
 * earlier that reaches the copies later still counts, as NetSuite counts it.
 * Nothing is written to NetSuite.
 *
 * Saving never stops an invoice: the fulfillment exists in NetSuite before
 * the copy is made, so a copy that can't be saved is logged and left.
 */

export type FulfilledFrom = Extract<MadeFrom, 'vehicle' | 'sales_order'>;
export type FulfilUnknown = 'lines' | 'location';
/** NetSuite's types for the items a copy keeps: kept in stock, or a kit FleetSuite couldn't take apart. */
export type KeptType = 'InvtPart' | 'Assembly' | 'Kit';
/** NetSuite's types for the items kept in stock. */
export type StockType = Exclude<KeptType, 'Kit'>;
/** 'po_rule': where FleetSuite's PO location rule books the PO's invoice; 'customer_rule': its invoice location rule's. */
export type LocationFrom = 'po_rule' | 'customer_rule';

/** A line FleetSuite takes from stock, as its copy of the sales order had it still to bill. */
export interface FulfilledLine {
  /** NetSuite's id for the item. */
  itemId: string;
  itemNumber: string | null;
  description: string | null;
  /** NetSuite's type for the item as the lists copy has it; null when that copy doesn't have the item. */
  itemType: KeptType | null;
  quantity: number;
  salesOrderLineId: string | null;
  /** NetSuite's id for the kit it was taken as a part of; null or absent for an item taken for itself. */
  kitId?: string | null;
}

export interface OwnFulfillmentInput {
  netsuiteId: string;
  netsuiteNumber: string | null;
  madeFrom: FulfilledFrom;
  madeFromId: string | null;
  salesOrderId: string;
  customerNetsuiteId: string | null;
  locationId: string | null;
  locationFrom: LocationFrom | null;
  /** 'YYYY-MM-DD', the day FleetSuite made it in Central time. */
  fulfilDate: string;
  /** Null when FleetSuite's copy of the sales order didn't have the order. */
  lines: FulfilledLine[] | null;
  madeBy: string | null;
}

export interface OwnFulfillmentLine extends FulfilledLine {
  lineNo: number;
}

export interface OwnFulfillment extends Omit<OwnFulfillmentInput, 'lines'> {
  lines: OwnFulfillmentLine[];
  unknowns: FulfilUnknown[];
}

/** FleetSuite's own copy of a fulfillment it made, from what it knows. Pure. */
export function workOutOwnFulfillment(input: OwnFulfillmentInput): OwnFulfillment {
  const unknowns: FulfilUnknown[] = [];
  if (input.lines === null) unknowns.push('lines');
  if (!input.locationId) unknowns.push('location');
  const lines = (input.lines ?? [])
    .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0)
    .map((l, i) => ({ ...l, lineNo: i + 1 }));
  const { lines: _fulfilled, ...header } = input;
  return { ...header, locationFrom: input.locationId ? input.locationFrom : null, lines, unknowns };
}

/** The copy as gl_own_fulfillment_save takes it. */
export function fulfillmentPayload(own: OwnFulfillment): Record<string, unknown> {
  return {
    netsuite_id: own.netsuiteId,
    netsuite_number: own.netsuiteNumber,
    company: OWN_COMPANY,
    made_from: own.madeFrom,
    made_from_id: own.madeFromId,
    sales_order_id: own.salesOrderId,
    customer_netsuite_id: own.customerNetsuiteId,
    fulfil_date: own.fulfilDate,
    location_netsuite_id: own.locationId,
    location_from: own.locationFrom,
    unknowns: own.unknowns,
    made_by: own.madeBy,
    lines: own.lines.map((l) => ({
      line_no: l.lineNo,
      item_netsuite_id: l.itemId,
      item_number: l.itemNumber,
      description: l.description,
      item_type: l.itemType,
      quantity: l.quantity,
      sales_order_line_id: l.salesOrderLineId,
      kit_netsuite_id: l.kitId ?? null,
    })),
  };
}

// ── What FleetSuite knows ──────────────────────────────────────────────────

const numericId = (v: unknown): string | null => (v !== null && v !== undefined && /^\d+$/.test(String(v).trim()) ? String(v).trim() : null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** A quantity to the four places the copy keeps. */
const fourPlaces = (n: number) => Math.round(n * 10_000) / 10_000;

/** The type a copy keeps for an item, from the lists copy's: null when it doesn't have one, undefined when the item doesn't move stock. */
export function keptType(type: string | null | undefined): KeptType | null | undefined {
  if (!type) return null;
  if (STOCK_TYPES.has(type) || type === 'Kit') return type as KeptType;
  return undefined;
}

/** A line of FleetSuite's copy of the sales order: which item it names. */
export interface OrderItem {
  lineId: string | null;
  itemId: string;
}

/**
 * What FleetSuite's copy of the sales order still had to bill, of the items that can move stock, and who it's for;
 * with the item every line of the copy names, billed or not and whatever its type.
 */
export async function readSalesOrderStock(service: SupabaseClient, salesOrderId: string): Promise<{
  customerNetsuiteId: string | null;
  customerName: string | null;
  lines: FulfilledLine[] | null;
  items: OrderItem[];
}> {
  const so = await service
    .from('netsuite_sales_orders')
    .select('id, customer_netsuite_id, customer_name')
    .eq('netsuite_id', salesOrderId)
    .maybeSingle();
  if (so.error) throw new Error(so.error.message);
  const head = so.data as { id: string; customer_netsuite_id: string | null; customer_name: string | null } | null;
  if (!head) return { customerNetsuiteId: null, customerName: null, lines: null, items: [] };

  const res = await service
    .from('netsuite_sales_order_lines')
    .select('line_id, item_netsuite_id, item_number, description, quantity, quantity_billed')
    .eq('so_id', head.id);
  if (res.error) throw new Error(res.error.message);
  const rows = ((res.data ?? []) as Array<{
    line_id: string; item_netsuite_id: string | null; item_number: string | null; description: string | null;
    quantity: number | string; quantity_billed: number | string;
  }>).sort((a, b) => Number(a.line_id) - Number(b.line_id));

  const itemIds = [...new Set(rows.map((r) => numericId(r.item_netsuite_id)).filter((id): id is string => !!id))];
  const listed = itemIds.length
    ? await service.from('gl_netsuite_lists').select('netsuite_id, name, details').eq('kind', 'item').in('netsuite_id', itemIds)
    : { data: [], error: null };
  if (listed.error) throw new Error(listed.error.message);
  const items = new Map(((listed.data ?? []) as Array<{ netsuite_id: string; name: string; details: Record<string, unknown> | null }>)
    .map((r) => [String(r.netsuite_id), { number: r.name, type: (r.details?.item_type as string | undefined) ?? null }]));

  const lines: FulfilledLine[] = [];
  const named: OrderItem[] = [];
  for (const r of rows) {
    const itemId = numericId(r.item_netsuite_id);
    if (!itemId) continue;
    named.push({ lineId: numericId(r.line_id), itemId });
    const item = items.get(itemId);
    // An item the lists copy doesn't have may move stock: kept, and the check says FleetSuite didn't know.
    const itemType = item ? keptType(item.type) : null;
    if (itemType === undefined) continue;
    const open = fourPlaces((num(r.quantity) ?? 0) - (num(r.quantity_billed) ?? 0));
    if (open <= 0) continue;
    lines.push({
      itemId,
      itemNumber: r.item_number || item?.number || null,
      description: r.description,
      itemType,
      quantity: open,
      salesOrderLineId: numericId(r.line_id),
    });
  }
  return { customerNetsuiteId: numericId(head.customer_netsuite_id), customerName: head.customer_name, lines, items: named };
}

/** The order's open stock lines cut down to what shipped, for a fulfillment of part of the order. Pure. */
export function shippedLines(open: FulfilledLine[], shipped: { salesOrderLineId: string; quantity: number }[]): FulfilledLine[] {
  const qty = new Map<string, number>();
  for (const s of shipped) qty.set(s.salesOrderLineId, (qty.get(s.salesOrderLineId) ?? 0) + s.quantity);
  return open
    .filter((l) => l.salesOrderLineId !== null && qty.has(l.salesOrderLineId))
    .map((l) => ({ ...l, quantity: fourPlaces(qty.get(l.salesOrderLineId!)!) }));
}

// ── A kit's parts ──────────────────────────────────────────────────────────

/** A part of a kit, per one kit: kept in stock, or an item the lists copy doesn't have, which may be. */
export interface KitPartLine {
  itemId: string;
  itemNumber: string | null;
  description: string | null;
  /** Null when the lists copy doesn't have the item, which may move stock. */
  itemType: StockType | null;
  /** How many one kit holds. */
  quantity: number;
}

/** An item as the lists copy has it, for taking a kit apart. */
export interface ListedItem {
  number: string;
  type: string | null;
  displayName: string | null;
  /** A kit's parts as the copy keeps them; null when it has none it can read. */
  parts: KitPart[] | null;
}

/** How deep kits inside kits are taken apart; a kit deeper than this leaves the kit it's in whole. */
export const KIT_DEPTH = 5;

/** A kit's parts as the lists copy keeps them (details.parts, src/lib/books/netsuite-lists.ts); null when it has none it can read whole. */
export function kitPartsOf(details: Record<string, unknown> | null | undefined): KitPart[] | null {
  const parts = details?.parts;
  if (!Array.isArray(parts) || !parts.length) return null;
  const out: KitPart[] = [];
  for (const part of parts) {
    const p = (part ?? {}) as Record<string, unknown>;
    const item = numericId(p.item);
    const quantity = num(p.quantity);
    if (!item || quantity === null || !(quantity > 0)) return null;
    out.push({ item, quantity });
  }
  return out;
}

/** Adds a part to the parts so far, an item held twice one part, in the order first held. */
function addPart(parts: Map<string, KitPartLine>, line: KitPartLine) {
  const had = parts.get(line.itemId);
  if (had) had.quantity += line.quantity;
  else parts.set(line.itemId, { ...line });
}

/** A kit's part as the lists copy has the item (`item`: null for one it doesn't have); null for one that doesn't move stock. */
function stockPart(itemId: string, item: ListedItem | null, quantity: number): KitPartLine | null {
  const type = item ? keptType(item.type) : null;
  if (type === undefined) return null;
  return { itemId, itemNumber: item?.number ?? null, description: item?.displayName ?? null, itemType: type as StockType | null, quantity };
}

/**
 * One kit's parts, per one kit, as the lists copy has them (`items`: null for an item it doesn't have, absent for one
 * not read): a kit inside it taken apart into its own parts, a part that doesn't move stock left out, an item held
 * twice one part. Null when the copy doesn't have the parts of the kit or of a kit inside it, or they weren't read.
 * Pure.
 */
export function kitStockParts(kitId: string, items: ReadonlyMap<string, ListedItem | null>, inside: readonly string[] = []): KitPartLine[] | null {
  const kit = items.get(kitId);
  if (!kit || kit.type !== 'Kit' || !kit.parts || inside.includes(kitId) || inside.length >= KIT_DEPTH) return null;
  const out = new Map<string, KitPartLine>();
  for (const part of kit.parts) {
    if (!items.has(part.item)) return null;
    const item = items.get(part.item) ?? null;
    if (item?.type === 'Kit') {
      const inner = kitStockParts(part.item, items, [...inside, kitId]);
      if (!inner) return null;
      for (const p of inner) addPart(out, { ...p, quantity: p.quantity * part.quantity });
      continue;
    }
    const line = stockPart(part.item, item, part.quantity);
    if (line) addPart(out, line);
  }
  return [...out.values()];
}

const detailText = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The items as the lists copy has them, null for one it doesn't have. Throws when the copy can't be read. */
async function readListed(service: SupabaseClient, ids: readonly string[]): Promise<Map<string, ListedItem | null>> {
  const wanted = [...new Set(ids)];
  const out = new Map<string, ListedItem | null>();
  if (!wanted.length) return out;
  const res = await service.from('gl_netsuite_lists').select('netsuite_id, name, details').eq('kind', 'item').in('netsuite_id', wanted);
  if (res.error) throw new Error(res.error.message);
  for (const r of (res.data ?? []) as Array<{ netsuite_id: string; name: string; details: Record<string, unknown> | null }>) {
    out.set(String(r.netsuite_id), {
      number: r.name,
      type: detailText(r.details?.item_type),
      displayName: detailText(r.details?.display_name),
      parts: kitPartsOf(r.details),
    });
  }
  for (const id of wanted) if (!out.has(id)) out.set(id, null);
  return out;
}

/**
 * Each kit's parts, per one kit (kitStockParts), from the lists copy: the kits, then what they hold, a level of kits
 * inside kits at a time. Never throws: when the copy can't be read, each kit is kept whole, and that's logged.
 */
export async function readKitParts(service: SupabaseClient, kitIds: readonly string[]): Promise<Map<string, KitPartLine[] | null>> {
  const items = new Map<string, ListedItem | null>();
  try {
    let wanted = [...new Set(kitIds)];
    for (let level = 0; wanted.length && level <= KIT_DEPTH; level++) {
      for (const [id, item] of await readListed(service, wanted)) items.set(id, item);
      wanted = [...new Set([...items.values()].flatMap((i) => (i?.type === 'Kit' && i.parts ? i.parts.map((p) => p.item) : [])))]
        .filter((id) => !items.has(id));
    }
  } catch (err) {
    console.error(`[books] the parts of ${kitIds.join(', ')} couldn't be read, so the kits are kept whole: ${String((err as any)?.message || err).slice(0, 300)}`);
    return new Map(kitIds.map((id) => [id, null]));
  }
  return new Map(kitIds.map((id) => [id, kitStockParts(id, items)]));
}

// ── The parts NetSuite's sales order lists ─────────────────────────────────

/** A line of NetSuite's sales order, as the read of a kit's parts takes it. */
export interface OrderLine {
  lineId: string;
  itemId: string;
  /** How many the line is for, all of them. */
  quantity: number;
  /** The kit line it's a part of (transactionline.kitmemberof); null for a line of its own. */
  kitLineId: string | null;
}

/** Every item line of a sales order in NetSuite, with the kit line each part of a kit is on. */
export function orderLinesQuery(salesOrderId: string): string {
  if (!/^\d+$/.test(salesOrderId)) throw new Error(`Not a NetSuite sales order id: ${salesOrderId}`);
  return `
      SELECT tl.id AS line_id, tl.item AS item_id, tl.quantity, tl.kitmemberof AS kit_line_id
      FROM transactionline tl
      WHERE tl.transaction = ${salesOrderId}
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        AND tl.item IS NOT NULL
      ORDER BY tl.id
    `;
}

/**
 * NetSuite's rows as order lines, a line with no quantity (a subtotal, say) for none; null when one can't be read
 * whole, so none is trusted. Pure.
 */
export function mapOrderLines(rows: readonly Record<string, unknown>[]): OrderLine[] | null {
  const out: OrderLine[] = [];
  for (const r of rows) {
    const lineId = numericId(r.line_id);
    const itemId = numericId(r.item_id);
    const given = (v: unknown) => v !== null && v !== undefined && v !== '';
    const kitLineId = given(r.kit_line_id) ? numericId(r.kit_line_id) : null;
    const quantity = given(r.quantity) ? num(r.quantity) : 0;
    if (!lineId || !itemId || quantity === null || (given(r.kit_line_id) && !kitLineId)) return null;
    out.push({ lineId, itemId, quantity: Math.abs(quantity), kitLineId });
  }
  return out;
}

/** Reads a sales order's lines from NetSuite (orderLinesQuery); null when they can't be read whole. */
export type ReadOrderLines = (salesOrderId: string) => Promise<OrderLine[] | null>;

/** How long the copy waits for NetSuite's order: the billing screen is waiting, and the invoice comes after. */
export const ORDER_READ_TIMEOUT_MS = 6000;

/** A SuiteQL read of NetSuite's order (nothing is written), given up after ORDER_READ_TIMEOUT_MS. */
export const readOrderLines: ReadOrderLines = async (salesOrderId) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      suiteqlQueryAll(orderLinesQuery(salesOrderId), 1000, { retries: 1 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`NetSuite didn't answer within ${ORDER_READ_TIMEOUT_MS / 1000} seconds`)), ORDER_READ_TIMEOUT_MS);
      }),
    ]);
    return mapOrderLines(rows);
  } finally {
    clearTimeout(timer);
  }
};

/** A kit line of NetSuite's order: its parts per one kit (null when they can't be used whole), and the lines under it. */
export interface OrderKit {
  parts: KitPartLine[] | null;
  lines: string[];
}

/**
 * The parts NetSuite's order lists for each of its kit lines, per one kit, by the kit's line: every line under it, a
 * kit inside it taken apart the same way, a part that doesn't move stock left out, an item held twice one part, each
 * its line's quantity over the kit's (a line's quantity is all of it, so a part inside an inner kit's too). A kit line
 * the order lists no parts for isn't in it; one whose parts can't be used whole has null parts (a kit inside it with
 * none, or deeper than KIT_DEPTH, or the kit's quantity nothing). Null altogether when the lines don't hang together
 * (a part of a line the order doesn't have, or of one the lists copy doesn't call a kit), so none is trusted. `items`
 * is the lists copy's, null for an item it doesn't have. Pure.
 */
export function orderKitParts(order: readonly OrderLine[], items: ReadonlyMap<string, ListedItem | null>): Map<string, OrderKit> | null {
  const byLine = new Map(order.map((l) => [l.lineId, l]));
  const under = new Map<string, OrderLine[]>();
  for (const l of order) {
    if (!l.kitLineId) continue;
    const kit = byLine.get(l.kitLineId);
    if (!kit || kit.lineId === l.lineId || items.get(kit.itemId)?.type !== 'Kit') return null;
    under.set(kit.lineId, [...(under.get(kit.lineId) ?? []), l]);
  }
  const out = new Map<string, OrderKit>();
  for (const [kitLine, first] of under) {
    const kit = byLine.get(kitLine)!;
    const parts = new Map<string, KitPartLine>();
    const lines: string[] = [];
    let whole = kit.quantity > 0;
    let level = first;
    for (let depth = 1; level.length && whole; depth++) {
      const next: OrderLine[] = [];
      for (const l of level) {
        if (l.lineId === kitLine || lines.includes(l.lineId)) { whole = false; break; }
        lines.push(l.lineId);
        const item = items.get(l.itemId) ?? null;
        if (item?.type === 'Kit') {
          const inner = under.get(l.lineId);
          if (!inner || depth >= KIT_DEPTH) { whole = false; break; }
          next.push(...inner);
          continue;
        }
        const part = stockPart(l.itemId, item, l.quantity / kit.quantity);
        if (part) addPart(parts, part);
      }
      level = next;
    }
    out.set(kitLine, { parts: whole ? [...parts.values()] : null, lines });
  }
  return out;
}

/**
 * The lines with each kit taken apart into its parts (`partsOf`, per one kit; null or absent when they aren't known):
 * each part the kit's quantity times what one kit holds, on the kit's sales order line, saying which kit it was taken
 * for. A kit whose parts aren't known stays as it is, for the check to say so. Pure.
 */
export function withKitParts(lines: readonly FulfilledLine[], partsOf: (kit: FulfilledLine) => KitPartLine[] | null | undefined): FulfilledLine[] {
  return lines.flatMap((l) => {
    const kitParts = l.itemType === 'Kit' ? partsOf(l) : null;
    if (!kitParts) return [l];
    return kitParts.map((p) => ({
      itemId: p.itemId,
      itemNumber: p.itemNumber,
      description: p.description,
      itemType: p.itemType,
      quantity: fourPlaces(l.quantity * p.quantity),
      salesOrderLineId: l.salesOrderLineId,
      kitId: l.itemId,
    }));
  });
}

/**
 * The lines with each kit taken apart (withKitParts): into the parts NetSuite's order lists for it, read from NetSuite
 * (orderKitParts), whose own lines on the copy then go; or, for a kit the order lists none for, or when the order can't
 * be read, into its parts as the lists copy has them (readKitParts), unless the order's copy also names one of them on
 * a line of its own, which may be that part as the order lists it. A kit whose parts can't be known stays whole, and
 * so do its lines. Never throws.
 */
export async function takeKitsApart(
  service: SupabaseClient,
  salesOrderId: string,
  lines: readonly FulfilledLine[],
  orderItems: readonly OrderItem[],
  readOrder: ReadOrderLines = readOrderLines,
): Promise<FulfilledLine[]> {
  const kits = lines.filter((l) => l.itemType === 'Kit');
  if (!kits.length) return [...lines];

  let fromOrder: Map<string, OrderKit> | null = null;
  try {
    const order = await readOrder(salesOrderId);
    if (order) {
      const kitItem = new Map(order.map((l) => [l.lineId, l.itemId]));
      const wanted = order.filter((l) => l.kitLineId).flatMap((l) => [l.itemId, kitItem.get(l.kitLineId!) ?? '']).filter(Boolean);
      fromOrder = orderKitParts(order, await readListed(service, wanted));
      if (!fromOrder) console.error(`[books] the kit parts NetSuite's sales order ${salesOrderId} lists don't hang together, so the copy of NetSuite's items is used`);
    }
  } catch (err) {
    console.error(`[books] the kit parts NetSuite's sales order ${salesOrderId} lists couldn't be read: ${String((err as any)?.message || err).slice(0, 300)}`);
  }

  const onOrder = (kit: FulfilledLine) => (kit.salesOrderLineId ? fromOrder?.get(kit.salesOrderLineId) : undefined);
  // The lines of the kits taken apart from the order: their parts, which replace them.
  const replaced = new Set(kits.flatMap((k) => (onOrder(k)?.parts ? onOrder(k)!.lines : [])));
  const byList = [...new Set(kits.filter((k) => !onOrder(k)).map((k) => k.itemId))];
  const listed = byList.length ? await readKitParts(service, byList) : new Map<string, KitPartLine[] | null>();
  const named = new Set(orderItems.filter((i) => !(i.lineId && replaced.has(i.lineId))).map((i) => i.itemId));

  return withKitParts(
    lines.filter((l) => !(l.salesOrderLineId && replaced.has(l.salesOrderLineId))),
    (kit) => {
      const found = onOrder(kit);
      if (found) return found.parts;
      const parts = listed.get(kit.itemId) ?? null;
      return parts && parts.some((p) => named.has(p.itemId)) ? null : parts;
    },
  );
}

// ── Saving ─────────────────────────────────────────────────────────────────

/** What one of the two ways of invoicing a sales order knows once NetSuite has fulfilled it. */
export interface MadeFulfillment {
  netsuiteId: string | null | undefined;
  netsuiteNumber?: string | null;
  madeFrom: FulfilledFrom;
  madeFromId?: string | null;
  madeBy?: string | null;
  salesOrderId: string | null | undefined;
  /** Where FleetSuite's PO location rule books the PO's invoice, for a sales order's installed quantities. */
  locationId?: string | number | null;
  /** What shipped, by sales order line, when FleetSuite shipped part of the order; absent when it shipped every open line. */
  shipped?: { salesOrderLineId: string; quantity: number }[] | null;
}

/**
 * Saves FleetSuite's own copy of a fulfillment it just made. Never throws: the fulfillment exists in NetSuite
 * whatever happens here, so a copy that can't be made is logged and the invoice goes on.
 */
export async function saveOwnFulfillment(
  service: SupabaseClient,
  made: MadeFulfillment,
  at: Date = new Date(),
  readOrder: ReadOrderLines = readOrderLines,
): Promise<SaveResult> {
  const netsuiteId = made.netsuiteId ? String(made.netsuiteId).trim() : '';
  if (!/^\d+$/.test(netsuiteId)) return { saved: false, reason: "NetSuite didn't say which fulfillment it made" };
  const salesOrderId = numericId(made.salesOrderId);
  if (!salesOrderId) return { saved: false, reason: 'No sales order was named' };
  try {
    const so = await readSalesOrderStock(service, salesOrderId);

    let locationId = numericId(made.locationId);
    let locationFrom: LocationFrom | null = locationId ? 'po_rule' : null;
    if (!locationId) {
      const locations = await service.from('gl_netsuite_lists').select('netsuite_id, name').eq('kind', 'location');
      if (locations.error) throw new Error(locations.error.message);
      locationId = ruleLocation(so.customerName, new Map(((locations.data ?? []) as Array<{ netsuite_id: string; name: string }>)
        .map((l) => [String(l.netsuite_id), l.name])));
      locationFrom = locationId ? 'customer_rule' : null;
    }

    const open = made.shipped && so.lines ? shippedLines(so.lines, made.shipped) : so.lines;
    // A kit is taken apart once what shipped of it is known: NetSuite takes a kit's parts from stock, not the kit.
    const lines = open ? await takeKitsApart(service, salesOrderId, open, so.items, readOrder) : open;

    const own = workOutOwnFulfillment({
      netsuiteId,
      netsuiteNumber: made.netsuiteNumber ?? null,
      madeFrom: made.madeFrom,
      madeFromId: made.madeFromId ?? null,
      salesOrderId,
      customerNetsuiteId: so.customerNetsuiteId,
      locationId,
      locationFrom,
      fulfilDate: chicagoDate(at),
      lines,
      madeBy: made.madeBy ?? null,
    });

    const { data, error } = await service.rpc('gl_own_fulfillment_save', { p: fulfillmentPayload(own) });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of NetSuite fulfillment ${netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
