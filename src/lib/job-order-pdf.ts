/**
 * Job Order PDF — a sales order printed as a shop pick ticket, with no
 * pricing (see job-order.ts). Drawn in the shared FleetSuite form layout
 * (src/lib/transaction-pdf.ts, Craig 2026-11-06): letterhead, customer /
 * ship-to, a details row, End user in a red box, then qty · part ·
 * description lines with an empty Picked box per line, Vendor POs, and
 * Picked by / Checked by sign-off lines.
 *
 * buildJobOrderPdf is pure (testable in node); openJobOrder is the click
 * handler that fetches the live SO and opens the print dialog.
 */

import jsPDF from 'jspdf';
import { vendorPoText, type JobOrderData } from './job-order';
import { buildFormPdf } from './transaction-pdf';
import { ensureFormLetterhead, formLetterhead, type FormLetterhead } from './form-letterhead-client';
import type { CompanyProfile } from './statement-pdf-doc';

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

export function buildJobOrderPdf(data: JobOrderData, opts?: { logo?: string | null; company?: CompanyProfile | null; printedAt?: Date }): jsPDF {
  return buildJobOrdersPdf([data], opts);
}

/**
 * Several Job Orders in ONE PDF (the To Print list's "Print selected",
 * Craig 2026-11-04), each starting on its own page with its own page
 * numbers, so the shop sends one print job.
 */
export function buildJobOrdersPdf(list: JobOrderData[], opts?: { logo?: string | null; company?: CompanyProfile | null; printedAt?: Date }): jsPDF {
  const loaded = formLetterhead();
  const letterhead = {
    company: opts?.company === undefined ? loaded.company : opts.company,
    logoDataUrl: opts?.logo === undefined ? loaded.logoDataUrl : opts.logo,
  };
  const printedAt = opts?.printedAt || new Date();
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  list.forEach((data, i) => {
    if (i > 0) doc.addPage();
    drawJobOrder(doc, data, letterhead, printedAt);
  });
  return doc;
}

/** One Job Order in the shared form layout (src/lib/transaction-pdf.ts, Craig 2026-11-06), no prices. */
function drawJobOrder(doc: jsPDF, data: JobOrderData, letterhead: FormLetterhead, printedAt: Date): void {
  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;

  const details: { label: string; value: string | null }[] = [
    { label: 'Order date', value: data.orderDate ? fmtDate(data.orderDate) : null },
    { label: 'Customer PO', value: data.poNumber },
  ];
  if (data.shipDate) details.push({ label: 'Ship date', value: fmtDate(data.shipDate) });
  if (data.shipMethod) details.push({ label: 'Ship via', value: data.shipMethod });
  details.push({ label: 'Sales rep', value: data.salesRep });
  if (data.status) details.push({ label: 'Status', value: data.status });
  if (data.vin) details.push({ label: 'VIN', value: data.vin });

  buildFormPdf({
    title: 'Job Order',
    number: data.soNumber,
    blocks: [
      { label: 'Customer', lines: [data.customer || '-'] },
      ...(data.shipTo ? [{ label: 'Ship to', lines: String(data.shipTo).split(/\r?\n/).map(l => l.trim()).filter(Boolean) }] : []),
    ],
    details,
    callout: data.endUser ? { label: 'End user', value: data.endUser } : null,
    table: {
      head: ['Qty', 'Part number', 'Description', 'Picked'],
      rows: data.lines.length > 0
        ? data.lines.map(l => [fmtQty(l.quantity), l.partNumber || '', l.description || '', ''])
        : [['', '', 'No lines on this sales order', '']],
      right: [0],
      widths: { 0: 45, 1: 120 },
      tickColumn: 3,
      tickRows: data.lines.length > 0 ? data.lines.map(l => l.quantity != null) : [false],
    },
    memo: data.memo,
    notes: [{ label: 'Vendor POs', value: vendorPoText(data.vendorPos) || 'none yet' }],
    signoffs: ['Picked by / Date', 'Checked by / Date'],
    letterhead,
  }, doc);

  // Printed line and page numbers on every page of this order.
  const endPage = doc.getNumberOfPages();
  const pages = endPage - startPage + 1;
  for (let p = startPage; p <= endPage; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`BMG Fleet · Job Order ${data.soNumber} · printed ${printedAt.toLocaleString('en-US')}`, margin, pageH - 20);
    if (pages > 1) doc.text(`Page ${p - startPage + 1} of ${pages}`, pageW - margin, pageH - 20, { align: 'right' });
    doc.setTextColor(0);
  }
  doc.setPage(endPage);
}

/**
 * Click handler: open a tab synchronously (popup blockers), fetch the live
 * sales order, build the Job Order and show it with the print dialog.
 */
export async function openJobOrder(soId: string): Promise<{ ok: boolean; error?: string }> {
  ensureFormLetterhead();
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

/**
 * Click handler for "Print selected": one tab opened synchronously (popup
 * blockers), every order fetched live, one PDF with the print dialog.
 * Orders that couldn't be read are left out and named in `failed`; if none
 * could be read nothing opens.
 */
export async function openJobOrders(soIds: string[]): Promise<{ ok: boolean; printed: string[]; failed: { soId: string; error: string }[]; error?: string }> {
  ensureFormLetterhead();
  const w = window.open('about:blank', '_blank');
  const results = await Promise.all(soIds.map(async (soId) => {
    try {
      const res = await fetch(`/api/netsuite/job-order/${encodeURIComponent(soId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.soNumber) throw new Error(data?.error || `Could not load the sales order (${res.status})`);
      return { soId, data: data as JobOrderData };
    } catch (e: any) {
      return { soId, error: e?.message || 'Could not load the sales order' };
    }
  }));
  const good = results.filter((r): r is { soId: string; data: JobOrderData } => 'data' in r);
  const failed = results.filter((r): r is { soId: string; error: string } => 'error' in r);
  if (good.length === 0) {
    w?.close();
    return { ok: false, printed: [], failed, error: failed[0]?.error || 'Could not open the sales orders' };
  }
  try {
    const doc = buildJobOrdersPdf(good.map(g => g.data));
    doc.autoPrint();
    const url = String(doc.output('bloburl'));
    if (w) w.location.href = url;
    else if (!window.open(url, '_blank')) doc.save('job-orders.pdf');
    return { ok: true, printed: good.map(g => g.soId), failed };
  } catch (e: any) {
    w?.close();
    return { ok: false, printed: [], failed, error: e?.message || 'Could not build the PDF' };
  }
}
