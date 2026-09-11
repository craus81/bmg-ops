/**
 * The one pre-expiry warning email (R6-9), for estimates AND wrap quotes.
 *
 * ONE template on purpose: the two quote types already have separate send
 * routes, separate PDF builders and separate reminder paths, and a second
 * copy of this message would drift from the first within a round.
 *
 * Machine-initiated, so docs/customer-email-standard.md (the staff compose
 * screen) does not apply — same footing as the existing approval reminder.
 * It goes only to the addresses the quote was already sent to; this is never
 * a chance to reach someone new.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmailDetailed } from './resend';
import { deepLinks } from './deep-links';
import { expiryDateText, daysUntilExpiry } from './quote-expiry';
import { filterRecipients, indexContactsByEmail } from './notification-prefs';

export interface ExpiringQuote {
  kind: 'estimate' | 'wrap';
  id: string;
  number: string;
  /** What the customer sees in the subject: "Estimate #1042 — 6 vans". */
  label: string;
  customerName: string | null;
  total: number | null;
  token: string | null;
  expiresAt: string | null;
  emails: string[];
  customerId?: string | null;
  netsuiteCustomerId?: string | null;
}

export interface ExpiryEmailResult { ok: boolean; skipped?: boolean; error?: string }

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Recipients who still want estimate reminders. No customers row to
 *  consult → keep everyone; missing data is not an opt-out. */
async function allowedRecipients(
  service: SupabaseClient,
  customerId: string | null,
  addressed: string[],
): Promise<string[]> {
  if (!customerId) return addressed;
  const { data: customer } = await service
    .from('customers').select('notify_estimate_reminders').eq('id', customerId).maybeSingle();
  const { data: contacts } = await service
    .from('external_contacts').select('email, notify_estimate_reminders').eq('customer_id', customerId);
  return filterRecipients('estimate_reminders', addressed, customer, indexContactsByEmail(contacts || []));
}

export async function sendQuoteExpiryWarning(
  service: SupabaseClient,
  q: ExpiringQuote,
): Promise<ExpiryEmailResult> {
  const addressed = (q.emails || []).map(e => String(e).trim()).filter(Boolean);
  if (addressed.length === 0) return { ok: false, skipped: true, error: 'no email on file' };
  // Same preference as the approval reminder (migration 306): an expiry
  // warning IS a reminder about an estimate awaiting approval, so a
  // customer who turned those off must not keep receiving these — that
  // would make the toggle a half-truth.
  const emails = await allowedRecipients(service, q.customerId || null, addressed);
  if (emails.length === 0) return { ok: false, skipped: true, error: 'all recipients opted out of estimate reminders' };
  if (!q.token) return { ok: false, skipped: true, error: 'no live approval link' };
  const days = daysUntilExpiry(q.expiresAt);
  // Belt and braces: the sweep already checks this, but a warning that says
  // "expires soon" about a dead link is the one thing this email must never
  // send.
  if (days == null || days < 0) return { ok: false, skipped: true, error: 'approval link already expired' };

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app').replace(/\/$/, '');
  const path = q.kind === 'estimate' ? 'estimate' : 'quote';
  const link = `${appUrl}/approve/${path}/${q.token}?via=email&to=${encodeURIComponent(emails[0])}`;

  const dateText = expiryDateText(q.expiresAt);
  const whenPhrase = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  const total = q.total != null && q.total > 0
    ? `$${Number(q.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;

  const subject = `[BMG Fleet] ${q.label} expires ${whenPhrase}`;
  const opening = `Your approval link for ${q.label}${total ? ` (${total})` : ''} expires ${whenPhrase}`
    + `${dateText ? ` — ${dateText}` : ''}.`;
  const closing = 'If you still want to go ahead after that, just reply and we will send a fresh link — '
    + 'pricing may need a quick re-check by then.';

  const text = [
    `Hi${q.customerName ? ` ${q.customerName}` : ''},`,
    '',
    opening,
    '',
    `Review and approve here: ${link}`,
    '',
    closing,
    '',
    '— BMG Fleet',
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#1f2937;">
      <p style="margin:0 0 14px;">Hi${q.customerName ? ` ${escapeHtml(q.customerName)}` : ''},</p>
      <p style="margin:0 0 18px;line-height:1.5;">Your approval link for <strong>${escapeHtml(q.label)}</strong>${total ? ` (<strong>${total}</strong>)` : ''} expires <strong>${whenPhrase}</strong>${dateText ? ` &mdash; ${escapeHtml(dateText)}` : ''}.</p>
      <p style="margin:0 0 22px;">
        <a href="${link}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;">Review &amp; Approve</a>
      </p>
      <p style="margin:0 0 6px;font-size:13px;color:#6b7280;line-height:1.5;">${escapeHtml(closing)}</p>
      <p style="margin:14px 0 0;font-size:13px;color:#6b7280;">&mdash; BMG Fleet</p>
    </div>`;

  const contextUrl = q.kind === 'estimate' ? deepLinks.estimate(q.id) : deepLinks.wrapQuote(q.id);
  const { ok, id: resendId } = await sendEmailDetailed(
    emails, subject, html, text, undefined, undefined, undefined,
    {
      kind: q.kind === 'estimate' ? 'estimate_expiry_warning' : 'wrap_quote_expiry_warning',
      contextUrl,
      customerId: q.customerId || undefined,
      netsuiteCustomerId: q.netsuiteCustomerId || undefined,
    },
  );

  if (q.kind === 'estimate') {
    // Same delivery-tracking columns the approval send and reminder write, so
    // a bounced warning surfaces in the builder's email banner rather than
    // being lost. wrap_quotes has no equivalent columns, so a wrap warning is
    // send-and-forget until it does.
    await service.from('estimates').update({
      approval_email_id: ok ? resendId : null,
      approval_email_status: ok ? 'sent' : 'failed',
      approval_email_detail: ok ? null : 'The expiry warning email could not be handed to the delivery service',
      approval_email_updated_at: new Date().toISOString(),
    }).eq('id', q.id);
  }

  return ok ? { ok: true } : { ok: false, error: 'send failed' };
}
