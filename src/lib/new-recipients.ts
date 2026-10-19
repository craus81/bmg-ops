/**
 * "Add them to the customer?" — after an estimate email goes to an address
 * the customer's record doesn't have, the compose screen offers to save it
 * as a contact (owner ask, 2026-10-19). Otherwise the next send starts from
 * a blank To line again and the person who actually approves estimates
 * never shows up in the contact dropdown.
 *
 * Pure helpers shared by the route (which knows every address on file) and
 * the compose screen (which prefills the name).
 */

const OWN_DOMAINS = ['bmgfleet.com'];

export const normalizeEmail = (e: string | null | undefined) => (e || '').trim().toLowerCase();

/** Our own people are never "new contacts at the customer". */
export function isOwnAddress(email: string): boolean {
  const domain = normalizeEmail(email).split('@')[1] || '';
  return OWN_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`));
}

/**
 * The recipients that aren't anywhere on the customer's record yet, in the
 * order they were typed, deduped, minus BMG addresses.
 */
export function unknownRecipients(sentTo: string[], known: Iterable<string | null | undefined>): string[] {
  const onFile = new Set<string>();
  for (const k of known) {
    const e = normalizeEmail(k);
    if (e) onFile.add(e);
  }
  const out: string[] = [];
  for (const raw of sentTo) {
    const e = normalizeEmail(raw);
    if (!e || !e.includes('@') || isOwnAddress(e) || onFile.has(e) || out.includes(e)) continue;
    out.push(e);
  }
  return out;
}

const SHARED_INBOXES = new Set([
  'ap', 'ar', 'accounting', 'accountspayable', 'admin', 'billing', 'contact', 'fleet', 'hello',
  'info', 'invoices', 'office', 'orders', 'purchasing', 'sales', 'service', 'support',
]);

/**
 * A starting guess at the person's name from their address, for the sender
 * to fix: "john.smith@" → "John Smith". Anything that doesn't look like
 * first.last (jsmith@, ap@, 1234@) comes back empty rather than inventing a
 * name nobody would recognise.
 */
export function guessNameFromEmail(email: string): string {
  const local = normalizeEmail(email).split('@')[0].replace(/\+.*$/, '');
  if (SHARED_INBOXES.has(local.replace(/[._-]/g, ''))) return '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return '';
  if (!parts.every(p => /^[a-z]{2,}$/.test(p))) return '';
  return parts.map(p => p[0].toUpperCase() + p.slice(1)).join(' ');
}
