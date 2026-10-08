import { describe, it, expect } from 'vitest';
import { gatherKitGroups, kitLineColumns, kitTaggedDescription, toKitDisplayLines } from './estimate-kits';
import { kitBuildable, kitEstimateLines, type KitWithMembers } from './part-kits';
import { renderEstimateDocument } from './estimate-document';
import { publicLines } from './estimate-approval-view';

const G = '11111111-1111-4111-8111-111111111111';
const kitFields = { kit_group_id: G, kit_id: null, kit_item_number: 'AR1205-S', kit_name: 'AluRack 6.5 FT Cap', kit_quantity: 2 };

const lines = [
  { id: 'a', item_number: 'BOLT', description: 'Bolt', quantity: 4, unit_price: 1, line_total: 4 },
  { id: 'b', item_number: 'FBM-1026-BLK', description: 'Base mount', quantity: 2, unit_price: 100, line_total: 200, ...kitFields },
  { id: 'c', item_number: 'AR-2000', description: 'Crossbar module', quantity: 2, unit_price: 300, line_total: 600, ...kitFields },
];

describe('toKitDisplayLines', () => {
  it('puts one priced rack line above its components, which carry no money', () => {
    const out = toKitDisplayLines(lines);
    expect(out.map(l => l.item_number)).toEqual(['BOLT', 'AR1205-S', 'FBM-1026-BLK', 'AR-2000']);
    const header = out[1];
    expect(header.kit_header).toBe(true);
    expect(header.quantity).toBe(2);
    expect(header.line_total).toBe(800);
    expect(header.unit_price).toBe(400);
    expect(out[2]).toMatchObject({ kit_component: true, quantity: 2, unit_price: 0, line_total: 0 });
  });

  it('keeps the displayed total equal to the stored lines', () => {
    const sum = (ls: any[]) => ls.reduce((s, l) => s + Number(l.line_total), 0);
    expect(sum(toKitDisplayLines(lines))).toBe(sum(lines));
  });

  it('leaves estimates without kits untouched', () => {
    const plain = [lines[0]];
    expect(toKitDisplayLines(plain)).toEqual(plain);
  });
});

describe('gatherKitGroups', () => {
  it('pulls a separated component back under its kit', () => {
    const out = gatherKitGroups([lines[1], lines[0], lines[2]]);
    expect(out.map(l => l.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('customer surfaces', () => {
  it('the emailed/signed document prices the rack, not its parts', () => {
    const html = renderEstimateDocument({ estimate_number: 'E1', subtotal: 804, grand_total: 804 }, lines);
    expect(html).toContain('AR1205-S');
    expect(html).toContain('$800.00');
    expect(html).toContain('$400.00');
    expect(html).not.toContain('$300.00');
    expect(html).not.toContain('$600.00');
    expect(html).toContain('FBM-1026-BLK');
  });

  it('the approval page gets the rack line and flagged components', () => {
    const pub = publicLines(lines);
    expect(pub.map(l => [l.item_number, l.kit_header, l.kit_component])).toEqual([
      ['BOLT', false, false],
      ['AR1205-S', true, false],
      ['FBM-1026-BLK', false, true],
      ['AR-2000', false, true],
    ]);
  });
});

describe('NetSuite line tags', () => {
  it('tags a component with its rack and leaves other lines alone', () => {
    expect(kitTaggedDescription('Base mount', kitFields)).toBe('Base mount [Rack AR1205-S]');
    expect(kitTaggedDescription('Bolt', {})).toBe('Bolt');
  });

  it('drops kit columns on lines that are not in a kit', () => {
    expect(kitLineColumns({ kit_item_number: 'X', kit_quantity: '3' })).toEqual({
      kit_group_id: null, kit_id: null, kit_item_number: null, kit_name: null, kit_quantity: null,
    });
    expect(kitLineColumns({ ...kitFields, kit_quantity: '3' }).kit_quantity).toBe(3);
  });
});

const part = (item_number: string, sales_price: number) => ({
  id: `p-${item_number}`, netsuite_id: '9', item_number, display_name: item_number, description: null,
  marketing_description: null, catalog: 'upfit', item_type: 'InvtPart', vendor: 'Prime Design',
  sales_price, purchase_price: null, avg_install_cost: null, labor_hours: 0, quantity_available: 0,
  product_category_id: null, image_path: null,
});

describe('kitEstimateLines', () => {
  const kit: KitWithMembers = {
    id: 'k1', name: 'AluRack 6.5 FT Cap', description: null, vehicle_label: null, image_path: null,
    item_number: 'AR1205-S', vendor: 'Prime Design', labor_adder_hours: 0,
    members: [{ part: part('FBM-1026-BLK', 100), quantity: 1 }, { part: part('AR-2102', 50), quantity: 2 }],
    missing: [{ item_number: 'AR-2000', description: 'Crossbar module', quantity: 1 }],
    totalPrice: 200, totalLabor: 0,
  };

  it('scales components by the rack quantity and groups them', () => {
    const out = kitEstimateLines(kit, 3);
    expect(out.map(l => [l.item_number, l.quantity, l.unit_price])).toEqual([
      ['FBM-1026-BLK', 3, 100], ['AR-2102', 6, 50], ['AR-2000', 3, 0],
    ]);
    expect(new Set(out.map(l => l.kit_group_id)).size).toBe(1);
    expect(out.every(l => l.kit_item_number === 'AR1205-S' && l.kit_quantity === 3)).toBe(true);
    // A part missing from NetSuite lands as a flagged custom line, not silently dropped.
    expect(out[2]).toMatchObject({ is_custom: true, netsuite_item_id: null });
  });

  it('a plain package still explodes into ungrouped lines', () => {
    const out = kitEstimateLines({ ...kit, item_number: null, missing: [] });
    expect(out.every(l => !l.kit_group_id)).toBe(true);
  });
});

describe('kitBuildable', () => {
  const comps = [
    { item_number: 'FEA-0024', quantity: 2, in_catalog: true },
    { item_number: 'CBR-0003', quantity: 1, in_catalog: true },
  ];

  it('is limited by the scarcest component', () => {
    const stock = new Map([
      ['FEA-0024', { free: 5, on_order: 4 }],
      ['CBR-0003', { free: 10, on_order: 0 }],
    ]);
    expect(kitBuildable(comps, stock)).toMatchObject({ now: 2, withOnOrder: 4, bottleneck: 'FEA-0024' });
  });

  it('a component with no stock (or not in the catalog) builds zero', () => {
    const r = kitBuildable([...comps, { item_number: 'FBM-1007-BLK', quantity: 1, in_catalog: false }], new Map([
      ['FEA-0024', { free: 5, on_order: 0 }], ['CBR-0003', { free: 10, on_order: 0 }],
    ]));
    expect(r.now).toBe(0);
    expect(r.bottleneck).toBe('FBM-1007-BLK');
  });

  it('adds up a part listed twice in one kit', () => {
    const r = kitBuildable([comps[1], comps[1]], new Map([['CBR-0003', { free: 5, on_order: 0 }]]));
    expect(r.now).toBe(2);
  });
});

describe('line discounts on customer surfaces (migration 350)', () => {
  it('a rack shows its parts\' line discounts once, under the rack', () => {
    const lines = [
      { kit_group_id: 'g1', kit_item_number: 'AR1', kit_quantity: 1, item_number: 'P1', quantity: 1, unit_price: 100, line_total: 100, discount_type: 'percent', discount_value: 10, discount_amount: 10 },
      { kit_group_id: 'g1', kit_item_number: 'AR1', kit_quantity: 1, item_number: 'P2', quantity: 1, unit_price: 50, line_total: 50, discount_type: 'percent', discount_value: 10, discount_amount: 5 },
    ];
    const out = toKitDisplayLines(lines as any);
    expect(out[0].kit_header).toBe(true);
    expect(out[0].discount_amount).toBe(15);
    expect(out[0].discount_type).toBe('percent');
    expect(out.slice(1).every((l: any) => l.discount_amount === 0)).toBe(true);
  });

  it('the emailed document puts a discount row under the line', () => {
    const html = renderEstimateDocument(
      { estimate_number: 'EST-1', subtotal: 90, labor_total: 0, tax_amount: 0, grand_total: 90, tax_rate: 0 },
      [{ item_number: 'BRK-1', quantity: 1, unit_price: 100, line_total: 100, discount_type: 'percent', discount_value: 10, discount_amount: 10 }],
    );
    expect(html).toContain('Discount (10%)');
    expect(html).toContain('&minus;$10.00');
  });

  it('the approval page gets the line discount', () => {
    const [l] = publicLines([{ id: 'x', item_number: 'A', quantity: 1, unit_price: 100, discount_type: 'amount', discount_value: 5, discount_amount: 5 }]);
    expect(l.discount_amount).toBe(5);
    expect(l.discount_type).toBe('amount');
  });
});
