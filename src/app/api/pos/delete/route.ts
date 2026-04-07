import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    const { poIds } = await req.json();

    if (!poIds || !Array.isArray(poIds) || poIds.length === 0) {
      return NextResponse.json({ error: 'poIds array required' }, { status: 400 });
    }

    const results: { id: string; success: boolean; error?: string }[] = [];

    for (const poId of poIds) {
      try {
        // 1. Get line item IDs for this PO
        const { data: lineItems } = await supabase
          .from('po_line_items')
          .select('id')
          .eq('po_id', poId);

        const lineIds = (lineItems || []).map((li: any) => li.id);

        // 2. Clear FK references from scanned_vehicles
        if (lineIds.length > 0) {
          await supabase
            .from('scanned_vehicles')
            .update({ po_line_item_id: null })
            .in('po_line_item_id', lineIds);
        }

        // 3. Delete line items
        const { error: lineErr } = await supabase
          .from('po_line_items')
          .delete()
          .eq('po_id', poId);

        if (lineErr) {
          console.error(`Failed to delete line items for PO ${poId}:`, lineErr);
        }

        // 4. Delete the PO itself
        const { error: poErr } = await supabase
          .from('purchase_orders')
          .delete()
          .eq('id', poId);

        if (poErr) {
          console.error(`Failed to delete PO ${poId}:`, poErr);
          results.push({ id: poId, success: false, error: poErr.message });
        } else {
          results.push({ id: poId, success: true });
        }
      } catch (err: any) {
        console.error(`Error deleting PO ${poId}:`, err);
        results.push({ id: poId, success: false, error: err.message });
      }
    }

    const allSuccess = results.every((r) => r.success);
    const deletedCount = results.filter((r) => r.success).length;

    return NextResponse.json({
      success: allSuccess,
      deleted: deletedCount,
      total: poIds.length,
      results,
    });
  } catch (err: any) {
    console.error('PO delete error:', err);
    return NextResponse.json({ error: err.message || 'Failed to delete' }, { status: 500 });
  }
}
