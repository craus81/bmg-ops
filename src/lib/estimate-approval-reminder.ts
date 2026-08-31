/**
 * Automated customer reminder for a sent-but-unanswered estimate (Stage 3
 * finding: proofs auto-remind ×3 + escalate; estimates relied on the rep
 * remembering). Called by the daily quote-followup cron.
 *
 * Deliberately NOT the compose-screen flow (docs/customer-email-standard.md
 * covers staff-initiated email): this is machine-initiated, same as the
 * proof reminder, and goes to the exact recipients the original approval
 * email went to (estimates.approval_email_to). No recipients → skipped.
 *
 * Unlike proofs (which mint a fresh token per reminder), the LIVE token is
 * reused: reminders all fire well inside the 30-day token life, and reuse
 * keeps every previously emailed link working. Expired or missing token →
 * skipped; the cron still escalates internally so a human follows up.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmailDetailed } from './resend';
import { deepLinks } from './deep-links';

type Service = SupabaseClient<any, any, any>;

export interface EstimateReminderRow {
  id: string;
  estimate_number: string;
  title: string | null;
  customer_name: string | null;
  customer_id: string | null;
  customer_netsuite_id: string | null;
  grand_total: number | null;
  sent_for_approval_at: string | null;
  approval_email_to: string[] | null;
  approval_token: string | null;
  approval_token_expires_at: string | null;
  approval_reminder_count: number | null;
}

export interface ReminderResult { ok: boolean; skipped?: boolean; error?: string }

export async function sendEstimateApprovalReminder(service: Service, est: EstimateReminderRow): Promise<ReminderResult> {
  const emails = (est.approval_email_to || []).filter(Boolean);
  if (emails.length === 0) return { ok: false, skipped: true, error: 'no email on file' };
  if (!est.approval_token) return { ok: false, skipped: true, error: 'no live approval link' };
  if (!est.approval_token_expires_at || new Date(est.approval_token_expires_at).getTime() < Date.now()) {
    return { ok: false, skipped: true, error: 'approval link expired' };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const link = `${appUrl}/approve/estimate/${est.approval_token}?via=email&to=${encodeURIComponent(emails[0])}`;
  const total = est.grand_total != null
    ? `$${Number(est.grand_total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;
  const sentOn = est.sent_for_approval_at
    ? new Date(est.sent_for_approval_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    : null;
  const label = `Estimate #${est.estimate_number}${est.title ? ` — ${est.title}` : ''}`;

  const subject = `[BMG Fleet] Reminder — ${label} is awaiting your approval`;
  const text = [
    `Hi${est.customer_name ? ` ${est.customer_name}` : ''},`,
    '',
    `Just a friendly reminder that ${label}${total ? ` (${total})` : ''}${sentOn ? `, sent on ${sentOn},` : ''} is still awaiting your review.`,
    '',
    `Review and approve here: ${link}`,
    '',
    'If you have questions or would like changes, just reply to the original estimate email and we’ll take care of it.',
    '',
    '— BMG Fleet',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#1f2937;">
      <p style="margin:0 0 14px;">Hi${est.customer_name ? ` ${escapeHtml(est.customer_name)}` : ''},</p>
      <p style="margin:0 0 18px;line-height:1.5;">Just a friendly reminder that <strong>${escapeHtml(label)}</strong>${total ? ` (<strong>${total}</strong>)` : ''}${sentOn ? `, sent on ${sentOn},` : ''} is still awaiting your review.</p>
      <p style="margin:0 0 22px;">
        <a href="${link}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;">Review &amp; Approve</a>
      </p>
      <p style="margin:0 0 6px;font-size:13px;color:#6b7280;line-height:1.5;">If you have questions or would like changes, just reply to the original estimate email and we&rsquo;ll take care of it.</p>
      <p style="margin:14px 0 0;font-size:13px;color:#6b7280;">&mdash; BMG Fleet</p>
    </div>`;

  const { ok, id: resendId } = await sendEmailDetailed(
    emails, subject, html, text, undefined, undefined, undefined,
    { kind: 'estimate_approval_reminder', contextUrl: deepLinks.estimate(est.id), customerId: est.customer_id, netsuiteCustomerId: est.customer_netsuite_id },
  );

  // Bookkeeping + delivery tracking (same webhook scheme as the original
  // send, so a bounced reminder surfaces in the builder's email banner).
  // The reminder clock only advances on a successful hand-off — a failed
  // send retries tomorrow and records 'failed' where staff can see it.
  await service.from('estimates').update({
    ...(ok ? {
      approval_reminder_sent_at: new Date().toISOString(),
      approval_reminder_count: (est.approval_reminder_count || 0) + 1,
    } : {}),
    approval_email_id: ok ? resendId : null,
    approval_email_status: ok ? 'sent' : 'failed',
    approval_email_detail: ok ? null : 'The reminder email could not be handed to the delivery service',
    approval_email_updated_at: new Date().toISOString(),
  }).eq('id', est.id);

  return ok ? { ok: true } : { ok: false, error: 'send failed' };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
