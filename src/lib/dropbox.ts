/**
 * Dropbox API Client for FleetSuite
 * Uses OAuth 2.0 with refresh tokens for persistent access.
 * Tokens are stored in Supabase `app_settings` table.
 */

import { createServiceClient } from '@/lib/supabase-service';

interface DropboxTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms
}

function getDropboxConfig() {
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error('Missing DROPBOX_APP_KEY or DROPBOX_APP_SECRET environment variables');
  }
  return { appKey, appSecret };
}

function getSupabaseAdmin() {
  return createServiceClient();
}

// ── Token Storage ──

export async function getStoredTokens(): Promise<DropboxTokens | null> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from('app_settings')
    .select('value')
    .eq('key', 'dropbox_tokens')
    .single();
  if (!data?.value) return null;
  return typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
}

export async function storeTokens(tokens: DropboxTokens): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from('app_settings').upsert({
    key: 'dropbox_tokens',
    value: tokens,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  if (error) {
    throw new Error(`Failed to store Dropbox tokens: ${error.message}`);
  }
}

// ── OAuth Token Refresh ──

async function refreshAccessToken(refreshToken: string): Promise<DropboxTokens> {
  const { appKey, appSecret } = getDropboxConfig();
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    // A revoked/invalid refresh token can't be recovered — the user must reconnect.
    if (err.includes('invalid_grant')) {
      throw new Error('Dropbox not connected. Please authorize via Settings.');
    }
    throw new Error(`Dropbox token refresh failed: ${err}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: refreshToken, // refresh token doesn't change
    expires_at: Date.now() + (data.expires_in * 1000) - 60000, // 1min buffer
  };
}

// ── Get Valid Access Token ──

export async function getAccessToken(forceRefresh = false): Promise<string> {
  const tokens = await getStoredTokens();
  if (!tokens) {
    throw new Error('Dropbox not connected. Please authorize via Settings.');
  }
  if (!tokens.refresh_token) {
    // Legacy/manually-seeded token with no refresh capability
    throw new Error('Dropbox not connected. Please authorize via Settings.');
  }

  // If token is still valid, return it
  if (!forceRefresh && tokens.expires_at > Date.now()) {
    return tokens.access_token;
  }

  // Refresh the token
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  try {
    await storeTokens(refreshed);
  } catch (err) {
    // The refreshed token is still usable for this request even if persisting failed
    console.error('Failed to persist refreshed Dropbox tokens:', err);
  }
  return refreshed.access_token;
}

// ── Authenticated fetch with expired-token retry ──

/**
 * Dropbox can reject an access token before our stored `expires_at`
 * (clock skew, tokens invalidated server-side, stale stored state).
 * On a 401, force a refresh via the refresh token and retry once.
 */
async function dropboxFetch(
  url: string,
  buildInit: (token: string) => RequestInit
): Promise<Response> {
  let token = await getAccessToken();
  let res = await fetch(url, buildInit(token));

  if (res.status === 401) {
    token = await getAccessToken(true);
    res = await fetch(url, buildInit(token));
  }

  return res;
}

// ── Exchange auth code for tokens (initial setup) ──

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<DropboxTokens> {
  const { appKey, appSecret } = getDropboxConfig();
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: appKey,
      client_secret: appSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dropbox auth failed: ${err}`);
  }

  const data = await res.json();
  const tokens: DropboxTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000) - 60000,
  };

  await storeTokens(tokens);
  return tokens;
}

// ── Search Files ──

export interface DropboxSearchResult {
  id: string;
  name: string;
  path: string;
  size: number;
  modified: string;
  folder: string; // parent folder name
}

export async function searchFiles(query: string, fileExtensions?: string[]): Promise<DropboxSearchResult[]> {
  const options: any = {
    path: '',
    max_results: 30,
    file_status: { '.tag': 'active' },
  };

  if (fileExtensions?.length) {
    options.file_categories = [{ '.tag': 'pdf' }];
  }

  const res = await dropboxFetch('https://api.dropboxapi.com/2/files/search_v2', (token) => ({
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      options,
    }),
  }));

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dropbox search failed: ${err}`);
  }

  const data = await res.json();
  const matches = data.matches || [];

  return matches
    .filter((m: any) => m.metadata?.metadata?.['.tag'] === 'file')
    .map((m: any) => {
      const meta = m.metadata.metadata;
      const pathParts = (meta.path_display || '').split('/');
      return {
        id: meta.id,
        name: meta.name,
        path: meta.path_display || meta.path_lower,
        size: meta.size || 0,
        modified: meta.server_modified || '',
        folder: pathParts.length > 2 ? pathParts[pathParts.length - 2] : '',
      };
    });
}

// ── Download File Content ──

export async function downloadFile(path: string): Promise<{ buffer: Buffer; name: string; contentType: string; rev?: string }> {
  const res = await dropboxFetch('https://content.dropboxapi.com/2/files/download', (token) => ({
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  }));

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dropbox download failed: ${err}`);
  }

  const resultHeader = res.headers.get('dropbox-api-result');
  const meta = resultHeader ? JSON.parse(resultHeader) : {};
  const buffer = Buffer.from(await res.arrayBuffer());

  return {
    buffer,
    name: meta.name || 'file',
    contentType: meta.name?.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
    rev: typeof meta.rev === 'string' ? meta.rev : undefined,
  };
}

// ── Get Thumbnail ──

export async function getThumbnail(
  path: string,
  size: 'w32h32' | 'w64h64' | 'w128h128' | 'w256h256' | 'w480h320' | 'w640h480' = 'w256h256'
): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await dropboxFetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', (token) => ({
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({
        resource: { '.tag': 'path', path },
        format: { '.tag': 'png' },
        size: { '.tag': size },
        mode: { '.tag': 'bestfit' },
      }),
    },
  }));

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dropbox thumbnail failed: ${err}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: 'image/png' };
}

// ── Check Connection Status ──

export async function isConnected(): Promise<boolean> {
  try {
    const res = await dropboxFetch('https://api.dropboxapi.com/2/check/user', (token) => ({
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'fleetsuite' }),
    }));
    return res.ok;
  } catch {
    return false;
  }
}

// ── Folder listing (Client Files sync) ──

/** One entry from files/list_folder, as the Client Files sync uses it. */
export type DropboxListEntry =
  | { tag: 'file'; id: string; name: string; path_lower: string; path_display: string; size: number; server_modified: string; rev: string }
  | { tag: 'folder'; id: string; name: string; path_lower: string; path_display: string }
  | { tag: 'deleted'; name: string; path_lower: string; path_display: string };

export interface DropboxListPage {
  entries: DropboxListEntry[];
  cursor: string;
  has_more: boolean;
}

/** list_folder/continue answered that the cursor is no longer valid; start a fresh listing. */
export class DropboxCursorResetError extends Error {
  constructor() {
    super('Dropbox cursor reset');
    this.name = 'DropboxCursorResetError';
  }
}

function toListEntry(e: any): DropboxListEntry | null {
  const tag = e?.['.tag'];
  if (tag === 'file') {
    return {
      tag, id: e.id, name: e.name, path_lower: e.path_lower, path_display: e.path_display || e.path_lower,
      size: Number(e.size) || 0, server_modified: e.server_modified, rev: e.rev,
    };
  }
  if (tag === 'folder') return { tag, id: e.id, name: e.name, path_lower: e.path_lower, path_display: e.path_display || e.path_lower };
  if (tag === 'deleted') return { tag, name: e.name, path_lower: e.path_lower, path_display: e.path_display || e.path_lower };
  return null;
}

async function listCall(url: string, body: unknown): Promise<DropboxListPage> {
  const res = await dropboxFetch(url, (token) => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!res.ok) {
    const err = await res.text();
    if (res.status === 409 && err.includes('reset')) throw new DropboxCursorResetError();
    throw new Error(`Dropbox list failed (${res.status}): ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    entries: (data.entries || []).map(toListEntry).filter(Boolean) as DropboxListEntry[],
    cursor: data.cursor,
    has_more: !!data.has_more,
  };
}

/** First page of a recursive listing of `path` (files and folders, not deleted ones). */
export function listFolderRecursive(path: string, limit = 2000): Promise<DropboxListPage> {
  return listCall('https://api.dropboxapi.com/2/files/list_folder', {
    path, recursive: true, include_deleted: false, include_non_downloadable_files: false, limit,
  });
}

/** Next page, or once caught up, everything that changed since the cursor (deletions included). */
export function listFolderContinue(cursor: string): Promise<DropboxListPage> {
  return listCall('https://api.dropboxapi.com/2/files/list_folder/continue', { cursor });
}

/** One item's metadata, or null when it no longer exists. */
export async function getMetadata(path: string): Promise<DropboxListEntry | null> {
  const res = await dropboxFetch('https://api.dropboxapi.com/2/files/get_metadata', (token) => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }));
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`Dropbox metadata failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return toListEntry(await res.json());
}

/**
 * A 4-hour direct link to a file's bytes, so a download goes straight from
 * Dropbox to the person instead of through a serverless function (print
 * files run to hundreds of MB).
 */
export async function getTemporaryLink(path: string): Promise<string> {
  const res = await dropboxFetch('https://api.dropboxapi.com/2/files/get_temporary_link', (token) => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }));
  if (!res.ok) throw new Error(`Dropbox link failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (!data?.link) throw new Error('Dropbox returned no link');
  return data.link as string;
}

// ── Upload File ──

/**
 * Dropbox-API-Arg is an HTTP header, so anything outside ASCII must go as a
 * JSON \u escape (Dropbox's documented rule) or the request is refused.
 */
export function dropboxApiArg(arg: unknown): string {
  return JSON.stringify(arg).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** A Dropbox error body in plain words for staff (missing write permission is the likely one). */
export function dropboxUploadErrorText(status: number, body: string): string {
  if (/missing_scope/.test(body)) {
    return "FleetSuite isn't allowed to save into Dropbox yet. The Dropbox connection needs write permission (files.content.write), then reconnect it.";
  }
  if (/insufficient_space/.test(body)) return 'The Dropbox account is out of space.';
  if (/disallowed_name|malformed_path/.test(body)) return 'Dropbox would not accept that file name.';
  return `Dropbox upload failed (${status}): ${body.slice(0, 200)}`;
}

/**
 * Save a new file into Dropbox (files/upload, up to 150 MB). Never
 * overwrites: a name already taken gets Dropbox's "(1)" rename. Folders on
 * the way are created as needed. Returns the path Dropbox saved it under.
 */
export async function uploadFile(path: string, bytes: Buffer | Uint8Array): Promise<{ pathDisplay: string; id: string }> {
  const res = await dropboxFetch('https://content.dropboxapi.com/2/files/upload', (token) => ({
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': dropboxApiArg({ path, mode: 'add', autorename: true, mute: true }),
    },
    body: bytes as any,
  }));

  if (!res.ok) {
    throw new Error(dropboxUploadErrorText(res.status, await res.text()));
  }
  const meta = await res.json();
  return { pathDisplay: meta.path_display || path, id: meta.id };
}

// ── Upload session (Client Files uploads, any size) ──
// The browser sends a file in pieces small enough for a Vercel function
// body, and each piece goes on to Dropbox here: start, append, then finish
// with where it goes. Never overwrites, the same as uploadFile.

async function sessionCall(url: string, arg: unknown, bytes: Buffer | Uint8Array): Promise<Response> {
  const res = await dropboxFetch(url, (token) => ({
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': dropboxApiArg(arg),
    },
    body: bytes as any,
  }));
  if (!res.ok) throw new Error(dropboxUploadErrorText(res.status, await res.text()));
  return res;
}

/** Start an upload session with the file's first piece. Returns the session id. */
export async function uploadSessionStart(bytes: Buffer | Uint8Array): Promise<string> {
  const res = await sessionCall('https://content.dropboxapi.com/2/files/upload_session/start', { close: false }, bytes);
  const data = await res.json();
  if (!data?.session_id) throw new Error('Dropbox returned no upload session');
  return data.session_id as string;
}

/** Add the next piece; offset is how many bytes Dropbox already has. */
export async function uploadSessionAppend(sessionId: string, offset: number, bytes: Buffer | Uint8Array): Promise<void> {
  await sessionCall('https://content.dropboxapi.com/2/files/upload_session/append_v2',
    { cursor: { session_id: sessionId, offset }, close: false }, bytes);
}

/** Save the session's bytes at `path` (a taken name gets Dropbox's "(1)" rename). */
export async function uploadSessionFinish(sessionId: string, offset: number, path: string): Promise<DropboxListEntry> {
  const res = await sessionCall('https://content.dropboxapi.com/2/files/upload_session/finish', {
    cursor: { session_id: sessionId, offset },
    commit: { path, mode: 'add', autorename: true, mute: false },
  }, new Uint8Array(0));
  const entry = toListEntry({ '.tag': 'file', ...(await res.json()) });
  if (!entry) throw new Error('Dropbox did not say where it saved the file');
  return entry;
}
