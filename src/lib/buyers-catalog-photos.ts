import { skuKeys, nearMatchSkuToPart } from '@/lib/vendor-catalog-import';

/**
 * Buyers Products 2024 catalog photos (Craig 2026-10-27): every product
 * photo cut out of the printed catalog (C2024.pdf), keyed by the part
 * number it belongs to. The images ship as static files under
 * /vendor-photos/buyers-2024/<photo>.jpg; buyers-catalog-2024.json maps
 * each catalog part number to [photo, printed page, exact]. The JSON is
 * loaded by the API route only, so this file stays light for the browser.
 *
 * exact = 1: the catalog prints this part number right under the picture.
 * exact = 0: the part number sits in the table beside the picture, so the
 * photo shows the same product line but may differ in size or finish.
 */
export type CatalogEntry = [photo: string, page: number, exact: 0 | 1];
export const BUYERS_PHOTO_DIR = '/vendor-photos/buyers-2024';

export interface CatalogPart { id: string; item_number: string; is_active: boolean; image_path: string | null }

export interface CatalogPhotoMatch {
  partId: string;
  itemNumber: string;
  catalogNumber: string;
  photo: string;
  page: number;
  /** Photo printed with this exact part number (vs same product line). */
  exactPhoto: boolean;
  /** Part number matched only by prefix/suffix containment (BP-1702700). */
  closeNumber: boolean;
  hasPhoto: boolean;
}

/**
 * Match the catalog to our parts. Exact-or-dashless part numbers first;
 * a part with no exact hit can still take a UNIQUE containment match
 * (catalog 1702700 ↔ ours BP-1702700), flagged closeNumber so the review
 * list leaves it unticked. Inactive parts are skipped. One photo per part:
 * an exact number beats a close one, then an exact photo beats a
 * same-product-line photo.
 */
export function matchCatalogPhotos(
  parts: CatalogPart[],
  catalog: Record<string, CatalogEntry>,
): CatalogPhotoMatch[] {
  const active = parts.filter(p => p.is_active && p.item_number);
  const byKey = new Map<string, string>();
  for (const p of active) for (const k of skuKeys(p.item_number)) if (!byKey.has(k)) byKey.set(k, p.id);
  const byId = new Map(active.map(p => [p.id, p]));

  const best = new Map<string, CatalogPhotoMatch>();
  const rank = (m: CatalogPhotoMatch) => (m.closeNumber ? 0 : 2) + (m.exactPhoto ? 1 : 0);
  const offer = (partId: string, catalogNumber: string, entry: CatalogEntry, closeNumber: boolean) => {
    const part = byId.get(partId)!;
    const m: CatalogPhotoMatch = {
      partId, itemNumber: part.item_number, catalogNumber,
      photo: entry[0], page: entry[1], exactPhoto: entry[2] === 1, closeNumber,
      hasPhoto: !!part.image_path,
    };
    const prev = best.get(partId);
    if (!prev || rank(m) > rank(prev)) best.set(partId, m);
  };

  const unmatched: [string, CatalogEntry][] = [];
  for (const [num, entry] of Object.entries(catalog)) {
    let hit: string | undefined;
    for (const k of skuKeys(num)) { hit = byKey.get(k); if (hit) break; }
    if (hit) offer(hit, num, entry, false);
    else unmatched.push([num, entry]);
  }
  for (const [num, entry] of unmatched) {
    const id = nearMatchSkuToPart(num, byKey);
    if (id) offer(id, num, entry, true);
  }
  return [...best.values()].sort((a, b) => a.itemNumber.localeCompare(b.itemNumber));
}
