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
  photoId: z.string().uuid(),
  status: z.enum(['approved', 'conditionally_approved', 'denied']),
  note: z.string().max(2000).optional().nullable(),
});

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
  const { photoId, status, note } = parsed.data;

  const { data: photo } = await supabase
    .from('cni_job_photos')
    .select('id, job_id, photo_type')
    .eq('id', photoId)
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
  }).eq('id', photoId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (status === 'denied' && job) {
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
          url: deepLinks.installerJob(job.id),
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
