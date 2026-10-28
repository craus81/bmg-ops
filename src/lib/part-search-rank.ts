import { partNumberKey } from './loose-search';

/**
 * Order part search results best match first (Craig 2026-10-28: searching
 * "3000" for UP12/3000SD-CG got crowded out by "3000 lb" descriptions).
 *
 *   0  part number is the search (dashes aside)
 *   1  part number starts with it
 *   2  a piece of the part number (after / - space .) starts with it
 *   3  part number holds it somewhere
 *   4  only the name or description matched
 *
 * Ties go by part number. Duplicate ids keep their first copy.
 */
export function partMatchTier(itemNumber: unknown, query: string | null | undefined): number {
  const key = partNumberKey(query);
  if (!key) return 4;
  const num = partNumberKey(itemNumber);
  if (num === key) return 0;
  if (num.startsWith(key)) return 1;
  const pieces = String(itemNumber ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let i = 1; i < pieces.length; i++) {
    if (partNumberKey(pieces.slice(i).join('')).startsWith(key)) return 2;
  }
  if (num.includes(key)) return 3;
  return 4;
}

export function rankPartResults<T extends { id?: string | null; item_number?: string | null }>(
  rows: T[],
  query: string | null | undefined,
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const r of rows) {
    const id = r.id ? String(r.id) : `n:${r.item_number ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(r);
  }
  return unique
    .map(r => ({ r, tier: partMatchTier(r.item_number, query) }))
    .sort((a, b) => a.tier - b.tier || String(a.r.item_number ?? '').localeCompare(String(b.r.item_number ?? '')))
    .map(x => x.r);
}

/** How many results the estimate part search shows at first, and per "Show more". */
export const PART_RESULTS_PAGE = 25;
/** Rows fetched per query; more than this and the count reads "300+". */
export const PART_RESULTS_FETCH = 300;
