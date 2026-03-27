import { Resend } from 'resend';

const apiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.RESEND_FROM_EMAIL || 'notifications@bmgfleet.com';
const fromName = process.env.RESEND_FROM_NAME || 'BMG Fleet';

const resend = apiKey ? new Resend(apiKey) : null;

/**
 * Send an email via Resend
 * Returns true if successful, false if Resend is not configured or failed
 */
export async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string,
  textBody?: string
): Promise<boolean> {
  if (!resend) {
    console.warn('Resend not configured — skipping email send');
    return false;
  }

  try {
    const { error } = await resend.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to,
      subject,
      html: htmlBody,
      text: textBody || htmlBody.replace(/<[^>]*>/g, ''),
    });

    if (error) {
      console.error('Resend email send failed:', error);
      return false;
    }

    return true;
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
        <div style="font-size:10px;color:#d0dcea;">You received this because of your notification settings in BMG Fleet.</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
