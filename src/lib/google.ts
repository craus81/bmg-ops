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

// ── Proof attachments (PDFs + photo/design files) ──────────────
// What a vehicle-graphics or print proof actually arrives as. Mirrors the
// classification in scripts/extract-email-proofs.mjs so the in-app picker and
// the bulk script agree on what counts as a proof.
const PROOF_ALWAYS_EXT = new Set(['pdf', 'ai', 'eps', 'psd', 'tif', 'tiff', 'svg']);
const PROOF_RASTER_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif']);
// Raster images must clear this size so we don't surface signature logos and
// tracking pixels. PDFs and design-source files always count.
const PROOF_MIN_RASTER_BYTES = 25000;

function proofExt(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

export interface ProofAttachment {
  filename: string;
  attachmentId: string;
  size: number;
  mimeType: string;
}

// Walk a message's MIME parts and return the attachments that look like proofs.
export function getProofAttachments(message: any): ProofAttachment[] {
  const out: ProofAttachment[] = [];
  function walk(part: any) {
    if (!part) return;
    const filename: string = part.filename || '';
    const attachmentId: string | undefined = part.body?.attachmentId;
    const size: number = part.body?.size || 0;
    if (filename && attachmentId) {
      const ext = proofExt(filename);
      const keep = PROOF_ALWAYS_EXT.has(ext) || (PROOF_RASTER_EXT.has(ext) && size >= PROOF_MIN_RASTER_BYTES);
      if (keep) out.push({ filename, attachmentId, size, mimeType: part.mimeType || '' });
    }
    if (part.parts) for (const p of part.parts) walk(p);
  }
  walk(message.payload);
  return out;
}

// Best-effort content type for a proof, falling back to the file extension when
// Gmail reports a generic/empty mimeType.
export function proofContentType(filename: string, mimeType?: string): string {
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType;
  const map: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', heic: 'image/heic',
    heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
    eps: 'application/postscript', ai: 'application/illustrator', psd: 'image/vnd.adobe.photoshop',
  };
  return map[proofExt(filename)] || 'application/octet-stream';
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
  /** Google Calendar color: 6=orange(graphics), 9=blue(upfit), 10=green(CNI).
   *  Pass null to leave the event's color untouched (e.g. editing an event
   *  a human created on Google). */
  colorId?: string | null;
}): Promise<string | null> {
  try {
    const calendar = await getCalendarClient();

    // Google Calendar all-day events: end date is exclusive, so add 1 day
    const endDate = new Date(params.date + 'T12:00:00');
    endDate.setDate(endDate.getDate() + 1);
    const endDateStr = endDate.toISOString().split('T')[0];

    const eventBody: any = {
      summary: params.title,
      description: params.description || '',
      location: params.location || '',
      start: {
        date: params.date, // All-day event
      },
      end: {
        date: endDateStr, // Exclusive end date (next day)
      },
    };
    if (params.colorId !== null) eventBody.colorId = params.colorId || '6';

    if (params.eventId) {
      // Patch (not update) — partial write that preserves fields we don't
      // manage, like attendees, reminders, and the color of human-created
      // events.
      const res = await calendar.events.patch({
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
 * Incremental pull from the shared calendar. Pass the syncToken from the
 * previous run to get only what changed since (including deletions);
 * pass null for a bootstrap sweep of the last ~60 days onward. When
 * Google expires a token (HTTP 410) the caller gets fullResyncNeeded and
 * should retry with null.
 */
export async function listCalendarChanges(syncToken: string | null): Promise<{
  events: any[];
  nextSyncToken: string | null;
  fullResyncNeeded: boolean;
}> {
  const calendar = await getCalendarClient();
  const events: any[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;

  try {
    do {
      const params: any = {
        calendarId: CALENDAR_ID,
        maxResults: 250,
        showDeleted: true,
        // Expand recurring series into concrete dated instances — without
        // this a weekly install block arrives as one master record and
        // every other occurrence is invisible to the sync.
        singleEvents: true,
        pageToken,
      };
      if (syncToken) {
        params.syncToken = syncToken;
      } else {
        // Bootstrap: recent past + everything scheduled ahead.
        params.timeMin = new Date(Date.now() - 60 * 86_400_000).toISOString();
      }
      const res = await calendar.events.list(params);
      events.push(...(res.data.items || []));
      pageToken = res.data.nextPageToken || undefined;
      if (res.data.nextSyncToken) nextSyncToken = res.data.nextSyncToken;
    } while (pageToken);
    return { events, nextSyncToken, fullResyncNeeded: false };
  } catch (err: any) {
    if (err?.code === 410 || err?.response?.status === 410) {
      return { events: [], nextSyncToken: null, fullResyncNeeded: true };
    }
    throw err;
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
