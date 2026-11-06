/**
 * FleetSuite's own PDF of a purchase order, sales order or invoice: what
 * FleetSuite attaches when it emails one of them, instead of NetSuite's print
 * form (Craig, 2026-11-06: "I want people to get used to seeing these forms
 * from FleetSuite instead of NetSuite"). NetSuite's PDF stays reachable from
 * the 📄 PDF links for staff.
 *
 * One layout for all three, in the same family as FleetSuite's own invoice
 * (src/lib/books/own-invoice-pdf.ts) and the customer statement: logo, title
 * and number, the company on the left, the other party on the right, a Ship
 * to block, a row of details, the lines, the totals and the memo.
 *
 * Pure: no window or DOM, so the server can make the bytes. Letter, in points.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { CompanyProfile } from '@/lib/statement-pdf-doc';
import { cityLine, pageText } from '@/lib/books/own-invoice-pdf';

export type TransactionKind = 'purchase_order' | 'sales_order' | 'invoice';

export interface TransactionPdfLine {
  itemNumber: string | null;
  description: string | null;
  quantity: number | null;
  rate: number | null;
  /** What the line comes to, a discount negative. */
  cents: number;
  /** A description-only line: no amount shown. */
  textOnly?: boolean;
}

export interface TransactionPdfData {
  kind: TransactionKind;
  number: string;
  /** Who it's to: the vendor on a PO, the customer otherwise. Name first, then address lines. */
  party: string[];
  /** Where it ships. Name first, then address lines. Empty leaves the block out. */
  shipTo: string[];
  /** The details row, in order; a blank value shows a dash. */
  details: { label: string; value: string | null }[];
  lines: TransactionPdfLine[];
  /** Leave tax null on a PO: it shows only a Total. */
  subtotalCents: number;
  taxCents: number | null;
  taxLabel?: string;
  /** Freight / shipping, when the transaction has some. */
  shippingCents?: number | null;
  /** An order-level discount, negative. */
  discountCents?: number | null;
  totalCents: number;
  memo: string | null;
  /** NetSuite voided, closed or cancelled it. */
  stamp?: string | null;
  /** The logo must already be inlined: jsPDF can't fetch. */
  letterhead: { company: CompanyProfile | null; logoDataUrl: string | null } | null;
}

const MARGIN = 40;
const DASH = '-';
const blank = (s: string | null | undefined): s is null | undefined | '' => !s || !s.trim();
const usd = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const rateText = (rate: number) => rate.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const qtyText = (n: number) => String(Number(n.toFixed(4)));

export const TITLES: Record<TransactionKind, string> = {
  purchase_order: 'Purchase Order',
  sales_order: 'Sales Order',
  invoice: 'Invoice',
};

const PARTY_LABEL: Record<TransactionKind, string> = {
  purchase_order: 'Vendor',
  sales_order: 'Bill to',
  invoice: 'Bill to',
};

const FOOTER: Record<TransactionKind, (company: string) => string> = {
  purchase_order: (c) => `Please confirm this order and reply with the ship date and tracking number once it ships. Reference our PO number on the packing list and invoice. Questions: contact ${c}.`,
  sales_order: (c) => `Thank you for your order. Please contact ${c} with any questions about this sales order.`,
  invoice: (c) => `Thank you for your business. Please contact ${c} with any questions about this invoice.`,
};

/** The file name: PO1234.pdf, SO1235.pdf, Invoice_INV2699.pdf. */
export function transactionPdfFilename(kind: TransactionKind, number: string): string {
  const n = number.replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || TITLES[kind].replace(/ /g, '_');
  return kind === 'invoice' ? `Invoice_${n}.pdf` : `${n}.pdf`;
}

/** An address as NetSuite or FleetSuite keeps it, a line each, empties dropped. */
export function addressLines(a: {
  addressee?: string | null; attention?: string | null; addr1?: string | null; addr2?: string | null;
  city?: string | null; state?: string | null; zip?: string | null;
} | null | undefined): string[] {
  if (!a) return [];
  return [a.addressee, a.attention ? `Attn: ${a.attention}` : null, a.addr1, a.addr2, cityLine(a.city, a.state, a.zip)]
    .filter((l): l is string => !blank(l))
    .map((l) => l.trim());
}

function companyLines(c: CompanyProfile | null | undefined): string[] {
  if (!c) return [];
  return [c.address, cityLine(c.city, c.state, c.zip), c.phone, c.email].filter((l): l is string => !blank(l)).map((l) => l.trim());
}

/** BMG logo red (#EE4023): the table heading colour on every FleetSuite form, as on the estimate. */
export const BRAND_RED: [number, number, number] = [238, 64, 35];

/**
 * Any FleetSuite form in the shared layout: logo, title and number, the
 * company then up to two labelled blocks, a details row, an optional boxed
 * callout (End user on the job order), the lines table, the memo, a footer
 * line, and optional sign-off lines.
 */
export interface FormPdfData {
  title: string;
  number: string;
  stamp?: string | null;
  /** Up to two labelled blocks after the company: name first, then lines. */
  blocks: { label: string; lines: string[] }[];
  details: { label: string; value: string | null }[];
  callout?: { label: string; value: string } | null;
  table: {
    head: string[];
    rows: string[][];
    /** Columns shown right-aligned (numbers). */
    right?: number[];
    widths?: Record<number, number>;
    /** A column drawn as an empty tick box. */
    tickColumn?: number;
    foot?: { label: string; value: string; bold?: boolean }[];
  };
  memo?: string | null;
  footer?: string | null;
  signoffs?: string[];
  letterhead: { company: CompanyProfile | null; logoDataUrl: string | null } | null;
}

export function buildFormPdf(data: FormPdfData, into?: jsPDF): jsPDF {
  const doc = into ?? new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const right = pageW - MARGIN;
  const lh = data.letterhead ?? null;
  const companyName = pageText(lh?.company?.name || 'BMG Fleet Installations');
  let y = 48;

  if (lh?.logoDataUrl) {
    try {
      const props = doc.getImageProperties(lh.logoDataUrl);
      const fmt = /^data:image\/jpe?g/i.test(lh.logoDataUrl) ? 'JPEG' : 'PNG';
      const h = 34;
      const w = Math.min(160, (props.width / props.height) * h);
      doc.addImage(lh.logoDataUrl, fmt, MARGIN, y - 12, w, h, undefined, 'FAST');
      y += h + 10;
    } catch { /* text letterhead */ }
  }

  doc.setFontSize(20).setFont('helvetica', 'bold').setTextColor(17, 24, 39).text(pageText(data.title), MARGIN, y + 12);
  doc.setFontSize(14).text(pageText(data.number), right, y + 12, { align: 'right' });
  if (!blank(data.stamp)) {
    doc.setFontSize(10).setTextColor(185, 28, 28).text(pageText(data.stamp!), right, y + 26, { align: 'right' });
  }
  y += 34;

  const nameFont = () => doc.setFontSize(11).setFont('helvetica', 'bold').setTextColor(17, 24, 39);
  const labelFont = () => doc.setFontSize(8).setFont('helvetica', 'bold').setTextColor(107, 114, 128);
  const lineFont = () => doc.setFontSize(9.5).setFont('helvetica', 'normal').setTextColor(55, 65, 81);

  const colW = (pageW - MARGIN * 2) / 3;
  const block = (x: number, label: string | null, lines: string[]) => {
    let by = y + 14;
    if (label) { labelFont().text(label.toUpperCase(), x, by); by += 13; }
    lines.forEach((line, i) => {
      if (i === 0) nameFont(); else lineFont();
      const wrapped = doc.splitTextToSize(pageText(line), colW - 12) as string[];
      doc.text(wrapped, x, by);
      by += wrapped.length * 12;
    });
    return by;
  };
  let bottom = block(MARGIN, null, [companyName, ...companyLines(lh?.company)]);
  data.blocks.slice(0, 2).forEach((b, i) => {
    bottom = Math.max(bottom, block(MARGIN + colW * (i + 1), b.label, b.lines.length ? b.lines : [DASH]));
  });
  doc.setTextColor(0);

  autoTable(doc, {
    startY: bottom + 12,
    margin: { left: MARGIN, right: MARGIN },
    theme: 'plain',
    head: [data.details.map((d) => d.label)],
    body: [data.details.map((d) => (blank(d.value) ? DASH : pageText(d.value!)))],
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: [244, 244, 244], textColor: 60, fontSize: 8.5 },
  });
  let tableY = (doc as any).lastAutoTable.finalY + 14;

  if (data.callout && !blank(data.callout.value)) {
    const h = 38;
    doc.setDrawColor(...BRAND_RED).setLineWidth(1.2).rect(MARGIN, tableY, pageW - MARGIN * 2, h);
    labelFont().setTextColor(...BRAND_RED).text(data.callout.label.toUpperCase(), MARGIN + 8, tableY + 13);
    doc.setFontSize(13).setFont('helvetica', 'bold').setTextColor(17, 24, 39).text(pageText(data.callout.value), MARGIN + 8, tableY + 29);
    tableY += h + 14;
  }

  const t = data.table;
  const rightCols = new Set(t.right ?? []);
  const colStyles: Record<number, any> = {};
  for (const [k, w] of Object.entries(t.widths ?? {})) colStyles[Number(k)] = { cellWidth: w };
  for (const k of rightCols) colStyles[k] = { ...(colStyles[k] ?? {}), halign: 'right' };
  if (t.tickColumn !== undefined) colStyles[t.tickColumn] = { ...(colStyles[t.tickColumn] ?? {}), halign: 'center', cellWidth: 50 };
  const span = t.head.length - 1;
  autoTable(doc, {
    startY: tableY,
    margin: { left: MARGIN, right: MARGIN },
    head: [t.head.map((content, i) => ({
      content,
      styles: { halign: rightCols.has(i) ? 'right' as const : i === t.tickColumn ? 'center' as const : 'left' as const },
    }))],
    body: t.rows.map((r) => r.map((c) => pageText(c))),
    foot: t.foot?.length ? t.foot.map((f) => [
      { content: f.label, colSpan: span, styles: { halign: 'right' as const, fontStyle: f.bold ? 'bold' as const : 'normal' as const } },
      { content: f.value, styles: { halign: 'right' as const, fontStyle: f.bold ? 'bold' as const : 'normal' as const } },
    ]) : undefined,
    showFoot: 'lastPage',
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: BRAND_RED, textColor: 255, fontSize: 8.5 },
    footStyles: { fillColor: [255, 255, 255], textColor: 20 },
    columnStyles: colStyles,
    didDrawCell: (hook) => {
      if (hook.section !== 'body' || hook.column.index !== t.tickColumn) return;
      const s = 9;
      doc.setDrawColor(90).setLineWidth(0.8).rect(hook.cell.x + (hook.cell.width - s) / 2, hook.cell.y + (hook.cell.height - s) / 2, s, s);
    },
  });

  let noteY = (doc as any).lastAutoTable.finalY + 20;
  doc.setFontSize(9).setFont('helvetica', 'normal').setTextColor(55, 65, 81);
  if (!blank(data.memo)) {
    const memo = doc.splitTextToSize(`Memo: ${pageText(data.memo!)}`, pageW - MARGIN * 2) as string[];
    doc.text(memo, MARGIN, noteY);
    noteY += memo.length * 11 + 8;
  }
  if (!blank(data.footer)) {
    doc.setFontSize(8.5).setTextColor(100).text(pageText(data.footer!), MARGIN, noteY, { maxWidth: pageW - MARGIN * 2 });
  }

  if (data.signoffs?.length) {
    const lineY = pageH - 70;
    const w = (pageW - MARGIN * 2 - 30 * (data.signoffs.length - 1)) / data.signoffs.length;
    data.signoffs.forEach((label, i) => {
      const x = MARGIN + i * (w + 30);
      doc.setDrawColor(150).setLineWidth(0.6).line(x, lineY, x + w, lineY);
      doc.setFontSize(8).setTextColor(100).text(label, x, lineY + 12);
    });
  }
  doc.setTextColor(0);
  return doc;
}

/** The transaction on a letter page, more pages when its lines need them. */
export function buildTransactionPdf(data: TransactionPdfData): jsPDF {
  const companyName = pageText(data.letterhead?.company?.name || 'BMG Fleet Installations');
  const foot: { label: string; value: string; bold?: boolean }[] = [];
  const hasExtras = data.taxCents !== null || !!data.shippingCents || !!data.discountCents;
  if (hasExtras) foot.push({ label: 'Subtotal', value: usd(data.subtotalCents) });
  if (data.discountCents) foot.push({ label: 'Discount', value: usd(data.discountCents) });
  if (data.shippingCents) foot.push({ label: 'Shipping', value: usd(data.shippingCents) });
  if (data.taxCents !== null) foot.push({ label: data.taxLabel || 'Sales tax', value: usd(data.taxCents) });
  foot.push({ label: 'Total', value: usd(data.totalCents), bold: true });
  return buildFormPdf({
    title: TITLES[data.kind],
    number: data.number,
    stamp: data.stamp,
    blocks: [
      { label: PARTY_LABEL[data.kind], lines: data.party },
      ...(data.shipTo.length ? [{ label: 'Ship to', lines: data.shipTo }] : []),
    ],
    details: data.details,
    table: {
      head: ['Item', 'Description', 'Qty', 'Rate', 'Amount'],
      rows: data.lines.map((l) => [
        l.itemNumber ?? '',
        l.description ?? '',
        l.quantity === null ? '' : qtyText(l.quantity),
        l.rate === null ? '' : rateText(l.rate),
        l.textOnly ? '' : usd(l.cents),
      ]),
      right: [2, 3, 4],
      widths: { 0: 90, 2: 48, 3: 70, 4: 80 },
      foot,
    },
    memo: data.memo,
    footer: FOOTER[data.kind](companyName),
    letterhead: data.letterhead,
  });
}
