/**
 * Estimate adapter for the shared quote-document renderer
 * (src/lib/quote-document.ts) — ONE document for every surface that shows
 * an estimate to a customer:
 *
 *  - the send-for-approval email (with a Review & Approve CTA), and
 *  - the frozen signed snapshot uploaded on acceptance (the E-SIGN
 *    evidence record), via the `signedBlockHtml` slot.
 *
 * Keeping these on one renderer is load-bearing: if the email and the
 * signed snapshot drift, the legal record stops matching what the customer
 * was sent. Estimate formatting conventions live HERE (fraction tax rate
 * shown as (rate*100)%, plain $X.XX money) — see the renderer's header for
 * why adapters own formatting.
 *
 * Server-safe: pure string building, no client imports.
 */

import type { EmailSignature } from './email-signature';
import {
  escHtml,
  renderQuoteDocument,
  type QuoteDocGraphicsBlock,
  type QuoteDocRow,
  type QuoteDocSection,
  type QuoteDocTotalRow,
} from './quote-document';

export { escHtml };

const money = (n: any) => `$${Number(n || 0).toFixed(2)}`;

/**
 * One-line vehicle description from the estimate's stored vehicle fields
 * (N4-B2 phase 3): "2026 Ford Transit · medium roof · 148" WB". Callers
 * hydrate `vehicle_platform_label` from vehicle_platforms — the estimate
 * row itself only stores the FK. `vehicle_other` is the free-text vehicle
 * for anything outside the platforms table (VIN-decoded or hand-typed) and
 * fills in when no platform is set. Also the line pushed into NetSuite
 * memos.
 */
export function vehicleDescription(est: any): string {
  const name = [est.vehicle_year, est.vehicle_platform_label || est.vehicle_other].filter(Boolean).join(' ');
  const wb = est.vehicle_wheelbase;
  return [
    name || null,
    est.vehicle_roof ? `${est.vehicle_roof} roof` : null,
    wb ? (/^\d/.test(wb) ? `${wb}" WB` : wb) : null,
    est.vehicle_cab ? `${est.vehicle_cab} cab` : null,
    est.vehicle_bed ? `${est.vehicle_bed}' bed` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * The NetSuite memo for an estimate — ONE builder for every push path
 * (estimate push and convert-to-SO), so the two NetSuite copies can't
 * drift: title, customer-facing notes, then a context line with the
 * vehicle, install/delivery/on-site details and the unit number (which has
 * no dedicated NS field — the memo is where it survives), and finally the
 * FleetSuite estimate number as a cross-reference. VIN and customer PO get
 * real NS fields (custbody_vin_number_ / otherRefNum) and stay out of here.
 */
export function estimateContextMemo(est: any): string {
  const memoParts: string[] = [];
  if (est.title?.trim()) memoParts.push(est.title.trim());
  if (est.notes?.trim()) memoParts.push(est.notes.trim());
  const ctxLines: string[] = [];
  const vehicle = vehicleDescription(est);
  if (vehicle) ctxLines.push(`Vehicle: ${vehicle}`);
  if (est.install_instructions?.trim()) ctxLines.push(`Install: ${est.install_instructions.trim()}`);
  if (est.delivery_preferences?.trim()) ctxLines.push(`Delivery: ${est.delivery_preferences.trim()}`);
  const onSite = [est.on_site_contact_name, est.on_site_contact_phone].filter(Boolean).join(' ');
  if (onSite) ctxLines.push(`On-site: ${onSite}`);
  if (est.unit_number?.trim()) ctxLines.push(`Unit: ${est.unit_number.trim()}`);
  if (ctxLines.length > 0) memoParts.push(ctxLines.join(' · '));
  memoParts.push(`FleetSuite Estimate #${est.estimate_number}`);
  return memoParts.join('\n');
}

export interface EstimateDocumentCompany {
  name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface EstimateDocumentOptions {
  company?: EstimateDocumentCompany | null;
  logoUrl?: string | null;
  /** Personal note from the sender, shown above the line table (escaped). */
  message?: string | null;
  /** Approve CTA — the email passes these; the snapshot passes none. */
  ctaUrl?: string | null;
  ctaLabel?: string | null;
  /** Small print under the CTA (e.g. link expiry). */
  ctaNote?: string | null;
  /** Pre-built trusted HTML appended after the totals (the signed/audit
   *  block on acceptance snapshots). Caller escapes its own interpolations. */
  signedBlockHtml?: string | null;
  /** The sender's email signature — rendered at the bottom of the
   *  document on composed sends; snapshots pass none. */
  signature?: EmailSignature | string | null;
  /** Wrap content from linked wrap quotes (wrap_quotes.estimate_attach —
   *  loadEstimateGraphics). Rendered as a Vinyl / Graphics section with the
   *  coverage diagram, so the email body, approval page, and signed
   *  snapshot show the same wrap content the merged PDF carries. Frozen
   *  snapshots must pass data-URI diagrams (inlineDiagrams) — the R2
   *  object is mutable. */
  graphics?: QuoteDocGraphicsBlock[] | null;
}

/**
 * Render the estimate as a self-contained HTML document.
 * `lines` must be the estimate_line_items rows in display order
 * (`.order('sort_order').order('id')`).
 */
export function renderEstimateDocument(est: any, lines: any[], opts: EstimateDocumentOptions = {}): string {
  const rows: QuoteDocRow[] = lines.map((l: any) => {
    const lineTotal = Number(l.line_total ?? (Number(l.unit_price) || 0) * (Number(l.quantity) || 0)) || 0;
    const label = escHtml(l.item_number || l.description || 'Item');
    const sub = l.description && l.description !== l.item_number
      ? `<div style="font-size:12px;color:#6b7280;">${escHtml(l.description)}</div>` : '';
    const note = l.notes ? `<div style="font-size:11px;color:#9ca3af;font-style:italic;">${escHtml(l.notes)}</div>` : '';
    // Enhanced-estimate assets (enrichLinesWithPartAssets): product photo and
    // vendor product-page link, where the catalog has them.
    const productLink = l.part_product_url
      ? `<div style="margin-top:2px;"><a href="${escHtml(l.part_product_url)}" target="_blank" rel="noopener noreferrer" style="font-size:11px;color:#2563eb;text-decoration:underline;">View product &#8599;</a></div>` : '';
    const itemText = `${label}${sub}${note}${productLink}`;
    // With a photo, the item cell becomes a nested table (the email-safe way
    // to put a thumbnail beside text — floats don't survive Outlook).
    const itemHtml = l.part_image_url
      ? `<table role="presentation" style="border-collapse:collapse;"><tr>
          <td style="padding:0 10px 0 0;vertical-align:top;"><img src="${escHtml(l.part_image_url)}" alt="${label}" width="56" height="56" style="width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;display:block;"></td>
          <td style="vertical-align:top;">${itemText}</td>
        </tr></table>`
      : itemText;
    return { itemHtml, qtyHtml: escHtml(l.quantity), rateHtml: money(l.unit_price), totalHtml: money(lineTotal) };
  });

  const laborHours = est.labor_hours_override ?? est.labor_hours;
  const totals: QuoteDocTotalRow[] = [{ labelHtml: 'Subtotal', valueHtml: money(est.subtotal) }];
  if (Number(est.labor_total) > 0) {
    totals.push({ labelHtml: `Labor (${escHtml(laborHours)} hrs @ $${escHtml(est.labor_rate)}/hr)`, valueHtml: money(est.labor_total) });
  }
  // Estimate tax_rate is a FRACTION — rendered as (rate*100)%.
  if (!est.tax_exempt && Number(est.tax_amount) > 0) {
    totals.push({ labelHtml: `Tax (${(Number(est.tax_rate) * 100).toFixed(2)}%)`, valueHtml: money(est.tax_amount) });
  }
  if (est.tax_exempt) totals.push({ labelHtml: 'Tax', valueHtml: 'Exempt' });
  totals.push({ labelHtml: 'Total', valueHtml: money(est.grand_total), bold: true });

  const identityLinesHtml: string[] = [];
  const vehicleLine = [
    escHtml(vehicleDescription(est)),
    est.vin ? `VIN ${escHtml(est.vin)}` : '',
    est.unit_number ? `Unit ${escHtml(est.unit_number)}` : '',
  ].filter(Boolean).join(' &middot; ');
  if (vehicleLine) identityLinesHtml.push(vehicleLine);
  const refLine = [
    est.po_number ? `PO #${escHtml(est.po_number)}` : '',
    est.expiration_date ? `Expires ${escHtml(est.expiration_date)}` : '',
  ].filter(Boolean).join(' &middot; ');
  if (refLine) identityLinesHtml.push(refLine);

  const sections: QuoteDocSection[] = [];
  if (est.install_instructions) sections.push({ title: 'Install Instructions', bodyHtml: escHtml(est.install_instructions) });
  if (est.on_site_contact_name || est.on_site_contact_phone) {
    sections.push({ title: 'On-site Contact', bodyHtml: `${escHtml(est.on_site_contact_name || '')}${est.on_site_contact_phone ? ' · ' + escHtml(est.on_site_contact_phone) : ''}` });
  }
  if (est.delivery_preferences) sections.push({ title: 'Delivery', bodyHtml: escHtml(est.delivery_preferences) });
  if (est.notes) sections.push({ title: 'Notes', bodyHtml: escHtml(est.notes) });

  return renderQuoteDocument(
    {
      docTitle: `Estimate #${est.estimate_number ?? ''}`,
      subtitleHtml: est.title ? escHtml(est.title) : null,
      preparedForHtml: `Prepared for ${escHtml(est.customer_name || 'you')}`,
      identityLinesHtml,
      columns: { qty: 'Qty', rate: 'Rate' },
      rows,
      totals,
      sections,
      graphics: opts.graphics || null,
    },
    {
      company: opts.company,
      logoUrl: opts.logoUrl,
      message: opts.message,
      ctaUrl: opts.ctaUrl,
      ctaLabel: opts.ctaLabel,
      ctaNote: opts.ctaNote,
      signedBlockHtml: opts.signedBlockHtml,
      signature: opts.signature,
    },
  );
}
