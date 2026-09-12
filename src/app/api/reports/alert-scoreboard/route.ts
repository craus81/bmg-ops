import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { loadScoreboard } from '@/lib/alert-scoreboard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/alert-scoreboard?days=30 (R6-13) — which notification
 * types earn their place, and which staff cannot receive a push.
 *
 * Admin: it reads every user's notification rows and names the people with
 * no registered device, which is staff data rather than anyone's own.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const raw = Number(req.nextUrl.searchParams.get('days') || 30);
  const days = [30, 90].includes(raw) ? raw : 30;

  try {
    return NextResponse.json(await loadScoreboard(service, days));
  } catch (e: any) {
    console.error('alert scoreboard failed:', e);
    return NextResponse.json({ error: 'Could not build the scoreboard.' }, { status: 500 });
  }
}
