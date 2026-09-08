import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { loadShopWeek, defaultWeekStart, weekStartMonday } from '@/lib/shop-week';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/shop-week?start=YYYY-MM-DD&days=7|14 — the week planner's data
 * (R5-16): per-day arrivals/upfits/promised-backs with sold-hours demand
 * against crew capacity. Staff-wide read; the planner page and the
 * OpsDashboard load strip both consume it.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const params = req.nextUrl.searchParams;
  const rawStart = params.get('start');
  const start = rawStart && /^\d{4}-\d{2}-\d{2}$/.test(rawStart)
    ? weekStartMonday(rawStart)
    : defaultWeekStart();
  const days = params.get('days') === '14' ? 14 : 7;

  try {
    const week = await loadShopWeek(service, start, days);
    return NextResponse.json(week);
  } catch (e) {
    console.error('shop-week load failed:', e);
    return NextResponse.json({ error: 'Failed to load the shop week' }, { status: 500 });
  }
}
