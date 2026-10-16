import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { verifyDropboxSignature, requestClientFilesRun } from '@/lib/client-files-lease';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

/**
 * Dropbox webhook: "something changed in the account" (Craig, 2026-10-16:
 * new proofs should show in Client Files within seconds, not up to 10
 * minutes). Registered once in the Dropbox App Console under Webhooks with
 * https://go.bmgfleet.com/api/webhooks/dropbox.
 *
 * GET is Dropbox's one-time check: echo ?challenge back as plain text.
 * POST carries no file details, only account ids, and must answer within
 * 10 seconds, so it records a request and starts the Client Files sync
 * (/api/cron/client-files) without waiting for it; that route holds a lease,
 * so a burst of alerts runs one sync at a time. The 10-minute cron stays as
 * the backup for a missed alert.
 *
 * verifyDropboxSignature is the credential check (HMAC with
 * DROPBOX_APP_SECRET) and fails closed.
 */
export async function GET(req: NextRequest) {
  const challenge = req.nextUrl.searchParams.get('challenge') || '';
  return new NextResponse(challenge, {
    headers: { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifyDropboxSignature(raw, req.headers.get('x-dropbox-signature'), process.env.DROPBOX_APP_SECRET)) {
    return NextResponse.json({ error: 'Bad signature' }, { status: 403 });
  }

  try {
    await requestClientFilesRun(createServiceClient());
  } catch (e: any) {
    console.error('[dropbox-webhook] request failed:', e?.message || e);
  }

  // Start the sync and let it run on its own; only the request needs to go out.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    try {
      await fetch(new URL('/api/cron/client-files?trigger=webhook', req.nextUrl.origin), {
        headers: { Authorization: `Bearer ${cronSecret}` },
        signal: AbortSignal.timeout(2_000),
      });
    } catch { /* timing out here is expected: the sync keeps going */ }
  }
  return NextResponse.json({ ok: true });
}
