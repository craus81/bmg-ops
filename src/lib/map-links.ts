/**
 * Map links for stored addresses: tap an address anywhere in FleetSuite and
 * it opens in a map. Apple devices (iPhone, iPad, Mac, including the iOS app)
 * get Apple Maps, everything else gets Google Maps — both links are plain
 * https URLs, so on a phone the OS hands them to the installed maps app and
 * on a computer they open the web map.
 *
 * Addresses reach the screens in several shapes (the customers mirror's
 * one-line "addr1, city, ST, zip", the CRM's " · "-joined form, multi-line
 * ship-to blocks, and {street, city, state, zip} objects on CNI jobs), so
 * everything funnels through mapQuery() first.
 */

export type AddressParts = {
  street?: string | null;
  address?: string | null;
  address2?: string | null;
  addr1?: string | null;
  addr2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

export type AddressInput = string | AddressParts | null | undefined;

/** One clean search line ("1200 Main St, O'Fallon, MO 63368"), or '' when
 *  there is nothing a map could find. */
export function mapQuery(input: AddressInput): string {
  if (!input) return '';
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    const street = [input.street ?? input.address ?? input.addr1, input.address2 ?? input.addr2]
      .map(s => (s || '').trim()).filter(Boolean).join(' ');
    const stateZip = [input.state, input.zip].map(s => (s || '').trim()).filter(Boolean).join(' ');
    text = [street, (input.city || '').trim(), stateZip].filter(Boolean).join(', ');
  }
  let lines = text
    .split(/\r?\n|\s+·\s+/)
    .map(s => s.trim().replace(/,+$/, '').trim())
    .filter(Boolean);
  // Ship-to blocks open with a company or contact name ("Acme Fleet\n1200
  // Main St\n…"), which can pull a map search toward some other business.
  // Start at the street line when there is one; with no street, keep the
  // name — it may be all that places the site (a plant name and a city).
  const street = lines.findIndex(l => /^\d+\s+\S/.test(l));
  if (street > 0) lines = lines.slice(street);
  const q = lines
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
  // A map can't place a bare "MO" or a stray "—" placeholder.
  return /[A-Za-z0-9]{3,}/.test(q) ? q : '';
}

/** Apple Maps on iPhone/iPad/Mac. iPadOS reports itself as a Mac, which is
 *  still Apple, so "Macintosh" alone settles it. */
export function isApplePlatform(userAgent: string | null | undefined): boolean {
  return /iPhone|iPad|iPod|Macintosh/.test(userAgent || '');
}

/** The map URL for an address, or null when the address can't be mapped.
 *  `directions` starts turn-by-turn from the person's current location. */
export function mapUrl(
  input: AddressInput,
  opts: { apple?: boolean; directions?: boolean } = {},
): string | null {
  const q = mapQuery(input);
  if (!q) return null;
  const e = encodeURIComponent(q);
  if (opts.apple) {
    return opts.directions ? `https://maps.apple.com/?daddr=${e}` : `https://maps.apple.com/?q=${e}`;
  }
  return opts.directions
    ? `https://www.google.com/maps/dir/?api=1&destination=${e}`
    : `https://www.google.com/maps/search/?api=1&query=${e}`;
}
