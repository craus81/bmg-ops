import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { setPrimaryContact } from '@/lib/primary-contact';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  /** prospect_contacts.id — the CRM contact being promoted. */
  contactId: z.string().uuid(),
  /** external_contacts.id to sync onto, when the caller already knows the
   *  pairing (re-syncing the current primary after its email/phone changed).
   *  Ignored unless it belongs to this customer. */
  externalContactId: z.string().uuid().optional(),
});

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * POST /api/prospects/contacts/primary
 *
 * Makes one CRM contact the customer's primary contact — the person
 * estimate approvals, pickup notices, proof approvals and SMS threads go
 * to. The flag itself lives on external_contacts (see src/lib/primary-
 * contact.ts); this route resolves the customer, then promotes.
 *
 * Body: { contactId }  →  { success, externalContactId, created }
 *
 * The customer is resolved server-side from the contact's own prospect, so
 * a caller can't point a promotion at someone else's customer row.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const supabase = getSupabase();
  const { data: contact } = await supabase
    .from('prospect_contacts')
    .select('id, name, title, email, phone, prospect_id')
    .eq('id', parsed.data.contactId)
    .maybeSingle();
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

  const { data: prospect } = await supabase
    .from('prospects')
    .select('id, netsuite_id')
    .eq('id', contact.prospect_id)
    .maybeSingle();
  // external_contacts.customer_id references the synced customers table, so
  // a lead that isn't a NetSuite customer yet has nowhere to hold a primary.
  // Say that plainly instead of failing on a foreign key.
  if (!prospect?.netsuite_id) {
    return NextResponse.json({
      error: 'This record is still a lead. Promote it to a NetSuite customer first — the primary contact is stored against the customer.',
    }, { status: 409 });
  }

  const { data: customer } = await supabase
    .from('customers')
    .select('id')
    .eq('netsuite_id', prospect.netsuite_id)
    .maybeSingle();
  if (!customer) {
    return NextResponse.json({
      error: 'No synced customer record for this NetSuite customer yet — it appears after the next customer sync.',
    }, { status: 409 });
  }

  const result = await setPrimaryContact(supabase, customer.id, contact, {
    targetId: parsed.data.externalContactId || null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({
    success: true,
    externalContactId: result.externalContactId,
    created: result.created,
  });
}
