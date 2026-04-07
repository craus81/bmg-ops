import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const PUBLIC_PATHS = ['/login', '/auth', '/api/auth', '/api/messages/twilio-webhook', '/view', '/cni/onboard'];
const CRON_PATHS = ['/api/gmail/auto-import'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static files and Next.js internals
  if (pathname.startsWith('/_next') || pathname.startsWith('/icon') || pathname.startsWith('/manifest') || pathname.startsWith('/sw.js') || pathname.startsWith('/pdf.worker')) {
    return NextResponse.next();
  }

  // Allow cron jobs with valid secret
  if (CRON_PATHS.some(p => pathname.startsWith(p))) {
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      return NextResponse.next();
    }
    // Also allow if manual trigger with valid session (checked below)
  }

  // Check for Supabase session via cookies
  const cookies = request.cookies;
  let hasSession = false;

  for (const cookie of cookies.getAll()) {
    if (cookie.name.includes('sb-') && cookie.name.includes('auth-token')) {
      if (cookie.value && cookie.value.length > 20) {
        hasSession = true;
        break;
      }
    }
  }

  if (!hasSession) {
    // API routes return 401
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // Page routes redirect to login
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all routes except static files
    '/((?!_next/static|_next/image|favicon.ico|icon.*|manifest.json|sw.js|pdf.worker.*).*)',
  ],
};
