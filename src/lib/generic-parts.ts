/**
 * Generic parts (Craig, 2026-10-30; migration 462): catalog parts like
 * Miscellaneous that stand in for a different job on every estimate. Their
 * labor is set on each estimate line ("This line only") and is never saved
 * to the part, filled into other estimates, or overwritten by the parts
 * sync. The Parts page "Generic part" checkbox (`netsuite_parts.is_generic`)
 * is the only source of truth — nothing here matches on names.
 */
export function isGenericPart(part: { is_generic?: boolean | null } | null | undefined): boolean {
  return !!part?.is_generic;
}
