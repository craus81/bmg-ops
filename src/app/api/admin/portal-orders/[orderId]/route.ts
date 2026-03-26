import { NextRequest, NextResponse } from 'next/server';
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
    const { data, error } = await adminSupabase
      .from('portal_orders')
      .select(`
        *,
        portal_customer:portal_customers(id, company_name, slug, logo_url, primary_color),
        lines:portal_order_lines(
          *,
          proof_part:proof_parts(id, part_name, part_number, description, unit_price, proof_id,
            proof:graphics_proofs(id, customer_name, vehicle_type)
          )
        )
      `)
      .eq('id', params.orderId)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { orderId: string } }
) {
  try {
    const body = await req.json();
    const { status, notes, ship_to_address, lines } = body;

    // Update order fields
    const updateData: Record<string, any> = {};
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (ship_to_address !== undefined) updateData.ship_to_address = ship_to_address;

    if (Object.keys(updateData).length > 0) {
      const { error } = await adminSupabase
        .from('portal_orders')
        .update(updateData)
        .eq('id', params.orderId);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    // Update lines if provided
    if (lines !== undefined) {
      // Delete existing lines and re-insert
      await adminSupabase
        .from('portal_order_lines')
        .delete()
        .eq('portal_order_id', params.orderId);

      if (lines.length > 0) {
        const lineInserts = lines.map((l: {
          proof_part_id: string;
          quantity: number;
          unit_price: number;
        }) => ({
          portal_order_id: params.orderId,
          proof_part_id: l.proof_part_id,
          quantity: l.quantity,
          unit_price: l.unit_price,
        }));

        const { error: linesError } = await adminSupabase
          .from('portal_order_lines')
          .insert(lineInserts);

        if (linesError) {
          return NextResponse.json({ error: linesError.message }, { status: 500 });
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
