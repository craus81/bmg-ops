import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET: Search open POs for the assignment picker
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() || '';

  let query = supabase
    .from('purchase_orders')
    .select('id, po_number, customer, status, ordered_date, po_line_items(id, part_number, description, quantity, installed, unit_price)')
    .in('status', ['open', 'complete'])
    .order('created_at', { ascending: false })
    .limit(20);

  if (q.length >= 2) {
    query = query.or(`po_number.ilike.%${q}%,customer.ilike.%${q}%`);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ pos: data || [] });
}

// POST: Auto-match a vehicle to a PO line item by part number
export async function POST(req: NextRequest) {
  try {
    const { vehicleId, poId, partNumber } = await req.json();

    if (!vehicleId || !poId) {
      return NextResponse.json({ error: 'vehicleId and poId required' }, { status: 400 });
    }

    // Get PO line items
    const { data: lineItems } = await supabase
      .from('po_line_items')
      .select('id, part_number, quantity, installed')
      .eq('po_id', poId);

    if (!lineItems || lineItems.length === 0) {
      return NextResponse.json({ error: 'No line items found on this PO' }, { status: 404 });
    }

    // Try to auto-match by part number
    let matchedLineId: string | null = null;

    if (partNumber) {
      // Find a line item with matching part number that still has capacity
      const match = lineItems.find(
        (l) => l.part_number?.toLowerCase() === partNumber.toLowerCase() && l.installed < l.quantity
      );
      if (match) {
        matchedLineId = match.id;
      } else {
        // Try partial match
        const partialMatch = lineItems.find(
          (l) => l.part_number?.toLowerCase().includes(partNumber.toLowerCase()) && l.installed < l.quantity
        );
        if (partialMatch) {
          matchedLineId = partialMatch.id;
        }
      }
    }

    // If no part number match, use first line item with capacity
    if (!matchedLineId) {
      const available = lineItems.find((l) => l.installed < l.quantity);
      if (available) {
        matchedLineId = available.id;
      } else {
        // All lines fulfilled — use first line anyway (over-assign)
        matchedLineId = lineItems[0].id;
      }
    }

    // Get current vehicle to check for existing assignment
    const { data: vehicle } = await supabase
      .from('scanned_vehicles')
      .select('po_line_item_id')
      .eq('id', vehicleId)
      .single();

    const oldPoLineItemId = vehicle?.po_line_item_id || null;

    // Use the same logic as update-match: decrement old, update, increment new
    if (oldPoLineItemId) {
      await supabase.rpc('decrement_po_installed', { p_line_id: oldPoLineItemId });
    }

    const { error: updateErr } = await supabase
      .from('scanned_vehicles')
      .update({ po_line_item_id: matchedLineId })
      .eq('id', vehicleId);

    if (updateErr) {
      if (oldPoLineItemId) {
        await supabase.rpc('increment_po_installed', { p_line_id: oldPoLineItemId });
      }
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Increment new line item's installed count
    await supabase.rpc('increment_po_installed', { p_line_id: matchedLineId });

    // Update PO status
    const { data: allLines } = await supabase
      .from('po_line_items')
      .select('quantity, installed')
      .eq('po_id', poId);

    const allFulfilled = (allLines || []).every((l: any) => l.installed >= l.quantity);
    await supabase
      .from('purchase_orders')
      .update({ status: allFulfilled ? 'complete' : 'open' })
      .eq('id', poId);

    // Also update old PO status if different
    if (oldPoLineItemId) {
      const { data: oldLine } = await supabase
        .from('po_line_items')
        .select('po_id')
        .eq('id', oldPoLineItemId)
        .single();

      if (oldLine && oldLine.po_id !== poId) {
        const { data: oldPOLines } = await supabase
          .from('po_line_items')
          .select('quantity, installed')
          .eq('po_id', oldLine.po_id);

        const oldAllFulfilled = (oldPOLines || []).every((l: any) => l.installed >= l.quantity);
        await supabase
          .from('purchase_orders')
          .update({ status: oldAllFulfilled ? 'complete' : 'open' })
          .eq('id', oldLine.po_id);
      }
    }

    // Get the matched line info to return
    const { data: matchedLine } = await supabase
      .from('po_line_items')
      .select('id, part_number, description')
      .eq('id', matchedLineId)
      .single();

    const { data: po } = await supabase
      .from('purchase_orders')
      .select('po_number, customer')
      .eq('id', poId)
      .single();

    return NextResponse.json({
      success: true,
      matched_line_item_id: matchedLineId,
      matched_part_number: matchedLine?.part_number,
      po_number: po?.po_number,
      customer: po?.customer,
    });
  } catch (err: any) {
    console.error('Assign PO error:', err);
    return NextResponse.json({ error: err.message || 'Failed to assign PO' }, { status: 500 });
  }
}
