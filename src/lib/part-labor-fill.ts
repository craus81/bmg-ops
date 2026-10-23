import type { SupabaseClient } from '@supabase/supabase-js';
import { computeTotals, normalizeDiscount } from '@/lib/estimate-totals';
import { fetchAllRows } from '@/lib/fetch-all';
import { snapshotReviewedContent, clearReviewIfContentChanged } from '@/lib/estimate-review-content';

/**
 * Fill this part's still-unset lines on draft estimates and re-total each
 * one exactly as a builder Save would (stored per-line taxability is kept —
 * each line keeps the tax answer it was quoted with). Only `status = 'draft'`
 * estimates are touched; sent, approved and SO'd estimates never are.
 */
export async function fillDraftEstimatesLabor(
  supabase: SupabaseClient,
  part: { id: string; netsuite_id: string | null },
  hours: number,
  actorId: string | null,
): Promise<{ estimates: { id: string; estimate_number: string | null }[]; error: string | null }> {
  const match = part.netsuite_id
    ? `part_id.eq.${part.id},and(part_id.is.null,netsuite_item_id.eq.${part.netsuite_id})`
    : `part_id.eq.${part.id}`;
  const { data: unset, error: lineErr } = await fetchAllRows<{ id: string; estimate_id: string }>((from, to) =>
    supabase.from('estimate_line_items')
      .select('id, estimate_id')
      .is('labor_hours', null)
      .or(match)
      .order('id')
      .range(from, to),
  );
  if (lineErr) return { estimates: [], error: lineErr.message };
  const estimateIds = [...new Set(unset.map(l => l.estimate_id))];
  if (estimateIds.length === 0) return { estimates: [], error: null };

  const drafts: any[] = [];
  for (let i = 0; i < estimateIds.length; i += 200) {
    const { data, error } = await supabase
      .from('estimates')
      .select('id, estimate_number, status, tax_rate, tax_exempt, labor_rate, labor_hours_override, vehicle_count, discount_type, discount_value')
      .in('id', estimateIds.slice(i, i + 200))
      .eq('status', 'draft');
    if (error) return { estimates: [], error: error.message };
    drafts.push(...(data || []));
  }

  const filled: { id: string; estimate_number: string | null }[] = [];
  for (const est of drafts) {
    const lineIds = unset.filter(l => l.estimate_id === est.id).map(l => l.id);
    const reviewedBefore = await snapshotReviewedContent(supabase, est.id);
    const { error: upErr } = await supabase
      .from('estimate_line_items')
      .update({ labor_hours: hours })
      .in('id', lineIds)
      .is('labor_hours', null);
    if (upErr) return { estimates: filled, error: upErr.message };

    const { data: lines, error: readErr } = await supabase
      .from('estimate_line_items')
      .select('*')
      .eq('estimate_id', est.id);
    if (readErr) return { estimates: filled, error: readErr.message };
    const totals = computeTotals(
      lines || [],
      Number(est.tax_rate) || 0,
      !!est.tax_exempt,
      Number(est.labor_rate) || 0,
      est.labor_hours_override != null ? Number(est.labor_hours_override) : null,
      est.vehicle_count,
      normalizeDiscount(est.discount_type, est.discount_value),
    );
    const { error: totErr } = await supabase
      .from('estimates')
      .update({
        labor_hours: totals.labor_hours,
        subtotal: totals.subtotal,
        labor_total: totals.labor_total,
        discount_amount: totals.discount_amount,
        tax_amount: totals.tax_amount,
        grand_total: totals.grand_total,
        updated_at: new Date().toISOString(),
      })
      .eq('id', est.id);
    if (totErr) return { estimates: filled, error: totErr.message };
    await clearReviewIfContentChanged(supabase, est.id, reviewedBefore, actorId);
    filled.push({ id: est.id, estimate_number: est.estimate_number ?? null });
  }
  return { estimates: filled, error: null };
}
