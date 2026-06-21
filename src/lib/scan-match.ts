/**
 * Shared scan → open-PO matching.
 *
 * A scan matches an open PO when the part numbers are equal (compared
 * case-insensitively and trimmed) and the PO line still has remaining capacity
 * (installed < quantity). When several open POs carry the same part, a scan
 * whose location lines up with a PO's ship-to is preferred — but location is
 * only a tie-breaker, never a hard filter, so a part match always connects to
 * *some* open PO with capacity.
 *
 * This is the single source of truth used by both the retroactive matcher
 * (POST /api/scans/match-po) and the at-scan-time match (POST /api/scans/log).
 *
 * Server-only: callers pass a service-role Supabase client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

function normalizePart(p: string | null | undefined): string {
  return (p || '').trim().toUpperCase();
}

/**
 * Does a PO's ship_to plausibly correspond to a scan's location_name?
 * Scan locations often look like "Masterack - Kansas City"; we compare the
 * city portion against the ship_to name/city, both directions, fuzzily.
 */
export function shipToMatchesLocation(shipTo: any, locationName: string | null | undefined): boolean {
  if (!shipTo || !locationName) return false;
  const locLower = locationName.toLowerCase();
  const shipName = (shipTo.name || '').toLowerCase();
  const shipCity = (shipTo.city || '').toLowerCase();
  const locCity = (locLower.includes(' - ') ? locLower.split(' - ')[1] : locLower).trim();
  if (!locCity) return false;
  return (
    (!!shipName && shipName.includes(locCity)) ||
    (!!shipCity && (shipCity.includes(locCity) || locCity.includes(shipCity)))
  );
}

export interface MatchResult { matched: number; total: number; }

/**
 * Match unmatched, unexported, unarchived scans to open POs. Pass `scanIds` to
 * limit to specific scans (e.g. the one just logged); omit to sweep all
 * outstanding scans. Increments po_line_items.installed for each match.
 */
export async function matchScansToOpenPos(
  service: SupabaseClient,
  scanIds?: string[],
): Promise<MatchResult> {
  let query = service
    .from('scan_logs')
    .select('id, part_number, location_name')
    .is('po_id', null)
    .is('exported_at', null)
    .is('archived_at', null);
  if (scanIds && scanIds.length > 0) query = query.in('id', scanIds);

  const { data: unmatched } = await query;
  if (!unmatched || unmatched.length === 0) return { matched: 0, total: 0 };

  const { data: pos } = await service
    .from('purchase_orders')
    .select('id, po_number, ship_to')
    .eq('status', 'open');
  if (!pos || pos.length === 0) return { matched: 0, total: unmatched.length };

  const poById = new Map(pos.map(p => [p.id, p]));
  const { data: allLines } = await service
    .from('po_line_items')
    .select('id, po_id, part_number, quantity, installed')
    .in('po_id', pos.map(p => p.id));
  const lines = allLines || [];

  let matched = 0;

  for (const scan of unmatched) {
    const scanPart = normalizePart(scan.part_number);
    if (!scanPart) continue;

    // Open lines for this part across all open POs (with remaining capacity).
    const openLines = lines.filter(l =>
      normalizePart(l.part_number) === scanPart && (l.installed || 0) < (l.quantity || 0)
    );
    if (openLines.length === 0) continue;

    // Prefer a PO whose ship_to matches the scan's location; otherwise take the
    // first open line. Location is a tie-breaker, not a requirement.
    const chosenLine =
      (scan.location_name &&
        openLines.find(l => shipToMatchesLocation(poById.get(l.po_id)?.ship_to, scan.location_name))) ||
      openLines[0];

    const po = poById.get(chosenLine.po_id);
    if (!po) continue;

    await service.from('scan_logs').update({
      po_id: po.id,
      po_number: po.po_number,
      po_line_item_id: chosenLine.id,
    }).eq('id', scan.id);

    await service.from('po_line_items').update({
      installed: (chosenLine.installed || 0) + 1,
    }).eq('id', chosenLine.id);

    // Reflect the consumed capacity for subsequent scans in this sweep.
    chosenLine.installed = (chosenLine.installed || 0) + 1;
    matched++;
  }

  return { matched, total: unmatched.length };
}
