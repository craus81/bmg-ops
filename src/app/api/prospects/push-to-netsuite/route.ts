import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createCustomerOrLead } from '@/lib/netsuite';
import { requireAuth } from '@/lib/api-auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/prospects/push-to-netsuite
 * Push a prospect to NetSuite as a Customer or Lead
 */
export async function POST(req: NextRequest) {
  try {
    const { prospectId, type, userId } = await req.json();

    if (!prospectId || !type) {
      return NextResponse.json({ error: 'Missing prospectId or type' }, { status: 400 });
    }

    if (!['customer', 'lead', 'prospect'].includes(type)) {
      return NextResponse.json({ error: 'Invalid type. Must be customer, lead, or prospect' }, { status: 400 });
    }

    // Fetch the prospect
    const { data: prospect, error: fetchError } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', prospectId)
      .single();

    if (fetchError || !prospect) {
      return NextResponse.json({ error: 'Prospect not found' }, { status: 404 });
    }

    if (prospect.netsuite_id) {
      return NextResponse.json({ error: 'Already pushed to NetSuite' }, { status: 400 });
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

    // Update the prospect with NetSuite info
    await supabase
      .from('prospects')
      .update({
        netsuite_id: result.customerId,
        netsuite_type: type,
        netsuite_url: result.netsuiteUrl,
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
