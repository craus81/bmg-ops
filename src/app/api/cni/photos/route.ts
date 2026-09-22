import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { storageDownloadUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  /** cni_job_photos.uploaded_by — who took the photo. */
  installerId: z.string().uuid().optional(),
  /** companies.id — every photo on jobs assigned to this company. */
  companyId: z.string().uuid().optional(),
  /** One job. */
  jobId: z.string().uuid().optional(),
  /** VIN substring (last 6 is the habit). */
  vin: z.string().trim().max(32).optional(),
  photoType: z.enum(['front', 'back', 'driver_side', 'passenger_side', 'vin_plate', 'detail', 'other']).optional(),
  /** Inclusive ISO dates (YYYY-MM-DD) on uploaded_at. */
  from: z.string().trim().max(32).optional(),
  to: z.string().trim().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * GET /api/cni/photos — every outside-installer photo, across jobs.
 *
 * Until now CNI photos were reachable only one job at a time: to answer
 * "show me everything this crew shot last week" somebody had to know which
 * jobs to open first. This is the cross-job read, filtered by installer,
 * company, job, VIN, angle and date.
 *
 * Service-role because cni_job_photos' RLS is admin-only (migration 038)
 * while this page is gated on the cni_admin FEATURE — a coordinator who
 * holds the feature without the admin role would otherwise read an empty
 * gallery and believe no photos exist.
 *
 * Paged with a deterministic order (uploaded_at desc, then id as the unique
 * tiebreaker) so "Load more" can't skip or repeat a row as photos arrive.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, Schema);
  if (parsed.error) return parsed.error;
  const { installerId, companyId, jobId, vin, photoType, from, to } = parsed.data;
  const limit = parsed.data.limit ?? 60;
  const offset = parsed.data.offset ?? 0;

  // The job and VIN each ride along as an embed rather than a second query.
  // Company and VIN filters apply to the embed with !inner, which is a real
  // join server-side: resolving them to id lists instead would have meant a
  // `.in()` of every job a company has ever had — thousands of uuids in a
  // GET URL, which is a 414 waiting to happen, not a filter.
  const jobEmbed = companyId ? 'cni_jobs!inner' : 'cni_jobs';
  const vinEmbed = vin ? 'cni_job_vins!inner' : 'cni_job_vins';
  const select =
    'id, job_id, vin_id, storage_path, photo_type, uploaded_at, uploaded_by, prescreen_verdict, prescreen_notes, '
    + `${jobEmbed}(job_number, title, assigned_company_id), `
    + `${vinEmbed}(vin, vehicle_year, vehicle_make, vehicle_model)`;

  try {
    let query = supabase
      .from('cni_job_photos')
      .select(select, { count: 'exact' })
      // Deterministic order with a unique tiebreaker, so paging can't skip
      // or repeat a row when two photos share an upload timestamp.
      .order('uploaded_at', { ascending: false })
      .order('id')
      .range(offset, offset + limit - 1);

    if (installerId) query = query.eq('uploaded_by', installerId);
    if (jobId) query = query.eq('job_id', jobId);
    if (photoType) query = query.eq('photo_type', photoType);
    if (from) query = query.gte('uploaded_at', `${from}T00:00:00.000Z`);
    if (to) query = query.lte('uploaded_at', `${to}T23:59:59.999Z`);
    if (companyId) query = query.eq('cni_jobs.assigned_company_id', companyId);
    // A VIN filter also drops job-level photos (vin_id NULL), which is right:
    // they belong to no VIN and so match no VIN search.
    if (vin) query = query.ilike('cni_job_vins.vin', `%${vin}%`);

    const { data: rows, error, count } = await query;
    if (error) throw new Error(error.message);
    const photos = (rows || []) as any[];

    // Embeds are to-one FKs, but Supabase can surface them as arrays.
    const one = (embed: any) => (Array.isArray(embed) ? embed[0] : embed) || null;

    // Uploader names for THIS page only — bounded by `limit`, so the lookup
    // never grows with the table.
    const userIds = [...new Set(photos.map(p => p.uploaded_by).filter(Boolean))] as string[];
    const usersRes = userIds.length
      ? await supabase.from('profiles').select('id, full_name, email').in('id', userIds)
      : { data: [] as any[] };
    const userById = new Map((usersRes.data || []).map((u: any) => [u.id, u.full_name || u.email || 'Installer']));

    const companyIds = [...new Set(photos.map(p => one(p.cni_jobs)?.assigned_company_id).filter(Boolean))] as string[];
    const companyById = new Map<string, string>();
    if (companyIds.length > 0) {
      const { data: companies } = await supabase.from('companies').select('id, name').in('id', companyIds);
      for (const c of companies || []) companyById.set(c.id, c.name);
    }

    const out = photos.map((p: any) => {
      const job: any = one(p.cni_jobs) || {};
      const vinRow: any = one(p.cni_job_vins);
      // storage_path carries either the full R2 key ('photos/cni-photos/…')
      // or a bucket-relative path on legacy rows — the same split the job
      // photo pages do when building a URL.
      const rel = String(p.storage_path || '').startsWith('photos/')
        ? String(p.storage_path).slice('photos/'.length)
        : String(p.storage_path || '');
      return {
        id: p.id,
        // Credentialed download route, never a public URL (R3-22).
        url: storageDownloadUrl('photos', rel, rel.split('/').pop() || 'photo.jpg'),
        photoType: p.photo_type,
        uploadedAt: p.uploaded_at,
        uploadedByName: p.uploaded_by ? (userById.get(p.uploaded_by) || null) : null,
        uploadedById: p.uploaded_by || null,
        jobId: p.job_id,
        jobNumber: job.job_number || null,
        jobTitle: job.title || null,
        companyName: job.assigned_company_id ? (companyById.get(job.assigned_company_id) || null) : null,
        vin: vinRow?.vin || null,
        vehicle: vinRow
          ? [vinRow.vehicle_year, vinRow.vehicle_make, vinRow.vehicle_model].filter(Boolean).join(' ') || null
          : null,
        prescreenVerdict: p.prescreen_verdict || null,
        prescreenNotes: p.prescreen_notes || null,
      };
    });

    return NextResponse.json({
      success: true,
      photos: out,
      total: count ?? null,
      hasMore: count != null ? offset + out.length < count : out.length === limit,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not load photos' }, { status: 500 });
  }
}
