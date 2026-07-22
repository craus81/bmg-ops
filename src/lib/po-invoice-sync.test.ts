import { describe, it, expect } from 'vitest';
import { fetchAllRows, normalizeNsInvoiceStatus } from './po-invoice-sync';

// The repeat-invoice bug: the sweep's dedup map was built from a select
// capped at 1000 rows, so rows past the cap were re-inserted every run.
// Pin the paging helper that now feeds that map.
describe('fetchAllRows', () => {
  const page = <T>(data: T[]) => ({ data, error: null });

  it('returns a short first page as-is', async () => {
    const rows = await fetchAllRows(async () => page([1, 2, 3]), 'test');
    expect(rows).toEqual([1, 2, 3]);
  });

  it('keeps paging while pages come back full', async () => {
    const calls: Array<[number, number]> = [];
    const rows = await fetchAllRows<number>(async (from, to) => {
      calls.push([from, to]);
      if (from === 0) return page([...Array(3).keys()]);
      if (from === 3) return page([3, 4, 5]);
      return page([6]);
    }, 'test', 3);
    expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(calls).toEqual([[0, 2], [3, 5], [6, 8]]);
  });

  it('a full last page costs one extra empty fetch, not an infinite loop', async () => {
    let calls = 0;
    const rows = await fetchAllRows<number>(async (from) => {
      calls++;
      return from === 0 ? page([1, 2]) : page([]);
    }, 'test', 2);
    expect(rows).toEqual([1, 2]);
    expect(calls).toBe(2);
  });

  it('throws on a page error instead of returning a partial result', async () => {
    await expect(
      fetchAllRows<number>(async (from) =>
        from === 0 ? page([...Array(3).keys()]) : { data: null, error: { message: 'boom' } },
      'invoice links', 3),
    ).rejects.toThrow('Failed to load invoice links: boom');
  });
});

describe('normalizeNsInvoiceStatus', () => {
  it('maps SuiteQL codes and text labels', () => {
    expect(normalizeNsInvoiceStatus('A')).toBe('open');
    expect(normalizeNsInvoiceStatus('B')).toBe('paid');
    expect(normalizeNsInvoiceStatus('Open')).toBe('open');
    expect(normalizeNsInvoiceStatus('Paid In Full')).toBe('paid');
  });
  it('unknown or missing status maps to null', () => {
    expect(normalizeNsInvoiceStatus('C')).toBe(null);
    expect(normalizeNsInvoiceStatus(null)).toBe(null);
    expect(normalizeNsInvoiceStatus(undefined)).toBe(null);
  });
});
