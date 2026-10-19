import type { SupabaseClient } from '@supabase/supabase-js';
import { createContact, updateContact } from '@/lib/netsuite';

export interface NetsuiteContactPush { pushed: boolean; error: string | null }

/**
 * Push a saved `prospect_contacts` row to NetSuite as a Contact on the
 * customer — the same thing the record page's Contacts card has always done.
 * Best effort: the local save is authoritative and a NetSuite refusal
 * (usually a missing Lists > Contacts permission, or a one-word name where
 * the account wants a last name) comes back as `error`, never thrown.
 *
 * Links a newly created NetSuite contact back onto the row, so later edits
 * PATCH the same contact instead of making another.
 */
export async function pushProspectContactToNetsuite(
  supabase: SupabaseClient,
  netsuiteCustomerId: string,
  contact: { id: string; name: string; title?: string | null; email?: string | null; phone?: string | null; netsuite_contact_id?: string | null },
): Promise<NetsuiteContactPush> {
  const [firstName, ...rest] = contact.name.trim().split(/\s+/);
  const nsFields = {
    firstName,
    lastName: rest.join(' ') || undefined,
    email: contact.email || undefined,
    phone: contact.phone || undefined,
    title: contact.title || undefined,
  };
  if (contact.netsuite_contact_id) {
    const r = await updateContact(String(contact.netsuite_contact_id), nsFields);
    return { pushed: r.success, error: r.error || null };
  }
  const r = await createContact({ companyId: netsuiteCustomerId, ...nsFields });
  if (r.success && r.internalId) {
    await supabase.from('prospect_contacts').update({ netsuite_contact_id: r.internalId }).eq('id', contact.id);
    contact.netsuite_contact_id = r.internalId;
  }
  return { pushed: r.success, error: r.error || null };
}
