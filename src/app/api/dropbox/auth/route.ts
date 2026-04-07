import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens, isConnected } from '@/lib/dropbox';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * Dropbox OAuth callback — exchanges auth code for tokens.
 * GET /api/dropbox/auth?code=xxx (redirect from Dropbox)
 *
 * Also used to get the authorization URL:
 * GET /api/dropbox/auth?action=url
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const action = req.nextUrl.searchParams.get('action');

  const appKey = process.env.DROPBOX_APP_KEY;
  if (!appKey) {
    return NextResponse.json({ error: 'DROPBOX_APP_KEY not configured' }, { status: 500 });
  }

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/dropbox/auth`;

  // Return the auth URL for the frontend to redirect to
  if (action === 'url') {
    const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${appKey}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&token_access_type=offline`;
    return NextResponse.json({ authUrl });
  }

  // Handle the OAuth callback
  if (code) {
    try {
      await exchangeCodeForTokens(code, redirectUri);
      // Redirect back to the app with a success indicator
      return NextResponse.redirect(new URL('/tracking?dropbox=connected', origin));
    } catch (err: any) {
      console.error('Dropbox auth error:', err);
      return NextResponse.redirect(new URL(`/tracking?dropbox=error&msg=${encodeURIComponent(err.message)}`, origin));
    }
  }

  return NextResponse.json({ error: 'Missing code or action parameter' }, { status: 400 });
}
