/**
 * Job Order PDF — a sales order printed as a shop pick ticket, with no
 * pricing (see job-order.ts). Same letter-size layout family as
 * packing-list-pdf.ts: logo + title, reference block, customer / ship-to,
 * then qty · part · description lines with an empty Picked box per line
 * and Picked by / Checked by sign-off lines.
 *
 * buildJobOrderPdf is pure (testable in node); openJobOrder is the click
 * handler that fetches the live SO and opens the print dialog.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { JobOrderData } from './job-order';

// Preloaded at module load: an await before window.open() would invite the
// popup blocker (same reasoning as packing-list-pdf.ts). Until it arrives
// the header falls back to the "BMG Fleet" text wordmark.
let logoDataUrl: string | null = null;
let logoFetch: Promise<void> | null = null;

function ensureLogoLoaded(): void {
  if (logoDataUrl || logoFetch || typeof window === 'undefined') return;
  logoFetch = fetch('/bmg-logo-color.png')
    .then(res => { if (!res.ok) throw new Error(String(res.status)); return res.blob(); })
    .then(blob => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }))
    .then(url => { logoDataUrl = url; })
    .catch(() => { logoFetch = null; });
}
ensureLogoLoaded();

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '';
  // NetSuite SuiteQL dates arrive as M/D/YYYY; Date parses those fine.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const fmtQty = (q: number | null) =>
  q == null ? '' : Number.isInteger(q) ? String(q) : String(Number(q.toFixed(4)));

export function jobOrderFilename(data: Pick<JobOrderData, 'soNumber'>): string {
  return `job-order-${String(data.soNumber).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`;
}

export function buildJobOrderPdf(data: JobOrderData, opts?: { logo?: string | null; printedAt?: Date }): jsPDF {
  const logo = opts?.logo === undefined ? logoDataUrl : opts.logo;
  const printedAt = opts?.printedAt || new Date();
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  let y = margin;

  // ─── Header ────────────────────────────────────────────────
  let logoBottom = 0;
  if (logo) {
    try {
      const props = doc.getImageProperties(logo);
      const h = 40;
      const w = Math.min(160, (props.width / props.height) * h);
      doc.addImage(logo, 'PNG', margin, y - 12, w, h, undefined, 'FAST');
      logoBottom = y - 12 + h;
    } catch { /* unreadable image — use the text wordmark */ }
  }
  if (!logoBottom) {
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.text('BMG Fleet', margin, y);
  }

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('JOB ORDER', pageW - margin, y, { align: 'right' });
  y = logoBottom ? logoBottom + 18 : y + 22;

  // ─── Reference block (right) ───────────────────────────────
  const refs: [string, string][] = [['Job Order #', data.soNumber]];
  if (data.orderDate) refs.push(['Order Date', fmtDate(data.orderDate)]);
  if (data.poNumber) refs.push(['PO #', data.poNumber]);
  if (data.shipDate) refs.push(['Ship Date', fmtDate(data.shipDate)]);
  if (data.shipMethod) refs.push(['Ship Via', data.shipMethod]);
  if (data.salesRep) refs.push(['Sales Rep', data.salesRep]);
  if (data.status) refs.push(['Status', data.status]);

  let refY = margin + 22;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  const maxValueW = Math.max(...refs.map(([, v]) => doc.getTextWidth(v)));
  doc.setFont('helvetica', 'bold');
  const maxLabelW = Math.max(...refs.map(([l]) => doc.getTextWidth(l)));
  const labelX = pageW - margin - Math.max(maxValueW + maxLabelW + 10, 110);
  for (const [label, value] of refs) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(110);
    doc.text(label, labelX, refY);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0);
    doc.text(value, pageW - margin, refY, { align: 'right' });
    refY += 13;
  }

  // ─── Customer / Ship To (left) ─────────────────────────────
  const leftW = labelX - margin - 20;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text('CUSTOMER', margin, y);
  doc.setTextColor(0);
  y += 14;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  const custLines = doc.splitTextToSize(data.customer || '—', leftW);
  doc.text(custLines, margin, y);
  y += custLines.length * 14;

  if (data.shipTo) {
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text('SHIP TO', margin, y);
    doc.setTextColor(0);
    y += 13;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const shipLines = doc.splitTextToSize(data.shipTo, leftW);
    doc.text(shipLines, margin, y);
    y += shipLines.length * 13;
  }

  y = Math.max(y, refY) + 10;

  // ─── VIN / memo ────────────────────────────────────────────
  if (data.vin) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(`VIN: ${data.vin}`, margin, y);
    y += 16;
  }
  if (data.memo) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text('MEMO', margin, y);
    doc.setTextColor(0);
    y += 12;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const memoLines = doc.splitTextToSize(data.memo, pageW - margin * 2);
    doc.text(memoLines, margin, y);
    y += memoLines.length * 13;
  }
  y += 6;

  // ─── Lines (no pricing) ────────────────────────────────────
  autoTable(doc, {
    startY: y,
    head: [['Qty', 'Part Number', 'Description', 'Picked']],
    body: data.lines.length > 0
      ? data.lines.map(l => [fmtQty(l.quantity), l.partNumber || '', l.description || '', ''])
      : [['', '', 'No lines on this sales order', '']],
    styles: { fontSize: 10, cellPadding: 6, valign: 'middle' },
    headStyles: { fillColor: [37, 99, 235], textColor: 255 },
    margin: { left: margin, right: margin, bottom: 50 },
    columnStyles: {
      0: { cellWidth: 45, halign: 'center' },
      1: { cellWidth: 140 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 50, halign: 'center' },
    },
    didDrawCell: (hook) => {
      // An empty tick box in the Picked column of every real line.
      if (hook.section !== 'body' || hook.column.index !== 3 || data.lines.length === 0) return;
      if (data.lines[hook.row.index]?.quantity == null) return;
      const s = 10;
      doc.setDrawColor(90);
      doc.rect(hook.cell.x + (hook.cell.width - s) / 2, hook.cell.y + (hook.cell.height - s) / 2, s, s);
    },
  });
  y = (doc as any).lastAutoTable.finalY + 18;

  // ─── Sign-off lines ────────────────────────────────────────
  if (y > pageH - 100) { doc.addPage(); y = margin; }
  const signY = Math.max(y + 30, pageH - 90);
  const colW = (pageW - margin * 2 - 30) / 2;
  doc.setDrawColor(150);
  doc.line(margin, signY, margin + colW, signY);
  doc.line(margin + colW + 30, signY, pageW - margin, signY);
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text('Picked by / Date', margin, signY + 12);
  doc.text('Checked by / Date', margin + colW + 30, signY + 12);
  doc.setTextColor(0);

  // ─── Footer on every page ──────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`BMG Fleet · Job Order ${data.soNumber} · printed ${printedAt.toLocaleString('en-US')}`, margin, pageH - 20);
    if (pages > 1) doc.text(`Page ${p} of ${pages}`, pageW - margin, pageH - 20, { align: 'right' });
    doc.setTextColor(0);
  }

  return doc;
}

/**
 * Click handler: open a tab synchronously (popup blockers), fetch the live
 * sales order, build the Job Order and show it with the print dialog.
 */
export async function openJobOrder(soId: string): Promise<{ ok: boolean; error?: string }> {
  ensureLogoLoaded();
  const w = window.open('about:blank', '_blank');
  try {
    const res = await fetch(`/api/netsuite/job-order/${encodeURIComponent(soId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.soNumber) throw new Error(data?.error || `Could not load the sales order (${res.status})`);
    const doc = buildJobOrderPdf(data as JobOrderData);
    doc.autoPrint();
    const url = String(doc.output('bloburl'));
    if (w) w.location.href = url;
    else if (!window.open(url, '_blank')) doc.save(jobOrderFilename(data));
    return { ok: true };
  } catch (e: any) {
    w?.close();
    return { ok: false, error: e?.message || 'Could not open the Job Order' };
  }
}
