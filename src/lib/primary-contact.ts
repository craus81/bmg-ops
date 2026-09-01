/**
 * The customer's PRIMARY contact — who estimate approvals, pickup notices,
 * proof approvals and SMS threads actually go to.
 *
 * That flag lives on `external_contacts.is_primary` (migration 078, made
 * single-primary by the partial unique index in 188), which is a DIFFERENT
 * table from the `prospect_contacts` rows the customer record's Contacts
 * card lists and creates. Before this file the two never met: staff added
 * contacts in the CRM, external_contacts was only ever populated implicitly
 * by the first outbound send or inbound text, and there was no control
 * anywhere to say "this person is the primary" — a field bug.
 *
 * So: promoting a CRM contact matches it onto the customer's existing
 * external contact when one is the same person (the SMS-created row, say)
 * and creates one when none is, then demotes the siblings. external_contacts
 * stays the single source of truth every notification path already reads.
 *
 * `samePerson` is pure and used on BOTH sides — the server to find the row
 * to promote, the client to know which contact row wears the star — so the
 * two can't disagree about who is already primary.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ContactLike {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

const emailKey = (e: string | null | undefined) => (e || '').trim().toLowerCase();
/** Last 10 digits — '(574) 555-0100', '5745550100' and '+15745550100' all
 *  describe the same person, and CRM/SMS rows never agree on formatting. */
const phoneKey = (p: string | null | undefined) => {
  const d = (p || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};
const nameKey = (n: string | null | undefined) => (n || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Are these two contact records the same person?
 *
 * Strongest shared identifier wins: when both carry an email it decides
 * alone (two people at one company share a phone far more often than an
 * address), then phone, then name. No shared identifier at all → not a
 * match, so a promote creates a new external contact rather than silently
 * retargeting someone else's notifications.
 */
export function samePerson(a: ContactLike, b: ContactLike): boolean {
  const ae = emailKey(a.email), be = emailKey(b.email);
  if (ae && be) return ae === be;
  const ap = phoneKey(a.phone), bp = phoneKey(b.phone);
  if (ap && bp) return ap === bp;
  const an = nameKey(a.name), bn = nameKey(b.name);
  return !!an && an === bn;
}

export interface CrmContact extends ContactLike {
  name: string;
  title?: string | null;
}

export type SetPrimaryResult =
  | { ok: true; externalContactId: string; created: boolean }
  | { ok: false; status: number; error: string };

/**
 * Make `contact` the customer's primary contact.
 *
 * Caller passes a service-role client (the demotion sweep has to see every
 * sibling regardless of RLS). Demotion runs BEFORE the promotion so the
 * single-primary unique index never sees two.
 */
export async function setPrimaryContact(
  service: SupabaseClient,
  customerId: string,
  contact: CrmContact,
  opts: { targetId?: string | null } = {},
): Promise<SetPrimaryResult> {
  const { data: existing, error: readErr } = await service
    .from('external_contacts')
    .select('id, name, title, email, phone')
    .eq('customer_id', customerId);
  if (readErr) return { ok: false, status: 500, error: readErr.message };

  // `targetId` names the row to sync onto outright. Callers pass it when they
  // already know the pairing and the identifiers are about to stop agreeing —
  // editing the primary's email would otherwise fail samePerson and fork a
  // second external contact, silently leaving notifications on the old one.
  const match = (opts.targetId && (existing || []).find(e => e.id === opts.targetId))
    || (existing || []).find(e => samePerson(e, contact))
    || null;
  const now = new Date().toISOString();

  // Demote every sibling first — including rows that are already false, which
  // costs one statement and keeps the index invariant true at all times.
  const demote = service.from('external_contacts')
    .update({ is_primary: false, updated_at: now })
    .eq('customer_id', customerId);
  const { error: demoteErr } = await (match ? demote.neq('id', match.id) : demote);
  if (demoteErr) return { ok: false, status: 500, error: demoteErr.message };

  if (match) {
    // The CRM row is what the person promoting is looking at, so it wins —
    // but only where it actually says something. A phone learned from an
    // inbound text is not thrown away because the CRM card has no phone.
    const { error } = await service.from('external_contacts')
      .update({
        name: contact.name || match.name,
        title: contact.title || match.title,
        email: contact.email || match.email,
        phone: contact.phone || match.phone,
        is_primary: true,
        updated_at: now,
      })
      .eq('id', match.id);
    if (error) return { ok: false, status: 500, error: error.message };
    return { ok: true, externalContactId: match.id, created: false };
  }

  const { data: created, error } = await service.from('external_contacts')
    .insert({
      customer_id: customerId,
      name: contact.name,
      title: contact.title || null,
      email: contact.email || null,
      phone: contact.phone || null,
      is_primary: true,
    })
    .select('id')
    .single();
  if (error || !created) return { ok: false, status: 500, error: error?.message || 'Could not create the contact' };
  return { ok: true, externalContactId: created.id, created: true };
}
