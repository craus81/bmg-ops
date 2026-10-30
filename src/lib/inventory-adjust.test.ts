import { describe, it, expect, vi, beforeEach } from 'vitest';

const suiteql = vi.fn();
const createAdj = vi.fn();
vi.mock('@/lib/netsuite', () => ({
  suiteqlQuery: (...a: any[]) => suiteql(...a),
  createInventoryAdjustment: (...a: any[]) => createAdj(...a),
  resolveDefaultLocationId: async () => '7',
}));

import { adjustInventory, adjustmentChange, adjustmentMemo } from './inventory-adjust';

describe('adjustmentChange', () => {
  it('uses the entered number as the change in add/remove mode', () => {
    expect(adjustmentChange('delta', -2, 5)).toEqual({ change: -2, after: 3 });
    expect(adjustmentChange('delta', 3, 0)).toEqual({ change: 3, after: 3 });
  });

  it('works out the difference from a shelf count', () => {
    expect(adjustmentChange('count', 2, 5)).toEqual({ change: -3, after: 2 });
    expect(adjustmentChange('count', 8, 5)).toEqual({ change: 3, after: 8 });
    expect(adjustmentChange('count', 0, 4)).toEqual({ change: -4, after: 0 });
  });

  it('refuses no change, going below 0, fractions and negative counts', () => {
    expect(adjustmentChange('delta', 0, 5)).toHaveProperty('error');
    expect(adjustmentChange('count', 5, 5)).toEqual({ error: 'NetSuite already shows 5 on hand. Nothing to adjust.' });
    expect(adjustmentChange('delta', -6, 5)).toEqual({ error: "That would leave -1 on hand. NetSuite can't go below 0. Check the count." });
    expect(adjustmentChange('delta', 1.5, 5)).toHaveProperty('error');
    expect(adjustmentChange('delta', NaN, 5)).toHaveProperty('error');
    expect(adjustmentChange('count', -1, 5)).toHaveProperty('error');
  });
});

describe('adjustmentMemo', () => {
  it('names the reason, note and person', () => {
    expect(adjustmentMemo('Damaged', ' Box crushed ', 'Jessie')).toBe('FleetSuite: Damaged · Box crushed · by Jessie');
    expect(adjustmentMemo('Found', '', null)).toBe('FleetSuite: Found');
  });
});

/** netsuite_parts lookup + updates, inventory_adjustments inserts, recorded. */
function fakeService(part: any) {
  const inserts: any[] = [];
  const updates: any[] = [];
  const service: any = {
    from(table: string) {
      return {
        select() {
          const chain: any = { eq: () => chain, maybeSingle: async () => ({ data: part, error: null }) };
          return chain;
        },
        update(values: any) {
          return { eq: async () => { updates.push({ table, values }); return { error: null }; } };
        },
        insert: async (row: any) => { inserts.push({ table, row }); return { error: null }; },
      };
    },
  };
  return { service, inserts, updates };
}

const base = { netsuiteId: '501', reason: 'Count correction', userId: 'u1', userName: 'Craig' };

beforeEach(() => {
  suiteql.mockReset();
  createAdj.mockReset();
});

describe('adjustInventory', () => {
  it('posts the shelf-count difference against NetSuite’s live O’Fallon count', async () => {
    const { service, inserts, updates } = fakeService({ id: 'p1', netsuite_id: '501', item_number: 'C-ST1205-6', item_type: 'InvtPart' });
    suiteql.mockImplementation(async (q: string) => {
      if (q.includes('inventoryitemlocations')) {
        return { items: [createAdj.mock.calls.length ? { quantityonhand: '2', quantityavailable: '0' } : { quantityonhand: '4', quantityavailable: '2' }] };
      }
      if (q.includes('FROM account')) return { items: [{ id: '312' }] };
      if (q.includes('FROM location')) return { items: [{ subsidiary: '1' }] };
      if (q.includes('totalquantityonhand')) return { items: [{ qty_on_hand: '2', qty_available: '0' }] };
      return { items: [] };
    });
    createAdj.mockResolvedValue({ success: true, adjustmentId: '9001', adjustmentNumber: 'IA42' });

    const r = await adjustInventory(service, { ...base, mode: 'count', qty: 2, note: 'shelf 3' });

    expect(createAdj).toHaveBeenCalledWith({
      itemId: '501', locationId: '7', accountId: '312', subsidiaryId: '1', adjustQtyBy: -2,
      memo: 'FleetSuite: Count correction · shelf 3 · by Craig',
    });
    expect(r).toEqual({ ok: true, adjustmentNumber: 'IA42', change: -2, onHandBefore: 4, onHand: 2, available: 0 });
    expect(updates[0].values).toMatchObject({ quantity_on_hand: 2, quantity_available: 0 });
    expect(inserts[0].table).toBe('inventory_adjustments');
    expect(inserts[0].row).toMatchObject({ change: -2, on_hand_before: 4, mode: 'count', netsuite_adjustment_number: 'IA42', created_by: 'u1' });
  });

  it('does not post when the change is invalid', async () => {
    const { service, inserts } = fakeService({ id: 'p1', netsuite_id: '501', item_number: 'X', item_type: 'InvtPart' });
    suiteql.mockResolvedValue({ items: [{ quantityonhand: '1', quantityavailable: '1' }] });
    const r = await adjustInventory(service, { ...base, mode: 'delta', qty: -3 });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(createAdj).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it('refuses non-inventory items and unknown reasons', async () => {
    const { service } = fakeService({ id: 'p1', netsuite_id: '501', item_number: 'LABOR', item_type: 'Service' });
    expect(await adjustInventory(service, { ...base, mode: 'delta', qty: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(await adjustInventory(service, { ...base, reason: 'Stolen?', mode: 'delta', qty: 1 })).toMatchObject({ ok: false, error: 'Pick a reason.' });
    expect(createAdj).not.toHaveBeenCalled();
  });

  it('passes NetSuite’s refusal through and saves nothing', async () => {
    const { service, inserts } = fakeService({ id: 'p1', netsuite_id: '501', item_number: 'X', item_type: 'InvtPart' });
    suiteql.mockImplementation(async (q: string) =>
      q.includes('FROM account') ? { items: [{ id: '312' }] } : { items: [{ quantityonhand: '1', quantityavailable: '1' }] });
    createAdj.mockResolvedValue({ success: false, error: 'NetSuite refused the adjustment (400): Insufficient permissions' });
    const r = await adjustInventory(service, { ...base, mode: 'delta', qty: 1 });
    expect(r).toEqual({ ok: false, status: 502, error: 'NetSuite refused the adjustment (400): Insufficient permissions' });
    expect(inserts).toHaveLength(0);
  });
});
