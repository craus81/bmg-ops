/**
 * Curt dealer price file (migration 447, Craig 2026-10-27).
 *
 * Curt sends BMG a "Customer Item Prices" spreadsheet (account 10729901)
 * covering every CURT Group brand: CURT, ARIES, LUVERNE, UWS, LIPPERT. Its
 * Price column is BMG's dealer cost; Jobber, MAP and List are Curt's
 * published prices. Inventory → Hitch Kits uploads it (the file loads into
 * curt_prices, replacing the rows by part number), and the hitch kit builder
 * reads the cost from there to show margin. Estimates still sell at Curt
 * List (Craig's pick), so an upload also refreshes the builder's list prices.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CurtPrice {
  item_number: string;
  brand: string | null;
  description: string | null;
  price_code: string | null;
  cost: number | null;
  jobber: number | null;
  map: number | null;
  list_price: number | null;
  weight_lb: number | null;
  upc: string | null;
}

export interface ParsedCurtPriceFile {
  rows: CurtPrice[];
  /** "Report Generated: 2026-10-26" from the title row, when present. */
  reportDate: string | null;
  /** Rows without a part number or a price (blank or footer lines). */
  skipped: number;
}

/** A cell as text; Excel rich text ({ richText: [{ text }] }) joins its runs. */
const text = (v: unknown): string | null => {
  if (v == null) return null;
  let raw: unknown = v;
  if (typeof v === 'object') {
    const o = v as any;
    raw = Array.isArray(o.richText) ? o.richText.map((r: any) => r?.text ?? '').join('') : (o.text ?? o.result ?? '');
  }
  const s = String(raw).trim();
  return s === '' ? null : s;
};

const money = (v: unknown): number | null => {
  const s = text(v);
  if (s == null) return null;
  const n = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const HEADERS: Record<string, keyof CurtPrice> = {
  'brand name': 'brand',
  'item number': 'item_number',
  'item description': 'description',
  'price code': 'price_code',
  'price': 'cost',
  'jobber': 'jobber',
  'map': 'map',
  'list': 'list_price',
  'weight': 'weight_lb',
  'upc': 'upc',
};

/**
 * Reads the price file's rows (each a list of cell values, first sheet). The
 * header row is found by its "Item Number" and "Price" titles, so a title
 * row above it, or columns in another order, don't matter.
 */
export function parseCurtPriceRows(sheet: unknown[][]): ParsedCurtPriceFile {
  let reportDate: string | null = null;
  let headerAt = -1;
  let cols: Partial<Record<keyof CurtPrice, number>> = {};
  for (let i = 0; i < Math.min(sheet.length, 20); i++) {
    const row = sheet[i] || [];
    for (const cell of row) {
      const m = /report generated:\s*(\d{4}-\d{2}-\d{2})/i.exec(text(cell) || '');
      if (m) reportDate = m[1];
    }
    const found: Partial<Record<keyof CurtPrice, number>> = {};
    row.forEach((cell, j) => {
      const key = HEADERS[(text(cell) || '').toLowerCase()];
      if (key && found[key] == null) found[key] = j;
    });
    if (found.item_number != null && found.cost != null) { headerAt = i; cols = found; break; }
  }
  if (headerAt < 0) {
    throw new Error('This doesn\'t look like the Curt price file: no "Item Number" and "Price" columns were found.');
  }

  const byItem = new Map<string, CurtPrice>();
  let skipped = 0;
  for (const row of sheet.slice(headerAt + 1)) {
    const at = (k: keyof CurtPrice) => (cols[k] == null ? undefined : (row || [])[cols[k]!]);
    const item = text(at('item_number'));
    const cost = money(at('cost'));
    if (!item || cost == null) { skipped++; continue; }
    byItem.set(item, {
      item_number: item,
      brand: text(at('brand')),
      description: text(at('description')),
      price_code: text(at('price_code')),
      cost,
      jobber: money(at('jobber')),
      map: money(at('map')),
      list_price: money(at('list_price')),
      weight_lb: money(at('weight_lb')),
      upc: text(at('upc')),
    });
  }
  return { rows: [...byItem.values()], reportDate, skipped };
}

/** Dealer cost per Curt SKU, for the parts the hitch builder offers. */
export async function loadCurtCosts(supabase: SupabaseClient, skus: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = [...new Set(skus)];
  for (let i = 0; i < wanted.length; i += 100) {
    // Only staff can read costs (RLS); anyone else just gets no margin shown.
    const { data } = await supabase.from('curt_prices').select('item_number, cost').in('item_number', wanted.slice(i, i + 100));
    for (const r of data || []) if (r.cost != null) out.set(String(r.item_number), Number(r.cost));
  }
  return out;
}

/** Margin on the sell price, as a whole percent; null when either side is unknown. */
export function marginPct(sell: number, cost: number | null | undefined): number | null {
  if (cost == null || !(sell > 0)) return null;
  return Math.round(((sell - cost) / sell) * 100);
}
