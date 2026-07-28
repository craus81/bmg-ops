'use client';

/**
 * Customer statement as a real PDF (jsPDF + autotable, letter format),
 * modeled on packing-list-pdf.ts. One renderer serves three outputs:
 *   open   → window.open(blob URL) so the user can view/save the PDF
 *   print  → same blob with autoPrint() so the print dialog opens
 * Both fall back to doc.save() (download) when a popup blocker eats the
 * window — the established pattern for jsPDF docs in this app.
 *
 * Scope semantics mirror /api/netsuite/customer-statement: 'open' is the
 * classic open-item remittance statement; 'all' is an activity statement
 * where paid invoices appear at $0 balance. The header always says which
 * one it is (and the date range), so the reader never has to guess.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { StatementInvoice, StatementScope, AgingBucketKey } from '@/lib/financials-data';
import { companyLines, type CompanyLetterhead } from '@/lib/company-profile';

export interface StatementPdfData {
  customer: string;
  invoices: StatementInvoice[];
  scope: StatementScope;
  from?: string | null; // ISO
  to?: string | null; // ISO
  /** Company letterhead — same source as the wrap quote's header. */
  letterhead?: CompanyLetterhead | null;
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtD = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
};

const AGING: [AgingBucketKey, string][] = [
  ['current', 'Current'], ['d1_30', '1–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90plus', '90+ days'],
];

export function exportStatementPDF(data: StatementPdfData, opts: { print?: boolean } = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  const isAll = data.scope === 'all';
  const total = data.invoices.reduce((s, i) => s + i.unpaid, 0);
  const pastDue = data.invoices.reduce((s, i) => s + (i.daysPastDue > 0 ? i.unpaid : 0), 0);

  // ── Header — mirrors the wrap quote's letterhead (logo, title, then a
  //    company block on the left and the customer on the right) ───────────
  const lh = data.letterhead || null;
  let y = 48;

  if (lh?.logoDataUrl) {
    try {
      const props = doc.getImageProperties(lh.logoDataUrl);
      // jsPDF wants the format explicitly; take it from the data URL's mime.
      const fmt = /^data:image\/jpe?g/i.test(lh.logoDataUrl) ? 'JPEG' : 'PNG';
      const h = 34;
      const w = Math.min(160, (props.width / props.height) * h);
      // 'FAST' (deflate) matters: an uncompressed logo makes a 1.5MB
      // statement out of a 38KB PNG; compressed it's ~47KB.
      doc.addImage(lh.logoDataUrl, fmt, margin, y - 12, w, h, undefined, 'FAST');
      y += h - 2;
    } catch { /* unreadable logo — fall through to the text letterhead */ }
  }

  doc.setFontSize(20).setFont('helvetica', 'bold').setTextColor(17, 24, 39).text('Statement', margin, y + 12);
  doc.setFontSize(10).setFont('helvetica', 'normal').setTextColor(107, 114, 128);
  const rangeLine = data.from || data.to
    ? `Invoices ${data.from ? `from ${fmtD(data.from)} ` : ''}${data.to ? `through ${fmtD(data.to)}` : ''}`.trim()
    : null;
  doc.text(
    [`As of ${new Date().toLocaleDateString('en-US')} · ${isAll ? 'All invoices (activity statement)' : 'Open items only'}`, ...(rangeLine ? [rangeLine] : [])].join('\n'),
    margin, y + 26,
  );
  y += rangeLine ? 44 : 34;

  // Company (left) / Customer (right), same pairing as the quote header.
  const nameFont = () => doc.setFontSize(11).setFont('helvetica', 'bold').setTextColor(17, 24, 39);
  const lineFont = () => doc.setFontSize(9.5).setFont('helvetica', 'normal').setTextColor(55, 65, 81);
  const coLines = companyLines(lh?.company);
  let leftY = y + 14;
  nameFont().text(lh?.company?.name || 'BMG Fleet', margin, leftY);
  lineFont();
  for (const line of coLines) {
    leftY += 12;
    doc.text(line, margin, leftY);
  }

  let rightY = y + 14;
  nameFont().text('Customer', pageW - margin, rightY, { align: 'right' });
  lineFont();
  rightY += 12;
  doc.text(data.customer, pageW - margin, rightY, { align: 'right' });
  rightY += 12;
  doc.text(
    `${data.invoices.length} invoice${data.invoices.length === 1 ? '' : 's'} · Balance due ${usd(total)}${pastDue > 0.005 ? ` · Past due ${usd(pastDue)}` : ''}`,
    pageW - margin, rightY, { align: 'right' },
  );
  doc.setTextColor(0);

  const tableY = Math.max(leftY, rightY) + 20;

  // ── Invoice table ───────────────────────────────────────────────────────
  const rows = [...data.invoices]
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.tranid.localeCompare(b.tranid))
    .map(i => [
      fmtD(i.date),
      i.tranid,
      i.po || '—',
      fmtD(i.dueDate),
      i.status === 'paid' ? 'Paid' : i.daysPastDue > 0 ? `${i.daysPastDue}d past due` : 'Open',
      usd(i.total),
      usd(i.unpaid),
    ]);
  autoTable(doc, {
    startY: tableY,
    margin: { left: margin, right: margin },
    head: [['Date', 'Invoice #', 'PO #', 'Due', 'Status', 'Total', 'Balance']],
    body: rows,
    foot: [['', '', '', '', 'Total balance due', '', usd(total)]],
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: [37, 99, 235], fontSize: 8.5 },
    footStyles: { fillColor: [244, 244, 244], textColor: 20, fontStyle: 'bold' },
    columnStyles: { 5: { halign: 'right' }, 6: { halign: 'right' } },
    didParseCell: (hook) => {
      if (hook.section === 'body' && hook.column.index === 4 && String(hook.cell.raw).includes('past due')) {
        hook.cell.styles.textColor = [185, 28, 28];
        hook.cell.styles.fontStyle = 'bold';
      }
    },
  });

  // ── Aging summary (only when something is open) ─────────────────────────
  const buckets: Record<AgingBucketKey, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  for (const i of data.invoices) if (i.status === 'open') buckets[i.bucket] += i.unpaid;
  if (total > 0.005) {
    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 16,
      margin: { left: margin, right: margin },
      head: [AGING.map(([, label]) => label)],
      body: [AGING.map(([k]) => usd(buckets[k]))],
      styles: { fontSize: 9, cellPadding: 5, halign: 'right' },
      headStyles: { fillColor: [244, 244, 244], textColor: 60, fontSize: 8.5, halign: 'right' },
    });
  }

  const noteY = (doc as any).lastAutoTable.finalY + 20;
  doc.setFontSize(8.5).setTextColor(100).text(
    `Amounts are open balances as of the statement date. Please contact ${lh?.company?.name || 'BMG Fleet'} with any questions about this statement.`,
    margin, noteY, { maxWidth: pageW - margin * 2 },
  );

  // ── Output ──────────────────────────────────────────────────────────────
  const fileName = `Statement_${data.customer.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'Customer'}_${new Date().toISOString().slice(0, 10)}.pdf`;
  if (opts.print) doc.autoPrint();
  const w = window.open(doc.output('bloburl').toString(), '_blank');
  if (!w) doc.save(fileName);
}
