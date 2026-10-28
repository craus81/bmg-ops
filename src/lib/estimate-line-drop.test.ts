import { describe, expect, it } from 'vitest';
import { dropIndex, duplicateKit, duplicatePartLine, insertAt, partEstimateLine } from './estimate-line-drop';

const lines = [
  { key: 'a', part_id: 'p1' },
  { key: 'k1', part_id: 'p2', kit_group_id: 'g' },
  { key: 'k2', part_id: 'p3', kit_group_id: 'g' },
  { key: 'b', part_id: 'p2' },
];

describe('dropIndex', () => {
  it('goes at the end with nothing under the point', () => {
    expect(dropIndex(lines, null)).toBe(4);
    expect(dropIndex(lines, { key: 'gone', before: true })).toBe(4);
  });
  it('goes above or below the line it was let go on', () => {
    expect(dropIndex(lines, { key: 'a', before: true })).toBe(0);
    expect(dropIndex(lines, { key: 'a', before: false })).toBe(1);
    expect(dropIndex(lines, { key: 'b', before: false })).toBe(4);
  });
  it('never lands inside a kit', () => {
    expect(dropIndex(lines, { key: 'k2', before: true })).toBe(1);
    expect(dropIndex(lines, { key: 'k1', before: false })).toBe(3);
  });
});

describe('insertAt', () => {
  it('puts the new lines in at the index, in order', () => {
    expect(insertAt(['a', 'b'], ['x', 'y'], 1)).toEqual(['a', 'x', 'y', 'b']);
    expect(insertAt(['a'], ['x'], 9)).toEqual(['a', 'x']);
  });
});

describe('duplicatePartLine', () => {
  it('finds the same part on its own line, not inside a kit', () => {
    expect(duplicatePartLine(lines, 'p2')?.key).toBe('b');
    expect(duplicatePartLine(lines, 'p3')).toBeNull();
    expect(duplicatePartLine(lines, null)).toBeNull();
  });
});

describe('partEstimateLine', () => {
  it('builds the line the builder adds for a part', () => {
    expect(partEstimateLine({
      id: 'p1', netsuite_id: '55', item_number: 'ACX-1', display_name: 'Clamp', sales_price: 12.5, labor_hours: null, catalog: 'upfit',
    })).toMatchObject({ part_id: 'p1', netsuite_item_id: '55', description: 'Clamp', quantity: 1, unit_price: 12.5, labor_hours: null, is_custom: false });
  });
});

describe('duplicateKit', () => {
  const onEstimate = [
    { key: 'a', part_id: 'p1' },
    { key: 'k1', part_id: 'p2', kit_group_id: 'g1', kit_id: 'rack', kit_quantity: 2, kit_name: 'Transit rack' },
  ];
  it('finds the same rack already on the estimate', () => {
    expect(duplicateKit(onEstimate, [{ kit_id: 'rack', kit_group_id: 'new' }]))
      .toEqual({ groupId: 'g1', quantity: 2, name: 'Transit rack' });
  });
  it('lets a different kit, or a plain package, through', () => {
    expect(duplicateKit(onEstimate, [{ kit_id: 'other', kit_group_id: 'new' }])).toBeNull();
    expect(duplicateKit(onEstimate, [{ kit_id: null, kit_group_id: null }])).toBeNull();
  });
});
