import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Who an estimate's customer email goes to when the sender hasn't typed a
 * recipient — resolved the same way by every estimate email flow
 * (send-for-approval, email-pdf, the quote follow-up).
 *
 * An estimate belongs to ONE of two sides, and both have to work:
 *
 *   - a NetSuite customer (customer_id) → its primary external contact,
 *     then the synced customer email;
 *   - a CRM lead (prospect_id, migration 251) → the lead's decision-maker
 *     contact, then any contact with an email, then the record's own email.
 *
 * The lead half is why this exists. Every flow used to resolve through
 * customer_id alone, so an estimate quoted for a brand-new customer — the
 * whole point of "Create + Start Estimate" — opened its compose screen with
 * an empty To and no hint why.
 */

export interface EstimateRecipientSource {
  customer_id?: string | null;
  prospect_id?: string | null;
}

/**
 * First usable email address for the estimate's customer, or null when the
 * record genuinely has none on file. Callers treat null as "make the sender
 * type one" — never as a reason to fail silently.
 */
export async function resolveEstimateEmail(
  supabase: SupabaseClient<any, any, any>,
  estimate: EstimateRecipientSource,
): Promise<string | null> {
  if (estimate.customer_id) {
    const { data: primary } = await supabase
      .from('external_contacts')
      .select('email')
      .eq('customer_id', estimate.customer_id)
      .eq('is_primary', true)
      .maybeSingle();
    if (primary?.email) return primary.email;

    const { data: customer } = await supabase
      .from('customers')
      .select('email')
      .eq('id', estimate.customer_id)
      .maybeSingle();
    if (customer?.email) return customer.email;
  }

  if (estimate.prospect_id) {
    // Decision-maker first — on a lead that's the person who signs off,
    // which is exactly who an approval link is for. Ordered by id so two
    // decision-makers resolve the same way on every send.
    const { data: contacts } = await supabase
      .from('prospect_contacts')
      .select('email, is_decision_maker')
      .eq('prospect_id', estimate.prospect_id)
      .not('email', 'is', null)
      .order('is_decision_maker', { ascending: false })
      .order('id');
    const contactEmail = (contacts || []).find((c: any) => c.email?.trim())?.email;
    if (contactEmail) return contactEmail;

    const { data: lead } = await supabase
      .from('prospects')
      .select('email')
      .eq('id', estimate.prospect_id)
      .maybeSingle();
    if (lead?.email) return lead.email;
  }

  return null;
}

/** Phone for the SMS half of the approval send, same two-sided lookup. */
export async function resolveEstimatePhone(
  supabase: SupabaseClient<any, any, any>,
  estimate: EstimateRecipientSource,
): Promise<string | null> {
  if (estimate.customer_id) {
    const { data: primary } = await supabase
      .from('external_contacts')
      .select('phone')
      .eq('customer_id', estimate.customer_id)
      .eq('is_primary', true)
      .maybeSingle();
    if (primary?.phone) return primary.phone;

    const { data: customer } = await supabase
      .from('customers')
      .select('phone')
      .eq('id', estimate.customer_id)
      .maybeSingle();
    if (customer?.phone) return customer.phone;
  }

  if (estimate.prospect_id) {
    const { data: contacts } = await supabase
      .from('prospect_contacts')
      .select('phone, is_decision_maker')
      .eq('prospect_id', estimate.prospect_id)
      .not('phone', 'is', null)
      .order('is_decision_maker', { ascending: false })
      .order('id');
    const contactPhone = (contacts || []).find((c: any) => c.phone?.trim())?.phone;
    if (contactPhone) return contactPhone;

    const { data: lead } = await supabase
      .from('prospects')
      .select('phone')
      .eq('id', estimate.prospect_id)
      .maybeSingle();
    if (lead?.phone) return lead.phone;
  }

  return null;
}
