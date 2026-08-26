import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type Source = 'vehicle_photo' | 'graphics_proof' | 'graphics_job_file';
type Category = 'before' | 'during' | 'completion' | 'damage' | 'proof' | 'design_file' | 'other';

interface TimelineItem {
  id: string;
  source: Source;
  category: Category;
  bucket: string;
  storagePath: string;
  fileName: string | null;
  fileType: string | null;
  isPdf: boolean;
  uploadedAt: string | null;
  uploadedByName: string | null;
  caption: string | null;
}

/**
 * GET /api/vehicles/[vin]/photos
 *
 * Unified per-vehicle photo timeline. Combines:
 *   - vehicle_photos (before / during / completion / damage / other)
 *   - graphics_proofs via the vehicle_proofs join table (proof)
 *   - graphics_job_files via fleet_checkins.matched_graphics_job_id (design_file)
 *
 * Explicitly excludes cni_job_photos (different workflow, different VIN space)
 * and part_files (catalog-level, not per-vehicle) per T1.4 locked decisions.
 */
export async function GET(req: NextRequest, { params }: { params: { vin: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const vin = (params.vin || '').toUpperCase();
  if (!vin) {
    return NextResponse.json({ error: 'vin required' }, { status: 400 });
  }

  // Most recent active checkin for this VIN
  const { data: checkin } = await supabase
    .from('fleet_checkins')
    .select('id, matched_graphics_job_id')
    .eq('vin', vin)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!checkin) {
    return NextResponse.json({ items: [], count: 0 });
  }

  const items: TimelineItem[] = [];

  // 1. vehicle_photos (direct FK on fleet_checkins.id)
  const { data: photoRows } = await supabase
    .from('vehicle_photos')
    .select('id, storage_path, photo_type, taken_at, caption, taken_by')
    .eq('vehicle_id', checkin.id);

  const uploaderIds = new Set<string>();
  for (const p of photoRows || []) {
    if (p.taken_by) uploaderIds.add(p.taken_by);
  }

  // 2. graphics_proofs via vehicle_proofs join table
  const { data: proofLinks } = await supabase
    .from('vehicle_proofs')
    .select('proof_id, linked_at, linked_by')
    .eq('vehicle_id', checkin.id);

  const proofIds = (proofLinks || []).map(r => r.proof_id).filter(Boolean);
  const proofById = new Map<string, any>();
  if (proofIds.length > 0) {
    const { data: proofRows } = await supabase
      .from('graphics_proofs')
      .select('id, file_name, file_type, storage_path, created_at, uploaded_by')
      .in('id', proofIds);
    for (const pr of proofRows || []) {
      proofById.set(pr.id, pr);
      if (pr.uploaded_by) uploaderIds.add(pr.uploaded_by);
    }
  }

  // 3. graphics_job_files via matched graphics job
  const { data: graphicsFiles } = checkin.matched_graphics_job_id
    ? await supabase
        .from('graphics_job_files')
        .select('id, file_name, file_type, storage_path, uploaded_at, uploaded_by')
        .eq('job_id', checkin.matched_graphics_job_id)
    : { data: [] };

  for (const g of graphicsFiles || []) {
    if (g.uploaded_by) uploaderIds.add(g.uploaded_by);
  }

  // Load uploader names in one shot
  const nameById = new Map<string, string>();
  if (uploaderIds.size > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', Array.from(uploaderIds));
    for (const p of profiles || []) {
      nameById.set(p.id, p.full_name || p.email || 'User');
    }
  }

  for (const p of photoRows || []) {
    const category = (p.photo_type as Category) || 'other';
    items.push({
      id: `vp:${p.id}`,
      source: 'vehicle_photo',
      category,
      bucket: 'photos',
      storagePath: p.storage_path,
      fileName: null,
      fileType: null,
      isPdf: false,
      uploadedAt: p.taken_at,
      uploadedByName: p.taken_by ? (nameById.get(p.taken_by) || null) : null,
      caption: p.caption || null,
    });
  }

  for (const link of proofLinks || []) {
    const pr = proofById.get(link.proof_id);
    if (!pr) continue;
    items.push({
      id: `gp:${pr.id}`,
      source: 'graphics_proof',
      category: 'proof',
      bucket: 'graphics-proofs',
      storagePath: pr.storage_path,
      fileName: pr.file_name,
      fileType: pr.file_type,
      isPdf: (pr.file_type || '').toLowerCase().includes('pdf') || (pr.file_name || '').toLowerCase().endsWith('.pdf'),
      uploadedAt: pr.created_at,
      uploadedByName: pr.uploaded_by ? (nameById.get(pr.uploaded_by) || null) : null,
      caption: null,
    });
  }

  for (const g of graphicsFiles || []) {
    items.push({
      id: `gjf:${g.id}`,
      source: 'graphics_job_file',
      category: 'design_file',
      bucket: 'graphics-proofs',
      storagePath: g.storage_path,
      fileName: g.file_name,
      fileType: g.file_type,
      isPdf: (g.file_type || '').toLowerCase().includes('pdf') || (g.file_name || '').toLowerCase().endsWith('.pdf'),
      uploadedAt: g.uploaded_at,
      uploadedByName: g.uploaded_by ? (nameById.get(g.uploaded_by) || null) : null,
      caption: null,
    });
  }

  items.sort((a, b) => (a.uploadedAt || '').localeCompare(b.uploadedAt || ''));

  return NextResponse.json({ items, count: items.length });
}
