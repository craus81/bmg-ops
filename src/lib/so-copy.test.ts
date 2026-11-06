import { describe, expect, it } from 'vitest';
import { copyLinesForSalesOrder } from './so-copy';
import type { NewInvoiceItem } from './new-invoice';

const item = (itemId: string, itemNumber: string, price: number | null, itemType = 'InvtPart'): NewInvoiceItem => ({
  itemId, itemNumber, description: `${itemNumber} catalog`, itemType, price, taxableOverride: null,
});

const vinyl = item('10', '3M-IJ180', 7.5);
const labor = item('20', 'LABOR', null, 'Service');
const catalog = {
  byId: new Map([['10', vinyl], ['20', labor]]),
  byNumber: new Map([['3M-IJ180', vinyl], ['LABOR', labor]]),
};

describe('copyLinesForSalesOrder', () => {
  it("copies parts at today's price, labor at the shop rate, and lists what's gone", () => {
    const out = copyLinesForSalesOrder({
      number: 'INV2699', typeLabel: 'Invoice', date: '2026-11-04',
      lines: [
        { itemNetsuiteId: '10', itemNumber: '3M-IJ180', description: 'Wrap vinyl', quantity: 36, rate: 6, amount: 216 },
        { itemNetsuiteId: null, itemNumber: 'LABOR', description: 'Install', quantity: 3, rate: 95, amount: 285 },
        { itemNetsuiteId: '99', itemNumber: 'OLD-PART', description: 'Gone', quantity: 1, rate: 10, amount: 10 },
        { itemNetsuiteId: '30', itemNumber: 'DISCOUNT', description: null, quantity: 1, rate: -20, amount: -20 },
      ],
    }, catalog, 120);
    expect(out.lines).toEqual([
      { ...vinyl, description: 'Wrap vinyl', quantity: 36, price: 7.5 },
      { ...labor, description: 'Install', quantity: 3, price: 120 },
    ]);
    expect(out.missed).toEqual(['OLD-PART: Gone']);
    expect(out.discountLines).toBe(1);
  });
});
