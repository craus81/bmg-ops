import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { storageDownloadUrl } from '@/lib/storage';
import { normalizeItemNumber } from '@/lib/vendor-po-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  partNumber: z.string().trim().min(1).max(80),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const MAX_SCANS = 500;

/**
 * GET /api/parts/install-photos?partNumber= — the part, actually
 * installed on real vehicles.
 *
 * This is the half of closed PR #463 that never shipped. That branch
 * denormalized part_number and vin onto scan_photos and queried them
 * directly; the schema that landed (migration 190) has neither column, so
 * this joins through scan_photos.scan_log_id → scan_logs instead.
 *
 * The join is the better design anyway: a part number corrected on the
 * scan flows straight through to the gallery, where a denormalized copy
 * would go stale and quietly file the photo under the wrong part forever.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const roles: string[] = auth.profile?.roles?.length ? auth.profile.roles : [auth.profile?.role];
  if (roles.includes('customer') && roles.length === 1) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = validateSearchParams(req, Schema);
  if (parsed.error) return parsed.error;
  const wanted = normalizeItemNumber(parsed.data.partNumber);
  const limit = parsed.data.limit ?? 60;

  try {
    // Scans of this part, newest first. Bounded: a high-volume part has
    // thousands of installs and the gallery only ever shows a page.
    const { data: scans, error: scanErr } = await supabase
      .from('scan_logs')
      .select('id, vin, part_number, vehicle_year, vehicle_make, vehicle_model, scanned_at, scanned_by')
      .ilike('part_number', wanted)
      .order('scanned_at', { ascending: false })
      .limit(MAX_SCANS);
    if (scanErr) throw new Error(`Could not read scans: ${scanErr.message}`);
    if (!scans || scans.length === 0) {
      return NextResponse.json({ success: true, photos: [], scansSearched: 0 });
    }

    const scanById = new Map(scans.map(s => [s.id as string, s]));
    const photos: any[] = [];
    const ids = scans.map(s => s.id as string);
    for (let i = 0; i < ids.length && photos.length < limit; i += 100) {
      const { data, error } = await supabase
        .from('scan_photos')
        .select('id, scan_log_id, storage_path, content_type, taken_by, created_at')
        .in('scan_log_id', ids.slice(i, i + 100))
        .order('created_at', { ascending: false });
      if (error) throw new Error(`Could not read scan photos: ${error.message}`);
      for (const p of data || []) photos.push(p);
    }

    // Who took them, for the caption.
    const takerIds = [...new Set(photos.map(p => p.taken_by).filter(Boolean))] as string[];
    const takers = new Map<string, string>();
    if (takerIds.length > 0) {
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', takerIds);
      for (const t of data || []) takers.set(t.id, t.full_name || '');
    }

    const out = photos.slice(0, limit).map(p => {
      const scan: any = scanById.get(p.scan_log_id) || {};
      return {
        id: p.id,
        // Credentialed download route, never a public URL (R3-22).
        url: storageDownloadUrl('photos', p.storage_path, 'installed.jpg'),
        vin: scan.vin || null,
        vehicle: [scan.vehicle_year, scan.vehicle_make, scan.vehicle_model].filter(Boolean).join(' ') || null,
        partNumber: scan.part_number || null,
        installedAt: scan.scanned_at || p.created_at,
        takenBy: p.taken_by ? (takers.get(p.taken_by) || null) : null,
      };
    });

    return NextResponse.json({
      success: true,
      photos: out,
      // How many scans were looked at, so "no photos" can be read as
      // "nobody photographed these" rather than "this part is never fitted".
      scansSearched: scans.length,
      capped: scans.length >= MAX_SCANS,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not load installed photos' }, { status: 500 });
  }
}
