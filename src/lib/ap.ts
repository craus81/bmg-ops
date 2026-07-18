import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Everyone who should see AP notifications: finance users, falling back to
 * admins when no finance role has been assigned yet.
 */
export async function financeUserIds(
  service: SupabaseClient<any, any, any>,
  excludeId?: string,
): Promise<string[]> {
  const { data } = await service
    .from('profiles')
    .select('id, role, roles')
    .or('role.eq.finance,roles.cs.{finance},role.eq.admin,roles.cs.{admin}')
    .eq('status', 'approved');
  const all = (data || []);
  const finance = all.filter(p => p.role === 'finance' || (p.roles || []).includes('finance'));
  const pool = finance.length > 0 ? finance : all;
  return pool.map(p => p.id).filter(id => id !== excludeId);
}
