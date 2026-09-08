import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { FIELD_SHIFT_MAX_HOURS, FIELD_SHIFT_STALE_HOURS } from '@/lib/crew-utilization';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily sweep for forgotten CNI/field shift timers (R6-12) — the sibling of
 * shop-shift-sweep, which only ever covered 'shop' and 'graphics'. A cni or
 * field shift left open past FIELD_SHIFT_STALE_HOURS gets closed at
 * started_at + FIELD_SHIFT_MAX_HOURS and flagged auto_closed, so the
 * productivity report shows those hours as approximate instead of booking a
 * phantom multi-day shift.
 *
 * The cap is later than the shop's: field crews travel and run multi-vehicle
 * days. It is still a cap — 18 hours open is a forgotten Stop press.
 *
 * The crew lead who started the shift is told, with the one-tap fix: their
 * job page, where the timer lives. Closing is never blocked by a failed
 * notification.
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
    const staleCutoff = new Date(Date.now() - FIELD_SHIFT_STALE_HOURS * 3_600_000).toISOString();
    const { data: stale, error } = await supabase
      .from('work_shifts')
      .select('id, started_at, started_by, context, cni_job_id')
      .in('context', ['cni', 'field'])
      .is('ended_at', null)
      .lt('started_at', staleCutoff)
      .limit(200);
    if (error) throw new Error(error.message);

    let closed = 0;
    const told = new Map<string, { context: string; cniJobId: string | null }[]>();
    for (const s of stale || []) {
      const cappedEnd = new Date(Date.parse(s.started_at) + FIELD_SHIFT_MAX_HOURS * 3_600_000).toISOString();
      const { error: closeErr } = await supabase
        .from('work_shifts')
        .update({ ended_at: cappedEnd, auto_closed: true })
        .eq('id', s.id)
        .is('ended_at', null);
      if (closeErr) { console.error(`field-shift-sweep: close failed for ${s.id}:`, closeErr.message); continue; }
      closed++;
      if (s.started_by) {
        const arr = told.get(s.started_by) || [];
        arr.push({ context: s.context, cniJobId: s.cni_job_id || null });
        told.set(s.started_by, arr);
      }
    }

    // One notification per lead, however many of their timers were capped.
    let notified = 0;
    for (const [userId, shifts] of told) {
      const jobId = shifts.find(s => s.cniJobId)?.cniJobId || null;
      try {
        await notifyMany([userId], {
          type: 'shift_auto_closed',
          title: shifts.length === 1 ? 'A timer was left running' : `${shifts.length} timers were left running`,
          body: `Nobody stopped ${shifts.length === 1 ? 'it' : 'them'}, so ${shifts.length === 1 ? 'it was' : 'they were'} capped at ${FIELD_SHIFT_MAX_HOURS} hours and marked approximate. Open the job and fix the hours if that's wrong.`,
          url: jobId ? deepLinks.installerJob(jobId) : deepLinks.earnings(),
        });
        notified++;
      } catch (e: any) {
        console.error('field-shift-sweep: notify failed:', e?.message || e);
      }
    }

    const syncStateWrite = await recordHeartbeat(supabase, 'field_shift_sweep', { closed, notified });
    return NextResponse.json({ success: true, closed, notified, syncStateWrite });
  } catch (err: any) {
    console.error('field-shift-sweep failed:', err);
    await recordHeartbeat(supabase, 'field_shift_sweep', { error: String(err?.message || err).slice(0, 300) }).catch(() => {});
    return NextResponse.json({ error: err?.message || 'Sweep failed' }, { status: 500 });
  }
}
