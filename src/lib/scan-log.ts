/**
 * Shared scan-logging logic — the single source of truth for writing a row to
 * scan_logs, used by every scan path (the main /scan page via /api/scans/log,
 * and the CNI installer flow via /api/cni/complete-vin).
 *
 * Keeping this in one place is deliberate: the three scanning contexts (admin,
 * BMG field installers, CNI installers) run the SAME process and differ only in
 * small, account-driven ways (who's allowed to write, where the VIN comes from,
 * which company is stamped). The validation, de-duplication, and insert live
 * here so a change applies to all three at once.
 *
 * Server-only: callers pass a service-role Supabase client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isVerizonRfidPart, validateSerial, validateImei, validateIccid } from './rfid';

export interface ScanRecordInput {
  vin: string;
  vehicle_year?: string | null;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  vehicle_trim?: string | null;
  body_class?: string | null;
  part_number?: string | null;
  part_description?: string | null;
  billable_customer?: string | null;
  unit_number?: string | null;
  serial_number?: string | null;
  imei?: string | null;
  iccid?: string | null;
  location_id?: string | null;
  location_name?: string | null;
}

export type LogScanResult =
  | { ok: true; scanLogId: string }
  | { ok: false; status: number; error: string };

/**
 * Resolve the company to stamp on a scan, given the scanning user — their
 * assigned company (profiles.company_id → companies.name), the same list used
 * everywhere else. Internal staff without a company stamp null.
 */
export async function resolveScannerCompany(
  service: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: profile } = await service
    .from('profiles')
    .select('company_id')
    .eq('id', userId)
    .maybeSingle();
  if (!profile?.company_id) return null;
  const { data: company } = await service
    .from('companies')
    .select('name')
    .eq('id', profile.company_id)
    .maybeSingle();
  return company?.name || null;
}

/**
 * Validate, de-dupe, and insert one scan_logs row. `scannedBy` and `company`
 * come from the authenticated account (never trusted from the client).
 */
export async function logScan(
  service: SupabaseClient,
  scannedBy: string,
  company: string | null,
  rec: ScanRecordInput,
): Promise<LogScanResult> {
  const vin = (rec.vin || '').trim().toUpperCase();
  if (vin.length < 5) return { ok: false, status: 400, error: 'VIN too short' };

  // Verizon RFID part requires all three device identifiers, validated.
  let serial = rec.serial_number ?? null;
  let imei = rec.imei ?? null;
  let iccid = rec.iccid ?? null;
  if (isVerizonRfidPart(rec.part_number)) {
    serial = validateSerial(serial || '');
    imei = validateImei(imei || '');
    iccid = validateIccid(iccid || '');
    if (!serial || !imei || !iccid) {
      return { ok: false, status: 400, error: 'Serial, IMEI, and CCID are all required and must be valid' };
    }
  }

  // Duplicate guards: same VIN+part, and (for devices) same IMEI.
  if (rec.part_number) {
    const { data: dup } = await service
      .from('scan_logs')
      .select('id, scanned_at')
      .eq('vin', vin)
      .eq('part_number', rec.part_number)
      .limit(1);
    if (dup && dup.length > 0) {
      const when = new Date(dup[0].scanned_at).toLocaleDateString();
      return { ok: false, status: 409, error: `Duplicate — ${vin} already scanned for ${rec.part_number} on ${when}` };
    }
  }
  if (imei) {
    const { data: dupImei } = await service.from('scan_logs').select('id').eq('imei', imei).limit(1);
    if (dupImei && dupImei.length > 0) {
      return { ok: false, status: 409, error: `IMEI ${imei} is already logged` };
    }
  }

  const { data, error } = await service
    .from('scan_logs')
    .insert({
      vin,
      vehicle_year: rec.vehicle_year ?? null,
      vehicle_make: rec.vehicle_make ?? null,
      vehicle_model: rec.vehicle_model ?? null,
      vehicle_trim: rec.vehicle_trim ?? null,
      body_class: rec.body_class ?? null,
      part_number: rec.part_number ?? null,
      part_description: rec.part_description ?? null,
      billable_customer: rec.billable_customer ?? null,
      unit_number: rec.unit_number ?? null,
      serial_number: serial,
      imei,
      iccid,
      location_id: rec.location_id ?? null,
      location_name: rec.location_name ?? null,
      scanned_by: scannedBy,
      scanned_by_company: company,
    })
    .select('id')
    .single();

  if (error) return { ok: false, status: 500, error: 'Failed to save scan: ' + error.message };
  return { ok: true, scanLogId: data.id };
}
