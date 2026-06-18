import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

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
  serial_number: string | null;
  imei: string | null;
  iccid: string | null;
  scanned_at: string;
  scanned_by: string | null;
  scanned_by_company: string | null;
}

/**
 * Scan-log rows that match the job's part, aren't already linked to any CNI
 * job VIN, and whose VIN isn't already on this job — i.e. vehicles that were
 * scanned (e.g. via the field /scan flow) but never attached to the CNI job.
 */
async function candidates(cniJobId: string): Promise<{ part: string | null; rows: ScanRow[] }> {
  const { data: job } = await service
    .from('cni_jobs').select('part_number').eq('id', cniJobId).single();
  const part = job?.part_number || null;
  if (!part) return { part, rows: [] };

  const { data: scans } = await service
    .from('scan_logs')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model, serial_number, imei, iccid, scanned_at, scanned_by, scanned_by_company')
    .eq('part_number', part)
    .order('scanned_at', { ascending: false })
    .limit(1000);
  if (!scans || scans.length === 0) return { part, rows: [] };

  // Scan logs already attached to a CNI job VIN (anywhere).
  const { data: linked } = await service
    .from('cni_job_vins').select('scan_log_id').not('scan_log_id', 'is', null);
  const linkedSet = new Set((linked || []).map(l => l.scan_log_id));

  // VINs already on this job (avoid duplicates if added another way).
  const { data: jobVins } = await service
    .from('cni_job_vins').select('vin').eq('job_id', cniJobId);
  const jobVinSet = new Set((jobVins || []).map(v => v.vin));

  return {
    part,
    rows: (scans as ScanRow[]).filter(s => !linkedSet.has(s.id) && !jobVinSet.has(s.vin)),
  };
}

const GetSchema = z.object({ cniJobId: z.string().uuid() });

/** GET — list importable scanned vehicles for the job, with scanner names. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const q = validateSearchParams(req, GetSchema);
  if (q.error) return q.error;

  const { part, rows } = await candidates(q.data.cniJobId);
  const scannerIds = [...new Set(rows.map(r => r.scanned_by).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (scannerIds.length > 0) {
    const { data: profiles } = await service.from('profiles').select('id, full_name').in('id', scannerIds);
    for (const p of profiles || []) names.set(p.id, p.full_name);
  }
  return NextResponse.json({
    part,
    candidates: rows.map(r => ({
      scanLogId: r.id,
      vin: r.vin,
      vehicle: [r.vehicle_year, r.vehicle_make, r.vehicle_model].filter(Boolean).join(' '),
      hasDevices: !!(r.serial_number && r.imei && r.iccid),
      scanned_at: r.scanned_at,
      scanned_by_name: r.scanned_by ? (names.get(r.scanned_by) || r.scanned_by_company || 'Unknown') : (r.scanned_by_company || '—'),
    })),
  });
}

const PostSchema = z.object({
  cniJobId: z.string().uuid(),
  scanLogIds: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * POST — import the chosen scans onto the job as completed VINs. Reuses the
 * existing scan_logs row (no duplicate) and re-links any of its pay credits to
 * the new VIN so back-pay/recompute see them and don't double-pay.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { cniJobId, scanLogIds } = parsed.data;

  // Re-fetch the eligible set so a stale client can't import linked/dup scans.
  const { rows } = await candidates(cniJobId);
  const eligible = new Map(rows.map(r => [r.id, r]));

  const { data: maxVin } = await service
    .from('cni_job_vins').select('sort_order').eq('job_id', cniJobId)
    .order('sort_order', { ascending: false }).limit(1).maybeSingle();
  let sortOrder = ((maxVin?.sort_order as number | undefined) ?? -1) + 1;

  let imported = 0;
  for (const scanLogId of scanLogIds) {
    const s = eligible.get(scanLogId);
    if (!s) continue; // already linked / not eligible — skip silently

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

    // Associate any existing credits from this scan with the new job VIN.
    await service
      .from('install_credits')
      .update({ cni_job_vin_id: newVin.id })
      .eq('scan_log_id', s.id)
      .is('cni_job_vin_id', null)
      .is('voided_at', null);

    imported++;
  }

  return NextResponse.json({ success: true, imported });
}
