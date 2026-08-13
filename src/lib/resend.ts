import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';

const apiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.RESEND_FROM_EMAIL || 'notifications@bmgfleet.com';
const fromName = process.env.RESEND_FROM_NAME || 'BMG Fleet';
// The from address is send-only — no mailbox exists behind it, so a customer
// hitting Reply bounces unless the email carries a Reply-To pointing at a
// real address. Callers pass the sending user's email where one exists;
// RESEND_REPLY_TO_EMAIL is the fallback for automated sends (crons, digests).
const defaultReplyTo = process.env.RESEND_REPLY_TO_EMAIL || '';

const resend = apiKey ? new Resend(apiKey) : null;

interface Attachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/**
 * Optional context for the universal email log (email_log). Pass it so the
 * admin Email delivery view can say WHAT an email was and bounce alerts can
 * reach the right person — sends without it still log, tagged 'other'.
 */
export interface EmailMeta {
  /** Flow slug, e.g. 'invoice', 'estimate_approval', 'statement', 'invite'. */
  kind?: string;
  /** The user who composed/triggered the send — bounce alerts go to them.
   *  Leave unset for automated sends (crons, digests). */
  sentBy?: string | null;
  /** Deep link (deep-links.ts) to the record the email is about. */
  contextUrl?: string | null;
}

/**
 * Log a send to email_log — the universal delivery record every flow gets
 * for free. Best-effort: a logging failure never fails a send, and without
 * service credentials (tests, misconfigured env) it silently skips.
 * Returns the log row id so the webhook's bounce alerts can deep-link it.
 */
async function logEmailSend(
  to: string | string[],
  subject: string,
  ok: boolean,
  sourceId: string | null,
  meta?: EmailMeta,
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const service = createClient(url, key);
    const { error } = await service.from('email_log').insert({
      source_id: ok ? sourceId : null,
      kind: meta?.kind || 'other',
      recipients: Array.isArray(to) ? to : [to],
      subject,
      sent_by: meta?.sentBy || null,
      context_url: meta?.contextUrl || null,
      // A failed hand-off gets 'failed' immediately — no webhook will ever
      // arrive to say so.
      delivery_status: ok ? 'sent' : 'failed',
      delivery_detail: ok ? null : 'The email could not be handed to the delivery service',
    });
    if (error) console.error('email_log insert failed:', error.message);
  } catch (err) {
    console.error('email_log insert failed:', err);
  }
}

// Resend's default rate limit is 2 requests/second. Parallel fan-outs
// (e.g. notifyMany emailing every admin about an access request) used to
// fire all sends at once and trip 429s, so sends are serialized through
// this queue with a minimum gap, and rate-limited sends are retried.
const MIN_SEND_INTERVAL_MS = 600;
const MAX_RATE_LIMIT_RETRIES = 3;

let sendQueue: Promise<void> = Promise.resolve();
let lastSendAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: { name?: string } | null): boolean {
  return error?.name === 'rate_limit_exceeded';
}

/**
 * Armor email HTML against a lossy hop between Resend and the recipient's
 * inbox that quoted-printable-decodes the body one time too many: any
 * literal `=` followed by two hex digits gets swallowed as a QP escape, so
 * "?id=5f5cbf95…" arrived in the field as "?id_cbf95…" and every UUID
 * query-param deep link (all-hex ids!) broke, while path-style links
 * survived untouched. Writing those `=` as the HTML entity `&#61;` keeps
 * the fragile byte sequence out of the transmitted body; HTML parsers
 * decode the entity, so rendered links and text are unchanged. `=` followed
 * by anything else (e.g. the `="` of attribute syntax) is not a valid QP
 * escape and passes through decoders literally, so it needs no armoring.
 */
export function qpProofHtml(html: string): string {
  return html.replace(/=(?=[0-9A-Fa-f]{2})/g, '&#61;');
}

function enqueueSend<T>(task: () => Promise<T>): Promise<T> {
  const run = sendQueue.then(async () => {
    const wait = lastSendAt + MIN_SEND_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    return task();
  });
  sendQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Send an email via Resend, returning success + the Resend message id.
 * The id is what delivery webhooks key on — callers that track delivery
 * (invoice emails) store it; everyone else can use sendEmail below.
 */
export async function sendEmailDetailed(
  to: string | string[],
  subject: string,
  htmlBody: string,
  textBody?: string,
  attachments?: Attachment[],
  replyTo?: string | string[],
  bcc?: string | string[],
  meta?: EmailMeta
): Promise<{ ok: boolean; id: string | null }> {
  if (!resend) {
    console.warn('Resend not configured — skipping email send');
    return { ok: false, id: null };
  }

  const effectiveReplyTo =
    replyTo && (typeof replyTo === 'string' ? replyTo.trim() : replyTo.length > 0)
      ? replyTo
      : defaultReplyTo || undefined;
  const effectiveBcc =
    bcc && (typeof bcc === 'string' ? bcc.trim() : bcc.length > 0) ? bcc : undefined;

  let result: { ok: boolean; id: string | null };
  try {
    result = await enqueueSend(async () => {
      for (let attempt = 0; ; attempt++) {
        const { data, error } = await resend!.emails.send({
          from: `${fromName} <${fromEmail}>`,
          to,
          subject,
          html: qpProofHtml(htmlBody),
          // The plain-text part derives from the RAW html — text has no
          // entity escape mechanism, so armoring can't help it there.
          text: textBody || htmlBody.replace(/<[^>]*>/g, ''),
          ...(effectiveReplyTo ? { replyTo: effectiveReplyTo } : {}),
          ...(effectiveBcc ? { bcc: effectiveBcc } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        });
        lastSendAt = Date.now();

        if (!error) return { ok: true, id: data?.id || null };

        if (isRateLimitError(error) && attempt < MAX_RATE_LIMIT_RETRIES) {
          await sleep(MIN_SEND_INTERVAL_MS * 2 ** attempt);
          continue;
        }

        console.error('Resend email send failed:', error);
        return { ok: false, id: null };
      }
    });
  } catch (err) {
    console.error('Resend email send failed:', err);
    result = { ok: false, id: null };
  }

  await logEmailSend(to, subject, result.ok, result.id, meta);
  return result;
}

/**
 * Send an email via Resend
 * Returns true if successful, false if Resend is not configured or failed
 */
export async function sendEmail(
  to: string | string[],
  subject: string,
  htmlBody: string,
  textBody?: string,
  attachments?: Attachment[],
  replyTo?: string | string[],
  bcc?: string | string[],
  meta?: EmailMeta
): Promise<boolean> {
  const { ok } = await sendEmailDetailed(to, subject, htmlBody, textBody, attachments, replyTo, bcc, meta);
  return ok;
}

/**
 * Build a styled HTML email body for BMG Fleet notifications.
 *
 * opts (all optional, used by the customer-email compose standard):
 *   note            — personal message from the sender, rendered as its own
 *                     block above the body (newlines preserved)
 *   attachmentNames — listed under the body so recipients know what's attached
 *   ctaNote         — small line under the CTA button (e.g. link expiry)
 */
export function buildNotificationEmail(
  title: string,
  body: string,
  ctaUrl?: string,
  ctaLabel?: string,
  opts?: { note?: string; attachmentNames?: string[]; ctaNote?: string },
): string {
  const noteHtml = opts?.note?.trim()
    ? `
        <div style="font-size:14px;color:#dbe4ee;line-height:1.6;background:#0f1923;border:1px solid #1e2d3d;border-radius:10px;padding:12px 14px;margin-bottom:14px;">${escapeHtml(opts.note.trim()).replace(/\n/g, '<br>')}</div>`
    : '';
  const attachmentsHtml = opts?.attachmentNames && opts.attachmentNames.length > 0
    ? `
        <div style="margin-top:14px;font-size:12px;color:#8899aa;">
          <span style="font-weight:700;color:#dbe4ee;">Attached:</span> ${opts.attachmentNames.map(n => escapeHtml(n)).join(', ')}
        </div>`
    : '';
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a1018;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:24px;">
    <div style="background:#141e2b;border:1px solid #1e2d3d;border-radius:16px;overflow:hidden;">
      <!-- Header -->
      <div style="background:linear-gradient(135deg,#0f1923,#1a2a3d);padding:20px 24px;border-bottom:1px solid #1e2d3d;">
        <div style="font-size:11px;font-weight:800;color:#ee3120;letter-spacing:1.5px;text-transform:uppercase;">BMG Fleet</div>
      </div>
      <!-- Body -->
      <div style="padding:24px;">
        <div style="font-size:16px;font-weight:800;color:#f5f8fc;margin-bottom:8px;">${escapeHtml(title)}</div>${noteHtml}
        <div style="font-size:14px;color:#8899aa;line-height:1.5;">${escapeHtml(body)}</div>
        ${ctaUrl ? `
        <div style="margin-top:20px;">
          <a href="${ctaUrl}" style="display:inline-block;padding:12px 24px;background:#3b82f6;color:#fff;font-weight:800;font-size:13px;border-radius:10px;text-decoration:none;">${escapeHtml(ctaLabel || 'Open in App')}</a>
        </div>` : ''}
        ${opts?.ctaNote ? `<div style="margin-top:8px;font-size:11px;color:#8899aa;">${escapeHtml(opts.ctaNote)}</div>` : ''}${attachmentsHtml}
      </div>
      <!-- Footer -->
      <div style="padding:16px 24px;border-top:1px solid #1e2d3d;text-align:center;">
        <div style="font-size:10px;color:#e8f0f8;">You received this because of your notification settings in BMG Fleet.</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Weekly customer digest: multi-section summary of the customer's vehicles
 * (in progress / completed / invoiced). Light theme — customers print and
 * forward these.
 */
export function buildCustomerDigestEmail(
  customerName: string,
  sections: { title: string; rows: string[] }[],
  footerNote?: string,
): string {
  const sectionHtml = sections
    .filter(s => s.rows.length > 0)
    .map(s => `
      <div style="margin-top:18px;">
        <div style="font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">${escapeHtml(s.title)}</div>
        ${s.rows.map(r => `<div style="font-size:13px;color:#111827;padding:6px 10px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:4px;">${escapeHtml(r)}</div>`).join('')}
      </div>`)
    .join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
      <div style="font-size:11px;font-weight:800;color:#ee3120;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">BMG Fleet</div>
      <div style="font-size:19px;font-weight:800;color:#111827;">Your weekly vehicle update</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">${escapeHtml(customerName)} · ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
      ${sectionHtml}
      <div style="margin-top:20px;font-size:12px;color:#6b7280;line-height:1.5;">
        Questions about any vehicle? Just reply to this email.
      </div>
    </div>
    <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">
      ${escapeHtml(footerNote || "Don't want these weekly summaries? Reply and we'll turn them off.")}
    </div>
  </div>
</body>
</html>`;
}

/**
 * Build a styled HTML email for sending invoices to customers
 */
export function buildInvoiceEmail(customerName: string, invoiceNumbers: string[], poNumbers: string[], customBody?: string): string {
  const invoiceList = invoiceNumbers.map(n => `<li style="margin-bottom:4px;color:#f5f8fc;font-size:14px;">Invoice #${escapeHtml(n)}</li>`).join('');
  const poLine = poNumbers.length > 0
    ? `<div style="font-size:13px;color:#8899aa;margin-top:12px;">PO${poNumbers.length > 1 ? 's' : ''}: ${poNumbers.map(p => escapeHtml(p)).join(', ')}</div>`
    : '';

  const defaultBody = `Please find the attached invoice${invoiceNumbers.length !== 1 ? 's' : ''} for your recent services.`;
  const bodyHtml = (customBody && customBody.trim()
    ? escapeHtml(customBody).replace(/\n/g, '<br>')
    : defaultBody);

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px;">
    <div style="background:#141e2b;border:1px solid #1e2d3d;border-radius:16px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#0f1923,#1a2a3d);padding:20px 24px;border-bottom:1px solid #1e2d3d;">
        <div style="font-size:11px;font-weight:800;color:#ee3120;letter-spacing:1.5px;text-transform:uppercase;">BMG Fleet</div>
      </div>
      <div style="padding:24px;">
        <div style="font-size:16px;font-weight:800;color:#f5f8fc;margin-bottom:12px;">
          ${invoiceNumbers.length === 1 ? 'Invoice' : 'Invoices'} for ${escapeHtml(customerName)}
        </div>
        <div style="font-size:14px;color:#8899aa;line-height:1.6;margin-bottom:16px;">
          ${bodyHtml}
        </div>
        <ul style="list-style:none;padding:0;margin:0 0 8px 0;">
          ${invoiceList}
        </ul>
        ${poLine}
      </div>
      <div style="padding:16px 24px;border-top:1px solid #1e2d3d;text-align:center;">
        <div style="font-size:10px;color:#8899aa;">BMG Fleet Services</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
