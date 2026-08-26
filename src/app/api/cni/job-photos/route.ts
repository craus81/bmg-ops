import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { canActOnCniJob } from '@/lib/cni-access';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PHOTO_TYPES = ['front', 'back', 'driver_side', 'passenger_side', 'vin_plate', 'detail', 'other'] as const;

const Schema = z.object({
  jobId: z.string().uuid(),
  vinId: z.string().uuid().optional().nullable(),
  storagePath: z.string().trim().min(1).max(500),
  photoType: z.enum(PHOTO_TYPES),
});

/**
 * Record one uploaded completion photo. Previously a direct browser insert into
 * cni_job_photos, where RLS checked only uploaded_by + job assignment — so a
 * crafted insert could set review_status='approved' and self-approve. Routed
 * here so uploaded_by is the caller and review_status is forced to 'pending'.
 * The binary itself still uploads via /api/storage; this stores the metadata row.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, vinId, storagePath, photoType } = parsed.data;

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, assigned_installer_id, assigned_company_id')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: profile } = await supabase
    .from('profiles').select('role, roles').eq('id', auth.user.id).single();
  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const isAdmin = roles.includes('admin');
  if (!isAdmin && !(await canActOnCniJob(supabase, auth.user.id, job))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // A vin_id must belong to this job (mirror complete-vin's cross-check).
  if (vinId) {
    const { data: vin } = await supabase
      .from('cni_job_vins').select('id, job_id').eq('id', vinId).single();
    if (!vin || vin.job_id !== jobId) {
      return NextResponse.json({ error: 'VIN not found for this job' }, { status: 404 });
    }
  }

  const { data: inserted, error } = await supabase
    .from('cni_job_photos')
    .insert({
      job_id: jobId,
      vin_id: vinId || null,
      storage_path: storagePath,
      photo_type: photoType,
      uploaded_by: auth.user.id,
      review_status: 'pending',
    })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, id: inserted?.id });
}
