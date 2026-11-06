/**
 * Extra parts for one vehicle on the Scan screen (Craig, 2026-11-06).
 *
 * A run is started with the part every truck gets (a decal kit), but some
 * trucks also take a part of their own: a unit-number decal whose part number
 * changes truck to truck. The installer adds those under "Extra parts for this
 * vehicle"; each one saves as its own scan_logs row (own pay rate, own PO
 * match) next to the shift's parts. The list stays until the installer clears
 * it.
 */
import { partsToSplit } from './scan-part-split';
import { isVerizonRfidPart } from './rfid';

export interface ExtraPartCatalogItem {
  item_number: string;
  display_name?: string | null;
  description?: string | null;
  billable_customer?: string | null;
}

export interface ScanPartLine {
  partNumber: string;
  partDesc: string;
  billable: string | null;
}

const key = (s: string) => s.trim().toUpperCase();

/**
 * Add what the installer typed (or picked) to the extra parts. "A/B" adds
 * both, unless the catalog has an item whose own number is "A/B". A number
 * that matches a catalog item takes the catalog's spelling; anything else is
 * kept as typed. Parts already on the list, or already in the shift's parts,
 * are skipped. The Verizon RFID part is refused: it captures device numbers
 * and has to be scanned by itself.
 */
export function addExtraParts(
  current: string[],
  typed: string,
  opts: { catalog?: ExtraPartCatalogItem[]; baseParts?: string[] } = {},
): { parts: string[]; error: string | null } {
  const catalog = opts.catalog || [];
  const pieces = partsToSplit(typed, catalog.map(c => c.item_number)) ?? [typed.trim()];
  const byKey = new Map(catalog.map(c => [key(c.item_number), c.item_number]));
  const taken = new Set([...current, ...(opts.baseParts || [])].map(key));
  const out = [...current];
  for (const raw of pieces) {
    const pn = byKey.get(key(raw)) || raw.trim();
    if (!pn) continue;
    if (isVerizonRfidPart(pn)) {
      return { parts: current, error: 'The Verizon RFID part has to be scanned by itself. Start a run with just that part.' };
    }
    if (taken.has(key(pn))) continue;
    taken.add(key(pn));
    out.push(pn);
  }
  return { parts: out, error: null };
}

/**
 * The lines one vehicle saves: the shift's parts first, then each extra part
 * not already among them. An extra part's description and billable customer
 * come from the catalog when it is there.
 */
export function withExtraParts(
  base: ScanPartLine[],
  extras: string[],
  catalog: ExtraPartCatalogItem[],
  fallbackBillable: string | null,
): ScanPartLine[] {
  const byKey = new Map(catalog.map(c => [key(c.item_number), c]));
  const seen = new Set(base.map(b => key(b.partNumber)));
  const out = [...base];
  for (const pn of extras) {
    if (!pn.trim() || seen.has(key(pn))) continue;
    seen.add(key(pn));
    const c = byKey.get(key(pn));
    out.push({
      partNumber: c?.item_number || pn.trim(),
      partDesc: c ? c.display_name || c.description || c.item_number : pn.trim(),
      billable: c?.billable_customer || fallbackBillable || null,
    });
  }
  return out;
}
