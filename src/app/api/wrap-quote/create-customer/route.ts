import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { createCustomerOrLead } from '@/lib/netsuite';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  companyName: z.string().trim().min(1).max(200),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(60).optional(),
  zip: z.string().trim().max(20).optional(),
});

/**
 * POST /api/wrap-quote/create-customer
 *
 * Creates a NetSuite Customer from the wrap-quote screen's customer form and
 * mirrors it into the local `customers` table so the quote can link to it
 * immediately (the NetSuite estimate push resolves customers.netsuite_id
 * from that link). Returns the local customers.id to set as the quote's
 * customerId.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;

  // Don't create a NetSuite double when the name already exists locally —
  // the local table mirrors NetSuite, so a hit here means the customer is a
  // search-pick away.
  const escaped = p.companyName.replace(/[\\%_]/g, '\\$&');
  const { data: existing } = await supabase
    .from('customers')
    .select('id, company_name, netsuite_id')
    .ilike('company_name', escaped)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({
      error: `"${existing.company_name}" already exists in NetSuite — pick it from the customer search instead.`,
      existingCustomerId: existing.id,
    }, { status: 409 });
  }

  const result = await createCustomerOrLead({ ...p, type: 'customer' });
  if (!result.success || !result.customerId) {
    return NextResponse.json({ error: result.error || 'NetSuite customer create failed' }, { status: 502 });
  }

  // Mirror into the local customers table (same shape as the customer sync)
  // so wrap-quote's NetSuite estimate push can resolve netsuite_id.
  const addressLine = [
    p.address,
    [p.city, p.state].filter(Boolean).join(', '),
    p.zip,
  ].filter(Boolean).join(', ');
  const { data: local, error: upsertErr } = await supabase
    .from('customers')
    .upsert({
      netsuite_id: result.customerId,
      netsuite_url: result.netsuiteUrl || null,
      company_name: p.companyName,
      entity_id: result.entityId || '',
      email: p.email || null,
      phone: p.phone || null,
      address: addressLine || null,
      active: true,
    }, { onConflict: 'netsuite_id' })
    .select('id')
    .single();
  if (upsertErr) {
    // The NetSuite record exists — surface the id so the user isn't stuck,
    // but flag that the local mirror failed (a customer sync will heal it).
    console.error('create-customer local upsert failed:', upsertErr.message);
  }

  return NextResponse.json({
    success: true,
    customerId: local?.id || null,
    netsuiteId: result.customerId,
    entityId: result.entityId || null,
    netsuiteUrl: result.netsuiteUrl || null,
  });
}
