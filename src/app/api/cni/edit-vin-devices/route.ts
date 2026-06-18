import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { validateSerial, validateImei, validateIccid } from '@/lib/rfid';
import { logScan, resolveScannerCompany } from '@/lib/scan-log';
import { canActOnCniJob, rolesOf } from '@/lib/cni-access';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  vinId: z.string().uuid(),
  serial_number: z.string().trim().max(64),
  imei: z.string().trim().max(32),
  iccid: z.string().trim().max(32),
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Retroactively set or fix the device identifiers (serial # / IMEI / CCID) on
 * a CNI job's vehicle. Keeps the canonical scan_logs row in sync: updates the
 * linked row if there is one, or creates one when the job carries a part
 * number (so the device data lands in reporting/invoicing too, not just on the
 * job VIN). For admins and the assigned company's installers.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { vinId } = parsed.data;

  const { data: vin } = await supabase
    .from('cni_job_vins')
    .select('id, job_id, vin, vehicle_year, vehicle_make, vehicle_model, scan_log_id')
    .eq('id', vinId)
    .single();
  if (!vin) return NextResponse.json({ error: 'VIN not found' }, { status: 404 });

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, assigned_installer_id, assigned_company_id, part_number, part_description, billable_customer, address, title')
    .eq('id', vin.job_id)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: profile } = await supabase
    .from('profiles').select('role, roles').eq('id', auth.user.id).single();
  const isAdmin = rolesOf(profile).includes('admin');
  if (!isAdmin && !(await canActOnCniJob(supabase, auth.user.id, job))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const serial = validateSerial(parsed.data.serial_number);
  const imei = validateImei(parsed.data.imei);
  const iccid = validateIccid(parsed.data.iccid);
  if (!serial || !imei || !iccid) {
    return NextResponse.json({ error: 'Serial, IMEI, and CCID are all required and must be valid' }, { status: 400 });
  }

  let scanLogId: string | null = vin.scan_log_id;
  if (scanLogId) {
    // Sync the existing canonical record.
    const { error } = await supabase
      .from('scan_logs')
      .update({ serial_number: serial, imei, iccid })
      .eq('id', scanLogId);
    if (error) return NextResponse.json({ error: 'Failed to update scan log: ' + error.message }, { status: 500 });
  } else if (job.part_number) {
    // No canonical record yet (e.g. completed before the part was set) — create
    // one so the device data is logged for reporting/invoicing.
    const company = await resolveScannerCompany(supabase, auth.user.id);
    const addr = (job.address || {}) as { city?: string; state?: string };
    const locationName = [addr.city, addr.state].filter(Boolean).join(', ') || job.title || null;
    const result = await logScan(supabase, auth.user.id, company, {
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
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    scanLogId = result.scanLogId;
  }

  const { error: vinErr } = await supabase
    .from('cni_job_vins')
    .update({ serial_number: serial, imei, iccid, scan_log_id: scanLogId })
    .eq('id', vinId);
  if (vinErr) return NextResponse.json({ error: 'Failed to update VIN: ' + vinErr.message }, { status: 500 });

  return NextResponse.json({ success: true, scanLogId, logged: !!scanLogId });
}
