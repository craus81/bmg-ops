import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { findUnsubscribeToken, recordUnsubscribe, maskEmail } from '@/lib/email-unsubscribe';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * Marketing-email unsubscribe (migration 437). Public: the token in the
 * footer link is the credential, and all it can do is opt its own address
 * out. GET tells the page whose link it is (masked); POST opts out. The
 * same POST takes a mail client's one-click request (RFC 8058: form body
 * "List-Unsubscribe=One-Click", no cookies, no page).
 */

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  if (!(await checkRateLimit(getRequestIp(req), 'unsubscribe_view', 60, 15 * 60 * 1000))) {
    return NextResponse.json({ error: 'Too many tries. Wait a few minutes and try again.' }, { status: 429 });
  }
  const { token } = params;
  const row = await findUnsubscribeToken(service, token);
  if (!row) return NextResponse.json({ status: 'invalid' }, { status: 404 });
  return NextResponse.json({
    status: row.unsubscribed_at ? 'unsubscribed' : 'ready',
    email: maskEmail(row.email),
  });
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  if (!(await checkRateLimit(getRequestIp(req), 'unsubscribe', 30, 15 * 60 * 1000))) {
    return NextResponse.json({ error: 'Too many tries. Wait a few minutes and try again.' }, { status: 429 });
  }
  const { token } = params;
  const row = await findUnsubscribeToken(service, token);
  if (!row) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  const type = req.headers.get('content-type') || '';
  const oneClick = type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data');
  try {
    await recordUnsubscribe(service, row, oneClick ? 'one_click' : 'page');
  } catch (err: any) {
    console.error('[unsubscribe]', err?.message || err);
    return NextResponse.json({ error: 'That didn\'t go through. Try again, or reply to the email and ask us to stop.' }, { status: 500 });
  }
  return NextResponse.json({ status: 'unsubscribed', email: maskEmail(row.email) });
}
