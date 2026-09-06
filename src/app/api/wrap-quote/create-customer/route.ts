import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { createCustomerOrLead } from '@/lib/netsuite';
import { validateBody, z } from '@/lib/validate';
import { findCustomerDuplicates, describeMatch } from '@/lib/customer-dupes';

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
  /** Skip the duplicate guard — set only after a human saw the matches. */
  force: z.boolean().optional().default(false),
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

  // Don't create a NetSuite double when the customer already exists —
  // previously an exact-name ilike on customers only; now the shared
  // checker (name + email + phone digits, prospects AND customers).
  //
  // Only a NAME match hard-blocks: this route's callers (check-in, PO
  // forms, graphics invoice review, upfit designer) have no "create
  // anyway" UI, and a shared phone/email under a different name is a real
  // pattern (franchises, shared AP lines) — those surface as a warning on
  // the created record instead. The 409 keeps `existingCustomerId` (first
  // customers-table match) so the existing link-the-existing-record flows
  // keep working; `matches` carries the full picture.
  let contactWarning: string | null = null;
  if (!p.force) {
    const matches = await findCustomerDuplicates(supabase, {
      companyName: p.companyName, email: p.email, phone: p.phone,
    });
    const nameMatches = matches.filter(m => m.matchedOn.includes('name'));
    if (nameMatches.length > 0) {
      const customerMatch = nameMatches.find(m => m.source === 'customers');
      return NextResponse.json({
        error: customerMatch
          ? `"${customerMatch.company_name}" already exists in NetSuite — pick it from the customer search instead.`
          : `"${nameMatches[0].company_name}" already exists in the CRM (no NetSuite record yet) — open it under Customers and use Add to NetSuite instead of creating a second record.`,
        existingCustomerId: customerMatch?.id || null,
        matches,
      }, { status: 409 });
    }
    if (matches.length > 0) {
      contactWarning = `Heads up: ${describeMatch(matches[0])} already exists — check it isn't the same company.`;
    }
  }

  const result = await createCustomerOrLead({ ...p, type: 'customer' });
  if (!result.success) {
    return NextResponse.json({ error: result.error || 'NetSuite customer create failed' }, { status: 502 });
  }
  if (!result.customerId) {
    // The customer EXISTS in NetSuite — the create succeeded but its id
    // could not be read, and the in-lib name-lookup recovery also failed.
    // This used to report a plain "create failed", the textbook
    // retry-to-duplicate invitation (Round 3, §7.2.4). Say what actually
    // happened and steer away from the retry.
    return NextResponse.json({
      error: 'NetSuite created the customer but did not return its id. Do NOT create it again — pick it from the customer search after the next sync (within ~2 hours), or find it in NetSuite directly.',
      mayExist: true,
    }, { status: 502 });
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
    warning: contactWarning,
  });
}
