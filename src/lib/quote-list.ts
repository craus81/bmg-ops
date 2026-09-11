/**
 * ONE loader for the combined quotes list — estimates and wrap quotes as
 * a single stream of "quotes", whichever builder made them. Powers
 * GET /api/quotes (the /quotes page: every status) and
 * GET /api/quotes/follow-up (legacy queue endpoint: sent only), so the
 * two can't drift on how the union is built.
 *
 * Deliberately NOT a table merge: each row keeps its type and opens in
 * its own builder. Both tables grow unboundedly, so reads paginate
 * (fetchAllRows) with a deterministic order + id tiebreaker.
 *
 * Server-only: callers pass a service-role Supabase client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { estimateHeadlineNumber, estimateAltNumber } from './estimate-number';
import { expiryState, type ExpiryState } from './quote-expiry';
import { summarizeViews, type ViewSummary } from './quote-views';

export type QuoteListStatus = 'working' | 'sent' | 'won' | 'lost' | 'all';

export interface QuoteFollowUpNote {
  id: string;
  note: string | null;
  remindAt: string | null;
  reminderSentAt: string | null;
  createdBy: string | null;
  creatorName: string | null;
  createdAt: string;
}

export interface QuoteListItem {
  type: 'estimate' | 'wrap';
  id: string;
  /** The number staff look for: NetSuite's once an estimate is pushed
   *  (estimate-number.ts), the builder's own number otherwise. */
  number: string;
  /** The other number when a pushed estimate has two; null for wrap quotes. */
  altNumber: string | null;
  title: string;
  customer: string;
  total: number;
  /** Raw per-table status: draft | pushed (estimates only) | sent |
   *  accepted | rejected. The list groups draft+pushed as "working". */
  status: string;
  repId: string | null;
  repName: string | null;
  createdAt: string | null;
  sentAt: string | null;
  /** Accepted/rejected timestamp where the table records one. */
  decidedAt: string | null;
  lastFollowupAt: string | null;
  /** Follow-up history — loaded for sent quotes (where chasing happens). */
  followups: QuoteFollowUpNote[];
  /** Earliest pending (undelivered, future-or-today) reminder date, if any. */
  nextReminderAt: string | null;
  /** When the customer's approval link stops working (R6-9). The TOKEN
   *  expiry is the quote's expiry — it is the date in their email and the
   *  moment Accept stops working. The token itself is never exposed here:
   *  it is a credential, stripped from every estimate GET for that reason. */
  expiresAt: string | null;
  /** no_link when nothing was ever sent for approval — never 'expired'. */
  expiryState: ExpiryState;
  /** Approval-page opens (R6-9), people and machines counted apart. Loaded
   *  for sent quotes only — that is where a rep reads it. */
  views: ViewSummary;
  /** Was this quote sent while the app was recording opens? False means
   *  zero views is UNKNOWN, not "nobody looked" — the UI must not claim
   *  "never opened" about a quote nothing was watching. */
  viewsTracked: boolean;
}

// The "working" group is everything not yet in front of the customer:
// estimate drafts and NetSuite-pushed estimates, wrap drafts.
const EST_STATUSES: Record<Exclude<QuoteListStatus, 'all'>, string[]> = {
  working: ['draft', 'pushed'],
  sent: ['sent'],
  won: ['accepted'],
  lost: ['rejected'],
};
const WRAP_STATUSES: Record<Exclude<QuoteListStatus, 'all'>, string[]> = {
  working: ['draft'],
  sent: ['sent'],
  won: ['accepted'],
  lost: ['rejected'],
};

export async function loadQuoteListItems(
  service: SupabaseClient,
  status: QuoteListStatus,
): Promise<QuoteListItem[]> {
  // Build a FRESH query per pagination call — PostgREST builders accumulate
  // clauses, so reusing one across fetchAllRows pages would stack orders.
  const estQuery = () => {
    let q = service
      .from('estimates')
      .select('id, estimate_number, netsuite_estimate_number, title, customer_name, grand_total, status, created_by, created_at, sent_for_approval_at, updated_at, last_followup_at, customer_approved_at, approval_token_expires_at');
    if (status !== 'all') q = q.in('status', EST_STATUSES[status]);
    return q.order('created_at', { ascending: false }).order('id');
  };
  const wrapQuery = () => {
    let q = service
      .from('wrap_quotes')
      .select('id, quote_number, vehicle_description, customer, total, status, created_by, created_at, sent_at, last_followup_at, accepted_at, rejected_at, approval_token_expires_at')
      .is('archived_at', null);
    if (status !== 'all') q = q.in('status', WRAP_STATUSES[status]);
    return q.order('created_at', { ascending: false }).order('id');
  };

  const [estRes, wrapRes] = await Promise.all([
    fetchAllRows<any>((from, to) => estQuery().range(from, to)),
    fetchAllRows<any>((from, to) => wrapQuery().range(from, to)),
  ]);
  if (estRes.error) throw new Error(estRes.error.message);
  if (wrapRes.error) throw new Error(wrapRes.error.message);

  const items: QuoteListItem[] = [
    ...(estRes.data || []).map((e: any) => ({
      type: 'estimate' as const,
      id: e.id,
      number: estimateHeadlineNumber(e),
      altNumber: estimateAltNumber(e),
      title: e.title || '',
      customer: e.customer_name || '—',
      total: Number(e.grand_total) || 0,
      status: e.status || 'draft',
      repId: e.created_by,
      repName: null,
      createdAt: e.created_at,
      // Pre-column rows have no sent_for_approval_at — updated_at is the
      // best send-time signal we have for them (same as the old queue).
      sentAt: e.status === 'sent' ? (e.sent_for_approval_at || e.updated_at) : e.sent_for_approval_at,
      decidedAt: e.status === 'accepted' ? e.customer_approved_at || null : null,
      lastFollowupAt: e.last_followup_at,
      followups: [] as QuoteFollowUpNote[],
      nextReminderAt: null,
      expiresAt: e.approval_token_expires_at || null,
      expiryState: expiryState(e.approval_token_expires_at),
      views: { humanCount: 0, firstHumanAt: null, lastHumanAt: null, machineCount: 0 } as ViewSummary,
      viewsTracked: false,
    })),
    ...(wrapRes.data || []).map((w: any) => ({
      type: 'wrap' as const,
      id: w.id,
      number: w.quote_number,
      altNumber: null,
      title: w.vehicle_description || '',
      customer: (w.customer as any)?.name || '—',
      total: Number(w.total) || 0,
      status: w.status || 'draft',
      repId: w.created_by,
      repName: null,
      createdAt: w.created_at,
      sentAt: w.sent_at,
      decidedAt: w.status === 'accepted' ? w.accepted_at : w.status === 'rejected' ? w.rejected_at : null,
      lastFollowupAt: w.last_followup_at,
      followups: [] as QuoteFollowUpNote[],
      nextReminderAt: null,
      expiresAt: w.approval_token_expires_at || null,
      expiryState: expiryState(w.approval_token_expires_at),
      views: { humanCount: 0, firstHumanAt: null, lastHumanAt: null, machineCount: 0 } as ViewSummary,
      viewsTracked: false,
    })),
  ];

  // Follow-up history (comments + reminders) for the SENT quotes — that's
  // where chasing happens. Best-effort so the list still loads before
  // migration 212; history grows unboundedly, so paginate.
  const sentItems = items.filter(i => i.status === 'sent');
  const byKey = new Map(sentItems.map(i => [`${i.type}-${i.id}`, i]));
  if (sentItems.length > 0) {
    const { data: fuRows } = await fetchAllRows<any>((from, to) =>
      service
        .from('quote_followups')
        .select('id, quote_type, quote_id, note, remind_at, reminder_sent_at, created_by, created_at')
        .in('quote_id', sentItems.map(i => i.id))
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to),
    );
    const today = new Date().toISOString().slice(0, 10);
    for (const r of fuRows || []) {
      const item = byKey.get(`${r.quote_type}-${r.quote_id}`);
      if (!item) continue;
      item.followups.push({
        id: r.id,
        note: r.note,
        remindAt: r.remind_at,
        reminderSentAt: r.reminder_sent_at,
        createdBy: r.created_by,
        creatorName: null,
        createdAt: r.created_at,
      });
      if (r.remind_at && !r.reminder_sent_at && r.remind_at >= today) {
        if (!item.nextReminderAt || r.remind_at < item.nextReminderAt) item.nextReminderAt = r.remind_at;
      }
    }
  }

  // Approval-page opens for the sent quotes (R6-9). Best-effort: a list that
  // will not render because migration 302 has not applied yet would be a
  // worse trade than a list with no view chips.
  if (sentItems.length > 0) {
    try {
      const { data: settings } = await service
        .from('quote_settings').select('view_tracking_started_at').eq('id', 1).maybeSingle();
      const startedAt = (settings as any)?.view_tracking_started_at
        ? Date.parse((settings as any).view_tracking_started_at)
        : NaN;

      const ids = sentItems.map(i => i.id);
      const byQuote = new Map<string, any[]>();
      // Chunked: `.in()` rides in the URL, and a shop with hundreds of sent
      // quotes would build a query string long enough to be rejected.
      for (let i = 0; i < ids.length; i += 200) {
        const slice = ids.slice(i, i + 200);
        const { data: viewRows } = await fetchAllRows<any>((from, to) =>
          service
            .from('quote_views')
            .select('quote_type, quote_id, viewed_at, viewer_kind')
            .in('quote_id', slice)
            .order('viewed_at', { ascending: false })
            .order('id')
            .range(from, to),
        );
        for (const v of viewRows || []) {
          const k = `${v.quote_type}-${v.quote_id}`;
          const arr = byQuote.get(k) || [];
          arr.push(v);
          byQuote.set(k, arr);
        }
      }
      for (const [k, item] of byKey) {
        item.views = summarizeViews(byQuote.get(k) || []);
        const sent = item.sentAt ? Date.parse(item.sentAt) : NaN;
        item.viewsTracked = !Number.isNaN(startedAt) && !Number.isNaN(sent) && sent >= startedAt;
      }
    } catch {
      // Leave every summary empty and viewsTracked false — with no data the
      // honest reading is "we do not know", which is exactly what the false
      // flag makes the UI say.
    }
  }

  const nameIds = [...new Set([
    ...items.map(i => i.repId),
    ...items.flatMap(i => i.followups.map(f => f.createdBy)),
  ].filter(Boolean))] as string[];
  if (nameIds.length > 0) {
    const { data: reps } = await service.from('profiles').select('id, full_name').in('id', nameIds);
    const names = new Map((reps || []).map((r: any) => [r.id, r.full_name]));
    for (const i of items) {
      i.repName = i.repId ? names.get(i.repId) || null : null;
      for (const f of i.followups) f.creatorName = f.createdBy ? names.get(f.createdBy) || null : null;
    }
  }

  return items;
}
