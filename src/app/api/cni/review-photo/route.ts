import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { getCompanyInstallerIds } from '@/lib/cni-access';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  photoId: z.string().uuid().optional(),
  status: z.enum(['approved', 'conditionally_approved', 'denied']).optional(),
  note: z.string().max(2000).optional().nullable(),
  // Bulk mode (R3-2: "fold bulk-approve into the route"): approve every
  // PENDING photo for one VIN server-side — the page used to loop browser
  // writes and then flag the VIN approved even when denied photos remained.
  vinId: z.string().uuid().optional(),
  bulk: z.boolean().optional(),
}).refine(
  b => (b.photoId && b.status) || (b.bulk && b.vinId),
  { message: 'Pass photoId+status for one verdict, or vinId+bulk to approve all pending' },
);

/**
 * A VIN's photos are "approved" when the NEWEST photo of each submitted
 * type is approved (plain or conditional). Older superseded photos —
 * including denied ones that were reshot — no longer count against it
 * (R3-2: one denied photo used to brick the job's closure and payout
 * forever, because nothing could ever un-deny it).
 */
async function recomputeVinPhotosApproved(vinId: string) {
  const { data: vinPhotos } = await supabase
    .from('cni_job_photos')
    .select('photo_type, review_status, uploaded_at')
    .eq('vin_id', vinId)
    .order('uploaded_at', { ascending: false });
  const newestByType = new Map<string, string>();
  for (const p of vinPhotos || []) {
    const t = p.photo_type || 'other';
    if (!newestByType.has(t)) newestByType.set(t, p.review_status);
  }
  const allOk = newestByType.size > 0 &&
    [...newestByType.values()].every(s => s === 'approved' || s === 'conditionally_approved');
  await supabase.from('cni_job_vins')
    .update({ photos_approved: allOk })
    .eq('id', vinId);
}

/**
 * POST /api/cni/review-photo — QC verdict on an installer's job photo
 * (audit item 16: the review was a browser-side update, so a DENIAL never
 * reached the installer who has to drive back and reshoot — they found
 * out when their invoice stalled).
 *
 * Writes the verdict, keeps the deny-side internal note (ported from the
 * review page), and on denial notifies the assigned installer — or the
 * whole assigned company roster when no individual is pinned.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { photoId, status, note, vinId, bulk } = parsed.data;

  // Bulk: approve every pending photo for the VIN, then recompute the flag
  // honestly (denied ones stay denied — the old browser loop flagged the
  // VIN approved regardless).
  if (bulk && vinId) {
    const { error: bulkErr } = await supabase
      .from('cni_job_photos')
      .update({
        review_status: 'approved',
        reviewed_by: auth.user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('vin_id', vinId)
      .eq('review_status', 'pending');
    if (bulkErr) return NextResponse.json({ error: bulkErr.message }, { status: 500 });
    await recomputeVinPhotosApproved(vinId);
    return NextResponse.json({ success: true, bulk: true });
  }

  const { data: photo } = await supabase
    .from('cni_job_photos')
    .select('id, job_id, vin_id, photo_type')
    .eq('id', photoId!)
    .maybeSingle();
  if (!photo) return NextResponse.json({ error: 'Photo not found' }, { status: 404 });

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title, assigned_installer_id, assigned_company_id')
    .eq('id', photo.job_id)
    .maybeSingle();

  const { error } = await supabase.from('cni_job_photos').update({
    review_status: status,
    reviewed_by: auth.user.id,
    reviewed_at: new Date().toISOString(),
    review_notes: note || null,
  }).eq('id', photoId!);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Every verdict — including a re-review of a previously denied or
  // approved photo — recomputes the VIN flag, so the route-level path
  // finally maintains photos_approved (the audit: only the browser bulk
  // loop ever set it).
  if (photo.vin_id) await recomputeVinPhotosApproved(photo.vin_id);

  if (status === 'denied' && job) {
    // Re-arm the submission flow: submit-photos short-circuits (and skips
    // its "photos ready for review" notification) while photos_submitted
    // is true — without this reset a reshoot after denial notified nobody
    // and the job sat blocked until someone reopened the review page
    // (Round 3 finding).
    if (photo.vin_id) {
      await supabase.from('cni_job_vins')
        .update({ photos_submitted: false })
        .eq('id', photo.vin_id);
    }
    // QC paper trail (ported from the review page — it lived browser-side).
    if (job.assigned_installer_id) {
      await supabase.from('cni_internal_notes').insert({
        installer_id: job.assigned_installer_id,
        note_type: 'qc',
        content: `Photo denied (${photo.photo_type || 'unknown'}): ${note || 'No notes'}`,
        auto_generated: true,
        source_job_id: job.id,
        created_by: auth.user.id,
      });
    }
    // The installer has to reshoot — tell them now, not when the invoice
    // stalls.
    try {
      const targets = job.assigned_installer_id
        ? [job.assigned_installer_id]
        : job.assigned_company_id
          ? await getCompanyInstallerIds(supabase, job.assigned_company_id)
          : [];
      if (targets.length > 0) {
        await notifyMany(targets, {
          type: 'cni_photo_denied',
          title: `📷 Photo needs a reshoot — ${job.job_number}`,
          body: `A ${photo.photo_type || 'job'} photo on "${job.title}" was denied.${note ? ` Reviewer: ${note}` : ''} Retake and resubmit from the job page.`,
          // The denial badge and reviewer notes render on the PHOTOS page —
          // installerJob(job.id) landed one page short of them.
          url: deepLinks.installerJobPhotos(job.id),
          channels: ['in_app', 'push'],
          forceChannels: true,
        });
      }
    } catch (err) {
      console.error('cni_photo_denied notify failed:', err);
    }
  }

  return NextResponse.json({ success: true });
}
