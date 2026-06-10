import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { isVerizonRfidPart, validateSerial, validateImei, validateIccid } from '@/lib/rfid';
import { logScan, resolveScannerCompany } from '@/lib/scan-log';

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

  // Load the job and authorize: assigned installer or admin.
  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, assigned_installer_id, part_number, part_description, billable_customer, address, title, status')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: profile } = await supabase
    .from('profiles').select('role, roles').eq('id', auth.user.id).single();
  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const isAdmin = roles.includes('admin');
  if (!isAdmin && job.assigned_installer_id !== auth.user.id) {
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

  // Cleaned device values for mirroring onto the VIN (logScan validates again).
  const rfid = isVerizonRfidPart(job.part_number);
  const serial = rfid ? validateSerial(parsed.data.serial_number || '') : null;
  const imei = rfid ? validateImei(parsed.data.imei || '') : null;
  const iccid = rfid ? validateIccid(parsed.data.iccid || '') : null;
  if (rfid && (!serial || !imei || !iccid)) {
    return NextResponse.json({ error: 'Serial, IMEI, and CCID are all required and must be valid' }, { status: 400 });
  }

  // Log to scan_logs via the shared helper (same logic as the main scan page).
  // Only when the job has a part and this VIN isn't already logged — idempotent.
  const scanner = job.assigned_installer_id || auth.user.id;
  let scanLogId: string | null = vin.scan_log_id;
  if (job.part_number && !vin.scan_log_id) {
    const addr = (job.address || {}) as { city?: string; state?: string };
    const locationName = [addr.city, addr.state].filter(Boolean).join(', ') || job.title || null;
    const company = await resolveScannerCompany(supabase, scanner);

    const result = await logScan(supabase, scanner, company, {
      vin: vin.vin,
      vehicle_year: vin.vehicle_year,
      vehicle_make: vin.vehicle_make,
      vehicle_model: vin.vehicle_model,
      part_number: job.part_number,
      part_description: job.part_description,
      billable_customer: job.billable_customer,
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

  // Mark the VIN complete and mirror the captured identifiers onto it.
  const { error: vinErr } = await supabase
    .from('cni_job_vins')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      serial_number: serial,
      imei,
      iccid,
      scan_log_id: scanLogId,
    })
    .eq('id', vinId);
  if (vinErr) {
    return NextResponse.json({ error: 'Failed to complete VIN: ' + vinErr.message }, { status: 500 });
  }

  // If every VIN on the job is now complete, advance the job to review.
  let jobCompleted = false;
  const { data: remaining } = await supabase
    .from('cni_job_vins').select('id').eq('job_id', jobId).neq('status', 'completed');
  if ((remaining?.length || 0) === 0 && job.status === 'in_progress') {
    await supabase.from('cni_jobs').update({
      status: 'completed_pending_review',
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);
    jobCompleted = true;
  }

  return NextResponse.json({ success: true, scanLogId, jobCompleted });
}
