import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { isOffTheFloor } from '@/lib/graphics-status';
import type { GraphicsJobStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  /**
   * The COMPLETE work order, top first. Exactly these jobs end up ranked
   * (1..N, in this order) and every other job's rank is cleared — the list
   * the admin is looking at IS the list. Sending [] clears the queue.
   */
  order: z.array(z.string().uuid()).max(500),
});

/**
 * POST /api/graphics-jobs/rank
 * Body: { order: string[] }   — job ids, top of the queue first
 *
 * Admin-controlled work order for the graphics board (migration 318). Due
 * dates and the priority bucket both tie constantly — a dozen "high" jobs
 * due the same week say nothing about which one to start — so admins hand
 * an explicit 1..N running order to the designer and production manager.
 *
 * Whole-list writes, never a single row: ranks are rewritten as a contiguous
 * block so they can't drift into gaps or duplicates. Last write wins if two
 * admins reorder at once, which is why the response echoes the order that
 * actually landed — the caller re-syncs from it rather than from its own
 * optimistic copy.
 *
 * Jobs off the floor (ready/ready for pickup, and finished ones) are
 * dropped on the way in: a job nobody in graphics can work is not "next",
 * and leaving it ranked would burn a slot on the designer's list.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  // De-dupe defensively: a double-drop in the UI must not rank a job twice.
  const requested = [...new Set(parsed.data.order)];

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Two reads, merged: the jobs being ranked (to check they exist and can
  // still be worked) and the jobs ranked right now (to clear the ones this
  // order drops). Both sets are small — the ranked queue is a handful, and
  // the requested list is capped at 500.
  const [asked, current] = await Promise.all([
    requested.length > 0
      ? supabase.from('graphics_jobs').select('id, status, work_rank').in('id', requested)
      : Promise.resolve({ data: [], error: null } as const),
    supabase.from('graphics_jobs').select('id, status, work_rank').not('work_rank', 'is', null),
  ]);
  const readErr = asked.error || current.error;
  if (readErr) {
    return NextResponse.json({ error: `Could not read graphics jobs: ${readErr.message}` }, { status: 500 });
  }

  type RankRow = { id: string; status: GraphicsJobStatus; work_rank: number | null };
  const rows = [...(asked.data || []), ...(current.data || [])] as RankRow[];
  const byId = new Map(rows.map(r => [r.id, r]));
  const workable = (id: string) => {
    const row = byId.get(id);
    return !!row && !isOffTheFloor(row.status);
  };

  // Drop ids that don't exist (deleted out from under the open modal) and
  // ones that left the floor while it sat open.
  const finalOrder = requested.filter(workable);
  const rankOf = new Map(finalOrder.map((id, i) => [id, i + 1]));

  const now = new Date().toISOString();
  const setBy = auth.user?.id ?? null;

  // Rows to clear: anything ranked today that isn't in the new order (or
  // finished since it was ranked).
  const toClear = [...byId.values()]
    .filter(r => r.work_rank !== null && !rankOf.has(r.id))
    .map(r => r.id);

  // Rows to write: only where the number actually changes, so a drag that
  // moves one job doesn't rewrite the whole board.
  const toRank = finalOrder.filter(id => byId.get(id)?.work_rank !== rankOf.get(id));

  try {
    if (toClear.length > 0) {
      const { error } = await supabase
        .from('graphics_jobs')
        .update({ work_rank: null, work_rank_set_at: now, work_rank_set_by: setBy })
        .in('id', toClear);
      if (error) throw new Error(error.message);
    }

    // Ranks are unique per job and the column has no constraint tying them
    // together, so these can all go at once.
    const results = await Promise.all(toRank.map(id => supabase
      .from('graphics_jobs')
      .update({ work_rank: rankOf.get(id)!, work_rank_set_at: now, work_rank_set_by: setBy })
      .eq('id', id)));
    const failed = results.find(r => r.error);
    if (failed?.error) throw new Error(failed.error.message);
  } catch (e: any) {
    return NextResponse.json({ error: `Could not save the work order: ${e.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    order: finalOrder,
    dropped: requested.filter(id => !rankOf.has(id)),
    cleared: toClear.length,
  });
}
