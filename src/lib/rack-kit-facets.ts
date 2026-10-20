/**
 * Browse facets for rack kits (Craig 2026-10-20: "browse ladder rack kits
 * when making an estimate"). The Prime/Ranger kits (migration 333) carry no
 * vehicle or style columns, so these are read from the kit's part number and
 * name: ErgoRack numbers code the vehicle (FT = Ford Transit, PM = ProMaster,
 * SPX = Sprinter, GM = Express/Savana, PU1–PU3 = pickup cap, PU4 = open bed,
 * SWM / UM3 = mounting style for any vehicle) and the style (BB/BC/BR = Base,
 * CC/CR = Clamp, RR = Rotation, a 3 = three crossbars). AluRack names spell
 * the vehicle out. A kit's own vehicle_label, when someone sets one, wins.
 */

export type RackLine = 'AluRack' | 'ErgoRack' | 'Other';
export type RackFinish = 'Silver' | 'Black';
export type RackStyle = 'Base' | 'Clamp' | 'Rotation' | '3-crossbar' | 'Fixed';

export interface RackFacets {
  vehicle: string;
  line: RackLine;
  finish: RackFinish;
  style: RackStyle;
}

interface FacetInput {
  item_number: string | null;
  name: string;
  vehicle_label?: string | null;
}

/** Vehicle group for a rack kit, from its name and part number. */
export function rackVehicle(itemNumber: string, name: string): string {
  const t = name.toLowerCase();
  const c = `-${itemNumber.toUpperCase()}-`;
  if (t.includes('transit connect')) return 'Ford Transit Connect';
  if (t.includes('transit') || c.includes('-FT-')) return 'Ford Transit';
  if (t.includes('promaster city')) return 'Ram ProMaster City';
  if (t.includes('promaster') || c.includes('-PM-')) return 'Ram ProMaster';
  if (t.includes('sprinter') || /-SPX?-/.test(c)) return 'Mercedes Sprinter';
  if (t.includes('metris')) return 'Mercedes Metris';
  if (t.includes('nv200') || t.includes('city express')) return 'Nissan NV200';
  if (t.includes('savana') || (t.includes('express') && !t.includes('city express')) || t.includes('gm van') || c.includes('-GM-')) return 'Chevy Express / GMC Savana';
  if (/\bnv\b/.test(t) || t.includes('nissan nv')) return 'Nissan NV';
  if (t.includes('e van') || t.includes('e-series') || t.includes('econoline')) return 'Ford E-Series';
  if (t.includes('open bed') || c.includes('-PU4-')) return 'Pickup, open bed';
  if (t.includes('universal') && t.includes('mountings not included')) return 'Universal (no mounts)';
  if (t.includes('topper') || /\bcap\b/.test(t) || t.includes('fiberglass top') || /-PU\d-/.test(c)) return 'Pickup cap';
  if (t.includes('side wall') || c.includes('-SWM-')) return 'Side wall mount (any vehicle)';
  if (/\bum3\b/.test(t) || c.includes('-UM3-')) return 'UM3 mount (any vehicle)';
  if (t.includes('universal')) return 'Universal (no mounts)';
  return 'Other';
}

export function rackLine(itemNumber: string, name: string): RackLine {
  if (/^AR/i.test(itemNumber) || /alurack/i.test(name)) return 'AluRack';
  if (/-M$/i.test(itemNumber) || /ergorack/i.test(name)) return 'ErgoRack';
  return 'Other';
}

export function rackFinish(itemNumber: string, name: string): RackFinish {
  return /-BLK\b/i.test(itemNumber) || /\bblack\b/i.test(name) ? 'Black' : 'Silver';
}

export function rackStyle(itemNumber: string, line: RackLine): RackStyle {
  if (line !== 'ErgoRack') return 'Fixed';
  const prefix = itemNumber.toUpperCase().split('-')[0] || '';
  if (prefix.includes('3')) return '3-crossbar';
  if (prefix.startsWith('B')) return 'Base';
  if (prefix.startsWith('C')) return 'Clamp';
  if (prefix.startsWith('R')) return 'Rotation';
  return 'Fixed';
}

export function rackFacets(kit: FacetInput): RackFacets {
  const item = String(kit.item_number || '');
  const line = rackLine(item, kit.name);
  return {
    vehicle: kit.vehicle_label?.trim() || rackVehicle(item, kit.name),
    line,
    finish: rackFinish(item, kit.name),
    style: rackStyle(item, line),
  };
}

/**
 * Search box match: every word must appear somewhere in the part number,
 * name, vehicle, line or finish ("transit high roof", "ar19 black").
 */
export function rackMatchesSearch(kit: FacetInput, facets: RackFacets, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [kit.item_number, kit.name, facets.vehicle, facets.line, facets.finish, facets.style].join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}

/** Silver and black versions of one rack share a base part number. */
export const rackBaseNumber = (itemNumber: string) => itemNumber.toUpperCase().replace(/-BLK$/, '');
