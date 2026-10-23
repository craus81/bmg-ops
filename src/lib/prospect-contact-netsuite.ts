import type { SupabaseClient } from '@supabase/supabase-js';
import { createContact, updateContact, suiteqlQuery } from '@/lib/netsuite';

export interface NetsuiteContactPush { pushed: boolean; error: string | null }

interface NetsuiteContactMatch { id: string; companyId: string | null; companyName: string | null; names: string[] }

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const sqlText = (s: string) => norm(s).replace(/'/g, "''");

/**
 * Find NetSuite contacts whose name matches any of `names` (case-insensitive,
 * first + last or the entity id). Returns [] when the lookup itself fails —
 * the caller then falls back to a create, as before this lookup existed.
 */
export async function findNetsuiteContactsByName(names: string[]): Promise<NetsuiteContactMatch[]> {
  const wanted = [...new Set(names.map(norm).filter(Boolean))];
  if (!wanted.length) return [];
  const list = wanted.map(n => `'${sqlText(n)}'`).join(', ');
  try {
    const res = await suiteqlQuery(`
      SELECT c.id, c.entityid, c.firstname, c.lastname, c.company, BUILTIN.DF(c.company) AS company_name
      FROM contact c
      WHERE LOWER(TRIM(NVL(c.firstname, '') || ' ' || NVL(c.lastname, ''))) IN (${list})
         OR LOWER(c.entityid) IN (${list})
    `, 50);
    return (res?.items || []).map((r: any) => ({
      id: String(r.id),
      companyId: r.company != null ? String(r.company) : null,
      companyName: r.company_name ? String(r.company_name) : null,
      names: [norm(`${r.firstname || ''} ${r.lastname || ''}`), norm(String(r.entityid || ''))],
    }));
  } catch (err) {
    console.warn('NetSuite contact lookup failed:', err);
    return [];
  }
}

/**
 * Push a saved `prospect_contacts` row to NetSuite as a Contact on the
 * customer — the same thing the record page's Contacts card has always done.
 * Best effort: the local save is authoritative and a NetSuite refusal
 * (usually a missing Lists > Contacts permission, or a one-word name where
 * the account wants a last name) comes back as `error`, never thrown.
 *
 * A row with no stored NetSuite id is NOT assumed to be new: contacts only
 * get their id from the manual contact sync or from a create here, so one
 * added in NetSuite since then would otherwise be re-created and NetSuite
 * refuses ("A contact record with this name already exists"). The contact
 * is looked up on the customer by its previous name, then its current name,
 * and linked + updated when found. Only when nothing matches is one created.
 *
 * Links the NetSuite contact back onto the row, so later edits PATCH the
 * same contact instead of making another.
 */
export async function pushProspectContactToNetsuite(
  supabase: SupabaseClient,
  netsuiteCustomerId: string,
  contact: { id: string; name: string; title?: string | null; email?: string | null; phone?: string | null; netsuite_contact_id?: string | null },
  previousName?: string | null,
): Promise<NetsuiteContactPush> {
  const [firstName, ...rest] = contact.name.trim().split(/\s+/);
  const nsFields = {
    firstName,
    lastName: rest.join(' ') || undefined,
    email: contact.email || undefined,
    phone: contact.phone || undefined,
    title: contact.title || undefined,
  };
  const link = async (internalId: string) => {
    await supabase.from('prospect_contacts').update({ netsuite_contact_id: internalId }).eq('id', contact.id);
    contact.netsuite_contact_id = internalId;
  };

  if (contact.netsuite_contact_id) {
    const r = await updateContact(String(contact.netsuite_contact_id), nsFields);
    return { pushed: r.success, error: r.error || null };
  }

  // Previous name first: on a rename, NetSuite still has the old one.
  const names = [previousName || '', contact.name];
  const matches = await findNetsuiteContactsByName(names);
  const onCustomer = matches.filter(m => m.companyId === String(netsuiteCustomerId));
  if (onCustomer.length) {
    // Prefer the previous-name match so a rename updates the existing
    // contact rather than a different same-named one.
    const prev = previousName ? norm(previousName) : '';
    const pick = (prev && onCustomer.find(m => m.names.includes(prev))) || onCustomer[0];
    await link(pick.id);
    const r = await updateContact(pick.id, nsFields);
    return { pushed: r.success, error: r.error || null };
  }

  const r = await createContact({ companyId: netsuiteCustomerId, ...nsFields });
  if (r.success && r.internalId) await link(r.internalId);
  if (!r.success && /already exists/i.test(r.error || '')) {
    const elsewhere = matches.find(m => m.companyId !== String(netsuiteCustomerId));
    const where = elsewhere?.companyName ? ` on "${elsewhere.companyName}"` : '';
    return {
      pushed: false,
      error: `NetSuite already has a contact named "${contact.name}"${where}, and NetSuite needs every contact name to be unique. Change the name slightly here (for example add the company or a middle initial) and save again.`,
    };
  }
  return { pushed: r.success, error: r.error || null };
}
