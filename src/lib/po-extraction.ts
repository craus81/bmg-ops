/**
 * Field helpers for the AI PO extraction (`/api/gmail/import-po`).
 *
 * These normalize what the model returns before it reaches the database.
 * They live here rather than in the route so they can be tested — a Next.js
 * route module may only export its HTTP handlers.
 */

import { isApMailbox } from './po-confirmation';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Buyer Information name from the PDF (migration 256). Tolerant of the model
 * returning a nested object or a bare string, and of a stray label.
 */
export function buyerName(x: any): string | null {
  const v = x?.buyer_name ?? x?.buyer?.name ?? null;
  // trim() first: the label strip is anchored, so leading whitespace off the
  // PDF used to defeat it and leave "Name: …" in the stored value.
  const s = v == null ? '' : String(v).trim().replace(/^name:\s*/i, '').trim();
  return s ? s.slice(0, 200) : null;
}

/**
 * Buyer Information email from the PDF (migration 256).
 *
 * These POs also print an "INVOICE TO: … Email: <AP mailbox>" line in the
 * footer, and the extractor can take that for the Buyer Information block in
 * the page-1 header. The prompt warns about the decoy at length; this makes
 * the slip unstorable rather than merely unlikely. A PO with no buyer beats a
 * PO with the wrong one: the receipt confirmation then falls through to
 * whoever emailed the PO in, instead of thanking accounts payable for an
 * order they did not place.
 */
export function buyerEmail(x: any): string | null {
  const v = x?.buyer_email ?? x?.buyer?.email ?? null;
  // trim() before the anchored label strip — see buyerName above.
  const s = v == null ? '' : String(v).trim().replace(/^email:\s*/i, '').trim().toLowerCase();
  if (!EMAIL_RE.test(s)) return null;
  if (isApMailbox(s)) return null;
  return s.slice(0, 254);
}

/**
 * The PO's own printed line number ("1.000"), so the lines can be shown back
 * in the order the customer's document lists them (migration 291). Falls back
 * to the line's 1-based position when a PO prints no line numbers —
 * po_line_items.id is a UUID, so without this an ordered read is arbitrary.
 */
export function lineNo(line: any, index: number): number {
  const n = parseFloat(String(line?.line_no ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : index + 1;
}
