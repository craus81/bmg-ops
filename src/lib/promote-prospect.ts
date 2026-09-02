import type { SupabaseClient } from '@supabase/supabase-js';
import { createCustomerOrLead, suiteqlQuery } from '@/lib/netsuite';
import { safeStringLiteral } from '@/lib/sql-safe';

/**
 * Promotion: the moment a FleetSuite lead becomes a NetSuite customer.
 *
 * Since the lead tier (owner decision 2026-08-30), creating a CRM record no
 * longer creates a NetSuite customer — a record without netsuite_id IS a
 * lead. Promotion happens exactly here, from three places:
 *
 *   - /api/prospects/push-to-netsuite — the record page's explicit
 *     "Promote to NetSuite Customer" button;
 *   - /api/estimates/push — pushing a lead's estimate to NetSuite needs a
 *     real customer, so the push promotes on the way;
 *   - /api/estimates/convert-to-so — same, for the rare estimate converted
 *     without ever being pushed.
 *
 * Kept in one module so the three paths can't drift on what "promoted"
 * writes (netsuite_id + status + the customers-mirror row).
 */

export interface ProspectRow {
  id: string;
  company_name: string;
  contact_name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  website?: string | null;
  record_type?: string | null;
  netsuite_id?: string | null;
}

export interface PromoteResult {
  success: boolean;
  error?: string;
  netsuiteId?: string;
  entityId?: string;
  netsuiteUrl?: string;
  /** customers-mirror row id, for deep links into the estimate builder. */
  localCustomerId?: string | null;
}

/**
 * Create the NetSuite customer for a prospect and record it on both local
 * tables. The caller is responsible for duplicate checks — this function
 * assumes the decision to promote is already made.
 */
export async function promoteProspect(
  supabase: SupabaseClient,
  prospect: ProspectRow,
  opts?: { userId?: string | null; type?: 'customer' | 'lead' | 'prospect' },
): Promise<PromoteResult> {
  if (prospect.netsuite_id) {
    return { success: false, error: 'Already pushed to NetSuite' };
  }
  if (prospect.record_type === 'vendor') {
    return { success: false, error: 'This is a vendor record — vendors are never created in NetSuite as customers' };
  }

  const type = opts?.type || 'customer';
  const result = await createCustomerOrLead({
    companyName: prospect.company_name,
    contactName: prospect.contact_name ?? undefined,
    title: prospect.title ?? undefined,
    email: prospect.email ?? undefined,
    phone: prospect.phone ?? undefined,
    address: prospect.address ?? undefined,
    city: prospect.city ?? undefined,
    state: prospect.state ?? undefined,
    zip: prospect.zip ?? undefined,
    website: prospect.website ?? undefined,
    type,
  });
  if (!result.success) {
    return { success: false, error: result.error || 'Failed to create in NetSuite' };
  }

  // Status is set here (not by the caller) so every promotion path lands in
  // the same converted state.
  await supabase
    .from('prospects')
    .update({
      netsuite_id: result.customerId,
      netsuite_type: type,
      netsuite_url: result.netsuiteUrl,
      status: 'converted',
      converted_customer_id: result.customerId,
      pushed_at: new Date().toISOString(),
      pushed_by: opts?.userId || null,
    })
    .eq('id', prospect.id);

  // Mirror into the local customers table (same shape as the customer sync)
  // so the new customer is immediately linkable — the estimate builder's
  // customer search reads this table, and waiting on the next NetSuite sync
  // left just-entered clients unpickable.
  const addressLine = [
    prospect.address,
    [prospect.city, prospect.state].filter(Boolean).join(', '),
    prospect.zip,
  ].filter(Boolean).join(', ');
  const { data: local, error: upsertErr } = await supabase
    .from('customers')
    .upsert({
      netsuite_id: result.customerId,
      netsuite_url: result.netsuiteUrl || null,
      company_name: prospect.company_name,
      entity_id: result.entityId || '',
      email: prospect.email || null,
      phone: prospect.phone || null,
      address: addressLine || null,
      active: true,
    }, { onConflict: 'netsuite_id' })
    .select('id')
    .single();
  if (upsertErr) {
    // The NetSuite record exists — don't fail the promotion; the next
    // customer sync heals the local mirror.
    console.error('promoteProspect local customer upsert failed:', upsertErr.message);
  }

  return {
    success: true,
    netsuiteId: result.customerId,
    entityId: result.entityId,
    netsuiteUrl: result.netsuiteUrl,
    localCustomerId: local?.id || null,
  };
}

/**
 * Resolve an estimate to a NetSuite customer id, promoting the lead it was
 * quoted for when that's what it refers to.
 *
 * `prospectId` (estimates.prospect_id, migration 251) is the reliable path:
 * the builder recorded exactly which lead this estimate is for, so there is
 * nothing to guess. The name path below is the fallback for estimates
 * written before that column existed — and it's why the column exists, since
 * matching on name gives up whenever the name was edited on the estimate or
 * two leads share one.
 *
 * Order matters: (1) the linked lead, if it still needs promoting;
 * (2) an existing NetSuite customer with exactly this name — never create a
 * double; (3) exactly one non-vendor lead with this name — promote it;
 * (4) null, and the caller keeps its "pick a customer" error. Ambiguity (two
 * same-named leads) also returns null: silently promoting one of them would
 * guess at money-bearing linkage.
 */
export async function resolveOrPromoteByName(
  supabase: SupabaseClient,
  customerName: string,
  userId?: string | null,
  prospectId?: string | null,
): Promise<{ netsuiteId: string; promoted: boolean } | null> {
  const name = (customerName || '').trim();

  // The estimate names its own lead — no name matching needed. A lead that
  // was promoted since (netsuite_id already set) resolves straight to it.
  if (prospectId) {
    const { data: linked } = await supabase
      .from('prospects')
      .select('id, company_name, contact_name, title, email, phone, address, city, state, zip, website, record_type, netsuite_id')
      .eq('id', prospectId)
      .maybeSingle();
    if (linked?.netsuite_id) {
      return { netsuiteId: String(linked.netsuite_id), promoted: false };
    }
    if (linked && linked.record_type !== 'vendor') {
      const promoted = await promoteProspect(supabase, linked as ProspectRow, { userId });
      if (promoted.success && promoted.netsuiteId) {
        return { netsuiteId: promoted.netsuiteId, promoted: true };
      }
      // A failed promote falls through to the name paths rather than
      // stopping: an existing NetSuite customer with this name is still a
      // legitimate answer, and the caller's error is the same either way.
    }
  }

  if (!name) return null;

  try {
    const safeName = safeStringLiteral(name, 200);
    const existing = await suiteqlQuery(
      `SELECT c.id FROM customer c WHERE UPPER(c.companyname) = UPPER('${safeName}') FETCH FIRST 1 ROWS ONLY`,
    );
    if (existing?.items?.[0]?.id) {
      return { netsuiteId: existing.items[0].id.toString(), promoted: false };
    }
  } catch { /* lookup failed — fall through to the lead path */ }

  // ilike with wildcards escaped — this is an exact (case-insensitive)
  // name match, not a pattern search; a '%' in a company name must not
  // widen it onto some other lead.
  const exact = name.replace(/([%_\\])/g, '\\$1');
  const { data: leads } = await supabase
    .from('prospects')
    .select('id, company_name, contact_name, title, email, phone, address, city, state, zip, website, record_type, netsuite_id')
    .ilike('company_name', exact)
    .is('netsuite_id', null)
    .neq('record_type', 'vendor')
    .limit(2);
  if (!leads || leads.length !== 1) return null;

  const promoted = await promoteProspect(supabase, leads[0] as ProspectRow, { userId });
  if (!promoted.success || !promoted.netsuiteId) return null;
  return { netsuiteId: promoted.netsuiteId, promoted: true };
}
