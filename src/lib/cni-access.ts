/**
 * Company-based CNI job access (docs/pay-splits-design.md).
 *
 * Jobs are assigned to a company; any installer at that company can act on
 * the job (schedule, scan, complete, invoice) — there is no lead. The legacy
 * assigned_installer_id is still honored for jobs predating company
 * assignment. Server-only helpers for service-role API routes; the matching
 * RLS policies live in migrations/110-companies-and-pay-splits.sql.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveFeatures } from '@/lib/features';

export function rolesOf(profile: { role?: string | null; roles?: string[] | null } | null): string[] {
  if (!profile) return [];
  return profile.roles?.length ? profile.roles : (profile.role ? [profile.role] : []);
}

/**
 * The user's company, straight from their profile — the same company they're
 * assigned at access-granting time. CNI membership is not a separate list.
 */
export async function getCniCompanyId(
  service: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data } = await service
    .from('profiles')
    .select('company_id')
    .eq('id', userId)
    .maybeSingle();
  return data?.company_id || null;
}

/**
 * May this (non-admin) user act on this CNI job? True when they're at the
 * assigned company, or are the legacy assigned installer.
 */
export async function canActOnCniJob(
  service: SupabaseClient,
  userId: string,
  job: { assigned_installer_id?: string | null; assigned_company_id?: string | null },
): Promise<boolean> {
  if (job.assigned_installer_id === userId) return true;
  if (!job.assigned_company_id) return false;
  const companyId = await getCniCompanyId(service, userId);
  return companyId !== null && companyId === job.assigned_company_id;
}

/**
 * The BMG-side people who coordinate CNI work — approved profiles holding the
 * `cni_admin` feature, resolved exactly the way the CNI admin pages gate
 * (role defaults + per-user overrides via resolveFeatures). That covers
 * admins and super_admins by default, admits non-admin staff granted the
 * console, and drops admins who had it revoked — previously this was "every
 * admin", so people who couldn't even open the review pages were pinged for
 * every CNI lifecycle event (R3-4). Falls back to all approved admins if
 * nobody holds the feature, so a coordination alert can never dead-end.
 * Optionally drops the actor so nobody is pinged about their own action.
 */
export async function getCniStaffIds(
  service: SupabaseClient,
  excludeUserId?: string | null,
): Promise<string[]> {
  const [{ data: profiles }, { data: overrides }] = await Promise.all([
    service
      .from('profiles')
      .select('id, role, roles')
      .eq('status', 'approved'),
    service
      .from('user_feature_overrides')
      .select('user_id, granted')
      .eq('feature', 'cni_admin'),
  ]);

  const overrideByUser = new Map<string, boolean>();
  for (const o of overrides || []) overrideByUser.set(o.user_id, o.granted);

  const holders = (profiles || [])
    .filter((p: any) => {
      const roles = rolesOf(p).map((r) => (r === 'production' ? 'graphics_production' : r));
      const ov = overrideByUser.has(p.id)
        ? [{ feature: 'cni_admin', granted: overrideByUser.get(p.id)! }]
        : [];
      return resolveFeatures(roles, ov).has('cni_admin');
    })
    .map((p: any) => p.id as string)
    .filter((id: string) => id && id !== excludeUserId);
  if (holders.length > 0) return holders;

  const { data: admins } = await service
    .from('profiles')
    .select('id')
    .or('role.eq.admin,roles.cs.{admin}')
    .eq('status', 'approved');
  return (admins || [])
    .map((p: any) => p.id as string)
    .filter((id: string) => id && id !== excludeUserId);
}

/**
 * The installers to notify when a company is assigned/scheduled to a job:
 * approved profiles at that company carrying the installer role (scalar or
 * roles[]). A CNI company's roster is simply its profiles.company_id members.
 * Optionally drops the actor.
 */
export async function getCompanyInstallerIds(
  service: SupabaseClient,
  companyId: string,
  excludeUserId?: string | null,
): Promise<string[]> {
  if (!companyId) return [];
  const { data } = await service
    .from('profiles')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'approved')
    .or('role.eq.installer,roles.cs.{installer}');
  return (data || [])
    .map((p: any) => p.id as string)
    .filter((id: string) => id && id !== excludeUserId);
}
