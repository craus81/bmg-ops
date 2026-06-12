/**
 * Client-side helpers for the shared `companies` table as used by CNI.
 *
 * CNI does not keep its own company list: a "CNI company" is just a row in
 * `companies` (the same list assigned to users at access-granting time), and
 * its installers are the profiles whose `company_id` points at it. These
 * helpers centralize "load companies with their installer counts" so the job
 * pages and the companies admin stay consistent.
 *
 * Takes a Supabase browser client (admin pages run with admin RLS).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CompanyOption {
  id: string;
  name: string;
  memberCount: number;
}

/** Profile ids → true for users who carry an installer role. */
function isInstaller(p: { role?: string | null; roles?: string[] | null }): boolean {
  return p.role === 'installer' || !!p.roles?.includes('installer');
}

/** Installer headcount per company id (only approved installer profiles). */
export async function installerCountsByCompany(
  supabase: SupabaseClient,
): Promise<Map<string, number>> {
  const { data } = await supabase
    .from('profiles')
    .select('company_id, role, roles, status')
    .not('company_id', 'is', null)
    .eq('status', 'approved');
  const counts = new Map<string, number>();
  for (const p of data || []) {
    if (!isInstaller(p)) continue;
    counts.set(p.company_id, (counts.get(p.company_id) || 0) + 1);
  }
  return counts;
}

/** All companies with their installer counts, name-sorted. */
export async function loadCompaniesWithCounts(
  supabase: SupabaseClient,
): Promise<CompanyOption[]> {
  const [{ data: comps }, counts] = await Promise.all([
    supabase.from('companies').select('id, name').order('name'),
    installerCountsByCompany(supabase),
  ]);
  return (comps || []).map((c: { id: string; name: string }) => ({
    id: c.id,
    name: c.name,
    memberCount: counts.get(c.id) || 0,
  }));
}
