import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { storageDownloadUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** A VIN is never scanned hundreds of times; this is a sanity bound, not paging. */
const MAX_INSTALLS = 100;

interface InstallPhoto {
  id: string;
  url: string;
  /** 'installer' = the angle set shot on the job; 'completion' = the scanner's photo. */
  kind: 'installer' | 'completion';
  label: string;
  takenAt: string | null;
  takenByName: string | null;
}

/**
 * GET /api/vehicles/[vin]/installs — the vehicle record for work done OUTSIDE
 * the shop.
 *
 * A vehicle an installer completes in a customer's yard never gets a
 * fleet_checkins row, so it has no check-in timeline and, until now, no
 * record at all: its photos were reachable only by knowing which CNI job to
 * open. The install itself has always been recorded — /api/cni/complete-vin
 * writes a scan_logs row carrying the VIN, install location, billable
 * customer, part and device ids — so this reads that spine and hangs both
 * photo sets off it.
 *
 * Every join is a foreign key, never a VIN-string match:
 *   scan_photos.scan_log_id  → scan_logs        (the scanner's photo)
 *   cni_job_vins.scan_log_id → scan_logs        (which job completed it)
 *   cni_job_photos.vin_id    → cni_job_vins     (the installer's angles)
 * The one string comparison is finding the VIN's own rows, which is the
 * question being asked.
 *
 * Shop visits are NOT merged in — they keep their own screens (T1.4's
 * check-in-scoped timeline stays check-in-scoped). They are returned as
 * links so a vehicle that did both doesn't look like it only did one.
 */
export async function GET(req: NextRequest, { params }: { params: { vin: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const roles: string[] = auth.profile?.roles?.length ? auth.profile.roles : [auth.profile?.role];
  if (roles.includes('customer') && roles.length === 1) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const vin = (params.vin || '').trim().toUpperCase();
  if (!vin) return NextResponse.json({ error: 'vin required' }, { status: 400 });

  try {
    // The install spine: every scan of this VIN, newest first.
    const { data: scans, error: scanErr } = await supabase
      .from('scan_logs')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, part_number, part_description, billable_customer, unit_number, serial_number, imei, iccid, location_name, scanned_by, scanned_by_company, scanned_at')
      .ilike('vin', vin)
      .order('scanned_at', { ascending: false })
      .limit(MAX_INSTALLS);
    if (scanErr) throw new Error(`Could not read scans: ${scanErr.message}`);

    // CNI VIN rows for this VIN. Rows WITH a scan_log_id attach to the scan
    // above; rows without one are vehicles a crew has started but not
    // completed — they can already have photos (the completion gate makes
    // the crew submit them first), and leaving them out would hide photos
    // that exist.
    const { data: cniVins } = await supabase
      .from('cni_job_vins')
      .select('id, job_id, vin, status, scan_log_id, completed_at, completed_by, checkin_id, photos_submitted')
      .ilike('vin', vin);

    const scanIds = (scans || []).map(s => s.id);
    const cniVinIds = (cniVins || []).map(v => v.id);
    const jobIds = [...new Set((cniVins || []).map(v => v.job_id).filter(Boolean))] as string[];

    const [scanPhotosRes, cniPhotosRes, jobsRes, checkinsRes] = await Promise.all([
      scanIds.length
        ? supabase.from('scan_photos').select('id, scan_log_id, storage_path, created_at, taken_by').in('scan_log_id', scanIds).order('created_at')
        : Promise.resolve({ data: [] as any[] }),
      cniVinIds.length
        ? supabase.from('cni_job_photos').select('id, vin_id, storage_path, photo_type, uploaded_at, uploaded_by').in('vin_id', cniVinIds).order('uploaded_at')
        : Promise.resolve({ data: [] as any[] }),
      jobIds.length
        ? supabase.from('cni_jobs').select('id, job_number, title, address, assigned_company_id').in('id', jobIds)
        : Promise.resolve({ data: [] as any[] }),
      supabase.from('fleet_checkins').select('id, created_at, status, archived_at').ilike('vin', vin).order('created_at', { ascending: false }),
    ]);

    // Names for whoever appears on this record — bounded by the rows above.
    const userIds = [...new Set([
      ...(scans || []).map(s => s.scanned_by),
      ...(scanPhotosRes.data || []).map((p: any) => p.taken_by),
      ...(cniPhotosRes.data || []).map((p: any) => p.uploaded_by),
      ...(cniVins || []).map(v => v.completed_by),
    ].filter(Boolean))] as string[];
    const nameById = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: people } = await supabase.from('profiles').select('id, full_name, email').in('id', userIds);
      for (const p of people || []) nameById.set(p.id, p.full_name || p.email || 'User');
    }

    const companyIds = [...new Set((jobsRes.data || []).map((j: any) => j.assigned_company_id).filter(Boolean))] as string[];
    const companyById = new Map<string, string>();
    if (companyIds.length > 0) {
      const { data: companies } = await supabase.from('companies').select('id, name').in('id', companyIds);
      for (const c of companies || []) companyById.set(c.id, c.name);
    }

    const jobById = new Map((jobsRes.data || []).map((j: any) => [j.id, j]));
    const cniVinByScanId = new Map<string, any>();
    for (const v of cniVins || []) if (v.scan_log_id) cniVinByScanId.set(v.scan_log_id, v);

    const scanPhotosByScan = new Map<string, any[]>();
    for (const p of scanPhotosRes.data || []) {
      const arr = scanPhotosByScan.get(p.scan_log_id) || [];
      arr.push(p);
      scanPhotosByScan.set(p.scan_log_id, arr);
    }
    const cniPhotosByVin = new Map<string, any[]>();
    for (const p of cniPhotosRes.data || []) {
      const arr = cniPhotosByVin.get(p.vin_id) || [];
      arr.push(p);
      cniPhotosByVin.set(p.vin_id, arr);
    }

    const TYPE_LABELS: Record<string, string> = {
      front: 'Front', back: 'Back', driver_side: 'Driver Side',
      passenger_side: 'Passenger Side', vin_plate: 'VIN Plate',
      detail: 'Detail / Close-up', other: 'Other',
    };

    // storage_path carries either the full R2 key ('photos/…') or a
    // bucket-relative path on legacy rows — the same split the photo pages do.
    const photoUrl = (storagePath: string) => {
      const raw = String(storagePath || '');
      const rel = raw.startsWith('photos/') ? raw.slice('photos/'.length) : raw;
      return storageDownloadUrl('photos', rel, rel.split('/').pop() || 'photo.jpg');
    };

    const installerPhotos = (vinRowId: string | null): InstallPhoto[] =>
      (vinRowId ? cniPhotosByVin.get(vinRowId) || [] : []).map((p: any) => ({
        id: `cni:${p.id}`,
        url: photoUrl(p.storage_path),
        kind: 'installer' as const,
        label: TYPE_LABELS[p.photo_type] || p.photo_type || 'Photo',
        takenAt: p.uploaded_at || null,
        takenByName: p.uploaded_by ? (nameById.get(p.uploaded_by) || null) : null,
      }));

    const installs = (scans || []).map((s: any) => {
      const cniVin = cniVinByScanId.get(s.id) || null;
      const job = cniVin?.job_id ? jobById.get(cniVin.job_id) : null;
      const completionPhotos: InstallPhoto[] = (scanPhotosByScan.get(s.id) || []).map((p: any) => ({
        id: `scan:${p.id}`,
        url: photoUrl(p.storage_path),
        kind: 'completion' as const,
        label: 'Completion',
        takenAt: p.created_at || null,
        takenByName: p.taken_by ? (nameById.get(p.taken_by) || null) : null,
      }));
      return {
        id: s.id,
        kind: 'completed' as const,
        at: s.scanned_at,
        locationName: s.location_name || null,
        billableCustomer: s.billable_customer || null,
        partNumber: s.part_number || null,
        partDescription: s.part_description || null,
        unitNumber: s.unit_number || null,
        serialNumber: s.serial_number || null,
        imei: s.imei || null,
        iccid: s.iccid || null,
        byName: s.scanned_by ? (nameById.get(s.scanned_by) || null) : null,
        companyName: s.scanned_by_company
          || (job?.assigned_company_id ? companyById.get(job.assigned_company_id) || null : null),
        job: job ? { id: job.id, number: job.job_number || null, title: job.title || null } : null,
        // Installer angles first — they show the work; the scanner's photo is
        // the confirmation shot.
        photos: [...installerPhotos(cniVin?.id || null), ...completionPhotos],
      };
    });

    // Started-but-not-completed CNI vehicles, so photos already taken are
    // visible rather than waiting on a completion that may not come today.
    const inProgress = (cniVins || [])
      .filter(v => !v.scan_log_id)
      .map((v: any) => {
        const job = v.job_id ? jobById.get(v.job_id) : null;
        const addr = (job?.address || {}) as { city?: string; state?: string };
        return {
          id: v.id,
          kind: 'in_progress' as const,
          at: v.completed_at || null,
          locationName: [addr.city, addr.state].filter(Boolean).join(', ') || job?.title || null,
          billableCustomer: null,
          partNumber: null,
          partDescription: null,
          unitNumber: null,
          serialNumber: null,
          imei: null,
          iccid: null,
          byName: v.completed_by ? (nameById.get(v.completed_by) || null) : null,
          companyName: job?.assigned_company_id ? companyById.get(job.assigned_company_id) || null : null,
          job: job ? { id: job.id, number: job.job_number || null, title: job.title || null } : null,
          photos: installerPhotos(v.id),
          status: v.status || 'pending',
        };
      })
      // An untouched VIN row with no photos is noise on the record.
      .filter(v => v.photos.length > 0);

    const first: any = (scans || [])[0] || {};
    return NextResponse.json({
      success: true,
      vin,
      vehicle: {
        year: first.vehicle_year || null,
        make: first.vehicle_make || null,
        model: first.vehicle_model || null,
      },
      installs: [...installs, ...inProgress],
      // Links only: the shop keeps its own screens.
      shopVisits: (checkinsRes.data || []).map((c: any) => ({
        id: c.id, at: c.created_at, status: c.status, archived: !!c.archived_at,
      })),
      capped: (scans || []).length >= MAX_INSTALLS,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not load the vehicle record' }, { status: 500 });
  }
}
