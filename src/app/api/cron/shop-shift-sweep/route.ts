import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';
import { SHOP_SHIFT_MAX_HOURS, SHOP_SHIFT_STALE_HOURS } from '@/lib/shop-labor';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily sweep for forgotten pick-list labor timers (R3-21). A shop shift
 * left open past SHOP_SHIFT_STALE_HOURS gets closed at started_at +
 * SHOP_SHIFT_MAX_HOURS (nobody wrenches a van for 14 straight hours — the
 * cap keeps one forgotten Stop press from booking a phantom double shift),
 * flagged auto_closed so the margin report shows the hours as approximate.
 * Completion closes timers earlier (update-status); this catches vehicles
 * that never completed with a timer running.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  if (!secret || authHeader !== `Bearer ${secret}`) {
    const admin = await requireAdmin(req);
    if (admin.error) return admin.error;
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const staleCutoff = new Date(Date.now() - SHOP_SHIFT_STALE_HOURS * 3_600_000).toISOString();
    const { data: stale, error } = await supabase
      .from('work_shifts')
      .select('id, started_at')
      // R6-6: print-room shifts run on the same timer model, so the same
      // runaway cap applies — nobody laminates for fourteen hours either.
      .in('context', ['shop', 'graphics'])
      .is('ended_at', null)
      .lt('started_at', staleCutoff)
      .limit(200);
    if (error) throw new Error(error.message);

    let closed = 0;
    for (const s of stale || []) {
      const cappedEnd = new Date(Date.parse(s.started_at) + SHOP_SHIFT_MAX_HOURS * 3_600_000).toISOString();
      const { error: closeErr } = await supabase
        .from('work_shifts')
        .update({ ended_at: cappedEnd, auto_closed: true })
        .eq('id', s.id)
        .is('ended_at', null);
      if (closeErr) console.error(`shop-shift-sweep: close failed for ${s.id}:`, closeErr.message);
      else closed++;
    }

    const syncStateWrite = await recordHeartbeat(supabase, 'shop_shift_sweep', { closed });
    return NextResponse.json({ success: true, closed, syncStateWrite });
  } catch (err: any) {
    console.error('shop-shift-sweep failed:', err);
    await recordHeartbeat(supabase, 'shop_shift_sweep', { error: String(err?.message || err).slice(0, 300) }).catch(() => {});
    return NextResponse.json({ error: err?.message || 'Sweep failed' }, { status: 500 });
  }
}
