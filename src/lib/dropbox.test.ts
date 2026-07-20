import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Tests for the Dropbox client's token lifecycle: refresh on expiry,
// forced refresh + retry when Dropbox 401s a token we thought was valid,
// and surfacing "not connected" when recovery isn't possible.

const store: { tokens: any; upserts: any[] } = { tokens: null, upserts: [] };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: store.tokens ? { value: store.tokens } : null }),
        }),
      }),
      upsert: async (row: any) => {
        store.upserts.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { searchFiles, getAccessToken } from './dropbox';

const ENV = {
  DROPBOX_APP_KEY: 'app-key',
  DROPBOX_APP_SECRET: 'app-secret',
  NEXT_PUBLIC_SUPABASE_URL: 'https://sb.example.com',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
};

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SEARCH_RESULT = {
  matches: [
    {
      metadata: {
        metadata: {
          '.tag': 'file',
          id: 'id:abc',
          name: 'proof.pdf',
          path_display: '/Proofs/Acme/proof.pdf',
          size: 123,
          server_modified: '2026-07-01T00:00:00Z',
        },
      },
    },
  ],
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  store.tokens = null;
  store.upserts = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getAccessToken', () => {
  it('throws "not connected" when no tokens are stored', async () => {
    await expect(getAccessToken()).rejects.toThrow('Dropbox not connected');
  });

  it('throws "not connected" when stored tokens have no refresh token', async () => {
    store.tokens = { access_token: 'legacy', expires_at: Date.now() + 3600_000 };
    await expect(getAccessToken()).rejects.toThrow('Dropbox not connected');
  });

  it('returns the stored token while it is still valid', async () => {
    store.tokens = {
      access_token: 'valid-token',
      refresh_token: 'rt',
      expires_at: Date.now() + 3600_000,
    };
    expect(await getAccessToken()).toBe('valid-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes and persists when the stored token is past expires_at', async () => {
    store.tokens = {
      access_token: 'stale',
      refresh_token: 'rt',
      expires_at: Date.now() - 1000,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'fresh', expires_in: 14400 }));

    expect(await getAccessToken()).toBe('fresh');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.dropboxapi.com/oauth2/token');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');

    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0].value.access_token).toBe('fresh');
    expect(store.upserts[0].value.refresh_token).toBe('rt');
  });

  it('maps a revoked refresh token (invalid_grant) to "not connected"', async () => {
    store.tokens = {
      access_token: 'stale',
      refresh_token: 'revoked',
      expires_at: Date.now() - 1000,
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'invalid_grant', error_description: 'refresh token is invalid' }, 400)
    );
    await expect(getAccessToken()).rejects.toThrow('Dropbox not connected');
  });
});

describe('searchFiles 401 retry', () => {
  it('force-refreshes and retries once when Dropbox rejects a token we thought was valid', async () => {
    store.tokens = {
      access_token: 'believed-valid',
      refresh_token: 'rt',
      expires_at: Date.now() + 3600_000, // not expired by our clock
    };

    fetchMock
      // search with stored token → 401 expired_access_token
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { '.tag': 'expired_access_token' }, error_summary: 'expired_access_token/' },
          401
        )
      )
      // forced refresh
      .mockResolvedValueOnce(jsonResponse({ access_token: 'fresh', expires_in: 14400 }))
      // retried search succeeds
      .mockResolvedValueOnce(jsonResponse(SEARCH_RESULT));

    const results = await searchFiles('acme');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer believed-valid');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.dropboxapi.com/oauth2/token');
    expect(fetchMock.mock.calls[2][1].headers['Authorization']).toBe('Bearer fresh');

    expect(results).toEqual([
      {
        id: 'id:abc',
        name: 'proof.pdf',
        path: '/Proofs/Acme/proof.pdf',
        size: 123,
        modified: '2026-07-01T00:00:00Z',
        folder: 'Acme',
      },
    ]);
  });

  it('does not retry more than once on repeated 401s', async () => {
    store.tokens = {
      access_token: 'believed-valid',
      refresh_token: 'rt',
      expires_at: Date.now() + 3600_000,
    };

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error_summary: 'expired_access_token/' }, 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'fresh', expires_in: 14400 }))
      .mockResolvedValueOnce(jsonResponse({ error_summary: 'invalid_access_token/' }, 401));

    await expect(searchFiles('acme')).rejects.toThrow('Dropbox search failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
