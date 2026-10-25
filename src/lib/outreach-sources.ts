import { areaMiles, AREA_ZIP3, OUTREACH_ORIGIN, OUTREACH_RADIUS_MILES } from './outreach-area';
import { haversineMiles, type Coord } from './invite-matching';

/**
 * Where Outreach finds companies (migration 438). Two free-or-cheap public
 * sources, each turned into the same OutreachCandidate shape:
 *
 *  - FLEETS: the federal DOT carrier census (FMCSA "Company Census File" on
 *    data.transportation.gov). Every company that registers trucks with the
 *    DOT is in it, with its address, phone, often an email, and how many
 *    power units it runs. Free; no key needed.
 *  - TRADES: Google business listings (Places API "Text Search") for
 *    plumbers, HVAC, electricians and the like near the shop. Gives phone
 *    and website, not email (the research step reads the website for that).
 *    Needs GOOGLE_MAPS_API_KEY; about $0.035 per search.
 *
 * Pure parsers (parseDotRow, parsePlace) are split from the fetches so the
 * tests can pin them without the network.
 */

export interface OutreachCandidate {
  source: 'dot' | 'google';
  sourceId: string;
  kind: 'fleet' | 'trade';
  companyName: string;
  trade: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  miles: number;
  phone: string | null;
  email: string | null;
  website: string | null;
  fleetSize: number | null;
  facts: Record<string, unknown>;
}

/** Fleets small enough to want a local upfitter, big enough to be a fleet. */
export const MIN_FLEET = 5;
export const MAX_FLEET = 500;

const str = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s ? s : null;
};
const int = (v: unknown): number | null => {
  const n = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

/** "ACME TRUCKING LLC" → "Acme Trucking LLC". DOT names are all caps. */
export function tidyName(name: string): string {
  if (name !== name.toUpperCase()) return name.trim();
  const keep = new Set(['LLC', 'INC', 'LP', 'LLP', 'PC', 'CO', 'USA', 'II', 'III', 'HVAC']);
  return name.trim().toLowerCase().split(/\s+/).map(w => {
    if (keep.has(w.toUpperCase().replace(/[.,]/g, ''))) return w.toUpperCase();
    return w.replace(/(^|[-/&'])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  }).join(' ');
}

export function formatPhone(raw: string | null): string | null {
  const d = String(raw || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (d.length !== 10) return str(raw);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// ── DOT carrier census ───────────────────────────────────────────────────

const DOT_URL = 'https://data.transportation.gov/resource/az4n-8mr2.json';
const DOT_FIELDS = [
  'dot_number', 'legal_name', 'dba_name', 'phy_street', 'phy_city', 'phy_state', 'phy_zip',
  'telephone', 'email_address', 'nbr_power_unit', 'driver_total', 'carrier_operation',
];
const DOT_PAGE = 5000;

/** One census row → a candidate, or null when it isn't a fit. */
export function parseDotRow(r: Record<string, unknown>): OutreachCandidate | null {
  const dot = str(r.dot_number);
  const legal = str(r.legal_name);
  if (!dot || !legal) return null;
  const miles = areaMiles(str(r.phy_zip));
  if (miles == null) return null;
  const units = int(r.nbr_power_unit);
  if (units == null || units < MIN_FLEET || units > MAX_FLEET) return null;
  const phone = formatPhone(str(r.telephone));
  const email = str(r.email_address)?.toLowerCase() || null;
  if (!phone && !email) return null;
  const dba = str(r.dba_name);
  return {
    source: 'dot',
    sourceId: dot,
    kind: 'fleet',
    companyName: tidyName(dba || legal),
    trade: null,
    street: str(r.phy_street) ? tidyName(str(r.phy_street)!) : null,
    city: str(r.phy_city) ? tidyName(str(r.phy_city)!) : null,
    state: str(r.phy_state),
    zip: str(r.phy_zip)?.slice(0, 5) || null,
    miles,
    phone,
    email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
    website: null,
    fleetSize: units,
    facts: {
      usdot: dot,
      legalName: tidyName(legal),
      drivers: int(r.driver_total),
      carrierOperation: str(r.carrier_operation),
    },
  };
}

/** The SoQL filter: physical address ZIP starts with an area ZIP3. The exact
 *  ZIP and fleet size are checked here rather than there, because the census
 *  keeps ZIP+4 and stores counts as text. */
export function dotWhere(): string {
  return `(${AREA_ZIP3.map(z => `starts_with(phy_zip, '${z}')`).join(' OR ')})`;
}

/** Every area fleet in the census. Throws a plain message on failure. */
export async function fetchDotFleets(fetchImpl: typeof fetch = fetch): Promise<OutreachCandidate[]> {
  const out: OutreachCandidate[] = [];
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;
  let select = true;
  for (let offset = 0; offset < 200_000; offset += DOT_PAGE) {
    const qs = new URLSearchParams({
      $where: dotWhere(), $order: 'dot_number', $limit: String(DOT_PAGE), $offset: String(offset),
    });
    if (select) qs.set('$select', DOT_FIELDS.join(','));
    const res = await fetchImpl(`${DOT_URL}?${qs}`, { headers, cache: 'no-store' });
    if (res.status === 400 && select && offset === 0) {
      // A renamed column fails the whole $select. Ask for whole rows instead.
      select = false;
      offset -= DOT_PAGE;
      continue;
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`The DOT carrier list didn't answer (${res.status}${body ? `: ${body}` : ''})`);
    }
    const rows = await res.json() as Record<string, unknown>[];
    for (const r of rows) {
      const c = parseDotRow(r);
      if (c) out.push(c);
    }
    if (rows.length < DOT_PAGE) break;
  }
  return out;
}

// ── Google business listings ─────────────────────────────────────────────

export const TRADE_SEARCHES: { trade: string; query: string }[] = [
  { trade: 'Plumbing', query: 'plumber' },
  { trade: 'HVAC', query: 'HVAC contractor' },
  { trade: 'Electrical', query: 'electrician' },
  { trade: 'Landscaping', query: 'landscaping company' },
  { trade: 'Roofing', query: 'roofing contractor' },
  { trade: 'Pest control', query: 'pest control' },
  { trade: 'Garage doors', query: 'garage door company' },
  { trade: 'Restoration', query: 'water damage restoration' },
];

/** Search centres, rotated week to week so the list doesn't keep finding the
 *  same top results around one town. */
export const SEARCH_CENTRES: (Coord & { name: string })[] = [
  { name: "O'Fallon", latitude: 38.8239, longitude: -90.7427 },
  { name: 'St. Charles', latitude: 38.8014, longitude: -90.5065 },
  { name: 'Wentzville', latitude: 38.802, longitude: -90.8534 },
  { name: 'Bridgeton', latitude: 38.7506, longitude: -90.4161 },
  { name: 'Chesterfield', latitude: 38.6491, longitude: -90.5358 },
  { name: 'St. Louis', latitude: 38.6346, longitude: -90.1913 },
  { name: 'South County', latitude: 38.4566, longitude: -90.3282 },
  { name: 'Arnold', latitude: 38.4305, longitude: -90.387 },
  { name: 'Festus', latitude: 38.1879, longitude: -90.4286 },
  { name: 'Washington', latitude: 38.5459, longitude: -91.0193 },
  { name: 'Troy', latitude: 39.0012, longitude: -90.9624 },
  { name: 'Alton', latitude: 38.9087, longitude: -90.1568 },
  { name: 'Edwardsville', latitude: 38.805, longitude: -89.9637 },
  { name: 'Collinsville', latitude: 38.6835, longitude: -89.9853 },
  { name: 'Belleville', latitude: 38.5127, longitude: -89.9847 },
];

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents',
  'places.location', 'places.nationalPhoneNumber', 'places.websiteUri', 'places.types',
  'places.businessStatus', 'places.userRatingCount', 'places.googleMapsUri', 'nextPageToken',
].join(',');

const component = (p: any, type: string, short = false): string | null => {
  const c = (p.addressComponents || []).find((a: any) => (a.types || []).includes(type));
  return c ? str(short ? c.shortText : c.longText) : null;
};

/** One Places result → a candidate, or null when it isn't a fit. */
export function parsePlace(p: any, trade: string): OutreachCandidate | null {
  const id = str(p?.id);
  const name = str(p?.displayName?.text);
  if (!id || !name) return null;
  if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') return null;
  const zip = component(p, 'postal_code');
  let miles = areaMiles(zip);
  if (miles == null && p.location?.latitude != null) {
    const m = Math.round(haversineMiles(OUTREACH_ORIGIN, p.location));
    if (m <= OUTREACH_RADIUS_MILES) miles = m;
  }
  if (miles == null) return null;
  const phone = formatPhone(str(p.nationalPhoneNumber));
  const website = str(p.websiteUri);
  if (!phone && !website) return null;
  const number = component(p, 'street_number');
  const route = component(p, 'route');
  return {
    source: 'google',
    sourceId: id,
    kind: 'trade',
    companyName: name,
    trade,
    street: [number, route].filter(Boolean).join(' ') || null,
    city: component(p, 'locality'),
    state: component(p, 'administrative_area_level_1', true),
    zip,
    miles,
    phone,
    email: null,
    website,
    fleetSize: null,
    facts: {
      address: str(p.formattedAddress),
      googleMapsUrl: str(p.googleMapsUri),
      reviews: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      types: Array.isArray(p.types) ? p.types.slice(0, 6) : [],
    },
  };
}

export const hasGoogleKey = (): boolean => !!process.env.GOOGLE_MAPS_API_KEY;

/** Up to 60 listings (3 pages) for one trade around one centre. */
export async function searchTrade(
  search: { trade: string; query: string },
  centre: Coord,
  fetchImpl: typeof fetch = fetch,
): Promise<OutreachCandidate[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Trade contractors need a Google Maps API key (GOOGLE_MAPS_API_KEY in Vercel)');
  const out: OutreachCandidate[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page++) {
    const res = await fetchImpl(PLACES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACES_FIELDS },
      body: JSON.stringify({
        textQuery: search.query,
        pageSize: 20,
        locationBias: { circle: { center: centre, radius: 40000 } },
        ...(pageToken ? { pageToken } : {}),
      }),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      const why = data?.error?.message || `status ${res.status}`;
      throw new Error(`Google business search didn't work: ${why}`);
    }
    for (const p of data.places || []) {
      const c = parsePlace(p, search.trade);
      if (c) out.push(c);
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}
