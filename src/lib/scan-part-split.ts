/**
 * Two part numbers typed into one part field ("0602S029/06S646" — a Masterack
 * install and its separate unit number part) are two billable parts on one
 * visit. scan_logs holds one part per row, so the combined string matches no
 * PO, no pay rate and no price until someone splits it by hand in Scans →
 * Edit Scan (Craig, 2026-10-29: record both automatically, every customer).
 *
 * Shared by the Scan screen (splits at scan time), the Scans page and
 * POST /api/scans/split-parts (splits the rows already saved that way).
 */

/**
 * The part numbers a typed part field means, in the order typed. A field
 * without a "/" comes back as itself; repeats ("A/a") collapse to one.
 */
export function splitPartNumbers(raw: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of (raw || '').split('/')) {
    const pn = t.trim();
    if (!pn || seen.has(pn.toUpperCase())) continue;
    seen.add(pn.toUpperCase());
    out.push(pn);
  }
  return out;
}

/**
 * The parts to record for a typed field, or null when it is one part. A
 * catalog item whose own number contains a "/" is one part, never split —
 * pass the catalog's item numbers (any casing) to rule those out.
 */
export function partsToSplit(
  raw: string | null | undefined,
  catalogItemNumbers?: Iterable<string>,
): string[] | null {
  const parts = splitPartNumbers(raw);
  if (parts.length < 2) return null;
  const whole = (raw || '').trim().toUpperCase();
  if (catalogItemNumbers) {
    for (const item of catalogItemNumbers) {
      if ((item || '').trim().toUpperCase() === whole) return null;
    }
  }
  return parts;
}
