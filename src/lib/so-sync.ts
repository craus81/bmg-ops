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

export interface SoLineItem { itemId: string; quantity: number; rate: number; description?: string }

export interface SoLineBuild {
  soLineItems: SoLineItem[];
  customLineDescriptions: string[];
  unmappedLineDescriptions: string[];
  laborSkipped: boolean;
  laborItemNumber: string | null;
  laborHours: number;
  laborRate: number;
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
 */
export async function buildSoLineItems(
  supabase: SupabaseClient,
  estimate: { labor_hours?: unknown; labor_hours_override?: unknown; labor_rate?: unknown },
  lines: any[],
): Promise<SoLineBuild> {
  const sorted = [...(lines || [])].sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0));
  const soLineItems: SoLineItem[] = [];
  const customLineDescriptions: string[] = [];
  const unmappedLineDescriptions: string[] = [];
  let customItemId: string | null | undefined;

  for (const li of sorted) {
    if ((parseFloat(li.quantity) || 0) <= 0) continue;
    if (li.netsuite_item_id) {
      const lineDesc = [li.description, li.notes].filter(Boolean).join(' — ')
        || li.item_number
        || undefined;
      soLineItems.push({
        itemId: String(li.netsuite_item_id),
        quantity: parseFloat(li.quantity),
        rate: parseFloat(li.unit_price) || 0,
        description: lineDesc,
      });
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
    const fullDesc = li.notes ? `${label} (${li.notes})` : label;
    soLineItems.push({
      itemId: customItemId,
      quantity: parseFloat(li.quantity),
      rate: parseFloat(li.unit_price) || 0,
      description: fullDesc,
    });
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

  return { soLineItems, customLineDescriptions, unmappedLineDescriptions, laborSkipped, laborItemNumber, laborHours, laborRate };
}

/**
 * The SO contract: lines with quantity > 0 (item number, qty, price) in
 * sort order, effective labor hours + rate, the reference number the SO
 * carries (customer PO, else the estimate number) and the VIN. Descriptions
 * and totals are excluded — a description touch or a tax-rate change on
 * our side doesn't alter what NetSuite has to bill lines for.
 */
export function soContentHash(
  estimate: { labor_hours?: unknown; labor_hours_override?: unknown; labor_rate?: unknown; po_number?: unknown; estimate_number?: unknown; vin?: unknown },
  lines: Array<{ item_number?: unknown; quantity?: unknown; unit_price?: unknown; sort_order?: unknown }>,
): string {
  const money = (v: unknown) => +(parseFloat(String(v ?? 0)) || 0).toFixed(2);
  const body = {
    lines: [...lines]
      .filter(l => (parseFloat(String(l.quantity ?? 0)) || 0) > 0)
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
      .map(l => [String(l.item_number ?? ''), money(l.quantity), money(l.unit_price)]),
    labor: [money(estimate.labor_hours_override ?? estimate.labor_hours), money(estimate.labor_rate || 85)],
    ref: String(estimate.po_number ?? '').trim() || String(estimate.estimate_number ?? ''),
    vin: String(estimate.vin ?? '').trim().toUpperCase(),
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
