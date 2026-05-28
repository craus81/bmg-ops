/**
 * Some work locations bill the facility (e.g. Masterack) regardless of
 * the part's end customer. Returns the override customer name for the
 * given location, or null if no override applies.
 *
 * Currently: any location whose name starts with "Masterack" bills to
 * Masterack LLC. Extend here when more facility-billed locations come up.
 */
export function locationBillingOverride(locationName: string | null | undefined): string | null {
  if (/^masterack/i.test((locationName || '').trim())) return 'Masterack LLC';
  return null;
}
