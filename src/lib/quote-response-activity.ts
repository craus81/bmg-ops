/**
 * Put a customer's answer to a quote on their account history.
 *
 * The approval links (estimate + wrap quote) record acceptance/rejection
 * on the quote row and alert the rep, but the customer record's Recent
 * Activity only ever showed the quote going out (the email row) — never
 * what came back. One row per verdict (migration 257: types
 * quote_accepted / quote_rejected, plus a deep link the timeline opens).
 *
 * created_by is null on purpose: the CUSTOMER acted, not a user. The
 * timeline already renders a null creator.
 *
 * Best-effort, never throws — the approval itself already succeeded.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveCustomerLinkage, type CustomerLinkageInput } from './customer-linkage';

export interface QuoteResponseInput extends CustomerLinkageInput {
  verdict: 'accepted' | 'rejected';
  /** "Estimate #EST-2608-041" / "Wrap quote WQ-1042" */
  label: string;
  total?: number | null;
  reason?: string | null;
  /** deepLinks.estimate(id) / deepLinks.wrapQuote(id) */
  url: string;
}

export async function logQuoteResponse(service: SupabaseClient, input: QuoteResponseInput): Promise<void> {
  try {
    const { prospectId } = await resolveCustomerLinkage(service, input);
    if (!prospectId) return;
    const money = input.total != null && Number(input.total) > 0
      ? ` ($${Number(input.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
      : '';
    const summary = input.verdict === 'accepted'
      ? `Customer accepted ${input.label}${money}`
      : `Customer requested changes on ${input.label}${money}${input.reason?.trim() ? ` — "${input.reason.trim()}"` : ''}`;
    const { error } = await service.from('prospect_activities').insert({
      prospect_id: prospectId,
      type: input.verdict === 'accepted' ? 'quote_accepted' : 'quote_rejected',
      summary: summary.slice(0, 1000),
      details: input.reason?.trim() || null,
      url: input.url,
      created_by: null,
    });
    if (error) console.error('[quote-response] prospect_activities insert failed:', error.message);
  } catch (err: any) {
    console.error('[quote-response] failed:', err?.message || err);
  }
}
