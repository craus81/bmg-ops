import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  scanIds: z.array(z.string().uuid()).min(1).max(1000),
  updates: z.record(z.string(), z.any()).refine((u) => Object.keys(u).length > 0, {
    message: 'updates object required',
  }),
});

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { scanIds, updates } = parsed.data;

  try {

    // Only allow safe fields to be updated
    const allowedFields = [
      'part_number', 'part_description', 'billable_customer',
      'location_id', 'location_name',
      'po_id', 'po_number', 'po_line_item_id',
      'invoice_number', 'date_invoiced', 'is_paid',
      'archived_at', 'exported_at',
    ];
    const safeUpdates: Record<string, any> = {};
    for (const key of Object.keys(updates)) {
      if (allowedFields.includes(key)) {
        safeUpdates[key] = updates[key];
      }
    }

    if (Object.keys(safeUpdates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('scan_logs')
      .update(safeUpdates)
      .in('id', scanIds)
      .select('id');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, updated: data?.length || 0 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Update failed' }, { status: 500 });
  }
}
