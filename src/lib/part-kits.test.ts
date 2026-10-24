import { describe, it, expect } from 'vitest';
import { rackKitForPart, rackKitsByNumber, type KitWithMembers } from './part-kits';

const kit = (id: string, item_number: string | null): KitWithMembers => ({
  id, name: `Kit ${id}`, description: null, vehicle_label: null, image_path: null,
  item_number, vendor: null, labor_adder_hours: 0, members: [], missing: [], totalPrice: 0, totalLabor: 0,
});

describe('rack kit duplicates (kit wins, Craig 2026-10-24)', () => {
  const byNumber = rackKitsByNumber([kit('a', 'AR1205-S'), kit('b', 'RR3-PM-72-M'), kit('pkg', null)]);

  it('matches a NetSuite item with the same part number, case and dashes aside', () => {
    expect(rackKitForPart(byNumber, 'AR1205-S')?.id).toBe('a');
    expect(rackKitForPart(byNumber, 'ar1205s')?.id).toBe('a');
    expect(rackKitForPart(byNumber, ' RR3 PM 72 M ')?.id).toBe('b');
  });

  it('leaves rack parts and near misses alone', () => {
    expect(rackKitForPart(byNumber, 'AR-2000')).toBeNull();
    expect(rackKitForPart(byNumber, 'AR1205-S-BLK')).toBeNull();
    expect(rackKitForPart(byNumber, 'AR1205')).toBeNull();
    expect(rackKitForPart(byNumber, '')).toBeNull();
    expect(rackKitForPart(byNumber, null)).toBeNull();
  });

  it('never matches a plain package (no part number)', () => {
    expect([...byNumber.values()].map(k => k.id).sort()).toEqual(['a', 'b']);
  });
});
