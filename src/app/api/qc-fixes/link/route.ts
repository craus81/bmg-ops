import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin, requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { qcLinkUrl } from '@/lib/qc-fixes';
import { ensureQcLink } from '@/lib/qc-fixes-server';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

/** GET /api/qc-fixes/link — customers with a QC link: the link and who gets the emails. */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const { data, error } = await supabase
    .from('customers')
    .select('id, company_name, qc_token, qc_token_created_at, qc_notify_emails')
    .not('qc_token', 'is', null)
    .order('company_name')
    .order('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    links: (data || []).map(c => ({
      customerId: c.id,
      customerName: c.company_name,
      url: qcLinkUrl(c.qc_token),
      createdAt: c.qc_token_created_at,
      emails: c.qc_notify_emails || [],
    })),
  });
}

const Schema = z.object({
  /** customers.id, or the NetSuite id from the customer picker. */
  customerId: z.string().uuid().optional(),
  customerNetsuiteId: z.string().max(40).optional(),
  action: z.enum(['create', 'regenerate', 'revoke', 'emails']),
  emails: z.array(z.string().trim().toLowerCase().email().max(254)).max(10).optional(),
});

/**
 * POST /api/qc-fixes/link — admins issue, regenerate (old link dies) or
 * revoke a customer's QC link, and set who is emailed when their team
 * reports an issue.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;
  if (!p.customerId && !p.customerNetsuiteId) return NextResponse.json({ error: 'Pick a customer' }, { status: 400 });

  let q = supabase.from('customers').select('id, company_name, qc_token, qc_token_created_at, qc_notify_emails');
  q = p.customerId ? q.eq('id', p.customerId) : q.eq('netsuite_id', p.customerNetsuiteId!);
  const { data: customer } = await q.maybeSingle();
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  if (p.action === 'revoke') {
    const { error } = await supabase.from('customers').update({ qc_token: null, qc_token_created_at: null }).eq('id', customer.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else if (p.action === 'emails') {
    const emails = [...new Set(p.emails || [])];
    const { error } = await supabase.from('customers').update({ qc_notify_emails: emails }).eq('id', customer.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    try {
      await ensureQcLink(supabase, customer, { regenerate: p.action === 'regenerate' });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }
  await logAudit(supabase, { actorId: auth.user.id, table: 'customers', recordId: customer.id, action: `qc_link_${p.action}` });
  return NextResponse.json({ ok: true, customerId: customer.id });
}
