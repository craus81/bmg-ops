/**
 * Loading helpers for the Scan Log (/admin/scans).
 *
 * The log used to read every scan, PO, CNI vehicle and pay credit on open,
 * which got slower with every week of history. Now only the work still
 * waiting to be exported loads up front; the history tabs load the first
 * time one is opened, and the per-scan lookups read just the scans on hand.
 */
import { fetchAllRows } from '@/lib/fetch-all';

/** Tabs that need exported + archived scans — they load on first open. */
export const HISTORY_TABS = ['exported', 'archived', 'invoices', 'all'] as const;

export const isHistoryTab = (tab: string): boolean =>
  (HISTORY_TABS as readonly string[]).includes(tab);

/** Archived history shown by default; "Load older" lifts it. */
export const ARCHIVE_WINDOW_DAYS = 90;

export const archiveWindowStart = (now = Date.now()) =>
  new Date(now - ARCHIVE_WINDOW_DAYS * 86_400_000).toISOString();

/** Split ids into .in() sized chunks (keeps each request URL short). */
export function chunkIds<T>(ids: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Run one query per chunk of ids, all at once, and join the rows. Each chunk
 * still pages past the 1000-row cap. The query must order by a unique key.
 * Returns the first error alongside whatever rows did arrive.
 */
export async function fetchByIdChunks<T>(
  ids: string[],
  makeQuery: (chunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  size = 200,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { data: [], error: null };
  const results = await Promise.all(
    chunkIds(unique, size).map(chunk => fetchAllRows<T>((from, to) => makeQuery(chunk, from, to))),
  );
  return {
    data: results.flatMap(r => r.data),
    error: results.find(r => r.error)?.error ?? null,
  };
}
