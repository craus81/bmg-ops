/**
 * Invoice location resolver — decides which NetSuite Location a FleetSuite
 * invoice should book to, from the invoice's customer and PO ship-to.
 *
 * BMG bills from four NetSuite locations. The rule, per ops:
 *   - Masterack          → the plant the work shipped to: Social Circle,
 *                          Wentzville, or Kansas City (chosen from the ship-to
 *                          city / work-location name).
 *   - Designs That Stick → Kansas City.
 *   - Everything else     → O'Fallon (the BMG shop, and the catch-all default
 *                          so an invoice never fails for lack of a location).
 *
 * Note that "everything else" is literal: a non-Masterack customer that happens
 * to ship to (say) Kansas City still books to O'Fallon. Only Masterack and
 * Designs That Stick ever resolve to a non-O'Fallon location.
 *
 * This is "name-match only" by design — there is no per-PO mapping table or
 * admin UI; the rules live here. If BMG adds a location, or a customer that
 * bills to a non-O'Fallon site, extend pickInvoiceLocationName below.
 */

import { suiteqlQuery } from './netsuite';

/** Canonical NetSuite location names, spelled as they appear in NetSuite. */
export type NsLocationName = "O'Fallon" | 'Kansas City' | 'Wentzville' | 'Social Circle';

/**
 * Fallback NetSuite internal ids for the four known locations, keyed by the
 * normalized location name. Used only when the live name→id lookup can't reach
 * NetSuite (or the name isn't found). These are BMG's production location ids;
 * a NetSuite internal id is stable once assigned. resolveInvoiceLocation()
 * prefers the live value and only falls back to these.
 */
export const KNOWN_LOCATION_IDS: Record<string, string> = {
  ofallon: '1',
  wentzville: '2',
  kansascity: '3',
  socialcircle: '5',
};

export interface LocationHint {
  /** Customer name (e.g. "Masterack LLC", "Designs That Stick"). */
  customerName?: string | null;
  /** PO ship-to city — the strongest signal for which Masterack plant. */
  city?: string | null;
  /** PO ship-to / facility name. */
  name?: string | null;
  /** Work-location name from a scan (e.g. "Masterack - Kansas City"). */
  locationName?: string | null;
}

/** Lowercase and strip everything but a–z0–9 so "O'Fallon" === "O Fallon". */
function norm(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface LocationDecision {
  name: NsLocationName;
  /**
   * Whether the location is a positive match rather than a fallback. False
   * only for a Masterack invoice whose plant we couldn't identify — there we
   * fall back to O'Fallon as a placeholder, not a real match. The retroactive
   * backfill uses this to avoid overwriting an already-correct plant location
   * with that O'Fallon guess.
   */
  confident: boolean;
}

/**
 * Pure rule: pick the NetSuite location for a customer + ship-to, plus a
 * `confident` flag (see LocationDecision). Does no NetSuite I/O, so it is
 * cheap and unit-tested in isolation.
 */
export function pickInvoiceLocation(hint: LocationHint): LocationDecision {
  const cust = norm(hint.customerName);
  // Everything we know about where the work happened, in one normalized blob.
  const blob = norm(
    [hint.city, hint.name, hint.locationName, hint.customerName].filter(Boolean).join(' ')
  );

  const isMasterack = cust.includes('masterack') || blob.includes('masterack');
  if (isMasterack) {
    // Distinguish the three Masterack plants by the ship-to / work location.
    if (blob.includes('socialcircle')) return { name: 'Social Circle', confident: true };
    if (blob.includes('wentzville')) return { name: 'Wentzville', confident: true };
    if (blob.includes('kansascity')) return { name: 'Kansas City', confident: true };
    // Masterack PO whose plant we can't identify — O'Fallon as a placeholder,
    // not a positive match. Fine for a new invoice; the backfill must NOT use
    // this to overwrite an existing plant location (see `confident`).
    return { name: "O'Fallon", confident: false };
  }

  if (cust.includes('designsthatstick') || blob.includes('designsthatstick')) {
    return { name: 'Kansas City', confident: true };
  }

  // Everything else books to O'Fallon.
  return { name: "O'Fallon", confident: true };
}

/** Back-compat convenience: just the resolved location name. */
export function pickInvoiceLocationName(hint: LocationHint): NsLocationName {
  return pickInvoiceLocation(hint).name;
}

// Memoized live name→id map for NetSuite locations (a ~4-row reference table).
let locCache: { at: number; map: Map<string, string> } | null = null;
const LOC_TTL_MS = 60 * 60 * 1000; // 1h — locations are slow-changing reference data

async function getLocationNameToId(): Promise<Map<string, string>> {
  if (locCache && Date.now() - locCache.at < LOC_TTL_MS) return locCache.map;
  const map = new Map<string, string>();
  try {
    const result = await suiteqlQuery("SELECT id, name FROM location WHERE isinactive = 'F'");
    for (const row of result?.items || []) {
      const key = norm(row.name);
      if (key && row.id != null) map.set(key, row.id.toString());
    }
  } catch {
    // NetSuite unreachable — fall back to KNOWN_LOCATION_IDS below.
  }
  locCache = { at: Date.now(), map };
  return map;
}

/** Test seam: drop the memoized location map so a test can re-stub the lookup. */
export function __resetLocationCache(): void {
  locCache = null;
}

/**
 * Resolve the NetSuite location for an invoice. Applies the customer/plant
 * rules, then maps the chosen location name to its internal id via a live
 * (cached) NetSuite lookup, falling back to the known production ids and
 * finally NETSUITE_DEFAULT_LOCATION_ID. Returns the name too, for logging /
 * dry-run output.
 */
export async function resolveInvoiceLocation(
  hint: LocationHint
): Promise<{ id: string | null; name: NsLocationName; confident: boolean }> {
  const { name, confident } = pickInvoiceLocation(hint);
  const key = norm(name);
  const map = await getLocationNameToId();
  const id = map.get(key) || KNOWN_LOCATION_IDS[key] || process.env.NETSUITE_DEFAULT_LOCATION_ID || null;
  return { id, name, confident };
}
