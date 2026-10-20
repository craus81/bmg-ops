// Search for the Installer Parts page (src/app/(main)/installer-parts).

/** Every word typed must appear in the part number, name or description. */
export function matchesPartSearch(
  p: { item_number: string; display_name: string | null; description: string | null },
  q: string,
): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${p.item_number} ${p.display_name || ''} ${p.description || ''}`.toLowerCase();
  return words.every(w => hay.includes(w));
}
