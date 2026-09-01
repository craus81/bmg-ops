/**
 * The customer-facing quote document as a real PDF (jsPDF + autotable,
 * letter format) — rendered from the SAME `QuoteDocModel` that
 * `renderQuoteDocument` turns into the emailed/snapshot HTML
 * (src/lib/quote-document.ts).
 *
 * Rendering from the shared model (instead of a second hand-rolled
 * renderer) is the whole point: the wrap quote a customer is emailed, the
 * frozen signed snapshot, and the PDF staff open off the customer record
 * all come from one row producer, so they cannot drift into disagreeing
 * about what was quoted. Adapters own all number formatting; this file
 * only lays out what they produced.
 *
 * Pure builder — no window/DOM access, so a server route can generate the
 * bytes. Model fields arrive as pre-escaped HTML fragments; `htmlToText`
 * flattens them for the page.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { QuoteDocModel, QuoteDocRow } from './quote-document';

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·',
  ndash: '-', mdash: '-', hellip: '...', times: 'x', deg: '°', sup2: '²',
};

// helvetica (a standard-14 font) is WinAnsi-encoded: characters outside it
// render as garbage, so the few typographic ones our adapters emit are
// folded to ASCII before they reach the page.
const NON_WINANSI: [RegExp, string][] = [
  [/[−–—]/g, '-'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/…/g, '...'],
  [/[•●]/g, '-'],
];

/**
 * Flatten one pre-escaped model fragment to plain text.
 *
 * `<br>` and `<span>` both become line breaks: in every adapter a span is
 * the grey detail suffix under a row's label (`detailSpan`), which reads
 * as its own line in a PDF cell. All other tags are dropped and entities
 * decoded.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let s = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\s*<span\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z0-9]+);/gi, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m);
  for (const [re, to] of NON_WINANSI) s = s.replace(re, to);
  return s
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface QuoteDocPdfImage {
  dataUrl: string;
  format: 'JPEG' | 'PNG';
}

export interface QuoteDocPdfOptions {
  company?: {
    name?: string | null; address?: string | null; city?: string | null;
    state?: string | null; zip?: string | null; phone?: string | null;
    email?: string | null;
  } | null;
  /** Letterhead logo, already fetched and inlined (jsPDF can't fetch). */
  logo?: QuoteDocPdfImage | null;
}

export function buildQuoteDocPdf(model: QuoteDocModel, opts: QuoteDocPdfOptions = {}): jsPDF {
  const { company, logo } = opts;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  let y = 48;

  // ── Letterhead — same pairing as the estimate/statement PDFs ───────────
  if (logo) {
    try {
      const props = doc.getImageProperties(logo.dataUrl);
      const h = 34;
      const w = Math.min(160, (props.width / props.height) * h);
      doc.addImage(logo.dataUrl, logo.format, margin, y - 12, w, h, undefined, 'FAST');
      y += h - 2;
    } catch { /* unreadable logo — fall through to the text letterhead */ }
  }

  doc.setFontSize(20).setFont('helvetica', 'bold').setTextColor(17, 24, 39);
  doc.text(htmlToText(model.docTitle) || 'Quote', margin, y + 12);
  let leftY = y + 26;

  const leftWidth = pageW * 0.55;
  const writeLeft = (text: string, size: number, style: 'normal' | 'bold', rgb: [number, number, number]) => {
    if (!text) return;
    doc.setFontSize(size).setFont('helvetica', style).setTextColor(...rgb);
    const wrapped = doc.splitTextToSize(text, leftWidth);
    doc.text(wrapped, margin, leftY);
    leftY += wrapped.length * (size + 2.5);
  };

  writeLeft(htmlToText(model.subtitleHtml), 10, 'normal', [107, 114, 128]);
  writeLeft(htmlToText(model.preparedForHtml), 10, 'normal', [107, 114, 128]);
  for (const line of model.identityLinesHtml || []) {
    writeLeft(htmlToText(line), 9.5, 'bold', [55, 65, 81]);
  }

  // Company block, right-aligned.
  let rightY = y + 14;
  if (company?.name) {
    doc.setFontSize(11).setFont('helvetica', 'bold').setTextColor(17, 24, 39);
    doc.text(String(company.name), pageW - margin, rightY, { align: 'right' });
    rightY += 12;
  }
  doc.setFontSize(9.5).setFont('helvetica', 'normal').setTextColor(55, 65, 81);
  const companyLines = [
    company?.address,
    [company?.city, company?.state, company?.zip].filter(Boolean).join(', '),
    company?.phone,
    company?.email,
  ].filter((l): l is string => !!l && String(l).trim().length > 0);
  for (const line of companyLines) {
    doc.text(String(line), pageW - margin, rightY, { align: 'right' });
    rightY += 12;
  }

  let cursorY = Math.max(leftY, rightY) + 12;
  const ensureRoom = (needed: number) => {
    if (cursorY + needed > pageH - margin) {
      doc.addPage();
      cursorY = margin + 8;
    }
  };

  // ── Bill-to block (wrap-style customer address) ────────────────────────
  const customerBlock = htmlToText(model.customerBlockHtml);
  if (customerBlock) {
    const lines = customerBlock.split('\n');
    ensureRoom(16 + lines.length * 12);
    doc.setFontSize(8).setFont('helvetica', 'bold').setTextColor(107, 114, 128);
    doc.text('PREPARED FOR', margin, cursorY);
    cursorY += 12;
    doc.setFontSize(9.5).setFont('helvetica', 'normal').setTextColor(17, 24, 39);
    doc.text(lines, margin, cursorY);
    cursorY += lines.length * 12 + 4;
  }

  const note = htmlToText(model.noteHtml);
  if (note) {
    const wrapped = doc.setFontSize(9.5).splitTextToSize(note, pageW - margin * 2);
    ensureRoom(wrapped.length * 12 + 6);
    doc.setFont('helvetica', 'normal').setTextColor(55, 65, 81);
    doc.text(wrapped, margin, cursorY);
    cursorY += wrapped.length * 12 + 6;
  }

  // ── Line table — omitted entirely when the model carries no columns
  //    (coverage-only sends, quotes with line items hidden) ──────────────
  if (model.columns && model.rows.length > 0) {
    const cell = (r: QuoteDocRow, k: keyof QuoteDocRow) => htmlToText(r[k]);
    autoTable(doc, {
      startY: cursorY + 4,
      margin: { left: margin, right: margin },
      head: [['Item', model.columns.qty, model.columns.rate, 'Total']],
      body: model.rows.map(r => [cell(r, 'itemHtml'), cell(r, 'qtyHtml'), cell(r, 'rateHtml'), cell(r, 'totalHtml')]),
      styles: { fontSize: 9, cellPadding: 5, valign: 'top' },
      headStyles: { fillColor: [37, 99, 235], fontSize: 8.5 },
      columnStyles: {
        1: { halign: 'right', cellWidth: 40 },
        2: { halign: 'right', cellWidth: 64 },
        3: { halign: 'right', cellWidth: 70 },
      },
    });
    cursorY = (doc as any).lastAutoTable.finalY + 14;
  }

  // ── Totals — right-aligned block, same rows as the HTML document ───────
  if (model.totals && model.totals.length > 0) {
    ensureRoom(model.totals.length * 16 + 10);
    const valueX = pageW - margin;
    const labelX = pageW - margin - 84;
    for (const t of model.totals) {
      if (t.bold) {
        doc.setDrawColor(209, 213, 219).setLineWidth(1.2);
        doc.line(pageW - margin - 240, cursorY - 9, pageW - margin, cursorY - 9);
        doc.setFontSize(11.5).setFont('helvetica', 'bold');
      } else {
        doc.setFontSize(9.5).setFont('helvetica', 'normal');
      }
      const rgb = hexToRgb(t.color) || [17, 24, 39];
      doc.setTextColor(...rgb);
      doc.text(htmlToText(t.labelHtml), labelX, cursorY, { align: 'right' });
      doc.text(htmlToText(t.valueHtml), valueX, cursorY, { align: 'right' });
      cursorY += t.bold ? 17 : 14;
    }
  }

  // ── Context sections (project notes, install instructions, …) ──────────
  for (const s of model.sections || []) {
    const body = htmlToText(s.bodyHtml);
    if (!body) continue;
    const wrapped = doc.setFontSize(9.5).splitTextToSize(body, pageW - margin * 2);
    ensureRoom(18 + wrapped.length * 12);
    cursorY += 8;
    doc.setFontSize(8).setFont('helvetica', 'bold').setTextColor(107, 114, 128);
    doc.text(s.title.toUpperCase(), margin, cursorY);
    cursorY += 12;
    doc.setFontSize(9.5).setFont('helvetica', 'normal').setTextColor(17, 24, 39);
    doc.text(wrapped, margin, cursorY);
    cursorY += wrapped.length * 12;
  }

  // ── Vinyl / graphics blocks (estimates carrying wrap content) ──────────
  for (const g of model.graphics || []) {
    const filmLines = g.films.map(f => `- ${f.name}${f.areas.length > 0 ? ` — ${f.areas.join(', ')}` : ''}`);
    ensureRoom(30 + filmLines.length * 12);
    cursorY += 8;
    doc.setFontSize(8).setFont('helvetica', 'bold').setTextColor(107, 114, 128);
    doc.text('VINYL / GRAPHICS', margin, cursorY);
    cursorY += 12;
    doc.setFontSize(9.5).setFont('helvetica', 'bold').setTextColor(17, 24, 39);
    doc.text(
      htmlToText(`Quote ${g.quoteNumber}${g.vehicle ? ` — ${g.vehicle}` : ''}${g.totalSqft > 0 ? ` · ~${g.totalSqft.toFixed(0)} sqft coverage` : ''}`),
      margin, cursorY,
    );
    cursorY += 13;
    doc.setFont('helvetica', 'normal');
    for (const fl of filmLines) {
      const wrapped = doc.splitTextToSize(htmlToText(fl), pageW - margin * 2 - 6);
      ensureRoom(wrapped.length * 12);
      doc.text(wrapped, margin + 4, cursorY);
      cursorY += wrapped.length * 12;
    }
  }

  // ── Footnotes (film usage, nesting note) ───────────────────────────────
  const footnotes = (model.footnotesHtml || []).map(htmlToText).filter(Boolean);
  if (footnotes.length > 0) {
    cursorY += 8;
    doc.setFontSize(8.5).setFont('helvetica', 'normal').setTextColor(107, 114, 128);
    for (const f of footnotes) {
      const wrapped = doc.splitTextToSize(f, pageW - margin * 2);
      ensureRoom(wrapped.length * 11);
      doc.text(wrapped, margin, cursorY);
      cursorY += wrapped.length * 11;
    }
  }

  return doc;
}

/** '#7c3aed' → [124, 58, 237]; null for anything else (use the default). */
function hexToRgb(hex: string | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
