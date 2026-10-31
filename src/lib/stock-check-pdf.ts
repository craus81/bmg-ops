/**
 * Parts stock check sheet — the estimate's Request parts list printed so
 * someone can walk the warehouse and count each part against what
 * FleetSuite says is on hand (Craig, 2026-10-26: print from the Request
 * parts window, every part, one estimate per sheet, no bin column).
 *
 * Same letter-size layout family as job-order-pdf.ts: logo + title,
 * reference block, then part · needed · on hand · on order · requesting
 * lines with an empty Counted box and an OK tick box per line, and
 * Counted by / Date sign-off lines. No pricing.
 *
 * buildStockCheckPdf is pure (testable in node); openStockCheckPdf is the
 * click handler that opens the print viewer.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { openPdfBytes } from './native-files';

// Preloaded at module load: an await before window.open() would invite the
// popup blocker (same reasoning as job-order-pdf.ts). Until it arrives the
// header falls back to the "BMG Fleet" text wordmark.
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

export interface StockCheckLine {
  itemNumber: string;
  description: string | null;
  needed: number;
  /** NetSuite on hand (the shelf); undefined when unknown (not in the catalog). */
  onHand?: number;
  /** NetSuite available: on hand less what other orders have committed. */
  available?: number;
  onOrder: number;
  /** Ticked quantity in the Request parts window; 0 = not being requested. */
  requesting: number;
  short: boolean;
  uncatalogued: boolean;
}

export interface StockCheckData {
  estimateNumber: string;
  customer: string | null;
  vehicle: string | null;
  vin: string | null;
  soNumber: string | null;
  accepted: boolean;
  lines: StockCheckLine[];
}

const fmtQty = (q: number) => (Number.isInteger(q) ? String(q) : String(Number(q.toFixed(2))));

export function stockCheckFilename(data: Pick<StockCheckData, 'estimateNumber'>): string {
  const n = String(data.estimateNumber || 'estimate').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `stock-check-${n || 'estimate'}.pdf`;
}

/** Table rows, short parts first in the order the window shows them. */
export function stockCheckRows(lines: StockCheckLine[]): string[][] {
  return lines.map(l => [
    l.itemNumber + (l.uncatalogued ? '  (not in catalog)' : l.short ? '  SHORT' : '') + (l.description ? `\n${l.description}` : ''),
    fmtQty(l.needed),
    l.uncatalogued || l.onHand === undefined ? '—' : fmtQty(l.onHand),
    l.uncatalogued || l.available === undefined ? '—' : fmtQty(l.available),
    l.onOrder > 0 ? fmtQty(l.onOrder) : '0',
    l.requesting > 0 ? fmtQty(l.requesting) : '—',
    '',
    '',
  ]);
}

export function buildStockCheckPdf(data: StockCheckData, opts?: { logo?: string | null; printedAt?: Date }): jsPDF {
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
  doc.text('PARTS STOCK CHECK', pageW - margin, y, { align: 'right' });
  y = logoBottom ? logoBottom + 18 : y + 22;

  // ─── Reference block (right) ───────────────────────────────
  const refs: [string, string][] = [['Estimate', data.estimateNumber || '—']];
  if (data.soNumber) refs.push(['Sales Order', data.soNumber]);
  refs.push(['Status', data.accepted ? 'Accepted' : 'Not accepted yet']);
  refs.push(['Printed', printedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })]);

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

  // ─── Customer / vehicle (left) ─────────────────────────────
  const leftW = labelX - margin - 20;
  const block = (label: string, value: string, size: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(label, margin, y);
    doc.setTextColor(0);
    y += size + 3;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(value, leftW);
    doc.text(lines, margin, y);
    y += lines.length * (size + 3) + 6;
  };
  block('CUSTOMER', data.customer || '—', 11);
  if (data.vehicle) block('VEHICLE', data.vehicle, 10);
  if (data.vin) block('VIN', data.vin, 10);

  y = Math.max(y, refY) + 6;

  // ─── Lines (no pricing) ────────────────────────────────────
  const COUNTED = 6;
  const OK = 7;
  autoTable(doc, {
    startY: y,
    head: [['Part', 'Needed', 'On hand', 'Available', 'On order', 'Requesting', 'Counted', 'OK']],
    body: data.lines.length > 0 ? stockCheckRows(data.lines) : [['No parts on this estimate', '', '', '', '', '', '', '']],
    styles: { fontSize: 10, cellPadding: 6, valign: 'middle' },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 9 },
    margin: { left: margin, right: margin, bottom: 50 },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 46, halign: 'right' },
      2: { cellWidth: 48, halign: 'right' },
      3: { cellWidth: 56, halign: 'right' },
      4: { cellWidth: 52, halign: 'right' },
      5: { cellWidth: 62, halign: 'right' },
      6: { cellWidth: 58 },
      7: { cellWidth: 30, halign: 'center' },
    },
    didParseCell: (hook) => {
      // Number headings sit over their right-aligned numbers.
      if (hook.section === 'head' && hook.column.index >= 1 && hook.column.index <= 5) hook.cell.styles.halign = 'right';
      if (hook.section !== 'body' || hook.column.index !== 0 || data.lines.length === 0) return;
      const line = data.lines[hook.row.index];
      if (line?.short) hook.cell.styles.textColor = [196, 39, 29];
    },
    didDrawCell: (hook) => {
      if (hook.section !== 'body' || data.lines.length === 0) return;
      const c = hook.cell;
      doc.setDrawColor(90);
      if (hook.column.index === COUNTED) {
        // A write-in box for the counted quantity.
        const h = Math.min(18, c.height - 8);
        doc.rect(c.x + 6, c.y + (c.height - h) / 2, c.width - 12, h);
      } else if (hook.column.index === OK) {
        const s = 11;
        doc.rect(c.x + (c.width - s) / 2, c.y + (c.height - s) / 2, s, s);
      }
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
  doc.text('Counted by / Date', margin, signY + 12);
  doc.text('Notes', margin + colW + 30, signY + 12);
  doc.setTextColor(0);

  // ─── Footer on every page ──────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`BMG Fleet · Stock check ${data.estimateNumber} · on hand is NetSuite available at ${printedAt.toLocaleString('en-US')}`, margin, pageH - 20);
    if (pages > 1) doc.text(`Page ${p} of ${pages}`, pageW - margin, pageH - 20, { align: 'right' });
    doc.setTextColor(0);
  }

  return doc;
}

/**
 * Click handler: open a tab synchronously (popup blockers), build the sheet
 * and show it in the shared PDF viewer (Print + Save PDF on desktop, the
 * phone's own viewer on iPhone and in the app).
 */
export function openStockCheckPdf(data: StockCheckData): { ok: boolean; error?: string } {
  ensureLogoLoaded();
  const w = window.open('about:blank', '_blank');
  try {
    const doc = buildStockCheckPdf(data);
    openPdfBytes(w, doc.output('arraybuffer'), stockCheckFilename(data));
    return { ok: true };
  } catch (e: any) {
    w?.close();
    return { ok: false, error: e?.message || 'Could not make the stock check sheet' };
  }
}
