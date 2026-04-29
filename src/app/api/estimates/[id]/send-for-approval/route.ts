import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { generateToken } from '@/lib/magic-link-approval';
import { sendEmail, buildNotificationEmail } from '@/lib/resend';
import { sendSMS } from '@/lib/sms-provider';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const expiryDays = typeof body.expiryDays === 'number' && body.expiryDays > 0 ? body.expiryDays : 30;

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

  if (!email && !phone) {
    return NextResponse.json({ error: 'No email or phone on file for this customer. Add a contact first.' }, { status: 400 });
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
      updated_at: new Date().toISOString(),
    })
    .eq('id', estimate.id);
  if (updErr) {
    return NextResponse.json({ error: 'Failed to mint token: ' + updErr.message }, { status: 500 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const subject = `[BMG Fleet] Estimate #${estimate.estimate_number} — Ready for your approval`;

  const dispatch: Record<string, any> = { email: null, sms: null };

  if (email) {
    const link = `${appUrl}/approve/estimate/${token}?via=email${email ? `&to=${encodeURIComponent(email)}` : ''}`;
    const body =
      `Estimate #${estimate.estimate_number}${estimate.title ? ` — ${estimate.title}` : ''}` +
      ` for ${estimate.customer_name || 'you'}. Total: $${Number(estimate.grand_total || 0).toFixed(2)}.` +
      ` Review and approve using the button below. Link expires in ${expiryDays} days.`;
    const html = buildNotificationEmail(subject.replace('[BMG Fleet] ', ''), body, link, 'Review & Approve');
    try {
      const ok = await sendEmail(email, subject, html);
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
