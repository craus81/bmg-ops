/**
 * Estimate ↔ NetSuite sales order: what the SO carries, and whether it
 * still matches the estimate (migration 259).
 *
 * ONE line builder for creating the SO (convert-to-so) and updating it
 * (push-so), so the two can never disagree about how estimate lines,
 * custom lines and labor reach NetSuite — the labor-item history in
 * src/lib/labor-item.ts is the cautionary tale for two copies of this
 * logic. ONE hash of the pushed contract, stamped on every successful
 * push and compared on every save, so "the sales order is out of date"
 * is a fact the estimate row carries rather than a guess.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQuery } from './netsuite';
import { resolveLaborItem } from './labor-item';
import { normalizeDiscount, normalizeVehicleCount } from './estimate-totals';
import { kitTaggedDescription } from './estimate-kits';
import { buildDiscountLines, buildLineDiscountLine, estimateNeedsDiscountItem, resolveDiscountItem, type DiscountItem } from './discount-item';

export interface SoLineItem {
  itemId: string;
  /** Omitted only on a Discount-type item's line (see src/lib/discount-item). */
  quantity?: number;
  rate: number; description?: string;
  /** false = NetSuite must not tax this line (migration 336); true only on
   *  a discount's taxed share (migration 342). Omitted otherwise. */
  taxable?: boolean;
  /** An estimate discount line (migration 342). */
  discount?: true;
  discountItem?: true;
}

/** The line's tax flag as SO/estimate payloads carry it: only an explicit false. */
export const untaxedFlag = (li: { taxable?: unknown }): { taxable?: false } =>
  (li.taxable === false ? { taxable: false } : {});

export interface SoLineBuild {
  soLineItems: SoLineItem[];
  customLineDescriptions: string[];
  unmappedLineDescriptions: string[];
  laborSkipped: boolean;
  laborItemNumber: string | null;
  laborHours: number;
  laborRate: number;
  /** The estimate has a discount but NetSuite has no discount item to carry it. */
  discountSkipped: boolean;
  discountAmount: number;
}

/**
 * The FS-CUSTOM placeholder item: custom estimate lines (no NetSuite item)
 * land on the SO as this item with the line's own description carrying
 * the detail. Admins create it once in NetSuite (Item Number = FS-CUSTOM).
 */
export async function findCustomItemId(): Promise<string | null> {
  try {
    const res = await suiteqlQuery(
      "SELECT i.id FROM item i WHERE UPPER(i.itemid) = 'FS-CUSTOM' FETCH FIRST 1 ROWS ONLY"
    );
    const id = res?.items?.[0]?.id;
    return id ? id.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Map an estimate's lines (+ labor) to NetSuite SO lines. qty-0 "included"
 * lines are skipped (they total $0 on the signed document). A missing
 * labor item is REPORTED (laborSkipped), never a silent no-op: NetSuite
 * has no free-text line, so the labor money would simply vanish.
 *
 * A fleet estimate (vehicle_count > 1, migration 304) pushes qty × count on
 * every line — the same multiplication computeTotals used for the figure the
 * customer signed, so the sales order bills exactly what was quoted. Labor
 * needs no multiplication: labor_hours is already the job total.
 */
export async function buildSoLineItems(
  supabase: SupabaseClient,
  estimate: {
    labor_hours?: unknown; labor_hours_override?: unknown; labor_rate?: unknown; vehicle_count?: unknown;
    labor_total?: unknown; discount_type?: unknown; discount_value?: unknown; tax_exempt?: unknown;
  },
  lines: any[],
): Promise<SoLineBuild> {
  const units = normalizeVehicleCount(estimate.vehicle_count);
  const sorted = [...(lines || [])].sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0));
  const soLineItems: SoLineItem[] = [];
  const customLineDescriptions: string[] = [];
  const unmappedLineDescriptions: string[] = [];
  let customItemId: string | null | undefined;

  // Discounts (migration 342 whole-job, 350 per line) need the NetSuite
  // discount item. A missing one is reported (discountSkipped) like labor,
  // and callers BLOCK on it: the sales order would bill the full price the
  // customer was not quoted.
  const discountAmount = estimateNeedsDiscountItem(estimate, sorted);
  let discountItem: DiscountItem | null = null;
  let discountSkipped = false;
  if (discountAmount > 0) {
    try {
      discountItem = (await resolveDiscountItem(supabase)).item;
    } catch { discountItem = null; }
    discountSkipped = !discountItem;
  }
  // A line's own discount goes right under it: NetSuite applies a discount
  // line to the line above.
  const pushLineDiscount = (li: any) => {
    const d = discountItem ? buildLineDiscountLine(li, estimate, discountItem) : null;
    if (d) soLineItems.push(d);
  };

  for (const li of sorted) {
    if ((parseFloat(li.quantity) || 0) <= 0) continue;
    if (li.netsuite_item_id) {
      // Rack kit components say which rack they belong to (estimate-kits).
      const lineDesc = kitTaggedDescription([li.description, li.notes].filter(Boolean).join(' — ')
        || li.item_number
        || undefined, li);
      soLineItems.push({
        itemId: String(li.netsuite_item_id),
        quantity: parseFloat(li.quantity) * units,
        rate: parseFloat(li.unit_price) || 0,
        description: lineDesc,
        ...untaxedFlag(li),
      });
      pushLineDiscount(li);
      continue;
    }
    if (customItemId === undefined) customItemId = await findCustomItemId();
    if (!customItemId) {
      unmappedLineDescriptions.push(li.item_number || li.description || 'Custom item');
      continue;
    }
    const label = li.item_number
      ? `${li.item_number}${li.description ? ' — ' + li.description : ''}`
      : (li.description || 'Custom item');
    const fullDesc = kitTaggedDescription(li.notes ? `${label} (${li.notes})` : label, li);
    soLineItems.push({
      itemId: customItemId,
      quantity: parseFloat(li.quantity) * units,
      rate: parseFloat(li.unit_price) || 0,
      description: fullDesc,
      ...untaxedFlag(li),
    });
    pushLineDiscount(li);
    customLineDescriptions.push(label);
  }

  const laborHours = parseFloat(String(estimate.labor_hours_override ?? estimate.labor_hours)) || 0;
  const laborRate = parseFloat(String(estimate.labor_rate)) || 85;
  let laborSkipped = false;
  let laborItemNumber: string | null = null;
  if (laborHours > 0) {
    try {
      const { item: laborItem } = await resolveLaborItem(supabase);
      if (laborItem) {
        laborItemNumber = laborItem.itemNumber;
        soLineItems.push({
          itemId: laborItem.id,
          quantity: laborHours,
          rate: laborRate,
          description: `Labor - ${laborHours} hrs @ $${laborRate}/hr`,
        });
      } else {
        laborSkipped = true;
      }
    } catch { laborSkipped = true; }
  }

  // The whole-job discount (migration 342) goes last.
  if (discountItem) soLineItems.push(...buildDiscountLines(estimate, sorted, discountItem));

  return {
    soLineItems, customLineDescriptions, unmappedLineDescriptions, laborSkipped, laborItemNumber, laborHours, laborRate,
    discountSkipped, discountAmount,
  };
}

/**
 * The SO contract: lines with quantity > 0 (item number, qty, price) in
 * sort order, effective labor hours + rate, the reference number the SO
 * carries (customer PO, else the estimate number) and the VIN. Descriptions
 * and totals are excluded — a description touch or a tax-rate change on
 * our side doesn't alter what NetSuite has to bill lines for.
 *
 * The vehicle count joins the contract ONLY when it is above 1. It changes
 * what NetSuite must bill, so raising it has to mark the SO out of date —
 * but folding a `1` into the body would change the hash of every estimate
 * ever pushed and light up "out of date" across the whole book on deploy.
 * A line's tax flag joins the same way, only when it is an untaxed line
 * (migration 336), since NetSuite has to stop taxing it. So does a discount
 * (migration 342), only when there is one.
 */
export function soContentHash(
  estimate: {
    labor_hours?: unknown; labor_hours_override?: unknown; labor_rate?: unknown; po_number?: unknown; estimate_number?: unknown; vin?: unknown; vehicle_count?: unknown;
    discount_type?: unknown; discount_value?: unknown;
  },
  lines: Array<{ item_number?: unknown; quantity?: unknown; unit_price?: unknown; sort_order?: unknown; taxable?: unknown; discount_type?: unknown; discount_value?: unknown }>,
): string {
  const money = (v: unknown) => +(parseFloat(String(v ?? 0)) || 0).toFixed(2);
  const units = normalizeVehicleCount(estimate.vehicle_count);
  const discount = normalizeDiscount(estimate.discount_type, estimate.discount_value);
  const body = {
    lines: [...lines]
      .filter(l => (parseFloat(String(l.quantity ?? 0)) || 0) > 0)
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
      .map(l => {
        // A line's own discount (migration 350) joins only when it has one,
        // so existing hashes are unchanged.
        const ld = normalizeDiscount(l.discount_type, l.discount_value);
        return [
          String(l.item_number ?? ''), money(l.quantity), money(l.unit_price),
          ...(l.taxable === false ? ['untaxed'] : []),
          ...(ld ? ['disc', ld.type, ld.value] : []),
        ];
      }),
    labor: [money(estimate.labor_hours_override ?? estimate.labor_hours), money(estimate.labor_rate || 85)],
    ref: String(estimate.po_number ?? '').trim() || String(estimate.estimate_number ?? ''),
    vin: String(estimate.vin ?? '').trim().toUpperCase(),
    ...(units > 1 ? { vehicles: units } : {}),
    ...(discount ? { discount: [discount.type, discount.value] } : {}),
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
