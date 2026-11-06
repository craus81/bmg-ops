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
import { graphicsShipSpeedLabel, type GraphicsJob } from '@/lib/types';
import { deliveryFromRow, deliveryLines } from '@/lib/delivery';
import { buildFormPdf } from '@/lib/transaction-pdf';
import { ensureFormLetterhead, formLetterhead, type FormLetterhead } from '@/lib/form-letterhead-client';

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
  /** Shipping speed label, e.g. "UPS 2nd Day Air" (migration 336). */
  shipSpeed?: string | null;
  /** Delivery method lines (migration 414), e.g. Customer Pick-Up + contact. */
  delivery?: { label: string; value: string }[];
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
    shipSpeed: job.delivery_method && job.delivery_method !== 'direct_ship' ? null : graphicsShipSpeedLabel(job.ship_speed),
    // The ship-to address and speed already print in their own blocks.
    delivery: deliveryLines(deliveryFromRow(job, 'graphics_jobs')).filter(l => l.label !== 'Ship to' && l.label !== 'Speed'),
    dueDate: job.due_date,
    lines,
  };
}

/**
 * The packing list in the shared FleetSuite form layout (src/lib/transaction-pdf.ts,
 * Craig 2026-11-06): letterhead, customer / ship to, a details row, the lines
 * with no prices, shipping and delivery notes, and Packed by / Checked by lines.
 * Pure, so it can be tested in node.
 */
export function buildPackingListPdf(data: PackingListData, opts?: { letterhead?: FormLetterhead | null; now?: Date }): jsPDF {
  const now = opts?.now || new Date();
  const details: { label: string; value: string | null }[] = [
    { label: 'Date', value: fmtDate(now.toISOString()) },
    { label: 'Customer PO', value: data.poNumber || null },
  ];
  if (data.invoiceNumber) details.push({ label: 'Invoice', value: String(data.invoiceNumber) });
  if (data.dueDate) details.push({ label: 'Due', value: fmtDate(data.dueDate) });
  const shipping = [data.shipSpeed, data.carrier, data.trackingNumber].filter(Boolean).join('  ·  ');
  const notes = [
    ...(shipping ? [{ label: 'Shipping', value: shipping }] : []),
    ...(data.delivery || []).map(l => ({ label: l.label, value: l.value })),
  ];
  const shipLines = String(data.shipTo || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const doc = buildFormPdf({
    title: 'Packing List',
    number: data.jobNumber ? String(data.jobNumber) : '',
    blocks: [
      { label: 'Customer', lines: [data.customer || '-', ...(data.title ? [String(data.title)] : [])] },
      ...(shipLines.length ? [{ label: 'Ship to', lines: [data.customer || '', ...shipLines].filter(Boolean) }] : []),
    ],
    details,
    table: {
      head: ['Qty', 'Part number', 'Description'],
      rows: data.lines.map(l => [String(l.quantity), l.partNumber || '-', l.description || '']),
      right: [0],
      widths: { 0: 50, 1: 140 },
    },
    notes,
    signoffs: ['Packed by / Date', 'Checked by / Date'],
    letterhead: opts?.letterhead ?? null,
  });
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFontSize(8).setTextColor(140).text(`BMG Fleet · Packing list generated ${now.toLocaleString()}`, 40, pageH - 20);
  doc.setTextColor(0);
  return doc;
}

/**
 * Render and either print (opens a new window with the print dialog) or
 * download the packing list PDF.
 */
export function exportPackingListPDF(data: PackingListData, opts?: { print?: boolean }) {
  ensureFormLetterhead(); // retry for the next click if the load-time fetch failed
  const doc = buildPackingListPdf(data, { letterhead: formLetterhead() });
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
