/**
 * Shared scan → open-PO matching.
 *
 * A scan matches an open PO when the part numbers are equal (compared
 * case-insensitively and trimmed), the PO line still has remaining capacity
 * (installed < quantity), and the PO ships to where the work was done.
 *
 * Location is a requirement, not a tie-breaker (field ask, 2026-09-21: "when
 * matching PO's the location has to match"). A PO is ruled out when its
 * ship-to and the scan's work location name two *different* known plants —
 * the same part is ordered per plant, so a Kansas City install must never
 * consume a Wentzville PO's line. It cost twice when it did: the wrong
 * plant's PO burned a unit of capacity (and could flip to 'complete'), and
 * invoicing reads the plant back off the PO ship-to plus the scan location,
 * so the invoice booked to the wrong NetSuite location too.
 *
 * What it does NOT do is rule out a PO we simply can't place. A ship-to is
 * AI-extracted from the PO PDF and is often absent, and work locations like
 * "BMG Shop" and "National Fleet" name no plant at all. Those stay eligible:
 * "we don't know" is not "it's the wrong one", and refusing them would strand
 * scans that match fine today. Only a genuine plant-vs-plant disagreement
 * blocks a match, and a scan left with nowhere to go stays unmatched (and is
 * counted in `skippedForLocation`) instead of landing on the wrong PO.
 *
 * This is the single source of truth used by both the retroactive matcher
 * (POST /api/scans/match-po) and the at-scan-time match (POST /api/scans/log).
 *
 * Server-only: callers pass a service-role Supabase client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { compareShipToLocation, normLocationText } from '@/lib/plant-location';
import { shipToCityLabel } from '@/lib/graphics-job-from-po';

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
 * The cities BMG works in, normalized, taken from work_locations rather than
 * hard-coded — adding a plant there teaches the matcher about it.
 *
 * A work location with no city ("BMG Shop", "National Fleet") contributes
 * nothing on purpose: it names no plant, so it can never be the evidence that
 * rules a PO out. Returns null if the table can't be read — the caller must
 * treat that as "don't decide" rather than fall back to matching blind.
 */
async function fetchPlantCities(service: SupabaseClient): Promise<string[] | null> {
  const { data, error } = await service.from('work_locations').select('name, city');
  if (error) return null;
  const cities = new Set<string>();
  for (const row of (data || []) as { city: string | null }[]) {
    const c = normLocationText(row.city);
    if (c) cities.add(c);
  }
  return [...cities];
}

export interface MatchResult {
  matched: number;
  total: number;
  /**
   * Scans that had an open PO line for their part but every one of them
   * shipped to a different plant. They are left unmatched on purpose —
   * surfaced so "waiting on PO" can be told apart from "the part is on a PO,
   * just not this location's".
   */
  skippedForLocation: number;
  /**
   * The same held scans, spelled out: which truck and part, where the work
   * was done, and the open PO lines that had the part but ship elsewhere.
   * "1 left unmatched" alone gave the office nothing to act on.
   */
  heldForLocation: HeldScan[];
}

/** An open PO line a held scan was refused because it ships to another plant. */
export interface HeldCandidate {
  poId: string;
  poNumber: string | null;
  lineId: string;
  /** Where the PO ships, as the PO picker spells it ('' when the PO has no ship-to). */
  shipTo: string;
  remaining: number;
}

export interface HeldScan {
  scanId: string;
  vin: string | null;
  partNumber: string | null;
  locationName: string | null;
  candidates: HeldCandidate[];
}

/** Nothing matched, nothing skipped — the shape every early return needs. */
const EMPTY_RESULT: MatchResult = { matched: 0, total: 0, skippedForLocation: 0, heldForLocation: [] };

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
 *
 * A PO whose ship-to names a different plant than the scan's work location is
 * never chosen — see the file header. When that rules out every candidate the
 * scan is left unmatched and counted in `skippedForLocation`.
 */
export async function matchScansToOpenPos(
  service: SupabaseClient,
  scanIds?: string[],
): Promise<MatchResult> {
  // Paginated: the outstanding-scans sweep is unbounded and a truncated
  // read left scans past the cap permanently unmatchable (Round 3 CRITICAL,
  // R3-1). Scoped calls (scanIds) stay small but ride the same path.
  const { data: unmatched, error: unmatchedErr } = await fetchAllRows<{
    id: string; vin: string | null; part_number: string | null; location_name: string | null; exported_at: string | null;
  }>((from, to) => {
    let query = service
      .from('scan_logs')
      .select('id, vin, part_number, location_name, exported_at')
      .is('po_id', null)
      .is('archived_at', null);
    if (scanIds && scanIds.length > 0) query = query.in('id', scanIds);
    return query.order('id').range(from, to);
  });
  if (unmatchedErr || !unmatched || unmatched.length === 0) return EMPTY_RESULT;

  // Location is a requirement now, so a matcher that can't read the plant
  // list can't safely decide anything — the same "don't decide on a partial
  // read" rule the line fetch follows. Matching blind here is what put Kansas
  // City installs on Wentzville POs in the first place.
  const plantCities = await fetchPlantCities(service);
  if (plantCities === null) return { ...EMPTY_RESULT, total: unmatched.length };

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
  if (posErr || !pos || pos.length === 0) return { ...EMPTY_RESULT, total: unmatched.length };

  const poById = new Map(pos.map(p => [p.id, p]));
  const allLines = await fetchLinesForPos<{ id: string; po_id: string; part_number: string | null; quantity: number | null; installed: number | null }>(
    service, pos.map(p => p.id), 'id, po_id, part_number, quantity, installed',
  );
  // Partial lines would mis-route scans to the wrong PO and bump the wrong
  // line's installed count — skip the sweep and let the next run match.
  if (allLines === null) return { ...EMPTY_RESULT, total: unmatched.length };
  const lines = allLines;

  let matched = 0;
  const heldForLocation: HeldScan[] = [];
  const touchedPoIds: string[] = [];

  for (const scan of unmatched) {
    const scanPart = normalizePart(scan.part_number);
    if (!scanPart) continue;

    // Open lines for this part across all open POs (with remaining capacity).
    const openLines = lines.filter(l =>
      normalizePart(l.part_number) === scanPart && (l.installed || 0) < (l.quantity || 0)
    );
    if (openLines.length === 0) continue;

    // Rule out the POs that ship somewhere else, then prefer one that
    // positively agrees with the scan's location over one we can't place.
    const eligible = openLines
      .map(l => ({ line: l, verdict: compareShipToLocation(poById.get(l.po_id)?.ship_to, scan.location_name, plantCities) }))
      .filter(c => c.verdict !== 'conflict');

    // Every open line for this part belongs to another plant. Leaving the
    // scan unmatched is the point: it shows as waiting on a PO until this
    // location's PO arrives, instead of silently eating another plant's.
    if (eligible.length === 0) {
      heldForLocation.push({
        scanId: scan.id,
        vin: scan.vin,
        partNumber: scan.part_number,
        locationName: scan.location_name,
        candidates: openLines.map(l => {
          const po = poById.get(l.po_id);
          return {
            poId: l.po_id,
            poNumber: po?.po_number ?? null,
            lineId: l.id,
            shipTo: shipToCityLabel(po?.ship_to),
            remaining: (l.quantity || 0) - (l.installed || 0),
          };
        }),
      });
      continue;
    }

    const chosenLine = (eligible.find(c => c.verdict === 'match') || eligible[0]).line;

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

  return { matched, total: unmatched.length, skippedForLocation: heldForLocation.length, heldForLocation };
}

export type AssignResult =
  | { ok: true; poId: string; poNumber: string | null }
  | { ok: false; status: number; error: string };

/**
 * Put one held scan on a PO line the matcher refused for location — the
 * "Assign anyway" button on the match results. The office's call to make:
 * the scan might have been logged at the wrong location, or the other
 * plant's PO really is covering this install.
 *
 * Unlike the bulk editor's PO dropdown, this books the unit the way the
 * matcher would: it bumps the line's installed count and re-checks the PO's
 * fulfilment, so the PO's remaining capacity stays honest.
 *
 * Refuses anything that isn't still the situation the button was shown for:
 * a scan that has since matched or been archived, a line whose part isn't
 * the scan's, a line with nothing left, or a PO that is no longer open.
 */
export async function assignScanToPoLine(
  service: SupabaseClient,
  scanId: string,
  lineId: string,
): Promise<AssignResult> {
  const { data: scan, error: scanErr } = await service
    .from('scan_logs')
    .select('id, part_number, po_id, archived_at')
    .eq('id', scanId)
    .maybeSingle();
  if (scanErr) return { ok: false, status: 500, error: 'Could not read the scan' };
  if (!scan) return { ok: false, status: 404, error: 'Scan not found' };
  if (scan.po_id) return { ok: false, status: 409, error: 'This scan is already on a PO' };
  if (scan.archived_at) return { ok: false, status: 409, error: 'This scan is archived' };

  const { data: line, error: lineErr } = await service
    .from('po_line_items')
    .select('id, po_id, part_number, quantity, installed')
    .eq('id', lineId)
    .maybeSingle();
  if (lineErr) return { ok: false, status: 500, error: 'Could not read the PO line' };
  if (!line) return { ok: false, status: 404, error: 'PO line not found' };
  if (normalizePart(line.part_number) !== normalizePart(scan.part_number)) {
    return { ok: false, status: 409, error: "That PO line is for a different part" };
  }
  if ((line.installed || 0) >= (line.quantity || 0)) {
    return { ok: false, status: 409, error: 'That PO line has no units left' };
  }

  const { data: po, error: poErr } = await service
    .from('purchase_orders')
    .select('id, po_number, status')
    .eq('id', line.po_id)
    .maybeSingle();
  if (poErr) return { ok: false, status: 500, error: 'Could not read the PO' };
  if (!po || po.status !== 'open') return { ok: false, status: 409, error: 'That PO is no longer open' };

  // Only claim the scan if it's still unmatched, so two clicks (or a sweep
  // running at the same moment) can't book it — and the line — twice.
  const { data: claimed, error: claimErr } = await service
    .from('scan_logs')
    .update({ po_id: po.id, po_number: po.po_number, po_line_item_id: line.id })
    .eq('id', scan.id)
    .is('po_id', null)
    .select('id');
  if (claimErr) return { ok: false, status: 500, error: 'Could not update the scan' };
  if (!claimed || claimed.length === 0) return { ok: false, status: 409, error: 'This scan is already on a PO' };

  await service.from('po_line_items').update({
    installed: (line.installed || 0) + 1,
  }).eq('id', line.id);

  await recomputePoFulfillment(service, [po.id]);

  return { ok: true, poId: po.id, poNumber: po.po_number };
}
