/**
 * How rack kits (src/lib/part-kits.ts) read on an estimate.
 *
 * Stored, a kit is its component lines — ordinary priced item lines that
 * share a kit_group_id. Shown, it is ONE priced line for the rack (its part
 * number, name, rack quantity, price per rack and total) followed by the
 * components indented beneath it with their quantities and no prices
 * (Craig 2026-09-30: customers see the components, only the rack is priced).
 *
 * `toKitDisplayLines` is the one conversion every customer surface uses
 * (PDF, emailed/signed HTML document, approval page), so they can't
 * disagree. Totals are untouched: the heading's total is exactly the sum
 * of its components' line totals.
 */

import type { KitLineFields } from './part-kits';
import { z } from './validate';

type AnyLine = KitLineFields & {
  item_number?: string | null;
  description?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  line_total?: number | string | null;
  [k: string]: any;
};

export type KitDisplayLine<T> = T & {
  /** The rack's priced heading line (synthesized, not stored). */
  kit_header?: boolean;
  /** A component under a heading — show quantity only, no money. */
  kit_component?: boolean;
};

const num = (v: unknown) => Number(v) || 0;
const lineTotal = (l: AnyLine) =>
  l.line_total != null && l.line_total !== '' ? num(l.line_total) : num(l.quantity) * num(l.unit_price);

/**
 * Keep every kit's lines together, in the position of the kit's first line
 * (drag-reordering or an older save can separate them). Stable otherwise.
 */
export function gatherKitGroups<T extends AnyLine>(lines: T[]): T[] {
  if (!lines.some(l => l.kit_group_id)) return lines;
  const out: T[] = [];
  const placed = new Set<string>();
  for (const l of lines) {
    const g = l.kit_group_id;
    if (!g) { out.push(l); continue; }
    if (placed.has(g)) continue;
    placed.add(g);
    out.push(...lines.filter(x => x.kit_group_id === g));
  }
  return out;
}

/**
 * Lines in display order with a synthesized heading before each kit's
 * components. Heading: kit part number + name, rack qty, price per rack,
 * total. Components: flagged kit_component, with unit_price/line_total
 * zeroed so anything that sums the display rows still gets the right total.
 */
export function toKitDisplayLines<T extends AnyLine>(lines: T[]): KitDisplayLine<T>[] {
  const ordered = gatherKitGroups(lines);
  const out: KitDisplayLine<T>[] = [];
  const seen = new Set<string>();
  for (const l of ordered) {
    const g = l.kit_group_id;
    if (!g) { out.push(l); continue; }
    if (!seen.has(g)) {
      seen.add(g);
      const members = ordered.filter(x => x.kit_group_id === g);
      const total = Math.round(members.reduce((s, m) => s + lineTotal(m), 0) * 100) / 100;
      // Line discounts (migration 350) on a rack's parts show once, under
      // the rack: their sum, labelled with the percent when they all share it.
      const discounted = members.filter(m => num(m.discount_amount) > 0);
      const discountAmount = Math.round(discounted.reduce((s, m) => s + num(m.discount_amount), 0) * 100) / 100;
      const sameDiscount = discounted.length > 0 && discounted.length === members.length
        && discounted.every(m => m.discount_type === discounted[0].discount_type && num(m.discount_value) === num(discounted[0].discount_value));
      const kitQty = num(l.kit_quantity) > 0 ? num(l.kit_quantity) : 1;
      out.push({
        ...l,
        id: `kit-${g}`,
        part_id: null,
        item_number: l.kit_item_number || l.kit_name || 'Kit',
        description: l.kit_name || null,
        notes: null,
        quantity: kitQty,
        unit_price: Math.round((total / kitQty) * 100) / 100,
        line_total: total,
        part_image_url: null,
        part_product_url: null,
        image: null,
        discount_amount: discountAmount,
        discount_type: sameDiscount ? discounted[0].discount_type : (discountAmount > 0 ? 'amount' : null),
        discount_value: sameDiscount ? discounted[0].discount_value : (discountAmount > 0 ? discountAmount : null),
        kit_header: true,
      } as KitDisplayLine<T>);
    }
    out.push({ ...l, unit_price: 0, line_total: 0, discount_amount: 0, kit_component: true });
  }
  return out;
}

/**
 * A component's NetSuite line description, tagged with its rack so the
 * sales order still reads by rack ("… [Rack AR1205-S]").
 */
export function kitTaggedDescription(desc: string | undefined, line: KitLineFields): string | undefined {
  if (!line.kit_item_number) return desc;
  const tag = `[Rack ${line.kit_item_number}]`;
  return desc ? `${desc} ${tag}` : tag;
}

/** Normalized kit columns for an estimate_line_items insert. */
export function kitLineColumns(l: Omit<KitLineFields, 'kit_quantity'> & { kit_quantity?: number | string | null }) {
  const group = l.kit_group_id || null;
  return {
    kit_group_id: group,
    kit_id: group ? l.kit_id || null : null,
    kit_item_number: group ? l.kit_item_number || null : null,
    kit_name: group ? l.kit_name || null : null,
    kit_quantity: group ? (Number(l.kit_quantity) > 0 ? Number(l.kit_quantity) : 1) : null,
  };
}

/** The kit fields every line-accepting API takes (spread into its line schema). */
export const kitLineSchemaFields = {
  kit_group_id: z.string().uuid().optional().nullable(),
  kit_id: z.string().uuid().optional().nullable(),
  kit_item_number: z.string().max(120).optional().nullable(),
  kit_name: z.string().max(500).optional().nullable(),
  kit_quantity: z.union([z.number(), z.string()]).optional().nullable(),
};
