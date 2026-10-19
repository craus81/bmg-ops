import { describe, it, expect } from 'vitest';
import { diffAgainstExisting, describeChanges, pendingExtractions } from './pending-po-existing';

const existing = [
  { part_number: '02-LB-118', quantity: 2, unit_price: 10 },
  { part_number: '06-FA-100', quantity: 1, unit_price: 250 },
];

describe('diffAgainstExisting', () => {
  it('finds nothing when the email matches the PO', () => {
    const lines = [
      { part_number: '02-lb-118', quantity: '2', unit_price: '10.00' },
      { part_number: 'X', supplier_part: '06-FA-100', quantity: 1, unit_price: 250 },
    ];
    expect(diffAgainstExisting(lines, existing)).toEqual([]);
  });

  it('lists added, removed and changed lines', () => {
    const lines = [
      { part_number: '02-LB-118', quantity: 4, unit_price: 10 },
      { part_number: '06-FA-2210', quantity: 1, unit_price: 99 },
    ];
    const changes = diffAgainstExisting(lines, existing);
    expect(changes.map(c => c.type).sort()).toEqual(['added', 'changed', 'removed']);
    expect(describeChanges(changes)).toBe('1 line added (06-FA-2210), 1 line removed (06-FA-100), 1 qty changed (02-LB-118: 2 → 4)');
  });

  it('describes a price-only change', () => {
    const changes = diffAgainstExisting([
      { part_number: '02-LB-118', quantity: 2, unit_price: 12 },
      { part_number: '06-FA-100', quantity: 1, unit_price: 250 },
    ], existing);
    expect(describeChanges(changes)).toBe('1 price changed (02-LB-118: $10.00 → $12.00)');
  });
});

describe('pendingExtractions', () => {
  it('reads a single and a multi-PO entry', () => {
    expect(pendingExtractions({ po_number: 123, lines: [] })).toEqual([{ poNumber: '123', lines: [] }]);
    expect(pendingExtractions({ multi: true, pos: [{ extracted: { po_number: 'A', lines: [] } }, { extracted: {} }] }))
      .toEqual([{ poNumber: 'A', lines: [] }]);
    expect(pendingExtractions(null, '77')).toEqual([{ poNumber: '77', lines: [] }]);
  });
});
