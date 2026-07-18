import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

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
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { scanIds, updates } = parsed.data;

  try {

    // Only allow safe fields to be updated
    const allowedFields = [
      'part_number', 'part_description', 'billable_customer',
      'unit_number', 'location_id', 'location_name',
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

    // Capture the values being overwritten (only the touched fields) so the
    // audit log can answer "what did this scan say before?".
    const touchedCols = Object.keys(safeUpdates).join(', ');
    const { data: beforeRows } = await supabase
      .from('scan_logs')
      .select(`id, vin, ${touchedCols}`)
      .in('id', scanIds);

    const { data, error } = await supabase
      .from('scan_logs')
      .update(safeUpdates)
      .in('id', scanIds)
      .select('id');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'scan_logs',
      recordId: null,
      action: 'bulk_update',
      detail: { updated: data?.length || 0, updates: safeUpdates, before: beforeRows || [] },
    });

    return NextResponse.json({ success: true, updated: data?.length || 0 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Update failed' }, { status: 500 });
  }
}
