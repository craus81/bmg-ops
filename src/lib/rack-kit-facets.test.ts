import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { rackBaseNumber, rackFacets, rackMatchesSearch } from './rack-kit-facets';

const kit = (item_number: string, name: string, vehicle_label: string | null = null) => ({ item_number, name, vehicle_label });

describe('rackFacets', () => {
  it('reads an AluRack Transit from its name', () => {
    expect(rackFacets(kit('AR1911', 'AluRack for Ford Transit 2015 with Long wheelbase 147.6 IN High Roof 110.1 IN L3H3')))
      .toEqual({ vehicle: 'Ford Transit', line: 'AluRack', finish: 'Silver', style: 'Fixed' });
  });

  it('reads black from the -BLK suffix', () => {
    expect(rackFacets(kit('AR1205-S-BLK', 'AluRack Aluminum Roof Rack Black, 6.5 FT Cap, 98 IN long with Roller')))
      .toMatchObject({ vehicle: 'Pickup cap', finish: 'Black' });
  });

  it('reads ErgoRack vehicle and style codes from the part number', () => {
    expect(rackFacets(kit('RR3-PU4-68-M', '[RR3-PU3-68-M] Rotation - Rotation 3 Crossbar Rack, Universal Pickup Cap, 8 FT Channel, 68 IN Crossbars')))
      .toEqual({ vehicle: 'Pickup, open bed', line: 'ErgoRack', finish: 'Silver', style: '3-crossbar' });
    expect(rackFacets(kit('CC-GM-68-M', 'Clamp - Clamp Rack, GMC Savana / Chevrolet Express, 68 IN Crossbars')))
      .toMatchObject({ vehicle: 'Chevy Express / GMC Savana', style: 'Clamp' });
    expect(rackFacets(kit('BR-SWM-90-M', 'Base - Rotation Rack, Side Wall Mounting Brackets, 90 IN Crossbars')))
      .toMatchObject({ vehicle: 'Side wall mount (any vehicle)', style: 'Base' });
    expect(rackFacets(kit('RR-UM3-68-M', 'Rotation - Rotation Rack, UM3 Mountings, 68 IN Crossbars')))
      .toMatchObject({ vehicle: 'UM3 mount (any vehicle)', style: 'Rotation' });
  });

  it('keeps NV200 apart from Express', () => {
    expect(rackFacets(kit('AR1221', 'AluRack Aluminum Roof Rack for Nissan NV200 2013 or City Express 2015 with Roller')).vehicle).toBe('Nissan NV200');
  });

  it('lets a kit vehicle label win', () => {
    expect(rackFacets(kit('AR1211', 'AluRack aluminum roof rack for 5-6 FT Pickup Topper', 'Ford Ranger cap')).vehicle).toBe('Ford Ranger cap');
  });

  it('gives every Prime kit in migration 333 a vehicle group', () => {
    const sql = readFileSync(join(__dirname, '../../migrations/333-prime-design-rack-kits.sql'), 'utf8').split('CREATE TEMP TABLE _prime_kit_items')[0];
    const rows = [...sql.matchAll(/^\s*\('([A-Z0-9-]+)', '((?:[^']|'')*)', '(?:[^']|'')*'\)/gm)];
    expect(rows.length).toBe(156);
    const other = rows.filter(r => rackFacets(kit(r[1], r[2].replace(/''/g, "'"))).vehicle === 'Other').map(r => r[1]);
    expect(other).toEqual([]);
  });
});

describe('rackMatchesSearch', () => {
  const k = kit('AR1911-BLK', 'AluRack for Ford Transit 2015 High Roof');
  const f = rackFacets(k);
  it('needs every word somewhere', () => {
    expect(rackMatchesSearch(k, f, 'transit high roof')).toBe(true);
    expect(rackMatchesSearch(k, f, 'ar19 black')).toBe(true);
    expect(rackMatchesSearch(k, f, 'sprinter')).toBe(false);
    expect(rackMatchesSearch(k, f, '  ')).toBe(true);
  });
});

describe('rackBaseNumber', () => {
  it('pairs silver and black', () => {
    expect(rackBaseNumber('AR1205-S-BLK')).toBe('AR1205-S');
    expect(rackBaseNumber('ar1205-s')).toBe('AR1205-S');
  });
});
