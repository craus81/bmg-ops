import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Quoted-margin freeze (R5-3): the server-side twin of the estimate
 * builder's live "Parts Margin" strip. The formula here MUST mirror
 * estimates/page.tsx (lineTrueCost/lineMarginPct) exactly — the frozen
 * number is the number the rep saw when they hit Send, or the governance
 * gate punishes people for a disagreement between two formulas.
 *
 * Cost = netsuite_parts.purchase_price + avg_install_cost per unit.
 * Lines with NEITHER cost field (custom lines, uncosted parts) are
 * excluded from the % and counted — never treated as 100% margin.
 * Labor is costed separately (sold hours x blended shop rate) and does
 * not enter the parts-margin % — matching the builder's labeling.
 */

export interface QuotedMarginLine {
  item_number: string | null;
  quantity: number;
  unit_price: number;
  purchase_price: number | null;
  avg_install_cost: number | null;
}

export interface QuotedMarginLineDetail {
  item_number: string | null;
  quantity: number;
  unit_price: number;
  /** Per-unit true cost; NULL = uncosted line. */
  unit_cost: number | null;
  margin_pct: number | null;
}

export interface QuotedMargin {
  costTotal: number;
  costedRevenue: number;
  /** Parts margin % over costed lines; NULL when nothing is costed. */
  marginPct: number | null;
  uncostedCount: number;
  /** Sold hours x blended rate; NULL when no rate is configured. */
  laborCost: number | null;
  lines: QuotedMarginLineDetail[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The share of the job an estimate's discount (migration 342) takes off,
 * from its stored totals: 0.1 for 10% off. The discount comes off every
 * dollar alike, so parts revenue shrinks by the same share.
 */
export function estimateDiscountRatio(estimate: { discount_amount?: unknown; subtotal?: unknown; labor_total?: unknown }): number {
  const amount = Number(estimate.discount_amount) || 0;
  const base = (Number(estimate.subtotal) || 0) + (Number(estimate.labor_total) || 0);
  return amount > 0 && base > 0 ? Math.min(amount / base, 1) : 0;
}

export function computeQuotedMargin(
  lines: QuotedMarginLine[],
  laborHours: number,
  laborCostRate: number | null,
  discountRatio = 0,
): QuotedMargin {
  let costTotal = 0;
  let costedRevenue = 0;
  let uncostedCount = 0;
  const detail: QuotedMarginLineDetail[] = [];

  for (const l of lines) {
    const qty = Number(l.quantity) || 0;
    const listPrice = Number(l.unit_price) || 0;
    // What the line actually earns after the estimate's discount.
    const price = listPrice * (1 - discountRatio);
    const hasCost = l.purchase_price != null || l.avg_install_cost != null;
    const unitCost = hasCost ? (Number(l.purchase_price) || 0) + (Number(l.avg_install_cost) || 0) : null;
    if (unitCost != null) {
      costTotal += unitCost * qty;
      costedRevenue += price * qty;
    } else {
      uncostedCount++;
    }
    detail.push({
      item_number: l.item_number ?? null,
      quantity: qty,
      unit_price: round2(listPrice),
      unit_cost: unitCost != null ? round2(unitCost) : null,
      margin_pct: unitCost != null && price > 0
        ? round2(((price - unitCost) / price) * 100)
        : null,
    });
  }

  return {
    costTotal: round2(costTotal),
    costedRevenue: round2(costedRevenue),
    marginPct: costedRevenue > 0 ? round2(((costedRevenue - costTotal) / costedRevenue) * 100) : null,
    uncostedCount,
    laborCost: laborCostRate != null ? round2(laborHours * laborCostRate) : null,
    lines: detail,
  };
}

/**
 * The margin floor (quote_settings singleton). Schema-cache grace returns
 * the default rather than throwing — the send must not fail because the
 * settings read hiccuped; 30 matches the column's SQL default.
 */
export async function getMarginFloorPct(service: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await service
      .from('quote_settings')
      .select('margin_floor_pct')
      .eq('id', 1)
      .maybeSingle();
    if (error || data?.margin_floor_pct == null) return 30;
    return Number(data.margin_floor_pct);
  } catch {
    return 30;
  }
}
