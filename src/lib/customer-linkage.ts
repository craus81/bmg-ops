/**
 * Resolve the customer behind a record from whichever id the flow holds.
 *
 * Three ids name a customer around the app: customers.id (the NetSuite
 * mirror row), prospects.id (the CRM record — the account-history timeline
 * hangs off THIS one), and the NetSuite customer internal id that bridges
 * the two (customers.netsuite_id = prospects.netsuite_id). Every producer
 * of account history needs the same hops, so they live here once: the
 * email send layer, quote-response logging, and anything else that writes
 * a prospect_activities row.
 *
 * Best-effort: a failed lookup returns what was resolvable. Callers treat
 * a null prospectId as "no timeline to write to".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CustomerLinkageInput {
  customerId?: string | null;
  prospectId?: string | null;
  netsuiteCustomerId?: string | number | null;
}

export interface CustomerLinkage {
  customerId: string | null;
  prospectId: string | null;
}

export async function resolveCustomerLinkage(
  service: SupabaseClient,
  input: CustomerLinkageInput,
): Promise<CustomerLinkage> {
  let customerId = input.customerId || null;
  let prospectId = input.prospectId || null;
  const nsId = input.netsuiteCustomerId != null && input.netsuiteCustomerId !== '' ? String(input.netsuiteCustomerId) : null;
  try {
    if (!customerId && nsId) {
      const { data } = await service.from('customers').select('id').eq('netsuite_id', nsId).maybeSingle();
      customerId = data?.id || null;
    }
    if (!prospectId && nsId) {
      const { data } = await service.from('prospects').select('id').eq('netsuite_id', nsId).maybeSingle();
      prospectId = data?.id || null;
    }
    if (!prospectId && customerId) {
      const { data: cust } = await service.from('customers').select('netsuite_id').eq('id', customerId).maybeSingle();
      if (cust?.netsuite_id) {
        const { data } = await service.from('prospects').select('id').eq('netsuite_id', cust.netsuite_id).maybeSingle();
        prospectId = data?.id || null;
      }
    }
  } catch { /* return what resolved */ }
  return { customerId, prospectId };
}
