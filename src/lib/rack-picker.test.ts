import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { KitWithMembers } from './part-kits';
import {
  addonLines, addonPicks, aluRackFit, builtRackName, chosenRack, EMPTY_CHOICE, fitsFor, pairsFor, pickerRacks,
  sideOffered, sidePair, vehiclesFor, estimateFits, noKitNote, rackVehicleFor, type AddonPart, type PickerChoice,
} from './rack-picker';

// The real Prime/Ranger kits, read from the migration that loads them.
const sql = readFileSync(join(__dirname, '../../migrations/333-prime-design-rack-kits.sql'), 'utf8');
const kitBlock = sql.split('INSERT INTO _prime_kits VALUES')[1].split(';\n')[0];
const primeKits: KitWithMembers[] = [...kitBlock.matchAll(/\('((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)'\)/g)]
  .map(([, item, name, short], i) => ({
    id: `k${i}`, name: name.replace(/''/g, "'"), description: short, vehicle_label: null, image_path: null,
    item_number: item, vendor: 'Ranger Design', labor_adder_hours: 0, members: [], missing: [], totalPrice: 0, totalLabor: 0,
  }));
const racks = pickerRacks(primeKits);
const choose = (c: Partial<PickerChoice>) => ({ ...EMPTY_CHOICE, ...c });

describe('pickerRacks', () => {
  it('offers every Prime kit', () => {
    expect(primeKits).toHaveLength(156);
    expect(racks).toHaveLength(156);
  });

  it('reads ErgoRack part numbers', () => {
    const r = racks.find(x => x.kit.item_number === 'RR3-UM3-99-M')!;
    expect(r).toMatchObject({ line: 'ErgoRack', bars: 3, pair: 'RR', fit: 'UM3-99', fitSub: '99 in crossbars' });
    const t = racks.find(x => x.kit.item_number === 'BR-FT-72-M')!;
    expect(t).toMatchObject({ vehicle: 'Ford Transit', fitLabel: 'Medium / high roof', bars: 2, pair: 'BR' });
  });

  it('groups AluRack silver and black under one fit', () => {
    const fits = fitsFor(racks, 'AluRack', 'Ford Transit');
    expect(fits.map(f => f.fitLabel)).toContain('L3H2');
    expect(fits.every(f => !f.fit.endsWith('-BLK'))).toBe(true);
  });

  it('labels AluRack fits without a roof code', () => {
    expect(aluRackFit('ALURACK 6.5 FT CHANNEL MOUNT - MOD', 'AluRack Aluminum Roof Rack, 6.5 FT Cap, 98 IN long with Roller').label).toBe('6.5 ft channel mount');
    expect(aluRackFit('ALURACK GM VAN - MOD', 'AluRack Aluminum Roof Rack for GM Van with Roller').label).toBe('Standard');
  });

  it('lists vehicles per line', () => {
    expect(vehiclesFor(racks, 'ErgoRack')).toContain('Mercedes Sprinter');
    expect(vehiclesFor(racks, 'AluRack')).toContain('Ram ProMaster');
  });
});

describe('ErgoRack sides', () => {
  it('pairs are order-free', () => {
    expect(sidePair('R', 'B')).toBe('BR');
    expect(sidePair('C', 'R')).toBe('CR');
  });

  it('lands on the kit for street / curb in either order', () => {
    const base = { line: 'ErgoRack' as const, vehicle: 'Ford Transit', fit: 'FT-72' };
    expect(chosenRack(racks, choose({ ...base, street: 'R', curb: 'B' }))?.kit.item_number).toBe('BR-FT-72-M');
    expect(chosenRack(racks, choose({ ...base, street: 'B', curb: 'R' }))?.kit.item_number).toBe('BR-FT-72-M');
    expect(chosenRack(racks, choose({ ...base, bars: 3, street: 'R', curb: 'R' }))?.kit.item_number).toBe('RR3-FT-72-M');
  });

  it('greys out combinations Prime has no kit for', () => {
    const c = choose({ line: 'ErgoRack', vehicle: 'Mercedes Sprinter', fit: 'SP-72' });
    const pairs = pairsFor(racks, c);
    expect(pairs.sort()).toEqual(['BB', 'BR', 'RR']);
    expect(sideOffered(pairs, 'C', null)).toBe(false);
    expect(sideOffered(pairs, 'B', 'R')).toBe(true);
    expect(chosenRack(racks, { ...c, street: 'C', curb: 'R' })).toBeNull();
  });

  it('puts the sides in the rack name', () => {
    const r = chosenRack(racks, choose({ line: 'ErgoRack', vehicle: 'Ford Transit', fit: 'FT-72', street: 'R', curb: 'B' }))!;
    expect(builtRackName(r, { street: 'R', curb: 'B' })).toMatch(/\(Street side: Rotation · Curb side: Base\)$/);
  });
});

describe('AluRack', () => {
  it('needs a finish', () => {
    const c = choose({ line: 'AluRack', vehicle: 'Ford Transit', fit: 'AR1912' });
    expect(chosenRack(racks, c)).toBeNull();
    expect(chosenRack(racks, { ...c, finish: 'Black' })?.kit.item_number).toBe('AR1912-BLK');
    expect(builtRackName(chosenRack(racks, { ...c, finish: 'Silver' })!, { street: null, curb: null })).not.toContain('Street');
  });

  it('adds clamps and straps as their own lines, 0.5 hr each', () => {
    const parts = new Map<string, AddonPart>([['ACX', { id: 'p1', netsuite_id: '11', item_number: 'ACX', display_name: 'Quick Clamp LH', sales_price: 450 }]]);
    const lines = addonLines(addonPicks('both', 3), parts);
    expect(lines.map(l => [l.item_number, l.quantity, l.labor_hours, l.unit_price, l.is_custom])).toEqual([
      ['ACX', 1, 0.5, 450, false],
      ['AXC', 1, 0.5, 421.28, true],
      ['ACC-8000', 3, 0.5, 101.39, true],
    ]);
    expect(lines.every(l => !('kit_group_id' in l))).toBe(true);
    expect(addonPicks('none', 0)).toEqual([]);
    expect(addonPicks('curb', -2).map(p => p.addon.item_number)).toEqual(['AXC']);
  });
});

describe('estimate vehicle', () => {
  const van = (platformKey: string, wheelbase = '', roof = '') =>
    ({ platformKey, bodyType: 'van' as const, year: '', label: 'x', wheelbase, roof, bed: '' });
  const truck = (bed: string) => ({ platformKey: 'f-150', bodyType: 'truck' as const, year: '', label: 'x', wheelbase: '', roof: '', bed });
  const labels = (line: 'ErgoRack' | 'AluRack', vehicle: string, v: Parameters<typeof estimateFits>[3]) =>
    estimateFits(racks, line, vehicle, v).map(f => fitsFor(racks, line, vehicle).find(x => x.fit === f)!.fitLabel);

  it('maps vans to the picker vehicle and pickups to none', () => {
    expect(rackVehicleFor(van('transit'))).toBe('Ford Transit');
    expect(rackVehicleFor(van('express-savana'))).toBe('Chevy Express / GMC Savana');
    expect(rackVehicleFor(truck('6.5'))).toBeNull();
    expect(vehiclesFor(racks, 'AluRack')).toContain('Ford Transit');
  });

  it('lands an AluRack Transit on its L#H#', () => {
    expect(labels('AluRack', 'Ford Transit', van('transit', '148', 'high'))).toEqual(['L3H3']);
    expect(labels('AluRack', 'Ford Transit', van('transit', '130', 'low'))).toEqual(['L2H1']);
    expect(labels('AluRack', 'Ford Transit', van('transit', '', 'high')).sort()).toEqual(['L3H3', 'L4H3']);
    expect(labels('AluRack', 'Ram ProMaster', van('promaster', '159 EXT', 'high'))).toEqual(['L5H2']);
    expect(labels('AluRack', 'Mercedes Sprinter', van('sprinter', '170', 'high'))).toEqual(['L3H2 / L4H2']);
    expect(estimateFits(racks, 'AluRack', 'Ford Transit', van('transit'))).toEqual([]);
  });

  it('lands an ErgoRack Transit by roof, and leaves a Sprinter to ask', () => {
    expect(labels('ErgoRack', 'Ford Transit', van('transit', '148', 'low'))).toEqual(['Low roof']);
    expect(labels('ErgoRack', 'Ford Transit', van('transit', '148', 'medium'))).toEqual(['Medium / high roof']);
    expect(estimateFits(racks, 'ErgoRack', 'Mercedes Sprinter', van('sprinter', '144', 'high'))).toEqual([]);
    expect(noKitNote(racks, 'ErgoRack', 'Mercedes Sprinter', van('sprinter', '144', 'high'))).toBe('');
  });

  it('matches a pickup cap by bed length', () => {
    expect(new Set(labels('ErgoRack', 'Pickup cap', truck('6.5')))).toEqual(new Set(['6 ft bed'])); // 62 and 68 in crossbars
    expect(new Set(labels('ErgoRack', 'Pickup cap', truck('8')))).toEqual(new Set(['8 ft bed']));
    expect(estimateFits(racks, 'AluRack', 'Pickup cap', truck('6.5')).sort()).toEqual(['AR1205-S', 'AR1213']);
    expect(estimateFits(racks, 'AluRack', 'Pickup cap', truck('4.5'))).toEqual(['AR1215']);
  });

  it('says so in red when there is no kit', () => {
    expect(noKitNote(racks, 'ErgoRack', null, van('metris'))).toMatch(/No ErgoRack kit for a Mercedes Metris/);
    expect(noKitNote(racks, 'ErgoRack', 'Ram ProMaster', van('promaster', '136', 'low'))).toMatch(/No ErgoRack kit for the estimate's Ram ProMaster/);
    expect(noKitNote(racks, 'ErgoRack', 'Ram ProMaster', van('promaster', '136', 'high'))).toBe('');
    expect(noKitNote(racks, 'AluRack', 'Ford Transit', van('transit', '148', 'high'))).toBe('');
  });
});
