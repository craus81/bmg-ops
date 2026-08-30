import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createCustomerOrLead } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { findCustomerDuplicates } from '@/lib/customer-dupes';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  prospectId: z.string().uuid(),
  // Prospects and customers are unified — everything is created as a
  // CUSTOMER. The lead/prospect stages remain accepted for API compat.
  type: z.enum(['customer', 'lead', 'prospect']).optional().default('customer'),
  userId: z.string().uuid().optional().nullable(),
  /** Skip the NetSuite-double guard — the CRM create flow sets this after
   *  its own pre-flight showed the user the matches. */
  force: z.boolean().optional().default(false),
});

/**
 * POST /api/prospects/push-to-netsuite
 * Push a prospect to NetSuite as a Customer or Lead
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { prospectId, type, userId, force } = parsed.data;

  try {

    // Fetch the prospect
    const { data: prospect, error: fetchError } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', prospectId)
      .single();

    if (fetchError || !prospect) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    }

    if (prospect.netsuite_id) {
      return NextResponse.json({ error: 'Already pushed to NetSuite' }, { status: 400 });
    }

    // Vendor records are FleetSuite-only — creating them in NetSuite would
    // make a supplier's rep a NetSuite Customer.
    if (prospect.record_type === 'vendor') {
      return NextResponse.json({ error: 'This is a vendor record — vendors are never created in NetSuite as customers' }, { status: 400 });
    }

    // NetSuite-double guard (audit Stage 1): this route had no duplicate
    // check at all, so any caller that skipped the CRM page's pre-flight
    // created a second NetSuite customer. A same-named row in the local
    // customers mirror means the NetSuite record already exists — block
    // unless the caller already put the matches in front of a human.
    if (!force) {
      const matches = await findCustomerDuplicates(supabase, {
        companyName: prospect.company_name,
        email: prospect.email,
        phone: prospect.phone,
        excludeProspectId: prospectId,
      });
      const nsNameMatch = matches.find(m => m.source === 'customers' && m.matchedOn.includes('name'));
      if (nsNameMatch) {
        return NextResponse.json({
          error: `"${nsNameMatch.company_name}" already exists in NetSuite. Link this record to it instead of creating a double — or retry with force if it truly is a different company.`,
          matches,
        }, { status: 409 });
      }
    }

    // Push to NetSuite
    const result = await createCustomerOrLead({
      companyName: prospect.company_name,
      contactName: prospect.contact_name,
      title: prospect.title,
      email: prospect.email,
      phone: prospect.phone,
      address: prospect.address,
      city: prospect.city,
      state: prospect.state,
      zip: prospect.zip,
      website: prospect.website,
      type,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to create in NetSuite' }, { status: 500 });
    }

    // Update the prospect with NetSuite info. Status is set here (not by the
    // caller) so every create path lands in the same converted state.
    await supabase
      .from('prospects')
      .update({
        netsuite_id: result.customerId,
        netsuite_type: type,
        netsuite_url: result.netsuiteUrl,
        status: 'converted',
        converted_customer_id: result.customerId,
        pushed_at: new Date().toISOString(),
        pushed_by: userId || null,
      })
      .eq('id', prospectId);

    // Mirror into the local customers table (same shape as the customer
    // sync) so the new customer is immediately linkable — the estimate
    // builder's customer search reads this table, and waiting on the next
    // NetSuite sync left just-entered clients unpickable.
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
      // The NetSuite record exists — don't fail the create; the next
      // customer sync heals the local mirror.
      console.error('push-to-netsuite local customer upsert failed:', upsertErr.message);
    }

    return NextResponse.json({
      success: true,
      customerId: result.customerId,
      entityId: result.entityId,
      netsuiteUrl: result.netsuiteUrl,
      localCustomerId: local?.id || null,
    });
  } catch (error: any) {
    console.error('Push to NetSuite error:', error);
    return NextResponse.json(
      { error: 'Failed to push to NetSuite: ' + (error?.message || 'Unknown') },
      { status: 500 }
    );
  }
}
