/**
 * The customer-facing estimate document — ONE renderer for every surface
 * that shows an estimate to a customer:
 *
 *  - the send-for-approval email (with a Review & Approve CTA), which used
 *    to be a generic dark notification card with no line items at all, and
 *  - the frozen signed snapshot uploaded on acceptance (the E-SIGN
 *    evidence record), via the `signedBlockHtml` slot.
 *
 * Keeping these on one renderer is load-bearing: if the email and the
 * signed snapshot drift, the legal record stops matching what the customer
 * was sent. Styles are inline (no <style> block) so the same markup renders
 * in email clients, browsers, and the archived HTML file alike.
 *
 * Server-safe: pure string building, no client imports.
 */

import { renderSignatureHtml, type EmailSignature } from './email-signature';

export function escHtml(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  graphics?: {
    quoteNumber: string;
    vehicle: string | null;
    totalSqft: number;
    films: { name: string; areas: string[] }[];
    diagramUrl: string | null;
  }[] | null;
}

/**
 * Render the estimate as a self-contained HTML document.
 * `lines` must be the estimate_line_items rows in display order
 * (`.order('sort_order').order('id')`).
 */
export function renderEstimateDocument(est: any, lines: any[], opts: EstimateDocumentOptions = {}): string {
  const { company, logoUrl, message, ctaUrl, ctaLabel, ctaNote, signedBlockHtml, signature, graphics } = opts;

  const cell = (v: string, right = false) =>
    `<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;vertical-align:top;${right ? 'text-align:right;white-space:nowrap;' : ''}">${v}</td>`;

  const rows = lines.map((l: any) => {
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
    return `<tr>${cell(itemHtml)}${cell(escHtml(l.quantity), true)}${cell(money(l.unit_price), true)}${cell(money(lineTotal), true)}</tr>`;
  }).join('\n');

  const laborHours = est.labor_hours_override ?? est.labor_hours;
  const totalRow = (label: string, value: string, bold = false) =>
    `<tr><td style="padding:4px 10px;font-size:${bold ? '15px' : '13px'};color:#111827;${bold ? 'font-weight:800;border-top:2px solid #d1d5db;' : ''}">${label}</td><td style="padding:4px 10px;text-align:right;font-size:${bold ? '15px' : '13px'};color:#111827;${bold ? 'font-weight:800;border-top:2px solid #d1d5db;' : ''}white-space:nowrap;">${value}</td></tr>`;

  const companyLines = [
    company?.name, company?.address,
    [company?.city, company?.state, company?.zip].filter(Boolean).join(', '),
    company?.phone, company?.email,
  ].filter(Boolean).map(l => escHtml(l)).join('<br>');

  const section = (title: string, body: string) =>
    `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;margin-top:12px;font-size:13px;color:#111827;white-space:pre-wrap;"><div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">${title}</div>${body}</div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Estimate ${escHtml(est.estimate_number)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:28px;">
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px;"><tr>
      <td style="vertical-align:top;">
        ${logoUrl ? `<img src="${escHtml(logoUrl)}" alt="${escHtml(company?.name || 'Company logo')}" height="44" style="height:44px;max-width:220px;display:block;margin-bottom:10px;">` : ''}
        <div style="font-size:22px;font-weight:800;color:#111827;">Estimate #${escHtml(est.estimate_number)}</div>
        ${est.title ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${escHtml(est.title)}</div>` : ''}
        <div style="font-size:13px;color:#6b7280;margin-top:2px;">Prepared for ${escHtml(est.customer_name || 'you')}</div>
        ${(vehicleDescription(est) || est.vin || est.unit_number) ? `<div style="font-size:12px;color:#374151;margin-top:6px;font-weight:600;">${[
          escHtml(vehicleDescription(est)),
          est.vin ? `VIN ${escHtml(est.vin)}` : '',
          est.unit_number ? `Unit ${escHtml(est.unit_number)}` : '',
        ].filter(Boolean).join(' &middot; ')}</div>` : ''}
        ${(est.po_number || est.expiration_date) ? `<div style="font-size:12px;color:#374151;margin-top:2px;">${[
          est.po_number ? `PO #${escHtml(est.po_number)}` : '',
          est.expiration_date ? `Expires ${escHtml(est.expiration_date)}` : '',
        ].filter(Boolean).join(' &middot; ')}</div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right;font-size:12px;color:#374151;line-height:1.5;">${companyLines}</td>
    </tr></table>

    ${message ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#1e3a8a;white-space:pre-wrap;">${escHtml(message)}</div>` : ''}

    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="text-align:left;padding:0 10px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;">Item</th>
        <th style="text-align:right;padding:0 10px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;">Qty</th>
        <th style="text-align:right;padding:0 10px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;">Rate</th>
        <th style="text-align:right;padding:0 10px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table style="width:45%;min-width:240px;margin-left:auto;border-collapse:collapse;margin-top:10px;">
      ${totalRow('Subtotal', money(est.subtotal))}
      ${Number(est.labor_total) > 0 ? totalRow(`Labor (${escHtml(laborHours)} hrs @ $${escHtml(est.labor_rate)}/hr)`, money(est.labor_total)) : ''}
      ${(!est.tax_exempt && Number(est.tax_amount) > 0) ? totalRow(`Tax (${(Number(est.tax_rate) * 100).toFixed(2)}%)`, money(est.tax_amount)) : ''}
      ${est.tax_exempt ? totalRow('Tax', 'Exempt') : ''}
      ${totalRow('Total', money(est.grand_total), true)}
    </table>

    ${est.install_instructions ? section('Install Instructions', escHtml(est.install_instructions)) : ''}
    ${(est.on_site_contact_name || est.on_site_contact_phone) ? section('On-site Contact', `${escHtml(est.on_site_contact_name || '')}${est.on_site_contact_phone ? ' · ' + escHtml(est.on_site_contact_phone) : ''}`) : ''}
    ${est.delivery_preferences ? section('Delivery', escHtml(est.delivery_preferences)) : ''}
    ${est.notes ? section('Notes', escHtml(est.notes)) : ''}

    ${(graphics || []).map(g => `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;margin-top:12px;font-size:13px;color:#111827;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Vinyl / Graphics</div>
      <div style="font-weight:700;">Quote ${escHtml(g.quoteNumber)}${g.vehicle ? ` — ${escHtml(g.vehicle)}` : ''}${g.totalSqft > 0 ? ` · ~${Math.round(g.totalSqft)} sqft coverage` : ''}</div>
      ${g.films.length > 0 ? `<ul style="margin:6px 0 0;padding-left:18px;">${g.films.map(f =>
        `<li style="margin-top:2px;">${escHtml(f.name)}${f.areas.length > 0 ? ` — ${escHtml(f.areas.join(', '))}` : ''}</li>`).join('')}</ul>` : ''}
      ${g.diagramUrl ? `<img src="${escHtml(g.diagramUrl)}" alt="Coverage diagram — Quote ${escHtml(g.quoteNumber)}" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px;margin-top:10px;display:block;">` : ''}
    </div>`).join('')}

    ${ctaUrl ? `
    <div style="text-align:center;margin-top:24px;">
      <a href="${escHtml(ctaUrl)}" style="display:inline-block;padding:14px 32px;background:#16a34a;color:#ffffff;font-weight:800;font-size:14px;border-radius:10px;text-decoration:none;">${escHtml(ctaLabel || 'Review & Approve')}</a>
      ${ctaNote ? `<div style="font-size:11px;color:#9ca3af;margin-top:8px;">${escHtml(ctaNote)}</div>` : ''}
    </div>` : ''}

    ${renderSignatureHtml(signature, 'light')}
    ${signedBlockHtml || ''}
  </div>
  <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">Sent by ${escHtml(company?.name || 'BMG Fleet')}</div>
</body></html>`;
}
