/**
 * Keep folded wrap quotes in step with their estimate's fate (Stage 3
 * finding: "approving the estimate never reconciles the linked wrap
 * quote, so the combined job keeps nagging reps and mis-books reporting").
 *
 * A wrap quote folded into an estimate (Add Graphics) is no longer its own
 * sales fact — the estimate carries the money and the customer's decision.
 * When the customer acts on the estimate, the folded quotes must follow:
 * - accept  → wrap quotes flip 'accepted' (+accepted_at): follow-up nudges
 *   stop, the pipeline stops counting them open.
 * - reject  → 'rejected' (+rejected_at), except quotes the customer already
 *   accepted separately, which keep their standing acceptance.
 * - reopen  → a resend-after-rejection puts the estimate back to 'sent';
 *   quotes this flow rejected come back with it.
 *
 * Linked = union of the estimate's line markers (estimate_line_items
 * .wrap_quote_id) and the wrap_quotes.estimate_id backlink — either can
 * exist without the other on older records.
 *
 * Best-effort by design: reconciliation must never fail the customer's
 * accept/reject or a resend, so errors are logged and swallowed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type WrapReconcileOutcome = 'accepted' | 'rejected' | 'reopened';

export async function reconcileLinkedWrapQuotes(
  service: SupabaseClient<any, any, any>,
  estimateId: string,
  outcome: WrapReconcileOutcome,
  whenIso: string,
): Promise<void> {
  try {
    const [byLine, byBacklink] = await Promise.all([
      service
        .from('estimate_line_items')
        .select('wrap_quote_id')
        .eq('estimate_id', estimateId)
        .not('wrap_quote_id', 'is', null),
      service
        .from('wrap_quotes')
        .select('id')
        .eq('estimate_id', estimateId),
    ]);
    const ids = [...new Set([
      ...(byLine.data || []).map((r: any) => r.wrap_quote_id).filter(Boolean),
      ...(byBacklink.data || []).map((r: any) => r.id),
    ])] as string[];
    if (ids.length === 0) return;

    if (outcome === 'accepted') {
      await service
        .from('wrap_quotes')
        .update({ status: 'accepted', accepted_at: whenIso })
        .in('id', ids)
        .neq('status', 'accepted');
    } else if (outcome === 'rejected') {
      await service
        .from('wrap_quotes')
        .update({ status: 'rejected', rejected_at: whenIso })
        .in('id', ids)
        .neq('status', 'accepted');
    } else {
      await service
        .from('wrap_quotes')
        .update({ status: 'sent' })
        .in('id', ids)
        .eq('status', 'rejected');
    }
  } catch (e: any) {
    console.warn(`wrap-quote reconcile (${outcome}) failed for estimate ${estimateId}:`, e?.message || e);
  }
}
