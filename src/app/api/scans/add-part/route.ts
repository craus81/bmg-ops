import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logScan } from '@/lib/scan-log';
import { matchScansToOpenPos } from '@/lib/scan-match';
import { creditAddedPart } from '@/lib/pay-credits';
import { fetchPartRowsCI } from '@/lib/part-number';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  scanId: z.string().uuid(),
  partNumber: z.string().trim().min(1).max(120),
  partDescription: z.string().trim().max(500).optional().nullable(),
});

/**
 * POST /api/scans/add-part
 * Body: { scanId, partNumber, partDescription? }
 *
 * A second (third, fourth) part on a vehicle that was already scanned: a
 * decal kit and a unit number are one visit but two billable parts, and they
 * often sit on two different POs — which is two invoices, since invoicing
 * groups by customer + PO. scan_logs holds one part per row, so the vehicle
 * gets a sibling row here, exactly like a multi-part field scan writes one
 * row per selected part.
 *
 * Everything that belongs to the visit rather than the part is carried over
 * from the scan being added to — vehicle, unit #, customer, location,
 * installer, scan date, completion photos (migration 190: a multi-part scan
 * attaches the same photo to every part's row) and the crew's pay credits.
 * What is per-part is NOT: the added row gets its own PO match, its own field
 * pay rate, and no install_cost (a vendor is paid per install line, and
 * copying it would bill BMG for the same install twice).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { scanId, partNumber, partDescription } = parsed.data;

  const { data: source, error: srcErr } = await service
    .from('scan_logs')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model, vehicle_trim, body_class, billable_customer, unit_number, location_id, location_name, installer_name, scanned_at, scanned_by, scanned_by_company')
    .eq('id', scanId)
    .maybeSingle();
  if (srcErr) return NextResponse.json({ error: srcErr.message }, { status: 500 });
  if (!source) return NextResponse.json({ error: 'Scan not found' }, { status: 404 });

  // The catalog fills in what the caller didn't send. The customer stays the
  // vehicle's — two parts on one vehicle are billed to whoever is being
  // billed for the visit — and the catalog's customer only fills a blank.
  const [catalogPart] = await fetchPartRowsCI(service, [partNumber], 'item_number, display_name, billable_customer');

  const result = await logScan(
    service,
    // The install belongs to whoever did it, not to the admin adding the part.
    source.scanned_by || auth.user.id,
    source.scanned_by_company ?? null,
    {
      vin: source.vin,
      vehicle_year: source.vehicle_year,
      vehicle_make: source.vehicle_make,
      vehicle_model: source.vehicle_model,
      vehicle_trim: source.vehicle_trim,
      body_class: source.body_class,
      part_number: partNumber,
      part_description: partDescription || catalogPart?.display_name || null,
      billable_customer: source.billable_customer ?? catalogPart?.billable_customer ?? null,
      unit_number: source.unit_number,
      location_id: source.location_id,
      location_name: source.location_name,
      installer_name: source.installer_name,
      scanned_at: source.scanned_at,
      // Device IDs belong to the RFID part itself, so there are none to carry
      // over. An admin adding that part here fills them in on the scan editor
      // afterwards — refusing the row would leave no way to add it at all.
      skipDeviceValidation: true,
    },
  );

  // logScan's duplicate guard is what refuses a part the vehicle already has.
  if (!result.ok) {
    return NextResponse.json({ error: result.error, duplicate: result.duplicate }, { status: result.status });
  }

  // Completion photos are evidence of the visit, not of one part — the field
  // scanner attaches the same file to every part's row, so an added part gets
  // the same rows pointing at the same stored file.
  const { data: photos } = await service
    .from('scan_photos')
    .select('storage_path, content_type, taken_by')
    .eq('scan_log_id', source.id);
  if (photos && photos.length > 0) {
    await service.from('scan_photos').insert(
      photos.map(p => ({ ...p, scan_log_id: result.scanLogId })),
    );
  }

  // Pay the crew that was credited for this vehicle, at the added part's own
  // rate. Best-effort: a credit failure must not undo a saved scan — it is
  // reported so the admin can fix it in the pay editor.
  const credits = await creditAddedPart(service, {
    sourceScanLogId: source.id,
    targetScanLogId: result.scanLogId,
    vin: source.vin,
    partNumber,
    createdBy: auth.user.id,
  });

  // Auto-match the added part to an open PO — the whole point of the second
  // row is that it can land on a different PO than the first.
  try {
    await matchScansToOpenPos(service, [result.scanLogId]);
  } catch (err) {
    console.warn('Added-part auto-match failed:', err);
  }

  const { data: saved } = await service
    .from('scan_logs')
    .select('id, part_number, po_number')
    .eq('id', result.scanLogId)
    .maybeSingle();

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'scan_logs',
    recordId: result.scanLogId,
    action: 'add_part',
    detail: {
      from_scan_id: source.id,
      vin: source.vin,
      part_number: saved?.part_number || partNumber,
      po_number: saved?.po_number || null,
      photos_copied: photos?.length || 0,
      credits_written: credits.credited,
    },
  });

  return NextResponse.json({
    success: true,
    scanLogId: result.scanLogId,
    partNumber: saved?.part_number || partNumber,
    poNumber: saved?.po_number || null,
    creditsWritten: credits.credited,
    creditsError: credits.ok ? null : credits.error,
  });
}
