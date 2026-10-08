/**
 * Wording for the "Created by" tag (src/components/CreatedBy.tsx) — kept
 * pure so list rows, detail headers and tests all agree on one phrasing.
 *
 *   FleetSuite person   → "Created by Jane Doe · Oct 7, 2026"
 *   NetSuite, name known → "Created in NetSuite by Jane Doe · Oct 7, 2026"
 *   NetSuite, no name    → "Created in NetSuite · Oct 7, 2026"
 *   QuickBooks history   → "Imported from QuickBooks · Mar 2, 2023"
 *   Read from email      → "Auto-imported from email · Oct 7, 2026"
 *   nothing known        → null (show nothing rather than guess)
 */

export type CreatedBySource = 'netsuite' | 'quickbooks' | 'email' | 'system';

export function fmtCreatedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // Date-only values (NetSuite trandate) must not shift a day in US time zones.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function createdByText(opts: {
  name?: string | null;
  at?: string | null;
  source?: CreatedBySource | null;
  label?: string;
}): string | null {
  const name = opts.name?.trim() || null;
  const date = fmtCreatedDate(opts.at);
  let head: string | null = null;
  switch (opts.source) {
    case 'netsuite':
      head = name ? `Created in NetSuite by ${name}` : 'Created in NetSuite';
      break;
    case 'quickbooks':
      head = 'Imported from QuickBooks';
      break;
    case 'email':
      head = 'Auto-imported from email';
      break;
    case 'system':
      head = name ? `${opts.label || 'Created by'} ${name}` : 'Created automatically';
      break;
    default:
      head = name ? `${opts.label || 'Created by'} ${name}` : null;
  }
  if (!head) return null;
  return date ? `${head} · ${date}` : head;
}
