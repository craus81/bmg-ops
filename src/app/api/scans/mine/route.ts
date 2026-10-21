import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAuth, isInternalStaffRole, getProfileRoles } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { storageDownloadUrl } from '@/lib/storage';
import { fetchAllRows } from '@/lib/fetch-all';
import { groupMyScans, type MyScanPhotoRow, type MyScanRow } from '@/lib/my-scans';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const Schema = z.object({
  days: z.coerce.number().int().refine(d => d === 1 || d === 7 || d === 30).optional(),
  /** The phone's offset from UTC in minutes (Date#getTimezoneOffset), so "Today" and day groups are local days. */
  tz: z.coerce.number().int().min(-840).max(840).optional(),
});

/**
 * GET /api/scans/mine?days=1|7|30 — the caller's own scans and the photos
 * on them, for "My scans" on the Scan screen (Craig, 2026-10-20). Same
 * allowlist as logging a scan (internal staff or the CNI installer role),
 * and always filtered to scanned_by = the caller, so nobody sees anyone
 * else's work. No prices or pay: the select carries none.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  const roles = getProfileRoles(auth.profile);
  if (!isInternalStaffRole(auth.profile) && !roles.includes('installer')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = validateSearchParams(req, Schema);
  if (parsed.error) return parsed.error;
  const days = parsed.data.days ?? 1;
  const tz = parsed.data.tz ?? 0;

  // Start of the caller's local day, (days - 1) days back.
  const localNow = new Date(Date.now() - tz * 60_000);
  const localMidnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  const since = new Date(localMidnight + tz * 60_000 - (days - 1) * 86_400_000).toISOString();
  const dayKey = (iso: string) => new Date(new Date(iso).getTime() - tz * 60_000).toISOString().slice(0, 10);

  const scansRes = await fetchAllRows<MyScanRow>((from, to) => supabase
    .from('scan_logs')
    .select('id, vin, part_number, unit_number, billable_customer, location_name, vehicle_year, vehicle_make, vehicle_model, scanned_at')
    .eq('scanned_by', auth.user.id)
    .gte('scanned_at', since)
    .order('scanned_at', { ascending: false })
    .order('id')
    .range(from, to));
  if (scansRes.error) return NextResponse.json({ error: scansRes.error.message }, { status: 500 });

  const ids = scansRes.data.map(s => s.id);
  const photos: MyScanPhotoRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from('scan_photos')
      .select('scan_log_id, storage_path, created_at')
      .in('scan_log_id', ids.slice(i, i + 200));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    photos.push(...(data || []));
  }

  const groups = groupMyScans(scansRes.data, photos, dayKey).map(({ photoPaths, ...g }) => ({
    ...g,
    day: dayKey(g.scannedAt),
    photos: photoPaths.map(path => ({ path, url: storageDownloadUrl('photos', path, 'scan-photo.jpg') })),
  }));

  return NextResponse.json({ scans: groups, days });
}
