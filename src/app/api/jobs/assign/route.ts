import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const JobTypeEnum = z.enum(['scanned_vehicle', 'graphics_job']);

const AssignSchema = z.object({
  jobType: JobTypeEnum,
  jobId: z.string().uuid(),
  userIds: z.array(z.string().uuid()).max(50),
  assignedBy: z.string().uuid().optional().nullable(),
  notifyUsers: z.boolean().optional(),
  notifyTeam: z.boolean().optional(),
  jobTitle: z.string().max(300).optional().nullable(),
});

const UnassignSchema = z.object({
  jobType: JobTypeEnum,
  jobId: z.string().uuid(),
  userId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, AssignSchema);
  if (parsed.error) return parsed.error;
  const { jobType, jobId, userIds, assignedBy, notifyUsers, notifyTeam, jobTitle } = parsed.data;

  try {
    // 1. Delete all existing assignments for this job, then re-insert
    await supabase
      .from('job_assignments')
      .delete()
      .eq('job_type', jobType)
      .eq('job_id', jobId);

    // 2. Insert current assignments
    if (userIds.length > 0) {
      const assignmentData = userIds.map((userId) => ({
        job_type: jobType,
        job_id: jobId,
        user_id: userId,
        assigned_by: assignedBy || null,
      }));

      const { error: insertError } = await supabase
        .from('job_assignments')
        .insert(assignmentData);

      if (insertError) {
        console.error('Assignment insert error:', insertError);
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
    }

    // 3. Mirror the first assignee onto the record's own assigned_to column.
    // job_assignments is the source of truth, but three consumers read the
    // scalar mirror instead — the tracking board card, the stuck-vehicle cron,
    // and graphics notify-ready all read fleet_checkins.assigned_to. The old
    // mirror targeted the RETIRED scanned_vehicles table and so silently wrote
    // nothing (jobType 'scanned_vehicle' carries a fleet_checkins id — see the
    // completion notifier, which reads job_assignments by that id); it's
    // restored here against fleet_checkins so assignees show on the card and
    // receive stuck alerts again.
    const firstAssignee = userIds.length > 0 ? userIds[0] : null;
    if (jobType === 'graphics_job') {
      await supabase
        .from('graphics_jobs')
        .update({ assigned_to: firstAssignee, updated_by: assignedBy || null })
        .eq('id', jobId);
    } else if (jobType === 'scanned_vehicle') {
      await supabase
        .from('fleet_checkins')
        .update({ assigned_to: firstAssignee })
        .eq('id', jobId);
    }

    // 4. Notify assigned users
    if (notifyUsers && userIds.length > 0) {
      const typeLabel = jobType === 'scanned_vehicle' ? 'Vehicle' : 'Graphics Job';
      const title = `Assigned to ${typeLabel}`;
      const body = jobTitle
        ? `You've been assigned to: ${jobTitle}`
        : `You've been assigned to a new ${typeLabel.toLowerCase()}.`;

      console.log(`[assign] Sending assignment notification to ${userIds.length} users:`, userIds);
      await notifyMany(userIds, {
        type: 'assignment',
        title,
        body,
        url: jobType === 'graphics_job' ? deepLinks.graphicsJob(jobId) : deepLinks.vehicle(jobId),
      }).catch(err => console.warn('Assignment notification error:', err));

      // Mark as notified
      await supabase
        .from('job_assignments')
        .update({ notified: true, notified_at: new Date().toISOString() })
        .eq('job_type', jobType)
        .eq('job_id', jobId)
        .in('user_id', userIds);
    }

    // 5. Notify full production team (for graphics jobs)
    if (notifyTeam && jobType === 'graphics_job') {
      const { data: teamMembers } = await supabase
        .from('profiles')
        .select('id')
        .in('role', ['production', 'graphics_production', 'admin'])
        .eq('status', 'approved');

      if (teamMembers && teamMembers.length > 0) {
        // Exclude the person who created it and already-assigned users
        const teamIds = teamMembers
          .map((m: any) => m.id)
          .filter((id: string) => id !== assignedBy && !userIds.includes(id as string));

        if (teamIds.length > 0) {
          await notifyMany(teamIds, {
            type: 'graphics',
            title: 'New Graphics Job',
            body: jobTitle ? `New job: ${jobTitle}` : 'A new graphics job has been created.',
            url: deepLinks.graphicsJob(jobId),
          }).catch(err => console.warn('Team notification error:', err));
        }
      }
    }

    return NextResponse.json({ success: true, assigned: userIds.length });
  } catch (err: any) {
    console.error('Job assign error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE — remove an assignment
export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UnassignSchema);
  if (parsed.error) return parsed.error;
  const { jobType, jobId, userId } = parsed.data;

  try {
    const { error } = await supabase
      .from('job_assignments')
      .delete()
      .eq('job_type', jobType)
      .eq('job_id', jobId)
      .eq('user_id', userId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Mirror the next assignee onto the record's scalar assigned_to field
    // (the readers use the mirror — see POST step 3).
    if (jobType === 'graphics_job' || jobType === 'scanned_vehicle') {
      const { data: remaining } = await supabase
        .from('job_assignments')
        .select('user_id')
        .eq('job_type', jobType)
        .eq('job_id', jobId)
        .order('assigned_at', { ascending: true })
        .limit(1);
      const nextAssignee = remaining?.[0]?.user_id || null;

      if (jobType === 'graphics_job') {
        await supabase.from('graphics_jobs').update({ assigned_to: nextAssignee }).eq('id', jobId);
      } else {
        await supabase.from('fleet_checkins').update({ assigned_to: nextAssignee }).eq('id', jobId);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
