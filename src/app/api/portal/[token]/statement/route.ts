import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { resolvePortalCustomer } from '@/lib/portal-token';
import { loadPortalBilling } from '@/lib/portal-billing';
import { generateStatementPdf } from '@/lib/statement-pdf-server';
import { statementPdfFilename } from '@/lib/statement-pdf-doc';
import { getNetSuitePdf } from '@/lib/netsuite';
import { sendEmail } from '@/lib/resend';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Fewer invoice PDFs than the staff route's 10 — the portal shares the same
// 60s budget but has no human watching a spinner explain itself.
const MAX_ATTACH = 6;

/**
 * The portal's statement surface (R5-14):
 *   GET  — download the open-items statement PDF (the same
 *          generateStatementPdf the staff email uses; no free parameters,
 *          scope is always the customer's own open invoices).
 *   POST — "Email me this statement": the token-authed variant of the
 *          staff email-statement route. Recipients are LOCKED to the
 *          customer's own record (primary contact email, else the customer
 *          row's email — never free input), and per the transaction-email
 *          rule the statement PDF rides first with the most-overdue open
 *          invoices' PDFs behind it.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'po_portal_statement', 20)) {
    return NextResponse.json({ error: 'Too many requests — try again shortly.' }, { status: 429 });
  }
  const customer = await resolvePortalCustomer(service, params.token);
  if (!customer) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  try {
    const { raw } = await loadPortalBilling(customer.netsuite_id);
    if (raw.length === 0) {
      return NextResponse.json({ error: 'No open invoices — nothing to put on a statement.' }, { status: 400 });
    }
    const customerName = raw[0].customer || customer.company_name || 'Customer';
    const pdf = await generateStatementPdf(service, { customer: customerName, invoices: raw, scope: 'open' });
    if (!pdf.ok) {
      return NextResponse.json({ error: 'The statement is temporarily unavailable — try again shortly.' }, { status: 502 });
    }
    return new NextResponse(new Uint8Array(pdf.buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${pdf.filename.replace(/[^\w.\- ]+/g, '')}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e: any) {
    console.error('portal statement failed:', e);
    return NextResponse.json({ error: 'The statement is temporarily unavailable — try again shortly.' }, { status: 502 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  // Emails are the expensive path (statement render + invoice PDF fetches
  // + a real send) — a handful per hour is plenty for a legitimate customer.
  if (!await checkRateLimit(ip, 'po_portal_statement_email', 5)) {
    return NextResponse.json({ error: 'Too many requests — try again later.' }, { status: 429 });
  }
  const customer = await resolvePortalCustomer(service, params.token);
  if (!customer) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  try {
    // Recipient lock: the customer's own record only. Primary contact
    // email first, else the customer row's email — the portal never
    // accepts a typed address (a leaked link must not become a relay).
    const { data: primary } = await service
      .from('external_contacts')
      .select('email')
      .eq('customer_id', customer.id)
      .eq('is_primary', true)
      .maybeSingle();
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const recipient = [primary?.email, customer.email]
      .map(e => String(e || '').trim())
      .find(e => emailRe.test(e));
    if (!recipient) {
      return NextResponse.json({
        error: 'No email address is on file for your account — contact your BMG representative to add one.',
      }, { status: 400 });
    }

    const { raw } = await loadPortalBilling(customer.netsuite_id);
    if (raw.length === 0) {
      return NextResponse.json({ error: 'No open invoices — nothing to put on a statement.' }, { status: 400 });
    }
    const customerName = raw[0].customer || customer.company_name || 'Customer';

    // Statement PDF first and mandatory (the body names it — a render
    // failure fails the send before anything goes out).
    const pdf = await generateStatementPdf(service, { customer: customerName, invoices: raw, scope: 'open' });
    if (!pdf.ok) {
      return NextResponse.json({ error: 'Could not generate the statement PDF — nothing was sent. Try again shortly.' }, { status: 502 });
    }
    const attachments = [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }];
    const failed: string[] = [];
    const toAttach = [...raw]
      .sort((a, b) => b.daysPastDue - a.daysPastDue || (a.date || '').localeCompare(b.date || ''))
      .slice(0, MAX_ATTACH);
    for (const inv of toAttach) {
      const invPdf = await getNetSuitePdf('invoice', String(inv.id));
      if (invPdf.success && invPdf.pdfBase64) {
        attachments.push({
          filename: invPdf.filename || `Invoice_${inv.tranid}.pdf`,
          content: Buffer.from(invPdf.pdfBase64, 'base64'),
          contentType: 'application/pdf',
        });
      } else {
        failed.push(inv.tranid);
      }
    }

    const total = raw.reduce((s, i) => s + i.unpaid, 0);
    const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
      <div style="font-size:11px;font-weight:800;color:#ee3120;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">BMG Fleet</div>
      <div style="font-size:19px;font-weight:800;color:#111827;">Your statement</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">${esc(customerName)} · requested from your billing portal</div>
      <div style="font-size:14px;color:#374151;line-height:1.6;margin-top:14px;">
        Your current balance is <b>${usd(total)}</b> across ${raw.length} open invoice${raw.length !== 1 ? 's' : ''}.
        A PDF copy of the statement is attached${attachments.length > 1 ? `, along with ${attachments.length - 1} invoice PDF${attachments.length !== 2 ? 's' : ''}` : ''}.
        ${failed.length ? `PDFs were unavailable for: ${esc(failed.join(', '))}.` : ''}
      </div>
      <div style="font-size:12px;color:#6b7280;margin-top:16px;border-top:1px solid #e5e7eb;padding-top:12px;">
        Questions? Just reply to this email.
      </div>
    </div>
    <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">Requested via your BMG Fleet billing portal.</div>
  </div>
</body></html>`;

    const ok = await sendEmail(
      recipient,
      `Statement — ${customerName} — ${new Date().toLocaleDateString('en-US')}`,
      html, undefined, attachments, undefined, undefined,
      { kind: 'statement', customerId: customer.id, netsuiteCustomerId: customer.netsuite_id },
    );
    if (!ok) return NextResponse.json({ error: 'Email send failed — try again shortly.' }, { status: 502 });

    // The customer sees where it went (masked — the portal link may be shared).
    const masked = recipient.replace(/^(.).*(@.*)$/, '$1…$2');
    return NextResponse.json({ success: true, sentTo: masked, attached: attachments.length });
  } catch (e: any) {
    console.error('portal statement email failed:', e);
    return NextResponse.json({ error: 'Could not email the statement — try again shortly.' }, { status: 502 });
  }
}
