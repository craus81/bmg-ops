import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { assignVehicleCredits } from '@/lib/pay-credits';

export const dynamic = 'force-dynamic';

// Insert + re-link + credit each vehicle; a large batch can exceed the default
// function timeout.
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface ScanRow {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  part_number: string | null;
  serial_number: string | null;
  imei: string | null;
  iccid: string | null;
  scanned_at: string;
  scanned_by: string | null;
  scanned_by_company: string | null;
}

/**
 * Scan-log rows that match a part, aren't already linked to any CNI job VIN,
 * and whose VIN isn't already on this job — vehicles that were scanned (e.g.
 * via the field /scan flow) but never attached to the CNI job. `partLike`
 * matches the part loosely (contains, case-insensitive) so scans logged under
 * a free-text part like "rfid" can be found; with no `partLike` it matches the
 * job's exact part.
 */
async function candidates(cniJobId: string, partLike?: string): Promise<{ jobPart: string | null; rows: ScanRow[] }> {
  const { data: job } = await service
    .from('cni_jobs').select('part_number').eq('id', cniJobId).single();
  const jobPart = job?.part_number || null;

  let query = service
    .from('scan_logs')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model, part_number, serial_number, imei, iccid, scanned_at, scanned_by, scanned_by_company')
    .order('scanned_at', { ascending: false })
    .limit(1000);
  // Part numbers are case-insensitive — match with ilike so a scan logged as
  // "06cs901033" still lines up with a job part of "06CS901033".
  if (partLike && partLike.trim()) query = query.ilike('part_number', `%${partLike.trim()}%`);
  else if (jobPart) query = query.ilike('part_number', jobPart);
  else return { jobPart, rows: [] };

  const { data: scans } = await query;
  if (!scans || scans.length === 0) return { jobPart, rows: [] };

  const { data: linked } = await service
    .from('cni_job_vins').select('scan_log_id').not('scan_log_id', 'is', null);
  const linkedSet = new Set((linked || []).map(l => l.scan_log_id));

  const { data: jobVins } = await service
    .from('cni_job_vins').select('vin').eq('job_id', cniJobId);
  const jobVinSet = new Set((jobVins || []).map(v => v.vin));

  return {
    jobPart,
    rows: (scans as ScanRow[]).filter(s => !linkedSet.has(s.id) && !jobVinSet.has(s.vin)),
  };
}

const GetSchema = z.object({
  cniJobId: z.string().uuid(),
  partLike: z.string().trim().max(120).optional(),
});

/** GET — list importable scanned vehicles for the job, with scanner names. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const q = validateSearchParams(req, GetSchema);
  if (q.error) return q.error;

  const { jobPart, rows } = await candidates(q.data.cniJobId, q.data.partLike);
  const scannerIds = [...new Set(rows.map(r => r.scanned_by).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (scannerIds.length > 0) {
    const { data: profiles } = await service.from('profiles').select('id, full_name').in('id', scannerIds);
    for (const p of profiles || []) names.set(p.id, p.full_name);
  }
  return NextResponse.json({
    jobPart,
    candidates: rows.map(r => ({
      scanLogId: r.id,
      vin: r.vin,
      vehicle: [r.vehicle_year, r.vehicle_make, r.vehicle_model].filter(Boolean).join(' '),
      partNumber: r.part_number,
      hasDevices: !!(r.serial_number && r.imei && r.iccid),
      scanned_at: r.scanned_at,
      scanned_by_name: r.scanned_by ? (names.get(r.scanned_by) || r.scanned_by_company || 'Unknown') : (r.scanned_by_company || '—'),
    })),
  });
}

const PostSchema = z.object({
  cniJobId: z.string().uuid(),
  partLike: z.string().trim().max(120).optional(),
  scanLogIds: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * POST — import the chosen scans onto the job as completed VINs. Reuses the
 * existing scan_logs row (no duplicate), re-stamps its part to the job's part
 * (so a scan logged under "rfid" gets consolidated under the real part for
 * reporting/invoicing), and re-links any of its pay credits to the new VIN so
 * back-pay/recompute see them and don't double-pay.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { cniJobId, partLike, scanLogIds } = parsed.data;

  const { data: job } = await service
    .from('cni_jobs').select('part_number, part_description, billable_customer').eq('id', cniJobId).single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  // Re-fetch the eligible set so a stale client can't import linked/dup scans.
  const { rows } = await candidates(cniJobId, partLike);
  const eligible = new Map(rows.map(r => [r.id, r]));

  const { data: maxVin } = await service
    .from('cni_job_vins').select('sort_order').eq('job_id', cniJobId)
    .order('sort_order', { ascending: false }).limit(1).maybeSingle();
  let sortOrder = ((maxVin?.sort_order as number | undefined) ?? -1) + 1;

  const assignedBy = auth.user?.id;
  let imported = 0;
  let credited = 0;
  const creditErrors: string[] = [];
  for (const scanLogId of scanLogIds) {
    const s = eligible.get(scanLogId);
    if (!s) continue;

    const { data: newVin, error } = await service
      .from('cni_job_vins')
      .insert({
        job_id: cniJobId,
        vin: s.vin,
        vehicle_year: s.vehicle_year,
        vehicle_make: s.vehicle_make,
        vehicle_model: s.vehicle_model,
        status: 'completed',
        completed_at: s.scanned_at,
        completed_by: s.scanned_by,
        serial_number: s.serial_number,
        imei: s.imei,
        iccid: s.iccid,
        scan_log_id: s.id,
        sort_order: sortOrder++,
      })
      .select('id')
      .single();
    if (error || !newVin) {
      return NextResponse.json({ error: 'Failed to import ' + s.vin + ': ' + (error?.message || 'unknown'), imported }, { status: 500 });
    }

    // Consolidate the scan under the job's real part (e.g. "rfid" → 06CS901033).
    if (job.part_number && s.part_number !== job.part_number) {
      await service
        .from('scan_logs')
        .update({ part_number: job.part_number, part_description: job.part_description, billable_customer: job.billable_customer })
        .eq('id', s.id);
    }

    // Associate (and re-stamp) any existing credits from this scan.
    await service
      .from('install_credits')
      .update({ cni_job_vin_id: newVin.id, part_number: job.part_number })
      .eq('scan_log_id', s.id)
      .is('cni_job_vin_id', null)
      .is('voided_at', null);

    // If the vehicle still has no live credit — field scans logged without an
    // active shift never created one — attribute it to the installer who
    // scanned it, at the job's pay rate, so imported work is paid just like a
    // vehicle completed on the job. Admins can re-tag afterward if the scanner
    // wasn't the installer who did the work.
    if (s.scanned_by && assignedBy) {
      const { data: live } = await service
        .from('install_credits')
        .select('id')
        .or(`scan_log_id.eq.${s.id},cni_job_vin_id.eq.${newVin.id}`)
        .is('voided_at', null)
        .limit(1);
      if (!live || live.length === 0) {
        const r = await assignVehicleCredits(service, {
          cniJobVinId: newVin.id,
          entries: [{ profile_id: s.scanned_by, share_weight: 1 }],
          assignedBy,
        });
        if (r.ok) credited++;
        else creditErrors.push(`${s.vin}: ${r.error}`);
      }
    }

    imported++;
  }

  return NextResponse.json({ success: true, imported, credited, creditErrors });
}
