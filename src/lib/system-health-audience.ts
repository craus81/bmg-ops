import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Who hears about a background-job problem.
 *
 * Lifted VERBATIM from the health-check cron, which owned this selection
 * alone: approved profiles carrying `admin` (scalar role or roles array),
 * kept when they are super_admin OR have been granted `system_health`
 * individually. System Health is an owner-level page, so the audience for an
 * alert about it is the people who can actually open the page and act.
 *
 * It moved here because the ledger importer needs the same audience and
 * neither job may import the other's route (a `route.ts` is not a library),
 * and because a second hand-rolled copy is how two "the same" audiences
 * quietly drift apart.
 *
 * Returns profile ids. An empty array is a real answer — nobody holds the
 * feature — and callers simply send nothing.
 */
export async function systemHealthAudience(service: SupabaseClient): Promise<string[]> {
  const [{ data: admins }, { data: overrides }] = await Promise.all([
    service
      .from('profiles')
      .select('id, roles')
      .or('role.eq.admin,roles.cs.{admin}')
      .eq('status', 'approved'),
    service
      .from('user_feature_overrides')
      .select('user_id')
      .eq('feature', 'system_health')
      .eq('granted', true),
  ]);

  const granted = new Set((overrides || []).map((o: any) => o.user_id));
  return (admins || [])
    .filter((a: any) => (a.roles || []).includes('super_admin') || granted.has(a.id))
    .map((a: any) => String(a.id));
}
