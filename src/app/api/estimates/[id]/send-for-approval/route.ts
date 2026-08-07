import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { generateToken } from '@/lib/magic-link-approval';
import { sendEmail } from '@/lib/resend';
import { sendSMS } from '@/lib/sms-provider';
import { renderEstimateDocument } from '@/lib/estimate-document';
import { r2PublicUrl } from '@/lib/r2';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SendForApprovalSchema = z.object({
  email: z.string().email().max(254).optional().nullable(),
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
    .select('*')
    .eq('id', params.id)
    .single();
  if (eErr || !estimate) {
    return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  }
  if (estimate.customer_approved) {
    return NextResponse.json({ error: 'Already approved' }, { status: 409 });
  }

  // Resolve delivery targets
  let email: string | null = body.email || null;
  let phone: string | null = body.phone || null;

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

  if (!email && !phone && !body.preview) {
    return NextResponse.json({ error: 'No email or phone on file for this customer. Add a contact first.' }, { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const subject = `[BMG Fleet] Estimate #${estimate.estimate_number} — Ready for your approval`;
  const message = body.message?.trim() || undefined;

  // The customer-facing document — line items, quantities, rates, totals —
  // loaded once for both the preview and the real send.
  const { data: lineItems } = await supabase
    .from('estimate_line_items')
    .select('*')
    .eq('estimate_id', estimate.id)
    .order('sort_order')
    .order('id');
  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || {};
  const logoUrl = company?.logo_path ? r2PublicUrl('vehicle-templates', company.logo_path) : null;

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
    });
    return NextResponse.json({ preview: true, to: email, subject, html });
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

  if (email) {
    const link = `${appUrl}/approve/estimate/${token}?via=email${email ? `&to=${encodeURIComponent(email)}` : ''}`;
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
    });
    try {
      const ok = await sendEmail(email, subject, html, undefined, undefined, auth.user?.email || undefined);
      dispatch.email = { target: email, ok };
    } catch (err: any) {
      dispatch.email = { target: email, ok: false, error: err?.message };
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
