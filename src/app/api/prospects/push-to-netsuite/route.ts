import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { promoteProspect } from '@/lib/promote-prospect';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { findCustomerDuplicates } from '@/lib/customer-dupes';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  prospectId: z.string().uuid(),
  // Promotion creates a NetSuite CUSTOMER. The lead/prospect stage values
  // remain accepted for API compat; the FleetSuite lead tier is the record
  // itself (netsuite_id null = lead), not a NetSuite stage.
  type: z.enum(['customer', 'lead', 'prospect']).optional().default('customer'),
  userId: z.string().uuid().optional().nullable(),
  /** Skip the NetSuite-double guard — the CRM create flow sets this after
   *  its own pre-flight showed the user the matches. */
  force: z.boolean().optional().default(false),
});

/**
 * POST /api/prospects/push-to-netsuite
 * Promote a FleetSuite lead to a NetSuite customer (the record page's
 * "Promote to NetSuite Customer" button). Since the lead tier, this is an
 * explicit act — creating a CRM record no longer calls this route.
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

    // Promote — shared with the estimate push/convert auto-promotion paths.
    const result = await promoteProspect(supabase, prospect, { userId, type });
    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to create in NetSuite' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      customerId: result.netsuiteId,
      entityId: result.entityId,
      netsuiteUrl: result.netsuiteUrl,
      localCustomerId: result.localCustomerId || null,
    });
  } catch (error: any) {
    console.error('Push to NetSuite error:', error);
    return NextResponse.json(
      { error: 'Failed to push to NetSuite: ' + (error?.message || 'Unknown') },
      { status: 500 }
    );
  }
}
