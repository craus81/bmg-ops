import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export interface InstallPhotoItem {
  id: string;
  source: 'scan' | 'cni_job';
  bucket: string;
  storagePath: string;
  fileName: string | null;
  photoType: string;
  vin: string | null;
  vehicle: string | null;
  uploadedAt: string | null;
  uploadedByName: string | null;
}

// Newest-first gallery, bounded so a high-volume part (thousands of installs)
// can't blow up the response. The cap is on photos shown, not installs.
const MAX_ITEMS = 200;
// How many recent scans of the part to walk when looking for linked CNI job
// photos (each scan is one vehicle).
const MAX_SCAN_ROWS = 500;

/**
 * GET /api/parts/install-photos?part=<item number>
 *
 * Everything we have showing this part installed on real vehicles:
 *   - scan_photos — completion photos techs attach at scan time
 *   - cni_job_photos — CNI job completion photos, joined through
 *     cni_job_vins.scan_log_id → scan_logs.part_number
 *
 * The part match is case-insensitive on the scan's recorded part_number, so
 * custom-job "part numbers" that aren't in the catalog still work.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const part = (req.nextUrl.searchParams.get('part') || '').trim();
  if (!part || part.length > 120) {
    return NextResponse.json({ error: 'part required' }, { status: 400 });
  }

  // ilike with no wildcards = case-insensitive equality. Escape the pattern
  // chars a part number could legitimately contain.
  const pattern = part.replace(/([%_\\])/g, '\\$1');

  // 1. Direct scan photos for this part.
  const { data: scanPhotoRows } = await service
    .from('scan_photos')
    .select('id, scan_log_id, storage_path, file_name, photo_type, uploaded_by, uploaded_at')
    .ilike('part_number', pattern)
    .order('uploaded_at', { ascending: false })
    .limit(MAX_ITEMS);

  // 2. Recent scans of this part → CNI VINs completed against them → their
  //    job completion photos.
  const { data: partScans } = await service
    .from('scan_logs')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model')
    .ilike('part_number', pattern)
    .order('scanned_at', { ascending: false })
    .limit(MAX_SCAN_ROWS);

  const scanById = new Map((partScans || []).map(s => [s.id, s]));

  // Vehicle context for scan photos whose scan fell outside the recent window.
  const missingScanIds = [...new Set(
    (scanPhotoRows || []).map(p => p.scan_log_id).filter(id => !scanById.has(id))
  )];
  if (missingScanIds.length > 0) {
    const { data: extraScans } = await service
      .from('scan_logs')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model')
      .in('id', missingScanIds);
    for (const s of extraScans || []) scanById.set(s.id, s);
  }

  let cniPhotoRows: any[] = [];
  const vinRowByVinId = new Map<string, { vin: string; scan_log_id: string }>();
  const partScanIds = (partScans || []).map(s => s.id);
  if (partScanIds.length > 0) {
    const { data: cniVins } = await service
      .from('cni_job_vins')
      .select('id, vin, scan_log_id')
      .in('scan_log_id', partScanIds);
    for (const v of cniVins || []) vinRowByVinId.set(v.id, v);

    const vinIds = [...vinRowByVinId.keys()];
    if (vinIds.length > 0) {
      const { data } = await service
        .from('cni_job_photos')
        .select('id, vin_id, storage_path, photo_type, uploaded_by, uploaded_at')
        .in('vin_id', vinIds)
        .order('uploaded_at', { ascending: false })
        .limit(MAX_ITEMS);
      cniPhotoRows = data || [];
    }
  }

  // Uploader names in one shot.
  const uploaderIds = new Set<string>();
  for (const p of scanPhotoRows || []) if (p.uploaded_by) uploaderIds.add(p.uploaded_by);
  for (const p of cniPhotoRows) if (p.uploaded_by) uploaderIds.add(p.uploaded_by);
  const nameById = new Map<string, string>();
  if (uploaderIds.size > 0) {
    const { data: profiles } = await service
      .from('profiles').select('id, full_name, email').in('id', [...uploaderIds]);
    for (const p of profiles || []) nameById.set(p.id, p.full_name || p.email || 'User');
  }

  const vehicleLabel = (s: any) =>
    [s?.vehicle_year, s?.vehicle_make, s?.vehicle_model].filter(Boolean).join(' ') || null;

  const items: InstallPhotoItem[] = [];

  for (const p of scanPhotoRows || []) {
    const scan = scanById.get(p.scan_log_id);
    items.push({
      id: `sp:${p.id}`,
      source: 'scan',
      bucket: 'photos',
      storagePath: p.storage_path,
      fileName: p.file_name,
      photoType: p.photo_type,
      vin: scan?.vin || null,
      vehicle: vehicleLabel(scan),
      uploadedAt: p.uploaded_at,
      uploadedByName: p.uploaded_by ? (nameById.get(p.uploaded_by) || null) : null,
    });
  }

  for (const p of cniPhotoRows) {
    const vinRow = vinRowByVinId.get(p.vin_id);
    const scan = vinRow ? scanById.get(vinRow.scan_log_id) : null;
    items.push({
      id: `cp:${p.id}`,
      source: 'cni_job',
      bucket: 'photos',
      storagePath: p.storage_path,
      fileName: null,
      photoType: p.photo_type,
      vin: vinRow?.vin || scan?.vin || null,
      vehicle: vehicleLabel(scan),
      uploadedAt: p.uploaded_at,
      uploadedByName: p.uploaded_by ? (nameById.get(p.uploaded_by) || null) : null,
    });
  }

  items.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));

  return NextResponse.json({ items: items.slice(0, MAX_ITEMS), count: items.length });
}
