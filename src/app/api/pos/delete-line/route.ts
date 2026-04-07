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
    const { lineId } = await req.json();

    if (!lineId) {
      return NextResponse.json({ error: 'lineId required' }, { status: 400 });
    }

    // Clear FK references from scanned_vehicles
    await supabase
      .from('scanned_vehicles')
      .update({ po_line_item_id: null })
      .eq('po_line_item_id', lineId);

    // Delete the line item
    const { error } = await supabase
      .from('po_line_items')
      .delete()
      .eq('id', lineId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Delete line item error:', err);
    return NextResponse.json({ error: err.message || 'Failed to delete' }, { status: 500 });
  }
}
