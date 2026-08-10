import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  poIds: z.array(z.string().uuid()).min(1).max(200),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { poIds } = parsed.data;

  try {
    const results: { id: string; success: boolean; error?: string }[] = [];

    for (const poId of poIds) {
      try {
        // 1. Get line item IDs for this PO
        const { data: lineItems } = await supabase
          .from('po_line_items')
          .select('id')
          .eq('po_id', poId);

        const lineIds = (lineItems || []).map((li: any) => li.id);

        // 2. Clear FK references from gmail_po_imports
        await supabase
          .from('gmail_po_imports')
          .update({ po_id: null })
          .eq('po_id', poId);

        // 3b. Clear FK references from graphics_jobs
        await supabase
          .from('graphics_jobs')
          .update({ po_id: null, po_line_item_id: null })
          .eq('po_id', poId);

        // 3c. Clear FK references from scan_logs
        if (lineIds.length > 0) {
          await supabase
            .from('scan_logs')
            .update({ po_id: null, po_line_item_id: null })
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
