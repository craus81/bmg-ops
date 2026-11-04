/**
 * End user: the company the work is really for when someone else is billed
 * (Craig, 2026-11-04: "we are billing Clement Ford but the end user is
 * actually Jerry Kelly"). Typed on the estimate, carried to the sales
 * order, and from there to every fulfillment and invoice.
 *
 * In NetSuite it lives in a transaction body field Craig picked because
 * nothing used it: custbody_vehicle_info_. Every read and write goes
 * through END_USER_FIELD so the field can move in one place.
 */

export const END_USER_FIELD = 'custbody_vehicle_info_';

/** Longest end user name we keep (NetSuite free-text fields hold 300). */
export const END_USER_MAX = 120;

/** Trimmed, inner whitespace collapsed; '' when blank. */
export function normalizeEndUser(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

/** NetSuite body fragment that stamps the end user, or {} when there is none. */
export function endUserBody(v: unknown): Record<string, string> {
  const s = normalizeEndUser(v).slice(0, END_USER_MAX);
  return s ? { [END_USER_FIELD]: s } : {};
}
