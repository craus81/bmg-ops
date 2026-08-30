/**
 * THE customer-facing quote document — one renderer for every surface that
 * shows a quote to a customer, whichever tool built the quote:
 *
 *   - estimate approval emails + frozen signed snapshots
 *     (adapter: renderEstimateDocument in src/lib/estimate-document.ts)
 *   - wrap-quote emails + frozen signed snapshots
 *     (adapter: wrapQuoteDocModel in src/lib/wrap-quote-document.ts)
 *
 * Keeping every surface on one chrome is load-bearing: when the email and
 * the signed snapshot drift, the legal record stops matching what the
 * customer was sent. Styles are inline (no <style> block) so the same
 * markup renders in email clients, browsers, and archived HTML files.
 *
 * Adapters own ALL number formatting. The two quote systems deliberately
 * differ — estimates carry a FRACTION tax rate shown as (rate*100)% and
 * plain $X.XX; wrap quotes carry a PERCENT tax rate shown raw, locale
 * thousands separators, and '—' for roll-nested rows whose per-line price
 * is intentionally null — so a shared formatter would silently corrupt one
 * of them. Every *Html field arrives pre-escaped from its adapter.
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

export interface QuoteDocRow {
  /** Pre-escaped item cell (label, detail spans, links, thumbnails). */
  itemHtml: string;
  qtyHtml: string;
  rateHtml: string;
  totalHtml: string;
}

export interface QuoteDocTotalRow {
  labelHtml: string;
  valueHtml: string;
  /** Bold + rule above (the grand total). */
  bold?: boolean;
  /** Row color override (wrap's discount purple / minimum amber / total green). */
  color?: string;
}

export interface QuoteDocSection {
  title: string;
  /** Pre-escaped body (white-space: pre-wrap). */
  bodyHtml: string;
}

export interface QuoteDocGraphicsBlock {
  quoteNumber: string;
  vehicle: string | null;
  totalSqft: number;
  films: { name: string; areas: string[] }[];
  diagramUrl: string | null;
}

export interface QuoteDocProofBlock {
  jobNumber: string | null;
  jobTitle: string | null;
  /** Image files render inline; PDFs render as a link (url) or, on frozen
   *  snapshots where url is null, as a named line item. */
  files: { name: string; url: string | null; isPdf: boolean }[];
}

export interface QuoteDocModel {
  /** Plain text — 'Estimate #123', 'Wrap Quote', 'Wrap Coverage'. */
  docTitle: string;
  /** Pre-escaped line under the title (estimate title / 'WQ-9 · date'). */
  subtitleHtml?: string | null;
  /** Pre-escaped 'Prepared for …' line. */
  preparedForHtml?: string | null;
  /** Pre-escaped identity lines (vehicle · VIN · unit; PO · expires; …). */
  identityLinesHtml?: string[];
  /** Wrap-style customer address block (<br>-joined, pre-escaped). When
   *  present, a two-column company | customer block renders under the
   *  header; when absent the company block sits in the header's right. */
  customerBlockHtml?: string | null;
  /** Pre-escaped note above the table ('Your quote is attached as a PDF.'). */
  noteHtml?: string | null;
  diagram?: { url: string; heading: string } | null;
  /** Column headings; null = no line table (coverage-only / hidden lines). */
  columns: { qty: string; rate: string } | null;
  rows: QuoteDocRow[];
  totals: QuoteDocTotalRow[] | null;
  sections?: QuoteDocSection[];
  /** Wrap content blocks on estimates (loadEstimateGraphics summaries). */
  graphics?: QuoteDocGraphicsBlock[] | null;
  /** Graphic-proof blocks from linked graphics jobs on estimates
   *  (loadEstimateProofs — graphics_jobs.estimate_attach). */
  proofs?: QuoteDocProofBlock[] | null;
  /** Pre-escaped small print after the totals (film usage, nesting note). */
  footnotesHtml?: string[];
}

export interface QuoteDocRenderOptions {
  company?: {
    name?: string | null; address?: string | null; city?: string | null;
    state?: string | null; zip?: string | null; phone?: string | null;
    email?: string | null;
  } | null;
  logoUrl?: string | null;
  /** Personal note from the sender, shown above the content (escaped). */
  message?: string | null;
  ctaUrl?: string | null;
  ctaLabel?: string | null;
  /** Small print under/inside the CTA (link expiry etc.). */
  ctaNote?: string | null;
  /** Render the CTA as the wrap-style green panel (button + helper copy)
   *  instead of the plain centered button. */
  ctaPanel?: boolean;
  /** Pre-built trusted HTML appended after the signature (the signed/audit
   *  block on acceptance snapshots). Caller escapes its own interpolations. */
  signedBlockHtml?: string | null;
  signature?: EmailSignature | string | null;
}

export function renderQuoteDocument(model: QuoteDocModel, opts: QuoteDocRenderOptions = {}): string {
  const { company, logoUrl, message, ctaUrl, ctaLabel, ctaNote, ctaPanel, signedBlockHtml, signature } = opts;

  const companyLines = [
    company?.name, company?.address,
    [company?.city, company?.state, company?.zip].filter(Boolean).join(', '),
    company?.phone, company?.email,
  ].filter(Boolean).map(l => escHtml(l)).join('<br>');

  const section = (title: string, body: string) =>
    `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;margin-top:12px;font-size:13px;color:#111827;white-space:pre-wrap;"><div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">${escHtml(title)}</div>${body}</div>`;

  const totalRow = (t: QuoteDocTotalRow) => {
    const color = t.color || '#111827';
    const base = `padding:4px 10px;font-size:${t.bold ? '15px' : '13px'};color:${color};${t.bold ? 'font-weight:800;border-top:2px solid #d1d5db;' : ''}`;
    return `<tr><td style="${base}">${t.labelHtml}</td><td style="${base}text-align:right;white-space:nowrap;">${t.valueHtml}</td></tr>`;
  };

  const cell = (v: string, right = false) =>
    `<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;vertical-align:top;${right ? 'text-align:right;white-space:nowrap;' : ''}">${v}</td>`;

  const cta = ctaUrl
    ? (ctaPanel
      ? `
    <div style="margin-top:22px;padding:18px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;text-align:center;">
      <a href="${escHtml(ctaUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;font-size:15px;font-weight:700;padding:13px 28px;border-radius:10px;text-decoration:none;">${escHtml(ctaLabel || 'Review & Accept')}</a>
      ${ctaNote ? `<div style="font-size:12px;color:#374151;margin-top:10px;line-height:1.5;">${escHtml(ctaNote)}</div>` : ''}
    </div>`
      : `
    <div style="text-align:center;margin-top:24px;">
      <a href="${escHtml(ctaUrl)}" style="display:inline-block;padding:14px 32px;background:#16a34a;color:#ffffff;font-weight:800;font-size:14px;border-radius:10px;text-decoration:none;">${escHtml(ctaLabel || 'Review & Approve')}</a>
      ${ctaNote ? `<div style="font-size:11px;color:#9ca3af;margin-top:8px;">${escHtml(ctaNote)}</div>` : ''}
    </div>`)
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escHtml(model.docTitle)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:28px;">
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px;"><tr>
      <td style="vertical-align:top;">
        ${logoUrl ? `<img src="${escHtml(logoUrl)}" alt="${escHtml(company?.name || 'Company logo')}" height="44" style="height:44px;max-width:220px;display:block;margin-bottom:10px;">` : ''}
        <div style="font-size:22px;font-weight:800;color:#111827;">${escHtml(model.docTitle)}</div>
        ${model.subtitleHtml ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${model.subtitleHtml}</div>` : ''}
        ${model.preparedForHtml ? `<div style="font-size:13px;color:#6b7280;margin-top:2px;">${model.preparedForHtml}</div>` : ''}
        ${(model.identityLinesHtml || []).map((l, i) => `<div style="font-size:12px;color:#374151;margin-top:${i === 0 ? '6' : '2'}px;${i === 0 ? 'font-weight:600;' : ''}">${l}</div>`).join('')}
      </td>
      ${model.customerBlockHtml ? '' : `<td style="vertical-align:top;text-align:right;font-size:12px;color:#374151;line-height:1.5;">${companyLines}</td>`}
    </tr></table>

    ${model.customerBlockHtml ? `<table style="width:100%;border-collapse:collapse;margin-bottom:16px;"><tr>
      <td style="vertical-align:top;font-size:12px;color:#374151;line-height:1.5;">${companyLines}</td>
      <td style="vertical-align:top;font-size:12px;color:#374151;line-height:1.5;text-align:right;"><b style="color:#111827;">Customer</b><br>${model.customerBlockHtml}</td>
    </tr></table>` : ''}

    ${message ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#1e3a8a;white-space:pre-wrap;">${escHtml(message)}</div>` : ''}

    ${model.noteHtml ? `<div style="font-size:13px;color:#374151;margin:0 0 14px;">${model.noteHtml}</div>` : ''}

    ${model.diagram ? `<div style="margin:0 0 14px;"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:4px;">${escHtml(model.diagram.heading)}</div><img src="${escHtml(model.diagram.url)}" alt="${escHtml(model.diagram.heading)}" width="584" style="width:100%;max-width:584px;display:block;border:1px solid #e5e7eb;border-radius:8px;"></div>` : ''}

    ${model.columns ? `<table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="text-align:left;padding:0 10px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;">Item</th>
        <th style="text-align:right;padding:0 10px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;">${escHtml(model.columns.qty)}</th>
        <th style="text-align:right;padding:0 10px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;">${escHtml(model.columns.rate)}</th>
        <th style="text-align:right;padding:0 10px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;">Total</th>
      </tr></thead>
      <tbody>${model.rows.map(r => `<tr>${cell(r.itemHtml)}${cell(r.qtyHtml, true)}${cell(r.rateHtml, true)}${cell(r.totalHtml, true)}</tr>`).join('\n')}</tbody>
    </table>` : ''}

    ${model.totals ? `<table style="width:45%;min-width:240px;margin-left:auto;border-collapse:collapse;margin-top:10px;">
      ${model.totals.map(totalRow).join('\n      ')}
    </table>` : ''}

    ${(model.footnotesHtml || []).map((f, i) => `<div style="margin-top:${i === 0 ? '12' : '4'}px;font-size:11px;color:#6b7280;">${f}</div>`).join('')}

    ${(model.sections || []).map(s => section(s.title, s.bodyHtml)).join('')}

    ${(model.graphics || []).map(g => `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;margin-top:12px;font-size:13px;color:#111827;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Vinyl / Graphics</div>
      <div style="font-weight:700;">Quote ${escHtml(g.quoteNumber)}${g.vehicle ? ` — ${escHtml(g.vehicle)}` : ''}${g.totalSqft > 0 ? ` · ~${Math.round(g.totalSqft)} sqft coverage` : ''}</div>
      ${g.films.length > 0 ? `<ul style="margin:6px 0 0;padding-left:18px;">${g.films.map(f =>
        `<li style="margin-top:2px;">${escHtml(f.name)}${f.areas.length > 0 ? ` — ${escHtml(f.areas.join(', '))}` : ''}</li>`).join('')}</ul>` : ''}
      ${g.diagramUrl ? `<img src="${escHtml(g.diagramUrl)}" alt="Coverage diagram — Quote ${escHtml(g.quoteNumber)}" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px;margin-top:10px;display:block;">` : ''}
    </div>`).join('')}

    ${(model.proofs || []).map(p => `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;margin-top:12px;font-size:13px;color:#111827;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Graphic Proof${p.files.length !== 1 ? 's' : ''} — For Your Approval</div>
      <div style="font-weight:700;">${escHtml([p.jobNumber ? `Job #${p.jobNumber}` : null, p.jobTitle].filter(Boolean).join(' — ') || 'Graphics job')}</div>
      ${p.files.map(f => f.isPdf
        ? (f.url
          ? `<div style="margin-top:8px;"><a href="${escHtml(f.url)}" target="_blank" rel="noopener noreferrer" style="font-size:13px;color:#2563eb;text-decoration:underline;">Open ${escHtml(f.name)} (PDF) &#8599;</a></div>`
          : `<div style="margin-top:8px;font-size:12px;color:#374151;">${escHtml(f.name)} (PDF proof)</div>`)
        : (f.url
          ? `<img src="${escHtml(f.url)}" alt="Proof — ${escHtml(f.name)}" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px;margin-top:10px;display:block;">`
          : `<div style="margin-top:8px;font-size:12px;color:#374151;">${escHtml(f.name)} (image unavailable)</div>`)).join('')}
    </div>`).join('')}

    ${cta}

    ${renderSignatureHtml(signature, 'light')}
    ${signedBlockHtml || ''}
  </div>
  <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">Sent by ${escHtml(company?.name || 'BMG Fleet')}</div>
</body></html>`;
}
