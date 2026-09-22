import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, isAdminRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { canActOnCniJob, getCniStaffIds } from '@/lib/cni-access';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// The photo types that must be present before a VIN's photos count as
// submitted (kept in sync with the installer photos page).
const REQUIRED_TYPES = ['front', 'back', 'driver_side', 'passenger_side', 'vin_plate'];

const Schema = z.object({
  jobId: z.string().uuid(),
  vinId: z.string().uuid(),
});

/**
 * Mark a VIN's photos submitted (photos_submitted=true) once all required
 * angles are on file. Previously a direct browser write to cni_job_vins under
 * RLS; routed here so the requirement is verified server-side (not just trusted
 * from the client), and so BMG is told the photos landed.
 * Idempotent — the flip and the notification fire only on the false→true edge.
 *
 * The flag means the required angles EXIST, nothing more. Migration 307
 * retired the approve/deny review, so there is no verdict to wait for and
 * no such thing as a VIN whose photos were rejected.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, vinId } = parsed.data;

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title, assigned_installer_id, assigned_company_id')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: profile } = await supabase
    .from('profiles').select('full_name, role, roles').eq('id', auth.user.id).single();
  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const isAdmin = isAdminRole(roles);
  if (!isAdmin && !(await canActOnCniJob(supabase, auth.user.id, job))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data: vin } = await supabase
    .from('cni_job_vins').select('id, job_id, vin, photos_submitted').eq('id', vinId).single();
  if (!vin || vin.job_id !== jobId) {
    return NextResponse.json({ error: 'VIN not found for this job' }, { status: 404 });
  }

  // Already submitted → succeed without re-flipping or re-notifying.
  if (vin.photos_submitted) {
    return NextResponse.json({ success: true, alreadySubmitted: true });
  }

  // Verify the required set is actually present — don't trust the client's word.
  const { data: photos } = await supabase
    .from('cni_job_photos').select('photo_type').eq('job_id', jobId).eq('vin_id', vinId);
  const covered = new Set((photos || []).map((p: any) => p.photo_type));
  const missing = REQUIRED_TYPES.filter(t => !covered.has(t));
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing required photos: ${missing.join(', ')}` }, { status: 400 });
  }

  const { error } = await supabase
    .from('cni_job_vins').update({ photos_submitted: true }).eq('id', vinId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Tell the coordinators photos landed — but only for the FIRST VIN of the
  // job (R3-4). A crew works a job's VINs one at a time, and pinging every
  // coordinator per VIN made a 30-VIN job 30 pushes + 30 emails each; once
  // they know the job has started producing photos, the job page shows the
  // live count. This is news, not a work item: with the review retired
  // (migration 307) nobody has to act on it.
  try {
    const { data: alreadyTold } = await supabase
      .from('cni_job_vins')
      .select('id')
      .eq('job_id', jobId)
      .eq('photos_submitted', true)
      .neq('id', vinId)
      .limit(1);
    if ((alreadyTold || []).length === 0) {
      const staff = await getCniStaffIds(supabase, auth.user.id);
      if (staff.length > 0) {
        const who = profile?.full_name || 'An installer';
        await notifyMany(staff, {
          type: 'cni_photos_ready',
          title: `Photos submitted: ${job.job_number}`,
          body: `${who} submitted completion photos for VIN …${(vin.vin || '').slice(-6)} on "${job.title}". View them on the job.`,
          url: deepLinks.cniJobPhotos(jobId),
          channels: ['in_app', 'push', 'email'],
        });
      }
    }
  } catch (err) {
    console.error('cni_photos_ready notify failed:', err);
  }

  return NextResponse.json({ success: true });
}
