import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * Quote "sales facts" (extracted from /api/reports/sales-performance for
 * R4-4): quotes sent in a window, what they turned into, and how fast —
 * the one implementation behind the sales-performance report AND the CEO
 * view's Sales band, so a win rate on the executive tab can never disagree
 * with the report it summarizes.
 *
 * Won means the CUSTOMER decided (accepted status or a recorded approval);
 * 'pushed' only says we mirrored the estimate to NetSuite. Wrap quotes
 * folded into an estimate are not their own sales fact — the estimate
 * carries the money and the decision.
 */

export interface QuoteFact {
  type: 'estimate' | 'wrap';
  repId: string | null;
  customer: string;
  number: string;
  total: number;
  sentAt: string | null;
  outcome: 'won' | 'lost' | 'open';
  decidedAt: string | null;
}

export interface QuoteFactSummary {
  sentCount: number;
  sentValue: number;
  wonCount: number;
  wonValue: number;
  lostCount: number;
  lostValue: number;
  openCount: number;
  openValue: number;
  winRate: number | null;
  avgDaysToClose: number | null;
}

/** Load quote facts for [start, endNext) — both YYYY-MM-DD, end-exclusive. */
export async function loadQuoteFacts(
  service: SupabaseClient,
  start: string,
  endNext: string,
): Promise<QuoteFact[]> {
  const [estRes, wrapRes] = await Promise.all([
    fetchAllRows<any>((from, to) =>
      service
        .from('estimates')
        .select('id, estimate_number, customer_name, grand_total, created_by, status, sent_for_approval_at, customer_approved_at, customer_rejected_at, updated_at, created_at')
        .neq('status', 'draft')
        .or(`and(created_at.gte.${start},created_at.lt.${endNext}),and(sent_for_approval_at.gte.${start},sent_for_approval_at.lt.${endNext})`)
        .order('created_at')
        .order('id')
        .range(from, to)),
    fetchAllRows<any>((from, to) =>
      service
        .from('wrap_quotes')
        .select('id, quote_number, customer, total, created_by, status, sent_at, accepted_at, rejected_at, created_at')
        .neq('status', 'draft')
        .is('estimate_id', null)
        .gte('sent_at', start)
        .lt('sent_at', endNext)
        .order('sent_at')
        .order('id')
        .range(from, to)),
  ]);
  if (estRes.error) throw new Error(estRes.error.message);
  if (wrapRes.error) throw new Error(wrapRes.error.message);

  const inRange = (iso: string | null) => !!iso && iso >= start && iso < endNext;
  const facts: QuoteFact[] = [];

  for (const e of estRes.data || []) {
    const sentAt = e.sent_for_approval_at || e.updated_at;
    if (!inRange(sentAt)) continue;
    const outcome = e.status === 'accepted' || e.customer_approved_at ? 'won'
      : e.status === 'rejected' ? 'lost' : 'open';
    facts.push({
      type: 'estimate',
      repId: e.created_by,
      customer: e.customer_name || '—',
      number: e.estimate_number,
      total: Number(e.grand_total) || 0,
      sentAt,
      outcome,
      decidedAt: outcome === 'won' ? (e.customer_approved_at || e.updated_at)
        : outcome === 'lost' ? (e.customer_rejected_at || e.updated_at) : null,
    });
  }
  for (const w of wrapRes.data || []) {
    const outcome = w.status === 'accepted' ? 'won' : w.status === 'rejected' ? 'lost' : 'open';
    facts.push({
      type: 'wrap',
      repId: w.created_by,
      customer: (w.customer as any)?.name || '—',
      number: w.quote_number,
      total: Number(w.total) || 0,
      sentAt: w.sent_at,
      outcome,
      decidedAt: outcome === 'won' ? w.accepted_at : outcome === 'lost' ? w.rejected_at : null,
    });
  }
  return facts;
}

export function summarizeQuoteFacts(rows: QuoteFact[]): QuoteFactSummary {
  const sentCount = rows.length;
  const sentValue = rows.reduce((s, f) => s + f.total, 0);
  const won = rows.filter(f => f.outcome === 'won');
  const lost = rows.filter(f => f.outcome === 'lost');
  const open = rows.filter(f => f.outcome === 'open');
  const decided = won.length + lost.length;
  const closeDays = won
    .map(f => f.sentAt && f.decidedAt ? (new Date(f.decidedAt).getTime() - new Date(f.sentAt).getTime()) / 86_400_000 : null)
    .filter((d): d is number => d != null && d >= 0);
  return {
    sentCount,
    sentValue,
    wonCount: won.length,
    wonValue: won.reduce((s, f) => s + f.total, 0),
    lostCount: lost.length,
    lostValue: lost.reduce((s, f) => s + f.total, 0),
    openCount: open.length,
    openValue: open.reduce((s, f) => s + f.total, 0),
    winRate: decided > 0 ? won.length / decided : null,
    avgDaysToClose: closeDays.length > 0 ? closeDays.reduce((a, b) => a + b, 0) / closeDays.length : null,
  };
}
