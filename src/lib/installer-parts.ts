// Search for the Installer Parts page (src/app/(main)/installer-parts).

import { partNumberIncludes } from './loose-search';

/**
 * Every word typed must appear in the part number, name or description, or
 * the typed part number matches with its dashes ignored.
 */
export function matchesPartSearch(
  p: { item_number: string; display_name: string | null; description: string | null },
  q: string,
): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${p.item_number} ${p.display_name || ''} ${p.description || ''}`.toLowerCase();
  // The part number also matches with its dashes ignored ("ar2000" → AR-2000).
  return words.every(w => hay.includes(w)) || partNumberIncludes(p.item_number, q);
}
