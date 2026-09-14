/**
 * QuickBooks Online — endpoints, app credentials, and the sandbox wall.
 *
 * Everything here is pure and synchronous: no network, no Supabase. The
 * endpoints are the [H]-confidence facts from docs/quickbooks-connect.md;
 * anything the API might disagree with is probed at runtime by client.ts and
 * recorded in `quickbooks_tokens.capabilities`, never asserted here.
 *
 * The one rule with teeth is `assertEnvironmentPairing` (owner item 22): a
 * QuickBooks SANDBOX realm carries fake money and a PRODUCTION realm carries
 * the company's real books. Connecting either to the wrong deployment writes
 * one into the other's ledger, and the ledger tables have no "this row was a
 * test" column — the only defence is refusing the handshake.
 */

export type QboEnvironment = 'production' | 'sandbox';

/**
 * The minor version pinned on every call. QuickBooks changes response shapes
 * between minor versions, so an unpinned call would silently start returning
 * a different envelope on Intuit's schedule. Override with QBO_MINOR_VERSION.
 */
export const QBO_DEFAULT_MINOR_VERSION = '73';

/**
 * The production Supabase project ref. Same literal as
 * scripts/seed-sandbox.mjs's PRODUCTION_REF, and config.test.ts asserts the
 * two stay equal — a fork of this constant is how the sandbox wall quietly
 * stops meaning anything.
 */
export const PRODUCTION_SUPABASE_REF = 'jdwoceryzhbimjmtwrpr';

export const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

/**
 * There is NO read-only accounting scope at Intuit. Read-only is a property
 * of this code — the client only ever issues GET/query/report/pdf calls and
 * exposes no mutating method at all — not of the grant.
 */
export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';

/** Are the three keys the handshake needs present? */
export function qboConfigured(): boolean {
  return !!(
    (process.env.QBO_CLIENT_ID || '').trim() &&
    (process.env.QBO_CLIENT_SECRET || '').trim() &&
    (process.env.QBO_REDIRECT_URI || '').trim()
  );
}

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: QboEnvironment;
  minorVersion: string;
}

/**
 * The app credentials. Throws when QBO_ENVIRONMENT is set to something that
 * is neither value: a typo there would otherwise silently fall back to
 * 'production' and point a sandbox connect at the real Intuit host.
 */
export function qboConfig(): QboConfig {
  const raw = (process.env.QBO_ENVIRONMENT || '').trim().toLowerCase();
  if (raw && raw !== 'production' && raw !== 'sandbox') {
    throw new Error('QBO_ENVIRONMENT must be production or sandbox');
  }
  return {
    clientId: (process.env.QBO_CLIENT_ID || '').trim(),
    clientSecret: (process.env.QBO_CLIENT_SECRET || '').trim(),
    redirectUri: (process.env.QBO_REDIRECT_URI || '').trim(),
    environment: (raw || 'production') as QboEnvironment,
    minorVersion: (process.env.QBO_MINOR_VERSION || '').trim() || QBO_DEFAULT_MINOR_VERSION,
  };
}

/** `https://…/v3/company/<realm>` — no trailing slash; client.ts joins paths. */
export function qboApiBase(environment: QboEnvironment, realmId: string): string {
  const host = environment === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  return `${host}/v3/company/${encodeURIComponent(realmId)}`;
}

/** The Supabase project ref from its URL, or null when the URL is not one. */
export function supabaseRef(url = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  const m = /^https:\/\/([a-z0-9-]+)\.supabase\.co/i.exec((url || '').trim());
  return m ? m[1].toLowerCase() : null;
}

export interface PairingContext {
  vercelEnv: string | undefined;
  netsuiteConfigured: boolean;
  ref: string | null;
}

/**
 * Refuse a QuickBooks realm that does not belong to this deployment.
 *
 * SANDBOX is refused whenever ANY of three discriminators say the deployment
 * is (or shares a database with) production: `VERCEL_ENV === 'production'`,
 * a NetSuite credential in the environment, or the production Supabase ref.
 * Owner item 22 is absolute, so the three are OR'd rather than weighed.
 *
 * The `vercelEnv` clause has a known cost, documented in
 * docs/quickbooks-connect.md §7: a sandbox hosted as its OWN Vercel project
 * also reports VERCEL_ENV='production' and is refused even though it carries
 * no production secret. That is deliberate belt-and-braces — the fix is to
 * connect the sandbox realm from the local `npm run dev` sandbox
 * (docs/sandbox-setup.md), where VERCEL_ENV is unset, not to relax the check.
 *
 * PRODUCTION is refused anywhere the Supabase ref is not production's: real
 * books must not land in a scratch database that someone will later reset.
 */
export function assertEnvironmentPairing(
  env: QboEnvironment,
  ctx: PairingContext = {
    vercelEnv: process.env.VERCEL_ENV,
    netsuiteConfigured: !!process.env.NETSUITE_ACCOUNT_ID || !!process.env.NETSUITE_TOKEN_ID,
    ref: supabaseRef(),
  },
): void {
  if (env === 'sandbox') {
    if (
      ctx.vercelEnv === 'production' ||
      ctx.netsuiteConfigured ||
      ctx.ref === PRODUCTION_SUPABASE_REF
    ) {
      throw new Error('sandbox_on_production');
    }
    return;
  }
  if (ctx.ref !== PRODUCTION_SUPABASE_REF) {
    throw new Error('production_off_production');
  }
}

/**
 * The ONLY form of a realm id allowed out of tokens.ts. Everything else —
 * `ledger_import_runs.realm_id`, audit details, API responses, the
 * Connections row — carries this, never the full id (spec §0 Secrets).
 */
export function maskRealm(realmId: string | null | undefined): string {
  const v = String(realmId ?? '').trim();
  if (!v) return '';
  return '…' + v.slice(-4);
}
