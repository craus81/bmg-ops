import type { SupabaseClient } from '@supabase/supabase-js';
import { qboConfig, type QboEnvironment } from './config';
import { QboAuthError, refreshGrant, type TokenGrant } from './oauth';
import type { QboCapabilities } from './client';

/**
 * The single QuickBooks connection row (`quickbooks_tokens`, id = 1).
 *
 * This is the ONLY module that reads or writes a token value or a full realm
 * id. Everything downstream gets `maskRealm()`'d output, and no route, log,
 * audit row or notification ever carries either (spec §0 Secrets).
 *
 * The hard part is refresh. Intuit ROTATES the refresh token — the previous
 * value dies the moment a new one is issued — and this app runs many
 * concurrent lambdas (an import chunk, the daily sync, a Connections probe).
 * Two of them refreshing at once means one persists a token the other has
 * already invalidated, and the connection dies until a human reconnects. So
 * refresh is serialized on a LEASE claimed in the database BEFORE the token
 * POST, and the loser waits for the winner's result instead of racing it.
 */

export const NO_QBO_TOKEN = 'NO_QBO_TOKEN';
export const QBO_TOKEN_READ_FAILED = 'QBO_TOKEN_READ_FAILED';
export const QBO_NOT_CONNECTED = 'QBO_NOT_CONNECTED';
export const QBO_REFRESH_BUSY = 'QBO_REFRESH_BUSY';
export const QBO_ENVIRONMENT_MISMATCH = 'QBO_ENVIRONMENT_MISMATCH';

/**
 * Is this a "the connection is not usable" error rather than a bug? Routes
 * answer these with a needsAuth 401 or a retryable partial, never a 500.
 */
export function isQboTokenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    msg === NO_QBO_TOKEN ||
    msg === QBO_NOT_CONNECTED ||
    msg === QBO_REFRESH_BUSY ||
    msg === QBO_ENVIRONMENT_MISMATCH ||
    // READ_FAILED carries the Postgres message after a colon.
    msg.startsWith(QBO_TOKEN_READ_FAILED)
  );
}

export interface QboConnection {
  realmId: string;
  environment: QboEnvironment;
  companyName: string | null;
  accessToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  minorVersion: string | null;
  needsReauthAt: string | null;
  capabilities: QboCapabilities;
}

const ROW_COLUMNS =
  'id, realm_id, environment, company_name, access_token, access_expires_at, refresh_token, refresh_expires_at, minor_version, needs_reauth_at, refresh_lease_until, capabilities';

/** Refresh once the access token is within this of expiry. */
const EXPIRY_SKEW_MS = 60_000;
/** How long a refresh lease is held before another caller may steal it. */
const LEASE_MS = 90_000;
/** Loser poll: 6 × 1.5 s ≈ 9 s, comfortably longer than a token POST. */
const LOSER_WAIT_MS = 1_500;
const LOSER_ATTEMPTS = 6;

function toConnection(row: any): QboConnection {
  return {
    realmId: String(row.realm_id),
    environment: row.environment as QboEnvironment,
    companyName: row.company_name ?? null,
    accessToken: String(row.access_token || ''),
    accessExpiresAt: row.access_expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    minorVersion: row.minor_version ?? null,
    needsReauthAt: row.needs_reauth_at ?? null,
    capabilities: (row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : {}) as QboCapabilities,
  };
}

async function readRow(service: SupabaseClient): Promise<any> {
  // One retry: this row gates every import chunk, and a single transient
  // PostgREST hiccup should not fail a 45-second unit of work.
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await service
      .from('quickbooks_tokens')
      .select(ROW_COLUMNS)
      .eq('id', 1)
      .maybeSingle();
    if (!error) return data;
    if (attempt >= 1) throw new Error(`${QBO_TOKEN_READ_FAILED}: ${error.message}`);
    await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The stored connection, or a named refusal.
 *
 * The environment check is not paranoia: `QBO_ENVIRONMENT` is a redeployable
 * env var and the realm is a stored row, so flipping the first without
 * reconnecting would silently point production code at a sandbox company's
 * books (or the reverse). Refuse and say so.
 */
export async function readConnection(service: SupabaseClient): Promise<QboConnection> {
  const row = await readRow(service);
  if (!row) throw new Error(NO_QBO_TOKEN);
  if (row.needs_reauth_at) throw new Error(QBO_NOT_CONNECTED);
  if (row.environment !== qboConfig().environment) throw new Error(QBO_ENVIRONMENT_MISMATCH);
  return toConnection(row);
}

/**
 * A usable access token, refreshing if needed.
 *
 * The lease is claimed BEFORE the network call, with the freshness predicate
 * in the UPDATE's own WHERE clause — `refresh_lease_until IS NULL OR <
 * now` — so the database, not the caller, decides who wins. A caller that
 * gets zero rows back did not win and must not POST.
 *
 * The claim RETURNS the row, and that returned copy is the only one the
 * refresh may use. Reading the row before the claim and POSTing that copy
 * afterwards is a lost-update waiting to happen: A reads (refresh_token R1),
 * B claims, rotates to R2 and releases, then A claims the now-free lease and
 * POSTs the dead R1. Intuit answers invalid_grant for a rotated-past token,
 * which would stamp needs_reauth_at and take every surface red until someone
 * reconnects — on a connection that was never actually broken. Since the
 * UPDATE ... RETURNING is atomic, the row it hands back already carries
 * whatever B committed.
 */
export async function getAccessToken(
  service: SupabaseClient,
  opts?: { forceRefresh?: boolean },
): Promise<{ token: string; conn: QboConnection }> {
  const row = await readRow(service);
  if (!row) throw new Error(NO_QBO_TOKEN);
  if (row.needs_reauth_at) throw new Error(QBO_NOT_CONNECTED);
  if (row.environment !== qboConfig().environment) throw new Error(QBO_ENVIRONMENT_MISMATCH);

  const fresh = (r: any) =>
    r.access_token && new Date(r.access_expires_at).getTime() > Date.now() + EXPIRY_SKEW_MS;
  if (!opts?.forceRefresh && fresh(row)) {
    return { token: String(row.access_token), conn: toConnection(row) };
  }

  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimError } = await service
    .from('quickbooks_tokens')
    .update({ refresh_lease_until: new Date(Date.now() + LEASE_MS).toISOString() })
    .eq('id', 1)
    .or(`refresh_lease_until.is.null,refresh_lease_until.lt.${nowIso}`)
    .select('*');
  if (claimError) throw new Error(`${QBO_TOKEN_READ_FAILED}: ${claimError.message}`);

  if (!claimed || claimed.length === 0) {
    // Someone else is refreshing. Wait for their write rather than issuing a
    // second POST that would rotate the token out from under them.
    for (let i = 0; i < LOSER_ATTEMPTS; i++) {
      await sleep(LOSER_WAIT_MS);
      const again = await readRow(service);
      if (!again) throw new Error(NO_QBO_TOKEN);
      if (again.needs_reauth_at) throw new Error(QBO_NOT_CONNECTED);
      if (fresh(again)) return { token: String(again.access_token), conn: toConnection(again) };
    }
    throw new Error(QBO_REFRESH_BUSY);
  }

  // The post-claim state, not the copy read at the top of this function.
  const held = (claimed[0] || row) as typeof row;
  if (held.needs_reauth_at) throw new Error(QBO_NOT_CONNECTED);

  // Another caller refreshed between our read and our claim: their token is
  // good, so release the lease and use it rather than rotating again.
  if (!opts?.forceRefresh && fresh(held)) {
    await service
      .from('quickbooks_tokens')
      .update({ refresh_lease_until: null, updated_at: new Date().toISOString() })
      .eq('id', 1);
    return { token: String(held.access_token), conn: toConnection(held) };
  }

  try {
    const grant = await refreshGrant(String(held.refresh_token));
    const now = Date.now();
    const patch = {
      access_token: grant.access_token,
      // Minus the skew: the stored expiry is when WE stop trusting it, which
      // is a minute before Intuit does, so a call never starts on a token
      // that dies in flight.
      access_expires_at: new Date(now + grant.expires_in * 1000 - EXPIRY_SKEW_MS).toISOString(),
      // ALWAYS overwritten. Intuit rotates; the previous value is dead.
      refresh_token: grant.refresh_token,
      refresh_expires_at: new Date(now + grant.x_refresh_token_expires_in * 1000).toISOString(),
      refreshed_at: new Date(now).toISOString(),
      refresh_lease_until: null as string | null,
      last_error: null as string | null,
      updated_at: new Date(now).toISOString(),
    };
    const { error: writeError } = await service.from('quickbooks_tokens').update(patch).eq('id', 1);
    if (writeError) throw new Error(`${QBO_TOKEN_READ_FAILED}: ${writeError.message}`);
    return {
      token: grant.access_token,
      conn: toConnection({ ...held, ...patch }),
    };
  } catch (e: any) {
    if (e instanceof QboAuthError && e.code === 'invalid_grant') {
      // The refresh token is gone for good — 100 idle days, a revoke at
      // Intuit, or a rotation we lost. Record it so every surface says
      // "reconnect" instead of retrying forever.
      await service
        .from('quickbooks_tokens')
        .update({
          needs_reauth_at: new Date().toISOString(),
          last_error: 'refresh token rejected (invalid_grant) — reconnect QuickBooks',
          refresh_lease_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', 1);
      throw new Error(QBO_NOT_CONNECTED);
    }
    // Transient: drop the lease so the next caller may try, and let the
    // original error travel.
    await service
      .from('quickbooks_tokens')
      .update({ refresh_lease_until: null, updated_at: new Date().toISOString() })
      .eq('id', 1);
    throw e;
  }
}

/**
 * Store a completed handshake. Clears every "this connection is broken"
 * marker, because it demonstrably is not any more.
 */
export async function storeConnection(
  service: SupabaseClient,
  row: {
    realmId: string;
    environment: QboEnvironment;
    companyName: string | null;
    grant: TokenGrant;
    connectedBy: string;
    minorVersion: string;
  },
): Promise<{ existed: boolean }> {
  const { data: before } = await service
    .from('quickbooks_tokens')
    .select('id')
    .eq('id', 1)
    .maybeSingle();
  const now = Date.now();
  const { error } = await service.from('quickbooks_tokens').upsert(
    {
      id: 1,
      realm_id: row.realmId,
      environment: row.environment,
      company_name: row.companyName,
      access_token: row.grant.access_token,
      access_expires_at: new Date(now + row.grant.expires_in * 1000 - EXPIRY_SKEW_MS).toISOString(),
      refresh_token: row.grant.refresh_token,
      refresh_expires_at: new Date(now + row.grant.x_refresh_token_expires_in * 1000).toISOString(),
      scope: row.grant.scope ?? null,
      minor_version: row.minorVersion,
      connected_by: row.connectedBy,
      connected_at: new Date(now).toISOString(),
      refreshed_at: null,
      refresh_lease_until: null,
      needs_reauth_at: null,
      last_error: null,
      updated_at: new Date(now).toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) throw new Error(`Could not store the QuickBooks connection: ${error.message}`);
  return { existed: !!before };
}

/**
 * Merge probe verdicts into `capabilities`. A JSON merge, not a replace: the
 * probes settle at different times (orderById on the first page, pdf per
 * entity type, cdc on the first daily sync) and each must keep the others.
 */
export async function updateCapabilities(
  service: SupabaseClient,
  patch: Partial<QboCapabilities>,
): Promise<void> {
  const { data } = await service
    .from('quickbooks_tokens')
    .select('capabilities')
    .eq('id', 1)
    .maybeSingle();
  const current = (data?.capabilities && typeof data.capabilities === 'object' ? data.capabilities : {}) as QboCapabilities;
  const merged: QboCapabilities = {
    ...current,
    ...patch,
    // Two nested maps that must merge per key rather than being replaced —
    // recording pdf.Invoice=false would otherwise erase pdf.CreditMemo.
    ...(patch.pdf ? { pdf: { ...(current.pdf || {}), ...patch.pdf } } : {}),
    ...(patch.throttle ? { throttle: { ...(current.throttle || { hits: 0 }), ...patch.throttle } } : {}),
    probedAt: new Date().toISOString(),
  };
  const { error } = await service
    .from('quickbooks_tokens')
    .update({ capabilities: merged, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) console.error('[qbo] capabilities merge failed:', error.message);
}

export async function setCompanyName(service: SupabaseClient, companyName: string | null): Promise<void> {
  const { error } = await service
    .from('quickbooks_tokens')
    .update({ company_name: companyName, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) console.error('[qbo] company name write failed:', error.message);
}

/** Disconnect: the row goes, so no token survives the revoke. */
export async function clearConnection(service: SupabaseClient): Promise<void> {
  const { error } = await service.from('quickbooks_tokens').delete().eq('id', 1);
  if (error) throw new Error(`Could not clear the QuickBooks connection: ${error.message}`);
}
