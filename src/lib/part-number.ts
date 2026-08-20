/**
 * Case-insensitive part-number handling.
 *
 * Part numbers are case-insensitive everywhere in practice (NetSuite matches
 * item ids with UPPER(); the parts cache and scan-matching normalize to
 * uppercase), but they're stored as plain text in several tables and a
 * hand-typed entry ("06u166") used to be stored verbatim — after which every
 * exact-match read (`.eq`/`.in` on item_number/part_number) silently missed
 * the catalog's "06U166": no price at invoicing, no pay rate, no duplicate
 * guard. Two rules fix the class:
 *
 *  1. On WRITE, resolve a hand-entered part number to the catalog's casing
 *     with canonicalizePartNumber (unknown/custom-job text stays as typed).
 *  2. On READ of columns that hold historical hand-typed values, match with
 *     `.ilike(col, partNumberPattern(pn))` — with the wildcards escaped,
 *     ilike is exactly case-insensitive equality. netsuite_parts has a
 *     lower(item_number) index (migration 117), so this stays cheap.
 */

/** Escape LIKE wildcards so an ilike matches the part number literally. */
export const partNumberPattern = (pn: string) => pn.replace(/[\\%_]/g, ch => `\\${ch}`);

/**
 * Resolve a hand-entered part number to the catalog's canonical casing
 * (06u166 → 06U166) so the stored value matches pricing / PO / pay-rate
 * lookups exactly. Part numbers not in the catalog (custom jobs, free text)
 * come back trimmed but otherwise as typed; empty input comes back null.
 */
export async function canonicalizePartNumber(
  service: any,
  partNumber: string | null | undefined,
): Promise<string | null> {
  const pn = (partNumber || '').trim();
  if (!pn) return null;
  const { data } = await service
    .from('netsuite_parts')
    .select('item_number')
    .ilike('item_number', partNumberPattern(pn))
    .limit(1);
  return (data?.[0]?.item_number as string | undefined) || pn;
}

/**
 * Fetch netsuite_parts rows matching any of the given part numbers,
 * case-insensitively. Key any map you build from the result by
 * `item_number.toUpperCase()` so lookups stay case-blind too.
 *
 * Clean part numbers batch through `.or()` ilike clauses; the or-syntax
 * delimiters would corrupt the filter if a part number ever contained one,
 * so those query individually.
 */
export async function fetchPartRowsCI(
  service: any,
  partNumbers: (string | null | undefined)[],
  select: string,
): Promise<any[]> {
  const unique = [...new Set(partNumbers.map(pn => (pn || '').trim()).filter(Boolean))];
  const clean = unique.filter(pn => !/[,()"]/.test(pn));
  const weird = unique.filter(pn => /[,()"]/.test(pn));
  const out: any[] = [];
  for (let i = 0; i < clean.length; i += 50) {
    const { data } = await service
      .from('netsuite_parts')
      .select(select)
      .or(clean.slice(i, i + 50).map(pn => `item_number.ilike.${partNumberPattern(pn)}`).join(','));
    out.push(...(data || []));
  }
  for (const pn of weird) {
    const { data } = await service
      .from('netsuite_parts')
      .select(select)
      .ilike('item_number', partNumberPattern(pn));
    out.push(...(data || []));
  }
  return out;
}
