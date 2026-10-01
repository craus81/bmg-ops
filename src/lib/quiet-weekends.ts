import type { SupabaseClient } from '@supabase/supabase-js';
import { isBusinessDay, shopDay } from '@/lib/business-heartbeat';

/**
 * Quiet weekends (owner decision 2026-09-28): the routine daily nudges —
 * follow-ups, reminders, aging sweeps — don't go out on Saturday or Sunday.
 * Urgent traffic is untouched: customer approvals and other event-driven
 * notifications, system health, direct messages and mentions, money and
 * delivery-failure alarms.
 *
 * The routine sweeps judge the CURRENT state of things (what is overdue,
 * stuck or unanswered right now) and stamp what they've sent, so skipping a
 * weekend run loses nothing: Monday's run picks up whatever came due.
 */

/** Saturday or Sunday on the shop's clock (America/Chicago). */
export function isShopWeekend(at: Date = new Date()): boolean {
  return !isBusinessDay(shopDay(at));
}

/**
 * Mark a routine cron's weekend skip on its sync_state row.
 *
 * Only `updated_at` moves. A daily job's stale threshold is ~48h, so a
 * Friday run followed by two skipped days would otherwise show stale on
 * System Health by Sunday and page the super admins. `last_result` is left
 * exactly as the last real run wrote it: several sweeps keep their dedupe
 * state there (at-risk snapshot, stuck-vehicle alert times), and an error
 * from Friday should still read as an error over the weekend. No cron_runs
 * row is written — nothing ran.
 */
export async function markWeekendSkip(service: SupabaseClient, syncType: string): Promise<void> {
  const { error } = await service
    .from('sync_state')
    .update({ updated_at: new Date().toISOString() })
    .eq('sync_type', syncType);
  if (error) console.error(`[quiet-weekends] ${syncType} skip stamp failed:`, error.message);
}
