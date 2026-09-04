import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { ensurePortalLink, portalLinkUrl } from '@/lib/po-portal-link';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  customerId: z.string().uuid(),
  /** create: issue a link if none exists (idempotent). regenerate: replace
   *  it (old links die). revoke: clear it. */
  action: z.enum(['create', 'regenerate', 'revoke']),
});

/**
 * POST /api/customers/portal-link — manage a customer's PO-status portal
 * link from the customer record (migration 260). Staff-wide: the link is
 * read-only customer data, and the people who send it are the same people
 * who email statements. Every change is audited on the customer row.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { customerId, action } = parsed.data;

  const { data: customer } = await supabase
    .from('customers')
    .select('id, netsuite_id, company_name, portal_token, portal_token_created_at, portal_last_viewed_at')
    .eq('id', customerId)
    .maybeSingle();
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  if (!customer.netsuite_id) {
    return NextResponse.json({ error: 'This customer has no NetSuite id yet — purchase orders are keyed by it, so there is nothing a portal could show.' }, { status: 400 });
  }

  if (action === 'revoke') {
    await supabase.from('customers').update({ portal_token: null, portal_token_created_at: null }).eq('id', customerId);
    await logAudit(supabase, {
      actorId: auth.user.id, table: 'customers', recordId: customerId, action: 'po_portal_link_revoked',
      detail: { previous_token_created_at: customer.portal_token_created_at || null },
    });
    return NextResponse.json({ success: true, token: null, url: null });
  }

  const result = await ensurePortalLink(supabase, customer, { regenerate: action === 'regenerate' });
  if (result.changed) {
    await logAudit(supabase, {
      actorId: auth.user.id, table: 'customers', recordId: customerId,
      action: action === 'regenerate' ? 'po_portal_link_regenerated' : 'po_portal_link_created',
      detail: { company: customer.company_name },
    });
  }
  return NextResponse.json({
    success: true,
    token: result.token,
    url: portalLinkUrl(result.token),
    createdAt: result.createdAt,
    lastViewedAt: customer.portal_last_viewed_at || null,
  });
}
