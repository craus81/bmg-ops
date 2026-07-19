// Domain-wide-delegated Gmail access: a service account authorized in the
// Google Workspace admin console (gmail.readonly only) impersonates a
// specific BMG mailbox. Used by the parts-email ETA scan — read-only, and
// only for mailboxes listed in parts_email_settings.
import { google } from 'googleapis';

export function dwdConfigured(): boolean {
  return !!(process.env.GOOGLE_DWD_CLIENT_EMAIL && process.env.GOOGLE_DWD_PRIVATE_KEY);
}

export function getDelegatedGmail(userEmail: string) {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_DWD_CLIENT_EMAIL,
    // Vercel env vars store the key with literal "\n" sequences.
    key: (process.env.GOOGLE_DWD_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject: userEmail,
  });
  return google.gmail({ version: 'v1', auth });
}

/** Plain-text body of a Gmail message: text/plain part preferred, stripped HTML as fallback, snippet as last resort. */
export function getMessagePlainText(message: any): string {
  const decode = (b64: string) => Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  let plain = '';
  let html = '';
  const walk = (part: any) => {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) plain += decode(part.body.data);
    else if (part.mimeType === 'text/html' && part.body?.data) html += decode(part.body.data);
    for (const p of part.parts || []) walk(p);
  };
  walk(message.payload);
  if (plain.trim()) return plain;
  if (html.trim()) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return message.snippet || '';
}

export function getHeader(message: any, name: string): string {
  const h = (message.payload?.headers || []).find((x: any) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}
