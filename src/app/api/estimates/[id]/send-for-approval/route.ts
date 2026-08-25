import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { generateToken } from '@/lib/magic-link-approval';
import { sendEmailDetailed } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { sendSMS } from '@/lib/sms-provider';
import { renderEstimateDocument } from '@/lib/estimate-document';
import { getEmailSignature } from '@/lib/email-signature';
import { enrichLinesWithPartAssets } from '@/lib/estimate-line-parts';
import { loadEstimateGraphics } from '@/lib/estimate-graphics';
import { r2PublicUrl } from '@/lib/r2';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SendForApprovalSchema = z.object({
  email: z.string().email().max(254).optional().nullable(),
  // Standard compose fields (docs/customer-email-standard.md): editable
  // multi-recipient To and bcc-the-sender.
  emails: z.array(z.string().email().max(254)).max(20).optional(),
  bccSelf: z.boolean().optional().default(false),
  phone: z.string().trim().max(40).optional().nullable(),
  expiryDays: z.number().int().positive().max(365).optional(),
  // Personal note rendered at the top of the estimate email (plain text,
  // newlines preserved). Same note block the wrap-quote email uses.
  message: z.string().trim().max(5000).optional(),
  // Preview: render exactly what would be sent (recipient, subject, HTML
  // body) WITHOUT minting a token, sending, or marking the estimate sent.
  preview: z.boolean().optional().default(false),
});

/**
 * POST /api/estimates/[id]/send-for-approval
 *
 * Mints (or rotates) an approval token on the estimate and dispatches an
 * email + (flag-gated) SMS to the customer's primary contact. Email works
 * today; SMS lands once SMS_PROVIDER_ENABLED flips on.
 *
 * Body: { email?, phone?, expiryDays? } — optional overrides. When absent,
 * falls back to the customer's primary external contact, then the
 * synced customer.email / customer.phone.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, SendForApprovalSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const expiryDays = body.expiryDays ?? 30;

  const { data: estimate, error: eErr } = await supabase
    .from('estimates')
    .select('*, vehicle_platforms(label)')
    .eq('id', params.id)
    .single();
  if (eErr || !estimate) {
    return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  }
  // Flatten the platform label for the document's vehicle line.
  (estimate as any).vehicle_platform_label = (estimate as any).vehicle_platforms?.label || null;
  if (estimate.customer_approved) {
    return NextResponse.json({ error: 'Already approved' }, { status: 409 });
  }

  // Resolve delivery targets. Explicit compose recipients win; otherwise
  // fall back to the customer's primary contact / synced profile.
  let email: string | null = body.email || null;
  let phone: string | null = body.phone || null;
  const composeEmails = (body.emails || []).map(e => e.trim()).filter(Boolean);

  if (!email || !phone) {
    let customerId: string | null = estimate.customer_id || null;
    if (customerId) {
      const { data: primary } = await supabase
        .from('external_contacts')
        .select('name, email, phone')
        .eq('customer_id', customerId)
        .eq('is_primary', true)
        .maybeSingle();
      if (primary) {
        email = email || primary.email || null;
        phone = phone || primary.phone || null;
      }
      if ((!email || !phone)) {
        const { data: customer } = await supabase
          .from('customers')
          .select('email, phone')
          .eq('id', customerId)
          .maybeSingle();
        if (customer) {
          email = email || customer.email || null;
          phone = phone || customer.phone || null;
        }
      }
    }
  }

  const emailList: string[] = composeEmails.length > 0 ? composeEmails : (email ? [email] : []);

  if (emailList.length === 0 && !phone && !body.preview) {
    return NextResponse.json({ error: 'No email or phone on file for this customer. Add a contact first.' }, { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const subject = `[BMG Fleet] Estimate #${estimate.estimate_number} — Ready for your approval`;
  const message = body.message?.trim() || undefined;

  // The customer-facing document — line items, quantities, rates, totals —
  // loaded once for both the preview and the real send.
  const { data: rawLineItems } = await supabase
    .from('estimate_line_items')
    .select('*')
    .eq('estimate_id', estimate.id)
    .order('sort_order')
    .order('id');
  // Enhanced estimate: product photos + vendor links per line (same
  // enrichment the approval page and signed snapshot use).
  const lineItems = await enrichLinesWithPartAssets(supabase, rawLineItems || []);
  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || {};
  const logoUrl = company?.logo_path ? r2PublicUrl('vehicle-templates', company.logo_path) : null;
  // Sender's signature — in the preview too, so what she sees is what goes.
  const signature = await getEmailSignature(supabase, auth.user?.id);
  // Wrap content from linked wrap quotes (estimate_attach): the email BODY
  // must show the same vinyl/coverage content the attached merged PDF and
  // the frozen snapshot carry — one story on every surface.
  const { summaries: approvalGraphics } = await loadEstimateGraphics(supabase, estimate.id);

  // Preview: show exactly what would go out (message, line items, totals,
  // Approve button) without minting a token, sending, or touching status.
  // The CTA points at a placeholder — the real link is minted on send.
  if (body.preview) {
    const html = renderEstimateDocument(estimate, lineItems || [], {
      company,
      logoUrl,
      message,
      ctaUrl: `${appUrl}/approve/estimate/`,
      ctaLabel: 'Review & Approve',
      ctaNote: `A unique, secure link is generated when you send. It expires in ${expiryDays} days.`,
      signature,
      graphics: approvalGraphics,
    });
    return NextResponse.json({ preview: true, to: emailList.join(', ') || null, subject, html });
  }

  // Mint a fresh token — rotating on resend invalidates prior links.
  const { token, expiresAt } = generateToken(expiryDays);
  const { error: updErr } = await supabase
    .from('estimates')
    .update({
      approval_token: token,
      approval_token_expires_at: expiresAt,
      sent_for_approval_at: new Date().toISOString(),
      sent_for_approval_by: auth.user.id,
      status: estimate.status === 'draft' ? 'sent' : estimate.status,
      // Clear any prior rejection so the resent link is actionable.
      customer_rejected_at: null,
      customer_rejection_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', estimate.id);
  if (updErr) {
    return NextResponse.json({ error: 'Failed to mint token: ' + updErr.message }, { status: 500 });
  }

  const dispatch: Record<string, any> = { email: null, sms: null };

  if (emailList.length > 0) {
    const link = `${appUrl}/approve/estimate/${token}?via=email&to=${encodeURIComponent(emailList[0])}`;
    // The real estimate document, not a notification card: the old email
    // carried a one-line summary and no quantities, rates, or line totals
    // at all — the fields customers kept asking about.
    const html = renderEstimateDocument(estimate, lineItems || [], {
      company,
      logoUrl,
      message,
      ctaUrl: link,
      ctaLabel: 'Review & Approve',
      ctaNote: `This link expires in ${expiryDays} days.`,
      signature,
      graphics: approvalGraphics,
    });
    const bcc = body.bccSelf && auth.user?.email ? [auth.user.email] : undefined;

    // When linked wrap quotes contribute assets (estimate_attach — coverage
    // diagram, proofs, vinyl details), attach the merged estimate PDF so
    // the customer approves ONE document carrying all of it. Best-effort:
    // a PDF hiccup never blocks the approval email itself.
    let approvalAttachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
    try {
      const { count: attachCount } = await supabase
        .from('wrap_quotes')
        .select('id', { count: 'exact', head: true })
        .eq('estimate_id', estimate.id)
        .not('estimate_attach', 'is', null);
      if ((attachCount || 0) > 0) {
        const { generateEstimatePdf } = await import('@/lib/estimate-pdf-server');
        const pdf = await generateEstimatePdf(supabase, estimate.id);
        if (pdf.ok) {
          approvalAttachments = [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }];
        }
      }
    } catch (err: any) {
      console.warn('[send-for-approval] estimate PDF attach skipped:', err?.message || err);
    }

    try {
      const { ok, id: resendId } = await sendEmailDetailed(
        emailList, subject, html, undefined, approvalAttachments, auth.user?.email || undefined, bcc,
        { kind: 'estimate_approval', sentBy: auth.user?.id, contextUrl: deepLinks.estimate(estimate.id), customerId: estimate.customer_id, netsuiteCustomerId: estimate.customer_netsuite_id },
      );
      dispatch.email = { target: emailList.join(', '), ok, bcc: bcc ? bcc.join(', ') : undefined };
      // Delivery tracking (same scheme as invoice emails): store the Resend
      // message id so the webhook can update this estimate's delivery state,
      // and reset the state for this fresh send. A failed hand-off to Resend
      // is recorded as 'failed' immediately — no webhook will ever come.
      // Best-effort: a logging failure never turns a sent email into an error.
      const { error: trackErr } = await supabase
        .from('estimates')
        .update({
          approval_email_id: ok ? resendId : null,
          approval_email_to: emailList,
          approval_email_status: ok ? 'sent' : 'failed',
          approval_email_detail: ok ? null : 'The email could not be handed to the delivery service',
          approval_email_updated_at: new Date().toISOString(),
        })
        .eq('id', estimate.id);
      if (trackErr) console.error('estimate email tracking update failed:', trackErr.message);
    } catch (err: any) {
      dispatch.email = { target: emailList.join(', '), ok: false, error: err?.message };
    }
  }

  if (phone) {
    const link = `${appUrl}/approve/estimate/${token}?via=sms${phone ? `&to=${encodeURIComponent(phone)}` : ''}`;
    const smsBody = `[BMG Fleet] Estimate #${estimate.estimate_number} ready for approval. ${link}`;
    try {
      const result = await sendSMS(phone, smsBody);
      dispatch.sms = {
        target: phone,
        ok: result.ok,
        skipped: result.skipped || false,
        providerName: result.providerName,
        error: result.error || null,
      };
    } catch (err: any) {
      dispatch.sms = { target: phone, ok: false, error: err?.message };
    }
  }

  return NextResponse.json({
    status: 'sent',
    token,
    expiresAt,
    approvalUrl: `${appUrl}/approve/estimate/${token}`,
    dispatch,
  });
}
