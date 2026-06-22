import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

// Service-role client. Per-installer NetSuite vendor ids live on
// cni_profiles, whose RLS is a tangle of overlapping policies (migration 032's
// role='admin'-only policy was never replaced by 044's is_internal_staff()
// one, so a multi-role admin whose scalar `role` isn't literally 'admin' gets
// silently blocked from reading OR writing them). Going through the service
// role here sidesteps all of that — the same approach /api/cni/invite uses.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Profiles that carry an installer role are the CNI installer population —
// matches the membership rule used on the company detail page.
const INSTALLER_FILTER = 'role.eq.installer,roles.cs.{installer}';

/**
 * GET /api/cni/installers[?companyId=<uuid>]
 * All installer-role profiles with their company name and NetSuite vendor id.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const companyId = req.nextUrl.searchParams.get('companyId');

  let query = supabase
    .from('profiles')
    .select('id, full_name, email, company_id, status, deactivated')
    .or(INSTALLER_FILTER)
    .order('full_name');
  if (companyId) query = query.eq('company_id', companyId);

  const { data: profiles, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = profiles || [];
  const ids = rows.map((p: any) => p.id);

  // Company names (only the ones referenced).
  const companyIds = [...new Set(rows.map((p: any) => p.company_id).filter(Boolean))];
  const companyMap: Record<string, string> = {};
  if (companyIds.length > 0) {
    const { data: companies } = await supabase
      .from('companies')
      .select('id, name')
      .in('id', companyIds);
    (companies || []).forEach((c: any) => { companyMap[c.id] = c.name; });
  }

  // Per-person vendor ids.
  const vendorMap: Record<string, string | null> = {};
  if (ids.length > 0) {
    const { data: cps } = await supabase
      .from('cni_profiles')
      .select('user_id, netsuite_vendor_id')
      .in('user_id', ids);
    (cps || []).forEach((c: any) => { vendorMap[c.user_id] = c.netsuite_vendor_id; });
  }

  const installers = rows.map((p: any) => ({
    user_id: p.id,
    full_name: p.full_name || 'Unknown',
    email: p.email || '',
    company_id: p.company_id || null,
    company_name: p.company_id ? (companyMap[p.company_id] || null) : null,
    status: p.status || 'unknown',
    deactivated: !!p.deactivated,
    netsuite_vendor_id: vendorMap[p.id] ?? null,
  }));

  return NextResponse.json({ installers });
}

const VendorIdSchema = z.object({
  userId: z.string().uuid(),
  // Empty / whitespace clears it (stored as NULL).
  netsuiteVendorId: z.string().trim().max(60).nullable().optional(),
});

/**
 * PATCH /api/cni/installers
 * Set one installer's NetSuite vendor id. Upserts cni_profiles so installers
 * without a CNI profile row still get a vendor id recorded.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, VendorIdSchema);
  if (parsed.error) return parsed.error;
  const { userId, netsuiteVendorId } = parsed.data;

  const clean = (netsuiteVendorId ?? '').trim() || null;

  // Guard: only set vendor ids on people who can actually be CNI installers.
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, roles')
    .eq('id', userId)
    .single();
  const isInstaller =
    profile && (profile.role === 'installer' || (profile.roles || []).includes('installer'));
  if (!isInstaller) {
    return NextResponse.json({ error: 'Not a CNI installer' }, { status: 400 });
  }

  const { error } = await supabase
    .from('cni_profiles')
    .upsert({ user_id: userId, netsuite_vendor_id: clean }, { onConflict: 'user_id' });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, netsuite_vendor_id: clean });
}
