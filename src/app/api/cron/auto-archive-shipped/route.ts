import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

// Shipped vehicles stay visible on the board long enough to coordinate
// pickup/delivery questions, then leave on their own. Before this sweep the
// In-Shop board never emptied — archive was an admin-only manual click, so
// returning vehicles double-listed against their own last visit (Round 3,
// §7.2.6).
const ARCHIVE_AFTER_DAYS = 7;

/**
 * Daily sweep: archive vehicles that have been in status 'shipped' for
 * ARCHIVE_AFTER_DAYS+. "When did it ship?" comes from the latest
 * vehicle_status_history row with to_status='shipped'; vehicles with no
 * such row (legacy data) fall back to updated_at, which can only be LATER
 * than the ship moment — so nothing archives early.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const { data: shipped } = await service
      .from('fleet_checkins')
      .select('id, updated_at')
      .eq('status', 'shipped')
      .is('archived_at', null)
      .limit(500);

    const candidates = shipped || [];
    const cutoff = Date.now() - ARCHIVE_AFTER_DAYS * 24 * 3_600_000;

    // Latest shipped-transition per vehicle, chunked (the .in() list rule).
    const shippedAt = new Map<string, number>();
    const ids = candidates.map(v => v.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { data: history } = await service
        .from('vehicle_status_history')
        .select('vehicle_id, created_at')
        .in('vehicle_id', ids.slice(i, i + 200))
        .eq('to_status', 'shipped')
        .order('created_at', { ascending: false });
      for (const h of history || []) {
        if (!shippedAt.has(h.vehicle_id)) {
          shippedAt.set(h.vehicle_id, new Date(h.created_at).getTime());
        }
      }
    }

    const toArchive = candidates
      .filter(v => {
        const t = shippedAt.get(v.id) ?? (v.updated_at ? new Date(v.updated_at).getTime() : Date.now());
        return t < cutoff;
      })
      .map(v => v.id);

    let archived = 0;
    for (let i = 0; i < toArchive.length; i += 200) {
      const slice = toArchive.slice(i, i + 200);
      const { error } = await service
        .from('fleet_checkins')
        .update({ archived_at: new Date().toISOString() })
        .in('id', slice)
        .is('archived_at', null);
      if (!error) archived += slice.length;
    }

    await recordHeartbeat(service, 'auto_archive_shipped', {
      shippedOnBoard: candidates.length,
      archived,
    });

    return NextResponse.json({ success: true, shippedOnBoard: candidates.length, archived });
  } catch (e: any) {
    console.error('auto-archive-shipped failed:', e);
    return NextResponse.json({ error: e.message || 'Sweep failed' }, { status: 500 });
  }
}
