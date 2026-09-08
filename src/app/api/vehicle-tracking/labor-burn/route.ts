import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { loadBurnForCheckins } from '@/lib/labor-burn';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** Statuses still on the floor — a shipped vehicle's burn is history, and
 *  the board only badges cards you can still do something about. */
const ON_FLOOR = ['received', 'checked_in', 'in_progress', 'stuck_parts', 'stuck_graphics'];

/**
 * GET /api/vehicle-tracking/labor-burn (R6-12)
 *
 * Labor burn for every vehicle currently on the floor, keyed by check-in id,
 * for the tracking board's badges. Hours and a percentage only — the blended
 * shop COST rate is admin-side job costing and never crosses this wire.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const { data, error } = await fetchAllRows<{ id: string }>((from, to) => service
      .from('fleet_checkins')
      .select('id')
      .in('status', ON_FLOOR)
      .is('archived_at', null)
      .order('id')
      .range(from, to));
    if (error) throw new Error(error.message);

    const burns = await loadBurnForCheckins(service, (data || []).map(r => r.id));
    const out: Record<string, unknown> = {};
    // Only vehicles with something to say — a card with no sold hours gets
    // no badge rather than a grey "unknown" chip on every row.
    for (const [id, b] of burns) {
      if (b.tone !== 'unknown') out[id] = { pct: b.pct, tone: b.tone, label: b.label };
    }
    return NextResponse.json({ burns: out });
  } catch (err: any) {
    console.error('labor-burn board read failed:', err);
    return NextResponse.json({ error: err?.message || 'Failed' }, { status: 500 });
  }
}
