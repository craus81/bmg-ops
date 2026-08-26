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
 * The BMG-side people who coordinate CNI work — approved admins (scalar role or
 * roles[] entry). The recipient set for installer-lifecycle notifications
 * (schedule declined, job complete, photos ready). Optionally drops the actor
 * so nobody is pinged about their own action. Mirrors the my-docs/my-invoices
 * staff-notify convention.
 */
export async function getCniStaffIds(
  service: SupabaseClient,
  excludeUserId?: string | null,
): Promise<string[]> {
  const { data } = await service
    .from('profiles')
    .select('id')
    .or('role.eq.admin,roles.cs.{admin}')
    .eq('status', 'approved');
  return (data || [])
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
