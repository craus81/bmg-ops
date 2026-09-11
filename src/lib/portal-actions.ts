/**
 * Portal Action Center — every approval this customer still owes us, in
 * one list (R6-11).
 *
 * The portal already showed each approval where its own record lived:
 * estimates in the estimates section, proofs and wrap quotes nowhere at
 * all. A customer with three things waiting had to find all three. This
 * collects them.
 *
 * SCOPING IS ID-KEYED, ALWAYS. Every source below joins on a real
 * identifier — estimates and proofs on `customer_netsuite_id`, wrap quotes
 * on `customer_id`, plus proofs reachable through one of this customer's
 * purchase orders. Nothing here name-matches, and that is not a
 * convenience: an entry in this list is a live E-SIGN link the holder can
 * click and legally accept, so "Acme Fleet" matching "Acme Fleet LLC"
 * would hand one company another's contract. A record with no id link is
 * invisible here rather than guessed at.
 *
 * A dead link is listed too, as `expired` with no URL — that is the whole
 * point of showing it (the fresh-link request in
 * `src/lib/approval-relink.ts` is what revives it). Expired entries are
 * bounded to EXPIRED_WINDOW_DAYS since the send: a quote nobody answered
 * two years ago is not an outstanding action, and listing it invites a
 * customer to resurrect a price we no longer honour.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { deepLinks } from './deep-links';

type Service = SupabaseClient<any, any, any>;

export type PortalActionKind = 'estimate' | 'quote' | 'proof';
export type PortalActionState = 'awaiting' | 'expired';

/** How far back a DEAD link is still worth showing as an outstanding action. */
export const EXPIRED_WINDOW_DAYS = 90;
/** How far back to look at all. A live token can't be older than its own
 *  expiry, so this only bounds the query, never the answer. */
export const LOOKBACK_DAYS = 240;
/** Per-source cap. Three sources, so the strip tops out at 90 rows. */
export const PER_KIND_CAP = 30;

export interface PortalAction {
  kind: PortalActionKind;
  /** Record id. The fresh-link request names it; it is not a secret (it
   *  buys nothing without the token, which never leaves the server). */
  id: string;
  /** What the customer calls it: "Estimate #EST-2609-014", "Job 4471". */
  ref: string;
  title: string | null;
  sentAt: string | null;
  /** Last automatic nudge, so "we did chase this" is visible. */
  remindedAt: string | null;
  expiresAt: string | null;
  total: number | null;
  state: PortalActionState;
  /** Live Review & Approve path. Null once the link is dead — a URL here
   *  is a promise that the click works. */
  approveUrl: string | null;
  kindLabel: string;
  actionLabel: string;
}

const KIND_LABEL: Record<PortalActionKind, string> = {
  estimate: 'Estimate',
  quote: 'Wrap quote',
  proof: 'Artwork proof',
};
const ACTION_LABEL: Record<PortalActionKind, string> = {
  estimate: 'Review & approve',
  quote: 'Review & accept',
  proof: 'Review artwork',
};

/** A token is live when it exists and has not lapsed. No token is the same
 *  lived experience as a lapsed one — a dead link — so it reads the same. */
export function tokenLive(token: unknown, expiresAt: unknown, now = Date.now()): boolean {
  if (!token) return false;
  if (!expiresAt) return true;
  const t = Date.parse(String(expiresAt));
  return Number.isFinite(t) ? t > now : true;
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const iso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Awaiting before expired; inside each group the longest wait first — the
 *  one that has been blocking us since March outranks yesterday's. */
export function sortActions(actions: PortalAction[]): PortalAction[] {
  const rank = (a: PortalAction) => (a.state === 'awaiting' ? 0 : 1);
  return [...actions].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return String(a.sentAt || '').localeCompare(String(b.sentAt || ''));
  });
}

/** Drop an entry whose dead link is older than the window worth reviving. */
export function withinWindow(a: PortalAction, now = Date.now()): boolean {
  if (a.state === 'awaiting') return true;
  if (!a.sentAt) return false;
  const t = Date.parse(a.sentAt);
  if (!Number.isFinite(t)) return false;
  return now - t <= EXPIRED_WINDOW_DAYS * 86_400_000;
}

export function buildEstimateAction(row: any, now = Date.now()): PortalAction {
  const live = tokenLive(row.approval_token, row.approval_token_expires_at, now);
  return {
    kind: 'estimate',
    id: String(row.id),
    ref: row.estimate_number ? `Estimate #${row.estimate_number}` : 'Estimate',
    title: row.title || null,
    sentAt: row.sent_for_approval_at || null,
    remindedAt: row.approval_reminder_sent_at || null,
    expiresAt: row.approval_token_expires_at || null,
    total: numOrNull(row.grand_total),
    state: live ? 'awaiting' : 'expired',
    approveUrl: live ? deepLinks.approveEstimate(String(row.approval_token)) : null,
    kindLabel: KIND_LABEL.estimate,
    actionLabel: ACTION_LABEL.estimate,
  };
}

export function buildQuoteAction(row: any, now = Date.now()): PortalAction {
  const live = tokenLive(row.approval_token, row.approval_token_expires_at, now);
  return {
    kind: 'quote',
    id: String(row.id),
    ref: row.quote_number ? `Wrap quote ${row.quote_number}` : 'Wrap quote',
    title: row.vehicle_description || null,
    sentAt: row.sent_at || null,
    remindedAt: row.last_followup_at || null,
    expiresAt: row.approval_token_expires_at || null,
    total: numOrNull(row.total),
    state: live ? 'awaiting' : 'expired',
    approveUrl: live ? deepLinks.approveQuote(String(row.approval_token)) : null,
    kindLabel: KIND_LABEL.quote,
    actionLabel: ACTION_LABEL.quote,
  };
}

export function buildProofAction(row: any, now = Date.now()): PortalAction {
  const live = tokenLive(row.approval_token, row.approval_token_expires_at, now);
  return {
    kind: 'proof',
    id: String(row.id),
    ref: row.job_number ? `Job ${row.job_number}` : 'Artwork proof',
    title: row.title || null,
    sentAt: row.sent_for_approval_at || null,
    remindedAt: row.approval_reminder_sent_at || null,
    expiresAt: row.approval_token_expires_at || null,
    // A proof carries no price of its own — the money lives on the
    // estimate or PO it came from. Null, not 0: zero would read as free.
    total: null,
    state: live ? 'awaiting' : 'expired',
    approveUrl: live ? deepLinks.approveProof(String(row.approval_token)) : null,
    kindLabel: KIND_LABEL.proof,
    actionLabel: ACTION_LABEL.proof,
  };
}

/**
 * Everything this customer still has to answer. `customer.id` scopes wrap
 * quotes, `customer.netsuite_id` scopes estimates and proofs, and
 * `poIds` (this customer's purchase orders, already loaded by the caller)
 * catches proofs created from a PO before the netsuite id was stamped on
 * the job — still an id join, just a second hop.
 */
export async function loadPortalActions(
  service: Service,
  customer: { id: string; netsuite_id: string },
  poIds: string[] = [],
): Promise<PortalAction[]> {
  const since = iso(LOOKBACK_DAYS);
  const out: PortalAction[] = [];

  const [estimates, quotes, proofsById, proofsByPo] = await Promise.all([
    service
      .from('estimates')
      .select('id, estimate_number, title, grand_total, sent_for_approval_at, approval_token, approval_token_expires_at, approval_reminder_sent_at')
      .eq('customer_netsuite_id', customer.netsuite_id)
      .not('sent_for_approval_at', 'is', null)
      .gte('sent_for_approval_at', since)
      .is('customer_rejected_at', null)
      .neq('customer_approved', true)
      .not('status', 'in', '("accepted","cancelled")')
      .order('sent_for_approval_at', { ascending: false })
      .limit(PER_KIND_CAP),
    service
      .from('wrap_quotes')
      .select('id, quote_number, vehicle_description, total, sent_at, approval_token, approval_token_expires_at, last_followup_at')
      .eq('customer_id', customer.id)
      .not('sent_at', 'is', null)
      .gte('sent_at', since)
      .is('accepted_at', null)
      .is('rejected_at', null)
      .is('archived_at', null)
      .order('sent_at', { ascending: false })
      .limit(PER_KIND_CAP),
    service
      .from('graphics_jobs')
      .select('id, job_number, title, sent_for_approval_at, approval_token, approval_token_expires_at, approval_reminder_sent_at')
      .eq('customer_netsuite_id', customer.netsuite_id)
      .not('sent_for_approval_at', 'is', null)
      .gte('sent_for_approval_at', since)
      .is('customer_rejected_at', null)
      .neq('customer_approved', true)
      .neq('status', 'cancelled')
      .order('sent_for_approval_at', { ascending: false })
      .limit(PER_KIND_CAP),
    poIds.length > 0
      ? service
        .from('graphics_jobs')
        .select('id, job_number, title, sent_for_approval_at, approval_token, approval_token_expires_at, approval_reminder_sent_at')
        .in('po_id', poIds.slice(0, 200))
        .not('sent_for_approval_at', 'is', null)
        .gte('sent_for_approval_at', since)
        .is('customer_rejected_at', null)
        .neq('customer_approved', true)
        .neq('status', 'cancelled')
        .order('sent_for_approval_at', { ascending: false })
        .limit(PER_KIND_CAP)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  for (const row of estimates.data || []) out.push(buildEstimateAction(row));
  for (const row of quotes.data || []) out.push(buildQuoteAction(row));

  // The two proof queries overlap by design (a PO-linked job usually
  // carries the netsuite id too) — dedupe on job id, first wins.
  const seenProof = new Set<string>();
  for (const row of [...(proofsById.data || []), ...((proofsByPo as any).data || [])]) {
    const id = String(row.id);
    if (seenProof.has(id)) continue;
    seenProof.add(id);
    out.push(buildProofAction(row));
  }

  return sortActions(out.filter(a => withinWindow(a)));
}
