import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, isAdminRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { screenPhoto, MAX_IMAGE_BYTES, PRESCREEN_MODEL, type PrescreenResult } from '@/lib/photo-prescreen';
import { callAnthropicWithRetry } from '@/lib/anthropic';
import { r2GetBytes } from '@/lib/r2';
import { canActOnCniJob } from '@/lib/cni-access';

export const dynamic = 'force-dynamic';
// The pre-screen runs INLINE so the installer gets "retake now" while still
// standing at the vehicle -- which is the whole point of checking at upload
// rather than at review. That costs a few seconds per photo; a background
// job would be faster to return and useless to the person who could fix it.
export const maxDuration = 60;

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
  const isAdmin = isAdminRole(roles);
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

  // Pre-screen (R6-8) — an advisory vision check while the crew is still on
  // site. It writes ONLY its own columns: review_status stays 'pending' and a
  // human reviewer still decides. A failure here never fails the upload, and
  // never records a pass it did not earn.
  const prescreen = await prescreenUploadedPhoto(supabase, {
    photoId: inserted?.id || null,
    storagePath,
    photoType,
    vinId: vinId || null,
  });

  return NextResponse.json({ success: true, id: inserted?.id, prescreen });
}

/**
 * Run the pre-screen and stamp the result. Returns what to tell the
 * installer, or null when there is nothing to say. Never throws.
 */
async function prescreenUploadedPhoto(
  service: typeof supabase,
  photo: { photoId: string | null; storagePath: string; photoType: string; vinId: string | null },
): Promise<{ verdict: string; notes: string } | null> {
  if (!photo.photoId) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  let result: PrescreenResult;
  if (!apiKey) {
    // No key configured is NOT a pass — the check did not run, and the row
    // says so rather than implying the photo was looked at.
    result = {
      verdict: 'not_screened',
      notes: 'Automatic photo checking is not configured, so this photo has not been checked.',
      findings: [], vinRead: null,
    };
  } else {
    let expectedVin: string | null = null;
    if (photo.vinId) {
      const { data } = await service.from('cni_job_vins').select('vin').eq('id', photo.vinId).maybeSingle();
      expectedVin = data?.vin || null;
    }
    // storage_path carries either the full R2 key ('photos/cni-photos/…') or
    // a bucket-relative path on legacy rows — the same split the photo pages
    // do when building a URL.
    const rel = photo.storagePath.startsWith('photos/')
      ? photo.storagePath.slice('photos/'.length)
      : photo.storagePath;

    result = await screenPhoto(
      { photoType: photo.photoType, expectedVin },
      {
        getImage: () => r2GetBytes('photos', rel, MAX_IMAGE_BYTES),
        call: (body) => callAnthropicWithRetry(body, apiKey),
        model: PRESCREEN_MODEL,
      },
    );
  }

  const { error: stampErr } = await service
    .from('cni_job_photos')
    .update({
      prescreen_verdict: result.verdict,
      prescreen_notes: result.notes,
      prescreen_at: new Date().toISOString(),
      prescreen_findings: result.findings,
    })
    .eq('id', photo.photoId);
  if (stampErr) console.error('photo pre-screen stamp failed:', stampErr.message);

  return { verdict: result.verdict, notes: result.notes };
}
