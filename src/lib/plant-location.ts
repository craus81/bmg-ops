/**
 * Placing a PO and a scan at the same plant.
 *
 * BMG orders the same part separately for each plant, so a purchase order
 * belongs to exactly one location and an install done at one plant must never
 * consume another plant's PO line (field ask, 2026-09-21: "when matching PO's
 * the location has to match").
 *
 * Both sides of that comparison are messy free text. A PO's ship-to is
 * extracted from the PDF by the importer and reads things like
 * "MFG Wentzville MO Install Wentzville" — often with no city field at all,
 * and frequently missing outright. A scan's work location comes from
 * work_locations and reads "Masterack - Kansas City", or names no plant at
 * all ("BMG Shop", "National Fleet"). So this compares by the plant *cities*
 * BMG actually works in, and reports "I can't place this" as its own answer
 * rather than guessing.
 *
 * Pure text, no I/O — the caller supplies the plant-city list (it comes from
 * work_locations, so adding a plant there teaches this about it) and both the
 * matcher and the admin UI share it.
 */

/** Lowercase and strip everything but a-z0-9, so "O'Fallon" === "O Fallon". */
export function normLocationText(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Which known plant cities a piece of address text names. Matched as a
 * substring of the normalized text because the real values contain the city
 * without ever equalling it — "MFG Wentzville MO Install Wentzville",
 * "Masterack - Kansas City".
 */
export function plantsNamedIn(text: string | null | undefined, plantCities: string[]): string[] {
  const blob = normLocationText(text);
  if (!blob) return [];
  return plantCities.filter(c => blob.includes(c));
}

/** How a PO's ship-to stands against the location a scan was done at. */
export type LocationVerdict = 'match' | 'conflict' | 'unknown';

export interface ShipTo {
  name?: string | null;
  city?: string | null;
}

/**
 * Compare a PO's ship-to with a scan's work location.
 *
 * 'match'    — both name a plant and they agree.
 * 'conflict' — both name a plant and they disagree. The only verdict that
 *              blocks a match.
 * 'unknown'  — at least one side names no plant we know: no ship-to on the
 *              PO, or a work location like "BMG Shop". Still eligible, but
 *              ranked behind a positive match. "We don't know" must not be
 *              treated as "it's the wrong one" — most POs would be refused.
 *
 * Reads the facility name and city only, never the street address: a road
 * named after a neighbouring town would otherwise place the PO at the wrong
 * plant, which is exactly the mistake this is here to prevent.
 */
export function compareShipToLocation(
  shipTo: ShipTo | null | undefined,
  locationText: string | null | undefined,
  plantCities: string[],
): LocationVerdict {
  const poPlants = plantsNamedIn([shipTo?.name, shipTo?.city].filter(Boolean).join(' '), plantCities);
  const scanPlants = plantsNamedIn(locationText, plantCities);
  if (poPlants.length === 0 || scanPlants.length === 0) return 'unknown';
  return poPlants.some(c => scanPlants.includes(c)) ? 'match' : 'conflict';
}

/**
 * Do two location labels refer to the same place? Used by the admin PO picker
 * to flag a PO that ships somewhere other than where the selected scans were
 * done — a display hint only, so it compares the two labels directly rather
 * than needing the plant list. "Kansas City" and "Masterack - Kansas City"
 * are the same place; either being blank means we can't say, so it says yes.
 */
export function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normLocationText(a);
  const y = normLocationText(b);
  if (!x || !y) return true;
  return x.includes(y) || y.includes(x);
}
