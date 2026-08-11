import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createCustomerOrLead } from '@/lib/netsuite';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

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
  const { prospectId, type, userId } = parsed.data;

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

    return NextResponse.json({
      success: true,
      customerId: result.customerId,
      entityId: result.entityId,
      netsuiteUrl: result.netsuiteUrl,
    });
  } catch (error: any) {
    console.error('Push to NetSuite error:', error);
    return NextResponse.json(
      { error: 'Failed to push to NetSuite: ' + (error?.message || 'Unknown') },
      { status: 500 }
    );
  }
}
