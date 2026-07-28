import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { safeIntId, SqlSafeError } from '@/lib/sql-safe';
import { fetchOpenArInvoices, type OpenArInvoice } from '@/lib/financials-data';
import { getNetSuitePdf } from '@/lib/netsuite';
import { sendEmailDetailed } from '@/lib/resend';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/netsuite/email-statement
 *
 * Email a customer their open-item statement: a branded HTML statement in
 * the email body (invoice table + aging summary), with the open invoices'
 * NetSuite PDFs attached (capped — fetching many PDFs server-side runs into
 * Vercel's 60s limit, the same reason bulk-download zips client-side).
 *
 * Body: { customerId: <NetSuite internal id>, recipients: string[] (1-10),
 *         customBody?: string, attachInvoices?: boolean (default true) }
 *
 * Failed PDF fetches don't block the send — the statement body is the
 * document of record; failures are reported in the response and a note is
 * added to the email. Sales + finance only (admin passes via requireRole).
 */

const MAX_ATTACH = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const esc = (s: string) => s.replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
));
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtD = (iso: string | null) => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
};

function statementEmailHtml(customer: string, invoices: OpenArInvoice[], customBody?: string, attachNote?: string): string {
  const total = invoices.reduce((s, i) => s + i.unpaid, 0);
  const pastDue = invoices.reduce((s, i) => s + (i.daysPastDue > 0 ? i.unpaid : 0), 0);
  const td = 'padding:7px 10px;border-bottom:1px solid #2a3644;font-size:13px;color:#f5f8fc;';
  const tdNum = td + 'text-align:right;white-space:nowrap;';
  const th = 'padding:7px 10px;border-bottom:2px solid #3a4654;font-size:11px;color:#8899aa;text-transform:uppercase;letter-spacing:.5px;text-align:left;';
  const rows = [...invoices]
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map(i => `
      <tr>
        <td style="${td}">${esc(fmtD(i.date))}</td>
        <td style="${td}">${esc(i.tranid)}</td>
        <td style="${td}">${esc(i.po || '—')}</td>
        <td style="${td}">${esc(fmtD(i.dueDate))}</td>
        <td style="${tdNum}${i.daysPastDue > 0 ? 'color:#f87171;font-weight:700;' : ''}">${i.daysPastDue > 0 ? `${i.daysPastDue}d` : '—'}</td>
        <td style="${tdNum}">${usd(i.unpaid)}</td>
      </tr>`).join('');

  const intro = customBody && customBody.trim()
    ? esc(customBody).replace(/\n/g, '<br>')
    : `Please find your current statement below${invoices.length ? ' — open invoices are attached as PDFs' : ''}.`;

  return `
  <div style="background:#0f1722;padding:28px 16px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
    <div style="max-width:640px;margin:0 auto;background:#16202e;border:1px solid #2a3644;border-radius:12px;padding:26px 26px 20px;">
      <div style="font-size:19px;font-weight:800;color:#f5f8fc;">BMG Fleet — Statement</div>
      <div style="font-size:13px;color:#8899aa;margin-top:2px;">${esc(customer)} · as of ${esc(new Date().toLocaleDateString('en-US'))}</div>
      <div style="font-size:14px;color:#d5dde6;line-height:1.6;margin:16px 0;">${intro}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:4px;">
        <thead><tr>
          <th style="${th}">Date</th><th style="${th}">Invoice #</th><th style="${th}">PO #</th>
          <th style="${th}">Due</th><th style="${th}text-align:right;">Past due</th><th style="${th}text-align:right;">Balance</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="5" style="${tdNum}font-weight:800;border-bottom:none;padding-top:12px;">Total balance due</td>
          <td style="${tdNum}font-weight:800;border-bottom:none;padding-top:12px;">${usd(total)}</td>
        </tr></tfoot>
      </table>
      ${pastDue > 0.005 ? `<div style="font-size:13px;color:#f87171;font-weight:700;margin-top:10px;">${usd(pastDue)} of this balance is past due.</div>` : ''}
      ${attachNote ? `<div style="font-size:12px;color:#8899aa;margin-top:10px;">${esc(attachNote)}</div>` : ''}
      <div style="font-size:12px;color:#8899aa;margin-top:18px;border-top:1px solid #2a3644;padding-top:12px;">
        Amounts are open balances as of the statement date. Please reply to this email with any questions.
      </div>
    </div>
  </div>`;
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['sales', 'finance']);
  if (auth.error) return auth.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const customerId = safeIntId(body?.customerId, 'customerId');
    const recipients: string[] = (Array.isArray(body?.recipients) ? body.recipients : [])
      .map((r: any) => String(r).trim()).filter((r: string) => EMAIL_RE.test(r));
    if (recipients.length === 0 || recipients.length > 10) {
      return NextResponse.json({ error: 'Provide 1-10 valid recipient email addresses' }, { status: 400 });
    }

    const { invoices } = await fetchOpenArInvoices(customerId);
    if (invoices.length === 0) {
      return NextResponse.json({ error: 'No open invoices — nothing to put on a statement' }, { status: 400 });
    }
    const customerName = invoices[0].customer;

    // ── Attach invoice PDFs (best effort, capped) ─────────────────────────
    const attachInvoices = body?.attachInvoices !== false;
    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    const failedAttachments: string[] = [];
    if (attachInvoices) {
      const toAttach = [...invoices]
        .sort((a, b) => b.daysPastDue - a.daysPastDue || (a.date || '').localeCompare(b.date || ''))
        .slice(0, MAX_ATTACH);
      for (const inv of toAttach) {
        const pdf = await getNetSuitePdf('invoice', inv.id);
        if (pdf.success && pdf.pdfBase64) {
          attachments.push({
            filename: pdf.filename || `Invoice_${inv.tranid}.pdf`,
            content: Buffer.from(pdf.pdfBase64, 'base64'),
            contentType: 'application/pdf',
          });
        } else {
          failedAttachments.push(inv.tranid);
        }
      }
    }
    const attachNote = [
      attachInvoices && invoices.length > MAX_ATTACH ? `The ${Math.min(MAX_ATTACH, attachments.length)} most overdue invoices are attached; the table above covers all ${invoices.length}.` : '',
      failedAttachments.length ? `PDFs unavailable for: ${failedAttachments.join(', ')}.` : '',
    ].filter(Boolean).join(' ');

    const html = statementEmailHtml(customerName, invoices, body?.customBody, attachNote);
    const subject = `Statement — ${customerName} — ${new Date().toLocaleDateString('en-US')}`;
    const result = await sendEmailDetailed(recipients, subject, html, undefined, attachments);
    if (!result.ok) {
      return NextResponse.json({ error: 'Email send failed' }, { status: 502 });
    }

    // Log to the CRM timeline when this customer has a record.
    try {
      const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
      const { data: prospect } = await supabase.from('prospects').select('id').eq('netsuite_id', customerId).maybeSingle();
      if (prospect) {
        const total = invoices.reduce((s, i) => s + i.unpaid, 0);
        await supabase.from('prospect_activities').insert({
          prospect_id: prospect.id,
          type: 'email',
          summary: `Statement emailed to ${recipients.join(', ')} (${invoices.length} open invoice${invoices.length === 1 ? '' : 's'}, ${usd(total)})`,
          created_by: auth.user?.id || null,
        });
      }
    } catch { /* logging is best-effort */ }

    return NextResponse.json({ success: true, sent: recipients, attached: attachments.length, failedAttachments });
  } catch (e: any) {
    if (e instanceof SqlSafeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e?.message || 'Failed to email statement' }, { status: 500 });
  }
}
