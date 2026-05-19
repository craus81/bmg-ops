// Google OAuth2 + Gmail API helpers for server-side use
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar',
];

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

// Per-process cache for the authenticated Gmail client. Without this, every
// getMessage/getAttachment call re-runs a Supabase round-trip + builds a new
// OAuth client, which turns the per-message loops in search-pos / import-po
// into an N+1 that blows past the function timeout on any real PO backlog.
// The googleapis client refreshes its own access token from the refresh
// token, so reuse is safe; the short TTL still lets a re-auth take effect.
let cachedGmail: { client: ReturnType<typeof google.gmail>; at: number } | null = null;
const GMAIL_CLIENT_TTL_MS = 5 * 60 * 1000;

// Get an authenticated Gmail client using stored refresh token
export async function getGmailClient() {
  if (cachedGmail && Date.now() - cachedGmail.at < GMAIL_CLIENT_TTL_MS) {
    return cachedGmail.client;
  }

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

  const gmail = google.gmail({ version: 'v1', auth: client });
  cachedGmail = { client: gmail, at: Date.now() };
  return gmail;
}

// Search Gmail for PO emails with PDF attachments.
//
// We accept several common subject patterns — vendors don't all literally
// say "PO" — to avoid silently missing purchase orders whose subjects say
// "Purchase Order" or "P.O." instead. has:attachment filename:pdf keeps
// the noise floor down.
export async function searchPOEmails(after?: string) {
  const gmail = await getGmailClient();

  let q = '(subject:PO OR subject:"purchase order" OR subject:P.O.) has:attachment filename:pdf';
  if (after) {
    q += ` after:${after}`;
  }

  const allMessages: any[] = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 200,
      ...(pageToken ? { pageToken } : {}),
    });

    const messages = res.data.messages || [];
    allMessages.push(...messages);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken && allMessages.length < 500); // safety cap at 500

  return allMessages;
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

// ═══════════ GOOGLE CALENDAR ═══════════

// The shared company calendar ID — set via env var or default to primary
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Get an authenticated Calendar client using stored refresh token
async function getCalendarClient() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

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

  client.on('tokens', async (tokens) => {
    const updates: any = {};
    if (tokens.access_token) updates.access_token = tokens.access_token;
    if (tokens.expiry_date) updates.expiry_date = new Date(tokens.expiry_date).toISOString();
    if (Object.keys(updates).length > 0) {
      await supabase.from('google_tokens').update(updates).eq('id', tokenRow.id);
    }
  });

  return google.calendar({ version: 'v3', auth: client });
}

/**
 * Create or update a Google Calendar event for a graphics job install date.
 * Returns the event ID.
 */
export async function syncCalendarEvent(params: {
  eventId?: string | null;
  title: string;
  date: string; // YYYY-MM-DD
  description?: string;
  location?: string;
  colorId?: string; // Google Calendar color: 6=orange(graphics), 9=blue(upfit), 10=green(CNI)
}): Promise<string | null> {
  try {
    const calendar = await getCalendarClient();

    // Google Calendar all-day events: end date is exclusive, so add 1 day
    const endDate = new Date(params.date + 'T12:00:00');
    endDate.setDate(endDate.getDate() + 1);
    const endDateStr = endDate.toISOString().split('T')[0];

    const eventBody = {
      summary: params.title,
      description: params.description || '',
      location: params.location || '',
      start: {
        date: params.date, // All-day event
      },
      end: {
        date: endDateStr, // Exclusive end date (next day)
      },
      colorId: params.colorId || '6',
    };

    if (params.eventId) {
      // Update existing event
      const res = await calendar.events.update({
        calendarId: CALENDAR_ID,
        eventId: params.eventId,
        requestBody: eventBody,
      });
      return res.data.id || params.eventId;
    } else {
      // Create new event
      const res = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: eventBody,
      });
      return res.data.id || null;
    }
  } catch (err) {
    console.error('Google Calendar sync failed:', err);
    return null;
  }
}

/**
 * Delete a Google Calendar event.
 */
export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  try {
    const calendar = await getCalendarClient();
    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId,
    });
    return true;
  } catch (err) {
    console.error('Google Calendar delete failed:', err);
    return false;
  }
}
