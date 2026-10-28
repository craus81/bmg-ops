import { describe, it, expect } from 'vitest';
import { estimateCopiedFrom, oldRecordCopiedFrom } from './estimate-copied-from';

const at = '2026-10-28T16:00:00.000Z';

describe('estimateCopiedFrom', () => {
  it('shows the source on a copy nobody has saved yet', () => {
    expect(estimateCopiedFrom({ internal_notes: 'Copied from EST-2610-094 (2026-10-28).\nGate code 1234', created_at: at, updated_at: at }))
      .toEqual({ text: 'Copied from EST-2610-094', sourceNumber: 'EST-2610-094' });
  });

  it('names fleet copies as fleet copies, without the unit', () => {
    expect(estimateCopiedFrom({ internal_notes: 'Fleet copy of EST-2610-094 for unit 4471 (2026-10-28).', created_at: at, updated_at: at }))
      .toEqual({ text: 'Fleet copy of EST-2610-094', sourceNumber: 'EST-2610-094' });
  });

  it('goes away once the copy has been saved', () => {
    expect(estimateCopiedFrom({ internal_notes: 'Copied from EST-1 (2026-10-28).', created_at: at, updated_at: '2026-10-28T16:05:00.000Z' })).toBeNull();
  });

  it('tolerates timestamp formats that differ only in precision', () => {
    expect(estimateCopiedFrom({ internal_notes: 'Copied from EST-1 (2026-10-28).', created_at: '2026-10-28T16:00:00.123456+00:00', updated_at: '2026-10-28T16:00:00.123Z' }))
      .not.toBeNull();
  });

  it('ignores revisions (they have their own banner) and ordinary notes', () => {
    const base = { created_at: at, updated_at: at };
    expect(estimateCopiedFrom({ ...base, internal_notes: 'Revision of EST-1 (2026-10-28) — original is locked by customer acceptance/conversion.' })).toBeNull();
    expect(estimateCopiedFrom({ ...base, internal_notes: 'Customer copied from last year' })).toBeNull();
    expect(estimateCopiedFrom({ ...base, internal_notes: 'Gate code\nCopied from EST-1 (2026-10-28).' })).toBeNull();
    expect(estimateCopiedFrom(null)).toBeNull();
  });
});

describe('oldRecordCopiedFrom', () => {
  it('names the NetSuite record', () => {
    expect(oldRecordCopiedFrom({ system: 'NetSuite', typeLabel: 'Invoice', number: 'INV1532' })).toBe('Copied from NetSuite Invoice INV1532');
  });
  it('puts # before a QuickBooks number', () => {
    expect(oldRecordCopiedFrom({ system: 'QuickBooks', typeLabel: 'Invoice', number: '050522-105' })).toBe('Copied from QuickBooks Invoice #050522-105');
  });
  it('is null until the record number is known', () => {
    expect(oldRecordCopiedFrom({ system: 'NetSuite', typeLabel: '', number: '' })).toBeNull();
    expect(oldRecordCopiedFrom(null)).toBeNull();
  });
});
