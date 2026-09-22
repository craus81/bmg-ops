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

// A bulk add walks the selected scans one at a time (each is a validated
// insert, a photo copy and a credit write), so a whole selection needs real
// headroom. The loop also stops early — see `deadline` — so the response is
// always our own JSON saying which vehicles were left untouched, never a
// platform kill page.
export const maxDuration = 120;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  scanIds: z.array(z.string().uuid()).min(1).max(200),
  partNumber: z.string().trim().min(1).max(120),
  partDescription: z.string().trim().max(500).optional().nullable(),
});

/**
 * POST /api/scans/add-part
 * Body: { scanIds: string[], partNumber, partDescription? }
 *
 * A second (third, fourth) part on vehicles that were already scanned: a
 * decal kit and a unit number are one visit but two billable parts, and they
 * often sit on two different POs — which is two invoices, since invoicing
 * groups by customer + PO. scan_logs holds one part per row, so each vehicle
 * gets a sibling row here, exactly like a multi-part field scan writes one
 * row per selected part. (Two parts typed into one field as "A/B" are one
 * unmatchable string, which is what this replaces.)
 *
 * Everything that belongs to the visit rather than the part is carried over
 * from the scan being added to — vehicle, unit #, customer, location,
 * installer, scan date, completion photos (migration 190: a multi-part scan
 * attaches the same photo to every part's row) and the crew's pay credits.
 * What is per-part is NOT: each added row gets its own PO match, its own
 * field pay rate, and no install_cost (a vendor is paid per install line, and
 * copying it would bill BMG for the same install twice).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { scanIds, partNumber, partDescription } = parsed.data;

  const { data: sources, error: srcErr } = await service
    .from('scan_logs')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model, vehicle_trim, body_class, billable_customer, unit_number, location_id, location_name, installer_name, scanned_at, scanned_by, scanned_by_company')
    .in('id', scanIds);
  if (srcErr) return NextResponse.json({ error: srcErr.message }, { status: 500 });
  if (!sources || sources.length === 0) {
    return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
  }

  // The catalog fills in what the caller didn't send. The customer stays the
  // vehicle's — two parts on one vehicle are billed to whoever is being
  // billed for the visit — and the catalog's customer only fills a blank.
  const [catalogPart] = await fetchPartRowsCI(service, [partNumber], 'item_number, display_name, billable_customer');

  const added: { scanId: string; vin: string; partNumber: string; poNumber: string | null }[] = [];
  const duplicates: { vin: string; error: string }[] = [];
  const failures: { vin: string; error: string }[] = [];
  let creditsWritten = 0;
  let creditsError: string | null = null;

  const deadline = Date.now() + (maxDuration - 20) * 1000;
  let notAttempted = 0;

  for (const source of sources) {
    if (Date.now() > deadline) {
      notAttempted++;
      continue;
    }

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

    // logScan's duplicate guard is what refuses a part the vehicle already
    // has. Across a selection that is expected — some of those trucks may
    // already carry the part — so it is reported, not treated as a failure.
    if (!result.ok) {
      (result.duplicate ? duplicates : failures).push({ vin: source.vin, error: result.error });
      continue;
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
    creditsWritten += credits.credited;
    if (!credits.ok && !creditsError) creditsError = credits.error || 'Failed to write pay credits';

    added.push({ scanId: result.scanLogId, vin: source.vin, partNumber, poNumber: null });
  }

  // Auto-match the added parts to open POs — the whole point of the second
  // row is that it can land on a different PO than the first.
  if (added.length > 0) {
    try {
      await matchScansToOpenPos(service, added.map(a => a.scanId));
    } catch (err) {
      console.warn('Added-part auto-match failed:', err);
    }

    const { data: saved } = await service
      .from('scan_logs')
      .select('id, part_number, po_number')
      .in('id', added.map(a => a.scanId));
    for (const a of added) {
      const row = saved?.find(r => r.id === a.scanId);
      if (row) {
        a.partNumber = row.part_number || a.partNumber;
        a.poNumber = row.po_number || null;
      }
    }

    await logAudit(service, added.map(a => ({
      actorId: auth.user.id,
      table: 'scan_logs',
      recordId: a.scanId,
      action: 'add_part',
      detail: { vin: a.vin, part_number: a.partNumber, po_number: a.poNumber },
    })));
  }

  // Nothing landed: the caller asked for something that could not be done, so
  // say so as an error rather than a success with a zero in it. A single-scan
  // call from the scan editor reads the message straight out.
  if (added.length === 0 && (duplicates.length > 0 || failures.length > 0)) {
    const onlyDupes = failures.length === 0;
    const summary = sources.length === 1
      ? (duplicates[0]?.error || failures[0]?.error || 'Could not add the part')
      : onlyDupes
        ? `All ${duplicates.length} vehicle${duplicates.length === 1 ? '' : 's'} already carry ${partNumber}`
        : `Could not add ${partNumber} to any of the ${sources.length} vehicles — ${failures[0].error}`;
    return NextResponse.json(
      { error: summary, duplicate: onlyDupes, duplicates, failures },
      { status: onlyDupes ? 409 : 400 },
    );
  }

  return NextResponse.json({
    success: true,
    added: added.length,
    results: added,
    duplicates,
    failures,
    notAttempted,
    // Single-scan callers (the scan editor) read these directly.
    scanLogId: added[0]?.scanId || null,
    partNumber: added[0]?.partNumber || partNumber,
    poNumber: added[0]?.poNumber || null,
    creditsWritten,
    creditsError,
  });
}
