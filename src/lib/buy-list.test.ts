import { describe, it, expect } from 'vitest';
import { buildBuyList, suggestedQuantity, summarizeSources, chunkItems, type BuyListInputRow } from './buy-list';

const row = (over: Partial<BuyListInputRow>): BuyListInputRow => ({
  item_number: 'PART-1', description: 'A part', vendor: 'Adrian Steel',
  netsuite_item_id: '900', in_catalog: true,
  needed: 10, on_order: 0, requested: 0,
  sources: [{ label: 'SO1001', quantity: 10 }], dismissed: null,
  ...over,
});

describe('suggestedQuantity', () => {
  it('subtracts what is already on order and in the queue', () => {
    expect(suggestedQuantity({ needed: 10, on_order: 3, requested: 2 })).toBe(5);
  });

  it('is zero when coverage meets or exceeds the need', () => {
    expect(suggestedQuantity({ needed: 10, on_order: 10, requested: 0 })).toBe(0);
    // Over-covered is still zero — never a negative "buy" that would read
    // as a credit somewhere downstream.
    expect(suggestedQuantity({ needed: 10, on_order: 8, requested: 5 })).toBe(0);
  });
});

describe('buildBuyList', () => {
  it('groups by vendor and skips covered rows, counting them', () => {
    const list = buildBuyList([
      row({ item_number: 'A-1', vendor: 'Adrian Steel', needed: 10 }),
      row({ item_number: 'A-2', vendor: 'Adrian Steel', needed: 4, on_order: 1 }),
      row({ item_number: 'W-1', vendor: 'Weather Guard', needed: 6 }),
      row({ item_number: 'C-1', vendor: 'Adrian Steel', needed: 5, on_order: 5 }),
    ]);
    expect(list.groups.map(g => g.vendor)).toEqual(['Adrian Steel', 'Weather Guard']);
    expect(list.groups[0].lines.map(l => l.itemNumber)).toEqual(['A-1', 'A-2']);
    expect(list.groups[0].units).toBe(13);
    expect(list.lineCount).toBe(3);
    expect(list.units).toBe(19);
    expect(list.coveredSkipped).toBe(1);
  });

  it('never queues a dismissed row, and says how many it held back', () => {
    const list = buildBuyList([
      row({ item_number: 'A-1' }),
      row({ item_number: 'A-2', dismissed: { at: '2026-09-01', by: null, reason: 'from stock', neededAtDismiss: 10 } }),
    ]);
    expect(list.lineCount).toBe(1);
    expect(list.dismissedSkipped).toBe(1);
  });

  it('keeps parts with no vendor — in their own group, always last', () => {
    const list = buildBuyList([
      row({ item_number: 'N-1', vendor: null }),
      row({ item_number: 'N-2', vendor: '  ' }),
      row({ item_number: 'A-1', vendor: 'Adrian Steel' }),
    ]);
    // The no-vendor group is the bigger one and still sorts last: it isn't
    // a PO anybody can place, so it must not lead the list.
    expect(list.groups.map(g => g.vendor)).toEqual(['Adrian Steel', null]);
    expect(list.groups[1].lines).toHaveLength(2);
    expect(list.noVendorCount).toBe(2);
  });

  it('treats vendor names case-insensitively so one vendor is one PO', () => {
    const list = buildBuyList([
      row({ item_number: 'A-1', vendor: 'Adrian Steel' }),
      row({ item_number: 'A-2', vendor: 'adrian steel' }),
    ]);
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0].lines).toHaveLength(2);
  });

  it('carries the jobs driving each number into the line', () => {
    const list = buildBuyList([row({
      sources: [
        { label: 'SO1001', quantity: 4 }, { label: 'SO1002', quantity: 3 },
        { label: 'EST-77', quantity: 3 },
      ],
    })]);
    const line = list.groups[0].lines[0];
    expect(line.jobCount).toBe(3);
    expect(line.sourceSummary).toBe('SO1001, SO1002 +1 more');
  });
});

describe('summarizeSources', () => {
  it('says nothing when there is nothing to say', () => {
    expect(summarizeSources([])).toBe('');
  });
});

describe('chunkItems', () => {
  it('splits past the API cap so a big sweep is not silently truncated', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunkItems(items);
    expect(chunks.map(c => c.length)).toEqual([100, 100, 50]);
    expect(chunks.flat()).toHaveLength(250);
  });
});
