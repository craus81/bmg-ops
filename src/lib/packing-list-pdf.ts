'use client';

/**
 * Packing list PDF for graphics jobs. Deliberately minimal (field ask,
 * 2026-08-21): a printable single-page slip with ship-to / customer info,
 * order references (job #, PO #, invoice #), the line items being shipped
 * (qty + part + description), shipping info, and packed-by / checked-by
 * sign-off lines. No job specs, no notes — the slip is a manifest, not a
 * job traveler. Triggered when an invoice is created from the graphics
 * job screen — see /graphics.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { GraphicsJob } from '@/lib/types';

// The BMG logo for the header, preloaded at module load rather than
// fetched when the user clicks Print — an await before window.open()
// would invite the popup blocker (same reasoning as company-profile.ts).
// Until it arrives (or if the fetch fails) the header falls back to the
// "BMG Fleet" text wordmark.
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

export interface PackingListLine {
  partNumber: string;
  description: string;
  quantity: number;
}

export interface PackingListData {
  jobNumber?: string | null;
  title?: string | null;
  customer?: string | null;
  shipTo?: string | null;
  poNumber?: string | null;
  invoiceNumber?: string | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  dueDate?: string | null;
  lines: PackingListLine[];
}

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * Build packing-list data from a graphics job. Line items are derived
 * from the comma-separated part numbers on the job, each shipped at the
 * job quantity — this mirrors how /api/graphics/create-invoice builds
 * its lines.
 */
export function packingListFromJob(
  job: GraphicsJob,
  opts?: { lines?: PackingListLine[] }
): PackingListData {
  const parts = (job.part_number || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  const lines: PackingListLine[] =
    opts?.lines && opts.lines.length > 0
      ? opts.lines
      : parts.length > 0
        ? parts.map(pn => ({
            partNumber: pn,
            description: job.title || '',
            quantity: job.quantity || 1,
          }))
        : [{ partNumber: '', description: job.title || '', quantity: job.quantity || 1 }];

  return {
    jobNumber: job.job_number,
    title: job.title,
    customer: job.customer,
    shipTo: job.ship_to,
    poNumber: job.po_number,
    invoiceNumber: job.netsuite_invoice_number,
    trackingNumber: job.tracking_number,
    carrier: job.carrier,
    dueDate: job.due_date,
    lines,
  };
}

/**
 * Render and either print (opens a new window with the print dialog) or
 * download the packing list PDF.
 */
export function exportPackingListPDF(data: PackingListData, opts?: { print?: boolean }) {
  ensureLogoLoaded(); // retry for the next click if the load-time fetch failed
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ─── Header ────────────────────────────────────────────────
  let logoBottom = 0;
  if (logoDataUrl) {
    try {
      const props = doc.getImageProperties(logoDataUrl);
      const h = 40;
      const w = Math.min(160, (props.width / props.height) * h);
      // 'FAST' (deflate) keeps the embedded PNG from bloating the file.
      doc.addImage(logoDataUrl, 'PNG', margin, y - 12, w, h, undefined, 'FAST');
      logoBottom = y - 12 + h;
    } catch { /* unreadable image — use the text wordmark */ }
  }
  if (!logoBottom) {
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.text('BMG Fleet', margin, y);
  }

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(110);
  doc.text('PACKING LIST', pageW - margin, y, { align: 'right' });
  doc.setTextColor(0);
  y = logoBottom ? logoBottom + 14 : y + 18;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(110);
  doc.text('Graphics Production', margin, y);
  doc.setTextColor(0);
  y += 18;

  // ─── Reference block (right-aligned) ───────────────────────
  const refs: [string, string][] = [];
  refs.push(['Date', fmtDate(new Date().toISOString())]);
  if (data.jobNumber) refs.push(['Job #', String(data.jobNumber)]);
  if (data.poNumber) refs.push(['PO #', String(data.poNumber)]);
  if (data.invoiceNumber) refs.push(['Invoice #', String(data.invoiceNumber)]);
  if (data.dueDate) refs.push(['Due', fmtDate(data.dueDate)]);

  let refY = margin + 40;
  doc.setFontSize(9);
  // Size the label column off the widest label + widest value so long values
  // (e.g. job numbers like GFX-MR99T5OU-DMQ) never draw over their label.
  doc.setFont('helvetica', 'normal');
  const maxValueW = Math.max(...refs.map(([, v]) => doc.getTextWidth(v)));
  doc.setFont('helvetica', 'bold');
  const maxLabelW = Math.max(...refs.map(([l]) => doc.getTextWidth(l)));
  const labelX = pageW - margin - Math.max(maxValueW + maxLabelW + 10, 90);
  for (const [label, value] of refs) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(110);
    doc.text(label, labelX, refY);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0);
    doc.text(value, pageW - margin, refY, { align: 'right' });
    refY += 13;
  }

  // ─── Ship To / Customer ────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text('SHIP TO', margin, y);
  doc.setTextColor(0);
  y += 14;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  if (data.customer) { doc.text(data.customer, margin, y); y += 14; }
  if (data.shipTo) {
    doc.setFontSize(10);
    const shipLines = doc.splitTextToSize(data.shipTo, (pageW - margin * 2) / 2);
    doc.text(shipLines, margin, y);
    y += shipLines.length * 13;
  }
  if (!data.customer && !data.shipTo) { doc.text('—', margin, y); y += 14; }

  if (data.title) {
    y += 4;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(data.title, margin, y);
    doc.setFont('helvetica', 'normal');
    y += 6;
  }

  y = Math.max(y, refY) + 12;

  // ─── Line items ────────────────────────────────────────────
  autoTable(doc, {
    startY: y,
    head: [['Qty', 'Part Number', 'Description']],
    body: data.lines.map(l => [
      String(l.quantity),
      l.partNumber || '—',
      l.description || '',
    ]),
    styles: { fontSize: 10, cellPadding: 6 },
    headStyles: { fillColor: [37, 99, 235], textColor: 255 },
    margin: { left: margin, right: margin },
    columnStyles: {
      0: { cellWidth: 50, halign: 'center' },
      1: { cellWidth: 150 },
      2: { cellWidth: 'auto' },
    },
  });
  y = (doc as any).lastAutoTable.finalY + 18;

  // ─── Shipping ──────────────────────────────────────────────
  if (data.trackingNumber || data.carrier) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text('SHIPPING', margin, y);
    doc.setTextColor(0);
    y += 13;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const shipBits = [data.carrier, data.trackingNumber].filter(Boolean).join('  ·  ');
    doc.text(shipBits, margin, y);
    y += 16;
  }

  // ─── Sign-off lines (anchored near the bottom) ─────────────
  const pageH = doc.internal.pageSize.getHeight();
  let signY = Math.max(y + 20, pageH - 90);
  if (signY > pageH - 60) signY = pageH - 60;
  const colW = (pageW - margin * 2 - 30) / 2;
  doc.setDrawColor(150);
  doc.line(margin, signY, margin + colW, signY);
  doc.line(margin + colW + 30, signY, pageW - margin, signY);
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text('Packed by / Date', margin, signY + 12);
  doc.text('Checked by / Date', margin + colW + 30, signY + 12);
  doc.setTextColor(0);

  // ─── Footer ────────────────────────────────────────────────
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text(
    `BMG Fleet · Packing list generated ${new Date().toLocaleString()}`,
    margin,
    pageH - 20,
  );
  doc.setTextColor(0);

  const safeName = (data.jobNumber ? `job-${data.jobNumber}` : (data.title || 'graphics-job'))
    .toString()
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase();
  const fileName = `packing-list-${safeName}.pdf`;

  if (opts?.print) {
    doc.autoPrint();
    const url = doc.output('bloburl');
    const win = window.open(url as any, '_blank');
    // Pop-up blocked → fall back to a download so the user still gets it.
    if (!win) doc.save(fileName);
  } else {
    doc.save(fileName);
  }
}
