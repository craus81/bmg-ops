import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { normalizeEmail, unknownRecipients } from '@/lib/new-recipients';
import { pushProspectContactToNetsuite, type NetsuiteContactPush } from '@/lib/prospect-contact-netsuite';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * "These addresses aren't on the customer yet — add them?" (owner ask,
 * 2026-10-19). The estimate compose screens call GET right after a send to
 * learn which recipients the record doesn't know, and POST when the sender
 * says Save.
 *
 * An estimate names its customer one of two ways: `customerId` (the
 * NetSuite-mirror customers row) or, for a lead nobody has pushed yet,
 * `prospectId` alone. Either resolves to the CRM record (prospects) the
 * Contacts card shows, joined by netsuite_id exactly as
 * /api/external-contacts does.
 */
async function resolveRecord(customerId: string | null, prospectId: string | null) {
  let customer: any = null;
  let prospect: any = null;
  if (customerId) {
    const { data } = await supabase
      .from('customers')
      .select('id, netsuite_id, company_name, email, billing_contact_email, ap_email')
      .eq('id', customerId)
      .maybeSingle();
    customer = data;
  }
  if (prospectId) {
    const { data } = await supabase
      .from('prospects')
      .select('id, netsuite_id, company_name, email, billing_emails')
      .eq('id', prospectId)
      .maybeSingle();
    prospect = data;
  } else if (customer?.netsuite_id) {
    const { data } = await supabase
      .from('prospects')
      .select('id, netsuite_id, company_name, email, billing_emails')
      .eq('netsuite_id', customer.netsuite_id)
      .maybeSingle();
    prospect = data;
  }
  return { customer, prospect };
}

/** Every address the record already carries, wherever it lives. */
async function addressesOnFile(customer: any, prospect: any): Promise<string[]> {
  const known: string[] = [];
  if (customer) {
    known.push(customer.email, customer.billing_contact_email, customer.ap_email);
    const { data } = await supabase
      .from('external_contacts')
      .select('email')
      .eq('customer_id', customer.id)
      .not('email', 'is', null)
      .limit(500);
    for (const r of data || []) known.push(r.email);
  }
  if (prospect) {
    known.push(prospect.email, ...(prospect.billing_emails || []));
    const { data } = await supabase
      .from('prospect_contacts')
      .select('email')
      .eq('prospect_id', prospect.id)
      .not('email', 'is', null)
      .limit(500);
    for (const r of data || []) known.push(r.email);
  }
  return known.filter(Boolean);
}

/**
 * GET /api/customer-contacts?customerId=&prospectId=&emails=a@x.com,b@y.com
 * → { unknown: string[], customerName, canSave }
 *
 * `unknown` is the sent-to addresses the record doesn't have (BMG's own
 * addresses never count). `canSave` is false when the estimate has no
 * customer record to save onto (a name typed with no customer picked).
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const sp = req.nextUrl.searchParams;
  const customerId = sp.get('customerId') || null;
  const prospectId = sp.get('prospectId') || null;
  if (customerId && !UUID.test(customerId)) return NextResponse.json({ error: 'Invalid customerId' }, { status: 400 });
  if (prospectId && !UUID.test(prospectId)) return NextResponse.json({ error: 'Invalid prospectId' }, { status: 400 });
  const emails = (sp.get('emails') || '').split(',').map(normalizeEmail).filter(Boolean).slice(0, 25);

  const { customer, prospect } = await resolveRecord(customerId, prospectId);
  if (!customer && !prospect) return NextResponse.json({ unknown: [], customerName: null, canSave: false });

  const unknown = unknownRecipients(emails, await addressesOnFile(customer, prospect));
  return NextResponse.json({
    unknown,
    customerName: prospect?.company_name || customer?.company_name || null,
    canSave: true,
  });
}

const SaveSchema = z.object({
  customerId: z.string().uuid().optional().nullable(),
  prospectId: z.string().uuid().optional().nullable(),
  contacts: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    title: z.string().trim().max(120).optional().nullable(),
  })).min(1).max(25),
});

type SaveResult = {
  email: string;
  saved: boolean;
  /** Why it wasn't saved, in words for the sender. */
  error?: string;
  netsuite?: NetsuiteContactPush;
};

/**
 * POST /api/customer-contacts
 * Body: { customerId?, prospectId?, contacts: [{ name, email, title? }] }
 *
 * Saves each as a contact on the customer record — the same Contacts card
 * the record page shows, and pushed to NetSuite as a Contact the way that
 * card's Add does. A record with no CRM half (a mirror customer nobody ever
 * opened in the CRM) gets an external_contacts row instead, which the
 * compose dropdown reads just the same.
 *
 * Never overwrites someone: a contact already on the record under the same
 * name with a DIFFERENT email is left alone and reported, so a guessed name
 * can't silently re-point an existing person's address.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, SaveSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { customer, prospect } = await resolveRecord(body.customerId || null, body.prospectId || null);
  if (!customer && !prospect) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  const results: SaveResult[] = [];
  for (const c of body.contacts) {
    const email = normalizeEmail(c.email);
    const name = c.name.trim();
    const title = c.title?.trim() || null;

    if (prospect) {
      const { data: sameName } = await supabase
        .from('prospect_contacts')
        .select('id, name, email, phone, title, netsuite_contact_id')
        .eq('prospect_id', prospect.id)
        .ilike('name', name.replace(/[%_\\]/g, m => `\\${m}`))
        .limit(1)
        .maybeSingle();

      let row: any;
      if (sameName) {
        if (sameName.email && normalizeEmail(sameName.email) !== email) {
          results.push({ email, saved: false, error: `${sameName.name} is already on the record as ${sameName.email}` });
          continue;
        }
        const { data, error } = await supabase
          .from('prospect_contacts')
          .update({ email, title: sameName.title || title })
          .eq('id', sameName.id)
          .select()
          .single();
        if (error || !data) { results.push({ email, saved: false, error: error?.message || 'Save failed' }); continue; }
        row = data;
      } else {
        const { data, error } = await supabase
          .from('prospect_contacts')
          .insert({ prospect_id: prospect.id, name, email, title, is_decision_maker: false })
          .select()
          .single();
        if (error || !data) { results.push({ email, saved: false, error: error?.message || 'Save failed' }); continue; }
        row = data;
      }

      const netsuite = prospect.netsuite_id
        ? await pushProspectContactToNetsuite(supabase, String(prospect.netsuite_id), row)
        : undefined;
      results.push({ email, saved: true, netsuite });
      continue;
    }

    const { error } = await supabase.from('external_contacts').insert({
      customer_id: customer.id,
      name,
      email,
      title,
      is_primary: false,
      is_unknown: false,
      created_by: auth.user.id,
    });
    results.push(error ? { email, saved: false, error: error.message } : { email, saved: true });
  }

  return NextResponse.json({ results });
}
