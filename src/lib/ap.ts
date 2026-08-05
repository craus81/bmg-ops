import type { SupabaseClient } from '@supabase/supabase-js';
import { deepLinks } from '@/lib/deep-links';

/**
 * Where an AP decision notification should send the submitter: installers
 * (who submit from the CNI portal) can't open admin pages. Pass the vendor
 * invoice id so either destination opens ON that invoice, not just the list.
 */
export async function apSubmitterUrl(
  service: SupabaseClient<any, any, any>,
  submitterId: string,
  invoiceId?: string | null,
): Promise<string> {
  const { data } = await service
    .from('profiles').select('role, roles').eq('id', submitterId).maybeSingle();
  const roles: string[] = data?.roles?.length ? data.roles : [data?.role];
  if (roles.includes('installer')) {
    return invoiceId ? deepLinks.installerInvoice(invoiceId) : '/installer/invoices';
  }
  return invoiceId ? deepLinks.apInvoice(invoiceId) : '/admin/ap';
}

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
