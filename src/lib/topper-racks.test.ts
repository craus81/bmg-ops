import { describe, expect, it } from 'vitest';
import type { AddonPart, EstimateRackVehicle } from './rack-picker';
import { TOPPER_ADDON_LABOR_HOURS, TOPPER_RACKS, topperAddonsFor, topperFits, topperLines, topperVehicles } from './topper-racks';

const van = (platformKey: string, year: string, wheelbase = '', roof = ''): EstimateRackVehicle =>
  ({ platformKey, bodyType: 'van', year, label: 'x', wheelbase, roof, bed: '' });
const rack = (n: string) => TOPPER_RACKS.find(r => r.item_number === n)!;

describe('topper racks', () => {
  it('covers the platform vans, standard racks only', () => {
    expect(topperVehicles()).toEqual([
      'Chevy Express / GMC Savana', 'Ford Transit', 'Ford Transit Connect', 'Mercedes Metris',
      'Mercedes Sprinter', 'Nissan NV200', 'Ram ProMaster', 'Ram ProMaster City',
    ]);
    expect(TOPPER_RACKS.some(r => r.item_number.startsWith('4'))).toBe(false);
  });

  it('picks the right Transit rack by year, wheelbase and roof (Topper Transit page)', () => {
    expect(topperFits('Ford Transit', van('transit', '2024', '130', 'high'))).toEqual(['258120']);
    expect(topperFits('Ford Transit', van('transit', '2026', '130', 'medium'))).toEqual(['258120']);
    expect(topperFits('Ford Transit', van('transit', '2024', '148', 'high'))).toEqual(['258144']);
    expect(topperFits('Ford Transit', van('transit', '2026', '148', 'low'))).toEqual(['258144']);
    expect(topperFits('Ford Transit', van('transit', '2026', '148', 'high'))).toEqual(['265848']);
    expect(topperFits('Ford Transit', van('transit', '2023', '148 EL', 'high'))).toEqual(['258170']);
    expect(topperFits('Ford Transit', van('transit', '2027', '148 EL', 'high'))).toEqual(['265848EX']);
    // No year: both 148 racks stay on offer.
    expect(topperFits('Ford Transit', van('transit', '', '148', 'high')).sort()).toEqual(['258144', '265848']);
  });

  it('picks other vans by wheelbase / roof / year', () => {
    expect(topperFits('Ram ProMaster', van('promaster', '2024', '159 EXT', 'high'))).toEqual(['360159']);
    expect(topperFits('Mercedes Sprinter', van('sprinter', '2022', '170 EXT', 'high'))).toEqual(['356170']);
    expect(topperFits('Mercedes Sprinter', van('sprinter', '2022', '144', 'standard'))).toEqual(['363144']);
    expect(topperFits('Ford Transit Connect', van('transit-connect', '2012'))).toEqual(['253504']);
    expect(topperFits('Chevy Express / GMC Savana', van('express-savana', '2020', '155'))).toEqual(['256506']);
  });

  it('offers the vehicle heavy duty kit and the matching catwalk', () => {
    const items = topperAddonsFor(rack('258144')).map(a => a.item_number);
    expect(items).toContain('312113');
    expect(items).toContain('KDCW12');
    expect(items).not.toContain('KDCW10');
    expect(items).not.toContain('702003');
    expect(topperAddonsFor(rack('358110')).find(a => a.item_number === 'TMC110')?.defaultOn).toBe(true);
  });

  it('builds lines: rack first with NetSuite price and labor, add-ons at 0.5 hr', () => {
    const parts = new Map<string, AddonPart>([
      ['258144', { id: 'p1', netsuite_id: '11', item_number: '258144', display_name: 'Topper 12 ft Transit', sales_price: 800, labor_hours: 2 }],
      ['1CB001', { id: 'p2', netsuite_id: '12', item_number: '1CB001', sales_price: 40 }],
    ]);
    const lines = topperLines(rack('258144'), { '1CB001': 2, KDCW12: 1, KDCW10: 1 }, parts);
    expect(lines.map(l => l.item_number)).toEqual(['258144', '1CB001', 'KDCW12']);
    expect(lines[0]).toMatchObject({ unit_price: 800, labor_hours: 2, is_custom: false, part_id: 'p1' });
    expect(lines[1]).toMatchObject({ quantity: 2, unit_price: 40, labor_hours: TOPPER_ADDON_LABOR_HOURS });
    expect(lines[2]).toMatchObject({ is_custom: true, labor_hours: TOPPER_ADDON_LABOR_HOURS });
  });

  it('falls back to the Topper list price when NetSuite lacks the rack', () => {
    const [line] = topperLines(rack('258120'), {}, new Map());
    expect(line).toMatchObject({ is_custom: true, unit_price: 720.10, labor_hours: null });
  });
});
