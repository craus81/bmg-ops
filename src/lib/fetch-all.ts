/**
 * Fetch every row of a Supabase query, paginating past PostgREST's
 * 1000-row response cap.
 *
 * PostgREST silently truncates any response at 1000 rows — no error, no
 * marker — which has repeatedly surfaced as "part not in catalog" /
 * missing-row bugs once a table grows past the cap (.limit(N) with N > 1000
 * does NOT help; the cap still applies). Use this for any read of a table
 * that can grow unboundedly (parts, scans, line items, credits, emails…).
 *
 * The caller builds the query and MUST give it a deterministic order with a
 * unique tiebreaker (e.g. `.order('item_number').order('id')`) — offset
 * pagination over a non-unique sort key can skip or duplicate rows at page
 * boundaries when rows are inserted mid-read.
 *
 *   const { data, error } = await fetchAllRows<Row>((from, to) =>
 *     supabase.from('netsuite_parts')
 *       .select('item_number, requires_po_match')
 *       .order('id')
 *       .range(from, to),
 *   );
 *
 * On a failed page the rows fetched so far are returned alongside the
 * error — callers decide whether a partial read is usable (usually not:
 * prefer keeping the last known-good copy, like the PO page's catalog).
 */
export async function fetchAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  for (let pg = 0; ; pg++) {
    const { data, error } = await makeQuery(pg * pageSize, (pg + 1) * pageSize - 1);
    if (error) return { data: all, error };
    all.push(...(data || []));
    if ((data || []).length < pageSize) return { data: all, error: null };
  }
}
