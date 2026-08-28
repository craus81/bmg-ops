import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  jobId: z.string().uuid(),
  kind: z.enum(['status', 'note', 'created']),
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
 * kind 'created' is a third audience: the graphics production team and
 * admins, resolved BY ROLE. It deliberately ignores notification_preferences
 * .notify_new_job — that flag was read from the browser, where RLS is
 * own-rows-only, so the recipient list was always empty and no new-job
 * notification has ever been delivered. Role membership is the subscription
 * now; it is predictable, and it matches who actually needs to know a job
 * landed. (Owner decision, 2026-08-28.)
 *
 * The actor is excluded everywhere — you don't need a ping about your own
 * note, status flip, or job.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const actorId = auth.user?.id || null;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, kind, newStatus, statusLabel, note } = parsed.data;

  try {
    const { data: job } = await supabase
      .from('graphics_jobs')
      .select('id, title, job_number, customer, created_by, assigned_to, quantity, part_number')
      .eq('id', jobId)
      .single();
    if (!job) {
      return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    }

    // Notes don't touch the graphics_jobs row, but the board's unread-dot
    // logic compares updated_at against each viewer's last_viewed_at — bump
    // it here (service role, so it works for roles that can't UPDATE the
    // jobs table directly). Status changes already bump it client-side.
    if (kind === 'note') {
      await supabase.from('graphics_jobs').update({ updated_at: new Date().toISOString() }).eq('id', jobId);
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
    const url = deepLinks.graphicsJob(job.id);

    let actorName = '';
    if (actorId) {
      const { data: actor } = await supabase.from('profiles').select('full_name').eq('id', actorId).maybeSingle();
      actorName = actor?.full_name || '';
    }

    const title = kind === 'note'
      ? `Note on ${jobLabel}`
      : kind === 'created'
        ? `New graphics job: ${jobLabel}`
        : `${jobLabel} → ${statusLabel || newStatus || 'updated'}`;
    const body = kind === 'note'
      ? `${actorName ? `${actorName}: ` : ''}${(note || '').slice(0, 300)}`
      : kind === 'created'
        ? `${job.customer || 'Unknown customer'}${actorName ? ` · created by ${actorName}` : ''}`
        : `Job #${job.job_number || job.id.slice(0, 8)}${job.customer ? ` (${job.customer})` : ''} status changed to ${statusLabel || newStatus}${actorName ? ` by ${actorName}` : ''}`;

    if (assigneeIds.size > 0) {
      await notifyMany(Array.from(assigneeIds), { type: 'graphics_activity', title, body, url });
    }

    // ----- Audience 3 (created only): the graphics team, by role -----
    if (kind === 'created') {
      const TEAM_ROLES = ['admin', 'super_admin', 'graphics_production', 'production'];
      const { data: staff } = await supabase
        .from('profiles')
        .select('id, role, roles, status, deactivated')
        .eq('status', 'approved');
      const teamIds = (staff || [])
        .filter((p: any) => {
          if (p.deactivated) return false;
          if (p.id === actorId) return false;
          // Same roles[]-with-scalar-fallback rule as profileRoles() in
          // src/lib/api-auth.ts, so this audience can't drift from authz.
          const roles = p.roles?.length ? p.roles : [p.role];
          return roles.some((r: string) => TEAM_ROLES.includes(r));
        })
        .map((p: any) => p.id);
      // Assignees already got the 'graphics_activity' ping above; don't double up.
      const freshIds = teamIds.filter((id: string) => !assigneeIds.has(id));
      if (freshIds.length > 0) {
        await notifyMany(freshIds, {
          type: 'graphics_new',
          title: `New graphics job: ${jobLabel}`,
          body: [
            job.customer || 'Unknown customer',
            job.quantity ? `${job.quantity} unit${job.quantity !== 1 ? 's' : ''}` : '',
            job.part_number || '',
            actorName ? `created by ${actorName}` : '',
          ].filter(Boolean).join(' · '),
          url,
        });
      }
      console.log('[notify-assignees] dispatch', { jobId, kind, assignees: assigneeIds.size, team: freshIds.length });
      return NextResponse.json({ sent: assigneeIds.size + freshIds.length, assignees: assigneeIds.size, team: freshIds.length });
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
