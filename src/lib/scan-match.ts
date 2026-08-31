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
import { fetchAllRows } from '@/lib/fetch-all';

function normalizePart(p: string | null | undefined): string {
  return (p || '').trim().toUpperCase();
}

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * All po_line_items for the given POs, immune to both truncation traps: the
 * id list is chunked (a long `.in()` blows the URL limit) and each chunk is
 * paginated past PostgREST's 1000-row cap (Round 3 CRITICAL, R3-1 — a PO
 * whose lines fell past the cap had every *surviving* line satisfied, so it
 * was flipped 'complete' with unreceived lines). Returns null on any read
 * error: callers must treat "couldn't read the lines" as "don't decide".
 */
async function fetchLinesForPos<T>(
  service: SupabaseClient,
  poIds: string[],
  columns: string,
): Promise<T[] | null> {
  const all: T[] = [];
  for (const ids of chunk(poIds, 200)) {
    const { data, error } = await fetchAllRows<T>((from, to) =>
      service
        .from('po_line_items')
        .select(columns)
        .in('po_id', ids)
        .order('id')
        .range(from, to) as any,
    );
    if (error) return null;
    all.push(...data);
  }
  return all;
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
 * Recompute open ↔ complete for the given POs: a PO is complete (fulfilled)
 * when it has at least one line with real quantity and every line's installed
 * count meets its quantity. Only ever flips between 'open' and 'complete' —
 * closed/cancelled POs are never touched.
 */
export async function recomputePoFulfillment(service: SupabaseClient, poIds: string[]): Promise<void> {
  const ids = [...new Set(poIds)].filter(Boolean);
  if (ids.length === 0) return;

  // Chunked: callers can pass an arbitrarily long touched-PO list.
  const posRows: { id: string; status: string }[] = [];
  for (const batch of chunk(ids, 200)) {
    const { data, error } = await service
      .from('purchase_orders')
      .select('id, status')
      .in('id', batch)
      .in('status', ['open', 'complete']);
    if (error) return; // can't see the POs → change nothing
    posRows.push(...(data || []));
  }
  if (posRows.length === 0) return;

  const lines = await fetchLinesForPos<{ po_id: string; quantity: number | null; installed: number | null }>(
    service, posRows.map(p => p.id), 'po_id, quantity, installed',
  );
  // A partial/failed line read must never drive a flip: with lines missing,
  // a complete PO reads as unfulfilled (flipped back open) or an open PO's
  // surviving lines all read satisfied (flipped complete) — both wrong.
  if (lines === null) return;

  for (const po of posRows) {
    const poLines = lines.filter(l => l.po_id === po.id);
    const fulfilled =
      poLines.length > 0 &&
      poLines.reduce((sum, l) => sum + (l.quantity || 0), 0) > 0 &&
      poLines.every(l => (l.installed || 0) >= (l.quantity || 0));
    const next = fulfilled ? 'complete' : 'open';
    if (next !== po.status) {
      await service.from('purchase_orders').update({ status: next }).eq('id', po.id);
    }
  }
}

/**
 * Match unmatched, unarchived scans to open POs. Exported scans ARE included
 * — a VIN exported before its PO arrived still deserves the link (billing
 * reports key on it), and lifecycle state is derived stamp-first so setting
 * po_id never changes an exported scan's displayed state. Archived/invoiced
 * scans stay excluded: that history is settled and shouldn't consume open PO
 * capacity. Pass `scanIds` to limit to specific scans (e.g. the one just
 * logged); omit to sweep all outstanding scans. Increments
 * po_line_items.installed for each match.
 */
export async function matchScansToOpenPos(
  service: SupabaseClient,
  scanIds?: string[],
): Promise<MatchResult> {
  // Paginated: the outstanding-scans sweep is unbounded and a truncated
  // read left scans past the cap permanently unmatchable (Round 3 CRITICAL,
  // R3-1). Scoped calls (scanIds) stay small but ride the same path.
  const { data: unmatched, error: unmatchedErr } = await fetchAllRows<{
    id: string; part_number: string | null; location_name: string | null; exported_at: string | null;
  }>((from, to) => {
    let query = service
      .from('scan_logs')
      .select('id, part_number, location_name, exported_at')
      .is('po_id', null)
      .is('archived_at', null);
    if (scanIds && scanIds.length > 0) query = query.in('id', scanIds);
    return query.order('id').range(from, to);
  });
  if (unmatchedErr || !unmatched || unmatched.length === 0) return { matched: 0, total: 0 };

  // When PO capacity is scarce, active (unexported) scans claim lines first —
  // they need the match to reach "Ready"; for exported scans it's enrichment.
  unmatched.sort((a, b) => (a.exported_at ? 1 : 0) - (b.exported_at ? 1 : 0));

  const { data: pos, error: posErr } = await fetchAllRows<{ id: string; po_number: string | null; ship_to: any }>((from, to) =>
    service
      .from('purchase_orders')
      .select('id, po_number, ship_to')
      .eq('status', 'open')
      .order('id')
      .range(from, to),
  );
  if (posErr || !pos || pos.length === 0) return { matched: 0, total: unmatched.length };

  const poById = new Map(pos.map(p => [p.id, p]));
  const allLines = await fetchLinesForPos<{ id: string; po_id: string; part_number: string | null; quantity: number | null; installed: number | null }>(
    service, pos.map(p => p.id), 'id, po_id, part_number, quantity, installed',
  );
  // Partial lines would mis-route scans to the wrong PO and bump the wrong
  // line's installed count — skip the sweep and let the next run match.
  if (allLines === null) return { matched: 0, total: unmatched.length };
  const lines = allLines;

  let matched = 0;
  const touchedPoIds: string[] = [];

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
    touchedPoIds.push(po.id);
    matched++;
  }

  // A match may have filled a PO's last remaining unit — mark it fulfilled
  // so it moves off the open list automatically.
  await recomputePoFulfillment(service, touchedPoIds);

  return { matched, total: unmatched.length };
}
