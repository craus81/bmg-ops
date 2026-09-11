/**
 * "Send me a fresh link" — the customer's way out of an expired approval
 * link (R6-11), replacing a dead end that could only be fixed by a staff
 * member noticing and re-sending.
 *
 * Three rules shape all of it:
 *
 * 1. THE LINK IS NEVER SHOWN IN-PAGE. A new token is minted and emailed to
 *    the address already on file; the page only ever learns a masked
 *    destination. The approval link's whole security model is that it
 *    reached a mailbox we already associate with this customer — printing
 *    it on a page anyone holding the portal link can open would quietly
 *    drop that, and the portal link gets forwarded (the page says as much).
 *
 * 2. A CHANGED ESTIMATE IS NOT SELF-SERVE. estimates carry
 *    approval_sent_hash, a fingerprint of the items and money the customer
 *    was actually sent. If the estimate has been edited since, re-minting
 *    would hand them a link to a DIFFERENT quote under the old invitation.
 *    Those go to the rep instead — a re-quote is a decision, and the real
 *    send route has the margin-floor governance that this path does not.
 *    Wrap quotes have no such fingerprint, so the same check is impossible
 *    there; that asymmetry is stated rather than papered over.
 *
 * 3. IT COUNTS SEPARATELY FROM OUR CHASES. approval_reminder_count means
 *    "times we chased them" and caps the reminder cron at 3; a customer
 *    asking for their own link back is not that. Migration 305 gives the
 *    request its own stamp and counter.
 *
 * Machine-initiated, so docs/customer-email-standard.md (the staff compose
 * screen) does not apply — same footing as the approval reminder and the
 * expiry warning, and like both, it can only reach addresses already on
 * the record. The requester supplies a record id and nothing else.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { generateToken, approvalContentHash } from './magic-link-approval';
import { sendEmailDetailed } from './resend';
import { deepLinks } from './deep-links';
import { resolveEstimateEmail } from './estimate-recipients';
import { sendProofApproval } from './proof-approval-send';
import { tokenLive } from './portal-actions';

type Service = SupabaseClient<any, any, any>;

export type RelinkKind = 'estimate' | 'quote' | 'proof';

/** Minutes between fresh-link requests for the SAME record. The portal
 *  link is shared across a purchasing team; without this, one bored
 *  click-through mails the approval contact all afternoon. */
export const RELINK_COOLDOWN_MINUTES = 15;
/** A fresh link is short — it is a second chance at a decision already
 *  overdue, not a new 30-day window to sit on. */
export const RELINK_EXPIRY_DAYS = 14;

export type RelinkOutcome =
  /** Minted and emailed. */
  | 'sent'
  /** Deliberately not self-served — the rep was told instead. */
  | 'referred_to_rep'
  /** Nothing to do: the link already works. */
  | 'already_live'
  /** Asked again too soon; the earlier email is already on its way. */
  | 'cooldown'
  /** No address on file, so there is nowhere honest to send it. */
  | 'no_recipient'
  | 'not_found'
  | 'error';

export interface RelinkResult {
  outcome: RelinkOutcome;
  /** What the page may say about where it went. Never the link itself. */
  maskedTo?: string | null;
  /** Customer-facing sentence — every outcome gets a true one. */
  message: string;
  /** Record label for the rep notification ("Estimate #EST-2609-014"). */
  label?: string;
}

/**
 * "jordan@acmefleet.com" → "jo•••@acmefleet.com". Enough for the requester
 * to recognise their own mailbox, not enough to learn an address they did
 * not already know.
 */
export function maskEmail(address: string): string {
  const raw = String(address || '').trim();
  const at = raw.lastIndexOf('@');
  if (at <= 0) return '•••';
  const local = raw.slice(0, at);
  const domain = raw.slice(at);
  if (local.length <= 2) return `${local[0] || ''}•••${domain}`;
  return `${local.slice(0, 2)}•••${domain}`;
}

/** How the page describes one or several destinations. */
export function maskedDestination(emails: string[]): string {
  // Trim BEFORE filtering: a whitespace-only cell is truthy, and letting
  // one through would print a masked address for a destination that does
  // not exist — "on its way to  •••" about an email nobody will receive.
  const list = emails.map(e => String(e ?? '').trim()).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return maskEmail(list[0]);
  return `${maskEmail(list[0])} and ${list.length - 1} other${list.length > 2 ? 's' : ''}`;
}

/** Still inside the per-record cooldown? */
export function inCooldown(lastAt: unknown, now = Date.now()): boolean {
  if (!lastAt) return false;
  const t = Date.parse(String(lastAt));
  if (!Number.isFinite(t)) return false;
  return now - t < RELINK_COOLDOWN_MINUTES * 60_000;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface RelinkEmailInput {
  kind: RelinkKind;
  label: string;
  customerName: string | null;
  token: string;
  emails: string[];
  expiryDays: number;
}

/** One template for all three kinds — the message is identical and three
 *  copies would drift apart within a round (the expiry-warning lesson). */
export function buildRelinkEmail(input: RelinkEmailInput): { subject: string; html: string; text: string } {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app').replace(/\/$/, '');
  const path = input.kind === 'estimate'
    ? deepLinks.approveEstimate(input.token)
    : input.kind === 'quote'
      ? deepLinks.approveQuote(input.token)
      : deepLinks.approveProof(input.token);
  const link = `${appUrl}${path}?via=email&to=${encodeURIComponent(input.emails[0])}`;
  const verb = input.kind === 'proof' ? 'review your artwork' : 'approve';
  const cta = input.kind === 'proof' ? 'Review Proof' : 'Review &amp; Approve';

  const subject = `[BMG Fleet] Your fresh link for ${input.label}`;
  const opening = `Here is a new link for ${input.label} — the previous one had expired.`;
  const closing = `This link works for ${input.expiryDays} days. `
    + 'If you did not ask for it, you can ignore this email; the old link stays expired either way.';

  const text = [
    `Hi${input.customerName ? ` ${input.customerName}` : ''},`,
    '',
    opening,
    '',
    `You can ${verb} here: ${link}`,
    '',
    closing,
    '',
    '— BMG Fleet',
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#1f2937;">
      <p style="margin:0 0 14px;">Hi${input.customerName ? ` ${escapeHtml(input.customerName)}` : ''},</p>
      <p style="margin:0 0 18px;line-height:1.5;">Here is a new link for <strong>${escapeHtml(input.label)}</strong> &mdash; the previous one had expired.</p>
      <p style="margin:0 0 22px;">
        <a href="${link}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;">${cta}</a>
      </p>
      <p style="margin:0 0 6px;font-size:13px;color:#6b7280;line-height:1.5;">${escapeHtml(closing)}</p>
      <p style="margin:14px 0 0;font-size:13px;color:#6b7280;">&mdash; BMG Fleet</p>
    </div>`;

  return { subject, html, text };
}

/** The customer's approval contact on file, by id: primary external
 *  contact first, then the customer record's own address. Never anything
 *  the requester supplied. */
async function contactEmailsFor(service: Service, customerId: string): Promise<string[]> {
  const { data: customer } = await service
    .from('customers')
    .select('id, email')
    .eq('id', customerId)
    .maybeSingle();
  const { data: primary } = await service
    .from('external_contacts')
    .select('email')
    .eq('customer_id', customerId)
    .eq('is_primary', true)
    .maybeSingle();
  const list = [primary?.email, customer?.email].map(e => String(e ?? '').trim()).filter(Boolean);
  return [...new Set(list)];
}

/** Recipients for an estimate relink: exactly where the original went,
 *  falling back to the customer's contact on file. Both are addresses the
 *  record already carries — never anything the requester supplied. */
async function estimateRecipients(service: Service, estimate: any): Promise<string[]> {
  const sentTo = (estimate.approval_email_to || []).map((e: unknown) => String(e).trim()).filter(Boolean);
  if (sentTo.length > 0) return sentTo;
  const fallback = await resolveEstimateEmail(service, estimate);
  return fallback ? [fallback] : [];
}

async function relinkEstimate(service: Service, id: string, netsuiteId: string): Promise<RelinkResult & { repRecipients?: (string | null)[] }> {
  const { data: est } = await service
    .from('estimates')
    .select('id, estimate_number, title, customer_name, customer_id, prospect_id, customer_netsuite_id, subtotal, labor_total, tax_amount, grand_total, tax_rate, approval_token, approval_token_expires_at, approval_sent_hash, approval_email_to, approval_relink_at, approval_relink_count, customer_approved, customer_rejected_at, status, sent_for_approval_by, created_by')
    .eq('id', id)
    .maybeSingle();
  // Scope check is an equality on the id, not a name comparison: this is
  // the gate that stops one company minting a link to another's contract.
  if (!est || String(est.customer_netsuite_id || '') !== netsuiteId) {
    return { outcome: 'not_found', message: 'We could not find that estimate on your account.' };
  }
  const label = `Estimate #${est.estimate_number}`;
  if (est.customer_approved || est.status === 'accepted') {
    return { outcome: 'already_live', message: `${label} has already been approved — nothing is waiting on you.`, label };
  }
  // Same liveness test the Action Center listed this row by, so the two
  // can never disagree about whether a link still works — including the
  // token-with-no-expiry case, which IS live.
  if (tokenLive(est.approval_token, est.approval_token_expires_at)) {
    return { outcome: 'already_live', message: `${label} still has a working link — check your email for it.`, label };
  }
  if (inCooldown(est.approval_relink_at)) {
    return { outcome: 'cooldown', message: `We just sent a fresh link for ${label} — give it a few minutes to arrive.`, label };
  }

  // Has the quote changed since the customer was invited to sign it?
  const { data: lines } = await service
    .from('estimate_line_items')
    .select('item_number, quantity, unit_price, sort_order')
    .eq('estimate_id', est.id)
    .order('sort_order');
  const currentHash = approvalContentHash(est, lines || []);
  if (est.approval_sent_hash && currentHash !== est.approval_sent_hash) {
    return {
      outcome: 'referred_to_rep',
      label,
      message: `${label} has been updated since we sent it, so we have asked your BMG contact to send you the current version.`,
      repRecipients: [est.sent_for_approval_by, est.created_by],
    };
  }

  const emails = await estimateRecipients(service, est);
  if (emails.length === 0) {
    return {
      outcome: 'no_recipient',
      label,
      message: `We do not have an email address on file for ${label} — please contact your BMG representative.`,
      repRecipients: [est.sent_for_approval_by, est.created_by],
    };
  }

  const { token, expiresAt } = generateToken(RELINK_EXPIRY_DAYS);
  const now = new Date().toISOString();
  const { error: updErr } = await service
    .from('estimates')
    .update({
      approval_token: token,
      approval_token_expires_at: expiresAt,
      // Re-stamped from the CURRENT content, which the check above proved
      // still matches what was sent. Without it the accept route refuses
      // the very link we just minted.
      approval_sent_hash: currentHash,
      approval_relink_at: now,
      approval_relink_count: (est.approval_relink_count || 0) + 1,
      updated_at: now,
    })
    .eq('id', est.id);
  if (updErr) return { outcome: 'error', message: 'We could not issue a new link just now — please try again shortly.', label };

  const { subject, html, text } = buildRelinkEmail({
    kind: 'estimate', label, customerName: est.customer_name || null, token, emails, expiryDays: RELINK_EXPIRY_DAYS,
  });
  const { ok } = await sendEmailDetailed(
    emails, subject, html, text, undefined, undefined, undefined,
    { kind: 'estimate_relink', contextUrl: deepLinks.estimate(est.id), customerId: est.customer_id || undefined, netsuiteCustomerId: est.customer_netsuite_id || undefined },
  );
  if (!ok) {
    return { outcome: 'error', message: 'We issued a new link but could not email it — please contact your BMG representative.', label, repRecipients: [est.sent_for_approval_by, est.created_by] };
  }
  return {
    outcome: 'sent',
    label,
    maskedTo: maskedDestination(emails),
    message: `A fresh link for ${label} is on its way to ${maskedDestination(emails)}.`,
    repRecipients: [est.sent_for_approval_by, est.created_by],
  };
}

async function relinkQuote(service: Service, id: string, customerId: string): Promise<RelinkResult & { repRecipients?: (string | null)[] }> {
  const { data: q } = await service
    .from('wrap_quotes')
    .select('id, quote_number, vehicle_description, customer, customer_id, sent_to, total, approval_token, approval_token_expires_at, approval_relink_at, approval_relink_count, accepted_at, rejected_at, archived_at, created_by')
    .eq('id', id)
    .maybeSingle();
  if (!q || String(q.customer_id || '') !== customerId) {
    return { outcome: 'not_found', message: 'We could not find that quote on your account.' };
  }
  const label = `Wrap quote ${q.quote_number}`;
  if (q.accepted_at) return { outcome: 'already_live', message: `${label} has already been accepted — nothing is waiting on you.`, label };
  if (tokenLive(q.approval_token, q.approval_token_expires_at)) {
    return { outcome: 'already_live', message: `${label} still has a working link — check your email for it.`, label };
  }
  if (inCooldown(q.approval_relink_at)) {
    return { outcome: 'cooldown', message: `We just sent a fresh link for ${label} — give it a few minutes to arrive.`, label };
  }

  // NOTE: wrap_quotes carry no approval_sent_hash, so unlike an estimate
  // there is no way to tell whether this quote changed since it was sent.
  // That is a pre-existing gap (the accept route has no hash guard either,
  // so a LIVE wrap link already accepts whatever the quote says now) and
  // re-minting does not widen it — but it is the reason this path cannot
  // offer the estimate's change check.
  const emails = [q.customer?.email, q.customer?.email_cc, q.sent_to]
    .map((e: unknown) => String(e ?? '').trim())
    .filter(Boolean);
  const unique = [...new Set(emails)];
  if (unique.length === 0) {
    return { outcome: 'no_recipient', label, message: `We do not have an email address on file for ${label} — please contact your BMG representative.`, repRecipients: [q.created_by] };
  }

  const { token, expiresAt } = generateToken(RELINK_EXPIRY_DAYS);
  const now = new Date().toISOString();
  const { error: updErr } = await service
    .from('wrap_quotes')
    .update({
      approval_token: token,
      approval_token_expires_at: expiresAt,
      approval_relink_at: now,
      approval_relink_count: (q.approval_relink_count || 0) + 1,
      updated_at: now,
    })
    .eq('id', q.id);
  if (updErr) return { outcome: 'error', message: 'We could not issue a new link just now — please try again shortly.', label };

  const { subject, html, text } = buildRelinkEmail({
    kind: 'quote', label, customerName: q.customer?.name || null, token, emails: unique, expiryDays: RELINK_EXPIRY_DAYS,
  });
  const { ok } = await sendEmailDetailed(
    unique, subject, html, text, undefined, undefined, undefined,
    { kind: 'wrap_quote_relink', contextUrl: deepLinks.wrapQuote(q.id), customerId: q.customer_id || undefined },
  );
  if (!ok) {
    return { outcome: 'error', message: 'We issued a new link but could not email it — please contact your BMG representative.', label, repRecipients: [q.created_by] };
  }
  return { outcome: 'sent', label, maskedTo: maskedDestination(unique), message: `A fresh link for ${label} is on its way to ${maskedDestination(unique)}.`, repRecipients: [q.created_by] };
}

async function relinkProof(service: Service, id: string, customer: { id: string; netsuite_id: string }, poIds: string[]): Promise<RelinkResult & { repRecipients?: (string | null)[] }> {
  const { data: job } = await service
    .from('graphics_jobs')
    .select('id, job_number, title, customer, customer_netsuite_id, po_id, approval_token, approval_token_expires_at, approval_relink_at, approval_relink_count, customer_approved, status, sent_for_approval_by, created_by, assigned_to')
    .eq('id', id)
    .maybeSingle();
  // Same two id paths the Action Center uses to decide this job is this
  // customer's — kept identical so a job can never be listed and then
  // rejected here (or, worse, the reverse).
  const ownedById = !!job && String(job.customer_netsuite_id || '') === customer.netsuite_id;
  const ownedByPo = !!job && !!job.po_id && poIds.includes(String(job.po_id));
  if (!job || (!ownedById && !ownedByPo)) {
    return { outcome: 'not_found', message: 'We could not find that proof on your account.' };
  }
  const label = job.job_number ? `Job ${job.job_number}` : 'your artwork proof';
  if (job.customer_approved) return { outcome: 'already_live', message: `${label} has already been approved — nothing is waiting on you.`, label };
  if (tokenLive(job.approval_token, job.approval_token_expires_at)) {
    return { outcome: 'already_live', message: `${label} still has a working link — check your email for it.`, label };
  }
  if (inCooldown(job.approval_relink_at)) {
    return { outcome: 'cooldown', message: `We just sent a fresh link for ${label} — give it a few minutes to arrive.`, label };
  }

  // Recipients resolve from the customer ID we just proved owns this job,
  // NOT from the send lib's own company-name lookup. Two customers with
  // similar names would resolve to the same row there; here the id decides.
  const emails = await contactEmailsFor(service, customer.id);
  if (emails.length === 0) {
    return {
      outcome: 'no_recipient',
      label,
      message: `We do not have an email address on file for ${label} — please contact your BMG representative.`,
      repRecipients: [job.sent_for_approval_by, job.assigned_to, job.created_by],
    };
  }

  // The proof send lib owns the artwork, the email body and the token: a
  // relink re-mints for the SAME pinned proof file and stays inside the
  // open revision round, which is exactly its reminder behaviour.
  const result = await sendProofApproval(service, job.id, { relink: true, emails, expiryDays: RELINK_EXPIRY_DAYS });
  if (result.skipped || !result.ok) {
    return {
      outcome: result.error === 'No email on file for this customer.' ? 'no_recipient' : 'error',
      label,
      message: result.error === 'No email on file for this customer.'
        ? `We do not have an email address on file for ${label} — please contact your BMG representative.`
        : 'We could not issue a new link just now — please try again shortly.',
      repRecipients: [job.sent_for_approval_by, job.assigned_to, job.created_by],
    };
  }

  const now = new Date().toISOString();
  await service.from('graphics_jobs').update({
    approval_relink_at: now,
    approval_relink_count: (job.approval_relink_count || 0) + 1,
  }).eq('id', job.id);

  const to = (result.dispatch?.email?.target || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  const masked = maskedDestination(to);
  return {
    outcome: 'sent',
    label,
    maskedTo: masked || null,
    message: masked
      ? `A fresh link for ${label} is on its way to ${masked}.`
      : `A fresh link for ${label} is on its way to the address we have on file.`,
    repRecipients: [job.sent_for_approval_by, job.assigned_to, job.created_by],
  };
}

/**
 * Issue a fresh approval link for one record this customer owns. The
 * caller has already resolved the customer from the portal token; this
 * re-verifies ownership against the record itself rather than trusting
 * that, because the id arrives in the request body.
 */
export async function sendFreshApprovalLink(
  service: Service,
  kind: RelinkKind,
  id: string,
  customer: { id: string; netsuite_id: string },
  poIds: string[] = [],
): Promise<RelinkResult & { repRecipients?: (string | null)[] }> {
  if (kind === 'estimate') return relinkEstimate(service, id, customer.netsuite_id);
  if (kind === 'quote') return relinkQuote(service, id, customer.id);
  return relinkProof(service, id, customer, poIds);
}
