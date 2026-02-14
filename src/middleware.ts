import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // Check for Supabase auth cookie (starts with sb-)
  const hasAuthCookie = request.cookies.getAll().some(c => 
    c.name.startsWith('sb-') && c.name.endsWith('-auth-token')
  );

  // Public routes — no auth required
  const isPublic = request.nextUrl.pathname.startsWith('/login')
    || request.nextUrl.pathname.startsWith('/auth')
    || request.nextUrl.pathname.startsWith('/view');

  // If no auth cookie and not on a public route, redirect to login
  if (!hasAuthCookie && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // If has auth cookie and on login page, redirect to app
  if (hasAuthCookie && request.nextUrl.pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/home';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json|icon-.*\\.png).*)'],
};
