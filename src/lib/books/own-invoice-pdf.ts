/**
 * FleetSuite's own PDF of one of its own invoices (Books part 68, docs/books.md
 * "Invoice PDFs"), drawn from FleetSuite's copy of the invoice (migration 407,
 * src/lib/books/own-invoices.ts): the letterhead, who it's billed to, its
 * number, date, due date, terms, PO and VIN, each line, and its subtotal,
 * sales tax and total. One builder serves every output: the PDF Books opens
 * and the one FleetSuite attaches to NetSuite's invoice once Invoice PDFs is
 * switched on (src/lib/books/invoice-pdfs.ts), so they can't differ.
 *
 * Pure: no window or DOM, so the server can make the bytes. Letter, in
 * points, laid out like the customer statement (src/lib/statement-pdf-doc.ts).
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { foldToWinAnsi } from '@/lib/quote-doc-pdf';
import type { CompanyProfile } from '@/lib/statement-pdf-doc';
import type { OwnInvoiceData } from './own-invoice-check';
import type { TaxBasis } from './own-invoices';

export interface InvoicePdfLine {
  itemNumber: string | null;
  description: string | null;
  quantity: number | null;
  rate: number | null;
  /** What the line charges, a discount negative. */
  cents: number;
  /** False when FleetSuite didn't know its price: NetSuite priced it. */
  priced: boolean;
}

export interface InvoicePdfData {
  number: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  dueDate: string | null;
  terms: string | null;
  poNumber: string | null;
  vin: string | null;
  memo: string | null;
  customer: string | null;
  /** The billing address, a line each. */
  billTo: string[];
  lines: InvoicePdfLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxBasis: TaxBasis;
  /** A fraction: 0.08238 for 8.238%. */
  taxRate: number;
  /** NetSuite voided or deleted the invoice. */
  voided: boolean;
  /** The logo must already be inlined: jsPDF can't fetch. */
  letterhead: { company: CompanyProfile | null; logoDataUrl: string | null } | null;
}

/** A billing address as FleetSuite's customer record keeps it. */
export interface BillToAddress {
  addr1?: string | null;
  addr2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

const MARGIN = 40;
/** What a detail the invoice doesn't have shows. An em dash isn't drawn right in helvetica (see foldToWinAnsi). */
const DASH = '-';

const usd = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const rateText = (rate: number) => rate.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const qtyText = (n: number) => String(Number(n.toFixed(4)));
const toCents = (v: string | null | undefined) => Math.round(Number(v ?? 0) * 100);
const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const blank = (s: string | null | undefined): s is null | undefined | '' => !s || !s.trim();

/** 'November 18, 2026' from '2026-11-18'. */
export function longDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Text as helvetica (WinAnsi) can draw it: the typographic characters folded as on quotes, anything else outside
 * Latin-1 shown as '?', and runs of spaces and line breaks made one space.
 */
export function pageText(text: string): string {
  return foldToWinAnsi(text).replace(/[^\x20-\x7E\xA0-\xFF\s]/g, '?').replace(/\s+/g, ' ').trim();
}

/** 'Springfield, MO 65802', leaving out what isn't known. */
export function cityLine(city: string | null | undefined, state: string | null | undefined, zip: string | null | undefined): string {
  const stateZip = [state, zip].filter((s) => !blank(s)).map((s) => s!.trim()).join(' ');
  return [blank(city) ? '' : city!.trim(), stateZip].filter(Boolean).join(', ');
}

/** A billing address a line each, empties left out. */
export function billToLines(address: BillToAddress | null | undefined): string[] {
  if (!address) return [];
  return [address.addr1, address.addr2, cityLine(address.city, address.state, address.zip)]
    .filter((l): l is string => !blank(l))
    .map((l) => l.trim());
}

/** The letterhead's lines under the company's name. */
function companyLines(c: CompanyProfile | null | undefined): string[] {
  if (!c) return [];
  return [c.address, cityLine(c.city, c.state, c.zip), c.phone, c.email].filter((l): l is string => !blank(l)).map((l) => l.trim());
}

/** What the sales tax line says. */
export function taxLabel(basis: TaxBasis, rate: number): string {
  if (basis === 'exempt_customer') return 'Sales tax (exempt)';
  if (basis === 'georgia' || !(rate > 0)) return 'Sales tax';
  return `Sales tax (${Number((rate * 100).toFixed(4))}%)`;
}

/** The invoice's number as it goes in a file name. */
const fileNumber = (number: string) => number.replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Invoice';

/** The name of the PDF Books opens: Invoice_INV10001.pdf. */
export function invoicePdfFilename(number: string): string {
  return `Invoice_${fileNumber(number)}.pdf`;
}

/**
 * The name of the file FleetSuite keeps in NetSuite for one version of its copy: Invoice_INV10001_123456.pdf, then
 * Invoice_INV10001_123456_v2.pdf once the invoice is fixed. NetSuite's id makes it the invoice's alone, so the script
 * that attaches it can look for it by name when FleetSuite sends it again.
 */
export function netsuitePdfFilename(number: string, netsuiteId: string, version: number): string {
  return `Invoice_${fileNumber(number)}_${netsuiteId}${version > 1 ? `_v${version}` : ''}.pdf`;
}

/** What goes on the page, from FleetSuite's copy of the invoice as gl_own_invoice_pairs reads it. */
export function ownInvoicePdfData(
  own: OwnInvoiceData,
  more: {
    customer: string | null;
    address: BillToAddress | null;
    voided: boolean;
    letterhead: InvoicePdfData['letterhead'];
  },
): InvoicePdfData {
  return {
    number: own.number?.trim() || own.netsuite_id,
    date: own.date,
    dueDate: own.due_date,
    terms: own.terms_name,
    poNumber: own.po_number,
    vin: own.vin,
    memo: own.memo,
    customer: more.customer,
    billTo: billToLines(more.address),
    lines: own.lines.map((l) => ({
      itemNumber: l.item_number,
      description: l.description,
      quantity: num(l.quantity),
      rate: num(l.rate),
      cents: toCents(l.amount),
      priced: l.priced,
    })),
    subtotalCents: toCents(own.subtotal),
    taxCents: toCents(own.tax),
    totalCents: toCents(own.total),
    taxBasis: own.tax_basis,
    taxRate: num(own.tax_rate) ?? 0,
    voided: more.voided,
    letterhead: more.letterhead,
  };
}

/** The invoice on a letter page, more pages when its lines need them. */
export function buildOwnInvoicePdf(data: InvoicePdfData): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const right = pageW - MARGIN;
  const lh = data.letterhead ?? null;
  const companyName = pageText(lh?.company?.name || 'BMG Fleet');
  let y = 48;

  if (lh?.logoDataUrl) {
    try {
      const props = doc.getImageProperties(lh.logoDataUrl);
      const fmt = /^data:image\/jpe?g/i.test(lh.logoDataUrl) ? 'JPEG' : 'PNG';
      const h = 34;
      const w = Math.min(160, (props.width / props.height) * h);
      // Compressed, as on the statement: an uncompressed logo makes a page of a megabyte or more.
      doc.addImage(lh.logoDataUrl, fmt, MARGIN, y - 12, w, h, undefined, 'FAST');
      y += h - 2;
    } catch { /* a logo that can't be read leaves the text letterhead */ }
  }

  doc.setFontSize(20).setFont('helvetica', 'bold').setTextColor(17, 24, 39).text('Invoice', MARGIN, y + 12);
  doc.setFontSize(14).text(pageText(data.number), right, y + 12, { align: 'right' });
  if (data.voided) {
    doc.setFontSize(10).setTextColor(185, 28, 28).text('Voided', right, y + 26, { align: 'right' });
  }
  y += 34;

  // The company on the left, who it's billed to on the right, as on the statement.
  const nameFont = () => doc.setFontSize(11).setFont('helvetica', 'bold').setTextColor(17, 24, 39);
  const lineFont = () => doc.setFontSize(9.5).setFont('helvetica', 'normal').setTextColor(55, 65, 81);
  let leftY = y + 14;
  nameFont().text(companyName, MARGIN, leftY);
  lineFont();
  for (const line of companyLines(lh?.company)) {
    leftY += 12;
    doc.text(pageText(line), MARGIN, leftY);
  }

  let rightY = y + 14;
  nameFont().text('Bill to', right, rightY, { align: 'right' });
  lineFont();
  for (const line of [data.customer ?? '', ...data.billTo].filter((l) => !blank(l))) {
    rightY += 12;
    doc.text(pageText(line), right, rightY, { align: 'right' });
  }
  doc.setTextColor(0);

  const head = { fillColor: [244, 244, 244] as [number, number, number], textColor: 60, fontSize: 8.5 };
  autoTable(doc, {
    startY: Math.max(leftY, rightY) + 20,
    margin: { left: MARGIN, right: MARGIN },
    theme: 'plain',
    head: [['Invoice date', 'Due date', 'Terms', 'PO #', 'VIN']],
    body: [[
      longDay(data.date),
      data.dueDate ? longDay(data.dueDate) : DASH,
      blank(data.terms) ? DASH : pageText(data.terms!),
      blank(data.poNumber) ? DASH : pageText(data.poNumber!),
      blank(data.vin) ? DASH : pageText(data.vin!),
    ]],
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: head,
  });

  const amountRow = (label: string, cents: number, bold = false) => [
    { content: label, colSpan: 4, styles: { halign: 'right' as const, fontStyle: bold ? 'bold' as const : 'normal' as const } },
    { content: usd(cents), styles: { halign: 'right' as const, fontStyle: bold ? 'bold' as const : 'normal' as const } },
  ];
  autoTable(doc, {
    startY: (doc as any).lastAutoTable.finalY + 14,
    margin: { left: MARGIN, right: MARGIN },
    head: [['Item', 'Description', ...['Qty', 'Rate', 'Amount'].map((content) => ({ content, styles: { halign: 'right' as const } }))]],
    body: data.lines.map((l) => [
      blank(l.itemNumber) ? '' : pageText(l.itemNumber!),
      blank(l.description) ? '' : pageText(l.description!),
      l.quantity === null ? '' : qtyText(l.quantity),
      l.rate === null ? '' : rateText(l.rate),
      l.priced ? usd(l.cents) : 'Not priced',
    ]),
    foot: [
      amountRow('Subtotal', data.subtotalCents),
      amountRow(taxLabel(data.taxBasis, data.taxRate), data.taxCents),
      amountRow('Total', data.totalCents, true),
    ],
    showFoot: 'lastPage',
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: [37, 99, 235], fontSize: 8.5 },
    footStyles: { fillColor: [255, 255, 255], textColor: 20 },
    columnStyles: { 0: { cellWidth: 90 }, 2: { halign: 'right', cellWidth: 48 }, 3: { halign: 'right', cellWidth: 70 }, 4: { halign: 'right', cellWidth: 80 } },
  });

  let noteY = (doc as any).lastAutoTable.finalY + 20;
  doc.setFontSize(9).setFont('helvetica', 'normal').setTextColor(55, 65, 81);
  if (!blank(data.memo)) {
    const memo = doc.splitTextToSize(`Memo: ${pageText(data.memo!)}`, pageW - MARGIN * 2) as string[];
    doc.text(memo, MARGIN, noteY);
    noteY += memo.length * 11 + 8;
  }
  doc.setFontSize(8.5).setTextColor(100).text(
    `Thank you for your business. Please contact ${companyName} with any questions about this invoice.`,
    MARGIN, noteY, { maxWidth: pageW - MARGIN * 2 },
  );

  return doc;
}
