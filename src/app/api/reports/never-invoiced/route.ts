import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { loadNeverInvoicedQueue, NEVER_INVOICED_WINDOW_DAYS } from '@/lib/never-invoiced';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/never-invoiced (R6-12)
 *
 * The recovery queue behind the dashboard's never-invoiced tile: every
 * completed/shipped vehicle with no invoice anywhere, oldest first,
 * bucketed by what it needs. Same predicate as the tile's count, so the
 * two can never disagree.
 *
 * `?days=` widens/narrows the window (default 180, the tile's window).
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['executive']);
  if (auth.error) return auth.error;

  const raw = Number(req.nextUrl.searchParams.get('days'));
  const windowDays = Number.isFinite(raw) && raw >= 1 && raw <= 1095
    ? Math.floor(raw)
    : NEVER_INVOICED_WINDOW_DAYS;

  try {
    return NextResponse.json(await loadNeverInvoicedQueue(supabase, { windowDays }));
  } catch (err: any) {
    console.error('never-invoiced report failed:', err);
    return NextResponse.json({ error: err?.message || 'Report failed' }, { status: 500 });
  }
}
