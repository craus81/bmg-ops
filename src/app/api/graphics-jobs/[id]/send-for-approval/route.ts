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
 * POST /api/graphics-jobs/[id]/send-for-approval
 * Mints a 30-day token + dispatches proof approval link via email + SMS.
 * Body: { proofFileId, email?, phone?, expiryDays? }. proofFileId selects
 * which graphics_job_files row the customer sees on the public approval
 * page. Email/phone overrides; otherwise resolves via the customer's
 * primary external_contact / synced customer row.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const expiryDays = typeof body.expiryDays === 'number' && body.expiryDays > 0 ? body.expiryDays : 30;
  const proofFileId: string | null = typeof body.proofFileId === 'string' ? body.proofFileId : null;

  const { data: job, error } = await supabase
    .from('graphics_jobs')
    .select('id, job_number, title, customer, customer_approved, status')
    .eq('id', params.id)
    .single();
  if (error || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.customer_approved) return NextResponse.json({ error: 'Already approved' }, { status: 409 });

  // Validate proofFileId belongs to the job (if provided). If omitted, the
  // approval page falls back to showing every attached file — kept for
  // backward compat with existing callers.
  if (proofFileId) {
    const { data: file } = await supabase
      .from('graphics_job_files')
      .select('id')
      .eq('id', proofFileId)
      .eq('job_id', job.id)
      .maybeSingle();
    if (!file) {
      return NextResponse.json({ error: 'Selected proof file does not belong to this job.' }, { status: 400 });
    }
  }

  let email: string | null = body.email || null;
  let phone: string | null = body.phone || null;

  if ((!email || !phone) && job.customer) {
    const { data: customer } = await supabase
      .from('customers')
      .select('id, email, phone')
      .ilike('company_name', job.customer)
      .maybeSingle();
    if (customer) {
      const { data: primary } = await supabase
        .from('external_contacts')
        .select('email, phone')
        .eq('customer_id', customer.id)
        .eq('is_primary', true)
        .maybeSingle();
      if (primary) {
        email = email || primary.email;
        phone = phone || primary.phone;
      }
      email = email || customer.email;
      phone = phone || customer.phone;
    }
  }

  if (!email && !phone) {
    return NextResponse.json({ error: 'No email or phone on file for this customer.' }, { status: 400 });
  }

  const { token, expiresAt } = generateToken(expiryDays);
  const { error: updErr } = await supabase
    .from('graphics_jobs')
    .update({
      approval_token: token,
      approval_token_expires_at: expiresAt,
      approval_proof_file_id: proofFileId,
      sent_for_approval_at: new Date().toISOString(),
      sent_for_approval_by: auth.user.id,
      // Clear any prior rejection so the resent link is actionable.
      customer_rejected_at: null,
      customer_rejection_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const label = job.title || job.job_number || `Job ${params.id.slice(0, 8)}`;
  const dispatch: Record<string, any> = { email: null, sms: null };

  if (email) {
    const link = `${appUrl}/approve/proof/${token}?via=email&to=${encodeURIComponent(email)}`;
    const emailBody = `Your graphic proof is ready for review — ${label}. Approve or request changes using the button below. Link expires in ${expiryDays} days.`;
    const html = buildNotificationEmail(`Proof ready for approval — ${label}`, emailBody, link, 'Review Proof');
    try {
      const ok = await sendEmail(email, `[BMG Fleet] Proof ready for approval — ${label}`, html);
      dispatch.email = { target: email, ok };
    } catch (err: any) {
      dispatch.email = { target: email, ok: false, error: err?.message };
    }
  }

  if (phone) {
    const link = `${appUrl}/approve/proof/${token}?via=sms&to=${encodeURIComponent(phone)}`;
    const smsBody = `[BMG Fleet] Your graphic proof is ready for review: ${link}`;
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
    approvalUrl: `${appUrl}/approve/proof/${token}`,
    dispatch,
  });
}
