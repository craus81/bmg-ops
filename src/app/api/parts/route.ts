import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

// Active parts for the pickers (scan page, PartPicker). Served with the
// service role: techs and CNI installers used to read netsuite_parts straight
// from the browser, where any RLS/policy mismatch silently returns zero rows
// and the pickers just look empty. Any approved non-customer account may read
// — the same population the table's RLS intends.
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const roles: string[] = auth.profile?.roles?.length ? auth.profile.roles : [auth.profile?.role];
  // Customer-ONLY accounts are blocked. A multi-role account (e.g. an admin
  // who also carries the customer role to preview the portal) is still
  // internal — same semantics as /api/scans/log.
  if (roles.includes('customer') && roles.length === 1) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const parts: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('netsuite_parts')
      .select('id, item_number, display_name, description, billable_customer, catalog, source')
      .eq('is_active', true)
      .order('item_number')
      .range(offset, offset + 999);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    parts.push(...data);
    if (data.length < 1000) break;
  }

  return NextResponse.json({ parts });
}
