import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';
import { kitLineColumns } from '@/lib/estimate-kits';
import { clearedReviewColumns } from '@/lib/estimate-review';
import { copyWorksheets } from '@/lib/estimate-copy-worksheets';
import { planCopiedProofs, type CopiedProof } from '@/lib/estimate-copied-proofs';

// Header fields that must never survive a duplicate: identity, lifecycle,
// and audit columns. Everything else on the row is descriptive content
// (customer, vehicle, rates, notes, install context) and copies as-is, so
// a future descriptive column rides along without touching this file.
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
  // An admin's discount approval (migration 365) covers the estimate they
  // looked at; a copy asks again.
  'discount_approval_requested_at',
  'discount_approval_requested_by',
  'discount_approved_at',
  'discount_approved_by',
  'discount_approved_pct',
]);

// Lifecycle column FAMILIES, stripped by prefix so additions to a family
// (e.g. approval_sent_hash joining approval_token) stay stripped without a
// list edit here. customer_id / prospect_id / customer_name /
// customer_netsuite_id do NOT match — only the approval/rejection state
// prefixes do — so a copy stays pointed at the same customer or CRM lead.
const DROP_PREFIXES = /^(netsuite_|approval_|customer_approved|customer_reject|signed_document_|sent_for_approval|pushed_|last_followup|followup_)/;

/**
 * A copy made for another vehicle in a fleet order (migration 410): same
 * build, its own unit number and VIN, joined to the source's group.
 */
export interface FleetCopyTarget {
  groupId: string;
  unitNumber: string;
  vin: string | null;
  /** Keep the source's customer PO number (one PO for the whole order). */
  keepPo: boolean;
}

/** Same lock definition as the save/delete gates in /api/estimates. */
export function estimateIsLocked(e: { customer_approved?: boolean | null; status?: string | null; netsuite_so_id?: string | null }): boolean {
  return !!(e.customer_approved || e.status === 'accepted' || e.netsuite_so_id);
}

/**
 * Copy an estimate (header + lines) into a fresh draft (Round 3 roadmap
 * R3-17). Shared by POST /api/estimates/[id]/duplicate and the fleet
 * "Copy for more vehicles" route.
 *
 * Plain duplicate, two modes decided from the source's state:
 * - Plain copy: the source is still editable. Re-quote a similar job
 *   without rebuilding the line list.
 * - Revision: the source is locked (customer-accepted, or already converted
 *   to a Sales Order). The copy is stamped supersedes_estimate_id so the
 *   builder can show the lineage both directions.
 *
 * Fleet copy (`fleet` given): always a new job for another vehicle, never a
 * revision, whatever the source's state. It takes the unit number and VIN
 * given, joins the group, and keeps the PO number only when asked.
 *
 * An approved internal review survives, marked as copied, until a line or
 * price changes; any other review state does not.
 *
 * What never survives the copy: approval/rejection state, the magic-link
 * token, signed-document pointers, NetSuite ids, push/send timestamps,
 * follow-up state, and the expiration date.
 *
 * Graphics Builder worksheets: a fleet copy shares the source's worksheet
 * (its lines keep wrap_quote_id, which is how a builder save finds the same
 * worksheet's lines on the other estimates of the group). Any other copy
 * gets its own copy of each worksheet, coverage proof included, and its
 * lines point at that copy (src/lib/estimate-copy-worksheets.ts).
 *
 * Graphics jobs' art proof (src/lib/estimate-copied-proofs.ts): a plain copy
 * shows the proof chosen on the original's job, and the job stays put; a
 * revision takes the job over, unless the original is on a Sales Order.
 */
export async function copyEstimate(
  supabase: SupabaseClient,
  sourceId: string,
  userId: string,
  fleet?: FleetCopyTarget,
): Promise<{ status: number; body: any }> {
  const { data: source, error: srcErr } = await supabase
    .from('estimates')
    .select('*')
    .eq('id', sourceId)
    .maybeSingle();
  if (srcErr) return { status: 500, body: { error: srcErr.message } };
  if (!source) return { status: 404, body: { error: 'Estimate not found' } };

  // A REJECTED estimate supersedes too (R6-9). The customer said no to that
  // document, and the counter replaces it for the same job — so it keeps
  // the PO number and the check-in link, and carries the lineage, exactly
  // like an accepted-then-revised one. Treating a counter-offer as an
  // unrelated new quote loses both the authorization and the thread of
  // what was actually being negotiated.
  const wasRejected = !fleet && !!(source.customer_rejected_at || source.status === 'rejected');
  const isRevision = !fleet && (estimateIsLocked(source) || wasRejected);

  const { data: sourceLines, error: linesErr } = await supabase
    .from('estimate_line_items')
    .select('*')
    .eq('estimate_id', source.id)
    .order('sort_order')
    .order('id');
  if (linesErr) return { status: 500, body: { error: linesErr.message } };

  const copy: Record<string, any> = {};
  for (const [key, value] of Object.entries(source)) {
    if (DROP_FIELDS.has(key) || DROP_PREFIXES.test(key)) continue;
    copy[key] = value;
  }
  if (!isRevision) {
    // A plain copy is a NEW job: the customer's PO number authorizes the
    // original order only, and the check-in link points at the original
    // vehicle visit. A revision replaces the same job, so it keeps both.
    if (!fleet?.keepPo) delete copy.po_number;
    delete copy.fleet_checkin_id;
    // A plain copy is a different job, so it leaves the fleet group; a
    // revision replaces its vehicle's estimate and stays in it.
    if (!fleet) copy.fleet_group_id = null;
  }
  if (fleet) {
    copy.fleet_group_id = fleet.groupId;
    copy.unit_number = fleet.unitNumber;
    copy.vin = fleet.vin;
  }

  const today = new Date().toISOString().slice(0, 10);
  // The customer's own words on the counter's notes: the reason they said
  // no is the brief for what this revision has to answer, and it lives on
  // the rejected row the copy deliberately strips.
  const rejectionLine = wasRejected && source.customer_rejection_reason
    ? `Customer's reason for declining: ${String(source.customer_rejection_reason).trim()}`
    : null;
  const provenanceNote = fleet
    ? `Fleet copy of ${source.estimate_number} for unit ${fleet.unitNumber} (${today}).`
    : wasRejected
      ? `Counter-offer revising ${source.estimate_number} (${today}) — the customer declined that document.`
      : isRevision
        ? `Revision of ${source.estimate_number} (${today}) — original is locked by customer acceptance/conversion.`
        : `Copied from ${source.estimate_number} (${today}).`;

  copy.status = 'draft';
  copy.created_by = userId;
  copy.supersedes_estimate_id = isRevision ? source.id : null;
  copy.internal_notes = [provenanceNote, rejectionLine, source.internal_notes].filter(Boolean).join('\n');

  // Internal review (Craig and Valarie, 2026-10-19): the copy has exactly
  // the reviewed lines and prices, so an APPROVED review comes along,
  // marked with the estimate it was given on. The first save that changes
  // a line or price clears it (src/lib/estimate-review-content.ts). A
  // review still pending or sent back stays with the original, and the
  // reminder/snooze state belongs to the original's round either way.
  Object.assign(copy, clearedReviewColumns());
  // Earlier rounds describe the original's history, not this estimate's.
  copy.internal_review_history = [];
  if (source.internal_review_status === 'approved') {
    for (const col of ['internal_review_status', 'internal_reviewer_id', 'internal_review_requested_by',
      'internal_review_requested_at', 'internal_review_decided_by', 'internal_review_decided_at', 'internal_review_note', 'internal_review_request_note']) {
      copy[col] = source[col] ?? null;
    }
    copy.internal_review_copied_from = source.internal_review_copied_from || source.estimate_number;
  }

  // The designer's art proof. A fleet copy is covered by the order's one
  // job and keeps whatever the source showed (copied with the header).
  let moveJobIds: string[] = [];
  let copiedProofs: CopiedProof[] = [];
  if (!fleet) {
    const plan = await planCopiedProofs(supabase, source, { copyInGroup: !!copy.fleet_group_id, revision: isRevision });
    moveJobIds = plan.moveJobIds;
    copiedProofs = plan.copied;
    copy.copied_graphics_proofs = copiedProofs.length > 0 ? copiedProofs : null;
  }

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
    return { status: 500, body: { error: insertErr?.message || 'Could not create the copy' } };
  }

  // Its own Graphics Builder worksheets, so the copy shows the coverage
  // proof and editing its graphics never rewrites the original's.
  let worksheetMap = new Map<string, string>();
  let worksheetCopies: { id: string; quote_number: string; from: string }[] = [];
  if (!fleet) {
    const lineWorksheetIds = (sourceLines || []).map((l: any) => l.wrap_quote_id).filter(Boolean) as string[];
    try {
      const res = await copyWorksheets(supabase, source.id, created.id, lineWorksheetIds, !!copy.fleet_group_id, userId);
      worksheetMap = res.map;
      worksheetCopies = res.created;
    } catch (err: any) {
      await removeWorksheetCopies(supabase, created.id);
      await supabase.from('estimates').delete().eq('id', created.id);
      return { status: 500, body: { error: `${err.message}. Nothing was created — try again.` } };
    }
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
      labor_hours: l.labor_hours ?? null,
      is_custom: !!l.is_custom,
      // The copy carries the source's totals, so it keeps the tax answer
      // each line was quoted with (migration 336); a Save re-resolves it.
      taxable: l.taxable ?? null,
      notes: l.notes ?? null,
      wrap_quote_id: l.wrap_quote_id ? (worksheetMap.get(l.wrap_quote_id) ?? l.wrap_quote_id) : null,
      discount_type: l.discount_type ?? null,
      discount_value: l.discount_value ?? null,
      discount_amount: l.discount_amount ?? 0,
      discount_description: l.discount_description ?? null,
      ...kitLineColumns(l),
    }));
    const { error: lineErr } = await supabase.from('estimate_line_items').insert(lineRows);
    if (lineErr) {
      // Unlike the builder's create path (where the user's work is in the
      // header), a header-only copy is worthless — remove it so a retry
      // starts clean instead of littering the list.
      await removeWorksheetCopies(supabase, created.id);
      await supabase.from('estimates').delete().eq('id', created.id);
      return { status: 500, body: { error: `Could not copy the line items (${lineErr.message}). Nothing was created — try again.` } };
    }
  }

  // A revision is the same job: its graphics jobs follow it. Best-effort,
  // after everything else landed — a failure leaves the job on the
  // original, which still shows nothing wrong to anyone.
  let jobsMoved = 0;
  if (moveJobIds.length > 0) {
    const { data: moved, error: moveErr } = await supabase
      .from('graphics_jobs')
      .update({ estimate_id: created.id, updated_at: new Date().toISOString() })
      .in('id', moveJobIds)
      .eq('estimate_id', source.id)
      .select('id');
    if (moveErr) console.error('revision: moving graphics jobs failed:', moveErr.message);
    jobsMoved = (moved || []).length;
  }

  await logAudit(supabase, {
    actorId: userId,
    table: 'estimates',
    recordId: created.id,
    action: fleet ? 'estimate_fleet_copied' : 'estimate_duplicated',
    detail: {
      source_estimate_id: source.id,
      source_estimate_number: source.estimate_number,
      revision: isRevision,
      line_count: (sourceLines || []).length,
      grand_total: source.grand_total,
      ...(worksheetCopies.length > 0 ? { worksheets_copied: worksheetCopies.map(w => ({ from: w.from, to: w.quote_number })) } : {}),
      ...(copiedProofs.length > 0 ? { art_proofs_shown: copiedProofs.map(p => p.job_id) } : {}),
      ...(jobsMoved > 0 ? { graphics_jobs_moved: moveJobIds } : {}),
      ...(fleet ? { fleet_group_id: fleet.groupId, unit_number: fleet.unitNumber } : {}),
    },
  });

  return {
    status: 200,
    body: {
      success: true,
      id: created.id,
      estimate_number: created.estimate_number,
      revision: isRevision,
      source_estimate_number: source.estimate_number,
      // The client re-saves over the copy in the locked-save escape hatch;
      // returning the note lets it keep the provenance line intact.
      provenance_note: provenanceNote,
      // Old worksheet id → the copy's own, for the same re-save.
      worksheet_map: Object.fromEntries(worksheetMap),
    },
  };
}

/** Undo a half-made copy's worksheets (the estimate delete only unpins them). */
async function removeWorksheetCopies(supabase: SupabaseClient, estimateId: string): Promise<void> {
  await supabase.from('wrap_quotes').delete().eq('estimate_id', estimateId);
}
