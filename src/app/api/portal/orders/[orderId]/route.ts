import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const adminSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  _req: NextRequest,
  { params }: { params: { orderId: string } }
) {
  try {
    const userSupabase = createServerClient();
    const { data: { session } } = await userSupabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: order, error } = await adminSupabase
      .from('portal_orders')
      .select(`
        *,
        portal_customer:portal_customers(id, company_name, slug, logo_url, primary_color),
        lines:portal_order_lines(
          *,
          proof_part:proof_parts(id, part_name, part_number, description, unit_price, proof_id)
        )
      `)
      .eq('id', params.orderId)
      .single();

    if (error || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Verify the user belongs to this portal customer
    const { data: pcu } = await adminSupabase
      .from('portal_customer_users')
      .select('id')
      .eq('portal_customer_id', order.portal_customer_id)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (!pcu) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    return NextResponse.json(order);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
