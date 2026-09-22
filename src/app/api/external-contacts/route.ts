import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { samePerson } from '@/lib/primary-contact';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CreateSchema = z
  .object({
    customerId: z.string().uuid().optional().nullable(),
    name: z.string().trim().max(120).optional().nullable(),
    phone: z.string().max(40).optional().nullable(),
    email: z.string().email().max(254).optional().nullable(),
    title: z.string().max(120).optional().nullable(),
    is_primary: z.boolean().optional(),
    // Matches the DB CHECK (078): 'both'/'none' were accepted here but always
    // failed the constraint with a 500.
    channel_pref: z.enum(['email', 'sms', 'phone']).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  })
  .refine((d) => !!(d.name || d.phone || d.email), {
    message: 'name, phone, or email required',
    path: ['name'],
  });

/**
 * The company's people, as every compose screen should see them.
 *
 * A customer's contacts live in TWO tables and always have:
 *
 *   - `external_contacts` (migration 078) — keyed to customers.id. Who
 *     notifications actually go to, and where `is_primary` lives. Populated
 *     only IMPLICITLY: the first outbound send, an inbound text, or an
 *     explicit "make primary" promote (src/lib/primary-contact.ts).
 *   - `prospect_contacts` — keyed to prospects.id. What staff type into the
 *     record page's Contacts card, and what the NetSuite contact sync writes
 *     (/api/netsuite/contacts/sync fills this table and only this one).
 *
 * So an account whose contacts came from NetSuite, or were typed on the
 * record page and never emailed, had NOTHING in external_contacts — and the
 * estimate compose screen's "Add a company contact" dropdown came up empty
 * while the record plainly showed people. That was the field bug.
 *
 * The two records are the same company under two ids, joined by the NetSuite
 * customer id the mirror row carries (see src/lib/promote-prospect.ts). This
 * reads both and returns one deduped list; `samePerson` decides what is a
 * duplicate, the same rule the promote path uses, so the two halves can't
 * disagree about who is already here.
 */
async function crmContactsForCustomer(customerId: string): Promise<any[]> {
  const { data: customer } = await supabase
    .from('customers')
    .select('netsuite_id')
    .eq('id', customerId)
    .maybeSingle();
  if (!customer?.netsuite_id) return [];

  const { data: prospect } = await supabase
    .from('prospects')
    .select('id')
    .eq('netsuite_id', customer.netsuite_id)
    .maybeSingle();
  if (!prospect?.id) return [];

  const { data } = await supabase
    .from('prospect_contacts')
    .select('id, name, title, email, phone, is_decision_maker')
    .eq('prospect_id', prospect.id)
    .order('is_decision_maker', { ascending: false })
    .order('name')
    .order('id')
    .limit(200);
  return data || [];
}

/**
 * GET /api/external-contacts?customerId=...&q=...
 *
 * With `customerId`, returns the customer's external contacts AND the CRM
 * contacts for the same company (see above), deduped. Every row carries
 * `source`: 'external' rows are real external_contacts (they have a usable
 * `id` for the [id] route); 'crm' rows are read-only here — their `id` is a
 * prospect_contacts id, so callers that edit must not PATCH them blind.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const customerId = url.searchParams.get('customerId');
  const q = url.searchParams.get('q');

  let query = supabase
    .from('external_contacts')
    .select('*')
    .order('is_primary', { ascending: false })
    .order('name', { ascending: true })
    .limit(200);
  if (customerId) query = query.eq('customer_id', customerId);
  if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const external = (data || []).map((c: any) => ({ ...c, source: 'external' as const }));
  if (!customerId) return NextResponse.json({ contacts: external });

  // CRM half. A failure here never fails the request — the dropdown showing
  // the external contacts alone is the old behavior, not a broken screen.
  let crm: any[] = [];
  try {
    crm = await crmContactsForCustomer(customerId);
  } catch { /* fall through with the external half */ }

  const needle = (q || '').trim().toLowerCase();
  const matchesQ = (c: any) => !needle
    || [c.name, c.email, c.phone].some(v => String(v || '').toLowerCase().includes(needle));

  const merged = [...external];
  for (const c of crm) {
    if (!matchesQ(c)) continue;
    if (merged.some(e => samePerson(e, c))) continue;
    merged.push({
      id: c.id,
      customer_id: customerId,
      name: c.name || null,
      title: c.title || null,
      email: c.email || null,
      phone: c.phone || null,
      // A CRM contact is never the notification primary — that flag only
      // means anything on external_contacts, and claiming it here would put
      // a "(primary)" badge on somebody nothing actually sends to.
      is_primary: false,
      is_decision_maker: !!c.is_decision_maker,
      source: 'crm' as const,
    });
  }

  return NextResponse.json({ contacts: merged });
}

/**
 * POST /api/external-contacts
 * Body: { customerId?, name, phone?, email?, title?, is_primary?, channel_pref?, notes? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, CreateSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  // If this contact is being marked as primary for a customer, clear
  // any existing primary flag for that customer first.
  if (body.is_primary && body.customerId) {
    await supabase
      .from('external_contacts')
      .update({ is_primary: false })
      .eq('customer_id', body.customerId);
  }

  const insert = {
    customer_id: body.customerId || null,
    name: body.name || null,
    phone: body.phone || null,
    email: body.email || null,
    title: body.title || null,
    is_primary: body.is_primary === true,
    channel_pref: body.channel_pref || null,
    notes: body.notes || null,
    is_unknown: false,
    created_by: auth.user.id,
  };

  const { data, error } = await supabase.from('external_contacts').insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ contact: data });
}
