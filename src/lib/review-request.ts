/**
 * Google review requests on job completion (R6-13).
 *
 * The completion email gains a "How did we do?" block — but only for a
 * customer it is reasonable to ask, which is a much smaller set than
 * "everyone whose vehicle is finished".
 *
 * FOUR REASONS NOT TO ASK, AND SILENCE IS THE DEFAULT:
 *
 *   no_url          — nothing is configured. A "How did we do?" heading
 *                     with a dead link is worse than no block, so the
 *                     absence of the setting suppresses the feature
 *                     entirely rather than degrading it.
 *   suppressed      — a human marked this customer never-ask.
 *   cooldown        — asked within the last six months. A fleet customer
 *                     collecting a vehicle a week would otherwise get an
 *                     ask a week, which is how this becomes spam.
 *   open_complaint  — an unresolved delivery failure or an open
 *                     conversation. Asking someone for a public review
 *                     while their complaint is open is the single worst
 *                     moment to ask, and the one this must never get wrong.
 *
 * A CHECK THAT FAILED IS ALSO A REASON NOT TO ASK. `unknown` is returned
 * when a query errors, and the caller treats it exactly like a refusal:
 * the cost of skipping an ask is nothing, and the cost of asking an angry
 * customer for a public review is a one-star review.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type Service = SupabaseClient<any, any, any>;

export const COOLDOWN_MONTHS = 6;

export type ReviewSkipReason = 'no_url' | 'suppressed' | 'cooldown' | 'open_complaint' | 'unknown';

export interface ReviewDecision {
  ask: boolean;
  reason: ReviewSkipReason | null;
  url: string | null;
}

/** Has the cooldown lapsed? No previous ask means yes. */
export function cooldownPassed(sentAt: unknown, now = Date.now()): boolean {
  if (!sentAt) return true;
  const t = Date.parse(String(sentAt));
  if (!Number.isFinite(t)) return true;   // unreadable stamp ⇒ treat as never asked
  const months = (now - t) / (30.44 * 86_400_000);
  return months >= COOLDOWN_MONTHS;
}

/** The company-wide review URL, or null when nothing is configured. */
export async function reviewUrl(service: Service): Promise<string | null> {
  try {
    const { data } = await service
      .from('app_settings')
      .select('value')
      .eq('key', 'google_review')
      .maybeSingle();
    const url = (data?.value as any)?.url;
    if (typeof url !== 'string') return null;
    const trimmed = url.trim();
    // Only an absolute http(s) URL: anything else in that column would
    // render as a broken CTA in a customer's inbox.
    return /^https?:\/\//i.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Should this customer be asked for a review right now?
 *
 * Every failure path returns ask:false with a reason — the caller never
 * has to interpret a null.
 */
export async function decideReviewAsk(service: Service, customerId: string | null): Promise<ReviewDecision> {
  const url = await reviewUrl(service);
  if (!url) return { ask: false, reason: 'no_url', url: null };
  if (!customerId) return { ask: false, reason: 'unknown', url };

  try {
    const { data: customer, error } = await service
      .from('customers')
      .select('id, review_request_sent_at, review_request_suppressed')
      .eq('id', customerId)
      .maybeSingle();
    if (error || !customer) return { ask: false, reason: 'unknown', url };
    if (customer.review_request_suppressed) return { ask: false, reason: 'suppressed', url };
    if (!cooldownPassed(customer.review_request_sent_at)) return { ask: false, reason: 'cooldown', url };

    // An unresolved delivery failure to this customer.
    const { count: badEmails, error: eErr } = await service
      .from('email_log')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .in('delivery_status', ['bounced', 'complained', 'failed'])
      .is('resolved_at', null);
    if (eErr) return { ask: false, reason: 'unknown', url };
    if ((badEmails ?? 0) > 0) return { ask: false, reason: 'open_complaint', url };

    // An open conversation with unread inbound messages: somebody is
    // waiting on us, which is not the moment to ask for five stars.
    const { count: openThreads, error: tErr } = await service
      .from('customer_threads')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .eq('status', 'open')
      .gt('unread_count', 0);
    if (tErr) return { ask: false, reason: 'unknown', url };
    if ((openThreads ?? 0) > 0) return { ask: false, reason: 'open_complaint', url };

    return { ask: true, reason: null, url };
  } catch {
    return { ask: false, reason: 'unknown', url };
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The block appended to a completion email. */
export function reviewBlockHtml(url: string): string {
  return `
    <div style="margin:26px 0 0;padding:18px 16px;border-top:1px solid #e5e7eb;text-align:center;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
      <div style="font-size:15px;font-weight:700;color:#1f2937;margin-bottom:6px;">How did we do?</div>
      <div style="font-size:13px;color:#6b7280;line-height:1.5;margin-bottom:14px;">
        If the work met the mark, a short review helps other fleets find us. If anything fell short, reply to this email first — we would rather fix it.
      </div>
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 20px;border-radius:8px;background:#1f2937;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">Leave a review</a>
    </div>`;
}

/**
 * Record that the ask went out. Called ONLY after the send succeeded — a
 * stamp written before delivery would suppress the next six months of asks
 * on the strength of an email that never left.
 */
export async function stampReviewAsk(service: Service, customerId: string): Promise<void> {
  try {
    await service
      .from('customers')
      .update({ review_request_sent_at: new Date().toISOString() })
      .eq('id', customerId);
  } catch (e: any) {
    // Failing to stamp costs at most one extra ask later; failing the
    // completion email over it would cost the customer their notification.
    console.error('review-request stamp failed:', e?.message);
  }
}
