import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import { clearedReviewColumns, reviewContentSignature } from '@/lib/estimate-review';

const HEADER_COLUMNS = 'internal_review_status, internal_review_decided_by, internal_review_copied_from, estimate_number, labor_rate, labor_hours_override, vehicle_count, discount_type, discount_value, tax_exempt';
const LINE_COLUMNS = 'sort_order, item_number, description, quantity, unit_price, labor_hours, discount_type, discount_value, kit_group_id, kit_item_number, kit_quantity';

/** An approved review's content, read before a write that may change it. */
export interface ReviewedContent {
  signature: string;
  estimateNumber: string | null;
  decidedBy: string | null;
  copiedFrom: string | null;
}

async function readContent(supabase: SupabaseClient, estimateId: string) {
  const [{ data: header }, { data: lines }] = await Promise.all([
    supabase.from('estimates').select(HEADER_COLUMNS).eq('id', estimateId).maybeSingle(),
    supabase.from('estimate_line_items').select(LINE_COLUMNS).eq('estimate_id', estimateId).order('sort_order').order('id'),
  ]);
  return { header: header as any, lines: (lines || []) as any[] };
}

/**
 * Snapshot an estimate's lines and money before a write, but only when it
 * has an approved review to lose. Null means there is nothing to protect,
 * so the caller can skip the after-check entirely.
 */
export async function snapshotReviewedContent(
  supabase: SupabaseClient,
  estimateId: string,
): Promise<ReviewedContent | null> {
  try {
    const { header, lines } = await readContent(supabase, estimateId);
    if (header?.internal_review_status !== 'approved') return null;
    return {
      signature: reviewContentSignature(header, lines),
      estimateNumber: header.estimate_number || null,
      decidedBy: header.internal_review_decided_by || null,
      copiedFrom: header.internal_review_copied_from || null,
    };
  } catch {
    return null;
  }
}

/**
 * After a write: if the lines or money differ from the snapshot, the review
 * no longer covers what the customer would see, so it is cleared and has to
 * go through Send for Review again (Craig, 2026-10-19). Returns true when
 * it cleared one. Best-effort: a failed read leaves the review alone rather
 * than failing a save that already landed.
 */
export async function clearReviewIfContentChanged(
  supabase: SupabaseClient,
  estimateId: string,
  before: ReviewedContent | null,
  actorId: string | null,
): Promise<boolean> {
  if (!before) return false;
  try {
    const { header, lines } = await readContent(supabase, estimateId);
    if (header?.internal_review_status !== 'approved') return false;
    if (reviewContentSignature(header, lines) === before.signature) return false;
    const { data: cleared } = await supabase
      .from('estimates')
      .update(clearedReviewColumns())
      .eq('id', estimateId)
      .eq('internal_review_status', 'approved')
      .select('id');
    if (!cleared?.length) return false;
    await logAudit(supabase, {
      actorId,
      table: 'estimates',
      recordId: estimateId,
      action: 'estimate_review_cleared',
      detail: {
        reason: 'lines or prices changed after review',
        estimate_number: before.estimateNumber,
        reviewed_by: before.decidedBy,
        copied_from: before.copiedFrom,
      },
    });
    return true;
  } catch {
    return false;
  }
}
