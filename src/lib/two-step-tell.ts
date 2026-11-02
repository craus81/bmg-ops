import type { SupabaseClient } from '@supabase/supabase-js';
import { getSuperAdminIds, notifyMany } from '@/lib/notify';
import { newAlertWatcherIds } from '@/lib/new-alert-watchers';

/**
 * Tells the super admins, and anyone copied on new alerts (Craig's standing
 * rule, 2026-10-28), that someone's two-step sign-in changed (src/lib/two-step.ts):
 * someone set an authenticator app up, so one set up by someone else who had
 * their password is caught, or a super admin reset someone's. Leaves out the
 * people named, such as whoever made the change. An alert that can't be sent
 * never undoes the change.
 */
export async function tellTwoStepChange(
  service: SupabaseClient,
  alert: { title: string; body: string; url: string },
  leaveOut: Array<string | null | undefined>,
): Promise<void> {
  try {
    const [admins, watchers] = await Promise.all([getSuperAdminIds(null), newAlertWatcherIds(service)]);
    const skip = new Set(leaveOut.filter(Boolean));
    const to = [...new Set([...admins, ...watchers])].filter((id) => !!id && !skip.has(id));
    if (to.length > 0) await notifyMany(to, { type: 'two_step_changed', ...alert, channels: ['in_app', 'push', 'email'] });
  } catch (err) {
    console.error(`[two-step] alert not sent: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Someone's name for an alert: their full name, else their email, else "Someone". */
export function personName(p: { full_name?: string | null; email?: string | null } | null | undefined): string {
  return p?.full_name?.trim() || p?.email?.trim() || 'Someone';
}
