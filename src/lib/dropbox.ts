/**
 * Dropbox API Client for FleetSuite
 * Uses OAuth 2.0 with refresh tokens for persistent access.
 * Tokens are stored in Supabase `app_settings` table.
 */

import { createClient } from '@supabase/supabase-js';

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
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
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
  await sb.from('app_settings').upsert({
    key: 'dropbox_tokens',
    value: tokens,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
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

export async function getAccessToken(): Promise<string> {
  const tokens = await getStoredTokens();
  if (!tokens) {
    throw new Error('Dropbox not connected. Please authorize via Settings.');
  }

  // If token is still valid, return it
  if (tokens.expires_at > Date.now()) {
    return tokens.access_token;
  }

  // Refresh the token
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  await storeTokens(refreshed);
  return refreshed.access_token;
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
  const token = await getAccessToken();

  const options: any = {
    path: '',
    max_results: 30,
    file_status: { '.tag': 'active' },
  };

  if (fileExtensions?.length) {
    options.file_categories = [{ '.tag': 'pdf' }];
  }

  const res = await fetch('https://api.dropboxapi.com/2/files/search_v2', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      options,
    }),
  });

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

export async function downloadFile(path: string): Promise<{ buffer: Buffer; name: string; contentType: string }> {
  const token = await getAccessToken();

  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  });

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
  };
}

// ── Check Connection Status ──

export async function isConnected(): Promise<boolean> {
  try {
    const token = await getAccessToken();
    const res = await fetch('https://api.dropboxapi.com/2/check/user', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'fleetsuite' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
