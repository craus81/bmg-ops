import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resolve a portal token to its customer — the ONE credential check every
 * tokenized portal route shares (R5-14 factored it out of the PO-portal
 * route). Null = invalid token or a customer with no NetSuite link; the
 * caller returns 404 without distinguishing which (don't confirm token
 * existence to guessers).
 */
export interface PortalCustomer {
  id: string;
  netsuite_id: string;
  company_name: string | null;
  email: string | null;
}

export async function resolvePortalCustomer(
  service: SupabaseClient,
  token: string,
): Promise<PortalCustomer | null> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  const { data: customer } = await service
    .from('customers')
    .select('id, netsuite_id, company_name, email')
    .eq('portal_token', token)
    .maybeSingle();
  if (!customer?.netsuite_id) return null;
  return {
    id: customer.id,
    netsuite_id: String(customer.netsuite_id),
    company_name: customer.company_name,
    email: customer.email,
  };
}
