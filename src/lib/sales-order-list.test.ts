import { describe, it, expect } from 'vitest';
import { parseSoView, soViewOf, statusCode, statusText, statusValuesFor } from './sales-order-list';

describe('sales order list', () => {
  it('reads both spellings of a status', () => {
    expect(statusCode('SalesOrd:B')).toBe('B');
    expect(statusCode('f')).toBe('F');
  });

  it('puts each status in its view', () => {
    for (const s of ['A', 'B', 'D', 'E', 'F', 'SalesOrd:F']) expect(soViewOf(s)).toBe('open');
    expect(soViewOf('G')).toBe('billed');
    expect(soViewOf('C')).toBe('closed');
    expect(soViewOf('H')).toBe('closed');
  });

  it('matches the views it lists', () => {
    for (const v of ['open', 'billed', 'closed'] as const) {
      for (const s of statusValuesFor(v)) expect(soViewOf(s)).toBe(v);
    }
  });

  it("prefers NetSuite's own label", () => {
    expect(statusText('B', 'Sales Order : Pending Fulfillment')).toBe('Sales Order : Pending Fulfillment');
    expect(statusText('F', null)).toBe('Pending Billing');
    expect(statusText(null, null)).toBe('Unknown');
  });

  it('falls back to Open for an unknown view', () => {
    expect(parseSoView('billed')).toBe('billed');
    expect(parseSoView('nope')).toBe('open');
    expect(parseSoView(null)).toBe('open');
  });
});
