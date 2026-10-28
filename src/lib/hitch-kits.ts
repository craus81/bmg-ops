/**
 * Trailer hitch kit builder (migration 434, Craig 2026-10-25).
 *
 * Nothing is set up ahead of time: the estimate picks the vehicle and year,
 * then a hitch, a 4-way wiring harness, an optional 7/4-way adapter and a
 * brake controller (good / better / best / Bluetooth). The picks become one
 * kit group of ordinary estimate lines — the same kit_group_id columns rack
 * kits use (migration 332), so every customer surface already shows them as
 * one priced kit line with the parts listed beneath it.
 *
 * Each part's own line carries its install labor (hitch, wiring, adapter,
 * brake controller from hitch_settings), so the estimate's labor total and
 * margin read it like any other line.
 *
 * A part is priced from its NetSuite item when one exists (matched by part
 * number: "13193", "C13193" as etrailer sells it, or "CURT-13193"). One that
 * isn't in NetSuite yet lands as a custom line at Curt's list price and is
 * flagged, so it can be created before the sales order.
 *
 * BMG's dealer cost comes from Curt's price file (curt_prices, migration
 * 445): the builder shows margin from it, and a line's cost falls back to it
 * when NetSuite has no purchase price.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { KitEstimateLine, KitLineFields } from './part-kits';
import { partNumberKey } from './loose-search';
import { HITCH_KIT_ITEM_NUMBER } from './estimate-kits';
import { loadCurtCosts } from './curt-prices';

export { HITCH_KIT_ITEM_NUMBER };

export type HitchRole = 'hitch' | 'wiring' | 'adapter' | 'factory_adapter' | 'brake_controller' | 'brake_harness';
export type BrakeTier = 'good' | 'better' | 'best' | 'bluetooth';

export interface HitchPart {
  sku: string;
  role: HitchRole;
  name: string;
  list_price: number | null;
  hitch_class: string | null;
  receiver: string | null;
  specs: Record<string, string>;
  features: string[];
  notes: string[];
  image_url: string | null;
  needs_factory_wiring: boolean;
  tier: BrakeTier | null;
  sort_order: number;
  active: boolean;
  /** BMG's dealer cost from Curt's price file; null when unknown or not staff. */
  dealer_cost: number | null;
}

export interface HitchFitment {
  platform_key: string;
  sku: string;
  year_start: number;
  year_end: number;
}

export interface HitchSettings {
  labor_hitch: number;
  labor_wiring: number;
  labor_adapter: number;
  labor_brake: number;
}

export const DEFAULT_HITCH_SETTINGS: HitchSettings = {
  labor_hitch: 1,
  labor_wiring: 1,
  labor_adapter: 0.75,
  labor_brake: 1,
};

export interface HitchData {
  parts: HitchPart[];
  fitment: HitchFitment[];
  settings: HitchSettings;
}

export const BRAKE_TIER_LABEL: Record<BrakeTier, string> = {
  good: 'Good',
  better: 'Better',
  best: 'Best',
  bluetooth: 'Bluetooth',
};

const num = (v: unknown) => Number(v) || 0;

function normPart(p: any): HitchPart {
  return {
    sku: String(p.sku),
    role: p.role,
    name: p.name,
    list_price: p.list_price == null ? null : Number(p.list_price),
    hitch_class: p.hitch_class || null,
    receiver: p.receiver || null,
    specs: p.specs && typeof p.specs === 'object' ? p.specs : {},
    features: Array.isArray(p.features) ? p.features : [],
    notes: Array.isArray(p.notes) ? p.notes : [],
    image_url: p.image_url || null,
    needs_factory_wiring: !!p.needs_factory_wiring,
    tier: p.tier || null,
    sort_order: num(p.sort_order),
    active: p.active !== false,
    dealer_cost: null,
  };
}

/** Everything the builder needs, in a few small reads. */
export async function loadHitchData(supabase: SupabaseClient): Promise<HitchData> {
  const [partsRes, fitRes, setRes] = await Promise.all([
    supabase.from('hitch_parts').select('*').order('sort_order').order('sku'),
    supabase.from('hitch_fitment').select('platform_key, sku, year_start, year_end').order('id'),
    supabase.from('hitch_settings').select('labor_hitch, labor_wiring, labor_adapter, labor_brake').eq('id', 1).maybeSingle(),
  ]);
  if (partsRes.error) throw new Error(partsRes.error.message);
  if (fitRes.error) throw new Error(fitRes.error.message);
  const s = setRes.data;
  const parts = (partsRes.data || []).map(normPart);
  const costs = await loadCurtCosts(supabase, parts.map(p => p.sku)).catch(() => new Map<string, number>());
  for (const p of parts) p.dealer_cost = costs.get(p.sku) ?? null;
  return {
    parts,
    fitment: (fitRes.data || []).map((f: any) => ({ ...f, year_start: num(f.year_start), year_end: num(f.year_end) })),
    settings: s
      ? { labor_hitch: num(s.labor_hitch), labor_wiring: num(s.labor_wiring), labor_adapter: num(s.labor_adapter), labor_brake: num(s.labor_brake) }
      : DEFAULT_HITCH_SETTINGS,
  };
}

export interface HitchOptions {
  hitches: HitchPart[];
  /** 4-way harnesses for this vehicle and year (factory-plug ones only when it has factory wiring). */
  wiring: HitchPart[];
  brakeControllers: HitchPart[];
  /** Plug-in brake harness for this vehicle, when Curt lists one. */
  brakeHarness: HitchPart | null;
  /** Vehicle has a factory tow plug option at all (shows the switch). */
  hasFactoryOption: boolean;
}

/** What the builder offers for one vehicle, model year and factory-wiring answer. */
export function hitchOptionsFor(data: HitchData, platformKey: string, year: number, factoryWiring: boolean): HitchOptions {
  const bySku = new Map(data.parts.filter(p => p.active).map(p => [p.sku, p]));
  const fits = data.fitment
    .filter(f => f.platform_key === platformKey && year >= f.year_start && year <= f.year_end)
    .map(f => bySku.get(f.sku))
    .filter((p): p is HitchPart => !!p);
  const byClass = (a: HitchPart, b: HitchPart) =>
    String(a.hitch_class || '').localeCompare(String(b.hitch_class || '')) || num(a.list_price) - num(b.list_price);
  const wiringAll = fits.filter(p => p.role === 'wiring');
  const wiring = wiringAll
    .filter(p => factoryWiring || !p.needs_factory_wiring)
    // With factory wiring, the plug-in parts are the usual pick: show them first.
    .sort((a, b) => (factoryWiring ? Number(b.needs_factory_wiring) - Number(a.needs_factory_wiring) : 0) || num(a.list_price) - num(b.list_price));
  return {
    hitches: fits.filter(p => p.role === 'hitch').sort(byClass),
    wiring,
    brakeControllers: data.parts.filter(p => p.active && p.role === 'brake_controller').sort((a, b) => a.sort_order - b.sort_order),
    brakeHarness: fits.find(p => p.role === 'brake_harness') || null,
    hasFactoryOption: wiringAll.some(p => p.needs_factory_wiring),
  };
}

/** The 7/4-way adapter that goes with a harness: the plug-in one for a factory socket. */
export function adapterFor(data: HitchData, wiring: HitchPart | null): HitchPart | null {
  if (!wiring) return null;
  const role: HitchRole = wiring.needs_factory_wiring ? 'factory_adapter' : 'adapter';
  return data.parts.filter(p => p.active && p.role === role).sort((a, b) => num(a.list_price) - num(b.list_price))[0] || null;
}

/** The Bluetooth controller plugs into the trailer's 7-way, so it needs the adapter. */
export const needsSevenWay = (brake: HitchPart | null) => brake?.tier === 'bluetooth';

export interface HitchChoices {
  platformLabel: string;
  year: number;
  hitch: HitchPart;
  wiring: HitchPart | null;
  adapter: HitchPart | null;
  brakeController: HitchPart | null;
  brakeHarness: HitchPart | null;
}

/** The kit's heading on the estimate and every customer surface. */
export function hitchKitName(c: Pick<HitchChoices, 'platformLabel' | 'year' | 'hitch' | 'wiring' | 'adapter' | 'brakeController'>): string {
  const bits = [`Trailer hitch kit, ${c.year} ${c.platformLabel}`];
  if (c.hitch.hitch_class) bits.push(`Class ${c.hitch.hitch_class}`);
  if (c.adapter) bits.push('7-way');
  else if (c.wiring) bits.push('4-way');
  let name = bits.join(', ');
  if (c.brakeController) name += ' + brake controller';
  return name;
}

/** Part numbers a Curt SKU may go by in NetSuite (etrailer sells 13193 as C13193). */
export function hitchSkuKeys(sku: string): string[] {
  const k = partNumberKey(sku);
  return [k, `c${k}`, `cur${k}`, `curt${k}`];
}

/** The Curt SKU behind a part number, if it looks like one ("C13193" → "13193"). */
export function curtSkuFromItemNumber(itemNumber: string | null | undefined): string | null {
  const k = partNumberKey(itemNumber);
  const m = /^(?:curt|cur|c)?(\d{4,8})$/.exec(k);
  return m ? m[1] : null;
}

export interface CatalogPart {
  id: string;
  netsuite_id: string | null;
  item_number: string;
  display_name?: string | null;
  description?: string | null;
  sales_price: number | null;
  purchase_price?: number | null;
  avg_install_cost?: number | null;
  catalog?: string | null;
}

/** NetSuite items for these SKUs, keyed by SKU. */
export async function matchHitchCatalog(supabase: SupabaseClient, skus: string[]): Promise<Map<string, CatalogPart>> {
  const out = new Map<string, CatalogPart>();
  const wanted = [...new Set(skus)];
  if (wanted.length === 0) return out;
  // Seven spellings per SKU; 40 SKUs a request keeps the URL short.
  for (let i = 0; i < wanted.length; i += 40) {
    const candidates = wanted.slice(i, i + 40).flatMap(s => [s, `C${s}`, `CUR${s}`, `CURT${s}`, `CURT-${s}`, `CUR-${s}`, `C-${s}`]);
    const { data } = await supabase
      .from('netsuite_parts')
      .select('id, netsuite_id, item_number, display_name, description, sales_price, purchase_price, avg_install_cost, catalog')
      .in('item_number', candidates)
      .eq('is_active', true);
    for (const p of (data || []) as CatalogPart[]) {
      const sku = curtSkuFromItemNumber(p.item_number);
      if (sku && wanted.includes(sku) && !out.has(sku)) out.set(sku, p);
    }
  }
  return out;
}

const newGroupId = () =>
  (globalThis.crypto && 'randomUUID' in globalThis.crypto)
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });

export interface HitchKitLine extends KitEstimateLine {
  /** Not in NetSuite yet: priced at Curt's list price, flagged on the builder. */
  not_in_netsuite?: boolean;
}

/**
 * The estimate lines for one built kit: one line per part, in builder order,
 * all in one new kit group. Labor rides on the line it belongs to.
 */
export function hitchKitLines(c: HitchChoices, settings: HitchSettings, catalog: Map<string, CatalogPart>): HitchKitLine[] {
  const group: KitLineFields = {
    kit_group_id: newGroupId(),
    kit_id: null,
    kit_item_number: HITCH_KIT_ITEM_NUMBER,
    kit_name: hitchKitName(c),
    kit_quantity: 1,
  };
  const picks: { part: HitchPart; labor: number }[] = [{ part: c.hitch, labor: settings.labor_hitch }];
  if (c.wiring) picks.push({ part: c.wiring, labor: settings.labor_wiring });
  if (c.adapter) picks.push({ part: c.adapter, labor: settings.labor_adapter });
  if (c.brakeController) {
    picks.push({ part: c.brakeController, labor: settings.labor_brake });
    // A dash-mounted controller plugs in with the vehicle's harness when Curt
    // makes one; the Bluetooth one plugs into the 7-way and needs none.
    if (c.brakeHarness && !needsSevenWay(c.brakeController)) picks.push({ part: c.brakeHarness, labor: 0 });
  }
  return picks.map(({ part, labor }) => {
    const ns = catalog.get(part.sku);
    if (ns) {
      return {
        part_id: ns.id,
        netsuite_item_id: ns.netsuite_id,
        item_number: ns.item_number,
        description: ns.display_name || ns.description || part.name,
        quantity: 1,
        unit_price: ns.sales_price != null ? Number(ns.sales_price) : num(part.list_price),
        labor_hours: labor,
        is_custom: false,
        catalog: ns.catalog || undefined,
        purchase_price: ns.purchase_price ?? part.dealer_cost,
        avg_install_cost: ns.avg_install_cost ?? null,
        ...group,
      };
    }
    return {
      part_id: null,
      netsuite_item_id: null,
      item_number: part.sku,
      description: `CURT ${part.name}`,
      quantity: 1,
      unit_price: num(part.list_price),
      labor_hours: labor,
      is_custom: true,
      not_in_netsuite: true,
      purchase_price: part.dealer_cost,
      ...group,
    };
  });
}

export const hitchLabor = (lines: { labor_hours: number | null }[]) =>
  Math.round(lines.reduce((s, l) => s + num(l.labor_hours), 0) * 100) / 100;

/**
 * Curt photo URLs for a hitch kit's estimate lines, keyed by Curt SKU — so a hitch kit's parts show their pictures on the PDF, the
 * email and the approval page even before they are NetSuite items.
 */
export async function hitchImagesForLines(
  supabase: SupabaseClient,
  lines: { item_number?: string | null; kit_item_number?: string | null }[],
): Promise<Map<string, string>> {
  const skus = [...new Set(lines
    .filter(l => l.kit_item_number === HITCH_KIT_ITEM_NUMBER)
    .map(l => curtSkuFromItemNumber(l.item_number))
    .filter(Boolean))] as string[];
  const out = new Map<string, string>();
  if (skus.length === 0) return out;
  const { data } = await supabase.from('hitch_parts').select('sku, image_url').in('sku', skus);
  for (const p of data || []) if (p.image_url && /^https:\/\//i.test(p.image_url)) out.set(String(p.sku), p.image_url);
  return out;
}
