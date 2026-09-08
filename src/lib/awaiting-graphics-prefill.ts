/**
 * Awaiting-Graphics smart create (R6-10).
 *
 * The queue flags a checked-in vehicle whose linked SO/estimate scored
 * positive in the keyword scan. Today "+ Create" carries over the customer
 * name and PO number and nothing else, so somebody retypes the part
 * numbers off another screen — the exact transcription step the queue was
 * meant to remove.
 *
 * This pulls the sales order's GRAPHIC lines into the wizard: part-number
 * chips, a quantity, a title, and the signal text as the description.
 *
 * Which lines are graphics — and why the answer is not just the prefix:
 *
 *   The Gmail PO import classifies by part number (02… / RM…) because a
 *   scanned Masterack PDF has nothing else to go on. A NetSuite sales
 *   order does: `netsuite_parts.catalog` says outright whether an item is
 *   a graphics part, and item numbers on an SO are under no obligation to
 *   follow a supplier's prefix convention. So the catalog is consulted
 *   FIRST and the prefix is the fallback for items the catalog has never
 *   heard of — and each matched line reports which signal picked it, so
 *   the wizard can say "3 from the catalog, 1 by part-number prefix"
 *   rather than presenting a guess and a fact as the same thing.
 */

import { isGraphicsPartNumber } from './po-install-parts';

export type GraphicsSignal = 'catalog' | 'prefix';

export interface PrefillLine {
  item_number: string | null;
  description: string | null;
  quantity: number | null;
}

export interface PrefillCatalogEntry {
  item_number: string;
  /** 'graphics' | 'upfit' — the FleetSuite-owned split. */
  catalog?: string | null;
  display_name?: string | null;
  description?: string | null;
}

export interface MatchedLine {
  itemNumber: string;
  description: string | null;
  quantity: number;
  /** Which signal claimed this line. Never hidden from the person. */
  signal: GraphicsSignal;
}

export interface AwaitingPrefill {
  partNumbers: string[];
  matched: MatchedLine[];
  /** The quantity to put in the form — see quantityAmbiguous. */
  quantity: number;
  /**
   * True when the graphic lines disagree on quantity. The form takes ONE
   * number, and guessing wrong means printing the wrong amount of vinyl,
   * so an ambiguous set falls back to 1 and says so instead of picking a
   * line's count and hoping.
   */
  quantityAmbiguous: boolean;
  /** Description seed: the keyword-scan signal that flagged the vehicle. */
  content: string;
  /** How many SO lines were read, and how many were not graphics. */
  linesRead: number;
  skipped: number;
  counts: { catalog: number; prefix: number };
}

const norm = (s: string | null | undefined) => String(s || '').trim().toUpperCase();

/**
 * Decide whether a line is a graphics line, and say which signal decided.
 * Returns null when it isn't one.
 */
export function classifyGraphicsLine(
  itemNumber: string | null | undefined,
  catalogEntry: PrefillCatalogEntry | undefined,
): GraphicsSignal | null {
  const key = norm(itemNumber);
  if (!key) return null;
  // The catalog is a deliberate human/NetSuite classification. When it has
  // an opinion it wins outright — including a NEGATIVE opinion: an item
  // the catalog files under 'upfit' is not a graphics line just because
  // its number happens to start with 02.
  const cat = catalogEntry?.catalog;
  if (cat === 'graphics') return 'catalog';
  if (cat) return null;
  return isGraphicsPartNumber(key) ? 'prefix' : null;
}

export function buildAwaitingPrefill(
  lines: PrefillLine[],
  catalog: Map<string, PrefillCatalogEntry>,
): AwaitingPrefill {
  const matched: MatchedLine[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const line of lines) {
    const key = norm(line.item_number);
    if (!key) { skipped++; continue; }
    const signal = classifyGraphicsLine(key, catalog.get(key));
    if (!signal) { skipped++; continue; }
    if (seen.has(key)) continue;   // one chip per part, however many lines
    seen.add(key);

    const cat = catalog.get(key);
    const qty = Number(line.quantity);
    matched.push({
      itemNumber: key,
      description: cat?.display_name || cat?.description || line.description || null,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
      signal,
    });
  }

  const quantities = [...new Set(matched.map(m => m.quantity))];
  const quantityAmbiguous = quantities.length > 1;

  return {
    partNumbers: matched.map(m => m.itemNumber),
    matched,
    quantity: quantities.length === 1 ? quantities[0] : 1,
    quantityAmbiguous,
    content: '',
    linesRead: lines.length,
    skipped,
    counts: {
      catalog: matched.filter(m => m.signal === 'catalog').length,
      prefix: matched.filter(m => m.signal === 'prefix').length,
    },
  };
}

/**
 * One line telling the person what was pulled in and on what evidence, so
 * a prefix guess is never presented as a catalog fact.
 */
export function prefillNote(p: AwaitingPrefill): string {
  if (p.matched.length === 0) {
    return p.linesRead === 0
      ? 'No sales-order lines found — nothing to prefill.'
      : `None of the ${p.linesRead} sales-order line${p.linesRead !== 1 ? 's' : ''} look like graphics work.`;
  }
  const bits: string[] = [];
  if (p.counts.catalog > 0) bits.push(`${p.counts.catalog} from the parts catalog`);
  if (p.counts.prefix > 0) bits.push(`${p.counts.prefix} by part-number prefix (02/RM)`);
  const tail = p.quantityAmbiguous
    ? ' The lines disagree on quantity, so it is set to 1 — check it.'
    : '';
  return `${p.matched.length} graphic line${p.matched.length !== 1 ? 's' : ''} pulled in — ${bits.join(', ')}.${tail}`;
}
