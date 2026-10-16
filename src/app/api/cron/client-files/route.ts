import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { syncClientFiles, type ClientFilesSyncResult } from '@/lib/client-files-sync';
import {
  acquireClientFilesLease, releaseClientFilesLease, requestClientFilesRun, clientFilesRunRequestedAt,
} from '@/lib/client-files-lease';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the sync's own budget is 240 s below.
export const maxDuration = 300;

const BUDGET_MS = 240_000;
/** Another pass for a webhook request needs at least this much time left. */
const MIN_EXTRA_PASS_MS = 30_000;

/**
 * GET /api/cron/client-files — every 10 minutes (:04, :14, … :54).
 *
 * Keeps the Client Files copy of Dropbox /OFFICE/Clients in step (migration
 * 378, src/lib/client-files-sync.ts): new, changed, moved and deleted files,
 * folder-to-customer matching, and copies of PDFs and photos into R2. The
 * first runs walk the whole folder and copy its history a batch at a time,
 * picking up where the last one stopped; after that a run only reads what
 * changed. The minutes ending in 4 were free in vercel.json.
 *
 * The Dropbox webhook (/api/webhooks/dropbox) also starts this route the
 * moment something changes. One run at a time holds a lease
 * (src/lib/client-files-lease.ts); a call that finds it held leaves a
 * request instead, and the running sync does one more pass for it.
 */
export async function GET(req: NextRequest) {
  // Vercel Cron with the shared secret; anyone else needs an admin session.
  // Fails closed if CRON_SECRET is not configured.
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const startedAt = Date.now();
  const deadline = startedAt + BUDGET_MS;
  const service = createServiceClient();
  try {
    if (!(await acquireClientFilesLease(service, BUDGET_MS + 60_000))) {
      await requestClientFilesRun(service);
      return NextResponse.json({ clientFiles: { skipped: 'another sync is running; it will pick this up' } });
    }
    const passes: ClientFilesSyncResult[] = [];
    try {
      for (;;) {
        const passStart = Date.now();
        passes.push(await syncClientFiles(service, { deadline }));
        const requested = await clientFilesRunRequestedAt(service);
        if (!requested || requested < passStart || Date.now() > deadline - MIN_EXTRA_PASS_MS) break;
      }
    } finally {
      await releaseClientFilesLease(service);
    }
    return NextResponse.json({ clientFiles: passes.length === 1 ? passes[0] : passes });
  } catch (e: any) {
    // The sync records its own outcome; this is the last resort for a thrown bug.
    console.error('[client-files] sync threw:', e?.message || e);
    return NextResponse.json({ clientFiles: { error: e?.message || 'sync failed' } }, { status: 500 });
  }
}
