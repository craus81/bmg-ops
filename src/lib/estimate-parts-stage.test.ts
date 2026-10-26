import { describe, it, expect } from 'vitest';
import { derivePartsStage, type PartsStageInput } from './estimate-parts-stage';

const base: PartsStageInput = { approved: true, soClosed: false, requests: [], dropShips: [], stock: null };
const req = (item: string, status: string, po: string | null = null) => ({ item_number: item, status, po_number: po });

describe('derivePartsStage', () => {
  it('gives no tag before approval or once the job is billed', () => {
    expect(derivePartsStage({ ...base, approved: false })).toBeNull();
    expect(derivePartsStage({ ...base, soClosed: true, requests: [req('A', 'ordered')] })).toBeNull();
  });

  it('stays Approved until every requested part is ordered (1A)', () => {
    const r = derivePartsStage({ ...base, requests: [req('A', 'ordered', 'PO1'), req('B', 'pending')] });
    expect(r?.stage).toBe('approved');
    expect(r?.detail).toBe('1 of 2 parts ordered');
  });

  it('is Parts ordered when all are, listing the POs', () => {
    const r = derivePartsStage({ ...base, requests: [req('A', 'ordered', 'PO2'), req('b', 'ordered', 'PO1'), req('C', 'cancelled')] });
    expect(r?.stage).toBe('parts_ordered');
    expect(r?.detail).toBe('All 2 parts ordered on PO1, PO2');
  });

  it('counts a split request as not ordered while its rest is pending', () => {
    const r = derivePartsStage({ ...base, requests: [req('A', 'ordered', 'PO1'), req('a', 'pending')] });
    expect(r?.stage).toBe('approved');
    expect(r?.detail).toBe('0 of 1 parts ordered');
  });

  it('counts drop ship POs as ordered', () => {
    const r = derivePartsStage({ ...base, requests: [req('A', 'ordered', 'PO1')], dropShips: [{ po_number: 'PO9', item_numbers: ['B'] }] });
    expect(r?.stage).toBe('parts_ordered');
    expect(r?.poNumbers).toEqual(['PO1', 'PO9']);
  });

  it('is Parts in stock when nothing was requested and nothing is short (2B)', () => {
    expect(derivePartsStage({ ...base, stock: { parts: 3, short: 0, unknown: 0, onOrder: 0 } })?.stage).toBe('parts_in_stock');
    expect(derivePartsStage({ ...base, stock: { parts: 0, short: 0, unknown: 0, onOrder: 0 } })?.detail).toBe('No parts to order');
  });

  it('stays Approved when stock is short, unknown, or unchecked', () => {
    expect(derivePartsStage({ ...base, stock: { parts: 3, short: 2, unknown: 0, onOrder: 0 } })?.detail).toBe('2 parts short · nothing requested yet');
    expect(derivePartsStage({ ...base, stock: { parts: 1, short: 0, unknown: 1, onOrder: 0 } })?.stage).toBe('approved');
    expect(derivePartsStage(base)?.detail).toBe('Parts not ordered yet');
  });
});
