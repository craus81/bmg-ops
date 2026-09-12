/**
 * One Badge System (R6-13) — every "someone needs to deal with this" count
 * in one place, computed once per request and filtered to what the caller
 * can actually act on.
 *
 * Before this, each surface counted for itself: the More menu ran three
 * browser queries on mount, the dashboard ran dozens, and nothing fed the
 * app icon at all. The same queue could show a different number in two
 * places depending on which query was written when.
 *
 * A COUNT THAT FAILED IS null, NEVER 0. This is the whole risk in a badge:
 * a badge is read as "nothing needs you", and rendering that from a query
 * that errored is a lie the user cannot detect. Every queue returns
 * `number | null`, null is never summed into the total, and the response
 * names which queues could not be counted so a caller can say so.
 *
 * ROLE FILTERING IS REAL FILTERING. A queue the caller cannot open is not
 * counted for them — it would inflate a total they can do nothing about,
 * and send them to a page that 403s.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FeatureKey } from './features';
import { loadNeverInvoicedCount } from './ops-pulse';

type Service = SupabaseClient<any, any, any>;

export interface AttentionQueue {
  key: string;
  label: string;
  /** Feature the caller must hold. Admin-only queues use adminOnly instead. */
  feature?: FeatureKey;
  adminOnly?: boolean;
  /** Where the badge sends you. */
  path: string;
  /** null on failure — never 0, which would read as "all clear". */
  count: (service: Service) => Promise<number | null>;
}

/** A head-count that reports failure as null rather than zero. */
async function countRows(
  service: Service,
  table: string,
  build: (q: any) => any,
): Promise<number | null> {
  try {
    const { count, error } = await build(service.from(table).select('id', { count: 'exact', head: true }));
    if (error) {
      console.error(`[badges] count ${table} failed:`, error.message);
      return null;
    }
    return count ?? null;
  } catch (e: any) {
    console.error(`[badges] count ${table} threw:`, e?.message);
    return null;
  }
}

export const ATTENTION_QUEUES: AttentionQueue[] = [
  {
    key: 'pending_users',
    label: 'Accounts waiting for approval',
    feature: 'user_management',
    path: '/admin/users',
    count: (s) => countRows(s, 'profiles', q => q.eq('status', 'pending')),
  },
  {
    key: 'purchase_requests',
    label: 'Parts requests waiting to be ordered',
    feature: 'parts_ordering',
    path: '/admin/purchasing',
    count: (s) => countRows(s, 'purchase_requests', q => q.eq('status', 'pending')),
  },
  {
    key: 'manual_receipts',
    label: 'Receipts still needing NetSuite entry',
    feature: 'parts_ordering',
    path: '/admin/receiving',
    // Same predicate the More menu already used (ns_status, not a boolean flag) so
    // the badge cannot disagree with the page it links to.
    count: (s) => countRows(s, 'po_receipts', q => q.eq('ns_status', 'manual_needed')),
  },
  {
    key: 'credit_applications',
    label: 'Credit applications to review',
    feature: 'credit_applications',
    path: '/admin/credit-applications',
    count: (s) => countRows(s, 'credit_applications', q => q.eq('status', 'submitted')),
  },
  {
    key: 'proofs_awaiting',
    label: 'Proofs waiting on the customer',
    feature: 'graphics',
    path: '/graphics',
    count: (s) => countRows(s, 'graphics_jobs', q => q
      .not('sent_for_approval_at', 'is', null)
      .neq('customer_approved', true)
      .is('customer_rejected_at', null)
      .neq('status', 'cancelled')),
  },
  {
    key: 'never_invoiced',
    label: 'Finished vehicles never invoiced',
    adminOnly: true,
    path: '/admin/reports/never-invoiced',
    // Reuses the ops-pulse loader on purpose: the badge and the queue page
    // must never disagree about how many vehicles are leaking.
    count: (s) => loadNeverInvoicedCount(s),
  },
  {
    key: 'email_problems',
    label: 'Bounced emails nobody has fixed',
    feature: 'system_health',
    path: '/admin/system-health',
    count: (s) => countRows(s, 'email_log', q => q
      .in('delivery_status', ['bounced', 'failed'])
      .is('resolved_at', null)),
  },
];

export interface BadgeResult {
  /** key → count. A key present with null could not be counted. */
  counts: Record<string, number | null>;
  /** Sum of the counts that succeeded. Nulls are excluded, not zeroed. */
  total: number;
  /** Keys whose count failed, so the caller can say "some queues unknown". */
  unknown: string[];
  computedAt: string;
}

export interface QueueAccess {
  isAdmin: boolean;
  hasFeature: (key: FeatureKey) => boolean;
}

/** The queues this caller may see. */
export function visibleQueues(access: QueueAccess): AttentionQueue[] {
  return ATTENTION_QUEUES.filter(q => {
    if (q.adminOnly) return access.isAdmin;
    if (q.feature) return access.isAdmin || access.hasFeature(q.feature);
    return true;
  });
}

export async function computeBadges(service: Service, access: QueueAccess): Promise<BadgeResult> {
  const queues = visibleQueues(access);
  const results = await Promise.all(queues.map(async q => [q.key, await q.count(service)] as const));

  const counts: Record<string, number | null> = {};
  const unknown: string[] = [];
  let total = 0;
  for (const [key, value] of results) {
    counts[key] = value;
    if (value == null) unknown.push(key);
    else total += value;
  }
  return { counts, total, unknown, computedAt: new Date().toISOString() };
}

// ═══════════ CACHE ═══════════

interface CacheEntry { at: number; value: BadgeResult }
const CACHE_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/** Cache key: the ACCESS SHAPE, not the user — two admins share a result,
 *  and a user whose permissions change gets a different key immediately. */
export function accessKey(access: QueueAccess): string {
  return visibleQueues(access).map(q => q.key).join(',') || 'none';
}

export async function cachedBadges(service: Service, access: QueueAccess): Promise<BadgeResult & { cacheAgeMs: number }> {
  const key = accessKey(access);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) {
    return { ...hit.value, cacheAgeMs: now - hit.at };
  }
  const value = await computeBadges(service, access);
  cache.set(key, { at: now, value });
  return { ...value, cacheAgeMs: 0 };
}

/** Test seam — the cache is module state and would leak between cases. */
export function clearBadgeCache(): void {
  cache.clear();
}
