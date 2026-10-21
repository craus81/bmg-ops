/**
 * Vendor PO numbers carry a short customer name (Craig, 2026-10-21):
 * NetSuite gives the PO its next number as usual and FleetSuite adds the
 * customer after a dash, so PO453 becomes PO453-ACME and the sequence never
 * skips. The ending is filled in from the job's customer and can be
 * changed (or typed for a stock order) on the Create PO screen.
 */

/** Words that say nothing about which customer it is. */
const FILLER = new Set([
  'THE', 'LLC', 'L.L.C', 'INC', 'INCORPORATED', 'CO', 'CORP', 'CORPORATION', 'COMPANY',
  'LTD', 'LP', 'LLP', 'PLLC', 'GROUP', 'AND', '&', 'OF',
]);

/** "Acme Plumbing, LLC" → "ACME"; "The A & B Fleet Co." → "ABFLEET". */
export function customerAbbrev(name: string | null | undefined): string {
  const words = String(name || '')
    .toUpperCase()
    .split(/[\s,./]+/)
    .map(w => w.replace(/[^A-Z0-9&]/g, ''))
    .filter(w => w && !FILLER.has(w));
  if (words.length === 0) return '';
  // A first word of one or two letters ("A B Fleet", "JK Services") reads
  // better joined with what follows than on its own.
  let out = words[0];
  for (let i = 1; out.length < 3 && i < words.length; i++) out += words[i];
  return out.replace(/&/g, '').slice(0, 8);
}

/** What may follow the dash: letters, digits and dashes, upper-cased. */
export function cleanPoSuffix(raw: string | null | undefined): string {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 20);
}

/** PO453 + ACME → PO453-ACME. Already ending in it → unchanged. */
export function withPoSuffix(poNumber: string, suffix: string): string {
  const s = cleanPoSuffix(suffix);
  if (!s || poNumber.toUpperCase().endsWith(`-${s}`)) return poNumber;
  return `${poNumber}-${s}`;
}

/** The ending to start the Create PO screen with: the customer, when every
 *  line is for the same one; blank otherwise. */
export function suggestedPoSuffix(customers: (string | null | undefined)[]): string {
  const abbrevs = [...new Set(customers.map(customerAbbrev))];
  return abbrevs.length === 1 ? abbrevs[0] : '';
}
