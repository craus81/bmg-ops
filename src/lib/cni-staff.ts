import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveFeatures } from './features';

/**
 * The internal people who chase CNI paperwork and coordinate jobs: anyone
 * whose resolved features include `cni_admin`. Resolved through
 * resolveFeatures — the SAME function the UI and the route guards use — so a
 * delegated coordinator with a per-user grant is in this audience and a
 * revoked admin is not, without this file re-deriving the rules and drifting.
 *
 * Takes the client so this module stays free of a module-scope Supabase
 * client (which would make it untestable under vitest).
 */
export async function cniStaffIds(service: SupabaseClient): Promise<string[]> {
  const [{ data: profiles }, { data: overrides }] = await Promise.all([
    service.from('profiles').select('id, role, roles, deactivated').eq('status', 'approved'),
    service.from('user_feature_overrides').select('user_id, feature, granted'),
  ]);
  const byUser = new Map<string, { feature: string; granted: boolean }[]>();
  for (const o of overrides || []) {
    const arr = byUser.get(o.user_id) || [];
    arr.push({ feature: o.feature, granted: o.granted });
    byUser.set(o.user_id, arr);
  }
  return (profiles || [])
    .filter((p: any) => !p.deactivated)
    .filter((p: any) => {
      const roles = Array.isArray(p.roles) && p.roles.length > 0 ? p.roles : (p.role ? [p.role] : []);
      return resolveFeatures(roles, byUser.get(p.id) || []).has('cni_admin');
    })
    .map((p: any) => p.id);
}
