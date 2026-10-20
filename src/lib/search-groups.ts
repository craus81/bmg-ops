/**
 * The order search result groups show in, for the top bar and the full
 * results page (owner ask 2026-10-20: "FleetSuite content should come up
 * first"). FleetSuite's own records come first, then NetSuite's, then
 * QuickBooks'. Estimates lead because their numbers are what staff search
 * most. Pure and client-safe.
 */
export const SEARCH_GROUP_ORDER: readonly string[] = [
  // FleetSuite
  'estimates',
  'graphics_jobs',
  'purchase_orders',
  'vehicles',
  'customers',
  'parts',
  'quotes',
  'cni_companies',
  'cni_installers',
  'messages',
  'notes',
  // NetSuite
  'invoices',
  'ns_estimates',
  'ns_sales_orders',
  'ns_transactions',
  // QuickBooks
  'qb_history',
  'bills',
];

/** Group keys in SEARCH_GROUP_ORDER; unknown groups go last, in their given order. */
export function orderSearchGroups(keys: string[]): string[] {
  const rank = (k: string) => {
    const i = SEARCH_GROUP_ORDER.indexOf(k);
    return i < 0 ? SEARCH_GROUP_ORDER.length : i;
  };
  return keys.map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map(x => x.k);
}

/** A results object rebuilt with its keys in SEARCH_GROUP_ORDER. */
export function orderSearchResults<T>(results: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of orderSearchGroups(Object.keys(results))) out[k] = results[k];
  return out;
}
