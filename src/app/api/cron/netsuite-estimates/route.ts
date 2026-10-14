import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { syncNetsuiteEstimates } from '@/lib/netsuite-estimate-sync';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the copy's own budget is 240 s below.
export const maxDuration = 300;

const BUDGET_MS = 240_000;

/**
 * GET /api/cron/netsuite-estimates — :09 on odd UTC hours.
 *
 * Copies NetSuite estimates into netsuite_estimates (migration 372,
 * src/lib/netsuite-estimate-sync.ts) so the top bar finds estimates made in
 * NetSuite. Its own route rather than a phase of netsuite-sync, which
 * already fills its 120 s; minute 9 on odd hours is free in vercel.json and
 * stays clear of the even-hour NetSuite jobs. The first runs work through
 * the whole history, a page at a time, picking up where the last stopped.
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
  try {
    const result = await syncNetsuiteEstimates(createServiceClient(), { deadline: startedAt + BUDGET_MS });
    return NextResponse.json({ estimates: result });
  } catch (e: any) {
    // The sync records its own outcome; this is the last resort for a thrown bug.
    console.error('[netsuite-estimates] sync threw:', e?.message || e);
    return NextResponse.json({ estimates: { error: e?.message || 'sync failed' } }, { status: 500 });
  }
}
