import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { updateItemFields } from '@/lib/netsuite';

// Writing back to NetSuite (RESTlet round-trip) can exceed the default ceiling.
export const maxDuration = 60;

// Tables that store the part number as a plain string snapshot (as opposed to
// the stable part_id FK). When a part is renamed we carry these over to the new
// number so history, reports, and pay-rate lookups keyed by the string keep
// matching the part. `column` is the part-number column on that table.
const PART_NUMBER_REFS: { table: string; column: string }[] = [
  { table: 'scan_logs', column: 'part_number' },
  { table: 'po_line_items', column: 'part_number' },
  { table: 'estimate_line_items', column: 'item_number' },
  { table: 'graphics_jobs', column: 'part_number' },
  { table: 'cni_jobs', column: 'part_number' },
  { table: 'work_shifts', column: 'part_number' },
  { table: 'install_credits', column: 'part_number' },
  { table: 'install_pay_rates', column: 'part_number' },
];

// Escape LIKE wildcards so an old number containing % or _ matches literally.
const likeLiteral = (s: string) => s.replace(/([%_\\])/g, '\\$1');

// Carry every string reference to `oldNumber` over to `newNumber` (matched
// case-insensitively, like the rest of the app's part matching). Best-effort:
// a table may be absent in some environments, and install_pay_rates.part_number
// is UNIQUE so a pre-existing rate row for the new number would reject the
// update — skip those rather than failing a rename that already committed.
// Returns the total rows updated across all tables.
async function sweepPartNumberReferences(
  supabase: SupabaseClient,
  oldNumber: string,
  newNumber: string,
): Promise<number> {
  const pattern = likeLiteral(oldNumber);
  let total = 0;
  for (const ref of PART_NUMBER_REFS) {
    const { count, error } = await supabase
      .from(ref.table)
      .update({ [ref.column]: newNumber }, { count: 'exact' })
      .ilike(ref.column, pattern);
    if (error) {
      console.warn(`[part-rename] sweep ${ref.table}.${ref.column} skipped: ${error.message}`);
      continue;
    }
    total += count || 0;
  }
  return total;
}

// Edit a catalog part's core fields. All optional, but at least one is required.
// item_number is the part number (NetSuite "Item Name/Number") and is required
// to be non-empty when present, since the column is NOT NULL.
const Schema = z
  .object({
    item_number: z.string().trim().min(1).max(120).optional(),
    display_name: z.string().trim().max(300).optional(),
    description: z.string().max(4000).optional(),
    sales_price: z.number().nonnegative().optional(),
    purchase_price: z.number().nonnegative().optional(),
  })
  .refine(
    (v) =>
      v.item_number !== undefined ||
      v.display_name !== undefined ||
      v.description !== undefined ||
      v.sales_price !== undefined ||
      v.purchase_price !== undefined,
    { message: 'Provide at least one field to update' },
  );

// Maps a local netsuite_parts column to the NetSuite field name(s) the RESTlet
// reports back in `fieldsSet`, so we can confirm the write actually landed.
const NS_FIELD: Record<string, string[]> = {
  item_number: ['itemid'],
  display_name: ['displayname'],
  sales_price: ['baseprice'],
  purchase_price: ['cost'],
  description: ['salesdescription', 'purchasedescription'],
};

// A real NetSuite-synced part has a numeric internal id, not a local placeholder
// (manual parts have a NULL id; create-item mirrors use a `bmg-`/`LOCAL-` stub).
// Only real parts get written back to NetSuite; local ones just update locally.
const isRealNetsuiteId = (id: string | null) => !!id && !/^(LOCAL-|bmg-)/i.test(id);

// Edit a catalog part. For real NetSuite-synced parts the server writes the
// change back to NetSuite first (the source of truth — otherwise the next parts
// sync would revert a local-only edit), then mirrors the value locally so the
// UI updates immediately. Manual/local parts update locally only.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const patch = parsed.data;
  const partId = params.id;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data: part } = await supabase
      .from('netsuite_parts')
      .select('id, netsuite_id, item_number')
      .eq('id', partId)
      .maybeSingle();
    if (!part) return NextResponse.json({ error: 'Part not found' }, { status: 404 });

    // Renaming the part number: refuse to collide with another part. There's no
    // DB unique constraint, and the catalog's dedup would silently hide one of
    // the two — so block it here (case-insensitive, ignoring this same row).
    if (patch.item_number) {
      const { data: dups } = await supabase
        .from('netsuite_parts')
        .select('id, item_number')
        .ilike('item_number', patch.item_number)
        .neq('id', partId);
      const clash = (dups || []).find(
        (d) => (d.item_number || '').toLowerCase() === patch.item_number!.toLowerCase(),
      );
      if (clash) {
        return NextResponse.json(
          { error: `Another part already uses the number "${patch.item_number}".` },
          { status: 409 },
        );
      }
    }

    if (isRealNetsuiteId(part.netsuite_id)) {
      const res = await updateItemFields(part.netsuite_id!, {
        itemNumber: patch.item_number,
        description: patch.description,
        displayName: patch.display_name,
        salesPrice: patch.sales_price,
        purchasePrice: patch.purchase_price,
      });
      if (!res.success) {
        // Keep the local row untouched if NetSuite rejected the change, so the
        // two stay in lockstep (a local edit the next sync would revert is worse
        // than no edit). The error is surfaced to the user.
        return NextResponse.json(
          { error: `NetSuite update failed: ${res.error}` },
          { status: 502 },
        );
      }
      // Confirm every requested field actually landed in NetSuite. An older
      // RESTlet deployment silently ignores fields it doesn't know — without
      // this check we'd mirror a value the next sync would overwrite.
      const set = res.fieldsSet || [];
      const missing = Object.keys(patch).filter(
        (col) => !(NS_FIELD[col] || []).some((f) => set.includes(f)),
      );
      if (missing.length > 0) {
        return NextResponse.json(
          {
            error: `NetSuite did not apply: ${missing.join(', ')}. The item RESTlet may need to be re-deployed (see scripts/netsuite-item-restlet.js).`,
          },
          { status: 502 },
        );
      }
    }

    const { error } = await supabase
      .from('netsuite_parts')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', partId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // The rename has committed. Carry historical string references (scans, PO
    // lines, estimates, jobs, pay rates…) over to the new number. Best-effort:
    // a sweep failure must not fail the rename, so swallow and just log.
    let sweptReferences = 0;
    const oldNumber = part.item_number as string | null;
    if (patch.item_number && oldNumber && patch.item_number !== oldNumber) {
      try {
        sweptReferences = await sweepPartNumberReferences(supabase, oldNumber, patch.item_number);
      } catch (e: any) {
        console.error('[part-rename] reference sweep failed:', e?.message || e);
      }
    }

    return NextResponse.json({
      success: true,
      ...patch,
      syncedToNetsuite: isRealNetsuiteId(part.netsuite_id),
      sweptReferences,
    });
  } catch (err: any) {
    console.error('part update error:', err);
    return NextResponse.json({ error: err.message || 'Update failed' }, { status: 500 });
  }
}

// Delete a part from FleetSuite (the local catalog mirror) ONLY — NetSuite is
// never touched. This is for cleaning up duplicate or stale rows, or ones that
// are wrong locally but correct in NetSuite. NOTE: if the item still exists in
// NetSuite, the next "Sync Now" will re-add it (NetSuite is the source of
// truth) — only rows with no live NetSuite twin stay gone.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const partId = params.id;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data: part } = await supabase
      .from('netsuite_parts')
      .select('id, item_number')
      .eq('id', partId)
      .maybeSingle();
    if (!part) return NextResponse.json({ error: 'Part not found' }, { status: 404 });

    // Remove attached files from storage. The part_files rows themselves cascade
    // when the part is deleted, but the stored objects would otherwise linger.
    const { data: files } = await supabase
      .from('part_files')
      .select('storage_path')
      .eq('part_id', partId);
    const paths = (files || []).map((f) => f.storage_path).filter(Boolean);
    if (paths.length > 0) {
      const { error: rmErr } = await supabase.storage.from('graphics-proofs').remove(paths);
      if (rmErr) console.warn(`[part-delete] storage cleanup failed: ${rmErr.message}`);
    }

    // Detach references whose FK has no auto rule — po_line_items and
    // schedule_assignments have no ON DELETE, so the delete would fail while
    // they point at this row. estimate_line_items (ON DELETE SET NULL) and
    // part_files (CASCADE) handle themselves. The part_number string stays on
    // those rows so they remain identifiable and can re-match later.
    await supabase.from('po_line_items').update({ part_id: null }).eq('part_id', partId);
    // schedule_assignments only exists in some environments — error ignored.
    await supabase.from('schedule_assignments').update({ part_id: null }).eq('part_id', partId);

    const { error } = await supabase.from('netsuite_parts').delete().eq('id', partId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true, deleted: part.item_number });
  } catch (err: any) {
    console.error('part delete error:', err);
    return NextResponse.json({ error: err.message || 'Delete failed' }, { status: 500 });
  }
}
