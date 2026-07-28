'use client';

/**
 * Printable financial documents for the Financials drill-downs: customer
 * statements and vendor-bill summaries, plus the financials-gated invoice-PDF
 * opener.
 *
 * Statements and bills are rendered as HTML into a new window and printed
 * from there (same pattern as the PO print in admin/pos) — NetSuite's PDF
 * RESTlet only renders invoices/SOs/estimates, so these are built locally.
 * The window MUST be opened synchronously inside the click gesture (popup
 * blockers), and the blocked-popup fallback must go through useDialog's
 * alert — native window.alert hangs the Capacitor webview.
 */

import { apiFetch } from '@/lib/api-client';
import { companyLines, type CompanyLetterhead } from '@/lib/company-profile';
import type { OpenArInvoice, OpenVendorBill, AgingBucketKey } from '@/lib/financials-data';

export const usd2 = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** ISO date → M/D/YYYY without timezone shifts (no Date parsing). */
export const fmtDate = (iso: string | null): string => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
));

const PRINT_STYLE = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: #111; margin: 32px; font-size: 12px; }
  h1 { margin: 0 0 4px 0; font-size: 22px; }
  .sub { color: #666; font-size: 12px; }
  .head { margin-bottom: 8px; }
  .head img { height: 42px; display: block; margin-bottom: 8px; }
  .head h1 { color: #111827; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 20px 0 24px; }
  .box h3 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .box .v { white-space: pre-line; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #333; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  td.late { color: #b91c1c; font-weight: 700; }
  tfoot td { font-weight: 700; border-top: 2px solid #111; border-bottom: none; padding-top: 12px; }
  table.aging { margin-top: 20px; }
  .note { margin-top: 24px; padding: 12px; border: 1px solid #ddd; border-radius: 6px; background: #fafafa; color: #444; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  @media print { body { margin: 16px; } @page { margin: 0.5in; } }
`;

async function openPrintWindow(title: string, bodyHtml: string, alertFn: (message: string) => Promise<void>) {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${PRINT_STYLE}</style>
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

const AGING_LABELS: [AgingBucketKey, string][] = [
  ['current', 'Current'],
  ['d1_30', '1–30 days'],
  ['d31_60', '31–60 days'],
  ['d61_90', '61–90 days'],
  ['d90plus', '90+ days'],
];

/** One customer's open-item statement body (letterhead, invoice table, aging). */
function statementBody(customer: string, invoices: OpenArInvoice[], letterhead?: CompanyLetterhead | null): string {
  const asOf = new Date().toLocaleDateString('en-US');
  const total = invoices.reduce((s, i) => s + i.unpaid, 0);
  const pastDue = invoices.reduce((s, i) => s + (i.daysPastDue > 0 ? i.unpaid : 0), 0);
  const buckets: Record<AgingBucketKey, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  for (const i of invoices) buckets[i.bucket as AgingBucketKey] += i.unpaid;

  const rows = [...invoices]
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.tranid.localeCompare(b.tranid))
    .map(i => `
    <tr>
      <td>${escapeHtml(fmtDate(i.date))}</td>
      <td>${escapeHtml(i.tranid)}</td>
      <td>${escapeHtml(i.po || '—')}</td>
      <td>${escapeHtml(fmtDate(i.dueDate))}</td>
      <td class="num${i.daysPastDue > 0 ? ' late' : ''}">${i.daysPastDue > 0 ? i.daysPastDue : '—'}</td>
      <td class="num">${usd2(i.total)}</td>
      <td class="num">${usd2(i.unpaid)}</td>
    </tr>`).join('');

  const agingCells = AGING_LABELS.map(([k]) => `<td class="num">${usd2(buckets[k])}</td>`).join('');
  const agingHead = AGING_LABELS.map(([, label]) => `<th class="num">${label}</th>`).join('');

  const logo = letterhead?.logoDataUrl || letterhead?.logoUrl || `${window.location.origin}/bmg-logo-color.png`;
  const coName = letterhead?.company?.name || 'BMG Fleet';
  const coLines = companyLines(letterhead?.company).map(l => escapeHtml(l)).join('\n');

  return `
  <div class="head">
    <div>
      <img src="${escapeHtml(logo)}" alt="${escapeHtml(coName)}" onerror="this.style.display='none'">
      <h1>Statement</h1>
      <div class="sub">As of ${escapeHtml(asOf)} · Open items only</div>
    </div>
  </div>
  <div class="grid">
    <div class="box">
      <h3>${escapeHtml(coName)}</h3>
      <div class="v">${coLines}</div>
    </div>
    <div class="box">
      <h3>Customer</h3>
      <div class="v">${escapeHtml(customer)}
${invoices.length} open invoice${invoices.length === 1 ? '' : 's'}
Balance due: ${usd2(total)}${pastDue > 0.005 ? `\nPast due: ${usd2(pastDue)}` : ''}</div>
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Invoice #</th>
        <th>PO #</th>
        <th>Due date</th>
        <th class="num">Days past due</th>
        <th class="num">Invoice total</th>
        <th class="num">Balance</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="6" class="num">Total balance due</td>
        <td class="num">${usd2(total)}</td>
      </tr>
    </tfoot>
  </table>
  <table class="aging">
    <thead><tr>${agingHead}</tr></thead>
    <tbody><tr>${agingCells}</tr></tbody>
  </table>
  <div class="note">Amounts are open balances as of the statement date. Please contact ${escapeHtml(coName)} with any questions about this statement.</div>`;
}

/**
 * Print open-item statements — one page per customer. Pass a single entry
 * for an individual statement or many for a batch run.
 */
export async function printStatements(
  groups: { customer: string; invoices: OpenArInvoice[] }[],
  alertFn: (message: string) => Promise<void>,
  letterhead?: CompanyLetterhead | null,
) {
  if (groups.length === 0) return;
  const title = groups.length === 1
    ? `Statement — ${groups[0].customer}`
    : `Customer statements (${groups.length})`;
  const body = groups.map(g => `<div class="page">${statementBody(g.customer, g.invoices, letterhead)}</div>`).join('');
  await openPrintWindow(title, body, alertFn);
}

/**
 * Print a vendor-bill summary. NetSuite's PDF RESTlet can't render vendor
 * bills and the integration role can't read their lines, so this is the
 * header-level record with a pointer to NetSuite for full detail.
 * `unpaidKnown: false` = NetSuite didn't return open balances, so the amount
 * is the full bill total.
 */
export async function printBill(
  bill: OpenVendorBill,
  alertFn: (message: string) => Promise<void>,
  opts?: { unpaidKnown?: boolean; letterhead?: CompanyLetterhead | null },
) {
  const unpaidKnown = opts?.unpaidKnown !== false;
  const partial = unpaidKnown && Math.abs(bill.total - bill.unpaid) > 0.005;
  const lh = opts?.letterhead;
  const body = `
  <div class="head">
    <div>
      <img src="${escapeHtml(lh?.logoDataUrl || lh?.logoUrl || `${window.location.origin}/bmg-logo-color.png`)}" alt="${escapeHtml(lh?.company?.name || 'BMG Fleet')}" onerror="this.style.display='none'">
      <h1>Vendor Bill ${escapeHtml(bill.tranid)}</h1>
      <div class="sub">Open · printed ${escapeHtml(new Date().toLocaleDateString('en-US'))}</div>
    </div>
  </div>
  <div class="grid">
    <div class="box">
      <h3>Vendor</h3>
      <div class="v">${escapeHtml(bill.vendor)}</div>
    </div>
    <div class="box">
      <h3>Dates</h3>
      <div class="v">Bill date: ${escapeHtml(fmtDate(bill.date))}
Due date: ${escapeHtml(fmtDate(bill.dueDate))}${bill.daysPastDue > 0 ? `\n${bill.daysPastDue} days past due` : ''}</div>
    </div>
  </div>
  <table>
    <thead>
      <tr><th>Bill #</th><th>Memo</th><th class="num">Bill total</th><th class="num">Balance due</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>${escapeHtml(bill.tranid)}</td>
        <td>${escapeHtml(bill.memo || '—')}</td>
        <td class="num">${usd2(bill.total)}</td>
        <td class="num">${usd2(bill.unpaid)}</td>
      </tr>
    </tbody>
    <tfoot>
      <tr><td colspan="3" class="num">Balance due</td><td class="num">${usd2(bill.unpaid)}</td></tr>
    </tfoot>
  </table>
  <div class="note">Header summary from NetSuite${partial ? ' (partially paid)' : ''}.${unpaidKnown ? '' : ' Amounts are full bill totals — partial payments may not be reflected.'} Line-level detail on vendor bills isn't visible to the FleetSuite integration — open the bill in NetSuite for the full record.</div>`;
  await openPrintWindow(`Vendor Bill ${bill.tranid}`, body, alertFn);
}

/**
 * Open an invoice PDF in a new tab via the financials-gated route (the staff
 * PDF route 403s for executives). Same blob-URL flow as openNetSuitePdf.
 */
export async function openArInvoicePdf(id: string): Promise<{ ok: boolean; error?: string }> {
  const w = window.open('about:blank', '_blank');
  try {
    const res = await apiFetch(`/api/reports/financials/invoice-pdf?id=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!data.success || !data.pdfBase64) throw new Error(data.error || 'PDF fetch failed');
    const bytes = Uint8Array.from(atob(data.pdfBase64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (w) w.location.href = url;
    else window.open(url, '_blank');
    return { ok: true };
  } catch (e: any) {
    w?.close();
    return { ok: false, error: e?.message || 'Could not open the PDF' };
  }
}
