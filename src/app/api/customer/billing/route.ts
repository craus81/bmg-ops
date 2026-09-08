import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, isAdminRole } from '@/lib/api-auth';
import { loadPortalBilling } from '@/lib/portal-billing';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/customer/billing (R5-14): the logged-in customer dashboard's
 * billing card — same loader as the tokenized portal, scoped by the
 * caller's own profiles.customer_netsuite_id (the id-keyed path, never
 * name matching). Admins may preview any customer via ?customerId=,
 * mirroring /api/customer/portal.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const roles: string[] = auth.profile?.roles?.length ? auth.profile.roles : [auth.profile?.role];
    const previewId = (req.nextUrl.searchParams.get('customerId') || '').trim();
    let netsuiteId: string | null = null;
    if (previewId && isAdminRole(roles)) {
      netsuiteId = /^\d{1,15}$/.test(previewId) ? previewId : null;
    } else {
      const { data: profile } = await service
        .from('profiles')
        .select('customer_netsuite_id')
        .eq('id', auth.user.id)
        .maybeSingle();
      netsuiteId = profile?.customer_netsuite_id ? String(profile.customer_netsuite_id) : null;
    }
    if (!netsuiteId) return NextResponse.json({ linked: false });

    const { billing } = await loadPortalBilling(netsuiteId);
    return NextResponse.json({ linked: true, ...billing });
  } catch (e: any) {
    console.error('customer billing failed:', e);
    return NextResponse.json({ error: 'Billing is temporarily unavailable — try again in a few minutes.' }, { status: 502 });
  }
}
