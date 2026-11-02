/**
 * A count's sheet (Books part 69, src/lib/stock-counts.ts): its items in the
 * count's order, each with an empty Counted box to write what's on the shelf,
 * for someone to walk the location with and type in after. No NetSuite counts
 * on it, so the count is what's there, not what NetSuite expects, and no
 * pricing.
 *
 * Same letter-size layout family as stock-check-pdf.ts: logo + title,
 * reference block, then the lines, and Counted by / Date and Checked by
 * sign-off lines.
 *
 * buildCountSheetPdf is pure (testable in node); openCountSheetPdf is the
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

export interface CountSheetLine {
  position: number;
  itemNumber: string;
  displayName: string | null;
}

export interface CountSheetData {
  /** CNT-0001. */
  label: string;
  locationName: string;
  what: string;
  /** 'YYYY-MM-DD'. */
  countDate: string;
  lines: CountSheetLine[];
  /** How many items on the count the sheet leaves out (counted already), when it's only what's left. */
  leftOut?: number;
}

export function countSheetFilename(data: Pick<CountSheetData, 'label'>): string {
  const n = String(data.label || 'count').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `count-sheet-${n || 'count'}.pdf`;
}

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Table rows in the count's order: its place, the item with its name under, and an empty Counted box. */
export function countSheetRows(lines: CountSheetLine[]): string[][] {
  return lines.map(l => [
    String(l.position),
    l.itemNumber + (l.displayName && l.displayName !== l.itemNumber ? `\n${l.displayName}` : ''),
    '',
  ]);
}

export function buildCountSheetPdf(data: CountSheetData, opts?: { logo?: string | null; printedAt?: Date }): jsPDF {
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
  doc.text('STOCK COUNT', pageW - margin, y, { align: 'right' });
  y = logoBottom ? logoBottom + 18 : y + 22;

  // ─── Reference block (right) ───────────────────────────────
  const refs: [string, string][] = [
    ['Count', data.label || '—'],
    ['Location', data.locationName || '—'],
    ['Count day', data.countDate ? day(data.countDate) : '—'],
    ['Printed', printedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })],
  ];
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

  // ─── What's on it (left) ───────────────────────────────────
  const leftW = labelX - margin - 20;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text('COUNTING', margin, y);
  doc.setTextColor(0);
  y += 14;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  const what = doc.splitTextToSize(data.what || '—', leftW);
  doc.text(what, margin, y);
  y += what.length * 14 + 4;
  doc.setFontSize(9);
  const how = doc.splitTextToSize(
    "Write what's on the shelf in each box: 0 when there's none. Leave a box blank when it wasn't counted."
      + (data.leftOut ? ` ${data.leftOut} item${data.leftOut === 1 ? '' : 's'} counted already ${data.leftOut === 1 ? "isn't" : "aren't"} on this sheet.` : ''),
    leftW,
  );
  doc.text(how, margin, y);
  y += how.length * 12;

  y = Math.max(y, refY) + 8;

  // ─── Lines (no NetSuite counts, no pricing) ────────────────
  const COUNTED = 2;
  autoTable(doc, {
    startY: y,
    head: [['#', 'Item', 'Counted']],
    body: data.lines.length > 0 ? countSheetRows(data.lines) : [['', 'Nothing left to count on this sheet', '']],
    styles: { fontSize: 10, cellPadding: 6, valign: 'middle' },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 9 },
    margin: { left: margin, right: margin, bottom: 50 },
    columnStyles: {
      0: { cellWidth: 34, halign: 'right', textColor: 110 },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 90 },
    },
    didParseCell: (hook) => {
      if (hook.section === 'head' && hook.column.index === 0) hook.cell.styles.halign = 'right';
    },
    didDrawCell: (hook) => {
      if (hook.section !== 'body' || data.lines.length === 0 || hook.column.index !== COUNTED) return;
      // A write-in box for what's on the shelf.
      const c = hook.cell;
      const h = Math.min(20, c.height - 8);
      doc.setDrawColor(90);
      doc.rect(c.x + 6, c.y + (c.height - h) / 2, c.width - 12, h);
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
  doc.text('Checked by / Date', margin + colW + 30, signY + 12);
  doc.setTextColor(0);

  // ─── Footer on every page ──────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`BMG Fleet · Count ${data.label} · ${data.locationName} · type the counts into FleetSuite on the count's page`, margin, pageH - 20);
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
export function openCountSheetPdf(data: CountSheetData): { ok: boolean; error?: string } {
  ensureLogoLoaded();
  const w = window.open('about:blank', '_blank');
  try {
    const doc = buildCountSheetPdf(data);
    openPdfBytes(w, doc.output('arraybuffer'), countSheetFilename(data));
    return { ok: true };
  } catch (e: any) {
    w?.close();
    return { ok: false, error: e?.message || 'Could not make the count sheet' };
  }
}
