import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { r2Delete } from '@/lib/r2';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const INTERNAL_STAFF_ROLES = ['admin', 'sales', 'graphics_production', 'shop_tech', 'field_tech', 'finance'];

/**
 * Completion photos for vehicle scans. Photos attach to scan_logs records
 * (the job record for a field/CNI install) and are stamped with the scan's
 * part number + VIN so they're also searchable from the parts catalog —
 * see /api/parts/install-photos.
 *
 * Writes run with the service role (installers can't write scan_photos
 * directly, mirroring scan_logs), so ownership checks live here: you can
 * only attach photos to scans you logged, unless you're internal staff.
 */

// A multi-part scan writes one scan_logs row per part; the client registers
// the same uploaded objects against every row so the photos surface under
// each part number.
const PostSchema = z.object({
  scanLogIds: z.array(z.string().uuid()).min(1).max(10),
  photos: z.array(z.object({
    path: z.string().trim().min(1).max(1000),
    fileName: z.string().trim().max(300).optional().nullable(),
  })).min(1).max(12),
});

function rolesOf(profile: any): string[] {
  return profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
}

function canScanPhotos(profile: any): boolean {
  const roles = rolesOf(profile);
  // Same gate as /api/scans/log: any approved account except customer-only.
  return !(roles.includes('customer') && roles.length === 1);
}

function isStaff(profile: any): boolean {
  return rolesOf(profile).some(r => INTERNAL_STAFF_ROLES.includes(r));
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  if (!canScanPhotos(auth.profile)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { scanLogIds, photos } = parsed.data;

  const ids = [...new Set(scanLogIds)];
  const { data: scans } = await service
    .from('scan_logs')
    .select('id, vin, part_number, scanned_by')
    .in('id', ids);
  if (!scans || scans.length !== ids.length) {
    return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
  }

  const staff = isStaff(auth.profile);
  if (!staff && scans.some(s => s.scanned_by !== auth.user.id)) {
    return NextResponse.json({ error: 'You can only add photos to your own scans' }, { status: 403 });
  }

  // Photos must live under one of these scans' own storage prefixes — stops a
  // caller from registering someone else's object (or an arbitrary key) as a
  // photo of their scan.
  const validPrefixes = ids.map(id => `scan-photos/${id}/`);
  for (const p of photos) {
    if (!validPrefixes.some(prefix => p.path.startsWith(prefix))) {
      return NextResponse.json({ error: 'Invalid photo path' }, { status: 400 });
    }
  }

  const rows = scans.flatMap(scan => photos.map(p => ({
    scan_log_id: scan.id,
    part_number: scan.part_number,
    vin: scan.vin,
    storage_path: p.path,
    file_name: p.fileName || null,
    photo_type: 'completion',
    uploaded_by: auth.user.id,
  })));

  const { data: inserted, error } = await service
    .from('scan_photos')
    .insert(rows)
    .select('id, scan_log_id, storage_path, file_name, photo_type, uploaded_by, uploaded_at');
  if (error) {
    return NextResponse.json({ error: 'Failed to save photos: ' + error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, photos: inserted });
}

// GET ?scanLogIds=a,b,c — photos for a set of scans (the scan page's
// "Today's Scans" list). Non-staff only see photos on their own scans.
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  if (!canScanPhotos(auth.profile)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const raw = (req.nextUrl.searchParams.get('scanLogIds') || '').split(',').map(s => s.trim()).filter(Boolean);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = [...new Set(raw)].filter(id => uuidRe.test(id)).slice(0, 200);
  if (ids.length === 0) return NextResponse.json({ photos: [] });

  let query = service
    .from('scan_photos')
    .select('id, scan_log_id, storage_path, file_name, photo_type, uploaded_by, uploaded_at')
    .in('scan_log_id', ids)
    .order('uploaded_at', { ascending: true });

  if (!isStaff(auth.profile)) {
    const { data: ownScans } = await service
      .from('scan_logs').select('id').in('id', ids).eq('scanned_by', auth.user.id);
    const ownIds = (ownScans || []).map(s => s.id);
    if (ownIds.length === 0) return NextResponse.json({ photos: [] });
    query = query.in('scan_log_id', ownIds);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ photos: data || [] });
}

const DeleteSchema = z.object({ id: z.string().uuid() });

// DELETE — remove a photo you took (admins: any). Also removes the R2 object,
// but only when no other scan_photos row still references it (a multi-part
// scan registers the same object against several scan rows).
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DeleteSchema);
  if (parsed.error) return parsed.error;

  const { data: photo } = await service
    .from('scan_photos')
    .select('id, storage_path, uploaded_by')
    .eq('id', parsed.data.id)
    .maybeSingle();
  if (!photo) return NextResponse.json({ error: 'Photo not found' }, { status: 404 });

  const isAdmin = rolesOf(auth.profile).includes('admin');
  if (!isAdmin && photo.uploaded_by !== auth.user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { error } = await service.from('scan_photos').delete().eq('id', photo.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: remaining } = await service
    .from('scan_photos').select('id').eq('storage_path', photo.storage_path).limit(1);
  if (!remaining || remaining.length === 0) {
    try { await r2Delete('photos', photo.storage_path); } catch {}
  }

  return NextResponse.json({ success: true });
}
