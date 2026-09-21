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

    // Which vehicle a row is, and the device fitted to it, belong to that one
    // row — applying a VIN or an IMEI to a selection would stamp every scan as
    // the same truck. The scans page only offers these when a single scan is
    // open; the route refuses them for more than one either way.
    const singleScanOnlyFields = [
      'vin', 'vehicle_year', 'vehicle_make', 'vehicle_model',
      'serial_number', 'imei', 'iccid',
    ];

    // Only allow safe fields to be updated
    const allowedFields = [
      ...singleScanOnlyFields,
      'part_number', 'part_description', 'billable_customer',
      'unit_number', 'location_id', 'location_name',
      'po_id', 'po_number', 'po_line_item_id',
      'invoice_number', 'date_invoiced', 'is_paid',
      'archived_at', 'exported_at', 'exported_by',
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

    const perScan = singleScanOnlyFields.filter((f) => f in safeUpdates);
    if (scanIds.length > 1 && perScan.length > 0) {
      return NextResponse.json(
        { error: `${perScan.join(', ')} can only be changed one scan at a time` },
        { status: 400 },
      );
    }

    // Capture the values being overwritten (only the touched fields) so the
    // audit log can answer "what did this scan say before?". id and vin are
    // always on the row, so a touched vin must not be listed twice.
    const touchedCols = ['id', 'vin', ...Object.keys(safeUpdates).filter((k) => k !== 'id' && k !== 'vin')].join(', ');
    const { data: beforeRows } = await supabase
      .from('scan_logs')
      .select(touchedCols)
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
