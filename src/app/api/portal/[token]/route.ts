import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { buildPoPortalData } from '@/lib/po-portal';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/portal/[token] — the customer PO-status portal (migration 260).
 *
 * No session: the shared link's token is the credential, exactly like the
 * approval magic links. Read-only, rate-limited per IP, and the payload is
 * the allowlisted projection in src/lib/po-portal.ts — nothing is returned
 * that isn't chosen for the customer. A revoked or regenerated link stops
 * resolving (customers.portal_token is replaced or cleared), which is the
 * whole revocation story.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  // A customer's whole purchasing team may share one office IP and refresh
  // this page all day — a much looser ceiling than the one-shot approval
  // pages, still enough to make token guessing pointless (UUID space).
  if (!await checkRateLimit(ip, 'po_portal_get', 300)) {
    return NextResponse.json({ status: 'error', error: 'Too many requests — try again in a little while.' }, { status: 429 });
  }

  const token = (params.token || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ status: 'invalid' }, { status: 404 });
  }

  const { data: customer } = await supabase
    .from('customers')
    .select('id, netsuite_id, company_name, portal_token')
    .eq('portal_token', token)
    .maybeSingle();
  if (!customer || !customer.netsuite_id) {
    return NextResponse.json({ status: 'invalid' }, { status: 404 });
  }

  const data = await buildPoPortalData(supabase, { netsuite_id: customer.netsuite_id, company_name: customer.company_name });

  // Best-effort "someone looked" stamp for the customer record.
  supabase.from('customers').update({ portal_last_viewed_at: new Date().toISOString() }).eq('id', customer.id)
    .then(() => undefined, () => undefined);

  return NextResponse.json({ status: 'ready', ...data });
}
