/**
 * A second (third, fourth) part on vehicles that were already scanned — the
 * shared core of POST /api/scans/add-part (the Scans editor's "Add part") and
 * POST /api/scans/split-parts (splitting rows saved as "A/B").
 *
 * scan_logs holds one part per row, so each vehicle gets a sibling row.
 * Everything that belongs to the visit rather than the part is carried over
 * from the source scan — vehicle, unit #, customer, location, installer, scan
 * date, completion photos and the crew's pay credits. What is per-part is
 * NOT: each added row gets its own PO match, its own field pay rate, and no
 * install_cost (a vendor is paid per install line, and copying it would bill
 * BMG for the same install twice).
 *
 * Server-only: callers pass a service-role Supabase client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logScan } from '@/lib/scan-log';
import { matchScansToOpenPos } from '@/lib/scan-match';
import { creditAddedPart } from '@/lib/pay-credits';
import { fetchPartRowsCI } from '@/lib/part-number';
import { logAudit } from '@/lib/audit';

/** The scan_logs columns a source row needs for addPartToScans. */
export const ADD_PART_SOURCE_COLUMNS = 'id, vin, vehicle_year, vehicle_make, vehicle_model, vehicle_trim, body_class, billable_customer, unit_number, stock_number, location_id, location_name, installer_name, scanned_at, scanned_by, scanned_by_company';

export interface AddPartResult {
  added: { scanId: string; vin: string; partNumber: string; poNumber: string | null; sourceId: string }[];
  duplicates: { vin: string; error: string; sourceId: string }[];
  failures: { vin: string; error: string; sourceId: string }[];
  notAttempted: number;
  creditsWritten: number;
  creditsError: string | null;
}

export async function addPartToScans(
  service: SupabaseClient,
  opts: {
    actorId: string;
    sources: any[];
    partNumber: string;
    partDescription?: string | null;
    /** Stop starting new vehicles after this time (ms epoch); the rest count as notAttempted. */
    deadline: number;
  },
): Promise<AddPartResult> {
  const { actorId, sources, partNumber, partDescription, deadline } = opts;

  // The catalog fills in what the caller didn't send. The customer stays the
  // vehicle's — two parts on one vehicle are billed to whoever is being
  // billed for the visit — and the catalog's customer only fills a blank.
  const [catalogPart] = await fetchPartRowsCI(service, [partNumber], 'item_number, display_name, billable_customer');

  const added: AddPartResult['added'] = [];
  const duplicates: AddPartResult['duplicates'] = [];
  const failures: AddPartResult['failures'] = [];
  let creditsWritten = 0;
  let creditsError: string | null = null;

  let notAttempted = 0;

  for (const source of sources) {
    if (Date.now() > deadline) {
      notAttempted++;
      continue;
    }

    const result = await logScan(
      service,
      // The install belongs to whoever did it, not to the admin adding the part.
      source.scanned_by || actorId,
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
        stock_number: source.stock_number,
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
      (result.duplicate ? duplicates : failures).push({ vin: source.vin, error: result.error, sourceId: source.id });
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
      createdBy: actorId,
    });
    creditsWritten += credits.credited;
    if (!credits.ok && !creditsError) creditsError = credits.error || 'Failed to write pay credits';

    added.push({ scanId: result.scanLogId, vin: source.vin, partNumber, poNumber: null, sourceId: source.id });
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
      actorId: actorId,
      table: 'scan_logs',
      recordId: a.scanId,
      action: 'add_part',
      detail: { vin: a.vin, part_number: a.partNumber, po_number: a.poNumber },
    })));
  }


  return { added, duplicates, failures, notAttempted, creditsWritten, creditsError };
}
