/**
 * The FleetSuite enhanced-estimate copy as a real PDF (jsPDF + autotable,
 * letter format) — the same customer-facing content as
 * `renderEstimateDocument` (src/lib/estimate-document.ts): header with
 * letterhead, vehicle/VIN/unit context, the line table with catalog photos
 * and vendor product links, totals, and the install/on-site/delivery/notes
 * sections. Keep the two in step: if a field is added to the HTML document,
 * it belongs here too.
 *
 * Pure builder — no window/DOM access, so the server can generate the same
 * bytes for viewing, printing (autoPrint), and email attachments. Callers
 * resolve images to data URLs first (jsPDF can't fetch).
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { vehicleDescription } from './estimate-document';

export interface EstimatePdfImage {
  dataUrl: string;
  format: 'JPEG' | 'PNG';
}

export interface EstimatePdfLine {
  item_number?: string | null;
  description?: string | null;
  notes?: string | null;
  quantity: number;
  unit_price: number;
  line_total?: number | null;
  /** Vendor product-page link (https, pre-validated by the enrichment). */
  part_product_url?: string | null;
  /** Catalog photo, already fetched and inlined. */
  image?: EstimatePdfImage | null;
}

export interface EstimatePdfGraphics {
  quoteNumber: string;
  vehicle: string | null;
  totalSqft: number;
  /** Film name → the coverage areas using it (measurement names). */
  films: { name: string; areas: string[] }[];
}

export interface EstimatePdfData {
  /** The estimates row, with vehicle_platform_label flattened on. */
  estimate: any;
  /** estimate_line_items in display order, enriched + images resolved. */
  lines: EstimatePdfLine[];
  company?: {
    name?: string | null; address?: string | null; city?: string | null;
    state?: string | null; zip?: string | null; phone?: string | null;
    email?: string | null;
  } | null;
  logo?: EstimatePdfImage | null;
  /** Linked wrap quotes whose "Vinyl details" checkbox was on — rendered
   *  as a Vinyl / Graphics section (film names + coverage areas). */
  graphics?: EstimatePdfGraphics[];
}

const money = (n: any) => `$${Number(n || 0).toFixed(2)}`;

const PHOTO = 40; // thumbnail edge in pt
// Plain ASCII — helvetica (standard-14 font) has no arrow glyphs.
const LINK_LABEL = 'View product';

export function buildEstimatePdf(data: EstimatePdfData): jsPDF {
  const { estimate: est, lines, company, logo, graphics } = data;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  let y = 48;

  // ── Letterhead — same pairing as the statement PDF ─────────────────────
  if (logo) {
    try {
      const props = doc.getImageProperties(logo.dataUrl);
      const h = 34;
      const w = Math.min(160, (props.width / props.height) * h);
      // 'FAST' (deflate) keeps embedded images from ballooning the file.
      doc.addImage(logo.dataUrl, logo.format, margin, y - 12, w, h, undefined, 'FAST');
      y += h - 2;
    } catch { /* unreadable logo — fall through to the text letterhead */ }
  }

  doc.setFontSize(20).setFont('helvetica', 'bold').setTextColor(17, 24, 39);
  doc.text(`Estimate #${est.estimate_number ?? ''}`, margin, y + 12);
  let leftY = y + 26;
  doc.setFontSize(10).setFont('helvetica', 'normal').setTextColor(107, 114, 128);
  if (est.title) { doc.text(String(est.title), margin, leftY, { maxWidth: pageW * 0.55 }); leftY += 13; }
  doc.text(`Prepared for ${est.customer_name || 'you'}`, margin, leftY);
  leftY += 13;
  const vehicleLine = [
    vehicleDescription(est),
    est.vin ? `VIN ${est.vin}` : '',
    est.unit_number ? `Unit ${est.unit_number}` : '',
  ].filter(Boolean).join(' · ');
  doc.setFontSize(9.5).setTextColor(55, 65, 81);
  if (vehicleLine) {
    doc.setFont('helvetica', 'bold');
    doc.text(vehicleLine, margin, leftY, { maxWidth: pageW * 0.55 });
    doc.setFont('helvetica', 'normal');
    leftY += 12 * doc.splitTextToSize(vehicleLine, pageW * 0.55).length;
  }
  const refLine = [
    est.po_number ? `PO #${est.po_number}` : '',
    est.expiration_date ? `Expires ${est.expiration_date}` : '',
  ].filter(Boolean).join(' · ');
  if (refLine) { doc.text(refLine, margin, leftY); leftY += 12; }

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
  doc.setTextColor(0);

  const tableY = Math.max(leftY, rightY) + 16;

  // ── Line table — photo column only when any line has one ───────────────
  const hasPhotos = lines.some(l => !!l.image);
  const itemCell = (l: EstimatePdfLine) => {
    const label = l.item_number || l.description || 'Item';
    const parts = [label];
    // Compare against the label, not item_number — a line with no item
    // number uses its description AS the label and must not repeat it.
    if (l.description && l.description !== label) parts.push(String(l.description));
    if (l.notes) parts.push(String(l.notes));
    // Reserve a line for the product link — drawn as a real link annotation
    // in didDrawCell (autotable cells are single-style, links aren't text).
    if (l.part_product_url) parts.push(' ');
    return parts.join('\n');
  };
  const bodyRows = lines.map(l => {
    const lineTotal = Number(l.line_total ?? (Number(l.unit_price) || 0) * (Number(l.quantity) || 0)) || 0;
    const cells = [itemCell(l), String(l.quantity ?? ''), money(l.unit_price), money(lineTotal)];
    if (hasPhotos) cells.unshift('');
    return cells;
  });
  const head = hasPhotos
    ? [['', 'Item', 'Qty', 'Rate', 'Total']]
    : [['Item', 'Qty', 'Rate', 'Total']];
  const col = (i: number) => (hasPhotos ? i + 1 : i); // logical → actual index

  autoTable(doc, {
    startY: tableY,
    margin: { left: margin, right: margin },
    head,
    body: bodyRows,
    styles: { fontSize: 9, cellPadding: 5, valign: 'top' },
    headStyles: { fillColor: [37, 99, 235], fontSize: 8.5 },
    columnStyles: {
      ...(hasPhotos ? { 0: { cellWidth: PHOTO + 10 } } : {}),
      [col(1)]: { halign: 'right', cellWidth: 40 },
      [col(2)]: { halign: 'right', cellWidth: 64 },
      [col(3)]: { halign: 'right', cellWidth: 70 },
    },
    didParseCell: (hook) => {
      if (hook.section !== 'body') return;
      const line = lines[hook.row.index];
      if (hasPhotos && line?.image) hook.cell.styles.minCellHeight = PHOTO + 10;
    },
    didDrawCell: (hook) => {
      if (hook.section !== 'body') return;
      const line = lines[hook.row.index];
      if (!line) return;
      if (hasPhotos && hook.column.index === 0 && line.image) {
        try {
          doc.addImage(line.image.dataUrl, line.image.format,
            hook.cell.x + 5, hook.cell.y + 5, PHOTO, PHOTO, undefined, 'FAST');
        } catch { /* bad image data — leave the cell empty */ }
      }
      if (hook.column.index === col(0) && line.part_product_url) {
        // The reserved blank line at the cell's bottom gets the blue link —
        // plain text plus a link rect (textWithLink inherits autotable's
        // character spacing and renders stretched).
        (doc as any).setCharSpace?.(0);
        doc.setFontSize(8.5).setTextColor(37, 99, 235);
        const tx = hook.cell.x + 5;
        const ty = hook.cell.y + hook.cell.height - 8;
        doc.text(LINK_LABEL, tx, ty);
        doc.link(tx, ty - 8, doc.getTextWidth(LINK_LABEL), 10, { url: line.part_product_url });
        doc.setFontSize(9).setTextColor(0);
      }
    },
  });

  let cursorY = (doc as any).lastAutoTable.finalY + 14;
  const ensureRoom = (needed: number) => {
    if (cursorY + needed > pageH - margin) {
      doc.addPage();
      cursorY = margin + 8;
    }
  };

  // ── Totals — right-aligned block, same rows as the HTML document ───────
  const laborHours = est.labor_hours_override ?? est.labor_hours;
  const totals: [string, string, boolean][] = [['Subtotal', money(est.subtotal), false]];
  if (Number(est.labor_total) > 0) {
    totals.push([`Labor (${laborHours} hrs @ $${est.labor_rate}/hr)`, money(est.labor_total), false]);
  }
  if (!est.tax_exempt && Number(est.tax_amount) > 0) {
    totals.push([`Tax (${(Number(est.tax_rate) * 100).toFixed(2)}%)`, money(est.tax_amount), false]);
  }
  if (est.tax_exempt) totals.push(['Tax', 'Exempt', false]);
  totals.push(['Total', money(est.grand_total), true]);

  ensureRoom(totals.length * 15 + 10);
  const valueX = pageW - margin;
  const labelX = pageW - margin - 84;
  for (const [label, value, bold] of totals) {
    if (bold) {
      doc.setDrawColor(209, 213, 219).setLineWidth(1.2);
      doc.line(pageW - margin - 240, cursorY - 9, pageW - margin, cursorY - 9);
      doc.setFontSize(11.5).setFont('helvetica', 'bold');
    } else {
      doc.setFontSize(9.5).setFont('helvetica', 'normal');
    }
    doc.setTextColor(17, 24, 39);
    doc.text(label, labelX, cursorY, { align: 'right' });
    doc.text(value, valueX, cursorY, { align: 'right' });
    cursorY += bold ? 17 : 14;
  }

  // ── Context sections — mirror the HTML document's order ────────────────
  const sections: [string, string][] = [];
  if (est.install_instructions) sections.push(['Install Instructions', String(est.install_instructions)]);
  if (est.on_site_contact_name || est.on_site_contact_phone) {
    sections.push(['On-site Contact',
      [est.on_site_contact_name, est.on_site_contact_phone].filter(Boolean).join(' · ')]);
  }
  if (est.delivery_preferences) sections.push(['Delivery', String(est.delivery_preferences)]);
  if (est.notes) sections.push(['Notes', String(est.notes)]);

  for (const [title, body] of sections) {
    const wrapped = doc.setFontSize(9.5).splitTextToSize(body, pageW - margin * 2);
    ensureRoom(18 + wrapped.length * 12);
    cursorY += 8;
    doc.setFontSize(8).setFont('helvetica', 'bold').setTextColor(107, 114, 128);
    doc.text(title.toUpperCase(), margin, cursorY);
    cursorY += 12;
    doc.setFontSize(9.5).setFont('helvetica', 'normal').setTextColor(17, 24, 39);
    doc.text(wrapped, margin, cursorY);
    cursorY += wrapped.length * 12;
  }

  // ── Vinyl / Graphics — films + coverage from linked wrap quotes ────────
  for (const g of graphics || []) {
    const filmLines = g.films.map(f =>
      `• ${f.name}${f.areas.length > 0 ? ` — ${f.areas.join(', ')}` : ''}`);
    ensureRoom(30 + filmLines.length * 12);
    cursorY += 8;
    doc.setFontSize(8).setFont('helvetica', 'bold').setTextColor(107, 114, 128);
    doc.text('VINYL / GRAPHICS', margin, cursorY);
    cursorY += 12;
    doc.setFontSize(9.5).setFont('helvetica', 'bold').setTextColor(17, 24, 39);
    doc.text(
      `Quote ${g.quoteNumber}${g.vehicle ? ` — ${g.vehicle}` : ''}${g.totalSqft > 0 ? ` · ~${g.totalSqft.toFixed(0)} sqft coverage` : ''}`,
      margin, cursorY,
    );
    cursorY += 13;
    doc.setFont('helvetica', 'normal');
    for (const fl of filmLines) {
      const wrapped = doc.splitTextToSize(fl, pageW - margin * 2 - 6);
      ensureRoom(wrapped.length * 12);
      doc.text(wrapped, margin + 4, cursorY);
      cursorY += wrapped.length * 12;
    }
  }

  return doc;
}

/** File name for the generated PDF, shared by the view and email routes. */
export function estimatePdfFilename(est: any): string {
  const num = String(est?.estimate_number ?? 'estimate').replace(/[^\w\-]+/g, '_');
  return `Estimate-${num}.pdf`;
}
