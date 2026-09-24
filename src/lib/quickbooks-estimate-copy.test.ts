import { describe, it, expect } from 'vitest';
import { catalogSearchTerms, matchQuickbooksLine, qboItemName, quickbooksDraftRequests } from './quickbooks-estimate-copy';
import type { HistoryLine } from './ledger/history';

const line = (over: Partial<HistoryLine>): HistoryLine => ({
  lineNo: 1, kind: 'item', itemName: null, itemNumber: null, description: null,
  quantity: null, unitPrice: null, amount: 0, serviceDate: null, ...over,
});

const doc = (lines: HistoryLine[]) => ({ lines, number: '1042', typeLabel: 'Invoice', date: '2021-05-04' });

describe('qboItemName', () => {
  it('takes the sub-item after QuickBooks\' Parent:Child path', () => {
    expect(qboItemName('Shelving:RB-148')).toBe('RB-148');
    expect(qboItemName('Labor')).toBe('Labor');
    expect(qboItemName('  ')).toBeNull();
    expect(qboItemName(null)).toBeNull();
  });
});

describe('quickbooksDraftRequests', () => {
  it('keeps priced item lines and carries the old quantity and price in the text', () => {
    const [r] = quickbooksDraftRequests(doc([
      line({ itemName: 'Shelving:RB-148', description: 'Ranger bin package, Transit 148', quantity: 2, unitPrice: 1234.5, amount: 2469 }),
    ]));
    expect(r.qboItem).toBe('RB-148');
    expect(r.request).toMatchObject({ itemNumber: null, description: 'Ranger bin package, Transit 148', quantity: 2 });
    expect(r.request.raw).toBe('RB-148: Ranger bin package, Transit 148 (2 × $1,234.50 on invoice #1042, 2021-05-04)');
  });

  it('skips subtotals, headings, discounts and tax, and lines with no words', () => {
    const out = quickbooksDraftRequests(doc([
      line({ kind: 'subtotal', amount: 100 }),
      line({ kind: 'description', description: 'Unit 14' }),
      line({ kind: 'discount', amount: -50 }),
      line({ kind: 'tax', amount: 8 }),
      line({ kind: 'item' }),
      line({ kind: 'item', itemName: 'Labor', quantity: 6, unitPrice: 95, amount: 570 }),
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].request.description).toBe('Labor');
  });

  it('leaves quantity unstated when QuickBooks had none, and shows the amount instead', () => {
    const [r] = quickbooksDraftRequests(doc([line({ description: 'Decal kit', amount: 300 })]));
    expect(r.request.quantity).toBeNull();
    expect(r.request.raw).toContain('$300.00 on invoice #1042');
  });
});

describe('matchQuickbooksLine', () => {
  const part = { id: 'p1', item_number: 'RB-148', display_name: 'Ranger bin package 148', sales_price: 1500, labor_hours: 4 };
  const other = { id: 'p2', item_number: 'LAD-01', display_name: 'Ladder rack aluminum', sales_price: 900, labor_hours: 2 };

  it('matches the QuickBooks item name as a catalog part number, priced from today\'s catalog', () => {
    const [q] = quickbooksDraftRequests(doc([line({ itemName: 'Shelving:RB-148', description: 'bins', quantity: 1, unitPrice: 1000, amount: 1000 })]));
    const m = matchQuickbooksLine(q, [other, part]);
    expect(m.part?.id).toBe('p1');
    expect(m.confidence).toBe('exact');
    expect(m.unitPrice).toBe(1500);
    expect(m.signal).toContain('QuickBooks item RB-148');
  });

  it('falls back to the words when the item name is not a catalog number', () => {
    const [q] = quickbooksDraftRequests(doc([line({ itemName: 'Racks', description: 'Ladder rack aluminum', quantity: 1, amount: 700 })]));
    const m = matchQuickbooksLine(q, [other, part]);
    expect(m.part?.id).toBe('p2');
    expect(m.unitPrice).toBe(900);
  });

  it('leaves a line with no match as a custom line with no price', () => {
    const [q] = quickbooksDraftRequests(doc([line({ itemName: 'Misc', description: 'Haul away old shelving', amount: 150 })]));
    const m = matchQuickbooksLine(q, [other, part]);
    expect(m.part).toBeNull();
    expect(m.confidence).toBe('none');
    expect(m.unitPrice).toBeNull();
  });
});

describe('catalogSearchTerms', () => {
  it('searches the item name and the description words, without filter syntax', () => {
    const [q] = quickbooksDraftRequests(doc([line({ itemName: 'Shelving:RB,148 (a)', description: 'Ranger bins for the Transit', amount: 1 })]));
    const terms = catalogSearchTerms(q);
    expect(terms[0]).not.toMatch(/[,()]/);
    expect(terms).toEqual(expect.arrayContaining(['ranger', 'bins', 'for', 'the']));
  });
});
