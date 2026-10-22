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
import { discountLabel, normalizeVehicleCount, perVehicleAmount } from './estimate-totals';
import { toKitDisplayLines } from './estimate-kits';
import {
  escHtml,
  renderQuoteDocument,
  type QuoteDocGraphicsBlock,
  type QuoteDocProofBlock,
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

/** One vehicle of a fleet order email (one estimate per vehicle). */
export interface FleetDocVehicle {
  estimateNumber: string | number | null;
  unitNumber: string | null;
  vin: string | null;
  grandTotal: number | string | null;
  /** That vehicle's own approval page; absent on the compose preview. */
  reviewUrl?: string | null;
  /** That vehicle's estimate PDF behind its own token. */
  pdfUrl?: string | null;
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
  /** The approval email's top button and Download PDF link, and its
   *  forwarding line (quote-document.ts ctaTop / forwardNote). */
  ctaTop?: { downloadUrl?: string | null; downloadLabel?: string | null } | null;
  forwardNote?: string | null;
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
  /** Graphic proofs from linked graphics jobs (graphics_jobs.estimate_attach
   *  — loadEstimateProofs). Rendered as a Graphic Proofs section so the
   *  customer approves design + price on ONE document. Frozen snapshots
   *  must pass inlineProofImages output — the R2 objects are mutable. */
  proofs?: QuoteDocProofBlock[] | null;
  /** Files riding along on the email (the estimate PDF and estimate_files
   *  picked on the compose screen). Listed as their own section so the
   *  customer knows what came with the estimate — the document itself can't
   *  show them. With a url the name is a download link (the token-gated
   *  download routes, src/lib/estimate-approval-downloads.ts), so a
   *  stripped or forwarded-without-attachments email still delivers the
   *  files; the compose preview passes bare names since no token exists yet. */
  attachmentNames?: Array<string | { name: string; url?: string | null }> | null;
  /** Heading for that section ('Attached' by default; the approval email,
   *  which attaches nothing since 2026-10-21, says 'Downloads'). */
  attachmentsTitle?: string | null;
  /** A fleet order sent in one email (Craig, 2026-10-19): the document is
   *  titled for the whole order, lists every vehicle with its own estimate,
   *  total and Review link, and shows the items once as "each vehicle".
   *  `est` and `lines` are the vehicle the items are shown from. */
  fleet?: { vehicles: FleetDocVehicle[] } | null;
}

/**
 * Render the estimate as a self-contained HTML document.
 * `lines` must be the estimate_line_items rows in display order
 * (`.order('sort_order').order('id')`).
 */
export function renderEstimateDocument(est: any, lines: any[], opts: EstimateDocumentOptions = {}): string {
  // Fleet multi-unit (R6-9, migration 304). 1 for every ordinary estimate,
  // which leaves this document byte-identical to what it rendered before.
  const units = normalizeVehicleCount(est.vehicle_count);
  const perVehicle = perVehicleAmount(est.grand_total, est.vehicle_count);
  // Rack kits: one priced rack line, components indented beneath it.
  const rows: QuoteDocRow[] = toKitDisplayLines(lines).flatMap((l: any): QuoteDocRow[] => {
    // A line's own discount (migration 350) is a row under it.
    const withDiscount = (row: QuoteDocRow): QuoteDocRow[] => (Number(l.discount_amount) > 0
      ? [row, {
        itemHtml: `<div style="padding-left:18px;font-size:12px;color:#15803d;">${escHtml(discountLabel(l.discount_type, l.discount_value, l.discount_description))}</div>`,
        qtyHtml: '',
        rateHtml: '',
        totalHtml: `<span style="color:#15803d;">&minus;${money(l.discount_amount)}</span>`,
      }]
      : [row]);
    if (l.kit_component) {
      const qty = units > 1 ? `${escHtml(l.quantity)} &times; ${units}` : escHtml(l.quantity);
      const desc = l.description && l.description !== l.item_number
        ? ` <span style="color:#6b7280;">${escHtml(l.description)}</span>` : '';
      return [{
        itemHtml: `<div style="padding-left:18px;font-size:12px;color:#374151;">&#8627; ${escHtml(l.item_number || l.description || 'Part')}${desc}</div>`,
        qtyHtml: `<span style="font-size:12px;color:#374151;">${qty}</span>`,
        rateHtml: '',
        totalHtml: '',
      }];
    }
    // Fleet estimates (R6-9): quantities are per vehicle, line totals are
    // for the whole order. Showing per-vehicle line totals under a fleet
    // subtotal gives the customer a column that visibly does not add up.
    const lineTotal = (Number(l.line_total ?? (Number(l.unit_price) || 0) * (Number(l.quantity) || 0)) || 0) * units;
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
    const qtyHtml = units > 1
      ? `${escHtml(l.quantity)} &times; ${units}`
      : escHtml(l.quantity);
    return withDiscount({ itemHtml, qtyHtml, rateHtml: money(l.unit_price), totalHtml: money(lineTotal) });
  });

  const laborHours = est.labor_hours_override ?? est.labor_hours;
  const totals: QuoteDocTotalRow[] = [{ labelHtml: 'Subtotal', valueHtml: money(est.subtotal) }];
  if (Number(est.labor_total) > 0) {
    totals.push({ labelHtml: `Labor (${escHtml(laborHours)} hrs @ $${escHtml(est.labor_rate)}/hr)`, valueHtml: money(est.labor_total) });
  }
  if (Number(est.discount_amount) > 0) {
    totals.push({ labelHtml: escHtml(discountLabel(est.discount_type, est.discount_value, est.discount_description)), valueHtml: `&minus;${money(est.discount_amount)}` });
  }
  // Estimate tax_rate is a FRACTION — rendered as (rate*100)%.
  if (!est.tax_exempt && Number(est.tax_amount) > 0) {
    totals.push({ labelHtml: `Tax (${(Number(est.tax_rate) * 100).toFixed(2)}%)`, valueHtml: money(est.tax_amount) });
  }
  if (est.tax_exempt) totals.push({ labelHtml: 'Tax', valueHtml: 'Exempt' });
  if (perVehicle) {
    totals.push({
      labelHtml: `Per vehicle (&times; ${units})`,
      valueHtml: `${perVehicle.exact ? '' : '&asymp; '}${money(perVehicle.amount)}`,
    });
  }
  totals.push({ labelHtml: 'Total', valueHtml: money(est.grand_total), bold: true });

  const fleet = opts.fleet && opts.fleet.vehicles.length > 1 ? opts.fleet : null;
  if (fleet) totals[totals.length - 1] = { labelHtml: 'Total for each vehicle', valueHtml: money(est.grand_total), bold: true };

  const identityLinesHtml: string[] = [];
  // A fleet order's VINs and unit numbers are in its vehicle table.
  const vehicleLine = [
    escHtml(vehicleDescription(est)),
    !fleet && est.vin ? `VIN ${escHtml(est.vin)}` : '',
    !fleet && est.unit_number ? `Unit ${escHtml(est.unit_number)}` : '',
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
  if (opts.attachmentNames && opts.attachmentNames.length > 0) {
    const items = opts.attachmentNames.map(a => (typeof a === 'string' ? { name: a, url: null } : a));
    const linked = items.some(a => a.url);
    sections.push({
      title: opts.attachmentsTitle || 'Attached',
      bodyHtml: items
        .map(a => (a.url
          ? `<a href="${escHtml(a.url)}" style="color:#1d4ed8;font-weight:600;text-decoration:underline;">${escHtml(a.name)}</a>`
          : escHtml(a.name)))
        .join(' &middot; ')
        + (linked ? `<div style="margin-top:6px;font-size:11px;color:#64748b;">Click a name to download a full-size copy. These links keep working for a year.</div>` : ''),
    });
  }

  return renderQuoteDocument(
    {
      docTitle: fleet ? `Estimates for ${fleet.vehicles.length} vehicles` : `Estimate #${est.estimate_number ?? ''}`,
      subtitleHtml: fleet
        ? [est.title ? escHtml(est.title) : '', fleet.vehicles.map(v => `#${escHtml(v.estimateNumber ?? '')}`).join(', ')].filter(Boolean).join(' &middot; ')
        : (est.title ? escHtml(est.title) : null),
      noteHtml: fleet ? fleetVehiclesHtml(fleet.vehicles, est) : null,
      preparedForHtml: `Prepared for ${escHtml(est.customer_name || 'you')}`,
      identityLinesHtml,
      columns: { qty: 'Qty', rate: 'Rate' },
      rows,
      totals,
      sections,
      graphics: opts.graphics || null,
      proofs: opts.proofs || null,
    },
    {
      company: opts.company,
      logoUrl: opts.logoUrl,
      message: opts.message,
      ctaUrl: opts.ctaUrl,
      ctaLabel: opts.ctaLabel,
      ctaNote: opts.ctaNote,
      ctaTop: opts.ctaTop,
      forwardNote: opts.forwardNote,
      signedBlockHtml: opts.signedBlockHtml,
      signature: opts.signature,
    },
  );
}

/**
 * The fleet order's vehicle table: one row per vehicle with its estimate,
 * unit number, VIN, total and its own Review link, then the order total.
 * Under it, what the item list below means: the same work on each vehicle,
 * or (when someone changed one vehicle's estimate) whose items they are.
 */
function fleetVehiclesHtml(vehicles: FleetDocVehicle[], shown: any): string {
  const td = 'padding:7px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;vertical-align:top;';
  const th = 'text-align:left;padding:0 8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;';
  const orderTotal = vehicles.reduce((sum, v) => sum + (Number(v.grandTotal) || 0), 0);
  const same = vehicles.every(v => Math.abs((Number(v.grandTotal) || 0) - (Number(shown.grand_total) || 0)) < 0.005);
  const rows = vehicles.map(v => {
    const links = [
      v.reviewUrl ? `<a href="${escHtml(v.reviewUrl)}" style="color:#1d4ed8;font-weight:700;text-decoration:underline;">Review</a>` : '',
      v.pdfUrl ? `<a href="${escHtml(v.pdfUrl)}" style="color:#1d4ed8;text-decoration:underline;">PDF</a>` : '',
    ].filter(Boolean).join(' &middot; ');
    return `<tr>
      <td style="${td}font-weight:700;">${escHtml(v.unitNumber || '—')}</td>
      <td style="${td}">#${escHtml(v.estimateNumber ?? '')}${v.vin ? `<div style="font-size:11px;color:#6b7280;font-family:ui-monospace,monospace;word-break:break-all;">VIN ${escHtml(v.vin)}</div>` : ''}${links ? `<div style="font-size:12px;margin-top:3px;">${links}</div>` : ''}</td>
      <td style="${td}text-align:right;white-space:nowrap;">${money(v.grandTotal)}</td>
    </tr>`;
  }).join('');
  const note = same
    ? 'Every vehicle gets the same work. The items below are for each vehicle. Each vehicle has its own estimate, so you can approve them all at once or one at a time.'
    : `Not every vehicle is priced the same, so the items below are unit ${escHtml(shown.unit_number || '')}'s (#${escHtml(shown.estimate_number ?? '')}). Use Review to see each vehicle's own items.`;
  return `<div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Vehicles in this order</div>
  <table style="width:100%;border-collapse:collapse;">
    <thead><tr><th style="${th}">Unit</th><th style="${th}">Estimate</th><th style="${th}text-align:right;">Total</th></tr></thead>
    <tbody>${rows}
      <tr><td colspan="2" style="padding:8px;font-size:14px;font-weight:800;color:#111827;border-top:2px solid #d1d5db;">Order total (${vehicles.length} vehicles)</td><td style="padding:8px;font-size:14px;font-weight:800;color:#111827;border-top:2px solid #d1d5db;text-align:right;white-space:nowrap;">${money(orderTotal)}</td></tr>
    </tbody>
  </table>
  <div style="font-size:12px;color:#374151;margin-top:8px;">${note}</div>`;
}
