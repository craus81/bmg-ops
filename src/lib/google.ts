// Google OAuth2 + Gmail API helpers for server-side use
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Generate the Google OAuth consent URL
export function getAuthUrl(state?: string): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force to get refresh_token every time
    state: state || '',
  });
}

// Exchange authorization code for tokens
export async function exchangeCode(code: string) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// Get an authenticated Gmail client using stored refresh token
export async function getGmailClient() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Get the stored Google token
  const { data: tokenRow } = await supabase
    .from('google_tokens')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!tokenRow) {
    throw new Error('NO_GOOGLE_TOKEN');
  }

  const client = getOAuth2Client();
  client.setCredentials({
    refresh_token: tokenRow.refresh_token,
    access_token: tokenRow.access_token,
    expiry_date: tokenRow.expiry_date ? new Date(tokenRow.expiry_date).getTime() : undefined,
  });

  // Listen for token refresh events and update DB
  client.on('tokens', async (tokens) => {
    const updates: any = {};
    if (tokens.access_token) updates.access_token = tokens.access_token;
    if (tokens.expiry_date) updates.expiry_date = new Date(tokens.expiry_date).toISOString();
    if (Object.keys(updates).length > 0) {
      await supabase
        .from('google_tokens')
        .update(updates)
        .eq('id', tokenRow.id);
    }
  });

  return google.gmail({ version: 'v1', auth: client });
}

// Search Gmail for PO emails with PDF attachments
export async function searchPOEmails(after?: string) {
  const gmail = await getGmailClient();

  // Build search query
  let q = 'subject:PO has:attachment filename:pdf';
  if (after) {
    q += ` after:${after}`;
  }

  const res = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: 50,
  });

  return res.data.messages || [];
}

// Get full message details
export async function getMessage(messageId: string) {
  const gmail = await getGmailClient();
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  return res.data;
}

// Download a PDF attachment as base64
export async function getAttachment(messageId: string, attachmentId: string): Promise<string> {
  const gmail = await getGmailClient();
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });

  // Gmail returns URL-safe base64, convert to standard base64
  const urlSafeB64 = res.data.data || '';
  return urlSafeB64.replace(/-/g, '+').replace(/_/g, '/');
}

// Extract PDF attachments from a message
export function getPdfAttachments(message: any): { filename: string; attachmentId: string; size: number }[] {
  const attachments: { filename: string; attachmentId: string; size: number }[] = [];

  function walkParts(parts: any[]) {
    for (const part of parts) {
      if (part.filename && part.filename.toLowerCase().endsWith('.pdf') && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          attachmentId: part.body.attachmentId,
          size: part.body.size || 0,
        });
      }
      if (part.parts) {
        walkParts(part.parts);
      }
    }
  }

  if (message.payload?.parts) {
    walkParts(message.payload.parts);
  } else if (message.payload?.body?.attachmentId && message.payload.filename?.toLowerCase().endsWith('.pdf')) {
    attachments.push({
      filename: message.payload.filename,
      attachmentId: message.payload.body.attachmentId,
      size: message.payload.body.size || 0,
    });
  }

  return attachments;
}

// Extract header value from message
export function getHeader(message: any, name: string): string {
  const headers = message.payload?.headers || [];
  const h = headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}
