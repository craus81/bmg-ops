import {
  QBO_AUTHORIZE_URL,
  QBO_REVOKE_URL,
  QBO_SCOPE,
  QBO_TOKEN_URL,
  qboApiBase,
  qboConfig,
  type QboEnvironment,
} from './config';

/**
 * The QuickBooks OAuth 2.0 round trip, hand-rolled on fetch.
 *
 * No SDK, matching the Dropbox and Google precedents in this repo: the whole
 * protocol is three form-encoded POSTs, and an SDK would add a dependency
 * whose retry/refresh behaviour we would then have to reason about on top of
 * `tokens.ts`'s lease.
 *
 * Nothing here touches Supabase. Persistence — and the rule that a rotated
 * refresh token is written on EVERY refresh — lives in tokens.ts.
 */

/**
 * Why a token operation failed, in the only two shapes callers act on.
 *
 * A real exported class, not an implied one: `tokens.getAccessToken`
 * branches on `code` — `invalid_grant` means the refresh token is dead and
 * the connection needs a human to re-authorize (so it stamps
 * `needs_reauth_at` and stops), while anything else is a transient failure
 * that must NOT burn the stored refresh token.
 */
export class QboAuthError extends Error {
  constructor(
    public code: 'invalid_grant' | 'refresh_failed',
    public status?: number,
  ) {
    super(`QuickBooks OAuth ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'QboAuthError';
  }
}

export interface TokenGrant {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
  scope?: string;
}

/** The consent URL the admin's browser is redirected to. */
export function buildAuthorizeUrl(state: string): string {
  const cfg = qboConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: QBO_SCOPE,
    // EXACT match against the URI registered in the Intuit app — Intuit
    // compares the string, not the host, so a trailing slash is a rejection.
    redirect_uri: cfg.redirectUri,
    state,
  });
  return `${QBO_AUTHORIZE_URL}?${params.toString()}`;
}

function basicAuth(): string {
  const cfg = qboConfig();
  return 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
}

async function postToken(body: URLSearchParams): Promise<{ status: number; text: string }> {
  const res = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
    cache: 'no-store',
  });
  return { status: res.status, text: await res.text() };
}

function parseGrant(text: string): TokenGrant {
  const json = JSON.parse(text);
  return {
    access_token: String(json.access_token || ''),
    refresh_token: String(json.refresh_token || ''),
    expires_in: Number(json.expires_in) || 3600,
    x_refresh_token_expires_in: Number(json.x_refresh_token_expires_in) || 8_726_400,
    token_type: String(json.token_type || 'Bearer'),
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

/** Authorization code → the first grant. */
export async function exchangeCode(code: string): Promise<TokenGrant> {
  const cfg = qboConfig();
  const { status, text } = await postToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  }));
  if (status < 200 || status >= 300) {
    throw new QboAuthError(/invalid_grant/i.test(text) ? 'invalid_grant' : 'refresh_failed', status);
  }
  const grant = parseGrant(text);
  if (!grant.access_token || !grant.refresh_token) {
    throw new QboAuthError('refresh_failed', status);
  }
  return grant;
}

/**
 * Refresh. The response may carry a NEW refresh token — Intuit rotates them
 * roughly daily — and the previous value stops working the moment it does,
 * so whatever comes back here must be persisted by the caller.
 */
export async function refreshGrant(refreshToken: string): Promise<TokenGrant> {
  const { status, text } = await postToken(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }));
  if (status < 200 || status >= 300) {
    // Intuit returns invalid_grant for a dead/rotated-past refresh token —
    // the one failure a retry can never fix.
    throw new QboAuthError(/invalid_grant/i.test(text) ? 'invalid_grant' : 'refresh_failed', status);
  }
  const grant = parseGrant(text);
  if (!grant.access_token) throw new QboAuthError('refresh_failed', status);
  // A refresh response that omits refresh_token means "keep using the one you
  // have" — echo it back so the caller's unconditional persist is a no-op
  // rather than a write of ''.
  if (!grant.refresh_token) grant.refresh_token = refreshToken;
  return grant;
}

/**
 * Best-effort revoke at Intuit. Disconnect must still clear our row when
 * this fails — a token we cannot revoke is a token we can at least stop
 * holding.
 */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(QBO_REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch (e: any) {
    console.error('[qbo] revoke failed (continuing):', e?.message || e);
  }
}

export type CompanyInfoResult =
  | { ok: true; companyName: string | null; via: 'query' | 'rest' }
  | { ok: false; reason: string; status?: number };

/**
 * The company's display name, for the Connections row and the connect
 * confirmation. BEST EFFORT AND NEVER THROWS: a company whose name we could
 * not read is still a valid connection, and treating a failed probe as a
 * failed connect would throw away tokens Intuit has already issued.
 *
 * Two attempts, because only the first is [H]: the query endpoint is the
 * documented path, and `GET /companyinfo/<realm>` is the [M] REST shape kept
 * as a fallback. The verdict is recorded as `capabilities.companyInfo`.
 */
export async function fetchCompanyInfo(
  accessToken: string,
  environment: QboEnvironment,
  realmId: string,
  minorVersion: string,
  signal: AbortSignal,
): Promise<CompanyInfoResult> {
  const base = qboApiBase(environment, realmId);
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  let lastReason = 'unknown';
  let lastStatus: number | undefined;

  // Attempt 1 [H]: the query endpoint.
  try {
    const url = `${base}/query?query=${encodeURIComponent('SELECT * FROM CompanyInfo')}&minorversion=${encodeURIComponent(minorVersion)}`;
    const res = await fetch(url, { headers, signal, cache: 'no-store' });
    if (res.ok) {
      const body: any = await res.json();
      const row = body?.QueryResponse?.CompanyInfo?.[0];
      if (row) return { ok: true, companyName: row.CompanyName || row.LegalName || null, via: 'query' };
      lastReason = 'query returned no CompanyInfo row';
    } else {
      lastStatus = res.status;
      lastReason = `query returned HTTP ${res.status}`;
    }
  } catch (e: any) {
    lastReason = e?.name === 'TimeoutError' ? 'query timed out' : String(e?.message || e).slice(0, 200);
  }

  // Attempt 2 [probe]: the REST shape.
  try {
    const url = `${base}/companyinfo/${encodeURIComponent(realmId)}?minorversion=${encodeURIComponent(minorVersion)}`;
    const res = await fetch(url, { headers, signal, cache: 'no-store' });
    if (res.ok) {
      const body: any = await res.json();
      const row = body?.CompanyInfo;
      if (row) return { ok: true, companyName: row.CompanyName || row.LegalName || null, via: 'rest' };
      lastReason = 'companyinfo returned no CompanyInfo object';
    } else {
      lastStatus = res.status;
      lastReason = `companyinfo returned HTTP ${res.status}`;
    }
  } catch (e: any) {
    lastReason = e?.name === 'TimeoutError' ? 'companyinfo timed out' : String(e?.message || e).slice(0, 200);
  }

  // `status` is returned so callers can tell an AUTH failure (401 — the token
  // is bad, which is a real problem) from a shape failure (the connection is
  // fine, we just could not read a name).
  return { ok: false, reason: lastReason, status: lastStatus };
}
