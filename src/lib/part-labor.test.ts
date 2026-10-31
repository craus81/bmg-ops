import { describe, it, expect } from 'vitest';
import { parseLaborHoursInput, applyPartLaborToLines, applyLaborToLine, lineIsPart } from './part-labor';
import { isGenericPart } from './generic-parts';

describe('parseLaborHoursInput', () => {
  it('blank clears to not set', () => {
    expect(parseLaborHoursInput('  ')).toEqual({ hours: null });
  });
  it('0 is a real value (no labor)', () => {
    expect(parseLaborHoursInput('0')).toEqual({ hours: 0 });
  });
  it('rounds to hundredths', () => {
    expect(parseLaborHoursInput('1.505')).toEqual({ hours: 1.51 });
  });
  it('rejects negatives, words and silly values', () => {
    for (const bad of ['-1', 'abc', '1.5h', '500']) {
      expect('error' in parseLaborHoursInput(bad)).toBe(true);
    }
  });
});

describe('applyPartLaborToLines', () => {
  const part = { id: 'p1', netsuite_id: '123' };
  const lines = [
    { key: 'a', part_id: 'p1', netsuite_item_id: '123', labor_hours: null },
    { key: 'b', part_id: 'p1', netsuite_item_id: '123', labor_hours: 2 },
    { key: 'c', part_id: null, netsuite_item_id: '123', labor_hours: null },
    { key: 'd', part_id: 'p2', netsuite_item_id: '999', labor_hours: null },
    { key: 'e', part_id: 'p2', netsuite_item_id: '123', labor_hours: null },
  ];

  it('sets every line of the part on this estimate, and no other part', () => {
    const out = applyPartLaborToLines(lines, part, 1.5);
    expect(out.map(l => l.labor_hours)).toEqual([1.5, 1.5, 1.5, null, null]);
  });

  it('a line with its own part_id is matched by part_id only', () => {
    expect(lineIsPart(lines[4], part)).toBe(false);
    expect(lineIsPart(lines[2], part)).toBe(true);
  });

  it('can clear back to not set', () => {
    expect(applyPartLaborToLines(lines, part, null)[1].labor_hours).toBeNull();
  });
});

describe('applyLaborToLine (This line only)', () => {
  const misc = { part_id: 'p-misc', netsuite_item_id: '9', labor_hours: null, is_custom: false };
  it('changes only the one line, not other lines of the same part', () => {
    const lines = [{ ...misc, key: 'a' }, { ...misc, key: 'b' }];
    const out = applyLaborToLine(lines, 'a', 1.5);
    expect(out.map(l => l.labor_hours)).toEqual([1.5, null]);
  });
});

describe('isGenericPart', () => {
  it('follows the flag only, never the name', () => {
    expect(isGenericPart({ is_generic: true })).toBe(true);
    expect(isGenericPart({ is_generic: false })).toBe(false);
    expect(isGenericPart(null)).toBe(false);
    expect(isGenericPart({ item_number: 'Miscellaneous' } as any)).toBe(false);
  });
});
