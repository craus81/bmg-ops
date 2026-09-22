/**
 * Paste-to-estimate drafter (R6-9): an RFQ in an email becomes a reviewable
 * grid of estimate lines.
 *
 * The model's ONLY job is reading the customer's words — what they asked
 * for, how many, and how many vehicles. Everything that costs money is
 * resolved from the catalog afterwards, in code:
 *
 *  - PRICE IS NEVER FROM THE MODEL. A plausible-looking invented price is
 *    the worst possible output of this feature: it would be quoted, sent,
 *    and signed. Price comes from netsuite_parts.sales_price or the line is
 *    flagged as having no catalog price — never 0, which is a real price.
 *  - AN UNSTATED QUANTITY IS NULL, NOT 1. "We need roof racks" does not say
 *    how many, and defaulting to one quietly under-quotes a fleet order.
 *  - A WEAK MATCH IS A SUGGESTION, NEVER A SELECTION. It carries the text it
 *    matched and how well, so the rep confirms rather than discovers later.
 *  - AN UNMATCHED REQUEST STAYS UNMATCHED. It becomes a custom line the rep
 *    prices, not a guess at the nearest catalog item.
 */

export const DRAFT_MODEL = 'claude-opus-5';

/** Below this overlap a candidate is not offered at all. */
export const MIN_MATCH_SCORE = 0.45;

export const DRAFT_SYSTEM = `You read a customer's request for quote and list what they asked for.

Return ONLY a JSON object, no prose, shaped:
{"vehicleCount": number|null, "lines": [{"raw": string, "itemNumber": string|null, "description": string, "quantity": number|null}]}

Rules:
- "raw" is the customer's own wording for that item, quoted from the text.
- "itemNumber" ONLY if the text states a part number. Never construct, guess or complete one.
- "quantity" ONLY if the text states it. If they did not say, use null. Do not assume one.
- "vehicleCount" ONLY if the text says how many vehicles the work covers. Otherwise null.
- NEVER include a price. You are not being asked what anything costs.
- One entry per distinct thing requested. Do not split a single item into components,
  and do not merge two different items into one line.
- If the text contains no request for goods or work, return {"vehicleCount":null,"lines":[]}.`;

export interface DraftRequestLine {
  raw: string;
  itemNumber: string | null;
  description: string;
  quantity: number | null;
}

export interface DraftExtraction {
  vehicleCount: number | null;
  lines: DraftRequestLine[];
}

/** Pull the JSON object out of a model reply; null when there isn't one. */
export function parseDraftReply(text: string): DraftExtraction | null {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.lines)) return null;

  const lines: DraftRequestLine[] = [];
  for (const l of parsed.lines) {
    const description = String(l?.description ?? '').trim();
    const rawText = String(l?.raw ?? '').trim();
    if (!description && !rawText) continue;
    const qty = Number(l?.quantity);
    lines.push({
      raw: rawText || description,
      itemNumber: String(l?.itemNumber ?? '').trim() || null,
      description: description || rawText,
      // A zero or negative quantity is not a quantity.
      quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
    });
  }
  const vc = Number(parsed.vehicleCount);
  return {
    vehicleCount: Number.isFinite(vc) && vc >= 1 ? Math.floor(vc) : null,
    lines,
  };
}

export interface CatalogPart {
  id: string;
  netsuite_id?: string | null;
  item_number: string;
  display_name?: string | null;
  description?: string | null;
  sales_price?: unknown;
  labor_hours?: unknown;
  purchase_price?: unknown;
  avg_install_cost?: unknown;
}

export type MatchConfidence = 'exact' | 'strong' | 'weak' | 'none';

export interface DraftLine {
  request: DraftRequestLine;
  part: CatalogPart | null;
  confidence: MatchConfidence;
  /** Which signal produced the match, in words a rep can check. */
  signal: string;
  /** The catalog text that matched, for a weak suggestion. */
  matchedText: string | null;
  score: number | null;
  /** Catalog price, or null when the catalog has none — never 0 as a stand-in. */
  unitPrice: number | null;
  laborHours: number | null;
}

/** Upper-cased, whitespace stripped — the conservative comparison. */
const normalizeItem = (s: unknown): string =>
  String(s ?? '').trim().toUpperCase().replace(/\s+/g, '');

/**
 * Alphanumerics only. Customers write RACK-100, RACK 100 and rack100 for the
 * same part, so a punctuation-only difference should still find it — but it
 * is reported as a near match rather than an exact one, because collapsing
 * punctuation CAN merge two genuinely different catalog numbers and the rep
 * is the one who should decide that.
 */
const looseItem = (s: unknown): string =>
  String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

const tokens = (s: unknown): string[] =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(t => t.length > 2);

/** Overlap of the request's words with a catalog entry's, 0..1. */
export function matchScore(request: string, candidate: string): number {
  const a = new Set(tokens(request));
  const b = new Set(tokens(candidate));
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  // Measured against the REQUEST, so a long catalog description does not
  // dilute a request whose every word it contains.
  return hit / a.size;
}

const priceOf = (p: CatalogPart): number | null => {
  const n = parseFloat(String(p.sales_price ?? ''));
  // 0 in the catalog means "no price recorded" here — a real zero-price item
  // would be an "included" line the rep adds deliberately, not something this
  // drafter should quote on its own.
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const laborOf = (p: CatalogPart): number | null => {
  const n = parseFloat(String(p.labor_hours ?? ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Resolve one request against catalog candidates. Candidates are whatever the
 * caller fetched; this decides which one — if any — to offer and how loudly.
 */
export function matchRequest(request: DraftRequestLine, candidates: CatalogPart[]): DraftLine {
  const base = { request, part: null, confidence: 'none' as MatchConfidence, signal: 'no catalog match', matchedText: null, score: null, unitPrice: null, laborHours: null };

  if (request.itemNumber) {
    const wanted = normalizeItem(request.itemNumber);
    const exact = (candidates || []).find(c => normalizeItem(c.item_number) === wanted);
    if (exact) {
      return {
        request, part: exact, confidence: 'exact',
        signal: `part number ${exact.item_number} stated in the request`,
        matchedText: exact.item_number, score: 1,
        unitPrice: priceOf(exact), laborHours: laborOf(exact),
      };
    }
    const wantedLoose = looseItem(request.itemNumber);
    const near = wantedLoose
      ? (candidates || []).find(c => looseItem(c.item_number) === wantedLoose)
      : undefined;
    if (near) {
      return {
        request, part: near, confidence: 'strong',
        signal: `they wrote "${request.itemNumber}"; the catalog carries ${near.item_number} — same characters, different punctuation`,
        matchedText: near.item_number, score: 1,
        unitPrice: priceOf(near), laborHours: laborOf(near),
      };
    }
    // The customer named a part number the catalog does not carry. That is a
    // FACT worth surfacing, not a licence to substitute something similar.
    return { ...base, signal: `part number ${request.itemNumber} is not in the catalog` };
  }

  let best: { part: CatalogPart; score: number; text: string } | null = null;
  for (const c of candidates || []) {
    for (const text of [c.display_name, c.description, c.item_number]) {
      if (!text) continue;
      const score = matchScore(request.description, text);
      if (!best || score > best.score) best = { part: c, score, text: String(text) };
    }
  }
  if (!best || best.score < MIN_MATCH_SCORE) return base;

  const confidence: MatchConfidence = best.score >= 0.99 ? 'strong' : 'weak';
  return {
    request,
    part: best.part,
    confidence,
    signal: confidence === 'strong'
      ? 'catalog name matches the request exactly'
      : `${Math.round(best.score * 100)}% of the request's words appear in this catalog entry`,
    matchedText: best.text,
    score: Math.round(best.score * 100) / 100,
    unitPrice: priceOf(best.part),
    laborHours: laborOf(best.part),
  };
}

/** What the review grid says at the top, so nobody has to count rows. */
export function summarize(lines: DraftLine[]): {
  total: number; exact: number; suggested: number; unmatched: number;
  missingQuantity: number; missingPrice: number;
} {
  return {
    total: lines.length,
    exact: lines.filter(l => l.confidence === 'exact' || l.confidence === 'strong').length,
    suggested: lines.filter(l => l.confidence === 'weak').length,
    unmatched: lines.filter(l => l.confidence === 'none').length,
    missingQuantity: lines.filter(l => l.request.quantity == null).length,
    missingPrice: lines.filter(l => l.part != null && l.unitPrice == null).length,
  };
}
