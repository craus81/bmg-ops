import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  jobId: z.string().uuid(),
  kind: z.enum(['status', 'note']),
  // Raw status value (for preference filtering) + display label (for message
  // text) — the label map lives client-side, so the caller supplies both.
  newStatus: z.string().max(50).optional(),
  statusLabel: z.string().max(80).optional(),
  note: z.string().max(2000).optional(),
});

/**
 * POST /api/graphics/notify-assignees
 *
 * Fires on any graphics-job activity (status change or new note) and notifies
 * everyone assigned to the job — job_assignments rows plus the job's creator
 * and legacy assigned_to — regardless of their event-type preference flags.
 * Being assigned IS the subscription; the 'graphics_activity' type skips the
 * notify_status_change/notify_new_job gates in getPreferredChannels while
 * still honoring each user's delivery preferences (in-app/push, email opt-in).
 *
 * For status changes it also carries the previously client-side "generic
 * status ping": everyone whose notification_preferences opt into this status
 * (notify_status_change, notify_shipped for shipped, or custom_statuses)
 * gets the preference-gated 'graphics_status' notification. Assignees are
 * excluded from that second set so nobody is notified twice.
 *
 * The actor is excluded everywhere — you don't need a ping about your own
 * note or status flip.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  const actorId = auth.user?.id || null;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, kind, newStatus, statusLabel, note } = parsed.data;

  try {
    const { data: job } = await supabase
      .from('graphics_jobs')
      .select('id, title, job_number, customer, created_by, assigned_to')
      .eq('id', jobId)
      .single();
    if (!job) {
      return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    }

    // ----- Audience 1: everyone assigned to this job (always notified) -----
    const assigneeIds = new Set<string>();
    const { data: assignments } = await supabase
      .from('job_assignments')
      .select('user_id')
      .eq('job_type', 'graphics_job')
      .eq('job_id', jobId);
    for (const a of assignments || []) assigneeIds.add(a.user_id);
    if (job.created_by) assigneeIds.add(job.created_by);
    if (job.assigned_to) assigneeIds.add(job.assigned_to);
    if (actorId) assigneeIds.delete(actorId);

    const jobLabel = job.title || `#${job.job_number || job.id.slice(0, 8)}`;
    const url = `/graphics?id=${job.id}`;

    let actorName = '';
    if (actorId) {
      const { data: actor } = await supabase.from('profiles').select('full_name').eq('id', actorId).maybeSingle();
      actorName = actor?.full_name || '';
    }

    const title = kind === 'note'
      ? `Note on ${jobLabel}`
      : `${jobLabel} → ${statusLabel || newStatus || 'updated'}`;
    const body = kind === 'note'
      ? `${actorName ? `${actorName}: ` : ''}${(note || '').slice(0, 300)}`
      : `Job #${job.job_number || job.id.slice(0, 8)}${job.customer ? ` (${job.customer})` : ''} status changed to ${statusLabel || newStatus}${actorName ? ` by ${actorName}` : ''}`;

    if (assigneeIds.size > 0) {
      await notifyMany(Array.from(assigneeIds), { type: 'graphics_activity', title, body, url });
    }

    // ----- Audience 2 (status only): preference-gated status ping -----
    // Mirrors the filter that used to live in the graphics page client code.
    let pingCount = 0;
    if (kind === 'status' && newStatus) {
      const { data: prefs } = await supabase
        .from('notification_preferences')
        .select('user_id, notify_status_change, notify_shipped, custom_statuses');
      const pingIds = (prefs || [])
        .filter((p: any) => {
          if (p.user_id === actorId || assigneeIds.has(p.user_id)) return false;
          if (newStatus === 'shipped' && p.notify_shipped) return true;
          if (p.notify_status_change) return true;
          if (p.custom_statuses?.includes(newStatus)) return true;
          return false;
        })
        .map((p: any) => p.user_id);
      if (pingIds.length > 0) {
        await notifyMany(pingIds, { type: 'graphics_status', title, body, url });
        pingCount = pingIds.length;
      }
    }

    console.log('[notify-assignees] dispatch', { jobId, kind, assignees: assigneeIds.size, statusPings: pingCount });
    return NextResponse.json({ sent: assigneeIds.size + pingCount, assignees: assigneeIds.size, statusPings: pingCount });
  } catch (err: any) {
    console.error('notify-assignees error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
