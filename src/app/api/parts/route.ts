import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAuth, isInternalStaffRole, getProfileRoles } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

// Active parts for the pickers (scan page, PartPicker). Served with the
// service role: techs and CNI installers used to read netsuite_parts straight
// from the browser, where any RLS/policy mismatch silently returns zero rows
// and the pickers just look empty. Internal staff and external CNI
// installers may read — installers pick the parts they put on when they log
// a scan (owner decision 2026-10-20: installers see the full list). This was
// requireStaff until then, which 403'd every installer and left Scan's part
// search empty for them. Customer-only accounts stay blocked.
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  const roles = getProfileRoles(auth.profile);
  if (!isInternalStaffRole(auth.profile) && !roles.includes('installer')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = createServiceClient();

  // Catalog version: active count + newest edit (migration 355 keeps
  // updated_at current on every write). A caller that already holds this
  // version gets { unchanged: true } instead of the whole list.
  const [activeRes, newestRes] = await Promise.all([
    supabase.from('netsuite_parts').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('netsuite_parts').select('updated_at').order('updated_at', { ascending: false, nullsFirst: false }).limit(1),
  ]);
  const version = activeRes.error || newestRes.error
    ? ''
    : `${activeRes.count ?? ''}|${newestRes.data?.[0]?.updated_at ?? ''}`;
  const have = req.nextUrl.searchParams.get('v');
  if (version && have && have === version) {
    return NextResponse.json({ unchanged: true, version });
  }

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

  return NextResponse.json({ parts, version });
}
