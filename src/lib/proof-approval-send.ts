/**
 * Proof-approval link dispatch, shared by the manual send route and the
 * daily reminder cron. Manual sends mint a fresh token, stamp
 * sent_for_approval_at, and go out via email + SMS. Reminder sends mint a
 * fresh token too (the emailed link must work even if the original
 * expired) but keep the original send stamps — sent_for_approval_at is
 * the aging anchor — and go email-only with reminder copy.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { generateToken } from './magic-link-approval';
import { sendEmail, buildNotificationEmail } from './resend';
import { sendSMS } from './sms-provider';

type Service = SupabaseClient<any, any, any>;

export interface SendProofOptions {
  /** Staff user who triggered a manual send; null for the cron. */
  actorId?: string | null;
  /** Email of that staff user — becomes the Reply-To so customer replies
   *  reach them; null for the cron (falls back to RESEND_REPLY_TO_EMAIL). */
  actorEmail?: string | null;
  email?: string | null;
  phone?: string | null;
  proofFileId?: string | null;
  expiryDays?: number;
  /** Reminder mode: keep original send stamps, email only, reminder copy. */
  reminder?: boolean;
}

export interface SendProofResult {
  ok: boolean;
  status?: number;
  /** True when the send was intentionally not made (e.g. customer not
   *  subscribed to automatic reminders) — not a failure. */
  skipped?: boolean;
  error?: string;
  token?: string;
  expiresAt?: string;
  approvalUrl?: string;
  dispatch?: Record<string, any>;
}

export async function sendProofApproval(
  service: Service,
  jobId: string,
  opts: SendProofOptions = {},
): Promise<SendProofResult> {
  const expiryDays = opts.expiryDays ?? 30;
  const reminder = !!opts.reminder;

  const { data: job, error } = await service
    .from('graphics_jobs')
    .select('id, job_number, title, customer, customer_approved, status, approval_proof_file_id, approval_reminder_count')
    .eq('id', jobId)
    .single();
  if (error || !job) return { ok: false, status: 404, error: 'Job not found' };
  if (job.customer_approved) return { ok: false, status: 409, error: 'Already approved' };

  // Reminders re-show whatever file the original send selected.
  const proofFileId = reminder ? job.approval_proof_file_id : (opts.proofFileId ?? null);
  if (!reminder && proofFileId) {
    const { data: file } = await service
      .from('graphics_job_files')
      .select('id')
      .eq('id', proofFileId)
      .eq('job_id', job.id)
      .maybeSingle();
    if (!file) return { ok: false, status: 400, error: 'Selected proof file does not belong to this job.' };
  }

  let email: string | null = opts.email || null;
  let phone: string | null = opts.phone || null;

  if ((!email || !phone) && job.customer) {
    const { data: customer } = await service
      .from('customers')
      .select('id, email, phone, notify_status_emails')
      .ilike('company_name', job.customer)
      .maybeSingle();
    // Automatic reminders are opt-in per customer (migration 171): the
    // original staff-clicked send always goes out, but the cron's quiet-
    // period nudges only reach customers subscribed to automatic emails.
    if (reminder && customer && customer.notify_status_emails !== true) {
      return { ok: false, skipped: true, status: 200, error: 'Customer not subscribed to automatic reminders' };
    }
    if (customer) {
      const { data: primary } = await service
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

  if (reminder && !email) return { ok: false, status: 400, error: 'No email on file for this customer.' };
  if (!email && !phone) return { ok: false, status: 400, error: 'No email or phone on file for this customer.' };

  const { token, expiresAt } = generateToken(expiryDays);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    approval_token: token,
    approval_token_expires_at: expiresAt,
    updated_at: now,
  };
  if (reminder) {
    patch.approval_reminder_sent_at = now;
    patch.approval_reminder_count = (job.approval_reminder_count || 0) + 1;
  } else {
    patch.approval_proof_file_id = proofFileId;
    patch.sent_for_approval_at = now;
    patch.sent_for_approval_by = opts.actorId ?? null;
    // Clear any prior rejection so the resent link is actionable, and reset
    // the reminder cycle — a fresh send restarts the clock.
    patch.customer_rejected_at = null;
    patch.customer_rejection_reason = null;
    patch.approval_reminder_sent_at = null;
    patch.approval_reminder_count = 0;
    patch.approval_escalated_at = null;
  }
  const { error: updErr } = await service.from('graphics_jobs').update(patch).eq('id', job.id);
  if (updErr) return { ok: false, status: 500, error: updErr.message };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const label = job.title || job.job_number || `Job ${jobId.slice(0, 8)}`;
  const dispatch: Record<string, any> = { email: null, sms: null };

  if (email) {
    const link = `${appUrl}/approve/proof/${token}?via=email&to=${encodeURIComponent(email)}`;
    const subject = reminder
      ? `[BMG Fleet] Reminder: proof awaiting your approval — ${label}`
      : `[BMG Fleet] Proof ready for approval — ${label}`;
    const emailBody = reminder
      ? `Just a reminder — your graphic proof for ${label} is still waiting on your review. Production can't move forward until it's approved. Approve or request changes with the button below (this fresh link expires in ${expiryDays} days).`
      : `Your graphic proof is ready for review — ${label}. Approve or request changes using the button below. Link expires in ${expiryDays} days.`;
    const html = buildNotificationEmail(
      reminder ? `Reminder: proof awaiting approval — ${label}` : `Proof ready for approval — ${label}`,
      emailBody, link, 'Review Proof',
    );
    try {
      const ok = await sendEmail(email, subject, html, undefined, undefined, opts.actorEmail || undefined);
      dispatch.email = { target: email, ok };
    } catch (err: any) {
      dispatch.email = { target: email, ok: false, error: err?.message };
    }
  }

  if (phone && !reminder) {
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

  return {
    ok: true,
    token,
    expiresAt,
    approvalUrl: `${appUrl}/approve/proof/${token}`,
    dispatch,
  };
}
