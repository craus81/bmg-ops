import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { suiteqlQuery, suiteqlQueryAll, updateInvoiceLocation } from '@/lib/netsuite';
import { resolveInvoiceLocation } from '@/lib/invoice-location';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

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
 *   - invoiceIds: restrict to a hand-picked set (test batch / re-run).
 *   - customer:   case-insensitive substring filter on the invoice's customer.
 *   - limit:      cap how many *changes* are processed (applies after filtering).
 *
 * Enumeration of "all FleetSuite invoices":
 *   - NetSuite invoices whose memo mentions FleetSuite (scan + SO-transform
 *     invoices stamp it), and
 *   - graphics-job invoices recorded in our DB (their memo doesn't say
 *     "FleetSuite", so they're picked up from graphics_jobs.netsuite_invoice_id).
 * Each invoice's target location is resolved from its NetSuite customer plus
 * the ship-to of its linked PO.
 */

const NumericId = z.string().regex(/^\d{1,15}$/);

const Schema = z.object({
  dryRun: z.boolean().optional(),
  limit: z.number().int().positive().max(10000).optional(),
  invoiceIds: z.array(NumericId).max(5000).optional(),
  customer: z.string().max(200).optional(),
});

type ShipTo = { city?: string; name?: string } | null;

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

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const dryRun = parsed.data.dryRun ?? true;
  const { limit, invoiceIds, customer } = parsed.data;
  const idFilter = invoiceIds && invoiceIds.length > 0 ? new Set(invoiceIds) : null;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // ── PO lookup maps (for ship-to → which Masterack plant) ──────────────
    const { data: pos } = await supabase
      .from('purchase_orders')
      .select('id, po_number, customer, ship_to, netsuite_invoice_id');
    const poById = new Map<string, { ship_to: ShipTo; customer: string | null }>();
    const poByNumber = new Map<string, { ship_to: ShipTo; customer: string | null }>();
    const poInvoiceIds = new Set<string>();
    for (const po of pos || []) {
      const entry = { ship_to: (po.ship_to as ShipTo) || null, customer: po.customer ?? null };
      if (po.id) poById.set(po.id, entry);
      if (po.po_number) poByNumber.set(po.po_number.trim().toUpperCase(), entry);
      if (po.netsuite_invoice_id) poInvoiceIds.add(po.netsuite_invoice_id.toString());
    }

    // Multi-invoice PO records.
    const { data: poInvoices } = await supabase
      .from('po_invoices')
      .select('netsuite_invoice_id, purchase_order_id');
    const poInvoiceToPoId = new Map<string, string>();
    for (const pi of poInvoices || []) {
      if (pi.netsuite_invoice_id) {
        poInvoiceIds.add(pi.netsuite_invoice_id.toString());
        if (pi.purchase_order_id) poInvoiceToPoId.set(pi.netsuite_invoice_id.toString(), pi.purchase_order_id);
      }
    }

    // ── Graphics-job invoices (memo doesn't say "FleetSuite") ─────────────
    const { data: gJobs } = await supabase
      .from('graphics_jobs')
      .select('netsuite_invoice_id, customer, ship_to, po_id')
      .not('netsuite_invoice_id', 'is', null);
    const graphicsByInvId = new Map<string, { customer: string | null; ship_to: string | null; po_id: string | null }>();
    for (const j of gJobs || []) {
      if (j.netsuite_invoice_id) {
        graphicsByInvId.set(j.netsuite_invoice_id.toString(), {
          customer: j.customer ?? null,
          ship_to: (j.ship_to as string | null) ?? null,
          po_id: j.po_id ?? null,
        });
      }
    }

    // ── Gather invoice rows (current location + customer) ─────────────────
    // 1) Everything with a FleetSuite memo (scan + SO-transform invoices).
    const rowsById = new Map<string, InvRow>();
    const memoRows = await suiteqlQueryAll(
      `SELECT ${INV_SELECT} WHERE t.type = 'CustInvc' AND UPPER(t.memo) LIKE '%FLEETSUITE%'`
    );
    for (const r of memoRows) {
      const row = toInvRow(r);
      if (row.id) rowsById.set(row.id, row);
    }

    // 2) Graphics + PO-linked invoice ids not already covered by the memo pass.
    const extraIds = Array.from(
      new Set([...graphicsByInvId.keys(), ...poInvoiceIds])
    ).filter((id) => !rowsById.has(id));
    for (const ids of chunk(extraIds, 200)) {
      const list = ids.map((i) => `'${i}'`).join(',');
      const res = await suiteqlQuery(
        `SELECT ${INV_SELECT} WHERE t.type = 'CustInvc' AND t.id IN (${list})`
      );
      for (const r of res?.items || []) {
        const row = toInvRow(r);
        if (row.id) rowsById.set(row.id, row);
      }
    }

    // ── Resolve target location per invoice and classify ──────────────────
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
    let correct = 0;
    let considered = 0;
    let indeterminate = 0;
    const byTarget: Record<string, number> = {};

    for (const row of rowsById.values()) {
      if (idFilter && !idFilter.has(row.id)) continue;
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

    // ── Apply (only when explicitly not a dry run) ────────────────────────
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
    return NextResponse.json({
      dryRun,
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
    });
  } catch (err: any) {
    console.error('Backfill invoice locations error:', err);
    return NextResponse.json({ error: err.message || 'Backfill failed' }, { status: 500 });
  }
}
