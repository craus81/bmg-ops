import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { resolvePortalCustomer } from '@/lib/portal-token';
import { loadPortalBilling } from '@/lib/portal-billing';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/portal/[token]/billing (R5-14): the customer's balance, aging,
 * and open-invoice list — keyed strictly on the token's
 * customers.netsuite_id (the same credential as the PO portal). Tighter
 * rate limit than the main portal read (live SuiteQL behind a shareable
 * link), softened by the 5-minute per-customer cache in portal-billing.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'po_portal_billing', 60)) {
    return NextResponse.json({ error: 'Too many requests — try again shortly.' }, { status: 429 });
  }

  const customer = await resolvePortalCustomer(service, params.token);
  if (!customer) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  try {
    const { billing } = await loadPortalBilling(customer.netsuite_id);
    return NextResponse.json({ status: 'ready', company: customer.company_name, ...billing });
  } catch (e: any) {
    console.error('portal billing failed:', e);
    return NextResponse.json({ error: 'Billing is temporarily unavailable — try again in a few minutes.' }, { status: 502 });
  }
}
