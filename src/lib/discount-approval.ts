import type { SupabaseClient } from '@supabase/supabase-js';
import { jobDiscountShare, normalizeDiscount } from './estimate-totals';
import { isAdminRole } from './features';
import { logAudit } from './audit';

/**
 * Admin approval for big discounts (migration 365).
 *
 * Valarie asked for controls on discounting; Craig (2026-10-13) chose: reps
 * discount up to a set percent of the job on their own (5%), and above that
 * an admin approves before the estimate goes to the customer or into
 * NetSuite. "The job" is every line plus labor before any discount, and the
 * discounts are all of them together: every line discount plus the
 * whole-job one (jobDiscountShare).
 *
 * The approval is stamped with the percent it covered. It holds while the
 * discounts stay at or under that percent (adding parts at the same
 * discount is fine) and lapses the moment a rep raises them.
 *
 * An admin never waits on themselves: when an admin sends or pushes an
 * estimate over the limit, that counts as their approval and is stamped.
 */

export const DEFAULT_DISCOUNT_APPROVAL_PCT = 5;

export type DiscountApprovalStatus = {
  /** All discounts as a percent of the job before discounts. */
  pct: number;
  /** All discounts in dollars. */
  amount: number;
  limitPct: number;
  /** Over the limit: an admin has to approve. */
  overLimit: boolean;
  /** Over the limit and an admin's approval covers it. */
  approved: boolean;
  /** Over the limit with no approval covering it: sending and pushing stop. */
  blocked: boolean;
};

export function discountApprovalStatus(
  estimate: {
    discount_type?: unknown; discount_value?: unknown; labor_total?: unknown; vehicle_count?: unknown;
    discount_approved_at?: unknown; discount_approved_pct?: unknown;
  },
  lines: any[],
  limitPct: number,
): DiscountApprovalStatus {
  const share = jobDiscountShare(
    lines,
    estimate.labor_total,
    estimate.vehicle_count,
    normalizeDiscount(estimate.discount_type, estimate.discount_value),
  );
  const limit = Number.isFinite(limitPct) && limitPct >= 0 ? limitPct : DEFAULT_DISCOUNT_APPROVAL_PCT;
  const overLimit = share.amount > 0 && share.pct > limit;
  const approvedPct = estimate.discount_approved_pct == null ? NaN : Number(estimate.discount_approved_pct);
  const approved = overLimit && !!estimate.discount_approved_at && Number.isFinite(approvedPct) && share.pct <= approvedPct;
  return { pct: share.pct, amount: share.amount, limitPct: limit, overLimit, approved, blocked: overLimit && !approved };
}

/** The limit from quote_settings; a read hiccup falls back to the default. */
export async function getDiscountApprovalPct(service: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await service
      .from('quote_settings')
      .select('discount_approval_pct')
      .eq('id', 1)
      .maybeSingle();
    if (error || data?.discount_approval_pct == null) return DEFAULT_DISCOUNT_APPROVAL_PCT;
    return Number(data.discount_approval_pct);
  } catch {
    return DEFAULT_DISCOUNT_APPROVAL_PCT;
  }
}

/** Stamp an admin's approval at the estimate's current discount percent. */
export async function stampDiscountApproval(
  service: SupabaseClient,
  estimate: { id: string; estimate_number?: unknown },
  status: DiscountApprovalStatus,
  adminId: string,
  how: 'approved' | 'admin_sent',
): Promise<string | null> {
  const { error } = await service
    .from('estimates')
    .update({
      discount_approved_at: new Date().toISOString(),
      discount_approved_by: adminId,
      discount_approved_pct: status.pct,
    })
    .eq('id', estimate.id);
  if (error) return error.message;
  await logAudit(service, {
    actorId: adminId,
    table: 'estimates',
    recordId: estimate.id,
    action: 'estimate_discount_approved',
    detail: {
      estimate_number: estimate.estimate_number ?? null,
      pct: status.pct,
      amount: status.amount,
      limitPct: status.limitPct,
      how,
    },
  });
  return null;
}

/**
 * The gate every send and push runs. Returns null to go ahead, or the
 * message to refuse with. An admin over the limit goes ahead and their
 * action is stamped as the approval.
 */
export async function checkDiscountApproval(
  service: SupabaseClient,
  estimate: any,
  lines: any[],
  actor: { id: string; roles: string[] },
  action: 'sent' | 'pushed' | 'converted',
): Promise<{ error: string; status: DiscountApprovalStatus } | null> {
  const limitPct = await getDiscountApprovalPct(service);
  const status = discountApprovalStatus(estimate, lines, limitPct);
  if (!status.blocked) return null;
  if (isAdminRole(actor.roles)) {
    await stampDiscountApproval(service, estimate, status, actor.id, 'admin_sent');
    return null;
  }
  const nothing = action === 'sent' ? 'Nothing was sent.' : action === 'converted' ? 'No sales order was created.' : 'Nothing was pushed.';
  return {
    error: `This estimate's discounts come to ${status.pct}% of the job ($${status.amount.toFixed(2)}), over the ${status.limitPct}% limit, so an admin has to approve them first. Use "Ask an admin" by the discount on the estimate. ${nothing}`,
    status,
  };
}
