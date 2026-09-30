/**
 * Packages and rack kits (part_kits / part_kit_items, migrations 201 + 332).
 *
 * Two flavors share the tables:
 *  - a plain PACKAGE (item_number NULL) explodes into ordinary estimate
 *    lines, exactly as before;
 *  - a RACK KIT (item_number set, e.g. Prime Design "AR1205-S") keeps its
 *    identity on the estimate: every component line carries the kit's
 *    group id / part number / name / quantity, and customer surfaces show
 *    one priced rack line with the components indented beneath it
 *    (src/lib/estimate-kits.ts).
 *
 * Either way the component lines are real, priced catalog lines, so stock,
 * tax, margin and the NetSuite push treat them like any hand-picked part.
 *
 * Members are matched to the catalog by part_id, else by item_number — a
 * kit can be imported before its parts exist in NetSuite, and links up once
 * the part syncs. A member with no catalog match is reported in `missing`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrowsePart } from '@/components/PartCatalogBrowser';
import { fetchAllRows } from './fetch-all';

export const KIT_PART_COLUMNS =
  'id, netsuite_id, item_number, display_name, description, marketing_description, catalog, item_type, vendor, sales_price, purchase_price, avg_install_cost, labor_hours, quantity_on_hand, quantity_available, product_category_id, category_source, image_path, width_in, depth_in, height_in, weight_lb, mount_type, dims_source';

export type KitPart = BrowsePart & { quantity_on_hand?: number | null };

export interface KitMissingMember {
  item_number: string;
  description: string | null;
  quantity: number;
}

/** A package / rack kit with its members resolved to live parts. */
export interface KitWithMembers {
  id: string;
  name: string;
  description: string | null;
  vehicle_label: string | null;
  image_path: string | null;
  /** Rack kit part number; null on a plain package. */
  item_number: string | null;
  vendor: string | null;
  /** Assembly overhead beyond the members' own labor hours. */
  labor_adder_hours: number;
  /** Members found in the catalog, in kit order. */
  members: { part: KitPart; quantity: number }[];
  /** Members not in the catalog yet (not created in NetSuite / not synced). */
  missing: KitMissingMember[];
  /** Sum of the found members' sales prices × qty. */
  totalPrice: number;
  totalLabor: number;
}

export const normItem = (s: string | null | undefined) => String(s || '').trim().toUpperCase();

/** Every active kit (packages and rack kits), members resolved. */
export async function loadKits(supabase: SupabaseClient): Promise<KitWithMembers[]> {
  const { data: rows, error } = await fetchAllRows<any>((from, to) =>
    supabase
      .from('part_kits')
      .select('id, name, description, vehicle_label, image_path, labor_adder_hours, item_number, vendor, part_kit_items(part_id, item_number, description, quantity, sort_order)')
      .eq('active', true)
      .order('name')
      .order('id')
      .range(from, to));
  if (error) throw new Error(error.message);

  const items = rows.flatMap((k: any) => k.part_kit_items || []);
  const partIds = [...new Set(items.map((i: any) => i.part_id).filter(Boolean))] as string[];
  const partsById = new Map<string, KitPart>();
  const partsByItem = new Map<string, KitPart>();
  const keep = (p: KitPart) => {
    partsById.set(p.id, p);
    const key = normItem(p.item_number);
    if (key && !partsByItem.has(key)) partsByItem.set(key, p);
  };
  for (let i = 0; i < partIds.length; i += 200) {
    const { data: ps } = await supabase
      .from('netsuite_parts')
      .select(KIT_PART_COLUMNS)
      .in('id', partIds.slice(i, i + 200))
      .eq('is_active', true);
    for (const p of (ps || []) as unknown as KitPart[]) keep(p);
  }
  // Members without a linked part (imported before the part existed):
  // match by part number.
  const unlinked = [...new Set(items
    .filter((i: any) => (!i.part_id || !partsById.has(i.part_id)) && i.item_number)
    .map((i: any) => String(i.item_number).trim()))] as string[];
  for (let i = 0; i < unlinked.length; i += 200) {
    const { data: ps } = await supabase
      .from('netsuite_parts')
      .select(KIT_PART_COLUMNS)
      .in('item_number', unlinked.slice(i, i + 200))
      .eq('is_active', true)
      .order('id');
    for (const p of (ps || []) as unknown as KitPart[]) keep(p);
  }

  return rows.map((k: any) => {
    const members: KitWithMembers['members'] = [];
    const missing: KitMissingMember[] = [];
    const sorted = [...(k.part_kit_items || [])].sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    for (const i of sorted) {
      const quantity = Number(i.quantity) || 1;
      const part = (i.part_id && partsById.get(i.part_id)) || partsByItem.get(normItem(i.item_number));
      if (part) members.push({ part, quantity });
      else if (i.item_number) missing.push({ item_number: String(i.item_number), description: i.description || null, quantity });
    }
    const laborAdder = Number(k.labor_adder_hours) || 0;
    return {
      id: k.id,
      name: k.name,
      description: k.description,
      vehicle_label: k.vehicle_label,
      image_path: k.image_path,
      item_number: k.item_number || null,
      vendor: k.vendor || null,
      labor_adder_hours: laborAdder,
      members,
      missing,
      totalPrice: members.reduce((s, m) => s + (Number(m.part.sales_price) || 0) * m.quantity, 0),
      totalLabor: members.reduce((s, m) => s + (Number(m.part.labor_hours) || 0) * m.quantity, 0) + laborAdder,
    };
  }).filter(k => k.members.length > 0 || k.missing.length > 0);
}

/** The line fields that tie a component line to its rack kit. */
export interface KitLineFields {
  kit_group_id?: string | null;
  kit_id?: string | null;
  kit_item_number?: string | null;
  kit_name?: string | null;
  kit_quantity?: number | null;
}

export interface KitEstimateLine extends KitLineFields {
  part_id: string | null;
  netsuite_item_id: string | null;
  item_number: string;
  description: string;
  quantity: number;
  unit_price: number;
  labor_hours: number | null;
  is_custom: boolean;
  catalog?: string;
  purchase_price?: number | null;
  avg_install_cost?: number | null;
}

const newGroupId = () =>
  (globalThis.crypto && 'randomUUID' in globalThis.crypto)
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });

/**
 * The estimate lines for adding `kitQty` of a kit. A rack kit's lines all
 * carry one new kit group; a plain package's lines are ordinary lines (plus
 * its assembly-labor line, as before). Members missing from the catalog
 * land as custom lines at $0 so nobody quotes a rack short a part without
 * seeing it — the builder flags them for a NetSuite match.
 */
export function kitEstimateLines(kit: KitWithMembers, kitQty = 1): KitEstimateLine[] {
  const qty = kitQty > 0 ? kitQty : 1;
  const group: KitLineFields = kit.item_number
    ? { kit_group_id: newGroupId(), kit_id: kit.id, kit_item_number: kit.item_number, kit_name: kit.name, kit_quantity: qty }
    : {};
  const lines: KitEstimateLine[] = kit.members.map(m => ({
    part_id: m.part.id,
    netsuite_item_id: m.part.netsuite_id,
    item_number: m.part.item_number,
    description: m.part.display_name || m.part.marketing_description || m.part.description || m.part.item_number,
    quantity: m.quantity * qty,
    unit_price: Number(m.part.sales_price) || 0,
    labor_hours: m.part.labor_hours ?? null,
    is_custom: false,
    catalog: m.part.catalog || undefined,
    purchase_price: m.part.purchase_price,
    avg_install_cost: m.part.avg_install_cost,
    ...group,
  }));
  for (const m of kit.missing) {
    lines.push({
      part_id: null,
      netsuite_item_id: null,
      item_number: m.item_number,
      description: m.description || m.item_number,
      quantity: m.quantity * qty,
      unit_price: 0,
      labor_hours: null,
      is_custom: true,
      ...group,
    });
  }
  if (kit.labor_adder_hours > 0) {
    lines.push({
      part_id: null,
      netsuite_item_id: null,
      item_number: '',
      description: `${kit.name} — assembly labor`,
      quantity: 1,
      unit_price: 0,
      labor_hours: kit.labor_adder_hours,
      is_custom: true,
      ...group,
    });
  }
  return lines;
}

// ── Buildable from stock ────────────────────────────────────────────────

export interface KitStock {
  /** Available in NetSuite minus FleetSuite reservations, floored at 0. */
  free: number;
  /** Open vendor PO quantity not yet received. */
  on_order: number;
}

export interface KitBuildable {
  /** Racks buildable from free stock right now. */
  now: number;
  /** Racks buildable once open POs arrive. */
  withOnOrder: number;
  /** The component that limits `now` (null when nothing limits it). */
  bottleneck: string | null;
  /** Per component: what one rack needs, what's free, how many racks it covers. */
  components: { item_number: string; per_kit: number; free: number; on_order: number; covers: number; in_catalog: boolean }[];
}

/**
 * How many of one kit can be built from stock. Each component covers
 * floor(free ÷ per-kit qty) racks; the kit is limited by its scarcest
 * component. Racks share parts, so this is "if you built only this rack".
 * A component missing from the catalog has no stock, so it limits to 0.
 */
export function kitBuildable(
  components: { item_number: string; quantity: number; in_catalog: boolean }[],
  stock: Map<string, KitStock>,
): KitBuildable {
  // One component can appear twice in a kit — combine per part number.
  const perKit = new Map<string, { qty: number; in_catalog: boolean }>();
  for (const c of components) {
    const key = normItem(c.item_number);
    const prev = perKit.get(key);
    perKit.set(key, { qty: (prev?.qty || 0) + (Number(c.quantity) || 0), in_catalog: (prev?.in_catalog ?? true) && c.in_catalog });
  }
  const rows: KitBuildable['components'] = [];
  let now = Infinity;
  let withOnOrder = Infinity;
  let bottleneck: string | null = null;
  for (const [item, { qty, in_catalog }] of perKit) {
    if (qty <= 0) continue;
    const s = stock.get(item) || { free: 0, on_order: 0 };
    const covers = Math.floor(s.free / qty);
    const coversLater = Math.floor((s.free + s.on_order) / qty);
    rows.push({ item_number: item, per_kit: qty, free: s.free, on_order: s.on_order, covers, in_catalog });
    if (covers < now) { now = covers; bottleneck = item; }
    withOnOrder = Math.min(withOnOrder, coversLater);
  }
  if (rows.length === 0) return { now: 0, withOnOrder: 0, bottleneck: null, components: [] };
  return { now, withOnOrder, bottleneck, components: rows };
}
