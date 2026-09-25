import { describe, it, expect } from 'vitest';
import { cleanPartQuery, partSearchFilter, rankPartSuggestions, latestPoPrices, pickPrice, type PartSuggestion } from './part-suggest';

const part = (item_number: string, extra: Partial<PartSuggestion> = {}): PartSuggestion => ({
  id: item_number, item_number, display_name: null, sales_price: 10, customer: null, billable_customer: null, ...extra,
});

describe('cleanPartQuery', () => {
  it('strips filter syntax and needs two characters', () => {
    expect(cleanPartQuery('02-1(2),%')).toBe('02-1 2');
    expect(cleanPartQuery(' a ')).toBe('');
  });
});

describe('partSearchFilter', () => {
  it('adds the O→0 variant only when it differs', () => {
    expect(partSearchFilter('02-1')).toBe('item_number.ilike.%02-1%,display_name.ilike.%02-1%');
    expect(partSearchFilter('O2-1')).toContain('item_number.ilike.%02-1%');
  });
});

describe('rankPartSuggestions', () => {
  it('puts exact, then customer, then prefix matches first without hiding others', () => {
    const ranked = rankPartSuggestions([
      part('X-0212'),
      part('0212-B', { customer: 'Other' }),
      part('0212-A', { customer: 'Masterack' }),
      part('0212'),
    ], '0212', 'masterack');
    expect(ranked.map(p => p.item_number)).toEqual(['0212', '0212-A', '0212-B', 'X-0212']);
  });

  it('collapses duplicate item numbers to the priced row', () => {
    const ranked = rankPartSuggestions([
      part('ABC', { id: 'manual', sales_price: 0 }),
      part('abc', { id: 'ns', sales_price: 42 }),
    ], 'abc', '');
    expect(ranked).toHaveLength(1);
    expect(ranked[0].id).toBe('ns');
  });
});

describe('latestPoPrices', () => {
  const row = (part_number: string, unit_price: number, id: string, date: string) => ({
    part_number, unit_price, purchase_orders: { id, po_number: `PO-${id}`, ordered_date: date, created_at: null },
  });

  it('keeps the newest non-zero price per part and skips the excluded PO', () => {
    const m = latestPoPrices([
      row('abc', 10, '1', '2026-01-01'),
      row('ABC', 12, '2', '2026-06-01'),
      row('ABC', 0, '3', '2026-08-01'),
      row('ABC', 99, 'current', '2026-09-01'),
    ], 'current');
    expect(m.get('ABC')).toEqual({ price: 12, poNumber: 'PO-2', date: '2026-06-01' });
  });
});

describe('pickPrice', () => {
  it('uses the sell price, falling back to the last PO price', () => {
    expect(pickPrice(20, { price: 15, poNumber: '1', date: null })).toBe(20);
    expect(pickPrice(0, { price: 15, poNumber: '1', date: null })).toBe(15);
    expect(pickPrice(null, undefined)).toBe(0);
  });
});
