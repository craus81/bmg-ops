import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/auth', '/api/auth', '/api/messages/twilio-webhook', '/view', '/cni/onboard'];
const CRON_PATHS = ['/api/gmail/auto-import'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static files, Next.js internals, and public assets
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/icon') ||
    pathname.startsWith('/manifest') ||
    pathname.startsWith('/sw.js') ||
    pathname.startsWith('/pdf.worker') ||
    pathname.startsWith('/bmg-logo')
  ) {
    return NextResponse.next();
  }

  // Allow cron jobs with valid secret
  if (CRON_PATHS.some(p => pathname.startsWith(p))) {
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      return NextResponse.next();
    }
  }

  // For page routes: let client-side AuthProvider handle protection
  // (Supabase JS stores session in localStorage, not cookies,
  // so middleware can't verify sessions server-side)
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // For API routes: check for auth header or Supabase cookies
  // The requireAuth helper in each route does the real verification.
  // This is a lightweight first-pass to block obviously unauthenticated requests.
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    return NextResponse.next();
  }

  // Check for any Supabase session cookie
  const cookies = request.cookies;
  for (const cookie of cookies.getAll()) {
    if (cookie.name.includes('sb-') || cookie.name.includes('supabase')) {
      if (cookie.value && cookie.value.length > 20) {
        return NextResponse.next();
      }
    }
  }

  // No auth found — but let requireAuth in the route handler make the final call
  // since the browser client sends the token via header, not cookie
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
