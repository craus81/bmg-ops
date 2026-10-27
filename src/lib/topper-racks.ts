/**
 * Topper Manufacturing van racks (Craig 2026-10-27), the third line in the
 * estimate's "Build a rack" picker beside ErgoRack and AluRack. Each Topper
 * rack is one galvanized steel part number, not a kit, so the picker goes
 * vehicle → rack → add-ons. Craig's calls:
 *  - every rack for the vans we have platforms for, standard (not
 *    knock-down) only; source is Topper's 2026 catalog and the Transit page
 *    https://www.toppermfg.com/products/van-racks/find-your-van-rack-part-number/transit/
 *    (2026+ Transits with a 148 wheelbase take different racks).
 *  - prices come from NetSuite, where the parts already are. List prices
 *    from the Transit price sheet only stand in if an item can't be found.
 *  - every add-on is offered, 0.5 hr labor each, own line under the rack.
 *    The rack's own labor is its NetSuite labor hours, like any part.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import type { AddonLine, AddonPart, EstimateRackVehicle } from './rack-picker';

export const TOPPER_ADDON_LABOR_HOURS = 0.5;

export interface TopperRack {
  item_number: string;
  /** The picker's vehicle group (same names as the ErgoRack / AluRack kits). */
  vehicle: string;
  label: string;
  sub: string;
  /** Rack length in feet, which picks the catwalk. */
  feet: number;
  /** Model years it fits, inclusive; null = open. */
  yearFrom?: number;
  yearTo?: number;
  /** vehicle_platforms config values it fits; empty/absent = any. */
  wheelbases?: string[];
  roofs?: string[];
  description: string;
  /** Topper list price (Transit price sheet), only used if NetSuite lacks the item. */
  list_price?: number;
}

const T = 'Ford Transit';
export const TOPPER_RACKS: TopperRack[] = [
  { item_number: '258120', vehicle: T, feet: 10, label: '10 ft · 130 wheelbase', sub: '2015 & newer, all roofs', yearFrom: 2015, wheelbases: ['130'],
    description: "Topper 10' Van Rack w/58\" Crossbars - 2015 & newer Ford Transit 130 WB", list_price: 720.10 },
  { item_number: '258144', vehicle: T, feet: 12, label: '12 ft · 148 wheelbase', sub: '2015–2025 all roofs, 2026+ low roof only', yearFrom: 2015, wheelbases: ['148'],
    description: "Topper 12' Van Rack w/58\" Crossbars - 2015-2025 Ford Transit 148 WB STD (2026+ low roof)", list_price: 778.05 },
  { item_number: '258170', vehicle: T, feet: 14, label: '14 ft · 148 EL wheelbase', sub: '2015–2025 only', yearFrom: 2015, yearTo: 2025, wheelbases: ['148 EL'],
    description: "Topper 14' Van Rack w/58\" Crossbars - 2015-2025 Ford Transit 148 WB Ext.", list_price: 954.42 },
  { item_number: '265848', vehicle: T, feet: 12, label: '12 ft · 148 wheelbase', sub: '2026 & newer, medium or high roof', yearFrom: 2026, wheelbases: ['148'], roofs: ['medium', 'high'],
    description: "Topper 12' Van Rack w/58\" Crossbars - 2026 & newer Ford Transit 148 WB, medium/high roof", list_price: 778.05 },
  { item_number: '265848EX', vehicle: T, feet: 14, label: '14 ft · 148 EL wheelbase', sub: '2026 & newer, high roof', yearFrom: 2026, wheelbases: ['148 EL'], roofs: ['high'],
    description: "Topper 14' Van Rack w/58\" Crossbars - 2026 & newer Ford Transit 148 WB Ext., high roof", list_price: 954.42 },

  { item_number: '253501', vehicle: 'Ford Transit Connect', feet: 8, label: '8 ft', sub: '2014 & newer', yearFrom: 2014,
    description: "Topper 8' Van Rack w/53\" Crossbars - 2014 & newer Ford Transit Connect" },
  { item_number: '253504', vehicle: 'Ford Transit Connect', feet: 8, label: '8 ft', sub: '2013 & earlier', yearTo: 2013,
    description: "Topper 8' Van Rack w/53\" Crossbars - 2013 & earlier Ford Transit Connect" },

  { item_number: '256500', vehicle: 'Chevy Express / GMC Savana', feet: 12, label: '12 ft · standard', sub: '135 wheelbase', wheelbases: ['135'],
    description: "Topper 12' Van Rack w/58\" Crossbars - '96 & newer GMC Savana / Chevy Express" },
  { item_number: '256506', vehicle: 'Chevy Express / GMC Savana', feet: 14, label: '14 ft · extended', sub: '155 wheelbase', wheelbases: ['155'],
    description: "Topper 14' Van Rack w/58\" Crossbars - '96 & newer GMC Savana / Chevy Express Ext." },

  { item_number: '360118', vehicle: 'Ram ProMaster', feet: 10, label: '10 ft · 118 wheelbase', sub: '', wheelbases: ['118'],
    description: "Topper 10' Van Rack w/60\" Crossbars - ProMaster 118 WB" },
  { item_number: '360136', vehicle: 'Ram ProMaster', feet: 12, label: '12 ft · 136 wheelbase', sub: '', wheelbases: ['136'],
    description: "Topper 12' Van Rack w/60\" Crossbars - ProMaster 136 WB" },
  { item_number: '360159', vehicle: 'Ram ProMaster', feet: 14, label: '14 ft · 159 wheelbase', sub: '159 standard and extended', wheelbases: ['159', '159 EXT'],
    description: "Topper 14' Maxi Van Rack w/60\" Crossbars - ProMaster 159 WB Std. & Ext." },
  { item_number: '353096', vehicle: 'Ram ProMaster City', feet: 8, label: '8 ft', sub: '',
    description: "Topper 8' Van Rack w/53\" Crossbars - ProMaster City" },

  { item_number: '363144', vehicle: 'Mercedes Sprinter', feet: 12, label: '12 ft · 144 low roof', sub: '2007 & newer', yearFrom: 2007, wheelbases: ['144'], roofs: ['standard'],
    description: "Topper 12' Van Rack w/63\" Crossbars - '07 & newer Sprinter low roof 144 WB" },
  { item_number: '356144', vehicle: 'Mercedes Sprinter', feet: 12, label: '12 ft · 144 high roof', sub: '2007 & newer', yearFrom: 2007, wheelbases: ['144'], roofs: ['high'],
    description: "Topper 12' Van Rack w/58\" Crossbars - '07 & newer Sprinter high roof 144 WB" },
  { item_number: '363170', vehicle: 'Mercedes Sprinter', feet: 14, label: '14 ft · 170 low roof', sub: '2007 & newer', yearFrom: 2007, wheelbases: ['170', '170 EXT'], roofs: ['standard'],
    description: "Topper 14' Maxi Van Rack w/63\" Crossbars - '07 & newer Sprinter low roof ext. 170 WB" },
  { item_number: '356170', vehicle: 'Mercedes Sprinter', feet: 14, label: '14 ft · 170 high roof', sub: '2007 & newer', yearFrom: 2007, wheelbases: ['170', '170 EXT'], roofs: ['high'],
    description: "Topper 14' Maxi Van Rack w/58\" Crossbars - '07 & newer Sprinter high roof ext. 170 WB" },

  { item_number: '253500', vehicle: 'Nissan NV200', feet: 8, label: '8 ft', sub: 'NV200 and Chevy City Express',
    description: "Topper 8' Van Rack w/53\" Crossbars - Nissan NV200 / Chevy City Express" },
  { item_number: '358110', vehicle: 'Mercedes Metris', feet: 10, label: '10 ft', sub: 'Cargo van',
    description: "Topper 10' Van Rack w/58\" Crossbars - Mercedes Metris Cargo Van" },
];

export interface TopperAddon {
  item_number: string;
  label: string;
  /** 'count' takes a quantity; 'check' is on or off. */
  kind: 'count' | 'check';
  /** Only offered for these vehicles; absent = every Topper rack. */
  vehicles?: string[];
  /** Only for a rack this long (catwalks). */
  feet?: number;
  /** Ticked when the picker opens (Metris mounting channel). */
  defaultOn?: boolean;
  list_price?: number;
}

export const TOPPER_ADDONS: TopperAddon[] = [
  { item_number: '312113', label: 'Heavy Duty Kit - Ford Transit', kind: 'check', vehicles: [T], list_price: 55.26 },
  { item_number: '202003', label: 'Heavy Duty Kit - vans with rain gutters', kind: 'check', vehicles: ['Chevy Express / GMC Savana'] },
  { item_number: '702003', label: 'Heavy Duty Kit - ProMaster', kind: 'check', vehicles: ['Ram ProMaster'] },
  { item_number: '302003', label: 'Heavy Duty Kit - Sprinter high/low roof', kind: 'check', vehicles: ['Mercedes Sprinter'] },
  { item_number: 'TMC110', label: 'Topper Mounting Channel - Mercedes Metris', kind: 'check', vehicles: ['Mercedes Metris'], defaultOn: true },
  { item_number: '202999', label: 'Conduit Carrier (pair)', kind: 'count' },
  { item_number: '202991', label: 'Center Support - Conduit Carrier', kind: 'count' },
  { item_number: '202992', label: 'Conduit Carrier L Bracket Pair for 6" PVC (pipe not included)', kind: 'count' },
  { item_number: '1CB001', label: 'Topper Ratcheting Rack Strap - Square Mount', kind: 'count' },
  { item_number: '201040', label: 'Wind Deflector', kind: 'check' },
  { item_number: 'KDCW10', label: "Knock-Down Catwalk for 10' Van Rack", kind: 'check', feet: 10 },
  { item_number: 'KDCW12', label: "Knock-Down Catwalk for 12' Van Rack", kind: 'check', feet: 12 },
  { item_number: 'KDCW14', label: "Knock-Down Catwalk for 14' Van Rack", kind: 'check', feet: 14 },
];

export const topperVehicles = () => [...new Set(TOPPER_RACKS.map(r => r.vehicle))].sort();
export const topperRacksFor = (vehicle: string | null) => TOPPER_RACKS.filter(r => r.vehicle === vehicle);

/** Add-ons that go with this rack. */
export const topperAddonsFor = (rack: TopperRack | null) =>
  rack ? TOPPER_ADDONS.filter(a => (!a.vehicles || a.vehicles.includes(rack.vehicle)) && (a.feet == null || a.feet === rack.feet)) : [];

const yearOf = (v: EstimateRackVehicle | null | undefined) => {
  const y = parseInt(v?.year || '', 10);
  return y >= 1990 && y <= 2100 ? y : null;
};

/**
 * The racks that fit the estimate's vehicle, using whatever the estimate
 * knows (year, wheelbase, roof). Unknown facts don't rule a rack out, so a
 * Transit 148 with no year offers both the 2015–2025 and 2026+ racks.
 */
export function topperFits(vehicle: string | null, v: EstimateRackVehicle | null | undefined): string[] {
  const racks = topperRacksFor(vehicle);
  if (!v || !vehicle) return [];
  const year = yearOf(v);
  const roof = (v.roof || '').toLowerCase();
  return racks.filter(r => {
    if (year && ((r.yearFrom && year < r.yearFrom) || (r.yearTo && year > r.yearTo))) return false;
    if (v.wheelbase && r.wheelbases?.length && !r.wheelbases.includes(v.wheelbase)) return false;
    if (roof && r.roofs?.length && !r.roofs.includes(roof)) return false;
    // 2026+ Transit 148 STD: the 258144 is low roof only.
    if (r.item_number === '258144' && year && year >= 2026 && roof && roof !== 'low') return false;
    return true;
  }).map(r => r.item_number);
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Topper items in NetSuite, keyed by Topper part number. Matches the bare
 * number first, then any Topper-vendor item whose number ends in it (in
 * case NetSuite carries a prefix such as "TOP-258120").
 */
export async function loadTopperParts(supabase: SupabaseClient): Promise<Map<string, AddonPart>> {
  const numbers = [...TOPPER_RACKS.map(r => r.item_number), ...TOPPER_ADDONS.map(a => a.item_number)];
  const cols = 'id, netsuite_id, item_number, display_name, description, sales_price, purchase_price, avg_install_cost, catalog, labor_hours';
  const [exact, vendor] = await Promise.all([
    supabase.from('netsuite_parts').select(cols).in('item_number', numbers).eq('is_active', true),
    fetchAllRows<AddonPart>((from, to) => supabase.from('netsuite_parts').select(cols)
      .ilike('vendor', '%topper%').eq('is_active', true).order('item_number').order('id').range(from, to) as never),
  ]);
  const out = new Map<string, AddonPart>();
  for (const p of (exact.data || []) as AddonPart[]) if (!out.has(norm(p.item_number))) out.set(norm(p.item_number), p);
  for (const n of numbers.map(norm)) {
    if (out.has(n)) continue;
    const hit = (vendor.data || []).find(p => norm(p.item_number).endsWith(n));
    if (hit) out.set(n, hit);
  }
  return out;
}

const lineFor = (item_number: string, fallbackText: string, quantity: number, labor: number | null, parts: Map<string, AddonPart>, listPrice?: number): AddonLine => {
  const p = parts.get(norm(item_number));
  if (p) {
    return {
      part_id: p.id, netsuite_item_id: p.netsuite_id, item_number: p.item_number,
      description: p.display_name || p.description || fallbackText, quantity,
      unit_price: p.sales_price != null ? Number(p.sales_price) : listPrice ?? 0,
      labor_hours: labor ?? (p.labor_hours != null ? Number(p.labor_hours) : null),
      is_custom: false, catalog: p.catalog || undefined,
      purchase_price: p.purchase_price ?? null, avg_install_cost: p.avg_install_cost ?? null,
    };
  }
  return {
    part_id: null, netsuite_item_id: null, item_number, description: fallbackText, quantity,
    unit_price: listPrice ?? 0, labor_hours: labor, is_custom: true,
  };
};

export const topperPrice = (item_number: string, parts: Map<string, AddonPart>, listPrice?: number) => {
  const p = parts.get(norm(item_number));
  return p && p.sales_price != null ? Number(p.sales_price) : listPrice ?? null;
};
export const topperInNetSuite = (item_number: string, parts: Map<string, AddonPart>) => parts.has(norm(item_number));

/** The rack and its add-ons as estimate lines, rack first. */
export function topperLines(rack: TopperRack, picks: Record<string, number>, parts: Map<string, AddonPart>): AddonLine[] {
  const out = [lineFor(rack.item_number, rack.description, 1, null, parts, rack.list_price)];
  for (const a of topperAddonsFor(rack)) {
    const qty = Math.max(0, Math.floor(picks[a.item_number] || 0));
    if (qty > 0) out.push(lineFor(a.item_number, `Topper ${a.label}`, qty, TOPPER_ADDON_LABOR_HOURS, parts, a.list_price));
  }
  return out;
}
