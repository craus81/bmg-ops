import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { isVerizonRfidPart, validateSerial, validateImei, validateIccid } from '@/lib/rfid';
import { logScan, resolveScannerCompany } from '@/lib/scan-log';
import { canActOnCniJob, rolesOf } from '@/lib/cni-access';
import { ensureCniShift, createCompletionCredits } from '@/lib/pay-credits';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  jobId: z.string().uuid(),
  vin: z.string().trim().min(5).max(17),
  vehicle_year: z.string().trim().max(8).optional().nullable(),
  vehicle_make: z.string().trim().max(100).optional().nullable(),
  vehicle_model: z.string().trim().max(100).optional().nullable(),
  serial_number: z.string().trim().max(64).optional().nullable(),
  imei: z.string().trim().max(32).optional().nullable(),
  iccid: z.string().trim().max(32).optional().nullable(),
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Installer (or admin) scans a vehicle straight onto a CNI job and completes
 * it — for vehicles that aren't in the pre-loaded VIN list. Adds the VIN (or
 * reuses a matching pending one), logs it to scan_logs, and snapshots pay
 * credits from the active crew shift, exactly like completing a listed VIN.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId } = parsed.data;
  const vin = parsed.data.vin.trim().toUpperCase();

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, assigned_installer_id, assigned_company_id, pay_per_vehicle, part_number, part_description, billable_customer, address, title, status, device_capture')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: profile } = await supabase
    .from('profiles').select('role, roles').eq('id', auth.user.id).single();
  const isAdmin = rolesOf(profile).includes('admin');
  if (!isAdmin && !(await canActOnCniJob(supabase, auth.user.id, job))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rfid = isVerizonRfidPart(job.part_number) || !!job.device_capture;
  const serial = rfid ? validateSerial(parsed.data.serial_number || '') : null;
  const imei = rfid ? validateImei(parsed.data.imei || '') : null;
  const iccid = rfid ? validateIccid(parsed.data.iccid || '') : null;
  if (rfid && (!serial || !imei || !iccid)) {
    return NextResponse.json({ error: 'Serial, IMEI, and CCID are all required and must be valid' }, { status: 400 });
  }

  // Reuse a matching VIN already on the job if it isn't done yet; else insert.
  const { data: existing } = await supabase
    .from('cni_job_vins')
    .select('id, status, scan_log_id')
    .eq('job_id', jobId).eq('vin', vin).limit(1).maybeSingle();
  if (existing?.status === 'completed') {
    return NextResponse.json({ error: `${vin} is already completed on this job` }, { status: 409 });
  }

  let vinId = existing?.id as string | undefined;
  let priorScanLogId = existing?.scan_log_id as string | null | undefined;
  if (!vinId) {
    const { data: maxVin } = await supabase
      .from('cni_job_vins').select('sort_order').eq('job_id', jobId)
      .order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const sortOrder = ((maxVin?.sort_order as number | undefined) ?? -1) + 1;
    const { data: inserted, error: insErr } = await supabase
      .from('cni_job_vins')
      .insert({
        job_id: jobId, vin,
        vehicle_year: parsed.data.vehicle_year || null,
        vehicle_make: parsed.data.vehicle_make || null,
        vehicle_model: parsed.data.vehicle_model || null,
        status: 'pending', sort_order: sortOrder,
      })
      .select('id')
      .single();
    if (insErr || !inserted) {
      return NextResponse.json({ error: 'Failed to add vehicle: ' + (insErr?.message || 'unknown') }, { status: 500 });
    }
    vinId = inserted.id;
    priorScanLogId = null;
  }

  // Log to scan_logs (canonical) when the job has a part and not already logged.
  let scanLogId: string | null = priorScanLogId || null;
  if (job.part_number && !scanLogId) {
    const addr = (job.address || {}) as { city?: string; state?: string };
    const locationName = [addr.city, addr.state].filter(Boolean).join(', ') || job.title || null;
    const company = await resolveScannerCompany(supabase, auth.user.id);
    const result = await logScan(supabase, auth.user.id, company, {
      vin,
      vehicle_year: parsed.data.vehicle_year || null,
      vehicle_make: parsed.data.vehicle_make || null,
      vehicle_model: parsed.data.vehicle_model || null,
      part_number: job.part_number,
      part_description: job.part_description,
      billable_customer: job.billable_customer,
      serial_number: serial, imei, iccid,
      location_name: locationName,
    });
    if (!result.ok) {
      // Roll back a VIN we just inserted so nothing dangles.
      if (!existing) await supabase.from('cni_job_vins').delete().eq('id', vinId);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    scanLogId = result.scanLogId;
  }

  // Pay credits from the active shift (implicit solo shift if none tagged).
  const shift = await ensureCniShift(supabase, jobId, auth.user.id);
  let creditsError: string | null = shift ? null : 'Failed to open a shift for pay credits';
  if (shift) {
    const credits = await createCompletionCredits(supabase, {
      shiftId: shift.id, source: 'cni',
      ratePerVehicle: job.pay_per_vehicle != null ? Number(job.pay_per_vehicle) : null,
      completion: { scanLogId, cniJobVinId: vinId, vin, partNumber: job.part_number },
    });
    if (!credits.ok) creditsError = credits.error || 'Failed to write pay credits';
  }

  const { error: vinErr } = await supabase
    .from('cni_job_vins')
    .update({ status: 'completed', completed_at: new Date().toISOString(), completed_by: auth.user.id, shift_id: shift?.id || null, serial_number: serial, imei, iccid, scan_log_id: scanLogId })
    .eq('id', vinId);
  if (vinErr) return NextResponse.json({ error: 'Failed to complete VIN: ' + vinErr.message }, { status: 500 });

  // Completion is an explicit "Mark Job Complete" action now, not auto-advanced
  // when no VIN is left pending — scanning vehicles one-by-one would otherwise
  // mark the job done after the first car. See docs/cni-redesign.md §2.5.

  return NextResponse.json({ success: true, vinId, scanLogId, creditsError });
}
