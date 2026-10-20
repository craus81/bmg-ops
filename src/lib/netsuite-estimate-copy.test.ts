import { describe, it, expect } from 'vitest';
import {
  matchNetsuiteLine, netsuiteDraftRequests, nsItemNumber, sourceLineFromRow,
  type NetsuiteCatalogPart, type NetsuiteSourceLine,
} from './netsuite-estimate-copy';

const line = (over: Partial<NetsuiteSourceLine>): NetsuiteSourceLine => ({
  itemNetsuiteId: null, itemNumber: null, description: null, quantity: null, rate: null, amount: null, ...over,
});

const doc = (lines: NetsuiteSourceLine[]) => ({ number: 'SO4410', typeLabel: 'Sales Order', date: '2025-06-12', lines });

const part = (over: Partial<NetsuiteCatalogPart>): NetsuiteCatalogPart => ({
  id: 'p1', netsuite_id: '501', item_number: 'RB-148', display_name: 'Ranger bin package', sales_price: 1399, labor_hours: 4, is_active: true, ...over,
});

describe('nsItemNumber', () => {
  it('takes the child of a Parent : Child item and upper-cases it', () => {
    expect(nsItemNumber('Shelving : rb-148')).toBe('RB-148');
    expect(nsItemNumber('  ')).toBeNull();
    expect(nsItemNumber(null)).toBeNull();
  });
});

describe('sourceLineFromRow', () => {
  it('reads the sales order / estimate copy shape', () => {
    expect(sourceLineFromRow({ item_netsuite_id: '501', item_number: 'RB-148', description: 'Bins', quantity: '2', rate: '1234.5', amount: '2469' }))
      .toEqual({ itemNetsuiteId: '501', itemNumber: 'RB-148', description: 'Bins', quantity: 2, rate: 1234.5, amount: 2469 });
  });
  it('reads the invoice mirror shape', () => {
    expect(sourceLineFromRow({ item_external_id: '501', item_number: 'RB-148', quantity: 1, unit_price: 10, amount: '-10' }))
      .toMatchObject({ itemNetsuiteId: '501', rate: 10, amount: -10 });
  });
});

describe('netsuiteDraftRequests', () => {
  it('keeps part lines with the old quantity and price in the text', () => {
    const { requests, skipped } = netsuiteDraftRequests(doc([
      line({ itemNetsuiteId: '501', itemNumber: 'RB-148', description: 'Ranger bins', quantity: 2, rate: 1234.5, amount: 2469 }),
    ]));
    expect(requests).toHaveLength(1);
    expect(requests[0].raw).toBe('RB-148: Ranger bins (2 × $1,234.50 on sales order SO4410, 2025-06-12)');
    expect(skipped).toEqual({ laborLines: 0, laborHours: 0, discountLines: 0 });
  });

  it('leaves labor and discounts off and counts them', () => {
    const { requests, skipped } = netsuiteDraftRequests(doc([
      line({ itemNumber: 'LABOR', quantity: 6.5, rate: 125 }),
      line({ itemNumber: 'GRAPHICS INSTALL LABOR', quantity: 2 }),
      line({ itemNumber: 'FLEET DISCOUNT', quantity: 1, rate: 50 }),
      line({ itemNumber: 'PROMO', amount: -100 }),
      line({ itemNumber: 'RB-148', quantity: 1 }),
    ]));
    expect(requests.map(r => r.line.itemNumber)).toEqual(['RB-148']);
    expect(skipped).toEqual({ laborLines: 2, laborHours: 8.5, discountLines: 2 });
  });

  it('skips lines with no item at all', () => {
    expect(netsuiteDraftRequests(doc([line({ description: 'Note to the customer' })])).requests).toEqual([]);
  });
});

describe('matchNetsuiteLine', () => {
  const req = (l: Partial<NetsuiteSourceLine>) => netsuiteDraftRequests(doc([line(l)])).requests[0];

  it('matches the same NetSuite item at today\'s catalog price, not the old one', () => {
    const m = matchNetsuiteLine(req({ itemNetsuiteId: '501', itemNumber: 'OLD-NAME', quantity: 2, rate: 999 }), [part({})]);
    expect(m.part?.id).toBe('p1');
    expect(m.confidence).toBe('exact');
    expect(m.unitPrice).toBe(1399);
    expect(m.laborHours).toBe(4);
    expect(m.request.quantity).toBe(2);
    expect(m.signal).toBe('same NetSuite item, RB-148');
  });

  it('falls back to the item number', () => {
    const m = matchNetsuiteLine(req({ itemNetsuiteId: '777', itemNumber: 'RB-148', quantity: 1 }), [part({})]);
    expect(m.confidence).toBe('exact');
    expect(m.signal).toBe('item number RB-148');
  });

  it('leaves a part that is gone from the catalog as a custom line with no price', () => {
    const m = matchNetsuiteLine(req({ itemNetsuiteId: '9', itemNumber: 'GONE-1', description: 'Old ladder rack', quantity: 1, rate: 800 }), [part({})]);
    expect(m.part).toBeNull();
    expect(m.confidence).toBe('none');
    expect(m.unitPrice).toBeNull();
    expect(m.request.description).toBe('Old ladder rack');
    expect(m.signal).toBe("GONE-1 isn't in today's catalog");
  });

  it('treats an inactive catalog part as gone', () => {
    const m = matchNetsuiteLine(req({ itemNetsuiteId: '501', itemNumber: 'RB-148', quantity: 1 }), [part({ is_active: false })]);
    expect(m.part).toBeNull();
    expect(m.signal).toBe('RB-148 is inactive in the catalog');
  });

  it('never matches by words', () => {
    const m = matchNetsuiteLine(req({ itemNumber: 'XYZ', description: 'Ranger bin package', quantity: 1 }), [part({})]);
    expect(m.part).toBeNull();
  });
});
