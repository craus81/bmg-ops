import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { assertEnvironmentPairing, qboConfig, qboConfigured } from '@/lib/quickbooks/config';
import { mintState } from '@/lib/quickbooks/oauth-state';
import { buildAuthorizeUrl } from '@/lib/quickbooks/oauth';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/auth/quickbooks — start the QuickBooks connect.
 *
 * Admin-gated like the Google and Dropbox equivalents, and for the same
 * reason: the callback writes the SINGLE shared `quickbooks_tokens` row, so
 * an unauthenticated hit could point the whole ledger import at a company
 * the attacker controls. `/api/auth/*` is public at the middleware, which is
 * why the gate is here in the handler.
 *
 * The environment pairing is checked BEFORE the redirect, not only on the
 * way back: sending an admin through Intuit's consent screen only to refuse
 * the result wastes their time and leaves a granted app connection at
 * Intuit's end.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  if (!qboConfigured()) {
    return NextResponse.redirect(
      new URL(deepLinks.ledgerAdmin({ qboAuth: 'error', reason: 'not_configured' }), req.url),
    );
  }

  let environment;
  try {
    ({ environment } = qboConfig());
    assertEnvironmentPairing(environment);
  } catch (e: any) {
    return NextResponse.redirect(
      new URL(deepLinks.ledgerAdmin({ qboAuth: 'error', reason: String(e?.message || 'config_error') }), req.url),
    );
  }

  try {
    const state = await mintState(createServiceClient(), auth.user.id, environment);
    return NextResponse.redirect(buildAuthorizeUrl(state));
  } catch (e: any) {
    console.error('[qbo] could not start the connect:', e?.message || e);
    return NextResponse.redirect(
      new URL(deepLinks.ledgerAdmin({ qboAuth: 'error', reason: 'state_mint_failed' }), req.url),
    );
  }
}
