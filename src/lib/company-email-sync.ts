/**
 * The company email follows the customer's PRIMARY contact.
 *
 * Owner ask 2026-10-23: the Company info email on the customer page should
 * be the starred (primary) contact's email and change when the star moves.
 * That field is the NetSuite customer's own Email — the 2-hourly
 * netsuite-sync overwrites customers.email and prospects.email from it — so
 * a FleetSuite-only write would quietly revert. Same rule as the prospects
 * PUT (owner decision 2026-09-21): push to NetSuite FIRST, write the local
 * copies only once NetSuite took it, and report a refusal plainly.
 *
 * A primary with no email, or clearing the primary, leaves the company email
 * alone: nobody asked for it to be blanked.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { updateCustomer as nsUpdateCustomer } from '@/lib/netsuite';

export type CompanyEmailResult =
  | { status: 'updated'; email: string }
  | { status: 'unchanged' | 'no_email' | 'not_linked' }
  | { status: 'failed'; error: string };

const norm = (e: string | null | undefined) => (e || '').trim().toLowerCase();

/** The email the company should switch to, or null when nothing changes. */
export function companyEmailChange(current: string | null | undefined, primaryEmail: string | null | undefined): string | null {
  const next = (primaryEmail || '').trim();
  if (!next) return null;
  return norm(current) === norm(next) ? null : next;
}

/**
 * Point the customer's company email at `primaryEmail`.
 *
 * `customerId` is the synced customers.id (what external_contacts hangs off).
 * Caller passes a service-role client.
 */
export async function syncCompanyEmailToPrimary(
  service: SupabaseClient,
  customerId: string,
  primaryEmail: string | null | undefined,
  deps: { updateCustomer?: typeof nsUpdateCustomer } = {},
): Promise<CompanyEmailResult> {
  if (!(primaryEmail || '').trim()) return { status: 'no_email' };

  const { data: customer, error: readErr } = await service
    .from('customers')
    .select('id, netsuite_id, email')
    .eq('id', customerId)
    .maybeSingle();
  if (readErr) return { status: 'failed', error: readErr.message };
  if (!customer?.netsuite_id) return { status: 'not_linked' };

  const next = companyEmailChange(customer.email, primaryEmail);
  if (!next) return { status: 'unchanged' };

  const push = deps.updateCustomer || nsUpdateCustomer;
  const pushed = await push(String(customer.netsuite_id), { email: next });
  if (!pushed.success) return { status: 'failed', error: pushed.error || 'NetSuite refused the change' };

  // NetSuite has the truth now; these just stop the page contradicting it
  // until the next sync, which reads back the same value.
  const { error: cErr } = await service.from('customers').update({ email: next }).eq('id', customer.id);
  if (cErr) console.error('company email: customers update failed:', cErr.message);
  const { error: pErr } = await service.from('prospects').update({ email: next }).eq('netsuite_id', String(customer.netsuite_id));
  if (pErr) console.error('company email: prospects update failed:', pErr.message);

  return { status: 'updated', email: next };
}
