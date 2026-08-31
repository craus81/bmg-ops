import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Header fields that must never survive a duplicate: identity, lifecycle,
// and audit columns. Everything else on the row is descriptive content
// (customer, vehicle, rates, notes, install context) and copies as-is, so
// a future descriptive column rides along without touching this route.
const DROP_FIELDS = new Set([
  'id',
  'estimate_number',
  'status',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'expiration_date', // a copied quote gets a fresh clock, not a stale one
  'supersedes_estimate_id', // set explicitly below
]);

// Lifecycle column FAMILIES, stripped by prefix so additions to a family
// (e.g. approval_sent_hash joining approval_token) stay stripped without a
// list edit here. customer_id / customer_name / customer_netsuite_id do NOT
// match — only the approval/rejection state prefixes do.
const DROP_PREFIXES = /^(netsuite_|approval_|customer_approved|customer_reject|signed_document_|sent_for_approval|pushed_|last_followup|followup_)/;

/**
 * POST /api/estimates/[id]/duplicate — copy an estimate (header + lines)
 * into a fresh draft (Round 3 roadmap R3-17).
 *
 * Two modes, decided server-side from the source's state — no body needed:
 * - Plain copy: the source is still editable. Re-quote a similar job
 *   without rebuilding the line list.
 * - Revision: the source is locked (customer-accepted, or already converted
 *   to a Sales Order). The copy is stamped supersedes_estimate_id so the
 *   builder can show the lineage both directions. This is the escape hatch
 *   the revision lock's "start a new estimate" message points at.
 *
 * What never survives the copy: approval/rejection state, the magic-link
 * token, signed-document pointers, NetSuite ids, push/send timestamps,
 * follow-up state, and the expiration date. wrap_quote_id on lines is
 * deliberately KEPT: it is what add-wrap-quote dedupes on and what marks a
 * line as graphics for the convert-time gate — stripping it would let the
 * same wrap quote be added twice and orphan the design linkage.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  try {
    const { data: source, error: srcErr } = await supabase
      .from('estimates')
      .select('*')
      .eq('id', params.id)
      .maybeSingle();
    if (srcErr) return NextResponse.json({ error: srcErr.message }, { status: 500 });
    if (!source) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

    // Same lock definition as the save/delete gates in ../route.ts: any of
    // these means the document's content is frozen, so the copy supersedes.
    const isRevision = !!(source.customer_approved || source.status === 'accepted' || source.netsuite_so_id);

    const { data: sourceLines, error: linesErr } = await supabase
      .from('estimate_line_items')
      .select('*')
      .eq('estimate_id', source.id)
      .order('sort_order')
      .order('id');
    if (linesErr) return NextResponse.json({ error: linesErr.message }, { status: 500 });

    const copy: Record<string, any> = {};
    for (const [key, value] of Object.entries(source)) {
      if (DROP_FIELDS.has(key) || DROP_PREFIXES.test(key)) continue;
      copy[key] = value;
    }
    if (!isRevision) {
      // A plain copy is a NEW job: the customer's PO number authorizes the
      // original order only, and the check-in link points at the original
      // vehicle visit. A revision replaces the same job, so it keeps both.
      delete copy.po_number;
      delete copy.fleet_checkin_id;
    }

    const today = new Date().toISOString().slice(0, 10);
    const provenanceNote = isRevision
      ? `Revision of ${source.estimate_number} (${today}) — original is locked by customer acceptance/conversion.`
      : `Copied from ${source.estimate_number} (${today}).`;

    copy.status = 'draft';
    copy.created_by = auth.user.id;
    copy.supersedes_estimate_id = isRevision ? source.id : null;
    copy.internal_notes = [provenanceNote, source.internal_notes].filter(Boolean).join('\n');

    // Same 23505 retry as the create path: the number is UNIQUE and the
    // RPC-failure fallback format can collide within a month.
    let created: { id: string; estimate_number: string } | null = null;
    let insertErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const estimate_number = await nextJobNumber(supabase, 'EST', legacyJobNumber.est);
      const res = await supabase
        .from('estimates')
        .insert({ ...copy, estimate_number })
        .select('id, estimate_number')
        .single();
      created = res.data as any;
      insertErr = res.error;
      if (!insertErr || insertErr.code !== '23505') break;
    }
    if (insertErr || !created) {
      return NextResponse.json({ error: insertErr?.message || 'Could not create the copy' }, { status: 500 });
    }

    if ((sourceLines || []).length > 0) {
      // Explicit field list (the builder's round-trip set), not a spread:
      // a future line column defaults on the copy instead of smuggling
      // per-line lifecycle state across.
      const lineRows = (sourceLines || []).map((l: any, idx: number) => ({
        estimate_id: created!.id,
        sort_order: idx,
        part_id: l.part_id ?? null,
        netsuite_item_id: l.netsuite_item_id ?? null,
        item_number: l.item_number ?? null,
        description: l.description ?? null,
        quantity: l.quantity ?? 0,
        unit_price: l.unit_price ?? 0,
        line_total: l.line_total ?? 0,
        labor_hours: l.labor_hours ?? 0,
        is_custom: !!l.is_custom,
        notes: l.notes ?? null,
        wrap_quote_id: l.wrap_quote_id ?? null,
      }));
      const { error: lineErr } = await supabase.from('estimate_line_items').insert(lineRows);
      if (lineErr) {
        // Unlike the builder's create path (where the user's work is in the
        // header), a header-only copy is worthless — remove it so a retry
        // starts clean instead of littering the list.
        await supabase.from('estimates').delete().eq('id', created.id);
        return NextResponse.json({ error: `Could not copy the line items (${lineErr.message}). Nothing was created — try again.` }, { status: 500 });
      }
    }

    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'estimates',
      recordId: created.id,
      action: 'estimate_duplicated',
      detail: {
        source_estimate_id: source.id,
        source_estimate_number: source.estimate_number,
        revision: isRevision,
        line_count: (sourceLines || []).length,
        grand_total: source.grand_total,
      },
    });

    return NextResponse.json({
      success: true,
      id: created.id,
      estimate_number: created.estimate_number,
      revision: isRevision,
      source_estimate_number: source.estimate_number,
      // The client re-saves over the copy in the locked-save escape hatch;
      // returning the note lets it keep the provenance line intact.
      provenance_note: provenanceNote,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
