import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { logScan } from '@/lib/scan-log';
import { validateBody, z } from '@/lib/validate';
import { isVerizonRfidPart } from '@/lib/rfid';
import { createCompletionCredits, getFieldRate } from '@/lib/pay-credits';

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
 * Pay credits (cni-redesign §1.6): imported work was billable but never PAID
 * — the installer's crew got no install_credits. Now the admin can pick the
 * crew: one closed 'field' shift is created (the backfillJobCredits pattern)
 * and every imported scan snapshots credits to it at the part's field rate
 * (unpriced parts credit at NULL and land in the needs-pricing queue, same
 * as live field scans). The client threads the returned shiftId through its
 * chunks so one import = one shift.
 *
 * Duplicate override (cni-redesign §3.2): the near-duplicate check (VIN
 * last-8) is soft for admins — overrideDuplicates re-runs flagged rows with
 * logScan's allowNearDuplicate. Exact repeats still refuse.
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
  /** Crew to credit for the imported installs (equal split). Creates one
   *  closed field shift on the first chunk; omit to import without pay. */
  crewProfileIds: z.array(z.string().uuid()).max(20).optional(),
  /** Shift from a previous chunk of the same import — pass it back so all
   *  chunks credit one shift instead of creating one each. */
  shiftId: z.string().uuid().optional().nullable(),
  /** Admin near-duplicate override (last-8 collisions); exact dups still refuse. */
  overrideDuplicates: z.boolean().optional(),
  rows: z.array(RowSchema).min(1).max(500),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const {
    companyName, partNumber, partDescription, billableCustomer, locationName,
    additionalPartNumbers, crewProfileIds, overrideDuplicates, rows,
  } = parsed.data;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const extras = (additionalPartNumbers || []).map(p => p.trim()).filter(Boolean);

  // One closed shift per import to hang the crew's credits on (the
  // backfillJobCredits pattern) — created on the first chunk, reused via
  // shiftId on the rest. No crew → no shift → billable but unpaid, as before.
  let shiftId: string | null = parsed.data.shiftId || null;
  if (!shiftId && crewProfileIds && crewProfileIds.length > 0) {
    const now = new Date().toISOString();
    const { data: shift, error: shiftErr } = await supabase
      .from('work_shifts')
      .insert({
        context: 'field',
        part_number: partNumber,
        location_name: locationName ?? null,
        started_by: auth.user.id,
        started_at: now,
        ended_at: now,
      })
      .select('id')
      .single();
    if (shiftErr || !shift) {
      return NextResponse.json({ error: 'Failed to create the pay shift: ' + (shiftErr?.message || 'unknown') }, { status: 500 });
    }
    const { error: memErr } = await supabase.from('work_shift_members').insert(
      crewProfileIds.map(pid => ({ shift_id: shift.id, profile_id: pid, added_by: auth.user.id })),
    );
    if (memErr) {
      return NextResponse.json({ error: 'Failed to add crew to the pay shift: ' + memErr.message }, { status: 500 });
    }
    shiftId = shift.id;
  }

  // Field pay rate per part, looked up once per distinct part in this chunk.
  const rateCache = new Map<string, number | null>();
  const rateFor = async (part: string): Promise<number | null> => {
    if (!rateCache.has(part)) rateCache.set(part, await getFieldRate(supabase, part));
    return rateCache.get(part) ?? null;
  };

  const results: { vin: string; part?: string; ok: boolean; error?: string; duplicate?: boolean }[] = [];
  let created = 0;
  let credited = 0;
  let attempted = 0;
  let creditsError: string | null = null;
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
        allowNearDuplicate: !!overrideDuplicates,
      });
      if (res.ok) {
        created++;
        results.push({ vin: r.vin, part, ok: true });
        if (shiftId) {
          const credits = await createCompletionCredits(supabase, {
            shiftId,
            source: 'field',
            ratePerVehicle: await rateFor(part),
            completion: { scanLogId: res.scanLogId, vin: r.vin.trim().toUpperCase(), partNumber: part },
          });
          if (credits.ok) credited++;
          else creditsError = credits.error || 'Failed to write pay credits';
        }
      } else {
        results.push({ vin: r.vin, part, ok: false, error: res.error, duplicate: res.duplicate });
      }
    }
  }

  return NextResponse.json({ created, failed: attempted - created, credited, creditsError, shiftId, results });
}
