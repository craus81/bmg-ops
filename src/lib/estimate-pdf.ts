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
import { discountLabel, normalizeVehicleCount, perVehicleAmount } from './estimate-totals';
import { kitComponentShowsPhoto, toKitDisplayLines } from './estimate-kits';

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
  /** This line's own discount (migration 350); amount covers all vehicles. */
  discount_type?: string | null;
  discount_value?: number | string | null;
  discount_amount?: number | string | null;
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
  /** Pro forma invoice (Craig, 2026-10-20): a dealer's lender wants an
   *  invoice before the work so it can fund the customer. Same content as
   *  the estimate, retitled, with a "not a bill" notice. Nothing is posted
   *  to NetSuite or Books — the real invoice still comes off the SO when
   *  the work is done. */
  proForma?: { issuedDate: string } | null;
}

const money = (n: any) => `$${Number(n || 0).toFixed(2)}`;

const PHOTO = 40; // thumbnail edge in pt
const KIT_PHOTO = 28; // a hitch kit part's thumbnail, under its kit line
// Plain ASCII — helvetica (standard-14 font) has no arrow glyphs.
const LINK_LABEL = 'View product';

export function buildEstimatePdf(data: EstimatePdfData): jsPDF {
  const { estimate: est, company, logo, graphics, proForma } = data;
  // Rack kits: one priced rack line, components indented beneath it.
  // A line's own discount (migration 350) is its own row under the line.
  const lines = toKitDisplayLines(data.lines).flatMap((l: any) => (Number(l.discount_amount) > 0
    ? [l, {
      discount_row: true,
      item_number: discountLabel(l.discount_type, l.discount_value, l.discount_description),
      quantity: 0,
      unit_price: 0,
      discount_amount: l.discount_amount,
    } as any]
    : [l]));
  // Fleet multi-unit (R6-9, migration 304). 1 on every ordinary estimate,
  // which leaves this PDF byte-identical to what it produced before.
  const units = normalizeVehicleCount((est as any).vehicle_count);
  const perVehicle = perVehicleAmount(est.grand_total, (est as any).vehicle_count);
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
      y += h + 8; // clear gap between the logo and the estimate number
    } catch { /* unreadable logo — fall through to the text letterhead */ }
  }

  doc.setFontSize(20).setFont('helvetica', 'bold').setTextColor(17, 24, 39);
  doc.text(proForma ? 'Pro Forma Invoice' : `Estimate #${est.estimate_number ?? ''}`, margin, y + 12);
  let leftY = y + 26;
  doc.setFontSize(10).setFont('helvetica', 'normal').setTextColor(107, 114, 128);
  if (proForma) {
    doc.text(`For Estimate #${est.estimate_number ?? ''} · Issued ${proForma.issuedDate}`, margin, leftY);
    leftY += 13;
  }
  if (est.title) { doc.text(String(est.title), margin, leftY, { maxWidth: pageW * 0.55 }); leftY += 13; }
  doc.text(proForma ? `Bill to ${est.customer_name || ''}` : `Prepared for ${est.customer_name || 'you'}`, margin, leftY);
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
    // A pro forma has no expiry — the lender may take weeks to fund.
    est.expiration_date && !proForma ? `Expires ${est.expiration_date}` : '',
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
  const hasPhotos = lines.some(l => !!l.image && (!(l as any).kit_component || kitComponentShowsPhoto(l as any)));
  const itemCell = (l: EstimatePdfLine & { kit_component?: boolean }) => {
    const label = l.item_number || l.description || 'Item';
    if (l.kit_component) {
      // Indented under its rack; plain ASCII (no arrow glyph in helvetica).
      const desc = l.description && l.description !== label ? `  ${l.description}` : '';
      return `    - ${label}${desc}`;
    }
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
    // Fleet estimates (R6-9): quantities are per vehicle, line totals cover
    // the whole order — same rule as the HTML document, so the PDF and the
    // approval page can never disagree about what a line costs.
    const lineTotal = (Number(l.line_total ?? (Number(l.unit_price) || 0) * (Number(l.quantity) || 0)) || 0) * units;
    const qtyCell = units > 1 ? `${l.quantity ?? ''} x ${units}` : String(l.quantity ?? '');
    const cells = (l as any).discount_row
      ? [`    ${l.item_number}`, '', '', `-${money(l.discount_amount)}`]
      : (l as any).kit_component
        ? [itemCell(l), qtyCell, '', '']
        : [itemCell(l), qtyCell, money(l.unit_price), money(lineTotal)];
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
    // BMG logo red (#EE4023), not a stock blue.
    headStyles: { fillColor: [238, 64, 35], textColor: 255, fontSize: 8.5 },
    columnStyles: {
      ...(hasPhotos ? { 0: { cellWidth: PHOTO + 10 } } : {}),
      [col(1)]: { halign: 'right', cellWidth: 40 },
      [col(2)]: { halign: 'right', cellWidth: 64 },
      [col(3)]: { halign: 'right', cellWidth: 70 },
    },
    didParseCell: (hook) => {
      // Qty/Rate/Total headings sit over their right-aligned numbers.
      if (hook.section === 'head' && hook.column.index >= col(1)) hook.cell.styles.halign = 'right';
      if (hook.section !== 'body') return;
      const line = lines[hook.row.index];
      if (hasPhotos && line?.image && !(line as any).kit_component) hook.cell.styles.minCellHeight = PHOTO + 10;
      // A hitch kit's parts carry a smaller photo.
      if (hasPhotos && line?.image && kitComponentShowsPhoto(line as any)) hook.cell.styles.minCellHeight = KIT_PHOTO + 6;
      // Components under a rack read smaller and lighter than priced lines.
      if ((line as any)?.kit_component) {
        hook.cell.styles.fontSize = 8;
        hook.cell.styles.textColor = [75, 85, 99];
        hook.cell.styles.cellPadding = { top: 2, bottom: 2, left: 5, right: 5 };
      }
      if ((line as any)?.kit_header) hook.cell.styles.fontStyle = 'bold';
      if ((line as any)?.discount_row) {
        hook.cell.styles.fontSize = 8.5;
        hook.cell.styles.textColor = [21, 128, 61];
        hook.cell.styles.cellPadding = { top: 2, bottom: 2, left: 5, right: 5 };
      }
    },
    didDrawCell: (hook) => {
      if (hook.section !== 'body') return;
      const line = lines[hook.row.index];
      if (line && hasPhotos && hook.column.index === 0 && line.image && kitComponentShowsPhoto(line as any)) {
        try {
          doc.addImage(line.image.dataUrl, line.image.format,
            hook.cell.x + 5 + (PHOTO - KIT_PHOTO), hook.cell.y + 3, KIT_PHOTO, KIT_PHOTO, undefined, 'FAST');
        } catch { /* bad image data — leave the cell empty */ }
        return;
      }
      // Components under a rack stay one compact text row: no photo, no link.
      if (!line || (line as any).kit_component || (line as any).discount_row) return;
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
  if (Number((est as any).discount_amount) > 0) {
    totals.push([discountLabel((est as any).discount_type, (est as any).discount_value, (est as any).discount_description), `-${money((est as any).discount_amount)}`, false]);
  }
  if (!est.tax_exempt && Number(est.tax_amount) > 0) {
    totals.push([`Tax (${(Number(est.tax_rate) * 100).toFixed(2)}%)`, money(est.tax_amount), false]);
  }
  if (est.tax_exempt) totals.push(['Tax', 'Exempt', false]);
  if (perVehicle) {
    totals.push([`Per vehicle (x ${units})`, `${perVehicle.exact ? '' : '~ '}${money(perVehicle.amount)}`, false]);
  }
  totals.push(['Total', money(est.grand_total), true]);

  ensureRoom(totals.length * 15 + 26);
  const valueX = pageW - margin;
  const labelX = pageW - margin - 84;
  for (const [label, value, bold] of totals) {
    if (bold) {
      // Breathing room on both sides of the rule so the bold Total
      // doesn't sit on it.
      cursorY += 6;
      doc.setDrawColor(209, 213, 219).setLineWidth(1.2);
      doc.line(pageW - margin - 240, cursorY - 9, pageW - margin, cursorY - 9);
      cursorY += 10;
      doc.setFontSize(11.5).setFont('helvetica', 'bold');
    } else {
      doc.setFontSize(9.5).setFont('helvetica', 'normal');
    }
    doc.setTextColor(17, 24, 39);
    doc.text(label, labelX, cursorY, { align: 'right' });
    doc.text(value, valueX, cursorY, { align: 'right' });
    cursorY += bold ? 17 : 14;
  }

  // ── Pro forma notice — right under the total the lender will read ─────
  if (proForma) {
    const boxW = pageW - margin * 2;
    const body = doc.setFontSize(9.5).splitTextToSize(PRO_FORMA_NOTICE, boxW - 24);
    const boxH = 30 + body.length * 12;
    ensureRoom(boxH + 12);
    cursorY += 6;
    doc.setFillColor(255, 247, 237).setDrawColor(251, 146, 60).setLineWidth(1);
    doc.roundedRect(margin, cursorY, boxW, boxH, 4, 4, 'FD');
    doc.setFontSize(9).setFont('helvetica', 'bold').setTextColor(154, 52, 18);
    doc.text('PRO FORMA - NOT A BILL', margin + 12, cursorY + 16);
    doc.setFontSize(9.5).setFont('helvetica', 'normal').setTextColor(17, 24, 39);
    doc.text(body, margin + 12, cursorY + 30);
    cursorY += boxH + 8;
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

export const PRO_FORMA_NOTICE = 'This pro forma invoice shows the price of the work listed above so it can be '
  + 'submitted for financing. It is not a request for payment. We will send the final invoice when the work '
  + 'is complete, and the final amount will change only if the work changes.';

/** File name for the generated PDF, shared by the view and email routes. */
export function estimatePdfFilename(est: any, opts: { proForma?: boolean } = {}): string {
  const num = String(est?.estimate_number ?? 'estimate').replace(/[^\w\-]+/g, '_');
  return opts.proForma ? `Pro-Forma-Invoice-${num}.pdf` : `Estimate-${num}.pdf`;
}

/** "October 20, 2026" in BMG's own time zone — the pro forma's issue date. */
export function proFormaIssuedDate(now: Date = new Date()): string {
  return now.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' });
}
