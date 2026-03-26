import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';

export const dynamic = 'force-dynamic';

const adminSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    // Verify portal user auth
    const userSupabase = createServerClient();
    const { data: { session } } = await userSupabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { slug, po_number, ship_to_address, lines } = await req.json();

    if (!slug || !po_number || !ship_to_address || !lines?.length) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Resolve portal customer from slug
    const { data: portalCustomer } = await adminSupabase
      .from('portal_customers')
      .select('id, company_name')
      .eq('slug', slug)
      .maybeSingle();

    if (!portalCustomer) {
      return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
    }

    // Verify user belongs to this portal
    const { data: pcu } = await adminSupabase
      .from('portal_customer_users')
      .select('id')
      .eq('portal_customer_id', portalCustomer.id)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (!pcu) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // Create the order
    const { data: order, error: orderError } = await adminSupabase
      .from('portal_orders')
      .insert({
        portal_customer_id: portalCustomer.id,
        po_number,
        ship_to_address,
        status: 'pending',
        created_by: session.user.id,
      })
      .select()
      .single();

    if (orderError || !order) {
      return NextResponse.json({ error: orderError?.message || 'Failed to create order' }, { status: 500 });
    }

    // Create order lines
    const lineInserts = lines.map((l: { proof_part_id: string; quantity: number; unit_price: number }) => ({
      portal_order_id: order.id,
      proof_part_id: l.proof_part_id,
      quantity: l.quantity,
      unit_price: l.unit_price,
    }));

    const { error: linesError } = await adminSupabase
      .from('portal_order_lines')
      .insert(lineInserts);

    if (linesError) {
      // Rollback the order
      await adminSupabase.from('portal_orders').delete().eq('id', order.id);
      return NextResponse.json({ error: linesError.message }, { status: 500 });
    }

    // Notify users with graphics_production role (and admins)
    const { data: productionUsers } = await adminSupabase
      .from('profiles')
      .select('id')
      .or('role.eq.graphics_production,role.eq.admin')
      .eq('deactivated', false)
      .not('status', 'eq', 'denied');

    // Also check roles[] array for graphics_production
    const { data: roleArrayUsers } = await adminSupabase
      .from('profiles')
      .select('id')
      .contains('roles', ['graphics_production'])
      .eq('deactivated', false)
      .not('status', 'eq', 'denied');

    const notifySet = new Set<string>();
    (productionUsers || []).forEach((u: { id: string }) => notifySet.add(u.id));
    (roleArrayUsers || []).forEach((u: { id: string }) => notifySet.add(u.id));
    // Remove the submitting user if they're internal (they won't be, but just in case)
    notifySet.delete(session.user.id);

    const notifyIds = Array.from(notifySet);
    if (notifyIds.length > 0) {
      const lineCount = lines.length;
      const total = lines.reduce((sum: number, l: { quantity: number; unit_price: number }) =>
        sum + l.quantity * l.unit_price, 0);
      await notifyMany(notifyIds, {
        type: 'portal_order_new',
        title: `New Portal Order — ${portalCustomer.company_name}`,
        body: `PO #${po_number} • ${lineCount} line${lineCount !== 1 ? 's' : ''} • $${total.toFixed(2)}`,
        url: `/admin/portal-orders/${order.id}`,
      });
    }

    return NextResponse.json({ id: order.id });
  } catch (err: any) {
    console.error('Portal order create error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
