import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { logScan } from '@/lib/scan-log';
import { validateBody, z } from '@/lib/validate';
import { isVerizonRfidPart } from '@/lib/rfid';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/admin/import-installs
 *
 * Bulk-imports vehicle installs (one scan_logs row per vehicle × part)
 * credited to a named company — used to load a CNI installer's RFID work
 * from a spreadsheet. Reuses logScan(), so each row gets the same
 * validation, de-duplication, and device-field handling as a live scan. The
 * company is stamped as free text (scanned_by_company); scanned_by is the
 * importing admin.
 *
 * Multi-part (K8): a row's own partNumber overrides the run default, and
 * additionalPartNumbers are logged for EVERY vehicle on top of that (the
 * same VIN × parts cross the bulk-paste flow does). RFID device IDs attach
 * only to the Verizon RFID part's row when a vehicle logs several parts —
 * mirroring the interactive scanner, which only captures device IDs with
 * exactly one part selected.
 *
 * The client sends rows in chunks (≤500) and aggregates the per-row results.
 */

const RowSchema = z.object({
  vin: z.string().min(1).max(20),
  serialNumber: z.string().max(60).optional().nullable(),
  imei: z.string().max(40).optional().nullable(),
  iccid: z.string().max(40).optional().nullable(),
  vehicleYear: z.string().max(8).optional().nullable(),
  vehicleMake: z.string().max(100).optional().nullable(),
  vehicleModel: z.string().max(100).optional().nullable(),
  unitNumber: z.string().max(60).optional().nullable(),
  partNumber: z.string().max(80).optional().nullable(),
});

const Schema = z.object({
  companyName: z.string().min(1).max(200),
  partNumber: z.string().min(1).max(80),
  partDescription: z.string().max(200).optional().nullable(),
  billableCustomer: z.string().max(200).optional().nullable(),
  locationName: z.string().max(200).optional().nullable(),
  additionalPartNumbers: z.array(z.string().min(1).max(80)).max(10).optional(),
  rows: z.array(RowSchema).min(1).max(500),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { companyName, partNumber, partDescription, billableCustomer, locationName, additionalPartNumbers, rows } = parsed.data;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const extras = (additionalPartNumbers || []).map(p => p.trim()).filter(Boolean);

  const results: { vin: string; part?: string; ok: boolean; error?: string }[] = [];
  let created = 0;
  let attempted = 0;
  for (const r of rows) {
    const primary = r.partNumber?.trim() || partNumber;
    const parts = [primary, ...extras.filter(p => p !== primary)];
    for (const part of parts) {
      attempted++;
      // Device IDs belong to the RFID part's row; on single-part vehicles
      // they ride along regardless (nothing else could own them).
      const deviceRow = parts.length === 1 || isVerizonRfidPart(part);
      const res = await logScan(supabase, auth.user.id, companyName, {
        vin: r.vin,
        vehicle_year: r.vehicleYear ?? null,
        vehicle_make: r.vehicleMake ?? null,
        vehicle_model: r.vehicleModel ?? null,
        part_number: part,
        part_description: part === partNumber ? (partDescription ?? null) : null,
        billable_customer: billableCustomer ?? null,
        unit_number: r.unitNumber ?? null,
        serial_number: deviceRow ? (r.serialNumber ?? null) : null,
        imei: deviceRow ? (r.imei ?? null) : null,
        iccid: deviceRow ? (r.iccid ?? null) : null,
        location_name: locationName ?? null,
      });
      if (res.ok) {
        created++;
        results.push({ vin: r.vin, part, ok: true });
      } else {
        results.push({ vin: r.vin, part, ok: false, error: res.error });
      }
    }
  }

  return NextResponse.json({ created, failed: attempted - created, results });
}
