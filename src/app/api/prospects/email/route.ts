import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { sendEmailDetailed } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { r2PublicUrl } from '@/lib/r2';
import { getEmailSignature, renderSignatureHtml, type EmailSignature } from '@/lib/email-signature';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/prospects/email — the general "email this customer/vendor"
 * flow behind the record page's Email button and contact-row links, which
 * used to be bare mailto: links (the device's mail app then composed from
 * whatever account it considered default — iCloud vs BMG — and FleetSuite
 * never saw the send). Standard compose contract
 * (docs/customer-email-standard.md): emails[], bccSelf, subject, message,
 * preview. Sends land in email_log with the customer/prospect linkage, so
 * they show on the account history automatically.
 */
const Schema = z.object({
  prospectId: z.string().uuid().optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  netsuiteCustomerId: z.string().max(40).optional().nullable(),
  /** Display name for the letterhead greeting line (company or contact). */
  recipientLabel: z.string().trim().max(200).optional().nullable(),
  emails: z.array(z.string().email().max(254)).max(20).default([]),
  bccSelf: z.boolean().optional().default(false),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  subject: z.string().trim().max(200).optional().default(''),
  message: z.string().trim().max(10_000).optional().default(''),
  preview: z.boolean().optional().default(false),
  /**
   * Appends the server-templated "Complete your credit application" CTA
   * (the public form's URL is never client-supplied — this flag is the
   * only way the link gets in). Used by the record page's "Send credit
   * application" action; the send is logged as kind credit_app_invite.
   */
  includeCreditAppLink: z.boolean().optional().default(false),
});

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function creditAppCtaHtml(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const link = `${appUrl}/credit-application`;
  return `
      <div style="margin:20px 0;text-align:center;">
        <a href="${esc(link)}" style="display:inline-block;background:#1a2b36;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 28px;border-radius:8px;">Complete your credit application</a>
        <div style="font-size:11px;color:#9ca3af;margin-top:8px;">Or copy this link: ${esc(link)}</div>
      </div>`;
}

function buildEmailHtml(company: any, logoUrl: string | null, message: string, signature: EmailSignature | null, ctaHtml = ''): string {
  const companyLines = [
    company?.name, company?.address,
    [company?.city, company?.state, company?.zip].filter(Boolean).join(', '),
    company?.phone, company?.email,
  ].filter(Boolean).map((l: string) => esc(l)).join('<br>');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
      ${logoUrl ? `<img src="${esc(logoUrl)}" alt="${esc(company?.name || 'Company logo')}" height="44" style="height:44px;max-width:220px;display:block;margin-bottom:14px;">` : ''}
      <div style="font-size:13px;color:#374151;white-space:pre-wrap;line-height:1.6;">${esc(message)}</div>
      ${ctaHtml}
      ${renderSignatureHtml(signature, 'light')}
      <div style="font-size:12px;color:#6b7280;margin-top:18px;border-top:1px solid #e5e7eb;padding-top:12px;line-height:1.5;">${companyLines}</div>
    </div>
    <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">Sent by ${esc(company?.name || 'BMG Fleet')}</div>
  </div>
</body>
</html>`;
}

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;

  try {
    const { data: settings } = await supabase
      .from('wrap_quote_settings').select('company').eq('id', 1).maybeSingle();
    const company = settings?.company || {};
    const logoUrl = company?.logo_path ? r2PublicUrl('vehicle-templates', company.logo_path) : null;
    // Sender's signature — in the preview too, so what they see is what goes.
    const signature = await getEmailSignature(supabase, auth.user?.id);

    const subject = p.subject
      || (p.includeCreditAppLink ? `Credit application — ${company?.name || 'BMG Fleet'}` : `Message from ${company?.name || 'BMG Fleet'}`);
    const defaultInviteMsg = 'To set up net payment terms with us, please complete our credit application using the button below. It takes about ten minutes, and our team reviews applications within 2-3 business days.';
    const html = buildEmailHtml(
      company, logoUrl,
      p.message || (p.includeCreditAppLink ? defaultInviteMsg : ''),
      signature,
      p.includeCreditAppLink ? creditAppCtaHtml() : '',
    );

    if (p.preview) {
      return NextResponse.json({ preview: true, to: p.emails.join(', ') || null, subject, html });
    }

    if (p.emails.length === 0) {
      return NextResponse.json({ error: 'Enter at least one recipient email address.' }, { status: 400 });
    }
    // A credit-app invite's substance is the CTA button; the personal
    // message is optional there (the preview shows the default line).
    if (!p.message.trim() && !p.includeCreditAppLink) {
      return NextResponse.json({ error: 'Write a message before sending.' }, { status: 400 });
    }

    const contextUrl = p.prospectId
      ? deepLinks.prospect(p.prospectId)
      : p.netsuiteCustomerId ? deepLinks.prospect(`ns-${p.netsuiteCustomerId}`) : null;
    const bcc = p.bccSelf && auth.user?.email ? [auth.user.email] : undefined;
    const { ok } = await sendEmailDetailed(
      p.emails, subject, html, undefined, undefined, auth.user?.email || undefined, bcc,
      {
        kind: p.includeCreditAppLink ? 'credit_app_invite' : 'customer_email',
        cc: p.cc,
        sentBy: auth.user?.id,
        contextUrl,
        customerId: p.customerId,
        prospectId: p.prospectId,
        netsuiteCustomerId: p.netsuiteCustomerId,
      },
    );
    if (!ok) {
      return NextResponse.json({ error: 'Email send failed (is Resend configured?)' }, { status: 502 });
    }
    return NextResponse.json({ success: true, to: p.emails, bcc: bcc || [] });
  } catch (err: any) {
    console.error('prospect email send failed:', err);
    return NextResponse.json({ error: err?.message || 'Failed to send email' }, { status: 500 });
  }
}
