import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { safeIntId, SqlSafeError } from '@/lib/sql-safe';
import { fetchStatementInvoices, type StatementInvoice, type StatementScope } from '@/lib/financials-data';
import { getNetSuitePdf } from '@/lib/netsuite';
import { sendEmailDetailed } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { r2PublicUrl } from '@/lib/r2';
import { getEmailSignature, renderSignatureHtml, type EmailSignature } from '@/lib/email-signature';
import { generateStatementPdf } from '@/lib/statement-pdf-server';
import { statementPdfFilename } from '@/lib/statement-pdf-doc';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/netsuite/email-statement
 *
 * Email a customer their open-item statement: a branded HTML statement in
 * the email body (invoice table + aging summary), with a PDF copy of the
 * statement itself attached first (the same document the Statement PDF /
 * Print buttons open — CLAUDE.md "every transaction email carries a PDF
 * copy"), then the open invoices' NetSuite PDFs (capped — fetching many
 * PDFs server-side runs into Vercel's 60s limit, the same reason
 * bulk-download zips client-side).
 *
 * Body: { customerId: <NetSuite internal id>, recipients: string[] (1-10),
 *         customBody?: string, attachInvoices?: boolean (default true),
 *         bccSelf?: boolean, preview?: boolean }
 *
 * preview: true renders the exact email — { to, subject, html, attachments }
 * — with zero side effects (customer-email compose standard): recipients are
 * optional, no PDFs are fetched (the attachment list is predicted from the
 * same selection the send uses), nothing sends, nothing is logged.
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

interface Letterhead { company: any; logoUrl: string | null }

function statementEmailHtml(customer: string, invoices: StatementInvoice[], scope: StatementScope, rangeNote: string, lh: Letterhead, customBody?: string, attachNote?: string, signature?: EmailSignature | null): string {
  const total = invoices.reduce((s, i) => s + i.unpaid, 0);
  const pastDue = invoices.reduce((s, i) => s + (i.daysPastDue > 0 ? i.unpaid : 0), 0);
  const td = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;';
  const tdNum = td + 'text-align:right;white-space:nowrap;';
  const th = 'padding:8px 10px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;text-align:left;';
  const rows = [...invoices]
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map(i => `
      <tr>
        <td style="${td}">${esc(fmtD(i.date))}</td>
        <td style="${td}">${esc(i.tranid)}</td>
        <td style="${td}">${esc(i.po || '—')}</td>
        <td style="${td}">${esc(fmtD(i.dueDate))}</td>
        <td style="${tdNum}${i.daysPastDue > 0 ? 'color:#b91c1c;font-weight:700;' : ''}">${i.status === 'paid' ? 'Paid' : i.daysPastDue > 0 ? `${i.daysPastDue}d late` : 'Open'}</td>
        <td style="${tdNum}">${usd(i.unpaid)}</td>
      </tr>`).join('');

  const intro = customBody && customBody.trim()
    ? esc(customBody).replace(/\n/g, '<br>')
    : `Please find your current statement below${invoices.some(i => i.status === 'open') ? ' — open invoices are attached as PDFs' : ''}.`;

  const co = lh.company || {};
  const coName = co.name || 'BMG Fleet';
  const companyLines = [
    co.name, co.address,
    [co.city, co.state, co.zip].filter(Boolean).join(', '),
    co.phone, co.email,
  ].filter(Boolean).map((l: string) => esc(l)).join('<br>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <tr>
          <td style="vertical-align:top;">
            ${lh.logoUrl ? `<img src="${esc(lh.logoUrl)}" alt="${esc(coName)}" height="44" style="height:44px;max-width:220px;display:block;margin-bottom:10px;">` : ''}
            <div style="font-size:22px;font-weight:800;color:#111827;">Statement</div>
            <div style="font-size:12px;color:#6b7280;">As of ${esc(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))} · ${scope === 'all' ? 'All invoices' : 'Open items only'}${esc(rangeNote)}</div>
          </td>
        </tr>
      </table>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr>
          <td style="vertical-align:top;font-size:12px;color:#374151;line-height:1.5;">${companyLines || esc(coName)}</td>
          <td style="vertical-align:top;font-size:12px;color:#374151;line-height:1.5;text-align:right;"><b style="color:#111827;">Customer</b><br>${esc(customer)}<br>${invoices.length} invoice${invoices.length === 1 ? '' : 's'} · Balance due ${usd(total)}</td>
        </tr>
      </table>
      <div style="font-size:13px;color:#374151;margin:0 0 16px;line-height:1.5;">${intro}</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th style="${th}">Date</th><th style="${th}">Invoice #</th><th style="${th}">PO #</th>
          <th style="${th}">Due</th><th style="${th}text-align:right;">Status</th><th style="${th}text-align:right;">Balance</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="5" style="${tdNum}font-weight:800;border-bottom:none;padding-top:12px;">Total balance due</td>
          <td style="${tdNum}font-weight:800;border-bottom:none;padding-top:12px;">${usd(total)}</td>
        </tr></tfoot>
      </table>
      ${pastDue > 0.005 ? `<div style="font-size:13px;color:#b91c1c;font-weight:700;margin-top:10px;">${usd(pastDue)} of this balance is past due.</div>` : ''}
      ${attachNote ? `<div style="font-size:12px;color:#6b7280;margin-top:10px;">${esc(attachNote)}</div>` : ''}
      <div style="font-size:12px;color:#6b7280;margin-top:18px;border-top:1px solid #e5e7eb;padding-top:12px;">
        Amounts are open balances as of the statement date. Please reply to this email with any questions.
      </div>
      ${renderSignatureHtml(signature, 'light')}
    </div>
    <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">Sent by ${esc(coName)}</div>
  </div>
</body>
</html>`;
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
    const preview = body?.preview === true;
    const recipients: string[] = (Array.isArray(body?.recipients) ? body.recipients : [])
      .map((r: any) => String(r).trim()).filter((r: string) => EMAIL_RE.test(r));
    // A preview renders fine with no recipients yet — the compose screen
    // fetches it while the To field is still being filled in.
    if (!preview && (recipients.length === 0 || recipients.length > 10)) {
      return NextResponse.json({ error: 'Provide 1-10 valid recipient email addresses' }, { status: 400 });
    }
    const scope: StatementScope = body?.scope === 'all' ? 'all' : 'open';
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const from = dateRe.test(String(body?.from || '')) ? String(body.from) : null;
    const to = dateRe.test(String(body?.to || '')) ? String(body.to) : null;
    const rangeNote = from || to ? ` (${from ? `from ${fmtD(from)}` : ''}${from && to ? ' ' : ''}${to ? `through ${fmtD(to)}` : ''})` : '';

    const { invoices } = await fetchStatementInvoices(customerId, { scope, from, to });
    if (invoices.length === 0) {
      return NextResponse.json({ error: scope === 'open' ? 'No open invoices — nothing to put on a statement' : 'No invoices in that range' }, { status: 400 });
    }
    const customerName = invoices[0].customer;

    // ── Attach OPEN invoices' PDFs (best effort, capped) ──────────────────
    // The selection is computed for previews too — the email body's
    // attachment note and the preview's attachment list come from it — but
    // only a real send pays for the NetSuite PDF fetches.
    const attachInvoices = body?.attachInvoices !== false;
    const toAttach = attachInvoices
      ? invoices.filter(i => i.status === 'open')
          .sort((a, b) => b.daysPastDue - a.daysPastDue || (a.date || '').localeCompare(b.date || ''))
          .slice(0, MAX_ATTACH)
      : [];
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const statementFilename = statementPdfFilename(customerName);
    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    const failedAttachments: string[] = [];
    if (!preview) {
      // The statement's own PDF rides first. Unlike the invoice PDFs it is
      // a hard requirement — the body names it, so a render failure fails
      // the send before anything goes out rather than emailing a body that
      // promises a file.
      let statementPdf: Awaited<ReturnType<typeof generateStatementPdf>>;
      try {
        statementPdf = await generateStatementPdf(supabase, { customer: customerName, invoices, scope, from, to });
      } catch (err: any) {
        console.error('[email-statement] statement PDF failed:', err?.message || err);
        statementPdf = { ok: false, status: 500, error: err?.message || 'PDF render failed' };
      }
      if (!statementPdf.ok) {
        return NextResponse.json({ error: `Could not generate the statement PDF (${statementPdf.error}). Nothing was sent — try again.` }, { status: 502 });
      }
      attachments.push({ filename: statementPdf.filename, content: statementPdf.buffer, contentType: 'application/pdf' });

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
    const openCount = invoices.filter(i => i.status === 'open').length;
    // Invoice PDFs only — the statement PDF is always the first attachment.
    const invoicesAttached = preview ? toAttach.length : Math.max(0, attachments.length - 1);
    const attachNote = [
      'A PDF copy of this statement is attached.',
      attachInvoices && openCount > MAX_ATTACH ? `The ${Math.min(MAX_ATTACH, invoicesAttached)} most overdue invoices are attached; the table above covers all ${invoices.length}.` : '',
      failedAttachments.length ? `PDFs unavailable for: ${failedAttachments.join(', ')}.` : '',
    ].filter(Boolean).join(' ');

    // Letterhead from the same settings singleton the wrap quote uses, so
    // both documents carry identical branding.
    const { data: settings } = await supabase.from('wrap_quote_settings').select('company').eq('id', 1).maybeSingle();
    const co: any = settings?.company || {};
    const lh = { company: co, logoUrl: co.logo_path ? r2PublicUrl('vehicle-templates', co.logo_path) : null };

    // Sender's signature — in the preview too, so what they see is what goes.
    const signature = await getEmailSignature(supabase, auth.user?.id);
    const html = statementEmailHtml(customerName, invoices, scope, rangeNote, lh, body?.customBody, attachNote, signature);
    const subject = `Statement — ${customerName} — ${new Date().toLocaleDateString('en-US')}`;

    // Preview: the exact email that would go out — nothing sends, nothing
    // is logged. Attachment names are predicted (real filenames come from
    // NetSuite at send time).
    if (preview) {
      return NextResponse.json({
        preview: true,
        to: recipients.join(', ') || null,
        subject,
        html,
        attachments: [statementFilename, ...toAttach.map(i => `Invoice_${i.tranid}.pdf`)],
      });
    }

    // Standard compose behavior: replies reach the sender (the from address
    // has no mailbox), and bcc-me copies the send to their inbox.
    const bcc = body?.bccSelf === true && auth.user?.email ? [auth.user.email] : undefined;
    // Cc BMG teammates (compose screen row) — validated like To.
    const cc: string[] = (Array.isArray(body?.cc) ? body.cc : []).map((r: any) => String(r).trim()).filter((r: string) => EMAIL_RE.test(r)).slice(0, 10);
    const result = await sendEmailDetailed(
      recipients, subject, html, undefined, attachments, auth.user?.email || undefined, bcc,
      // ns-<id> routes to the customer record even when no CRM row exists.
      { kind: 'statement', cc, sentBy: auth.user?.id, contextUrl: deepLinks.prospect(`ns-${customerId}`), netsuiteCustomerId: String(customerId) },
    );
    if (!result.ok) {
      return NextResponse.json({ error: 'Email send failed' }, { status: 502 });
    }

    // CRM-timeline logging now happens in the send layer itself (the
    // EmailMeta netsuiteCustomerId above) — every composed send lands one
    // 'email' activity with the log row attached, so the bespoke insert
    // that used to live here would double-log.

    return NextResponse.json({ success: true, sent: recipients, statementPdf: statementFilename, attached: invoicesAttached, failedAttachments });
  } catch (e: any) {
    if (e instanceof SqlSafeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e?.message || 'Failed to email statement' }, { status: 500 });
  }
}
