import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/parts-sync', () => ({ fetchSalesPrices: vi.fn() }));
vi.mock('@/lib/netsuite', () => ({ updateItemFields: vi.fn() }));

import { findMismatches } from './price-mismatch';

describe('findMismatches', () => {
  const part = (id: string, netsuite_id: string | null, item_number: string, sales_price: number | null, is_active = true) =>
    ({ id, netsuite_id, item_number, sales_price, is_active });

  it('lists parts whose NetSuite price differs or is missing', () => {
    const out = findMismatches([
      part('a', '10', 'A', 100),
      part('b', '11', 'B', 50),
      part('c', '12', 'C', 75),
      part('d', '13', 'D', 20),
    ], { '10': 100, '11': 55, '13': 20.004 });
    expect(out).toEqual([
      { part_id: 'b', item_number: 'B', fleetsuite_price: 50, netsuite_price: 55 },
      { part_id: 'c', item_number: 'C', fleetsuite_price: 75, netsuite_price: null },
    ]);
  });

  it('skips inactive, local and unpriced parts, and one NetSuite item counts once', () => {
    const out = findMismatches([
      part('x', '20', 'X', 10, false),
      part('y', 'LOCAL-1', 'Y', 10),
      part('z', null, 'Z', 10),
      part('n', '21', 'N', 0),
      part('d1', '22', 'DUP', 10),
      part('d2', '22', 'DUP', 10),
    ], { '22': 12 });
    expect(out).toEqual([{ part_id: 'd1', item_number: 'DUP', fleetsuite_price: 10, netsuite_price: 12 }]);
  });
});
