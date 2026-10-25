import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_HITCH_SETTINGS, adapterFor, curtSkuFromItemNumber, hitchKitLines, hitchKitName, hitchLabor, hitchOptionsFor,
  type CatalogPart, type HitchData, type HitchPart,
} from './hitch-kits';
import { kitComponentShowsPhoto, kitTaggedDescription, toKitDisplayLines } from './estimate-kits';

const part = (p: Partial<HitchPart> & Pick<HitchPart, 'sku' | 'role'>): HitchPart => ({
  name: `Part ${p.sku}`, list_price: 10, hitch_class: null, receiver: null, specs: {}, features: [], notes: [],
  image_url: null, needs_factory_wiring: false, tier: null, sort_order: 0, active: true, ...p,
});

const data: HitchData = {
  parts: [
    part({ sku: '13475', role: 'hitch', hitch_class: '3', list_price: 295.95 }),
    part({ sku: '14017', role: 'hitch', hitch_class: '4', list_price: 387.95 }),
    part({ sku: '56110', role: 'wiring', needs_factory_wiring: true, list_price: 30.95 }),
    part({ sku: '56465', role: 'wiring', list_price: 110.95 }),
    part({ sku: '55515', role: 'wiring', needs_factory_wiring: true, list_price: 22.95 }),
    part({ sku: '57672', role: 'adapter', list_price: 48.95 }),
    part({ sku: '55774', role: 'factory_adapter', needs_factory_wiring: true, list_price: 44.95 }),
    part({ sku: '51436', role: 'brake_harness', list_price: 14.95 }),
    part({ sku: '51110', role: 'brake_controller', tier: 'good', sort_order: 1, list_price: 85.95 }),
    part({ sku: '51180', role: 'brake_controller', tier: 'bluetooth', sort_order: 4, list_price: 319.95 }),
    part({ sku: '51146', role: 'brake_controller', tier: 'better', sort_order: 2, list_price: 156.95, active: false }),
  ],
  fitment: [
    { platform_key: 'f-150', sku: '14017', year_start: 2019, year_end: 2026 },
    { platform_key: 'f-150', sku: '13475', year_start: 2019, year_end: 2026 },
    { platform_key: 'f-150', sku: '56110', year_start: 2019, year_end: 2019 },
    { platform_key: 'f-150', sku: '56465', year_start: 2021, year_end: 2023 },
    { platform_key: 'f-150', sku: '55515', year_start: 2019, year_end: 2026 },
    { platform_key: 'f-150', sku: '51436', year_start: 2019, year_end: 2026 },
    { platform_key: 'transit', sku: '13193', year_start: 2019, year_end: 2026 },
  ],
  settings: DEFAULT_HITCH_SETTINGS,
};

describe('hitchOptionsFor', () => {
  it('offers only what fits the vehicle and model year, hitches by class', () => {
    const o = hitchOptionsFor(data, 'f-150', 2022, false);
    expect(o.hitches.map(h => h.sku)).toEqual(['13475', '14017']);
    expect(o.wiring.map(w => w.sku)).toEqual(['56465']);
    expect(o.brakeHarness?.sku).toBe('51436');
    expect(o.hasFactoryOption).toBe(true);
  });

  it('hides factory-plug wiring unless the vehicle has factory trailer wiring, then lists it first', () => {
    expect(hitchOptionsFor(data, 'f-150', 2019, false).wiring.map(w => w.sku)).toEqual([]);
    expect(hitchOptionsFor(data, 'f-150', 2019, true).wiring.map(w => w.sku)).toEqual(['55515', '56110']);
    expect(hitchOptionsFor(data, 'f-150', 2022, true).wiring.map(w => w.sku)).toEqual(['55515', '56465']);
  });

  it('offers the active brake controllers in good/better/best order', () => {
    expect(hitchOptionsFor(data, 'f-150', 2022, false).brakeControllers.map(b => b.sku)).toEqual(['51110', '51180']);
  });

  it('pairs the plug-in adapter with a factory socket and the bracket adapter with a harness', () => {
    const bySku = (s: string) => data.parts.find(p => p.sku === s)!;
    expect(adapterFor(data, bySku('56465'))?.sku).toBe('57672');
    expect(adapterFor(data, bySku('55515'))?.sku).toBe('55774');
    expect(adapterFor(data, null)).toBeNull();
  });
});

describe('curtSkuFromItemNumber', () => {
  it('reads the Curt number however NetSuite spells it', () => {
    expect(curtSkuFromItemNumber('13193')).toBe('13193');
    expect(curtSkuFromItemNumber('C13193')).toBe('13193');
    expect(curtSkuFromItemNumber('CURT-13193')).toBe('13193');
    expect(curtSkuFromItemNumber('AR1205-S')).toBeNull();
    expect(curtSkuFromItemNumber('')).toBeNull();
  });
});

describe('hitchKitLines', () => {
  const bySku = (s: string) => data.parts.find(p => p.sku === s)!;
  const choices = {
    platformLabel: 'Ford F-150', year: 2022,
    hitch: bySku('13475'), wiring: bySku('56465'), adapter: bySku('57672'),
    brakeController: bySku('51110'), brakeHarness: bySku('51436'),
  };
  const catalog = new Map<string, CatalogPart>([
    ['13475', { id: 'p1', netsuite_id: '901', item_number: 'C13475', display_name: 'Curt Class 3 hitch F-150', sales_price: 279.99, purchase_price: 190 }],
  ]);

  it('makes one kit group with labor on each part line', () => {
    const lines = hitchKitLines(choices, DEFAULT_HITCH_SETTINGS, catalog);
    expect(lines.map(l => l.item_number)).toEqual(['C13475', '56465', '57672', '51110', '51436']);
    expect(new Set(lines.map(l => l.kit_group_id)).size).toBe(1);
    expect(lines.every(l => l.kit_item_number === 'Hitch kit' && l.kit_quantity === 1)).toBe(true);
    expect(lines.map(l => l.labor_hours)).toEqual([1, 1, 0.75, 1, 0]);
    expect(hitchLabor(lines)).toBe(3.75);
    expect(lines[0].kit_name).toBe('Trailer hitch kit, 2022 Ford F-150, Class 3, 7-way + brake controller');
  });

  it('prices NetSuite items from NetSuite and flags the rest at Curt list', () => {
    const [hitch, wiring] = hitchKitLines(choices, DEFAULT_HITCH_SETTINGS, catalog);
    expect(hitch).toMatchObject({ part_id: 'p1', netsuite_item_id: '901', unit_price: 279.99, is_custom: false });
    expect(hitch.not_in_netsuite).toBeUndefined();
    expect(wiring).toMatchObject({ part_id: null, unit_price: 110.95, is_custom: true, not_in_netsuite: true });
  });

  it('skips the brake harness for the Bluetooth controller', () => {
    const lines = hitchKitLines({ ...choices, brakeController: bySku('51180') }, DEFAULT_HITCH_SETTINGS, catalog);
    expect(lines.map(l => l.item_number)).not.toContain('51436');
  });

  it('names a hitch-only kit without wiring or brake words', () => {
    expect(hitchKitName({ ...choices, wiring: null, adapter: null, brakeController: null })).toBe('Trailer hitch kit, 2022 Ford F-150, Class 3');
    expect(hitchKitName({ ...choices, adapter: null, brakeController: null })).toBe('Trailer hitch kit, 2022 Ford F-150, Class 3, 4-way');
  });

  it('shows as one priced kit line with photo-carrying parts beneath it', () => {
    const lines = hitchKitLines(choices, DEFAULT_HITCH_SETTINGS, catalog).map((l, i) => ({ ...l, id: `l${i}` }));
    const shown = toKitDisplayLines(lines);
    expect(shown[0].kit_header).toBe(true);
    expect(shown[0].item_number).toBe('Hitch kit');
    expect((shown[0] as any).line_total).toBe(Math.round((279.99 + 110.95 + 48.95 + 85.95 + 14.95) * 100) / 100);
    expect(shown.slice(1).every(l => kitComponentShowsPhoto(l))).toBe(true);
    expect(kitComponentShowsPhoto({ kit_component: true, kit_item_number: 'AR1205-S' })).toBe(false);
    expect(kitTaggedDescription('Hitch', lines[0])).toBe('Hitch [Hitch kit]');
  });
});

describe('migration 433 data', () => {
  const sql = readFileSync(join(__dirname, '../../migrations/433-hitch-kits.sql'), 'utf8');
  it('offers exactly four brake controllers: good, better, best, Bluetooth', () => {
    const tiers = [...sql.matchAll(/'brake_controller'.*?'(good|better|best|bluetooth)', \d+\)/g)].map(m => m[1]);
    expect(tiers).toEqual(['good', 'better', 'best', 'bluetooth']);
  });
  it('seeds both adapters with brackets', () => {
    expect(sql).toMatch(/\('57672', 'adapter'/);
    expect(sql).toMatch(/\('55774', 'factory_adapter'/);
  });
  it('only fits parts it seeds', () => {
    const seeded = new Set([...sql.matchAll(/^ {2}\('(\d+)', '(?:hitch|wiring|adapter|factory_adapter|brake_controller|brake_harness)'/gm)].map(m => m[1]));
    const fitted = [...sql.matchAll(/^ {2}\('[a-z0-9-]+', '(\d+)', \d{4}, \d{4}\)/gm)].map(m => m[1]);
    expect(fitted.length).toBeGreaterThan(50);
    expect(fitted.filter(s => !seeded.has(s))).toEqual([]);
  });
});
