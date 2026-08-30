import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { getAuthUrl } from '@/lib/google';

/**
 * Kick off the company-Gmail/Calendar OAuth connect (the "Connect Google"
 * buttons on /admin/pos and the proof search). Staff-gated like the
 * matching dropbox/auth route: the callback overwrites the SINGLE shared
 * google_tokens row, so an unauthenticated hit could wipe or replace the
 * mailbox that PO import and the calendar sync read from.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const url = getAuthUrl();
    return NextResponse.redirect(url);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to generate auth URL' }, { status: 500 });
  }
}
