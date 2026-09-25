/**
 * Pure helpers behind the PO "Add Part" autocomplete
 * (src/components/PartNumberAutocomplete.tsx): building the catalog search
 * filter, ranking hits, and picking the customer's last PO price per part.
 */

export interface PartSuggestion {
  id: string;
  item_number: string;
  display_name: string | null;
  sales_price: number | null;
  customer: string | null;
  billable_customer: string | null;
}

export interface LastPoPrice {
  price: number;
  poNumber: string;
  /** ordered_date, else the PO's created_at (ISO / YYYY-MM-DD). */
  date: string | null;
}

// Part numbers visually conflate O/0 (mirrors PartPicker / CatalogPartSearch).
const norm = (s: string | null | undefined) => (s || '').toLowerCase().replace(/o/g, '0');

/** Free text → safe for a PostgREST .or() ilike filter ('' = too short to search). */
export function cleanPartQuery(q: string): string {
  const cleaned = q.trim().replace(/[,%_()\\*]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length >= 2 ? cleaned : '';
}

/**
 * The .or() filter for a cleaned query. Adds the O→0 variant of the item
 * number so typing "O2-" still finds "02-" parts.
 */
export function partSearchFilter(cleaned: string): string {
  const clauses = [`item_number.ilike.%${cleaned}%`, `display_name.ilike.%${cleaned}%`];
  const zeroed = cleaned.replace(/[oO]/g, '0');
  if (zeroed !== cleaned) clauses.push(`item_number.ilike.%${zeroed}%`);
  return clauses.join(',');
}

/**
 * Order hits: exact part number, then this PO's customer's parts, then
 * part numbers starting with the query, then the rest alphabetically.
 * Nothing is hidden for belonging to another customer. Duplicate item
 * numbers (manual + NetSuite rows) collapse to the one with a price.
 */
export function rankPartSuggestions(hits: PartSuggestion[], query: string, customer: string): PartSuggestion[] {
  const q = norm(query.trim());
  const cust = (customer || '').trim().toLowerCase();
  const byItem = new Map<string, PartSuggestion>();
  for (const h of hits) {
    const key = (h.item_number || '').toUpperCase();
    const prev = byItem.get(key);
    if (!prev || (!(Number(prev.sales_price) > 0) && Number(h.sales_price) > 0)) byItem.set(key, h);
  }
  const score = (h: PartSuggestion) => {
    const n = norm(h.item_number);
    const isCust = !!cust && [h.customer, h.billable_customer].some(c => (c || '').trim().toLowerCase() === cust);
    return (n === q ? 0 : 4) + (isCust ? 0 : 2) + (n.startsWith(q) ? 0 : 1);
  };
  return [...byItem.values()].sort((a, b) => score(a) - score(b) || a.item_number.localeCompare(b.item_number));
}

interface PoLineRow {
  part_number: string | null;
  unit_price: number | null;
  purchase_orders: { id?: string; po_number: string | null; ordered_date: string | null; created_at: string | null } | null;
}

/**
 * Latest non-zero price per part (keyed by upper-cased part number) from the
 * customer's PO lines, skipping `excludePoId` (the PO being edited).
 */
export function latestPoPrices(rows: PoLineRow[], excludePoId?: string | null): Map<string, LastPoPrice> {
  const best = new Map<string, LastPoPrice & { sortKey: string }>();
  for (const r of rows) {
    const po = r.purchase_orders;
    const price = Number(r.unit_price) || 0;
    if (!po || !r.part_number || price <= 0) continue;
    if (excludePoId && po.id === excludePoId) continue;
    const date = po.ordered_date || po.created_at || null;
    const sortKey = date || '';
    const key = r.part_number.trim().toUpperCase();
    const prev = best.get(key);
    if (!prev || sortKey > prev.sortKey) best.set(key, { price, poNumber: po.po_number || '', date, sortKey });
  }
  const out = new Map<string, LastPoPrice>();
  best.forEach(({ sortKey: _s, ...v }, k) => out.set(k, v));
  return out;
}

/** The price a pick fills in: the parts list sell price, else the last PO price. */
export function pickPrice(sell: number | null | undefined, last: LastPoPrice | undefined): number {
  const s = Number(sell) || 0;
  return s > 0 ? s : (last?.price || 0);
}
