import { NextRequest, NextResponse } from 'next/server';
import { requireStaff, profileHasFeature } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateSearchParams, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { storageDownloadUrl } from '@/lib/storage';
import { ESTIMATE_FILE_PREFIX } from '@/lib/estimate-attachments';
import { completionPhotoFileName, completionPhotoRecordLink } from '@/lib/completion-photos';
import { deepLinks } from '@/lib/deep-links';
import {
  groupEstimateFiles, groupCompletionPhotos, completionJobKey, completionCustomerFilter, completionRowIsCustomer,
  estimateFolderName, type FsSubFolder, type FsFile,
} from '@/lib/client-files-fleetsuite';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  /** customers.id (the NetSuite mirror row), as on the customer page. */
  customer: z.string().uuid(),
  folder: z.enum(['estimates', 'completion']).optional(),
  /** With folder: one estimate id, or one job key ("shop:<id>"). */
  sub: z.string().max(200).optional(),
});

const IMAGE_RE = /\.(jpe?g|png|gif|webp|heic|heif)$/i;

/**
 * GET /api/client-files/fleetsuite?customer=<id>[&folder=estimates|completion[&sub=<key>]]
 *
 * The "From Estimates" and "Completion Photos" folders every customer's
 * Client Files shows next to its Dropbox folders (Craig, 2026-10-22), read
 * from FleetSuite's own storage so they're there with no Dropbox folder.
 * No folder: how much each holds. A folder: its sub-folders, newest first.
 * A sub-folder: its files. All staff; Completion Photos also needs the
 * completion_photos feature, as the Completion Photos page does.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = validateSearchParams(req, Schema);
  if (parsed.error) return parsed.error;
  const { customer, folder, sub } = parsed.data;
  const service = createServiceClient();

  const { data: cust, error: cErr } = await service.from('customers')
    .select('id, company_name').eq('id', customer).maybeSingle();
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
  if (!cust) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  const photosAllowed = await profileHasFeature(auth.user.id, auth.profile, 'completion_photos');

  const loadEstimateFiles = () => fetchAllRows<any>((from, to) => {
    let q = service.from('estimate_files')
      .select('id, file_name, content_type, size_bytes, storage_path, created_at, estimate:estimates!inner(id, estimate_number, netsuite_estimate_number, customer_id)')
      .eq('estimate.customer_id', customer)
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to);
    if (folder === 'estimates' && sub) q = q.eq('estimate_id', sub);
    return q;
  });

  const loadCompletion = async () => {
    const res = await fetchAllRows<any>((from, to) =>
      service.from('completion_photos')
        .select('id, source, storage_path, taken_at, customer_name, customer_id, vin, vehicle, job_label, record_id')
        .or(completionCustomerFilter(customer, cust.company_name))
        .order('taken_at', { ascending: false, nullsFirst: false })
        .order('id')
        .range(from, to),
    );
    return { ...res, data: res.data.filter(r => completionRowIsCustomer(r, customer, cust.company_name)) };
  };

  try {
    if (!folder) {
      const [est, comp] = await Promise.all([
        loadEstimateFiles(),
        photosAllowed ? loadCompletion() : Promise.resolve({ data: [] as any[], error: null }),
      ]);
      if (est.error) throw new Error(est.error.message);
      if (comp.error) throw new Error(comp.error.message);
      const e = groupEstimateFiles(est.data);
      const c = groupCompletionPhotos(comp.data);
      return NextResponse.json({
        estimates: { folders: e.length, files: est.data.length },
        completion: photosAllowed ? { folders: c.length, files: comp.data.length } : null,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (folder === 'estimates') {
      const est = await loadEstimateFiles();
      if (est.error) throw new Error(est.error.message);
      if (!sub) return NextResponse.json({ folders: groupEstimateFiles(est.data) satisfies FsSubFolder[] }, { headers: { 'Cache-Control': 'no-store' } });
      const files: FsFile[] = est.data.map(r => ({
        id: r.id,
        name: r.file_name,
        isImage: IMAGE_RE.test(r.file_name) || String(r.content_type || '').startsWith('image/'),
        size: Number(r.size_bytes) || 0,
        at: r.created_at,
        url: storageDownloadUrl(ESTIMATE_FILE_PREFIX, r.storage_path, r.file_name),
        downloadUrl: storageDownloadUrl(ESTIMATE_FILE_PREFIX, r.storage_path, r.file_name, 'attachment'),
        subtitle: r.estimate ? estimateFolderName(r.estimate) : null,
        link: r.estimate ? deepLinks.estimate(r.estimate.id) : null,
      }));
      return NextResponse.json({ files }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (!photosAllowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const comp = await loadCompletion();
    if (comp.error) throw new Error(comp.error.message);
    if (!sub) return NextResponse.json({ folders: groupCompletionPhotos(comp.data) }, { headers: { 'Cache-Control': 'no-store' } });
    const rows = comp.data.filter(r => completionJobKey(r) === sub);
    const files: FsFile[] = rows.map((r, i) => {
      const name = completionPhotoFileName(r, i + 1);
      return {
        id: r.id,
        name,
        isImage: true,
        size: 0,
        at: r.taken_at,
        url: storageDownloadUrl('photos', r.storage_path, name),
        downloadUrl: storageDownloadUrl('photos', r.storage_path, name, 'attachment'),
        subtitle: [r.vehicle, r.vin ? `VIN ${r.vin}` : null].filter(Boolean).join(' · ') || null,
        link: completionPhotoRecordLink(r),
      };
    });
    return NextResponse.json({ files }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[client-files/fleetsuite] failed:', e?.message || e);
    return NextResponse.json({ error: e?.message || 'Could not load the FleetSuite folders' }, { status: 500 });
  }
}
