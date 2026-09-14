import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { completeConnection } from '@/lib/quickbooks/connect';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/auth/quickbooks/callback — finish the connect.
 *
 * `requireAdmin` runs HERE, in the handler: `/api/auth/*` is public at the
 * middleware, and the redirect back from Intuit rides the connecting
 * admin's own browser session, so their cookies are present. Without it,
 * anyone who could get an admin's browser to deliver a code would rewrite
 * the shared connection row. The `state` nonce is the second wall.
 *
 * Every outcome is a REDIRECT to the ledger page with a named reason —
 * docs/quickbooks-connect.md §4 lists what each one means — rather than a
 * JSON body the admin's browser would render as raw text.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) {
    return NextResponse.redirect(
      new URL(deepLinks.ledgerAdmin({ qboAuth: 'error', reason: 'forbidden' }), req.url),
    );
  }

  const params = req.nextUrl.searchParams;
  const providerError = params.get('error');
  if (providerError) {
    return NextResponse.redirect(
      new URL(deepLinks.ledgerAdmin({ qboAuth: 'error', reason: providerError }), req.url),
    );
  }

  const code = params.get('code') || '';
  const realmId = params.get('realmId') || '';
  const state = params.get('state') || '';
  if (!realmId) {
    return NextResponse.redirect(
      new URL(deepLinks.ledgerAdmin({ qboAuth: 'error', reason: 'missing_realm' }), req.url),
    );
  }

  try {
    const result = await completeConnection(createServiceClient(), {
      code,
      realmId,
      state,
      userId: auth.user.id,
    });
    if (!result.ok) {
      return NextResponse.redirect(
        new URL(deepLinks.ledgerAdmin({ qboAuth: 'error', reason: result.reason }), req.url),
      );
    }
    // A failed CompanyInfo probe is NOT a failed connect — the tokens are
    // stored and valid, the page simply shows "company name unavailable".
    return NextResponse.redirect(new URL(deepLinks.ledgerAdmin({ qboAuth: 'success' }), req.url));
  } catch (e: any) {
    console.error('[qbo] callback failed:', e?.message || e);
    return NextResponse.redirect(
      new URL(deepLinks.ledgerAdmin({ qboAuth: 'error', reason: 'exchange_failed' }), req.url),
    );
  }
}
