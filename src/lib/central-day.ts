/**
 * The day and the month in O'Fallon. The shop and its books run on Central time (America/Chicago), so the date
 * FleetSuite puts on a document, and the month a Books page opens on, are Central's. Taking them from
 * `new Date().toISOString()` gives UTC's instead, which is already tomorrow from 7 PM Central (6 PM in winter), and
 * on the evening of a month's last day already next month: a receipt made then was dated the 1st, in NetSuite too.
 *
 * Work done on a date that's already known, such as a month's last day or a date plus some days, is plain calendar
 * arithmetic and stays in UTC. Client-safe.
 */

const PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The day in O'Fallon at a moment, 'YYYY-MM-DD'. */
export function centralDate(at: Date = new Date()): string {
  const part = Object.fromEntries(PARTS.formatToParts(at).map((p) => [p.type, p.value]));
  return `${part.year}-${part.month}-${part.day}`;
}

/** The month in O'Fallon at a moment, 'YYYY-MM-01'. */
export const centralMonth = (at: Date = new Date()): string => `${centralDate(at).slice(0, 7)}-01`;

/** The month before the one in O'Fallon at a moment, 'YYYY-MM-01': the month Books' pages open on. */
export function centralLastMonth(at: Date = new Date()): string {
  const [y, m] = centralMonth(at).split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}
