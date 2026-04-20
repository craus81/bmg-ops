import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/graphics/notify-ready
 *
 * Fires when a graphics_job transitions to 'ready'. Computes a narrow target set
 * of users who actually care about this as an install-readiness event and
 * dispatches via notifyMany.
 *
 * Target set = installers assigned to matched fleet_checkins via job_assignments,
 *              plus fleet_checkins.assigned_to users, plus admins,
 *              plus anyone with notification_preferences.notify_ready_for_install=true.
 *
 * Body: { jobId: string, excludeUserId?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { jobId, excludeUserId } = await req.json();
    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }

    // Load the graphics job for notification context
    const { data: job } = await supabase
      .from('graphics_jobs')
      .select('id, title, job_number, part_number, customer')
      .eq('id', jobId)
      .single();

    if (!job) {
      return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    }

    // Find fleet_checkins matched to this graphics job
    const { data: matchedCheckins } = await supabase
      .from('fleet_checkins')
      .select('id, vin, assigned_to')
      .eq('matched_graphics_job_id', jobId)
      .in('status', ['received', 'in_progress']);

    const targetUserIds = new Set<string>();
    const checkinIds: string[] = [];
    for (const c of matchedCheckins || []) {
      checkinIds.push(c.id);
      if (c.assigned_to) targetUserIds.add(c.assigned_to);
    }

    // Installers assigned to these checkins via job_assignments
    if (checkinIds.length > 0) {
      const { data: assignments } = await supabase
        .from('job_assignments')
        .select('user_id')
        .eq('job_type', 'scanned_vehicle')
        .in('job_id', checkinIds);
      for (const a of assignments || []) targetUserIds.add(a.user_id);
    }

    // Admins (always notified for install-readiness oversight)
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .eq('status', 'approved');
    for (const a of admins || []) targetUserIds.add(a.id);

    // Opt-in: users with notify_ready_for_install = true
    const { data: optins } = await supabase
      .from('notification_preferences')
      .select('user_id')
      .eq('notify_ready_for_install', true);
    for (const p of optins || []) targetUserIds.add(p.user_id);

    // Exclude the user who triggered the change
    if (excludeUserId) targetUserIds.delete(excludeUserId);

    const userIds = Array.from(targetUserIds);
    if (userIds.length === 0) {
      return NextResponse.json({ sent: 0, reason: 'no_targets' });
    }

    const jobLabel = job.job_number || job.id.slice(0, 8);
    const vehicleCount = matchedCheckins?.length || 0;
    const bodySuffix = vehicleCount > 0
      ? ` ${vehicleCount} vehicle${vehicleCount === 1 ? '' : 's'} ready to install.`
      : '';

    await notifyMany(userIds, {
      type: 'graphics_ready_for_install',
      title: `Graphics ready: ${job.title || jobLabel}`,
      body: `Job #${jobLabel}${job.customer ? ` for ${job.customer}` : ''} is ready.${bodySuffix}`,
      url: '/installer/ready-for-install',
    });

    return NextResponse.json({
      sent: userIds.length,
      matchedCheckins: vehicleCount,
    });
  } catch (err: any) {
    console.error('notify-ready error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
