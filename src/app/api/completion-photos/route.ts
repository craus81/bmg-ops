import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature, outsideStaff } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { storageDownloadUrl } from '@/lib/storage';
import { looseOrFilter } from '@/lib/loose-search';
import {
  COMPLETION_PHOTO_SOURCES, completionPhotoFileName, completionPhotoRecordLink,
  type CompletionPhotoRow,
} from '@/lib/completion-photos';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  /** Customer, VIN, job / SO / PO number or vehicle — the forgiving search. */
  q: z.string().trim().max(100).optional(),
  source: z.enum(COMPLETION_PHOTO_SOURCES as [string, ...string[]]).optional(),
  /** Inclusive ISO dates (YYYY-MM-DD) on when the photo was taken. */
  from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * GET /api/completion-photos — finished-work photos from every job.
 *
 * Shop completion photos, outside-installer photos and scan photos, through
 * the completion_photos view (migration 369). Internal staff only: it shows
 * every customer's vehicles, so customer and outside-installer logins get
 * a 403. Service role because the view is not granted to browser roles.
 *
 * Paged with a deterministic order (taken_at desc, then id as the unique
 * tiebreaker) so "Load more" can't skip or repeat a row as photos arrive.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'completion_photos');
  if (auth.error) return auth.error;
  const outside = outsideStaff(auth);
  if (outside) return outside;

  const parsed = validateSearchParams(req, Schema);
  if (parsed.error) return parsed.error;
  const { q, source, from, to } = parsed.data;
  const limit = parsed.data.limit ?? 60;
  const offset = parsed.data.offset ?? 0;

  try {
    let query = supabase
      .from('completion_photos')
      .select('id, source, storage_path, taken_at, customer_name, vin, vehicle, job_label, record_id', { count: 'exact' })
      .order('taken_at', { ascending: false, nullsFirst: false })
      .order('id')
      .range(offset, offset + limit - 1);

    if (source) query = query.eq('source', source);
    if (from) query = query.gte('taken_at', `${from}T00:00:00.000Z`);
    if (to) query = query.lte('taken_at', `${to}T23:59:59.999Z`);
    const qFilter = looseOrFilter(['customer_name', 'vin', 'job_label', 'vehicle'], q);
    if (qFilter) query = query.or(qFilter);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    const rows = (data || []) as CompletionPhotoRow[];

    const photos = rows.map(r => {
      const downloadName = completionPhotoFileName(r, 1);
      return {
        id: r.id,
        source: r.source,
        // Credentialed route, never a public URL (R3-22).
        url: storageDownloadUrl('photos', r.storage_path, downloadName),
        downloadName,
        takenAt: r.taken_at,
        customerName: r.customer_name,
        vin: r.vin,
        vehicle: r.vehicle,
        jobLabel: r.job_label,
        link: completionPhotoRecordLink(r),
      };
    });

    return NextResponse.json({
      success: true,
      photos,
      total: count ?? null,
      hasMore: count != null ? offset + photos.length < count : photos.length === limit,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not load photos' }, { status: 500 });
  }
}
