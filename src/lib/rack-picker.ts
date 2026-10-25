/**
 * "Build a rack" step picker (Craig 2026-10-25), the first tab of the
 * estimate's Ladder rack window. It walks the existing Prime/Ranger rack
 * kits (migration 333) one choice at a time and only offers combinations
 * that are a real kit (Craig: "presets only, grey out combos that don't
 * exist").
 *
 *  - ErgoRack: vehicle → roof / crossbar size → 2 or 3 crossbars → street
 *    side and curb side, each Base, Clamp or Rotation. The parts don't
 *    depend on which side gets what (a BR kit is Base on one side, Rotation
 *    on the other), so the sides ride along as a note in the rack's name.
 *  - AluRack: vehicle → roof / length → silver or black, plus add-ons: a
 *    ladder clamp down per side (ACX street side, AXC curb side, at most one
 *    of each) and any number of ACC-8000 ratchet tie downs. Add-ons are
 *    their own lines right under the rack, 0.5 hr labor each.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { KitWithMembers } from './part-kits';
import { rackBaseNumber, rackFacets, rackFinish, type RackFinish } from './rack-kit-facets';

export type RackSide = 'B' | 'C' | 'R';
export const SIDE_LABEL: Record<RackSide, string> = { B: 'Base', C: 'Clamp', R: 'Rotation' };
export const SIDE_HINT: Record<RackSide, string> = {
  B: 'End stop, ladder rides on top',
  C: 'Clamp-down arm',
  R: 'Drops the ladder to the side',
};
const SIDE_ORDER = 'BCR';

/** The kit code for one side each, order-free: Rotation + Base = "BR". */
export const sidePair = (a: RackSide, b: RackSide) =>
  [a, b].sort((x, y) => SIDE_ORDER.indexOf(x) - SIDE_ORDER.indexOf(y)).join('');

export interface PickerRack {
  kit: KitWithMembers;
  line: 'ErgoRack' | 'AluRack';
  vehicle: string;
  /** Roof / size choice within the vehicle. */
  fit: string;
  fitLabel: string;
  fitSub: string;
  finish: RackFinish;
  /** ErgoRack only. */
  bars?: 2 | 3;
  pair?: string;
}

// ErgoRack part numbers: STYLE-VEHICLE-WIDTH-M, e.g. BR-FT-72-M, RR3-UM3-99-M.
const ERGO_NUMBER = /^(BB|BC|BR|CC|CR|RR)(3?)-([A-Z0-9]+)-(\d{2})-M$/i;

const ERGO_FIT: Record<string, string | Record<string, string>> = {
  FT: { '72': 'Medium / high roof', '78': 'Low roof' },
  PM: { '72': 'High roof' },
  PU1: '5 ft bed',
  PU2: '6 ft bed',
  PU3: '8 ft bed',
  PU4: '8 ft open bed',
  SP: 'No factory roof channel',
  SPX: 'Factory roof channel',
};

const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\bFt\b/g, 'ft');

/** AluRack roof / length label from the kit's Prime description and name. */
export function aluRackFit(description: string, name: string): { label: string; sub: string } {
  const roof = description.toUpperCase().match(/L\dH\d(?: L\dH\d)?/) || name.toUpperCase().match(/L\dH\d/);
  const wheelbase = name.match(/(\d{3}(?:\.\d)?) IN (?:Extended )?Wheelbase/i);
  if (roof) return { label: roof[0].replace(' ', ' / '), sub: wheelbase ? `${wheelbase[1]} in wheelbase` : '' };
  const rest = description.toUpperCase()
    .replace(/ALURACK|\bAR\b|BLACK|\bBLK\b|- ?MOD|W ROLLER|NV200 13|CITY EXPRESS 15|FORD E VAN|GM VAN|FORD MAVERICK|UNIVERSAL|\bCHL\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const len = name.match(/(\d+) IN long|Top (\d+) IN/i);
  return {
    label: rest ? titleCase(rest).replace('Channel', 'channel').replace('Mount', 'mount') : 'Standard',
    sub: /universal/i.test(name) && !/topper/i.test(name) ? 'No mounts included' : len ? `${len[1] || len[2]} in rails` : '',
  };
}

/** The kits the picker can offer, read from their part numbers and names. */
export function pickerRacks(kits: KitWithMembers[]): PickerRack[] {
  const out: PickerRack[] = [];
  for (const kit of kits) {
    const number = String(kit.item_number || '').trim();
    if (!number) continue;
    const facets = rackFacets(kit);
    const ergo = ERGO_NUMBER.exec(number);
    if (ergo) {
      const [, style, three, veh, width] = ergo;
      const named = ERGO_FIT[veh.toUpperCase()];
      const label = typeof named === 'string' ? named : named?.[width] || `${width} in crossbars`;
      out.push({
        kit, line: 'ErgoRack', vehicle: facets.vehicle,
        fit: `${veh.toUpperCase()}-${width}`, fitLabel: label, fitSub: `${width} in crossbars`,
        finish: 'Silver', bars: three ? 3 : 2, pair: style.toUpperCase(),
      });
    } else if (facets.line === 'AluRack') {
      const f = aluRackFit(kit.description || '', kit.name);
      out.push({
        kit, line: 'AluRack', vehicle: facets.vehicle,
        fit: rackBaseNumber(number), fitLabel: f.label, fitSub: f.sub,
        finish: rackFinish(number, kit.name),
      });
    }
  }
  return out.sort((a, b) => String(a.kit.item_number).localeCompare(String(b.kit.item_number)));
}

export interface PickerChoice {
  line: 'ErgoRack' | 'AluRack' | null;
  vehicle: string | null;
  fit: string | null;
  bars: 2 | 3;
  street: RackSide | null;
  curb: RackSide | null;
  finish: RackFinish | null;
}

export const EMPTY_CHOICE: PickerChoice = { line: null, vehicle: null, fit: null, bars: 2, street: null, curb: null, finish: null };

const uniq = <T,>(a: T[]) => [...new Set(a)];

export const vehiclesFor = (racks: PickerRack[], line: PickerChoice['line']) =>
  uniq(racks.filter(r => r.line === line).map(r => r.vehicle)).sort();

/** Fits for a vehicle, one entry each, in part-number order. */
export function fitsFor(racks: PickerRack[], line: PickerChoice['line'], vehicle: string | null) {
  const seen = new Map<string, PickerRack>();
  for (const r of racks) if (r.line === line && r.vehicle === vehicle && !seen.has(r.fit)) seen.set(r.fit, r);
  return [...seen.values()];
}

export const racksForFit = (racks: PickerRack[], c: PickerChoice) =>
  racks.filter(r => r.line === c.line && r.vehicle === c.vehicle && r.fit === c.fit);

/** Side codes that exist for the chosen fit and crossbar count. */
export const pairsFor = (racks: PickerRack[], c: PickerChoice) =>
  uniq(racksForFit(racks, c).filter(r => r.bars === c.bars).map(r => r.pair as string));

/** Is this feature offered on this side, given what the other side holds? */
export function sideOffered(pairs: string[], side: RackSide, other: RackSide | null): boolean {
  return other ? pairs.includes(sidePair(side, other)) : pairs.some(p => p.includes(side));
}

/** The rack the choices land on, or null while a step is open. */
export function chosenRack(racks: PickerRack[], c: PickerChoice): PickerRack | null {
  if (!c.line || !c.vehicle || !c.fit) return null;
  const pool = racksForFit(racks, c);
  if (c.line === 'ErgoRack') {
    if (!c.street || !c.curb) return null;
    const pair = sidePair(c.street, c.curb);
    return pool.find(r => r.bars === c.bars && r.pair === pair) || null;
  }
  if (!c.finish) return null;
  return pool.find(r => r.finish === c.finish) || null;
}

/** The rack's name on the estimate, with the ErgoRack sides for the installer. */
export function builtRackName(rack: PickerRack, c: Pick<PickerChoice, 'street' | 'curb'>): string {
  if (rack.line !== 'ErgoRack' || !c.street || !c.curb) return rack.kit.name;
  return `${rack.kit.name} (Street side: ${SIDE_LABEL[c.street]} · Curb side: ${SIDE_LABEL[c.curb]})`;
}

// ── AluRack add-ons ─────────────────────────────────────────────────────

export type ClampChoice = 'none' | 'street' | 'curb' | 'both';
export const ADDON_LABOR_HOURS = 0.5;

export interface RackAddon {
  item_number: string;
  label: string;
  /** Prime 2026 MAP price, used only when the item isn't in NetSuite yet. */
  fallback_price: number;
}

export const STREET_CLAMP: RackAddon = { item_number: 'ACX', label: 'AluRack Quick Clamp Option LH (street side)', fallback_price: 421.28 };
export const CURB_CLAMP: RackAddon = { item_number: 'AXC', label: 'AluRack Quick Clamp Option RH (curb side)', fallback_price: 421.28 };
export const TIE_DOWN: RackAddon = { item_number: 'ACC-8000', label: 'Retractable Ratchet Strap w/ Mount', fallback_price: 101.39 };
export const RACK_ADDONS = [STREET_CLAMP, CURB_CLAMP, TIE_DOWN];

export function addonPicks(clamp: ClampChoice, straps: number): { addon: RackAddon; quantity: number }[] {
  const out: { addon: RackAddon; quantity: number }[] = [];
  if (clamp === 'street' || clamp === 'both') out.push({ addon: STREET_CLAMP, quantity: 1 });
  if (clamp === 'curb' || clamp === 'both') out.push({ addon: CURB_CLAMP, quantity: 1 });
  const n = Math.max(0, Math.floor(straps || 0));
  if (n > 0) out.push({ addon: TIE_DOWN, quantity: n });
  return out;
}

export interface AddonPart {
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

/** The add-ons' NetSuite items, keyed by upper-case part number. */
export async function loadAddonParts(supabase: SupabaseClient): Promise<Map<string, AddonPart>> {
  const { data } = await supabase
    .from('netsuite_parts')
    .select('id, netsuite_id, item_number, display_name, description, sales_price, purchase_price, avg_install_cost, catalog')
    .in('item_number', RACK_ADDONS.map(a => a.item_number))
    .eq('is_active', true);
  const out = new Map<string, AddonPart>();
  for (const p of (data || []) as AddonPart[]) {
    const key = p.item_number.toUpperCase();
    if (!out.has(key)) out.set(key, p);
  }
  return out;
}

export const addonPrice = (addon: RackAddon, parts: Map<string, AddonPart>) => {
  const p = parts.get(addon.item_number.toUpperCase());
  return p && p.sales_price != null ? Number(p.sales_price) : addon.fallback_price;
};

export interface AddonLine {
  part_id: string | null;
  netsuite_item_id: string | null;
  item_number: string;
  description: string;
  quantity: number;
  unit_price: number;
  labor_hours: number;
  is_custom: boolean;
  catalog?: string;
  purchase_price?: number | null;
  avg_install_cost?: number | null;
}

/** Plain estimate lines for the add-ons, to go right under the rack. */
export function addonLines(picks: { addon: RackAddon; quantity: number }[], parts: Map<string, AddonPart>): AddonLine[] {
  return picks.map(({ addon, quantity }) => {
    const p = parts.get(addon.item_number.toUpperCase());
    if (p) {
      return {
        part_id: p.id,
        netsuite_item_id: p.netsuite_id,
        item_number: p.item_number,
        description: p.display_name || p.description || addon.label,
        quantity,
        unit_price: addonPrice(addon, parts),
        labor_hours: ADDON_LABOR_HOURS,
        is_custom: false,
        catalog: p.catalog || undefined,
        purchase_price: p.purchase_price ?? null,
        avg_install_cost: p.avg_install_cost ?? null,
      };
    }
    return {
      part_id: null,
      netsuite_item_id: null,
      item_number: addon.item_number,
      description: addon.label,
      quantity,
      unit_price: addon.fallback_price,
      labor_hours: ADDON_LABOR_HOURS,
      is_custom: true,
    };
  });
}
