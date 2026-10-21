import { describe, it, expect } from 'vitest';
import { chunkIds, fetchByIdChunks, isHistoryTab, archiveWindowStart, ARCHIVE_WINDOW_DAYS } from './scan-log-load';

describe('scan log loading', () => {
  it('treats only the history tabs as load-on-open', () => {
    expect(['exported', 'archived', 'invoices', 'all'].every(isHistoryTab)).toBe(true);
    expect(['ready', 'waiting', 'bulk', 'vendor'].some(isHistoryTab)).toBe(false);
  });

  it('shows three months of archived scans by default', () => {
    expect(ARCHIVE_WINDOW_DAYS).toBe(90);
    const now = Date.UTC(2026, 9, 21);
    expect(archiveWindowStart(now)).toBe(new Date(Date.UTC(2026, 6, 23)).toISOString());
  });

  it('chunks ids', () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkIds([], 2)).toEqual([]);
  });

  it('queries each chunk once, de-dupes ids, and joins rows', async () => {
    const seen: string[][] = [];
    const res = await fetchByIdChunks<{ id: string }>(['a', 'b', 'a', '', 'c'], async (chunk) => {
      seen.push(chunk);
      return { data: chunk.map(id => ({ id })), error: null };
    }, 2);
    expect(seen).toEqual([['a', 'b'], ['c']]);
    expect(res.data.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(res.error).toBeNull();
  });

  it('pages a chunk past 1000 rows', async () => {
    const res = await fetchByIdChunks<number>(['a'], async (_chunk, from, to) => {
      const total = 1500;
      const rows = [];
      for (let i = from; i <= Math.min(to, total - 1); i++) rows.push(i);
      return { data: rows, error: null };
    });
    expect(res.data.length).toBe(1500);
  });

  it('skips the query when there are no ids', async () => {
    let called = false;
    const res = await fetchByIdChunks(['', ''], async () => { called = true; return { data: [], error: null }; });
    expect(called).toBe(false);
    expect(res.data).toEqual([]);
  });

  it('passes a chunk error through', async () => {
    const res = await fetchByIdChunks<string>(['a', 'b'], async (chunk) =>
      chunk[0] === 'b' ? { data: null, error: { message: 'boom' } } : { data: ['ok'], error: null }, 1);
    expect(res.error?.message).toBe('boom');
    expect(res.data).toEqual(['ok']);
  });
});
