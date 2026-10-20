import type { SupabaseClient } from '@supabase/supabase-js';
import { STOCK_TYPES } from './bill-rule';
import { chicagoDate, OWN_COMPANY, ruleLocation, type MadeFrom, type SaveResult } from './own-invoices';

/**
 * FleetSuite's own copy of each fulfillment it makes (migration 418; owner
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
 *     them). A kit, whose parts FleetSuite doesn't know, and an item the
 *     lists copy doesn't have yet are kept too, so the check can say so;
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
/** NetSuite's types for the items a copy keeps: kept in stock, or a kit of parts FleetSuite doesn't know. */
export type KeptType = 'InvtPart' | 'Assembly' | 'Kit';
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

/** What FleetSuite's copy of the sales order still had to bill, of the items that can move stock, and who it's for. */
export async function readSalesOrderStock(service: SupabaseClient, salesOrderId: string): Promise<{
  customerNetsuiteId: string | null;
  customerName: string | null;
  lines: FulfilledLine[] | null;
}> {
  const so = await service
    .from('netsuite_sales_orders')
    .select('id, customer_netsuite_id, customer_name')
    .eq('netsuite_id', salesOrderId)
    .maybeSingle();
  if (so.error) throw new Error(so.error.message);
  const head = so.data as { id: string; customer_netsuite_id: string | null; customer_name: string | null } | null;
  if (!head) return { customerNetsuiteId: null, customerName: null, lines: null };

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
  for (const r of rows) {
    const itemId = numericId(r.item_netsuite_id);
    if (!itemId) continue;
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
  return { customerNetsuiteId: numericId(head.customer_netsuite_id), customerName: head.customer_name, lines };
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
}

/**
 * Saves FleetSuite's own copy of a fulfillment it just made. Never throws: the fulfillment exists in NetSuite
 * whatever happens here, so a copy that can't be made is logged and the invoice goes on.
 */
export async function saveOwnFulfillment(service: SupabaseClient, made: MadeFulfillment, at: Date = new Date()): Promise<SaveResult> {
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
      lines: so.lines,
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
