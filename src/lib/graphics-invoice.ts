/**
 * Shared resolution logic for invoicing a graphics job.
 *
 * A graphics job stores its parts as a comma-separated `part_number` string
 * and a single job-level `quantity`. Historically every consumer (auto
 * invoice, estimate, packing list) applied that one quantity to every part,
 * so multi-part jobs got the wrong per-line quantities. These helpers build a
 * *proposed* set of invoice lines — one per part, each with its NetSuite item,
 * a resolved price, and a quantity pulled from the linked PO when available —
 * for a human to verify before anything is created.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { findItems, getItemBasePrices } from '@/lib/netsuite';
import { fetchPartRowsCI } from '@/lib/part-number';

// The two NetSuite items a wrap quote maps onto — kept identical to the
// estimate push (/api/wrap-quote/netsuite): all material pricing collapses
// onto the first line, all labor onto the second, so the estimate and the
// eventual invoice carry the same two totals.
export const WRAP_VINYL_ITEM = '3M Vinyl';
export const WRAP_LABOR_ITEM = 'Graphics Install Labor';

/**
 * Split a whole-job total into kit-quantity × per-kit rate for NetSuite
 * lines — but only when the cents divide exactly, so quantity × rate always
 * reconstructs the total to the penny. Otherwise one qty-1 line at the full
 * amount (a rounded synthetic per-kit rate would desync the estimate or
 * invoice from the quote the customer approved).
 */
export function kitLineSplit(total: number, kitQty: number): { quantity: number; rate: number } {
  const cents = Math.round(total * 100);
  const qty = Math.max(1, Math.floor(Number(kitQty) || 1));
  if (qty > 1 && cents % qty === 0) return { quantity: qty, rate: cents / qty / 100 };
  return { quantity: 1, rate: cents / 100 };
}

export interface ProposedInvoiceLine {
  partNumber: string;
  itemId: string | null;          // NetSuite internal id (null = not found in NS)
  displayName: string;
  quantity: number;
  rate: number;
  found: boolean;                 // matched a NetSuite item
  priced: boolean;                // rate resolved to > 0
  qtySource: 'po' | 'job' | 'quote'; // where the suggested quantity came from
}

/** Prefill for the "add NetSuite customer" form, taken from the wrap quote's
 *  customer snapshot when the job has no NetSuite customer yet. */
export interface WrapQuoteCustomerPrefill {
  companyName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}

export interface WrapQuoteInvoiceInfo {
  quoteId: string;
  quoteNumber: string | null;
  materialsTotal: number;
  laborTotal: number;
  total: number;
  vehicleDescription: string | null;
  lines: ProposedInvoiceLine[];
  customerPrefill: WrapQuoteCustomerPrefill | null;
}

/** Split a job's comma-separated part_number into clean part numbers. */
export function jobPartNumbers(partNumber: string | null | undefined): string[] {
  return (partNumber || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Resolve the NetSuite customer id for a job: prefer the id stored on the job,
 * then a name match against `customers`, then the customer on the linked PO.
 */
export async function resolveCustomerNsId(
  supabase: SupabaseClient,
  job: any,
): Promise<string | null> {
  if (job.customer_netsuite_id) return job.customer_netsuite_id;

  if (job.customer) {
    const { data: customer } = await supabase
      .from('customers')
      .select('netsuite_id')
      .ilike('company_name', job.customer)
      .eq('active', true)
      .limit(1)
      .maybeSingle();
    if (customer?.netsuite_id) return customer.netsuite_id;
  }

  if (job.po_id) {
    const { data: po } = await supabase
      .from('purchase_orders')
      .select('customer, customer_netsuite_id')
      .eq('id', job.po_id)
      .maybeSingle();
    // Prefer the NetSuite id resolved at PO import time.
    if (po?.customer_netsuite_id) return po.customer_netsuite_id;
    if (po?.customer) {
      const { data: customer } = await supabase
        .from('customers')
        .select('netsuite_id')
        .ilike('company_name', po.customer)
        .eq('active', true)
        .limit(1)
        .maybeSingle();
      if (customer?.netsuite_id) return customer.netsuite_id;
    }
  }

  return null;
}

/**
 * Build one proposed invoice line per part on the job. Quantities come from
 * the linked PO's line items (matched by part number, summed if a part repeats)
 * and fall back to the job quantity. Rates come from the parts catalog, then
 * the item's NetSuite base price.
 */
export async function deriveProposedLines(
  supabase: SupabaseClient,
  job: any,
): Promise<{ lines: ProposedInvoiceLine[]; skippedParts: string[] }> {
  const partNumbers = jobPartNumbers(job.part_number);
  if (partNumbers.length === 0) return { lines: [], skippedParts: [] };

  // Ordered quantities from the linked PO, keyed by upper-cased part number.
  const poQty: Record<string, number> = {};
  if (job.po_id) {
    const { data: poLines } = await supabase
      .from('po_line_items')
      .select('part_number, quantity')
      .eq('po_id', job.po_id);
    for (const l of poLines || []) {
      const key = (l.part_number || '').trim().toUpperCase();
      if (!key) continue;
      poQty[key] = (poQty[key] || 0) + (Number(l.quantity) || 0);
    }
  }

  // Catalog prices by item number. Case-insensitive fetch — job parts are
  // hand-typed, so an exact .in() never returned the catalog row for a
  // casing variant and the line silently priced at 0.
  const catalogPrice: Record<string, number> = {};
  for (const r of await fetchPartRowsCI(supabase, partNumbers, 'item_number, sales_price, is_active')) {
    if (r.is_active !== true) continue;
    if (r.item_number) catalogPrice[r.item_number.trim().toUpperCase()] = Number(r.sales_price) || 0;
  }

  // NetSuite items for these part numbers.
  const nsItems = await findItems(partNumbers);

  const lines: ProposedInvoiceLine[] = [];
  const skippedParts: string[] = [];
  for (const pn of partNumbers) {
    const up = pn.toUpperCase();
    const nsItem = nsItems[up];
    const found = !!nsItem;
    if (!found) skippedParts.push(pn);

    const hasPo = (poQty[up] || 0) > 0;
    const quantity = hasPo ? poQty[up] : (Number(job.quantity) || 1);
    const rate = catalogPrice[up] || 0;

    lines.push({
      partNumber: pn,
      itemId: nsItem?.id || null,
      displayName: nsItem?.displayName || pn,
      quantity,
      rate,
      found,
      priced: rate > 0,
      qtySource: hasPo ? 'po' : 'job',
    });
  }

  // Fall back to the NetSuite base price for found-but-unpriced lines.
  const needBase = lines.filter((l) => l.found && l.itemId && !(l.rate > 0));
  if (needBase.length > 0) {
    const basePrices = await getItemBasePrices(needBase.map((l) => l.itemId!));
    for (const l of needBase) {
      const bp = basePrices[l.itemId!];
      if (bp > 0) { l.rate = bp; l.priced = true; }
    }
  }

  return { lines, skippedParts };
}

/**
 * Build the proposed invoice lines from the wrap quote a job was spawned
 * from — the missing link that lets a wrap quote's totals carry all the way
 * to the invoice. Mirrors the estimate push: materials_total → "3M Vinyl"
 * (described with the vehicle) and labor_total → "Graphics Install Labor",
 * each qty 1. Returns null when the job isn't linked to a wrap quote so
 * callers can fall back to the part-derived lines.
 */
export async function deriveWrapQuoteLines(
  supabase: SupabaseClient,
  job: any,
): Promise<WrapQuoteInvoiceInfo | null> {
  if (!job.wrap_quote_id) return null;

  const { data: quote } = await supabase
    .from('wrap_quotes')
    .select('id, quote_number, vehicle_description, materials_total, labor_total, total, customer, package_qty')
    .eq('id', job.wrap_quote_id)
    .maybeSingle();
  if (!quote) return null;

  const materials = Math.round((Number(quote.materials_total) || 0) * 100) / 100;
  const labor = Math.round((Number(quote.labor_total) || 0) * 100) / 100;
  const kitQty = Math.max(1, Number(quote.package_qty) || 1);

  // Resolve the two NetSuite items once; a missing item leaves itemId null so
  // the reviewer is prompted to pick one (the totals still show).
  const items = await findItems([WRAP_VINYL_ITEM, WRAP_LABOR_ITEM]);
  const vinyl = items[WRAP_VINYL_ITEM.toUpperCase()];
  const laborItem = items[WRAP_LABOR_ITEM.toUpperCase()];

  const lines: ProposedInvoiceLine[] = [];
  if (materials > 0) {
    // Kit-quantity quotes bill as qty × per-kit rate when it divides to the
    // cent (12 × $980 reads better than 1 × $11,760 and matches the quote).
    const split = kitLineSplit(materials, kitQty);
    lines.push({
      partNumber: WRAP_VINYL_ITEM,
      itemId: vinyl?.id || null,
      displayName: `${quote.vehicle_description || vinyl?.displayName || WRAP_VINYL_ITEM}${kitQty > 1 ? ` — ${kitQty} kits` : ''}`,
      quantity: split.quantity,
      rate: split.rate,
      found: !!vinyl,
      priced: true,
      qtySource: 'quote',
    });
  }
  if (labor > 0) {
    lines.push({
      partNumber: WRAP_LABOR_ITEM,
      itemId: laborItem?.id || null,
      displayName: laborItem?.displayName || WRAP_LABOR_ITEM,
      quantity: 1,
      rate: labor,
      found: !!laborItem,
      priced: true,
      qtySource: 'quote',
    });
  }

  const c = (quote.customer && typeof quote.customer === 'object') ? quote.customer : {};
  const customerPrefill: WrapQuoteCustomerPrefill | null = c.name
    ? {
        companyName: c.name || '',
        email: c.email || '',
        phone: c.phone || '',
        address: c.address || '',
        city: c.city || '',
        state: c.state || '',
        zip: c.zip || '',
      }
    : null;

  return {
    quoteId: quote.id,
    quoteNumber: quote.quote_number || null,
    materialsTotal: materials,
    laborTotal: labor,
    total: Math.round((Number(quote.total) || materials + labor) * 100) / 100,
    vehicleDescription: quote.vehicle_description || null,
    lines,
    customerPrefill,
  };
}
