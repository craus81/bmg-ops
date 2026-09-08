/**
 * Catalog health (R6-7): how complete is the parts catalog, attribute by
 * attribute, and which parts should be fixed first.
 *
 * The honest part is the ordering. A raw "62% of parts have a photo" is
 * true and useless — most of a 12,000-row NetSuite catalog is dead stock
 * nobody will ever quote. What matters is coverage on the parts actually
 * in play: on an open sales order, on an approved estimate, or sitting in
 * the demand list waiting to be bought. So every bar reports BOTH numbers
 * and leads with the in-demand one, and the fix-it worklist puts in-demand
 * parts first. No single blended "weighted %" — a number nobody can
 * reconstruct is a number nobody trusts.
 */

export interface CatalogPart {
  id: string;
  item_number: string;
  display_name?: string | null;
  description?: string | null;
  netsuite_id?: string | null;
  vendor?: string | null;
  product_category_id?: string | null;
  image_path?: string | null;
  labor_hours?: number | null;
  width_in?: number | null;
  depth_in?: number | null;
  height_in?: number | null;
  is_taxable?: boolean | null;
  product_url?: string | null;
  catalog?: string | null;
  is_active?: boolean | null;
}

export interface CatalogAttribute {
  key: string;
  label: string;
  /** Why a gap here costs something — shown under the bar. */
  why: string;
  isSet: (p: CatalogPart) => boolean;
  /** Which /parts filter or page fixes it, for the worklist's CTA. */
  fixHint: string;
}

const text = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/**
 * NULL vs 0 matters twice here and both were deliberate schema decisions:
 * labor_hours NULL = "nobody has priced this part" while 0 = "no labor is
 * charged" (migration 258), and is_taxable NULL = "unknown" while false =
 * "confirmed non-taxable" (migration 252). Treating either NULL as a value
 * would report a gap as covered, which is the whole failure mode this
 * dashboard exists to catch.
 */
export const CATALOG_ATTRIBUTES: CatalogAttribute[] = [
  {
    key: 'netsuite_id', label: 'NetSuite id',
    why: 'Without it a purchase request can’t become a real PO line.',
    isSet: p => text(p.netsuite_id),
    fixHint: 'Run the parts sync — these are FleetSuite-only rows.',
  },
  {
    key: 'vendor', label: 'Vendor',
    why: 'Buy lists group by vendor; a blank one lands in the “no vendor” pile.',
    isSet: p => text(p.vendor),
    fixHint: 'The enrichment pass backfills this from purchase history.',
  },
  {
    key: 'category', label: 'Browse category',
    why: 'Uncategorized parts are invisible in the catalog browser.',
    isSet: p => text(p.product_category_id),
    fixHint: 'Tag it on /parts, add a rule, or accept an enrichment proposal.',
  },
  {
    key: 'labor_hours', label: 'Labor hours',
    why: 'Unpriced labor drops out of every quote and capacity number.',
    isSet: p => p.labor_hours !== null && p.labor_hours !== undefined,
    fixHint: 'Set hours inline on /parts (0 means “no labor charged”).',
  },
  {
    key: 'photo', label: 'Photo',
    why: 'A part with no picture doesn’t sell itself on a proposal.',
    isSet: p => text(p.image_path),
    fixHint: 'Upload in the visual catalog or run the vendor-asset import.',
  },
  {
    key: 'dims', label: 'Dimensions',
    why: 'No W×D×H means the part can’t be placed in the 3D designer.',
    // width_in is the sentinel: dims are authored as a complete set or not
    // at all (the /admin/part-dimensions queue enforces it).
    isSet: p => p.width_in !== null && p.width_in !== undefined,
    fixHint: 'Author them in /admin/part-dimensions.',
  },
  {
    key: 'taxability', label: 'Taxability',
    why: 'Unknown taxability makes an estimate’s tax line a guess.',
    isSet: p => p.is_taxable !== null && p.is_taxable !== undefined,
    fixHint: 'Set it on /parts — false is an answer, blank is not.',
  },
  {
    key: 'product_url', label: 'Product URL',
    why: 'The enrichment pass and spec lookups both read the vendor page.',
    isSet: p => text(p.product_url),
    fixHint: 'Paste the vendor’s product page on /parts.',
  },
];

export interface AttributeCoverage {
  key: string;
  label: string;
  why: string;
  fixHint: string;
  /** Whole active catalog. */
  total: number;
  filled: number;
  pct: number | null;
  /** Parts on an open SO / approved estimate / the demand list. */
  hotTotal: number;
  hotFilled: number;
  hotPct: number | null;
  /** Missing in-demand parts, worst first — the fix-it worklist. */
  worklist: CatalogPart[];
}

export interface CatalogHealth {
  attributes: AttributeCoverage[];
  parts: number;
  hotParts: number;
  /** In-demand item numbers the catalog has no row for at all. A part
   *  being bought that isn't in the catalog is its own kind of gap and
   *  can't show up in any bar below. */
  uncatalogued: string[];
}

const pct = (filled: number, total: number): number | null =>
  total > 0 ? Math.round((filled / total) * 1000) / 10 : null;

/**
 * @param parts    active catalog rows
 * @param hotItems normalized item numbers in play right now (open SO lines,
 *                 approved-estimate lines, demand rows)
 */
export function computeCatalogHealth(
  parts: CatalogPart[],
  hotItems: Set<string>,
  worklistLimit = 50,
): CatalogHealth {
  const norm = (s: string) => s.trim().toUpperCase();
  const isHot = (p: CatalogPart) => hotItems.has(norm(p.item_number || ''));
  const present = new Set(parts.map(p => norm(p.item_number || '')));

  const attributes = CATALOG_ATTRIBUTES.map<AttributeCoverage>(attr => {
    let filled = 0, hotTotal = 0, hotFilled = 0;
    const missingHot: CatalogPart[] = [];
    const missingCold: CatalogPart[] = [];
    for (const p of parts) {
      const set = attr.isSet(p);
      if (set) filled++;
      const hot = isHot(p);
      if (hot) {
        hotTotal++;
        if (set) hotFilled++; else missingHot.push(p);
      } else if (!set && missingCold.length < worklistLimit) {
        missingCold.push(p);
      }
    }
    // In-demand parts first, always — that's the whole point of the
    // ordering. Cold parts only fill the remaining slots.
    const worklist = [...missingHot, ...missingCold].slice(0, worklistLimit);
    return {
      key: attr.key, label: attr.label, why: attr.why, fixHint: attr.fixHint,
      total: parts.length, filled, pct: pct(filled, parts.length),
      hotTotal, hotFilled, hotPct: pct(hotFilled, hotTotal),
      worklist,
    };
  });

  // Sort the bars by where the pain is: worst in-demand coverage first,
  // and an attribute with no in-demand parts at all sinks to the bottom.
  attributes.sort((a, b) => {
    const av = a.hotPct === null ? 101 : a.hotPct;
    const bv = b.hotPct === null ? 101 : b.hotPct;
    if (av !== bv) return av - bv;
    return a.label.localeCompare(b.label);
  });

  const uncatalogued = [...hotItems].filter(n => n && !present.has(n)).sort();

  return {
    attributes,
    parts: parts.length,
    hotParts: parts.filter(isHot).length,
    uncatalogued,
  };
}

/** Coverage tone for a bar. Deliberately generous below 100: a catalog is
 *  never finished, and painting 88% red trains people to ignore the colour. */
export function coverageTone(p: number | null): 'none' | 'good' | 'warn' | 'bad' {
  if (p === null) return 'none';
  if (p >= 90) return 'good';
  if (p >= 60) return 'warn';
  return 'bad';
}
