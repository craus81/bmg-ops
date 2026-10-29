import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { fetchPartRowsCI } from '@/lib/part-number';
import { partsToSplit } from '@/lib/scan-part-split';
import { addPartToScans, ADD_PART_SOURCE_COLUMNS } from '@/lib/scan-add-part';
import { matchScansToOpenPos } from '@/lib/scan-match';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

// Same headroom and early stop as add-part: every split vehicle is an update
// plus one validated insert, photo copy and credit write per extra part.
export const maxDuration = 120;

const service = createServiceClient();

/**
 * Scans still open for billing whose part field holds two parts ("A/B"), and
 * whose whole string is not itself a catalog item. Invoiced and archived rows
 * are left alone — their billing is already done, and a sibling row added now
 * would bill the second part again.
 */
async function findSplittable(scanIds?: string[]) {
  const { data, error } = await fetchAllRows<any>((from, to) => {
    let q = service
      .from('scan_logs')
      .select(`${ADD_PART_SOURCE_COLUMNS}, part_number, part_description, po_id`)
      .like('part_number', '%/%')
      .is('invoice_number', null)
      .is('archived_at', null);
    if (scanIds) q = q.in('id', scanIds);
    return q.order('scanned_at', { ascending: false }).order('id').range(from, to);
  });
  if (error) return { error: error.message };
  const rows = data || [];
  const catalogWhole = await fetchPartRowsCI(service, rows.map(r => r.part_number), 'item_number');
  const catalogNumbers = catalogWhole.map(p => p.item_number as string);
  return {
    rows: rows
      .map(r => ({ row: r, parts: partsToSplit(r.part_number, catalogNumbers) }))
      .filter((x): x is { row: any; parts: string[] } => !!x.parts),
  };
}

/**
 * GET /api/scans/split-parts — the scans that would be split, for the Scans
 * page's "two parts in one field" banner.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const found = await findSplittable();
  if ('error' in found) return NextResponse.json({ error: found.error }, { status: 500 });
  return NextResponse.json({
    scans: found.rows.map(({ row, parts }) => ({
      id: row.id,
      vin: row.vin,
      part_number: row.part_number,
      parts,
      unit_number: row.unit_number,
      location_name: row.location_name,
      scanned_at: row.scanned_at,
    })),
  });
}

const Schema = z.object({
  scanIds: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * POST /api/scans/split-parts
 * Body: { scanIds }
 *
 * Splits each "A/B" scan into one row per part — the same thing as Edit Scan
 * → "split into A + B" → Apply, for many scans at once. The row keeps the
 * first part (and its photos, credits and history); every other part becomes
 * a sibling row through the shared add-part path, so it carries the visit
 * over and gets its own PO match and pay rate. The kept row is PO-matched
 * too when it had no PO, since "A/B" never matched one.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const found = await findSplittable(parsed.data.scanIds);
  if ('error' in found) return NextResponse.json({ error: found.error }, { status: 500 });
  if (found.rows.length === 0) {
    return NextResponse.json({ error: 'None of those scans have two parts in one field (or they are already invoiced or archived)' }, { status: 400 });
  }

  const deadline = Date.now() + (maxDuration - 25) * 1000;
  const allParts = [...new Set(found.rows.flatMap(x => x.parts.map(p => p.toUpperCase())))];
  const catalog = new Map(
    (await fetchPartRowsCI(service, allParts, 'item_number, display_name, billable_customer'))
      .map(p => [String(p.item_number).toUpperCase(), p]),
  );

  const problems: { vin: string; error: string }[] = [];
  const split: { id: string; vin: string; from: string; parts: string[] }[] = [];
  let notAttempted = 0;
  let creditsError: string | null = null;
  const rematch: string[] = [];

  for (const { row, parts } of found.rows) {
    if (Date.now() > deadline) { notAttempted++; continue; }

    // 1. The row itself becomes the first part.
    const first = catalog.get(parts[0].toUpperCase());
    const updates: Record<string, any> = {
      part_number: first?.item_number || parts[0],
      part_description: first?.display_name || parts[0],
    };
    if (!row.billable_customer && first?.billable_customer) updates.billable_customer = first.billable_customer;
    const { error: upErr } = await service.from('scan_logs').update(updates).eq('id', row.id);
    if (upErr) {
      // Usually the unique index: this vehicle already has a row for the
      // first part. Leave the "A/B" row for a person to look at.
      problems.push({ vin: row.vin, error: `${row.part_number}: ${upErr.message}` });
      continue;
    }
    if (!row.po_id) rematch.push(row.id);

    // 2. Every other part is a sibling row, exactly like "Add part".
    const added: string[] = [updates.part_number];
    for (const pn of parts.slice(1)) {
      const r = await addPartToScans(service, {
        actorId: auth.user.id,
        sources: [row],
        partNumber: catalog.get(pn.toUpperCase())?.item_number || pn,
        deadline: Number.POSITIVE_INFINITY,
      });
      if (r.added.length > 0) added.push(r.added[0].partNumber);
      // Already on the vehicle is fine: the part is recorded either way.
      for (const f of r.failures) problems.push({ vin: f.vin, error: `${pn}: ${f.error}` });
      if (r.creditsError && !creditsError) creditsError = r.creditsError;
    }
    split.push({ id: row.id, vin: row.vin, from: row.part_number, parts: added });
  }

  if (rematch.length > 0) {
    try {
      await matchScansToOpenPos(service, rematch);
    } catch (err) {
      console.warn('Split-part auto-match failed:', err);
    }
  }

  if (split.length > 0) {
    await logAudit(service, split.map(s => ({
      actorId: auth.user.id,
      table: 'scan_logs',
      recordId: s.id,
      action: 'split_parts',
      detail: { vin: s.vin, from: s.from, parts: s.parts },
    })));
  }

  return NextResponse.json({
    success: true,
    split: split.length,
    results: split,
    problems,
    notAttempted,
    creditsError,
  });
}
