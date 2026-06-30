import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { isVerizonRfidPart, validateSerial, validateImei, validateIccid } from '@/lib/rfid';
import { logScan, resolveScannerCompany } from '@/lib/scan-log';
import { createCompletionCredits } from '@/lib/pay-credits';

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
  // Admin bypass: add the VIN and credit the crew even when the device IDs
  // (serial / IMEI / CCID) for an RFID job are missing.
  skip_devices: z.boolean().optional(),
  entries: z.array(z.object({
    profileId: z.string().uuid(),
    weight: z.number().positive().max(99),
  })).min(1).max(50),
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Admin: add a completed vehicle to a CNI job that was installed but never
 * scanned. Inserts the VIN (completed), logs it to scan_logs when the job has
 * a part, and credits the chosen crew at the job's per-vehicle rate — so a
 * missed vehicle still gets attributed to the right employee(s) in one step.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, entries, skip_devices: skipDevices } = parsed.data;
  const vin = parsed.data.vin.trim().toUpperCase();

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, part_number, part_description, billable_customer, address, title, pay_per_vehicle, device_capture')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  // Device IDs are required when the job captures devices (Verizon part or
  // flag) — unless the admin opts to skip them to log a missed vehicle.
  // Whatever IDs ARE provided are still validated; missing ones stay null.
  const rfid = isVerizonRfidPart(job.part_number) || !!job.device_capture;
  let serial: string | null = null, imei: string | null = null, iccid: string | null = null;
  if (rfid) {
    serial = validateSerial(parsed.data.serial_number || '');
    imei = validateImei(parsed.data.imei || '');
    iccid = validateIccid(parsed.data.iccid || '');
    if (!skipDevices && (!serial || !imei || !iccid)) {
      return NextResponse.json({ error: 'Serial, IMEI, and CCID are all required and must be valid' }, { status: 400 });
    }
  }

  const now = new Date().toISOString();
  const { data: maxVin } = await supabase
    .from('cni_job_vins').select('sort_order').eq('job_id', jobId)
    .order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const sortOrder = ((maxVin?.sort_order as number | undefined) ?? -1) + 1;

  const { data: newVin, error: vinErr } = await supabase
    .from('cni_job_vins')
    .insert({
      job_id: jobId,
      vin,
      vehicle_year: parsed.data.vehicle_year || null,
      vehicle_make: parsed.data.vehicle_make || null,
      vehicle_model: parsed.data.vehicle_model || null,
      status: 'completed',
      completed_at: now,
      completed_by: auth.user.id,
      serial_number: serial,
      imei,
      iccid,
      sort_order: sortOrder,
    })
    .select('id')
    .single();
  if (vinErr || !newVin) {
    return NextResponse.json({ error: 'Failed to add vehicle: ' + (vinErr?.message || 'unknown') }, { status: 500 });
  }

  // Always log to scan_logs (canonical record), even without a part — the VIN
  // then shows in the Scan Log flagged "needs part" instead of vanishing from
  // billing (docs/cni-redesign.md §1.3). On failure (e.g. duplicate VIN+part),
  // undo the VIN insert so nothing is left dangling.
  let scanLogId: string | null = null;
  {
    const company = await resolveScannerCompany(supabase, auth.user.id);
    const addr = (job.address || {}) as { city?: string; state?: string };
    const locationName = [addr.city, addr.state].filter(Boolean).join(', ') || job.title || null;
    const result = await logScan(supabase, auth.user.id, company, {
      vin,
      vehicle_year: parsed.data.vehicle_year || null,
      vehicle_make: parsed.data.vehicle_make || null,
      vehicle_model: parsed.data.vehicle_model || null,
      part_number: job.part_number,
      part_description: job.part_description,
      billable_customer: job.billable_customer,
      serial_number: serial,
      imei,
      iccid,
      location_name: locationName,
      skipDeviceValidation: skipDevices,
    });
    if (!result.ok) {
      await supabase.from('cni_job_vins').delete().eq('id', newVin.id);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    scanLogId = result.scanLogId;
  }

  // Closed shift carrying the chosen crew, then credits for this vehicle.
  const { data: shift, error: shiftErr } = await supabase
    .from('work_shifts')
    .insert({ context: 'cni', cni_job_id: jobId, started_by: auth.user.id, started_at: now, ended_at: now })
    .select('id')
    .single();
  if (shiftErr || !shift) {
    return NextResponse.json({ error: 'Vehicle added but crew shift failed: ' + (shiftErr?.message || 'unknown') }, { status: 500 });
  }
  await supabase.from('work_shift_members').insert(
    entries.map(e => ({ shift_id: shift.id, profile_id: e.profileId, share_weight: e.weight, added_by: auth.user.id })),
  );

  const rate = job.pay_per_vehicle != null ? Number(job.pay_per_vehicle) : null;
  const credits = await createCompletionCredits(supabase, {
    shiftId: shift.id,
    source: 'cni',
    ratePerVehicle: rate,
    completion: { cniJobVinId: newVin.id, scanLogId, vin, partNumber: job.part_number },
  });

  await supabase.from('cni_job_vins').update({ scan_log_id: scanLogId, shift_id: shift.id }).eq('id', newVin.id);

  return NextResponse.json({ success: true, vinId: newVin.id, credited: credits.ok, creditError: credits.ok ? null : credits.error });
}
