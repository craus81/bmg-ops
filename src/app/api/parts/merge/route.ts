import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

// Re-homing references + deleting rows can take a moment on large catalogs.
export const maxDuration = 60;

const Schema = z.object({
  keepId: z.string().uuid(),
  mergeIds: z.array(z.string().uuid()).min(1),
});

// FK columns that point at netsuite_parts(id). On merge we re-home them from the
// absorbed rows onto the keeper so no history (proofs, PO lines, scans via line
// items, estimates, schedule) is lost. schedule_assignments exists only in some
// environments, so a failure there is tolerated.
const PART_ID_REFS = ['part_files', 'po_line_items', 'estimate_line_items', 'schedule_assignments'];

// A real NetSuite-synced row has a numeric internal id, not a local placeholder.
const isRealNs = (id: string | null) => !!id && !/^(LOCAL-|bmg-)/i.test(id);

interface PartRow {
  id: string;
  netsuite_id: string | null;
  item_number: string;
  display_name: string | null;
  description: string | null;
  sales_price: number | null;
  purchase_price: number | null;
  labor_hours: number | null;
  vendor: string | null;
  ns_class: string | null;
  ns_department: string | null;
  billable_customer: string | null;
  vehicle_type: string | null;
  graphic_package: string | null;
  customer: string | null;
  proof_pages: number | null;
}

// Merge duplicate catalog rows (same part number) into a single keeper. Folds
// each absorbed row's references onto the keeper and fills any field the keeper
// is missing, then deletes the absorbed rows. NetSuite is never touched — this
// only consolidates the local FleetSuite mirror.
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { keepId, mergeIds } = parsed.data;
  if (mergeIds.includes(keepId)) {
    return NextResponse.json({ error: 'keepId cannot also be in mergeIds' }, { status: 400 });
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data: rows } = await supabase
      .from('netsuite_parts')
      .select('*')
      .in('id', [keepId, ...mergeIds]);
    const parts = (rows || []) as PartRow[];
    const keeper = parts.find((p) => p.id === keepId);
    if (!keeper) return NextResponse.json({ error: 'Keeper part not found' }, { status: 404 });
    const losers = parts.filter((p) => p.id !== keepId);
    if (losers.length === 0) return NextResponse.json({ error: 'No parts to merge' }, { status: 400 });

    // Guard 1: every row must share the keeper's number (case-insensitive). Merge
    // is for true duplicates — never silently fold two different parts together.
    const key = (keeper.item_number || '').trim().toLowerCase();
    if (parts.some((p) => (p.item_number || '').trim().toLowerCase() !== key)) {
      return NextResponse.json({ error: 'All parts must have the same part number to merge.' }, { status: 409 });
    }

    // Guard 2: don't delete a NetSuite-synced row while keeping a local one —
    // the next sync would just re-create it. Keep the NetSuite row as survivor.
    if (!isRealNs(keeper.netsuite_id) && losers.some((l) => isRealNs(l.netsuite_id))) {
      return NextResponse.json(
        { error: 'Keep the NetSuite-synced row as the survivor — merging it away would be re-created by the next sync.' },
        { status: 409 },
      );
    }

    // Fill the keeper's empty fields from the absorbed rows (keeper's own values
    // win; first non-empty among the rest fills a gap), so a merge never loses
    // data the keeper happened to be missing.
    const ordered = [keeper, ...losers]; // keeper first → its values take priority
    const firstText = (get: (p: PartRow) => string | null, skipNumber = false): string | undefined => {
      for (const p of ordered) {
        const v = (get(p) || '').trim();
        if (v && !(skipNumber && v.toLowerCase() === key)) return v;
      }
      return undefined;
    };
    const firstPos = (get: (p: PartRow) => number | null): number | undefined => {
      for (const p of ordered) { const v = get(p) || 0; if (v > 0) return v; }
      return undefined;
    };
    const fill: Record<string, unknown> = {};
    const fillText = (col: keyof PartRow, val: string | undefined) => {
      const cur = (keeper[col] as string | null) || '';
      const curEmpty = !cur.trim() || (col === 'display_name' && cur.trim().toLowerCase() === key);
      if (curEmpty && val && val !== cur) fill[col] = val;
    };
    const fillNum = (col: keyof PartRow, val: number | undefined) => {
      if (!(keeper[col] as number | null) && val) fill[col] = val;
    };
    fillText('display_name', firstText((p) => p.display_name, true));
    fillText('description', firstText((p) => p.description));
    fillText('vendor', firstText((p) => p.vendor));
    fillText('ns_class', firstText((p) => p.ns_class));
    fillText('ns_department', firstText((p) => p.ns_department));
    fillText('billable_customer', firstText((p) => p.billable_customer));
    fillText('vehicle_type', firstText((p) => p.vehicle_type));
    fillText('graphic_package', firstText((p) => p.graphic_package));
    fillText('customer', firstText((p) => p.customer));
    fillNum('sales_price', firstPos((p) => p.sales_price));
    fillNum('purchase_price', firstPos((p) => p.purchase_price));
    fillNum('labor_hours', firstPos((p) => p.labor_hours));
    fillNum('proof_pages', firstPos((p) => p.proof_pages));

    if (Object.keys(fill).length > 0) {
      fill.updated_at = new Date().toISOString();
      const { error: upErr } = await supabase.from('netsuite_parts').update(fill).eq('id', keepId);
      if (upErr) return NextResponse.json({ error: `Failed to update keeper: ${upErr.message}` }, { status: 500 });
    }

    // Re-home every FK reference from the absorbed rows onto the keeper BEFORE
    // deleting, so a mid-way failure can never drop history.
    const loserIds = losers.map((p) => p.id);
    let movedReferences = 0;
    for (const table of PART_ID_REFS) {
      const { count, error } = await supabase
        .from(table)
        .update({ part_id: keepId }, { count: 'exact' })
        .in('part_id', loserIds);
      if (error) {
        if (table === 'schedule_assignments') {
          console.warn(`[part-merge] ${table} skipped: ${error.message}`);
          continue;
        }
        return NextResponse.json({ error: `Failed to move ${table}: ${error.message}` }, { status: 500 });
      }
      movedReferences += count || 0;
    }

    // Now safe to remove the absorbed rows.
    const { error: delErr } = await supabase.from('netsuite_parts').delete().in('id', loserIds);
    if (delErr) return NextResponse.json({ error: `Failed to delete merged rows: ${delErr.message}` }, { status: 500 });

    return NextResponse.json({
      success: true,
      keptId: keepId,
      mergedCount: losers.length,
      movedReferences,
      // We deleted a NetSuite-synced row (a NetSuite-side duplicate) — warn that
      // it can come back on the next sync until it's also merged in NetSuite.
      netsuiteDuplicateWarning: losers.some((l) => isRealNs(l.netsuite_id)),
    });
  } catch (err: any) {
    console.error('part merge error:', err);
    return NextResponse.json({ error: err.message || 'Merge failed' }, { status: 500 });
  }
}
