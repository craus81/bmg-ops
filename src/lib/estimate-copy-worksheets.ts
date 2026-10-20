import type { SupabaseClient } from '@supabase/supabase-js';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';

/**
 * Graphics Builder worksheets on a duplicated estimate (Craig, 2026-10-20).
 *
 * A worksheet is pinned to one estimate (wrap_quotes.estimate_id), and the
 * Graphics card, the PDF and the approval page find its coverage proof
 * through that pin (or the fleet group, src/lib/estimate-fleet.ts). A plain
 * Duplicate leaves the fleet group, so before this the copy carried the
 * graphics lines and money but no proof, and its lines still pointed at the
 * original's worksheet — opening Graphics Builder from the copy edited the
 * original. Now the copy gets its OWN worksheet: same pictures, films and
 * prices, a new WQ number, pinned to the copy, and the copy's lines point
 * at it. The original's worksheet is never touched.
 *
 * Proof pictures are shared by storage path, not re-uploaded: the builder
 * writes every save to a new timestamped path (quote-diagrams/<WQ>-<n>-<ms>)
 * and never deletes the old one, so the copy's next save makes its own file
 * and the original keeps pointing at its own.
 */

// Identity and lifecycle: a copied worksheet starts as a fresh draft.
const DROP_FIELDS = new Set([
  'id',
  'quote_number',
  'estimate_id',
  'status',
  'sent_at',
  'sent_to',
  'accepted_at',
  'rejected_at',
  'archived_at',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'never_opened_notified_at',
]);

// Same families estimate-copy.ts strips: approval/rejection state, NetSuite
// ids, signed documents, follow-up and expiry bookkeeping.
const DROP_PREFIXES = /^(netsuite_|approval_|customer_approved|customer_reject|signed_document_|last_followup|followup_|expiry_)/;

/** The columns of a worksheet that carry over to its copy. */
export function worksheetCopyRow(source: Record<string, any>, estimateId: string, userId: string | null): Record<string, any> {
  const row: Record<string, any> = {};
  for (const [key, value] of Object.entries(source)) {
    if (DROP_FIELDS.has(key) || DROP_PREFIXES.test(key)) continue;
    row[key] = value;
  }
  row.estimate_id = estimateId;
  row.status = 'draft';
  row.created_by = userId;
  return row;
}

/**
 * Which worksheets a copy needs its own copy of.
 *
 * - Every worksheet pinned to the source.
 * - A worksheet the source's lines carry but that is pinned to a fleet
 *   sibling, only when the copy leaves the group (a plain Duplicate): in the
 *   group it is still shared, out of it nothing would show its proof.
 */
export function worksheetsToCopy(
  sourceId: string,
  worksheets: Array<{ id: string; estimate_id: string | null }>,
  lineWorksheetIds: string[],
  copyInFleetGroup: boolean,
): string[] {
  const out: string[] = [];
  const onLines = new Set(lineWorksheetIds);
  for (const w of worksheets) {
    if (w.estimate_id === sourceId) out.push(w.id);
    else if (!copyInFleetGroup && onLines.has(w.id)) out.push(w.id);
  }
  return out;
}

/**
 * Copy the source's worksheets onto the new estimate. Returns old id → new
 * id for repointing the copy's lines, plus the new rows' ids and numbers.
 * Throws on a failed insert so the caller can remove the half-made copy.
 */
export async function copyWorksheets(
  supabase: SupabaseClient,
  sourceId: string,
  targetId: string,
  lineWorksheetIds: string[],
  copyInFleetGroup: boolean,
  userId: string | null,
): Promise<{ map: Map<string, string>; created: { id: string; quote_number: string; from: string }[] }> {
  const ids = [...new Set(lineWorksheetIds)];
  const { data: rows, error } = await supabase
    .from('wrap_quotes')
    .select('*')
    .or(ids.length > 0 ? `estimate_id.eq.${sourceId},id.in.(${ids.join(',')})` : `estimate_id.eq.${sourceId}`)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Could not read the Graphics Builder worksheets (${error.message})`);

  const wanted = new Set(worksheetsToCopy(sourceId, (rows || []) as any[], ids, copyInFleetGroup));
  const map = new Map<string, string>();
  const created: { id: string; quote_number: string; from: string }[] = [];
  for (const src of (rows || []) as any[]) {
    if (!wanted.has(src.id)) continue;
    const base = worksheetCopyRow(src, targetId, userId);
    let made: { id: string; quote_number: string } | null = null;
    let insertErr: any = null;
    // quote_number is UNIQUE; same 23505 retry as the estimate number.
    for (let attempt = 0; attempt < 3; attempt++) {
      const quote_number = await nextJobNumber(supabase, 'WQ', legacyJobNumber.wq);
      const res = await supabase.from('wrap_quotes').insert({ ...base, quote_number }).select('id, quote_number').single();
      made = res.data as any;
      insertErr = res.error;
      if (!insertErr || insertErr.code !== '23505') break;
    }
    if (insertErr || !made) {
      throw new Error(`Could not copy worksheet ${src.quote_number} (${insertErr?.message || 'no row'})`);
    }
    map.set(src.id, made.id);
    created.push({ id: made.id, quote_number: made.quote_number, from: src.quote_number });
  }
  return { map, created };
}

/** Point lines at the copy's own worksheets (worksheet_map from a copy). */
export function remapWorksheetIds<T extends { wrap_quote_id?: string | null }>(lines: T[], map: Record<string, string> | null | undefined): T[] {
  if (!map || Object.keys(map).length === 0) return lines;
  return lines.map(l => (l.wrap_quote_id && map[l.wrap_quote_id] ? { ...l, wrap_quote_id: map[l.wrap_quote_id] } : l));
}
