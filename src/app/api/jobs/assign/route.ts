import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { jobType, jobId, userIds, assignedBy, notifyUsers, notifyTeam, jobTitle } = await req.json();

    if (!jobType || !jobId || !userIds || !Array.isArray(userIds)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // 1. Delete all existing assignments for this job, then re-insert
    await supabase
      .from('job_assignments')
      .delete()
      .eq('job_type', jobType)
      .eq('job_id', jobId);

    // 2. Insert current assignments
    if (userIds.length > 0) {
      const assignmentData = userIds.map((userId: string) => ({
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

    // 3. Update the legacy assigned_to field
    const table = jobType === 'scanned_vehicle' ? 'scanned_vehicles' : 'graphics_jobs';
    await supabase
      .from(table)
      .update({ assigned_to: userIds.length > 0 ? userIds[0] : null })
      .eq('id', jobId);

    // 4. Notify assigned users
    if (notifyUsers && userIds.length > 0) {
      const typeLabel = jobType === 'scanned_vehicle' ? 'Vehicle' : 'Graphics Job';
      const title = `Assigned to ${typeLabel}`;
      const body = jobTitle
        ? `You've been assigned to: ${jobTitle}`
        : `You've been assigned to a new ${typeLabel.toLowerCase()}.`;

      await notifyMany(userIds, {
        type: 'assignment',
        title,
        body,
        url: `/jobs/${jobId}`,
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
          .filter((id: string) => id !== assignedBy && !userIds.includes(id));

        if (teamIds.length > 0) {
          await notifyMany(teamIds, {
            type: 'graphics',
            title: 'New Graphics Job',
            body: jobTitle ? `New job: ${jobTitle}` : 'A new graphics job has been created.',
            url: `/jobs/${jobId}`,
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
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { jobType, jobId, userId } = await req.json();

    const { error } = await supabase
      .from('job_assignments')
      .delete()
      .eq('job_type', jobType)
      .eq('job_id', jobId)
      .eq('user_id', userId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Update legacy assigned_to — set to next assigned user or null
    const { data: remaining } = await supabase
      .from('job_assignments')
      .select('user_id')
      .eq('job_type', jobType)
      .eq('job_id', jobId)
      .order('assigned_at', { ascending: true })
      .limit(1);

    const table = jobType === 'scanned_vehicle' ? 'scanned_vehicles' : 'graphics_jobs';
    await supabase
      .from(table)
      .update({ assigned_to: remaining?.[0]?.user_id || null })
      .eq('id', jobId);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
