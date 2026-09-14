import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import { assertEnvironmentPairing, maskRealm, qboConfig } from './config';
import { exchangeCode, fetchCompanyInfo } from './oauth';
import { consumeState } from './oauth-state';
import { setCompanyName, storeConnection, updateCapabilities } from './tokens';

/**
 * The OAuth callback's logic, lifted out of the route so it is testable
 * without importing a `route.ts`.
 *
 * The ordering here is the whole design. By the time Intuit redirects back,
 * it has ALREADY issued (and possibly rotated) tokens for this realm — so
 * `storeConnection` runs BEFORE the CompanyInfo probe. Probing first and
 * treating a failure as a failed connect would throw away live credentials
 * and leave the app disconnected from a company Intuit thinks is connected.
 * A missing company name is cosmetic; a missing refresh token is a support
 * call.
 */

export type ConnectFailure =
  | 'state_mismatch'
  | 'expired'
  | 'user_mismatch'
  | 'forbidden'
  | 'exchange_failed'
  | 'another_realm_connected'
  | 'sandbox_on_production'
  | 'production_off_production'
  | 'missing_realm';

export type ConnectResult =
  | { ok: true; existed: boolean; companyName: string | null; companyInfoProbe: 'ok' | 'failed' }
  | { ok: false; reason: ConnectFailure };

export async function completeConnection(
  service: SupabaseClient,
  input: { code: string; realmId: string; state: string; userId: string },
): Promise<ConnectResult> {
  if (!input.realmId) return { ok: false, reason: 'missing_realm' };

  const consumed = await consumeState(service, input.state, input.userId);
  if (!consumed.ok) {
    return {
      ok: false,
      reason:
        consumed.reason === 'expired'
          ? 'expired'
          : consumed.reason === 'user_mismatch'
            ? 'user_mismatch'
            : 'state_mismatch',
    };
  }

  // The environment the ADMIN started in, not whatever the env says now.
  try {
    assertEnvironmentPairing(consumed.environment);
  } catch (e: any) {
    const reason = e?.message === 'sandbox_on_production' ? 'sandbox_on_production' : 'production_off_production';
    return { ok: false, reason };
  }

  // One realm per app row. Swapping companies would orphan every imported
  // `ledger_*` row against a realm that no longer matches the connection, so
  // it takes a deliberate Disconnect first.
  const { data: existing } = await service
    .from('quickbooks_tokens')
    .select('realm_id')
    .eq('id', 1)
    .maybeSingle();
  if (existing?.realm_id && String(existing.realm_id) !== String(input.realmId)) {
    return { ok: false, reason: 'another_realm_connected' };
  }

  const cfg = qboConfig();
  let grant;
  try {
    grant = await exchangeCode(input.code);
  } catch (e: any) {
    console.error('[qbo] code exchange failed:', e?.message || e);
    return { ok: false, reason: 'exchange_failed' };
  }

  const { existed } = await storeConnection(service, {
    realmId: input.realmId,
    environment: consumed.environment,
    companyName: null,
    grant,
    connectedBy: input.userId,
    minorVersion: cfg.minorVersion,
  });

  // Best effort, after the tokens are safe. A failure here is recorded as a
  // capability, not raised: "company name unavailable" is what the runbook
  // tells the owner to expect, and the connection is valid either way.
  let companyName: string | null = null;
  let companyInfoProbe: 'ok' | 'failed' = 'failed';
  const probe = await fetchCompanyInfo(
    grant.access_token,
    consumed.environment,
    input.realmId,
    cfg.minorVersion,
    AbortSignal.timeout(8_000),
  );
  if (probe.ok) {
    companyName = probe.companyName;
    companyInfoProbe = 'ok';
    await setCompanyName(service, companyName);
    await updateCapabilities(service, { companyInfo: true });
  } else {
    await updateCapabilities(service, { companyInfo: false });
  }

  await logAudit(service, {
    // AuditEntry.actorId is required; a connect always has a session user
    // (the route calls requireAdmin itself).
    actorId: input.userId,
    table: 'quickbooks_tokens',
    recordId: '1',
    action: existed ? 'qbo_reconnected' : 'qbo_connected',
    // Masked realm only — the full id lives in exactly one column.
    detail: {
      realmMasked: maskRealm(input.realmId),
      companyName,
      environment: consumed.environment,
      companyInfoProbe,
    },
  });

  return { ok: true, existed, companyName, companyInfoProbe };
}
