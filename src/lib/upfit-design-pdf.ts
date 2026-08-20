'use client';

/**
 * Upfit design layout PDF — the downloadable deliverable of the 3D upfit
 * designer: company letterhead, the vehicle, a capture of the 3D layout,
 * the itemized parts list with pricing, and totals. Modeled on
 * packing-list-pdf.ts; output follows statement-pdf.ts (blob URL in a new
 * tab, plain download when the popup blocker objects).
 *
 * Import this module with `await import(...)` at click time (the
 * xlsx-export pattern) so jsPDF stays out of the route's initial chunk.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { AggregatedLine } from '@/lib/upfit-layout';
import { CompanyLetterhead, companyLines } from '@/lib/company-profile';

export interface UpfitDesignPdfData {
  designName: string;
  vehicle: string; // "Ford Transit · 148" WB · high roof"
  customerName?: string | null;
  /** PNG capture of the 3D scene, with its pixel size (jsPDF can't measure
   *  a data URL itself — pass what the canvas reported). */
  snapshot?: { dataUrl: string; width: number; height: number } | null;
  lines: AggregatedLine[];
  totals: {
    subtotal: number;
    labor_hours: number;
    labor_total: number;
    tax_amount: number;
    grand_total: number;
  };
  taxExempt: boolean;
  laborRate: number;
  letterhead: CompanyLetterhead | null;
}

const money = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function exportUpfitDesignPDF(data: UpfitDesignPdfData, opts?: { print?: boolean }) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  let y = margin;

  // ─── Letterhead ───
  const company = data.letterhead?.company || null;
  if (data.letterhead?.logoDataUrl) {
    try {
      doc.addImage(data.letterhead.logoDataUrl, 'PNG', margin, y - 8, 110, 36, undefined, 'FAST');
    } catch { /* a bad logo never blocks the document */ }
    y += 34;
  } else {
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.text(company?.name || 'BMG Fleet', margin, y);
    y += 8;
  }
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(110);
  doc.text('UPFIT DESIGN', pageW - margin, margin, { align: 'right' });
  doc.setTextColor(0);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(110);
  for (const line of companyLines(company)) {
    doc.text(line, margin, y + 8);
    y += 11;
  }
  doc.setTextColor(0);
  y += 14;

  // ─── Design header ───
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text(data.designName, margin, y);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(110);
  doc.text(new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), pageW - margin, y, { align: 'right' });
  doc.setTextColor(0);
  y += 15;
  doc.setFontSize(10);
  doc.text(data.vehicle, margin, y);
  if (data.customerName) {
    doc.text(`Customer: ${data.customerName}`, pageW - margin, y, { align: 'right' });
  }
  y += 14;

  // ─── 3D layout capture ───
  if (data.snapshot) {
    const maxW = pageW - margin * 2;
    const maxH = 250;
    const scale = Math.min(maxW / data.snapshot.width, maxH / data.snapshot.height);
    const w = data.snapshot.width * scale;
    const h = data.snapshot.height * scale;
    try {
      doc.setDrawColor(210);
      doc.roundedRect(margin + (maxW - w) / 2 - 4, y - 4, w + 8, h + 8, 4, 4);
      doc.addImage(data.snapshot.dataUrl, 'PNG', margin + (maxW - w) / 2, y, w, h, undefined, 'FAST');
      y += h + 16;
    } catch { /* capture failures degrade to a text-only document */ }
  }

  // ─── Parts table ───
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Qty', 'Part #', 'Description', 'Unit Price', 'Line Total']],
    body: data.lines.map(l => [
      String(l.quantity),
      l.item_number + (l.placed ? '' : ' *'),
      l.description,
      money(l.unit_price),
      money(l.quantity * l.unit_price),
    ]),
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 32, halign: 'right' },
      1: { cellWidth: 90 },
      3: { cellWidth: 70, halign: 'right' },
      4: { cellWidth: 75, halign: 'right' },
    },
  });
  y = (doc as any).lastAutoTable.finalY + 12;

  // ─── Totals ───
  const totalRows: [string, string][] = [
    ['Parts subtotal', money(data.totals.subtotal)],
    [`Labor (${data.totals.labor_hours} h @ ${money(data.laborRate)}/h)`, money(data.totals.labor_total)],
    [data.taxExempt ? 'Tax (exempt)' : 'Tax', money(data.totals.tax_amount)],
    ['Estimated total', money(data.totals.grand_total)],
  ];
  const labelX = pageW - margin - 200;
  doc.setFontSize(10);
  for (let i = 0; i < totalRows.length; i++) {
    const last = i === totalRows.length - 1;
    if (y > pageH - margin - 40) {
      doc.addPage();
      y = margin;
    }
    doc.setFont('helvetica', last ? 'bold' : 'normal');
    doc.setFontSize(last ? 12 : 10);
    doc.text(totalRows[i][0], labelX, y);
    doc.text(totalRows[i][1], pageW - margin, y, { align: 'right' });
    y += last ? 18 : 14;
  }

  // ─── Footnotes ───
  const notes: string[] = [];
  if (data.lines.some(l => !l.placed)) {
    notes.push('* Included in pricing but not shown in the 3D layout (no catalog dimensions on file).');
  }
  notes.push('Preliminary layout for planning purposes — pricing subject to a formal estimate.');
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120);
  for (const note of notes) {
    if (y > pageH - margin) { doc.addPage(); y = margin; }
    doc.text(note, margin, y);
    y += 11;
  }
  doc.setTextColor(0);

  // ─── Output (statement-pdf pattern) ───
  const fileName = `Upfit_Design_${data.designName.replace(/[^A-Za-z0-9-]+/g, '_').slice(0, 60)}_${new Date().toISOString().slice(0, 10)}.pdf`;
  if (opts?.print) doc.autoPrint();
  const w = window.open(doc.output('bloburl').toString(), '_blank');
  if (!w) doc.save(fileName); // popup blocked → plain download
}
