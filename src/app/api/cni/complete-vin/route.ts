import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { isVerizonRfidPart, validateSerial, validateImei, validateIccid } from '@/lib/rfid';
import { logScan, resolveScannerCompany } from '@/lib/scan-log';
import { canActOnCniJob } from '@/lib/cni-access';
import { ensureCniShift, createCompletionCredits, getOpenCniShift } from '@/lib/pay-credits';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  jobId: z.string().uuid(),
  vinId: z.string().uuid(),
  serial_number: z.string().trim().max(64).optional().nullable(),
  imei: z.string().trim().max(32).optional().nullable(),
  iccid: z.string().trim().max(32).optional().nullable(),
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Completes a CNI job VIN. When the job carries a part number, this also logs
 * the install to scan_logs (the unified record used by /admin/scans) — exactly
 * like the main scan page. For the Verizon RFID part, the three device
 * identifiers are required and stored on the same scan_logs row.
 *
 * Installers can't write scan_logs directly (RLS is internal-staff only), so
 * this runs server-side with the service role after verifying the caller is the
 * job's assigned installer (or an admin).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, vinId } = parsed.data;

  // Load the job and authorize: any installer at the assigned company, the
  // legacy assigned installer, or an admin (company model — no lead).
  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, assigned_installer_id, assigned_company_id, pay_per_vehicle, part_number, part_description, billable_customer, address, title, status, device_capture')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: profile } = await supabase
    .from('profiles').select('role, roles').eq('id', auth.user.id).single();
  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const isAdmin = roles.includes('admin');
  if (!isAdmin && !(await canActOnCniJob(supabase, auth.user.id, job))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Load the VIN and confirm it belongs to this job.
  const { data: vin } = await supabase
    .from('cni_job_vins')
    .select('id, job_id, vin, vehicle_year, vehicle_make, vehicle_model, scan_log_id')
    .eq('id', vinId)
    .single();
  if (!vin || vin.job_id !== jobId) {
    return NextResponse.json({ error: 'VIN not found for this job' }, { status: 404 });
  }

  // The part is whatever the crew picked for the open shift (CNI field-shift
  // model, §1.2), falling back to the job's default when no shift part is set.
  // It drives RFID device capture, the scan_logs row, and the pay credit.
  const open = await getOpenCniShift(supabase, jobId);
  const effPart = open?.part_number ?? job.part_number;
  const effPartDescription = open?.part_number ? open.part_description : job.part_description;
  const effBillableCustomer = open?.part_number ? open.billable_customer : job.billable_customer;

  // Device capture (serial / IMEI / ICCID) applies to the Verizon RFID part
  // or any job flagged for it.
  const rfid = isVerizonRfidPart(effPart) || !!job.device_capture;
  const serial = rfid ? validateSerial(parsed.data.serial_number || '') : null;
  const imei = rfid ? validateImei(parsed.data.imei || '') : null;
  const iccid = rfid ? validateIccid(parsed.data.iccid || '') : null;
  if (rfid && (!serial || !imei || !iccid)) {
    return NextResponse.json({ error: 'Serial, IMEI, and CCID are all required and must be valid' }, { status: 400 });
  }

  // Log to scan_logs via the shared helper (same logic as the main scan page).
  // Only when the job has a part and this VIN isn't already logged — idempotent.
  // Scans are attributed to whoever actually scanned, not the legacy assigned
  // installer — with company assignment any crew member may be completing.
  const scanner = auth.user.id;
  let scanLogId: string | null = vin.scan_log_id;
  // Always log to scan_logs so a completed VIN reaches the Scan Log even when
  // the job has no part yet (it lands flagged "needs part", instead of
  // vanishing from billing). See docs/cni-redesign.md §1.3 / §3.6.
  if (!vin.scan_log_id) {
    const addr = (job.address || {}) as { city?: string; state?: string };
    const locationName = [addr.city, addr.state].filter(Boolean).join(', ') || job.title || null;
    const company = await resolveScannerCompany(supabase, scanner);

    const result = await logScan(supabase, scanner, company, {
      vin: vin.vin,
      vehicle_year: vin.vehicle_year,
      vehicle_make: vin.vehicle_make,
      vehicle_model: vin.vehicle_model,
      part_number: effPart,
      part_description: effPartDescription,
      billable_customer: effBillableCustomer,
      serial_number: serial,
      imei,
      iccid,
      location_name: locationName,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    scanLogId = result.scanLogId;
  }

  // Pay credits: snapshot the active shift's crew for this vehicle. If no
  // shift was started, an implicit solo shift is created (crew of one).
  const shift = await ensureCniShift(supabase, jobId, auth.user.id);
  let creditsError: string | null = shift ? null : 'Failed to open a shift for pay credits';
  if (shift) {
    const credits = await createCompletionCredits(supabase, {
      shiftId: shift.id,
      source: 'cni',
      ratePerVehicle: job.pay_per_vehicle != null ? Number(job.pay_per_vehicle) : null,
      completion: {
        scanLogId,
        cniJobVinId: vinId,
        vin: vin.vin,
        partNumber: effPart,
      },
    });
    if (!credits.ok) creditsError = credits.error || 'Failed to write pay credits';
  }

  // Mark the VIN complete and mirror the captured identifiers onto it.
  const { error: vinErr } = await supabase
    .from('cni_job_vins')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      completed_by: auth.user.id,
      shift_id: shift?.id || null,
      serial_number: serial,
      imei,
      iccid,
      scan_log_id: scanLogId,
    })
    .eq('id', vinId);
  if (vinErr) {
    return NextResponse.json({ error: 'Failed to complete VIN: ' + vinErr.message }, { status: 500 });
  }

  // Completion is now an explicit "Mark Job Complete" action (installer or
  // admin), NOT auto-advanced when the VIN list empties. In the scan-as-you-go
  // model the first scanned vehicle leaves zero pending VINs, which would
  // otherwise mark the whole job done after one car. See docs/cni-redesign.md §2.5.

  // A credits failure doesn't undo the completion — the vehicle IS done; the
  // missing credits surface in the admin shift editor and can be rebuilt.
  return NextResponse.json({ success: true, scanLogId, creditsError });
}
