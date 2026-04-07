import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { vehicleId, newPoLineItemId, oldPoLineItemId } = await req.json();

    if (!vehicleId) {
      return NextResponse.json({ error: 'vehicleId required' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // If removing an old match, decrement installed count
    if (oldPoLineItemId) {
      await supabase.rpc('decrement_po_installed', { p_line_id: oldPoLineItemId });
    }

    // Update the vehicle's match
    const { error: updateErr } = await supabase
      .from('scanned_vehicles')
      .update({ po_line_item_id: newPoLineItemId || null })
      .eq('id', vehicleId);

    if (updateErr) {
      // Rollback the decrement if update failed
      if (oldPoLineItemId) {
        await supabase.rpc('increment_po_installed', { p_line_id: oldPoLineItemId });
      }
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // If setting a new match, increment installed count
    if (newPoLineItemId) {
      await supabase.rpc('increment_po_installed', { p_line_id: newPoLineItemId });
    }

    // Check if old PO needs status update (might no longer be complete)
    if (oldPoLineItemId) {
      const { data: oldLine } = await supabase
        .from('po_line_items')
        .select('po_id')
        .eq('id', oldPoLineItemId)
        .single();

      if (oldLine) {
        const { data: allLines } = await supabase
          .from('po_line_items')
          .select('quantity, installed')
          .eq('po_id', oldLine.po_id);

        const allFulfilled = (allLines || []).every((l: any) => l.installed >= l.quantity);
        await supabase
          .from('purchase_orders')
          .update({ status: allFulfilled ? 'complete' : 'open' })
          .eq('id', oldLine.po_id);
      }
    }

    // Check if new PO is now complete
    if (newPoLineItemId) {
      const { data: newLine } = await supabase
        .from('po_line_items')
        .select('po_id')
        .eq('id', newPoLineItemId)
        .single();

      if (newLine) {
        const { data: allLines } = await supabase
          .from('po_line_items')
          .select('quantity, installed')
          .eq('po_id', newLine.po_id);

        const allFulfilled = (allLines || []).every((l: any) => l.installed >= l.quantity);
        await supabase
          .from('purchase_orders')
          .update({ status: allFulfilled ? 'complete' : 'open' })
          .eq('id', newLine.po_id);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Update match error:', err);
    return NextResponse.json({ error: err.message || 'Failed to update match' }, { status: 500 });
  }
}
