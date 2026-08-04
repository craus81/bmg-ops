'use client';

/**
 * Per-prospect PDF export for the CRM. Renders a printable single-page
 * (or two-page) summary: header card, contacts, opportunities, recent
 * activity, spend snapshot, and the latest NetSuite documents. Triggered
 * from the prospect detail panel — see /admin/prospects.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface ProspectPDFData {
  prospect: {
    company_name: string;
    contact_name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    website: string | null;
    notes: string | null;
    netsuite_id: string | null;
    is_hot: boolean;
    multi_location: boolean;
    email_campaign: boolean;
    lead_source: string | null;
    created_at: string;
  };
  ownerName?: string | null;
  metrics?: {
    total_spend?: number;
    total_orders?: number;
    ytd_spend?: number;
    ytd_orders?: number;
    last_year_spend?: number;
    last_order_date?: string | null;
    avg_order_value?: number;
  } | null;
  contacts: { name: string; title: string | null; email: string | null; phone: string | null; is_decision_maker: boolean }[];
  opportunities: { title: string; type: string; stage: string; value: number | null; expected_close_date: string | null }[];
  activities: { type: string; summary: string; created_at: string; creator_name?: string }[];
  tags: { tag: string }[];
  documents?: { number: string; date: string; typeLabel: string; status: string }[];
}

const fmtCurrency = (n: number | null | undefined) =>
  typeof n === 'number'
    ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : '—';

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export function exportProspectPDF(data: ProspectPDFData) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ─── Header ────────────────────────────────────────────────
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(data.prospect.company_name || 'Untitled', margin, y);
  y += 22;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(110);
  const headerBits: string[] = [];
  if (data.prospect.is_hot) headerBits.push('🔥 Hot');
  if (data.prospect.multi_location) headerBits.push('Multi-Location');
  if (data.prospect.email_campaign) headerBits.push('Email Campaign');
  if (data.ownerName) headerBits.push(`Owner: ${data.ownerName}`);
  if (data.prospect.lead_source) headerBits.push(`Source: ${data.prospect.lead_source}`);
  if (!data.prospect.netsuite_id) headerBits.push('Not yet in NetSuite');
  if (headerBits.length > 0) {
    doc.text(headerBits.join('  ·  '), margin, y);
    y += 14;
  }

  doc.setTextColor(0);
  const addrLine = [
    data.prospect.address,
    [data.prospect.city, data.prospect.state, data.prospect.zip].filter(Boolean).join(', '),
  ].filter(Boolean).join(' · ');

  const contactLine = [
    data.prospect.contact_name,
    data.prospect.email,
    data.prospect.phone,
    data.prospect.website,
  ].filter(Boolean).join('  ·  ');

  if (contactLine) { doc.text(contactLine, margin, y); y += 12; }
  if (addrLine) { doc.text(addrLine, margin, y); y += 12; }
  if (data.prospect.netsuite_id) {
    doc.setTextColor(110);
    doc.text(`NetSuite Customer #${data.prospect.netsuite_id}`, margin, y);
    doc.setTextColor(0);
    y += 12;
  }
  if (data.tags.length > 0) {
    doc.setTextColor(110);
    doc.text(`Tags: ${data.tags.map(t => t.tag).join(', ')}`, margin, y);
    doc.setTextColor(0);
    y += 12;
  }
  y += 6;

  // ─── Spend Snapshot ─────────────────────────────────────────
  if (data.metrics) {
    const m = data.metrics;
    autoTable(doc, {
      startY: y,
      head: [['Metric', 'Value']],
      body: [
        ['Total Spend', fmtCurrency(m.total_spend)],
        ['Total Orders', String(m.total_orders ?? '—')],
        ['YTD Spend', fmtCurrency(m.ytd_spend)],
        ['YTD Orders', String(m.ytd_orders ?? '—')],
        ['Last Year Spend', fmtCurrency(m.last_year_spend)],
        ['Avg Order Value', fmtCurrency(m.avg_order_value)],
        ['Last Order', fmtDate(m.last_order_date)],
      ],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [37, 99, 235], textColor: 255 },
      margin: { left: margin, right: margin },
      tableWidth: (pageW - margin * 2) / 2 - 6,
    });
    y = (doc as any).lastAutoTable.finalY + 16;
  }

  // ─── Contacts ──────────────────────────────────────────────
  if (data.contacts.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['Contact', 'Title', 'Email', 'Phone']],
      body: data.contacts.map(c => [
        `${c.name}${c.is_decision_maker ? ' ★' : ''}`,
        c.title || '',
        c.email || '',
        c.phone || '',
      ]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [37, 99, 235], textColor: 255 },
      margin: { left: margin, right: margin },
    });
    y = (doc as any).lastAutoTable.finalY + 16;
  }

  // ─── Opportunities ─────────────────────────────────────────
  if (data.opportunities.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['Opportunity', 'Type', 'Stage', 'Value', 'Close']],
      body: data.opportunities.map(o => [
        o.title,
        o.type,
        o.stage,
        fmtCurrency(o.value),
        fmtDate(o.expected_close_date),
      ]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [37, 99, 235], textColor: 255 },
      margin: { left: margin, right: margin },
    });
    y = (doc as any).lastAutoTable.finalY + 16;
  }

  // ─── Recent Activity (latest 20) ───────────────────────────
  if (data.activities.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['When', 'Type', 'Summary', 'By']],
      body: data.activities.slice(0, 20).map(a => [
        fmtDate(a.created_at),
        a.type,
        a.summary,
        a.creator_name || '',
      ]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [37, 99, 235], textColor: 255 },
      margin: { left: margin, right: margin },
      columnStyles: { 2: { cellWidth: 'auto' } },
    });
    y = (doc as any).lastAutoTable.finalY + 16;
  }

  // ─── Latest Documents (latest 25) ──────────────────────────
  if (data.documents && data.documents.length > 0) {
    autoTable(doc, {
      startY: y,
      head: [['Date', 'Type', 'Number', 'Status']],
      body: data.documents.slice(0, 25).map(d => [
        fmtDate(d.date),
        d.typeLabel,
        d.number,
        d.status,
      ]),
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [37, 99, 235], textColor: 255 },
      margin: { left: margin, right: margin },
    });
    y = (doc as any).lastAutoTable.finalY + 16;
  }

  // ─── Notes ─────────────────────────────────────────────────
  if (data.prospect.notes) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Notes', margin, y);
    y += 12;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const lines = doc.splitTextToSize(data.prospect.notes, pageW - margin * 2);
    doc.text(lines, margin, y);
  }

  // ─── Footer ────────────────────────────────────────────────
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(
      `BMG Fleet Customers · Generated ${new Date().toLocaleString()} · Page ${i} of ${pageCount}`,
      margin,
      doc.internal.pageSize.getHeight() - 20,
    );
  }

  const safeName = (data.prospect.company_name || 'customer').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const stamp = new Date().toISOString().split('T')[0];
  doc.save(`crm-${safeName}-${stamp}.pdf`);
}
