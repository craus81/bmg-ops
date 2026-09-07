import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { loadCompletions, loadOpenCommitments, summarizeOnTime } from '@/lib/on-time';
import { chicagoDay } from '@/lib/exec-metrics';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/on-time (R4-6): did we deliver by the promised-back date?
 *
 * Scorecard over the last N months of completions (default 6, ?months=1-24):
 * overall/monthly/per-customer kept-vs-missed from promised_back_date vs the
 * completion transition in vehicle_status_history, the no-promise count (a
 * discipline number — a promise never recorded can't be kept), and the open
 * commitments currently overdue or due this week. Same lib as the daily
 * promised-back guardian cron.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  try {
    const monthsRaw = parseInt(new URL(req.url).searchParams.get('months') || '6', 10);
    const months = Math.min(24, Math.max(1, Number.isFinite(monthsRaw) ? monthsRaw : 6));
    const today = chicagoDay();
    const [y, m] = today.split('-').map(Number);
    const start = m - (months - 1);
    const sinceDay = `${start <= 0 ? y - 1 : y}-${String(start <= 0 ? start + 12 : start).padStart(2, '0')}-01`;

    const [completions, open] = await Promise.all([
      loadCompletions(supabase, sinceDay),
      loadOpenCommitments(supabase),
    ]);

    const overdue = open.filter(c => c.daysUntil < 0);
    return NextResponse.json({
      sinceDay,
      months,
      ...summarizeOnTime(completions),
      open: {
        total: open.length,
        overdue: overdue.map(c => ({ ...c, daysLate: -c.daysUntil })),
        dueThisWeek: open.filter(c => c.daysUntil >= 0 && c.daysUntil <= 6),
      },
    });
  } catch (err: any) {
    console.error('on-time report failed:', err);
    return NextResponse.json({ error: err?.message || 'Report failed' }, { status: 500 });
  }
}
