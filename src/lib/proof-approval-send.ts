/**
 * Proof-approval link dispatch, shared by the manual send route and the
 * daily reminder cron. Manual sends mint a fresh token, stamp
 * sent_for_approval_at, and go out via email + SMS. Reminder sends mint a
 * fresh token too (the emailed link must work even if the original
 * expired) but keep the original send stamps — sent_for_approval_at is
 * the aging anchor — and go email-only with reminder copy.
 *
 * Manual sends follow the customer-email compose standard
 * (docs/customer-email-standard.md): multiple recipients, a personal
 * message, bcc, file attachments pulled from the job's files, and a
 * preview mode that renders the exact email without minting or sending.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { generateToken } from './magic-link-approval';
import { sendEmail, buildNotificationEmail } from './resend';
import { deepLinks } from './deep-links';
import { sendSMS } from './sms-provider';
import { r2Get } from './r2';

type Service = SupabaseClient<any, any, any>;

const FILE_BUCKET_PREFIX = 'graphics-proofs';

// Total attachment budget per email. Resend caps messages at 40MB, but
// plenty of corporate inboxes bounce well before that — 20MB is the safe
// ceiling, enforced against declared sizes up front and actual bytes after
// fetching (upload rows can carry a null file_size).
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface SendProofOptions {
  /** Staff user who triggered a manual send; null for the cron. */
  actorId?: string | null;
  /** Email of that staff user — becomes the Reply-To so customer replies
   *  reach them; null for the cron (falls back to RESEND_REPLY_TO_EMAIL). */
  actorEmail?: string | null;
  /** Single-recipient override (legacy callers). Prefer `emails`. */
  email?: string | null;
  /** Standard-compose recipients; overrides the customer-contact lookup. */
  emails?: string[] | null;
  /** Bcc addresses for the customer email (e.g. the sender's own inbox). */
  bcc?: string[] | null;
  /** Personal note rendered at the top of the email. */
  message?: string | null;
  phone?: string | null;
  proofFileId?: string | null;
  /** graphics_job_files ids to attach to the email itself. */
  attachmentFileIds?: string[] | null;
  expiryDays?: number;
  /** Reminder mode: keep original send stamps, email only, reminder copy. */
  reminder?: boolean;
  /** Render the exact email (to/subject/html) without minting or sending. */
  preview?: boolean;
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
  preview?: { to: string | null; subject: string; html: string };
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function sendProofApproval(
  service: Service,
  jobId: string,
  opts: SendProofOptions = {},
): Promise<SendProofResult> {
  const expiryDays = opts.expiryDays ?? 30;
  const reminder = !!opts.reminder;
  const previewOnly = !!opts.preview;
  const message = opts.message?.trim() || undefined;

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

  // Attachments must belong to this job, and their declared sizes must fit
  // the budget — a mismatch is a hard error, never a silent drop.
  const attachmentFileIds = [...new Set((opts.attachmentFileIds || []).filter(Boolean))];
  let attachmentRows: { id: string; file_name: string; file_size: number | null; file_type: string | null; storage_path: string }[] = [];
  if (!reminder && attachmentFileIds.length > 0) {
    const { data: rows } = await service
      .from('graphics_job_files')
      .select('id, file_name, file_size, file_type, storage_path')
      .in('id', attachmentFileIds)
      .eq('job_id', job.id);
    attachmentRows = rows || [];
    if (attachmentRows.length !== attachmentFileIds.length) {
      return { ok: false, status: 400, error: 'Some selected attachments do not belong to this job.' };
    }
    // Keep the sender's selection order.
    attachmentRows.sort((a, b) => attachmentFileIds.indexOf(a.id) - attachmentFileIds.indexOf(b.id));
    const declaredTotal = attachmentRows.reduce((sum, r) => sum + (r.file_size || 0), 0);
    if (declaredTotal > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false, status: 400,
        error: `Attachments total ${(declaredTotal / (1024 * 1024)).toFixed(1)}MB — the limit is ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB. Deselect some files.`,
      };
    }
  }

  let emailList: string[] = (opts.emails || []).map(e => e.trim()).filter(Boolean);
  if (emailList.length === 0 && opts.email) emailList = [opts.email];
  let phone: string | null = opts.phone || null;

  if ((emailList.length === 0 || !phone) && job.customer) {
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
      const resolvedEmail = primary?.email || customer.email || null;
      if (emailList.length === 0 && resolvedEmail) emailList = [resolvedEmail];
      phone = phone || primary?.phone || customer.phone || null;
    }
  }

  if (!previewOnly) {
    if (reminder && emailList.length === 0) return { ok: false, status: 400, error: 'No email on file for this customer.' };
    if (emailList.length === 0 && !phone) return { ok: false, status: 400, error: 'No email or phone on file for this customer.' };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const label = job.title || job.job_number || `Job ${jobId.slice(0, 8)}`;
  const subject = reminder
    ? `[BMG Fleet] Reminder: proof awaiting your approval — ${label}`
    : `[BMG Fleet] Proof ready for approval — ${label}`;
  const emailTitle = reminder
    ? `Reminder: proof awaiting approval — ${label}`
    : `Proof ready for approval — ${label}`;
  const emailBody = reminder
    ? `Just a reminder — your graphic proof for ${label} is still waiting on your review. Production can't move forward until it's approved. Approve or request changes with the button below (this fresh link expires in ${expiryDays} days).`
    : `Your graphic proof is ready for review — ${label}. Approve or request changes using the button below. Link expires in ${expiryDays} days.`;
  const emailOpts = {
    note: message,
    attachmentNames: attachmentRows.map(r => r.file_name),
  };

  // Preview: the exact email that would go out, with a placeholder CTA —
  // the real link is minted on send. No token, no stamps, no dispatch.
  if (previewOnly) {
    const html = buildNotificationEmail(emailTitle, emailBody, `${appUrl}/approve/proof/`, 'Review Proof', {
      ...emailOpts,
      ctaNote: 'A unique, secure link is generated when you send.',
    });
    return { ok: true, preview: { to: emailList.join(', ') || null, subject, html } };
  }

  // Pull attachment bytes before minting anything — a failed fetch must not
  // rotate the token or stamp the job as sent.
  const emailAttachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  if (emailList.length > 0 && attachmentRows.length > 0) {
    let fetchedTotal = 0;
    for (const row of attachmentRows) {
      const result = await r2Get(FILE_BUCKET_PREFIX, row.storage_path);
      if (!result.success || !result.body) {
        return { ok: false, status: 502, error: `Could not fetch attachment "${row.file_name}" from storage: ${result.error || 'unknown error'}` };
      }
      const content = await streamToBuffer(result.body);
      fetchedTotal += content.byteLength;
      if (fetchedTotal > MAX_ATTACHMENT_BYTES) {
        return {
          ok: false, status: 400,
          error: `Attachments exceed the ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit ("${row.file_name}" pushed it over). Deselect some files.`,
        };
      }
      emailAttachments.push({
        filename: row.file_name,
        content,
        contentType: row.file_type || result.contentType || undefined,
      });
    }
  }

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

  const dispatch: Record<string, any> = { email: null, sms: null };

  if (emailList.length > 0) {
    const link = `${appUrl}/approve/proof/${token}?via=email&to=${encodeURIComponent(emailList[0])}`;
    const html = buildNotificationEmail(emailTitle, emailBody, link, 'Review Proof', {
      ...emailOpts,
      ctaNote: `This link expires in ${expiryDays} days.`,
    });
    const bcc = (opts.bcc || []).map(e => e.trim()).filter(Boolean);
    try {
      const ok = await sendEmail(
        emailList, subject, html, undefined,
        emailAttachments.length > 0 ? emailAttachments : undefined,
        opts.actorEmail || undefined,
        bcc.length > 0 ? bcc : undefined,
        { kind: 'proof_approval', sentBy: opts.actorId || null, contextUrl: deepLinks.graphicsJob(jobId) },
      );
      dispatch.email = { target: emailList.join(', '), ok, attachments: emailAttachments.length, bcc: bcc.length > 0 ? bcc.join(', ') : undefined };
    } catch (err: any) {
      dispatch.email = { target: emailList.join(', '), ok: false, error: err?.message };
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
