import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { suiteqlQuery, suiteqlQueryAll, updateInvoiceLocation } from '@/lib/netsuite';
import { resolveInvoiceLocation, getActiveLocations } from '@/lib/invoice-location';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/netsuite/backfill-invoice-locations
 *
 * Retroactively sets the NetSuite Location on FleetSuite-created invoices to
 * the location our PO rules imply (src/lib/invoice-location.ts — Masterack →
 * plant, Designs That Stick → Kansas City, everything else → O'Fallon),
 * reusing the exact resolver the live creation paths now use.
 *
 * SAFE BY DEFAULT: dryRun is true unless you explicitly pass dryRun:false, and
 * even then only invoices whose location is actually wrong are touched.
 * Invoices in a closed accounting period are reported, not forced.
 *
 * Body (all optional):
 *   { dryRun?: boolean=true, limit?: number, invoiceIds?: string[], customer?: string }
 *   - invoiceIds: restrict to a hand-picked set. This is also the FAST path —
 *     when present, only those invoices are looked up (no broad scan), so it's
 *     the right way to apply in chunks without timing out.
 *   - customer:   case-insensitive substring filter on the invoice's customer.
 *   - limit:      cap how many *changes* are processed (applies after filtering).
 *
 * Enumeration of "all FleetSuite invoices" (only when invoiceIds is omitted):
 *   - NetSuite invoices whose memo mentions FleetSuite (scan + SO-transform
 *     invoices stamp it), and
 *   - graphics-job invoices recorded in our DB (their memo doesn't say
 *     "FleetSuite", so they come from graphics_jobs.netsuite_invoice_id).
 * Each invoice's target location is resolved from its NetSuite customer plus
 * the ship-to of its linked PO.
 */

const NumericId = z.string().regex(/^\d{1,15}$/);

const Schema = z.object({
  dryRun: z.boolean().optional(),
  limit: z.number().int().positive().max(10000).optional(),
  invoiceIds: z.array(NumericId).max(5000).optional(),
  customer: z.string().max(200).optional(),
  // Manual overrides from the admin picker: set these exact invoice → location
  // pairs (bypasses the rule). Applied directly, no enumeration.
  assignments: z.array(z.object({ invoiceId: NumericId, locationId: NumericId })).max(5000).optional(),
});

type ShipTo = { city?: string; name?: string } | null;
type PoEntry = { ship_to: ShipTo; customer: string | null };

/** Pull a PO number out of a memo like "... — PO #ABC123". */
function poNumberFromMemo(memo: string | null | undefined): string | null {
  const m = (memo || '').match(/PO\s*#\s*([A-Za-z0-9._/-]+)/i);
  return m ? m[1] : null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// One NetSuite invoice row with its current header location + customer.
interface InvRow {
  id: string;
  tranid: string | null;
  memo: string | null;
  otherrefnum: string | null;
  customer_name: string | null;
  location_id: string | null;
}

const INV_SELECT = `
  t.id, t.tranid, t.memo, t.otherrefnum,
  c.companyname AS customer_name,
  tl.location AS location_id
  FROM transaction t
  JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T'
  LEFT JOIN customer c ON t.entity = c.id
`;

function toInvRow(r: any): InvRow {
  return {
    id: r.id?.toString(),
    tranid: r.tranid ?? null,
    memo: r.memo ?? null,
    otherrefnum: r.otherrefnum ?? null,
    customer_name: r.customer_name ?? null,
    location_id: r.location_id != null ? r.location_id.toString() : null,
  };
}

/** Fetch invoice rows (current location + customer) for an explicit id set. */
async function fetchInvoiceRows(ids: string[]): Promise<InvRow[]> {
  const rows: InvRow[] = [];
  for (const ids200 of chunk(ids, 200)) {
    const list = ids200.map((i) => `'${i}'`).join(',');
    const res = await suiteqlQuery(`SELECT ${INV_SELECT} WHERE t.type = 'CustInvc' AND t.id IN (${list})`);
    for (const r of res?.items || []) {
      const row = toInvRow(r);
      if (row.id) rows.push(row);
    }
  }
  return rows;
}

/** Load purchase_orders for the referenced numbers/ids into lookup maps. */
async function loadPoMaps(
  supabase: SupabaseClient,
  poNumbers: string[],
  poIds: string[],
): Promise<{ byNumber: Map<string, PoEntry>; byId: Map<string, PoEntry> }> {
  const byNumber = new Map<string, PoEntry>();
  const byId = new Map<string, PoEntry>();
  const ingest = (rows: any[] | null | undefined) => {
    for (const po of rows || []) {
      const entry: PoEntry = { ship_to: (po.ship_to as ShipTo) || null, customer: po.customer ?? null };
      if (po.id) byId.set(po.id, entry);
      if (po.po_number) byNumber.set(po.po_number.trim().toUpperCase(), entry);
    }
  };
  for (const c of chunk(poNumbers, 300)) {
    if (!c.length) continue;
    const { data } = await supabase
      .from('purchase_orders')
      .select('id, po_number, customer, ship_to')
      .in('po_number', c);
    ingest(data);
  }
  for (const c of chunk(poIds, 300)) {
    if (!c.length) continue;
    const { data } = await supabase
      .from('purchase_orders')
      .select('id, po_number, customer, ship_to')
      .in('id', c);
    ingest(data);
  }
  return { byNumber, byId };
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const dryRun = parsed.data.dryRun ?? true;
  const { limit, invoiceIds, customer, assignments } = parsed.data;
  const scoped = invoiceIds && invoiceIds.length > 0 ? invoiceIds : null;

  // ── Manual apply: set exactly the given invoice → location pairs ──────────
  // The picker sends these (in small chunks) to apply hand-picked locations.
  // No enumeration — just the PATCHes — so it stays well under the time limit.
  if (assignments && assignments.length > 0) {
    if (dryRun) {
      return NextResponse.json({ dryRun: true, summary: { processed: 0, applied: 0, failed: 0, closedPeriodSkips: 0 } });
    }
    let applied = 0;
    let failed = 0;
    const closedPeriod: string[] = [];
    const results: { invoiceId: string; locationId: string; applied: boolean; error?: string }[] = [];
    for (const a of assignments) {
      const res = await updateInvoiceLocation(a.invoiceId, a.locationId);
      if (res.success) {
        applied++;
        results.push({ invoiceId: a.invoiceId, locationId: a.locationId, applied: true });
      } else {
        failed++;
        if (/period/i.test(res.error || '')) closedPeriod.push(a.invoiceId);
        results.push({ invoiceId: a.invoiceId, locationId: a.locationId, applied: false, error: res.error });
      }
    }
    return NextResponse.json({
      dryRun: false,
      summary: { processed: assignments.length, applied, failed, closedPeriodSkips: closedPeriod.length },
      ...(closedPeriod.length ? { closedPeriodInvoices: closedPeriod } : {}),
      results,
    });
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // NetSuite locations — for the picker options and for naming the current
    // location of each invoice (the invoice query gives us only its id).
    const locations = await getActiveLocations();
    const idToName = new Map(locations.map((l) => [l.id, l.name]));

    // ── 1. Determine the candidate invoice rows ───────────────────────────
    // Scoped: look up exactly the requested invoices — no broad scan, so a
    // targeted apply stays fast. Full: discover every FleetSuite invoice.
    const rowsById = new Map<string, InvRow>();
    if (scoped) {
      for (const row of await fetchInvoiceRows(scoped)) rowsById.set(row.id, row);
    } else {
      const memoRows = await suiteqlQueryAll(
        `SELECT ${INV_SELECT} WHERE t.type = 'CustInvc' AND UPPER(t.memo) LIKE '%FLEETSUITE%'`
      );
      for (const r of memoRows) {
        const row = toInvRow(r);
        if (row.id) rowsById.set(row.id, row);
      }
      // Graphics + multi-invoice PO records whose memo doesn't say FleetSuite.
      const [{ data: gIds }, { data: piIds }] = await Promise.all([
        supabase.from('graphics_jobs').select('netsuite_invoice_id').not('netsuite_invoice_id', 'is', null),
        supabase.from('po_invoices').select('netsuite_invoice_id'),
      ]);
      const extra = Array.from(
        new Set([
          ...(gIds || []).map((r) => r.netsuite_invoice_id?.toString()),
          ...(piIds || []).map((r) => r.netsuite_invoice_id?.toString()),
        ])
      ).filter((id): id is string => !!id && !rowsById.has(id));
      for (const row of await fetchInvoiceRows(extra)) rowsById.set(row.id, row);
    }

    const candidateIds = Array.from(rowsById.keys());
    if (candidateIds.length === 0) {
      return NextResponse.json({
        dryRun,
        locations,
        summary: { fleetSuiteInvoices: 0, alreadyCorrect: 0, indeterminateKept: 0, toChange: 0, processed: 0, applied: 0, failed: 0, closedPeriodSkips: 0, byTargetLocation: {} },
        changes: [],
        invoices: [],
      });
    }

    // ── 2. Load only the supporting data these invoices reference ─────────
    const graphicsByInvId = new Map<string, { ship_to: string | null; po_id: string | null }>();
    const poInvoiceToPoId = new Map<string, string>();
    const [{ data: gJobs }, { data: poInvoices }] = await Promise.all([
      supabase.from('graphics_jobs').select('netsuite_invoice_id, ship_to, po_id').in('netsuite_invoice_id', candidateIds),
      supabase.from('po_invoices').select('netsuite_invoice_id, purchase_order_id').in('netsuite_invoice_id', candidateIds),
    ]);
    for (const j of gJobs || []) {
      if (j.netsuite_invoice_id) {
        graphicsByInvId.set(j.netsuite_invoice_id.toString(), {
          ship_to: (j.ship_to as string | null) ?? null,
          po_id: j.po_id ?? null,
        });
      }
    }
    for (const pi of poInvoices || []) {
      if (pi.netsuite_invoice_id && pi.purchase_order_id) {
        poInvoiceToPoId.set(pi.netsuite_invoice_id.toString(), pi.purchase_order_id);
      }
    }

    // PO numbers referenced by the invoices (otherrefnum / "PO #" in memo) and
    // PO ids referenced via graphics jobs / multi-invoice records.
    const refPoNumbers = new Set<string>();
    for (const row of rowsById.values()) {
      const pn = (row.otherrefnum || poNumberFromMemo(row.memo) || '').trim().toUpperCase();
      if (pn) refPoNumbers.add(pn);
    }
    const refPoIds = new Set<string>();
    for (const g of graphicsByInvId.values()) if (g.po_id) refPoIds.add(g.po_id);
    for (const poId of poInvoiceToPoId.values()) refPoIds.add(poId);
    const { byNumber: poByNumber, byId: poById } = await loadPoMaps(
      supabase,
      Array.from(refPoNumbers),
      Array.from(refPoIds),
    );

    // ── 3. Resolve target location per invoice and classify ───────────────
    const changes: {
      invoiceId: string;
      invoiceNumber: string | null;
      customer: string | null;
      fromLocationId: string | null;
      toLocationId: string;
      toLocation: string;
      applied?: boolean;
      error?: string;
    }[] = [];
    // Every invoice (for the admin picker): current + suggested location.
    const invoices: {
      invoiceId: string;
      invoiceNumber: string | null;
      customer: string | null;
      currentLocationId: string | null;
      currentLocationName: string | null;
      suggestedLocationId: string;
      suggestedLocation: string;
      confident: boolean;
    }[] = [];
    let correct = 0;
    let considered = 0;
    let indeterminate = 0;
    const byTarget: Record<string, number> = {};

    for (const row of rowsById.values()) {
      if (customer && !(row.customer_name || '').toLowerCase().includes(customer.toLowerCase())) continue;
      considered++;

      // Build the location hint: NetSuite customer + the linked PO's ship-to.
      let shipTo: ShipTo = null;
      let locationName: string | null = null;
      const g = graphicsByInvId.get(row.id);
      if (g) {
        locationName = g.ship_to;
        const po = g.po_id ? poById.get(g.po_id) : null;
        if (po) shipTo = po.ship_to;
      }
      if (!shipTo) {
        const poId = poInvoiceToPoId.get(row.id);
        if (poId && poById.get(poId)) shipTo = poById.get(poId)!.ship_to;
      }
      if (!shipTo) {
        const poNum = (row.otherrefnum || poNumberFromMemo(row.memo) || '').trim().toUpperCase();
        if (poNum && poByNumber.get(poNum)) shipTo = poByNumber.get(poNum)!.ship_to;
      }

      const target = await resolveInvoiceLocation({
        customerName: row.customer_name,
        city: shipTo?.city,
        name: shipTo?.name,
        locationName,
      });
      if (!target.id) continue; // resolver always defaults to O'Fallon, so this is unreachable in practice

      // Record every invoice for the picker (current + suggested location).
      invoices.push({
        invoiceId: row.id,
        invoiceNumber: row.tranid,
        customer: row.customer_name,
        currentLocationId: row.location_id,
        currentLocationName: row.location_id ? idToName.get(row.location_id) || row.location_id : null,
        suggestedLocationId: target.id,
        suggestedLocation: target.name,
        confident: target.confident,
      });

      // Masterack invoice whose plant we couldn't identify: `target` is an
      // O'Fallon placeholder, not a positive match. Never overwrite a
      // possibly-correct existing plant location with that guess — leave it.
      if (!target.confident) {
        indeterminate++;
        continue;
      }

      byTarget[target.name] = (byTarget[target.name] || 0) + 1;

      if (row.location_id && row.location_id === target.id) {
        correct++;
        continue;
      }
      changes.push({
        invoiceId: row.id,
        invoiceNumber: row.tranid,
        customer: row.customer_name,
        fromLocationId: row.location_id,
        toLocationId: target.id,
        toLocation: target.name,
      });
    }

    // Stable, deterministic order; apply the optional change cap.
    changes.sort((a, b) => Number(a.invoiceId) - Number(b.invoiceId));
    const toProcess = limit ? changes.slice(0, limit) : changes;

    // ── 4. Apply (only when explicitly not a dry run) ─────────────────────
    let applied = 0;
    let failed = 0;
    const closedPeriod: string[] = [];
    if (!dryRun) {
      for (const ch of toProcess) {
        const res = await updateInvoiceLocation(ch.invoiceId, ch.toLocationId);
        if (res.success) {
          ch.applied = true;
          applied++;
        } else {
          ch.applied = false;
          ch.error = res.error;
          failed++;
          if (/period/i.test(res.error || '')) closedPeriod.push(ch.invoiceNumber || ch.invoiceId);
        }
      }
    }

    // Cap the detail payload; counts are always complete.
    const DETAIL_CAP = 1000;
    invoices.sort((a, b) => Number(a.invoiceId) - Number(b.invoiceId));
    return NextResponse.json({
      dryRun,
      locations,
      summary: {
        fleetSuiteInvoices: considered,
        alreadyCorrect: correct,
        indeterminateKept: indeterminate,
        toChange: changes.length,
        processed: dryRun ? 0 : toProcess.length,
        applied,
        failed,
        closedPeriodSkips: closedPeriod.length,
        byTargetLocation: byTarget,
      },
      ...(closedPeriod.length ? { closedPeriodInvoices: closedPeriod } : {}),
      changes: toProcess.slice(0, DETAIL_CAP),
      ...(toProcess.length > DETAIL_CAP ? { changesTruncated: toProcess.length - DETAIL_CAP } : {}),
      invoices: invoices.slice(0, 5000),
    });
  } catch (err: any) {
    console.error('Backfill invoice locations error:', err);
    return NextResponse.json({ error: err.message || 'Backfill failed' }, { status: 500 });
  }
}
