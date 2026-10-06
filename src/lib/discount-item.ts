import { suiteqlQuery } from './netsuite';
import { discountLabel, discountSplit, normalizeDiscount, normalizeVehicleCount } from './estimate-totals';
import { isLineTaxable } from './line-taxability';

/**
 * THE NetSuite item an estimate's discount (migration 342) pushes as, and
 * the discount lines themselves.
 *
 * Same shape as the labor item (src/lib/labor-item.ts): an admin names the
 * item once in Settings -> NetSuite Discount Item, and until then the push
 * looks for one. A missing item is never a silent no-op: NetSuite would
 * bill the full, undiscounted price, so callers BLOCK the push and say so.
 *
 * Order of authority -- the configured item (quote_settings) -> the best
 * active item of NetSuite type "Discount" -> an active item whose name
 * contains DISCOUNT.
 */

export type DiscountItem = {
  /** NetSuite internal id. */
  id: string;
  /** NetSuite item name (itemid). */
  itemNumber: string | null;
  /** NetSuite item type ("Discount", "OthCharge", ...); null when unknown. */
  itemType: string | null;
  source: 'setting' | 'search';
};

export type DiscountItemResolution = {
  item: DiscountItem | null;
  reason?: 'none_found' | 'netsuite_error';
  error?: string;
  candidates?: { id: string; itemNumber: string; itemType: string | null }[];
};

type Row = { id: string | number; itemid?: string | null; itemtype?: string | null };

/**
 * Rank candidates so every push picks the same item: real Discount-type
 * items first, then by how plainly the name says "discount", then
 * alphabetically, so NetSuite's row order never decides.
 */
export function rankDiscountItems<T extends Row>(rows: T[]): T[] {
  const score = (r: T) => {
    const name = (r.itemid || '').trim().toUpperCase();
    const typeScore = r.itemtype === 'Discount' ? 0 : 10;
    const nameScore = name === 'DISCOUNT' ? 0 : name.startsWith('DISCOUNT') ? 1 : name.includes('DISCOUNT') ? 2 : 3;
    return typeScore + nameScore;
  };
  return rows
    .filter((r) => r.itemtype === 'Discount' || (r.itemid || '').toUpperCase().includes('DISCOUNT'))
    .sort((a, b) => {
      const diff = score(a) - score(b);
      return diff !== 0 ? diff : (a.itemid || '').localeCompare(b.itemid || '');
    });
}

type SupabaseLike = { from: (table: string) => any };

async function configuredDiscountItem(supabase: SupabaseLike): Promise<{ id: string; itemNumber: string | null } | null> {
  try {
    const { data } = await supabase
      .from('quote_settings')
      .select('netsuite_discount_item_id, netsuite_discount_item_number')
      .eq('id', 1)
      .maybeSingle();
    const id = data?.netsuite_discount_item_id;
    if (id && /^\d+$/.test(String(id).trim())) {
      return { id: String(id).trim(), itemNumber: data?.netsuite_discount_item_number || null };
    }
  } catch {
    // Settings unreadable -- fall through to the search.
  }
  return null;
}

export async function resolveDiscountItem(supabase?: SupabaseLike): Promise<DiscountItemResolution> {
  const configured = supabase ? await configuredDiscountItem(supabase) : null;
  try {
    if (configured) {
      // The type decides the line's shape (a Discount item takes no
      // quantity), so it is read live rather than stored.
      let itemType: string | null = null;
      try {
        const res = await suiteqlQuery(`SELECT i.itemtype FROM item i WHERE i.id = ${configured.id}`);
        itemType = res?.items?.[0]?.itemtype || null;
      } catch { /* unknown type: pushed as a one-unit line */ }
      return { item: { ...configured, itemType, source: 'setting' } };
    }
    const res = await suiteqlQuery(
      "SELECT i.id, i.itemid, i.itemtype FROM item i WHERE i.isinactive = 'F' AND (i.itemtype = 'Discount' OR UPPER(i.itemid) LIKE '%DISCOUNT%') ORDER BY i.itemid",
      100,
    );
    const ranked = rankDiscountItems<Row>(res?.items || []);
    const best = ranked[0];
    if (!best) return { item: null, reason: 'none_found' };
    return {
      item: { id: String(best.id), itemNumber: best.itemid || null, itemType: best.itemtype || null, source: 'search' },
      candidates: ranked.map((r) => ({ id: String(r.id), itemNumber: r.itemid || '', itemType: r.itemtype || null })),
    };
  } catch (err: any) {
    return { item: null, reason: 'netsuite_error', error: err?.message || String(err) };
  }
}

/** A discount line as the NetSuite payload builders take it. */
export interface DiscountNsLine {
  itemId: string;
  /** Omitted for a Discount-type item, which has no quantity in NetSuite. */
  quantity?: number;
  /** Negative: the dollars off. */
  rate: number;
  description: string;
  /** Discount-type item: send the rate alone, no price level. */
  discountItem?: true;
  discount: true;
  /** true on the taxed share (unless the customer is exempt), false on the rest. */
  taxable?: boolean;
}

/**
 * The estimate's discount figured from its stored lines, the same way
 * computeTotals figured it when the estimate was saved.
 */
export function estimateDiscountSplit(
  estimate: { discount_type?: unknown; discount_value?: unknown; subtotal?: unknown; labor_total?: unknown; vehicle_count?: unknown },
  lines: any[],
) {
  const discount = normalizeDiscount(estimate.discount_type, estimate.discount_value);
  const units = normalizeVehicleCount(estimate.vehicle_count);
  const amt = (l: any) => (parseFloat(l.quantity) || 0) * units * (parseFloat(l.unit_price) || 0);
  const subtotal = (lines || []).reduce((s, l) => s + amt(l), 0);
  const taxedBase = (lines || []).reduce((s, l) => (isLineTaxable(l) ? s + amt(l) : s), 0);
  const labor = parseFloat(String(estimate.labor_total ?? 0)) || 0;
  return { discount, ...discountSplit(subtotal + labor, taxedBase, discount) };
}

/**
 * The NetSuite lines for an estimate's discount: one taxed line for the
 * share on taxed parts and one untaxed line for the rest (labor, services,
 * freight), each only when it is non-zero. Empty when there is no discount.
 */
export function buildDiscountLines(
  estimate: { discount_type?: unknown; discount_value?: unknown; subtotal?: unknown; labor_total?: unknown; vehicle_count?: unknown; tax_exempt?: unknown },
  lines: any[],
  item: DiscountItem,
): DiscountNsLine[] {
  const split = estimateDiscountSplit(estimate, lines);
  if (!(split.amount > 0)) return [];
  const label = discountLabel(estimate.discount_type, estimate.discount_value);
  const isDiscountType = item.itemType === 'Discount';
  const make = (dollars: number, taxed: boolean, suffix: string): DiscountNsLine => ({
    itemId: item.id,
    ...(isDiscountType ? { discountItem: true as const } : { quantity: 1 }),
    rate: -dollars,
    description: `${label}${suffix}`,
    discount: true,
    // Said outright both ways: the item's own default must not decide.
    // An exempt customer's estimate carries no line tax flag at all, like
    // its other lines, and NetSuite's exempt header zeroes the tax.
    ...(taxed ? (estimate.tax_exempt ? {} : { taxable: true }) : { taxable: false }),
  });
  const both = split.taxedPortion > 0 && split.untaxedPortion > 0;
  const out: DiscountNsLine[] = [];
  if (split.taxedPortion > 0) out.push(make(split.taxedPortion, true, both ? ' - on taxed parts' : ''));
  if (split.untaxedPortion > 0) out.push(make(split.untaxedPortion, false, both ? ' - on labor and untaxed items' : ''));
  return out;
}
