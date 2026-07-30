/**
 * Print / CSV export helpers for purchase orders — shared by the PO list
 * (batch print in select mode) and the PO record page (Print PO / Download
 * CSV). Extracted from the list page when it became a thin table.
 */

import type { PurchaseOrder, POLineItem } from '@/lib/types';
import { formatShipTo } from '@/lib/graphics-job-from-po';

type PrintablePo = PurchaseOrder & { line_items: POLineItem[] };

function csvEscape(value: string | number | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadPoCsv(po: PrintablePo) {
  const header = ['Part Number', 'Description', 'Quantity', 'Installed', 'Unit Price', 'Line Total'];
  const rows = po.line_items.map(li => [
    li.part_number,
    li.description || '',
    li.quantity,
    li.installed,
    li.unit_price.toFixed(2),
    (li.quantity * li.unit_price).toFixed(2),
  ]);
  const total = po.line_items.reduce((s, li) => s + li.quantity * li.unit_price, 0);
  rows.push(['', '', '', '', 'Total', total.toFixed(2)]);
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `PO-${po.po_number || po.id}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
));

const PO_PRINT_STYLE = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: #111; margin: 32px; font-size: 12px; }
  h1 { margin: 0 0 4px 0; font-size: 22px; }
  .sub { color: #666; font-size: 12px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 20px 0 24px; }
  .box h3 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .box .v { white-space: pre-line; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #333; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 700; border-top: 2px solid #111; border-bottom: none; padding-top: 12px; }
  .notes { margin-top: 24px; padding: 12px; border: 1px solid #ddd; border-radius: 6px; background: #fafafa; }
  .notes h3 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .po-page { page-break-after: always; }
  .po-page:last-child { page-break-after: auto; }
  @media print { body { margin: 16px; } @page { margin: 0.5in; } }
`;

// One PO's printable body — shared by the single-PO print and the multi-PO
// batch print (which stacks these with a page break between POs).
function poPrintBody(po: PrintablePo): string {
  const ship = formatShipTo(po.ship_to);
  const total = po.line_items.reduce((s, li) => s + li.quantity * li.unit_price, 0);
  const ordered = po.ordered_date ? new Date(po.ordered_date).toLocaleDateString() : '';
  const requested = po.requested_delivery_date ? new Date(po.requested_delivery_date).toLocaleDateString() : '';
  const linesHtml = po.line_items.map(li => `
    <tr>
      <td>${escapeHtml(li.part_number)}</td>
      <td>${escapeHtml(li.description || '')}</td>
      <td class="num">${li.quantity}</td>
      <td class="num">$${li.unit_price.toFixed(2)}</td>
      <td class="num">$${(li.quantity * li.unit_price).toFixed(2)}</td>
    </tr>`).join('');
  return `
  <h1>Purchase Order #${escapeHtml(po.po_number)}</h1>
  <div class="sub">${escapeHtml(po.customer)}${po.status ? ` · ${escapeHtml(po.status)}` : ''}</div>
  <div class="grid">
    <div class="box">
      <h3>Ship To</h3>
      <div class="v">${ship ? escapeHtml(ship) : '<span style="color:#999">—</span>'}</div>
    </div>
    <div class="box">
      <h3>Dates</h3>
      <div class="v">Ordered: ${escapeHtml(ordered) || '—'}${requested ? `\nRequested: ${escapeHtml(requested)}` : ''}</div>
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Part #</th>
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit Price</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${linesHtml}</tbody>
    <tfoot>
      <tr>
        <td colspan="4" class="num">Total</td>
        <td class="num">$${total.toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>
  ${po.notes ? `<div class="notes"><h3>Notes</h3>${escapeHtml(po.notes)}</div>` : ''}`;
}

async function openPrintWindow(title: string, bodyHtml: string, alertFn: (message: string) => Promise<void>) {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${PO_PRINT_STYLE}</style>
</head>
<body>${bodyHtml}</body>
</html>`;
  const w = window.open('', '_blank');
  if (!w) { await alertFn('Pop-up blocked. Allow pop-ups to print.'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.onload = () => { w.focus(); w.print(); };
}

export async function printPo(po: PrintablePo, alertFn: (message: string) => Promise<void>) {
  await openPrintWindow(`PO #${po.po_number}`, poPrintBody(po), alertFn);
}

// Batch print: every selected PO in one document, one PO per page.
export async function printPos(posToPrint: PrintablePo[], alertFn: (message: string) => Promise<void>) {
  if (posToPrint.length === 0) return;
  if (posToPrint.length === 1) return printPo(posToPrint[0], alertFn);
  const body = posToPrint.map(po => `<div class="po-page">${poPrintBody(po)}</div>`).join('');
  await openPrintWindow(`Purchase Orders (${posToPrint.length})`, body, alertFn);
}
