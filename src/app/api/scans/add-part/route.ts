import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { addPartToScans, ADD_PART_SOURCE_COLUMNS } from '@/lib/scan-add-part';

export const dynamic = 'force-dynamic';

// A bulk add walks the selected scans one at a time (each is a validated
// insert, a photo copy and a credit write), so a whole selection needs real
// headroom. The loop also stops early — see `deadline` — so the response is
// always our own JSON saying which vehicles were left untouched, never a
// platform kill page.
export const maxDuration = 120;

const service = createServiceClient();

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
    .select(ADD_PART_SOURCE_COLUMNS)
    .in('id', scanIds);
  if (srcErr) return NextResponse.json({ error: srcErr.message }, { status: 500 });
  if (!sources || sources.length === 0) {
    return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
  }

  const { added, duplicates, failures, notAttempted, creditsWritten, creditsError } = await addPartToScans(service, {
    actorId: auth.user.id,
    sources,
    partNumber,
    partDescription,
    deadline: Date.now() + (maxDuration - 20) * 1000,
  });

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
