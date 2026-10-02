import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Which quote lines carry sales tax (migration 336).
 *
 * FleetSuite owns this answer. NetSuite's item Taxable box is NOT used: it is
 * not maintained in this account and once excluded $6,848.61 of ordinary
 * parts from a quote (see the note atop src/lib/estimate-totals.ts). Instead:
 *
 *  - a part's own `taxable_override`, when an admin has set it, wins;
 *  - otherwise a NetSuite Service item is untaxed (separately billed
 *    install/service work) and every other item type is taxed;
 *  - a line we can't match to a catalog part (custom lines, unknown items) is
 *    taxed, so an unmatched line can never quietly shrink the tax.
 *
 * The answer is stamped on each estimate line at save (`taxable`) and sent to
 * NetSuite with the line, so the quote, the sales order and the invoice
 * transformed from it all agree.
 */

export const UNTAXED_ITEM_TYPES = new Set(['Service']);

export interface PartTaxFields {
  item_type?: string | null;
  taxable_override?: boolean | null;
}

export function isPartTaxable(part: PartTaxFields): boolean {
  if (part.taxable_override === true || part.taxable_override === false) return part.taxable_override;
  return !UNTAXED_ITEM_TYPES.has(String(part.item_type || ''));
}

/** Why a part is (or isn't) taxed, in the words the parts page shows. */
export function partTaxReason(part: PartTaxFields): string {
  if (part.taxable_override === true) return 'Taxed (set by an admin)';
  if (part.taxable_override === false) return 'Not taxed (set by an admin)';
  return isPartTaxable(part) ? 'Taxed' : 'Not taxed (service item)';
}

/** A line is taxed unless it was explicitly stamped non-taxable. */
export function isLineTaxable(line: { taxable?: unknown }): boolean {
  return line.taxable !== false;
}

const norm = (v: unknown) => String(v ?? '').trim().toUpperCase();

type LineRef = { part_id?: unknown; netsuite_item_id?: unknown; item_number?: unknown; is_custom?: unknown };
type CatalogTaxRow = PartTaxFields & { id?: unknown; netsuite_id?: unknown; item_number?: unknown };

export const CATALOG_TAX_COLUMNS = 'id, netsuite_id, item_number, item_type, taxable_override';

/**
 * A line → taxed? function over a set of catalog rows. Matched on part_id
 * first, then the NetSuite item id, then the item number (case-insensitive).
 * A line that matches nothing is taxed.
 */
export function taxabilityResolver(parts: CatalogTaxRow[]): (line: LineRef) => boolean {
  const byId = new Map<string, boolean>();
  const byNsId = new Map<string, boolean>();
  const byNumber = new Map<string, boolean>();
  for (const p of parts) {
    const taxable = isPartTaxable(p);
    if (p.id) byId.set(String(p.id), taxable);
    if (p.netsuite_id) byNsId.set(String(p.netsuite_id), taxable);
    // Two catalog rows can share a number; if they disagree, tax it.
    const key = norm(p.item_number);
    if (key) byNumber.set(key, (byNumber.get(key) ?? false) || taxable);
  }
  return (l: LineRef) => {
    const pid = l.part_id ? String(l.part_id) : '';
    const nsid = l.netsuite_item_id ? String(l.netsuite_item_id) : '';
    const resolved = (pid && byId.has(pid)) ? byId.get(pid)
      : (nsid && byNsId.has(nsid)) ? byNsId.get(nsid)
      : byNumber.get(norm(l.item_number));
    return resolved !== false;
  };
}

/**
 * Stamp `taxable` on each line from the catalog. A catalog hiccup leaves
 * every line taxed rather than failing the save: quoting a few dollars high
 * is corrected at invoicing, quoting low is not.
 */
export async function resolveLineTaxability<T extends LineRef>(
  supabase: SupabaseClient,
  lines: T[],
): Promise<(T & { taxable: boolean })[]> {
  const partIds = [...new Set(lines.map(l => l.part_id).filter(Boolean).map(String))];
  const nsIds = [...new Set(lines.map(l => l.netsuite_item_id).filter(Boolean).map(String))];
  // Catalog item numbers are mixed case and the lookup is case-sensitive, so
  // ask for both the number as typed and its upper-cased form.
  const numbers = [...new Set(lines.flatMap(l => {
    const raw = String(l.item_number ?? '').trim();
    return raw ? [raw, raw.toUpperCase()] : [];
  }))];

  const found: CatalogTaxRow[] = [];
  try {
    const chunked = async (column: string, values: string[]) => {
      // Chunked: a long line list would otherwise overflow the request URL.
      for (let i = 0; i < values.length; i += 200) {
        const { data, error } = await supabase
          .from('netsuite_parts')
          .select(CATALOG_TAX_COLUMNS)
          .in(column, values.slice(i, i + 200));
        if (error) throw error;
        found.push(...((data || []) as CatalogTaxRow[]));
      }
    };
    await chunked('id', partIds);
    await chunked('netsuite_id', nsIds);
    await chunked('item_number', numbers);
  } catch (err: any) {
    console.warn('[line-taxability] catalog lookup failed, taxing every line:', err?.message || err);
    return lines.map(l => ({ ...l, taxable: true }));
  }

  const taxed = taxabilityResolver(found);
  return lines.map(l => ({ ...l, taxable: taxed(l) }));
}
