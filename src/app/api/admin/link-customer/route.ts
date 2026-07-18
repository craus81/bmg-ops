import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  userId: z.string().uuid(),
  // null unlinks the account.
  customerNetsuiteId: z.string().trim().min(1).max(40).nullable(),
});

/**
 * POST /api/admin/link-customer — tie a customer-role login to its NetSuite
 * customer. One link scopes the whole portal; replaces per-vehicle manual
 * assignment.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { userId, customerNetsuiteId } = parsed.data;

  let companyName: string | null = null;
  if (customerNetsuiteId) {
    const { data: customer } = await service
      .from('customers')
      .select('netsuite_id, company_name')
      .eq('netsuite_id', customerNetsuiteId)
      .maybeSingle();
    if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    companyName = customer.company_name;
  }

  const { error } = await service
    .from('profiles')
    .update({ customer_netsuite_id: customerNetsuiteId })
    .eq('id', userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(service, {
    actorId: auth.user!.id,
    table: 'profiles',
    recordId: userId,
    action: customerNetsuiteId ? 'link_customer' : 'unlink_customer',
    detail: { customer_netsuite_id: customerNetsuiteId, company_name: companyName },
  });

  return NextResponse.json({ success: true, companyName });
}
