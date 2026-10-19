import type { SupabaseClient } from '@supabase/supabase-js';
import { roundCentsHalfEven } from '@/lib/estimate-totals';
import { KNOWN_LOCATION_IDS, pickInvoiceLocation } from '@/lib/invoice-location';
import { isPartTaxable } from '@/lib/line-taxability';
import { getSalesTaxRate } from '@/lib/sales-tax';
import { isLayoutItem } from './invoice-rule';
import type { BooksCompany } from './journal';

/**
 * FleetSuite's own copy of each invoice it makes (migration 407; owner
 * decision 2026-10-19, thread "Replacing NetSuite with FleetSuite", "Own
 * invoices"; docs/books.md "FleetSuite's own invoices").
 *
 * When FleetSuite makes an invoice in NetSuite, one of five ways (a vehicle
 * off its sales order, a sales order's installed quantities, a PO's open
 * quantities, scans, or a graphics job), it keeps its own copy, worked out
 * from what it billed by its own rules rather than read back from NetSuite:
 *
 *   - the lines are the ones FleetSuite sent, or for a sales order billed
 *     whole, what FleetSuite's copy of the sales order still had to bill
 *     (netsuite_sales_order_lines, copied every two hours);
 *   - each line's amount is its quantity times its price, to the cent;
 *   - sales tax is tax@1, FleetSuite's quoting rule: a line is taxed by
 *     src/lib/line-taxability.ts (Service items not, an admin's override
 *     either way, everything else taxed; a discount as the line above it),
 *     at the one rate in Settings -> Sales Tax, worked out line by line and rounded half to even the way
 *     NetSuite does (src/lib/estimate-totals.ts). A FleetSuite customer
 *     marked tax-exempt pays none, and nor does work at Social Circle,
 *     Georgia (owner, 2026-10-09: Masterack's Georgia plant work isn't
 *     taxed);
 *   - the due date is the invoice's date plus the customer's terms, as
 *     NetSuite's customer list has them (src/lib/books/netsuite-lists.ts).
 *     A customer with no terms is due the day it's billed, as in NetSuite.
 *
 * What FleetSuite can't work out is said so on the copy (unknowns) rather
 * than guessed from NetSuite: a sales order not copied yet, a customer the
 * lists copy doesn't have, a line NetSuite priced, which Masterack plant a
 * vehicle's sales order books to. The check
 * (src/lib/books/own-invoice-check.ts) puts each copy next to NetSuite's
 * invoice, and the books post a copy that matches it in place of NetSuite's
 * (src/lib/books/own-invoice-posting.ts). Nothing is written to NetSuite.
 *
 * Saving never stops an invoice: the invoice already exists in NetSuite when
 * the copy is made, so a copy that can't be saved is logged and left.
 */

export const OWN_TAX_RULE = 'tax@1';

/** The company FleetSuite makes its invoices for, so the one its own copies are of. */
export const OWN_COMPANY: BooksCompany = 'BMG';

export type MadeFrom = 'vehicle' | 'sales_order' | 'po' | 'scans' | 'graphics';
export type TaxBasis = 'rate' | 'exempt_customer' | 'georgia';
export type Unknown = 'lines' | 'customer' | 'terms' | 'prices' | 'location';

/** A line FleetSuite billed: as it sent it to NetSuite, or as its copy of the sales order had it still to bill. */
export interface BilledLine {
  /** NetSuite's id for the item. */
  itemId: string | null;
  itemNumber?: string | null;
  description?: string | null;
  quantity: number | null;
  /** The price each; null when FleetSuite set none and NetSuite priced the line. */
  rate: number | null;
  /**
   * What the line charges in cents, when that's known rather than worked out: a sales order line billed whole
   * charges what the order says, and a discount has no price to work it out from.
   */
  cents?: number | null;
  salesOrderLineId?: string | null;
}

/** What FleetSuite knows that its copy is worked out from. */
export interface OwnInvoiceFacts {
  /** NetSuite item id → its NetSuite item type and an admin's tax override (netsuite_parts.taxable_override). */
  items: Map<string, { number: string | null; type: string | null; taxableOverride: boolean | null }>;
  /** The FleetSuite customer: its id, when exactly one has the NetSuite id, and whether it's tax-exempt. */
  customer: { id: string | null; taxExempt: boolean } | null;
  /** Whether NetSuite's customer list (the lists copy) has the customer. */
  customerListed: boolean;
  /** The customer's terms there, null when it has none. */
  terms: { id: string; name: string; days: number | null } | null;
  /** Settings → Sales Tax, a fraction. */
  rate: number;
  /** NetSuite location id → name. */
  locations: Map<string, string>;
}

export interface OwnInvoiceInput {
  netsuiteId: string;
  netsuiteNumber: string | null;
  madeFrom: MadeFrom;
  madeFromId: string | null;
  salesOrderId: string | null;
  customerNetsuiteId: string | null;
  locationId: string | null;
  locationFrom: 'sent' | 'rule' | null;
  poNumber: string | null;
  memo: string | null;
  vin: string | null;
  /** 'YYYY-MM-DD', the day FleetSuite made it in Central time. */
  invoiceDate: string;
  /** Null when FleetSuite couldn't say what it billed. */
  lines: BilledLine[] | null;
  linesFrom: 'sent' | 'sales_order_copy';
  madeBy: string | null;
}

export interface OwnInvoiceLine {
  lineNo: number;
  itemId: string | null;
  itemNumber: string | null;
  description: string | null;
  quantity: number | null;
  rate: number | null;
  /** What the line charges, a discount negative. */
  cents: number;
  priced: boolean;
  taxable: boolean;
  taxCents: number;
  salesOrderLineId: string | null;
}

export interface OwnInvoice extends Omit<OwnInvoiceInput, 'lines'> {
  lines: OwnInvoiceLine[];
  customerId: string | null;
  termsId: string | null;
  termsName: string | null;
  termsDays: number | null;
  dueDate: string | null;
  taxBasis: TaxBasis;
  /** A fraction; 0 when not taxed. */
  taxRate: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  unknowns: Unknown[];
}

const DAY_MS = 86_400_000;
const norm = (s: string | null | undefined) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The America/Chicago calendar date (YYYY-MM-DD) for an instant. */
export function chicagoDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(at);
}

/** 'YYYY-MM-DD' plus whole days. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole cents, rounded half to even, of a dollar amount. */
const halfEvenCents = (dollars: number) => Math.round(roundCentsHalfEven(dollars) * 100);

/** One line's sales tax at a rate (a fraction), in cents, rounded half to even the way NetSuite does. */
export const lineTax = (cents: number, rate: number) => (rate > 0 ? halfEvenCents((cents / 100) * rate) : 0);

/** '-12.50' from -1250. */
export function signedAmount(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Where FleetSuite's invoice location rule (src/lib/invoice-location.ts) books a sales order billed whole, which
 * NetSuite bills from the order's own location: null when the rule can't be sure, a Masterack order with no plant
 * named, or there's no customer to go by.
 */
export function ruleLocation(customerName: string | null, locations: Map<string, string>): string | null {
  if (!customerName?.trim()) return null;
  const pick = pickInvoiceLocation({ customerName });
  if (!pick.confident) return null;
  for (const [id, name] of locations) if (norm(name) === norm(pick.name)) return id;
  return KNOWN_LOCATION_IDS[norm(pick.name)] ?? null;
}

/** Social Circle, Georgia, by its name in NetSuite's lists or its known id. */
export function isGeorgia(locationId: string | null, locations: Map<string, string>): boolean {
  if (!locationId) return false;
  const name = locations.get(locationId);
  return name ? norm(name) === 'socialcircle' : locationId === KNOWN_LOCATION_IDS.socialcircle;
}

/** Discounts take money off; NetSuite's copies of sales order lines keep amounts unsigned. */
export const TAKES_OFF = new Set(['Discount']);

/**
 * FleetSuite's own copy of an invoice it made, from what it billed and what it knows. Pure; amounts are whole cents.
 * A line that never posts (a subtotal or description) is left out, as the invoice rule leaves it out.
 */
export function workOutOwnInvoice(input: OwnInvoiceInput, facts: OwnInvoiceFacts): OwnInvoice {
  const unknowns = new Set<Unknown>();
  if (input.lines === null) unknowns.add('lines');
  if (!input.customerNetsuiteId) unknowns.add('customer');
  if (!input.locationId) unknowns.add('location');

  const taxBasis: TaxBasis = isGeorgia(input.locationId, facts.locations) ? 'georgia'
    : facts.customer?.taxExempt ? 'exempt_customer'
      : 'rate';
  const taxRate = taxBasis === 'rate' ? facts.rate : 0;

  const lines: OwnInvoiceLine[] = [];
  for (const billed of input.lines ?? []) {
    const item = billed.itemId ? facts.items.get(billed.itemId) : undefined;
    if (billed.itemId && isLayoutItem(billed.itemId, item?.type)) continue;

    let cents: number | null = null;
    if (billed.cents !== undefined && billed.cents !== null) cents = billed.cents;
    else if (billed.rate !== null && billed.quantity !== null) cents = halfEvenCents(billed.quantity * billed.rate);
    const priced = cents !== null;
    if (!priced) unknowns.add('prices');
    const amount = cents ?? 0;
    if (priced && amount === 0) continue;

    // FleetSuite's own rule, not NetSuite's Taxable box; an item FleetSuite doesn't know is taxed. A discount's tax
    // follows the line it takes money off, the one above it, as on an estimate (src/lib/estimate-totals.ts).
    const above = lines[lines.length - 1];
    const taxable = priced && (item?.type && TAKES_OFF.has(item.type) && above
      ? above.taxable
      : isPartTaxable({ item_type: item?.type ?? null, taxable_override: item?.taxableOverride ?? null }));
    lines.push({
      lineNo: lines.length + 1,
      itemId: billed.itemId,
      itemNumber: billed.itemNumber ?? item?.number ?? null,
      description: billed.description ?? null,
      quantity: billed.quantity,
      rate: billed.rate,
      cents: amount,
      priced,
      taxable,
      taxCents: taxable ? lineTax(amount, taxRate) : 0,
      salesOrderLineId: billed.salesOrderLineId ?? null,
    });
  }

  let termsId: string | null = null;
  let termsName: string | null = null;
  let termsDays: number | null = null;
  let dueDate: string | null = null;
  if (!facts.customerListed) {
    unknowns.add('terms');
  } else if (!facts.terms) {
    termsDays = 0;
    dueDate = input.invoiceDate;
  } else {
    termsId = facts.terms.id;
    termsName = facts.terms.name;
    // Terms due on a day of the month, not after a number of days, aren't worked out.
    if (facts.terms.days !== null && Number.isInteger(facts.terms.days) && facts.terms.days >= 0) {
      termsDays = facts.terms.days;
      dueDate = addDays(input.invoiceDate, facts.terms.days);
    } else {
      unknowns.add('terms');
    }
  }

  const subtotalCents = lines.reduce((sum, l) => sum + l.cents, 0);
  const taxCents = lines.reduce((sum, l) => sum + l.taxCents, 0);
  const { lines: _billed, ...header } = input;
  return {
    ...header,
    lines,
    customerId: facts.customer?.id ?? null,
    termsId,
    termsName,
    termsDays,
    dueDate,
    taxBasis,
    taxRate,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    unknowns: [...unknowns],
  };
}

/** The copy as gl_own_invoice_save takes it. */
export function savePayload(own: OwnInvoice): Record<string, unknown> {
  return {
    netsuite_id: own.netsuiteId,
    netsuite_number: own.netsuiteNumber,
    company: OWN_COMPANY,
    made_from: own.madeFrom,
    made_from_id: own.madeFromId,
    sales_order_id: own.salesOrderId,
    customer_netsuite_id: own.customerNetsuiteId,
    customer_id: own.customerId,
    invoice_date: own.invoiceDate,
    location_netsuite_id: own.locationId,
    location_from: own.locationFrom,
    po_number: own.poNumber,
    memo: own.memo,
    vin: own.vin,
    terms_netsuite_id: own.termsId,
    terms_name: own.termsName,
    terms_days: own.termsDays,
    due_date: own.dueDate,
    tax_rule: OWN_TAX_RULE,
    tax_basis: own.taxBasis,
    tax_rate: own.taxRate.toFixed(6),
    subtotal: signedAmount(own.subtotalCents),
    tax: signedAmount(own.taxCents),
    total: signedAmount(own.totalCents),
    lines_from: own.linesFrom,
    unknowns: own.unknowns,
    made_by: own.madeBy,
    lines: own.lines.map((l) => ({
      line_no: l.lineNo,
      item_netsuite_id: l.itemId,
      item_number: l.itemNumber,
      description: l.description,
      quantity: l.quantity,
      rate: l.rate,
      amount: signedAmount(l.cents),
      priced: l.priced,
      taxable: l.taxable,
      tax: signedAmount(l.taxCents),
      sales_order_line_id: l.salesOrderLineId,
    })),
  };
}

// ── What FleetSuite knows ──────────────────────────────────────────────────

const numericId = (v: unknown): string | null => (v !== null && v !== undefined && /^-?\d+$/.test(String(v).trim()) ? String(v).trim() : null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Reads what workOutOwnInvoice needs. A read that fails throws: the copy isn't saved half worked out. */
export async function readOwnInvoiceFacts(
  service: SupabaseClient,
  customerNetsuiteId: string | null,
  itemIds: string[],
): Promise<OwnInvoiceFacts> {
  const ids = [...new Set(itemIds.filter((id) => /^\d+$/.test(id)))];
  const [parts, listed, customers, listedCustomer, locations, rate] = await Promise.all([
    ids.length
      ? service.from('netsuite_parts').select('netsuite_id, item_number, item_type, taxable_override').in('netsuite_id', ids)
      : Promise.resolve({ data: [], error: null }),
    ids.length
      ? service.from('gl_netsuite_lists').select('netsuite_id, name, details').eq('kind', 'item').in('netsuite_id', ids)
      : Promise.resolve({ data: [], error: null }),
    customerNetsuiteId
      ? service.from('customers').select('id, tax_exempt').eq('netsuite_id', customerNetsuiteId)
      : Promise.resolve({ data: [], error: null }),
    customerNetsuiteId
      ? service.from('gl_netsuite_lists').select('details').eq('kind', 'customer').eq('netsuite_id', customerNetsuiteId).is('gone_at', null).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    service.from('gl_netsuite_lists').select('netsuite_id, name').eq('kind', 'location'),
    getSalesTaxRate(service),
  ]);
  for (const res of [parts, listed, customers, listedCustomer, locations]) {
    if (res.error) throw new Error(res.error.message);
  }

  const items: OwnInvoiceFacts['items'] = new Map();
  for (const row of (listed.data ?? []) as Array<{ netsuite_id: string; name: string; details: Record<string, unknown> | null }>) {
    items.set(String(row.netsuite_id), { number: row.name, type: (row.details?.item_type as string | undefined) ?? null, taxableOverride: null });
  }
  // FleetSuite's catalog has the admin's override, and the type where the lists copy lacks one.
  for (const row of (parts.data ?? []) as Array<{ netsuite_id: string; item_number: string | null; item_type: string | null; taxable_override: boolean | null }>) {
    const known = items.get(String(row.netsuite_id));
    items.set(String(row.netsuite_id), {
      number: known?.number ?? row.item_number,
      type: known?.type ?? (row.item_type || null),
      taxableOverride: row.taxable_override ?? null,
    });
  }

  const matched = (customers.data ?? []) as Array<{ id: string; tax_exempt: boolean | null }>;
  const customer = matched.length
    ? { id: matched.length === 1 ? matched[0].id : null, taxExempt: matched.every((c) => c.tax_exempt === true) }
    : null;

  const details = (listedCustomer.data as { details?: Record<string, unknown> } | null)?.details ?? null;
  let terms: OwnInvoiceFacts['terms'] = null;
  const termsId = numericId(details?.terms_id);
  if (termsId) {
    const term = await service.from('gl_netsuite_lists').select('name, details').eq('kind', 'term').eq('netsuite_id', termsId).maybeSingle();
    if (term.error) throw new Error(term.error.message);
    const row = term.data as { name: string; details: Record<string, unknown> | null } | null;
    terms = { id: termsId, name: row?.name ?? `Terms ${termsId}`, days: row ? num(row.details?.days_until_net_due) : null };
  }

  return {
    items,
    customer,
    customerListed: details !== null,
    terms,
    rate,
    locations: new Map(((locations.data ?? []) as Array<{ netsuite_id: string; name: string }>).map((l) => [String(l.netsuite_id), l.name])),
  };
}

/** What the sales order still had to bill, from FleetSuite's copy of it, and who it's for. */
export async function readSalesOrderCopy(service: SupabaseClient, salesOrderId: string): Promise<{
  customerNetsuiteId: string | null;
  customerName: string | null;
  poNumber: string | null;
  memo: string | null;
  vin: string | null;
  lines: BilledLine[] | null;
}> {
  const so = await service
    .from('netsuite_sales_orders')
    .select('id, customer_netsuite_id, customer_name, otherrefnum, memo, vin')
    .eq('netsuite_id', salesOrderId)
    .maybeSingle();
  if (so.error) throw new Error(so.error.message);
  const head = so.data as { id: string; customer_netsuite_id: string | null; customer_name: string | null; otherrefnum: string | null; memo: string | null; vin: string | null } | null;
  if (!head) return { customerNetsuiteId: null, customerName: null, poNumber: null, memo: null, vin: null, lines: null };

  const res = await service
    .from('netsuite_sales_order_lines')
    .select('line_id, item_netsuite_id, item_number, description, quantity, quantity_billed, rate, amount')
    .eq('so_id', head.id);
  if (res.error) throw new Error(res.error.message);
  const rows = ((res.data ?? []) as Array<{
    line_id: string; item_netsuite_id: string | null; item_number: string | null; description: string | null;
    quantity: number | string; quantity_billed: number | string; rate: number | string | null; amount: number | string | null;
  }>).sort((a, b) => Number(a.line_id) - Number(b.line_id));

  const itemIds = [...new Set(rows.map((r) => r.item_netsuite_id).filter((id): id is string => !!id && /^\d+$/.test(id)))];
  const itemTypes = itemIds.length
    ? await service.from('gl_netsuite_lists').select('netsuite_id, details').eq('kind', 'item').in('netsuite_id', itemIds)
    : { data: [], error: null };
  if (itemTypes.error) throw new Error(itemTypes.error.message);
  const typeOf = new Map(((itemTypes.data ?? []) as Array<{ netsuite_id: string; details: Record<string, unknown> | null }>)
    .map((r) => [String(r.netsuite_id), (r.details?.item_type as string | undefined) ?? null]));

  // A discount or markup line has no quantity: NetSuite bills it with the order's first invoice.
  const billedBefore = rows.some((r) => (num(r.quantity_billed) ?? 0) > 0);
  const lines: BilledLine[] = [];
  for (const r of rows) {
    const type = r.item_netsuite_id ? typeOf.get(r.item_netsuite_id) ?? null : null;
    const sign = type && TAKES_OFF.has(type) ? -1 : 1;
    const quantity = num(r.quantity) ?? 0;
    const open = quantity - (num(r.quantity_billed) ?? 0);
    // The copy keeps a price or amount of nothing as null (src/lib/sales-order-sync.ts): with neither, the line is free.
    const free = r.rate === null && r.amount === null;
    const rate = free ? 0 : num(r.rate);
    const amount = free ? 0 : num(r.amount);
    if (quantity > 0 && type !== 'Discount' && type !== 'Markup') {
      if (open <= 0) continue;
      lines.push({
        itemId: numericId(r.item_netsuite_id), itemNumber: r.item_number, description: r.description,
        quantity: open, rate: rate === null ? null : sign * rate,
        // Billed whole, a line charges what the order says, which a price kept to four places can miss by a cent.
        cents: amount !== null && open === quantity ? sign * Math.round(amount * 100) : null,
        salesOrderLineId: numericId(r.line_id),
      });
    } else if (!billedBefore && amount !== null && amount !== 0) {
      lines.push({
        itemId: numericId(r.item_netsuite_id), itemNumber: r.item_number, description: r.description,
        quantity: null, rate: null, cents: sign * Math.round(amount * 100), salesOrderLineId: numericId(r.line_id),
      });
    }
  }
  return {
    customerNetsuiteId: numericId(head.customer_netsuite_id),
    customerName: head.customer_name,
    poNumber: head.otherrefnum,
    memo: head.memo,
    vin: head.vin,
    lines,
  };
}

// ── Saving ─────────────────────────────────────────────────────────────────

/** What one of the five ways of invoicing knows once NetSuite has made the invoice. */
export interface MadeInvoice {
  netsuiteId: string | null | undefined;
  netsuiteNumber?: string | null;
  madeFrom: MadeFrom;
  madeFromId?: string | null;
  madeBy?: string | null;
  /** For an invoice off a sales order. */
  salesOrderId?: string | null;
  /** The customer FleetSuite billed; off a sales order, FleetSuite's copy of the order says, when it has it. */
  customerNetsuiteId?: string | null;
  /** The location FleetSuite gave NetSuite, if it gave one. */
  locationId?: string | number | null;
  poNumber?: string | null;
  memo?: string | null;
  vin?: string | null;
  /**
   * The lines FleetSuite sent. Null or absent for a sales order billed whole, whose lines are what FleetSuite's copy
   * of it still had to bill.
   */
  billed?: BilledLine[] | null;
}

export interface SaveResult {
  saved: boolean;
  /** Why not, in a few words. */
  reason?: string;
}

/**
 * Saves FleetSuite's own copy of an invoice it just made. Never throws: the invoice exists in NetSuite whatever
 * happens here, so a copy that can't be made is logged and the invoice goes on.
 */
export async function saveOwnInvoice(service: SupabaseClient, made: MadeInvoice, at: Date = new Date()): Promise<SaveResult> {
  const netsuiteId = made.netsuiteId ? String(made.netsuiteId).trim() : '';
  if (!/^\d+$/.test(netsuiteId)) return { saved: false, reason: "NetSuite didn't say which invoice it made" };
  try {
    const fromSalesOrder = !!made.salesOrderId && /^\d+$/.test(String(made.salesOrderId));
    const sentLines = made.billed ?? null;
    // An invoice off a sales order is for the order's customer, whatever FleetSuite's record of the job says.
    const so = fromSalesOrder ? await readSalesOrderCopy(service, String(made.salesOrderId)) : null;

    const customerNetsuiteId = so?.customerNetsuiteId ?? numericId(made.customerNetsuiteId) ?? null;
    const lines = sentLines ?? so?.lines ?? null;
    const facts = await readOwnInvoiceFacts(service, customerNetsuiteId, (lines ?? []).map((l) => l.itemId ?? '').filter(Boolean));

    let locationId = numericId(made.locationId);
    let locationFrom: OwnInvoiceInput['locationFrom'] = locationId ? 'sent' : null;
    if (!locationId) {
      locationId = ruleLocation(so?.customerName ?? null, facts.locations);
      locationFrom = locationId ? 'rule' : null;
    }

    const own = workOutOwnInvoice({
      netsuiteId,
      netsuiteNumber: made.netsuiteNumber ?? null,
      madeFrom: made.madeFrom,
      madeFromId: made.madeFromId ?? null,
      salesOrderId: fromSalesOrder ? String(made.salesOrderId) : null,
      customerNetsuiteId,
      locationId,
      locationFrom,
      poNumber: made.poNumber ?? so?.poNumber ?? null,
      memo: made.memo ?? so?.memo ?? null,
      vin: made.vin ?? so?.vin ?? null,
      invoiceDate: chicagoDate(at),
      lines,
      linesFrom: sentLines || !fromSalesOrder ? 'sent' : 'sales_order_copy',
      madeBy: made.madeBy ?? null,
    }, facts);

    const { data, error } = await service.rpc('gl_own_invoice_save', { p: savePayload(own) });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of NetSuite invoice ${netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
