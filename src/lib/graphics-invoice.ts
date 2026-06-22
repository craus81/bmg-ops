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

export interface ProposedInvoiceLine {
  partNumber: string;
  itemId: string | null;       // NetSuite internal id (null = not found in NS)
  displayName: string;
  quantity: number;
  rate: number;
  found: boolean;              // matched a NetSuite item
  priced: boolean;            // rate resolved to > 0
  qtySource: 'po' | 'job';    // where the suggested quantity came from
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
      .select('customer')
      .eq('id', job.po_id)
      .maybeSingle();
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

  // Catalog prices by item number.
  const catalogPrice: Record<string, number> = {};
  const { data: catRows } = await supabase
    .from('netsuite_parts')
    .select('item_number, sales_price')
    .in('item_number', partNumbers)
    .eq('is_active', true);
  for (const r of catRows || []) {
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
