import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.RESEND_FROM_EMAIL || 'notifications@bmgfleet.com';
const fromName = process.env.RESEND_FROM_NAME || 'BMG Fleet';

const resend = apiKey ? new Resend(apiKey) : null;

interface Attachment {
  filename: string;
  content: Buffer;
  contentType?: string;
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
 * Send an email via Resend
 * Returns true if successful, false if Resend is not configured or failed
 */
export async function sendEmail(
  to: string | string[],
  subject: string,
  htmlBody: string,
  textBody?: string,
  attachments?: Attachment[]
): Promise<boolean> {
  if (!resend) {
    console.warn('Resend not configured — skipping email send');
    return false;
  }

  try {
    return await enqueueSend(async () => {
      for (let attempt = 0; ; attempt++) {
        const { error } = await resend!.emails.send({
          from: `${fromName} <${fromEmail}>`,
          to,
          subject,
          html: htmlBody,
          text: textBody || htmlBody.replace(/<[^>]*>/g, ''),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        });
        lastSendAt = Date.now();

        if (!error) return true;

        if (isRateLimitError(error) && attempt < MAX_RATE_LIMIT_RETRIES) {
          await sleep(MIN_SEND_INTERVAL_MS * 2 ** attempt);
          continue;
        }

        console.error('Resend email send failed:', error);
        return false;
      }
    });
  } catch (err) {
    console.error('Resend email send failed:', err);
    return false;
  }
}

/**
 * Build a styled HTML email body for BMG Fleet notifications
 */
export function buildNotificationEmail(title: string, body: string, ctaUrl?: string, ctaLabel?: string): string {
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
        <div style="font-size:16px;font-weight:800;color:#f5f8fc;margin-bottom:8px;">${escapeHtml(title)}</div>
        <div style="font-size:14px;color:#8899aa;line-height:1.5;">${escapeHtml(body)}</div>
        ${ctaUrl ? `
        <div style="margin-top:20px;">
          <a href="${ctaUrl}" style="display:inline-block;padding:12px 24px;background:#3b82f6;color:#fff;font-weight:800;font-size:13px;border-radius:10px;text-decoration:none;">${escapeHtml(ctaLabel || 'Open in App')}</a>
        </div>` : ''}
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
