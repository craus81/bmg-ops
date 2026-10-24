import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { MAX_PART_LABOR_HOURS } from '@/lib/part-labor';
import { fillDraftEstimatesLabor } from '@/lib/part-labor-fill';

const Schema = z.object({
  hours: z.number().min(0).max(MAX_PART_LABOR_HOURS).nullable(),
});

// Set a catalog part's labor hours from an estimate line — super admins only
// (Craig, 2026-10-23). FleetSuite-owned like the Parts page edit: nothing is
// written to NetSuite, and the parts sync only overwrites it when NetSuite's
// own labor field (custitem1) carries a value. When the part was "not set",
// its unset lines on other draft estimates are filled and re-totalled too;
// see src/lib/part-labor.ts.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const hours = parsed.data.hours == null ? null : Math.round(parsed.data.hours * 100) / 100;

  try {
    const supabase = createServiceClient();
    const { data: part, error: readErr } = await supabase
      .from('netsuite_parts')
      .select('id, netsuite_id, item_number, labor_hours')
      .eq('id', params.id)
      .maybeSingle();
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    if (!part) return NextResponse.json({ error: 'Part not found in the catalog' }, { status: 404 });

    const { error } = await supabase
      .from('netsuite_parts')
      .update({ labor_hours: hours, updated_at: new Date().toISOString() })
      .eq('id', part.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const wasUnset = part.labor_hours == null;
    const fill = wasUnset && hours != null
      ? await fillDraftEstimatesLabor(supabase, part, hours, auth.user.id)
      : { estimates: [], error: null };

    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'netsuite_parts',
      recordId: part.id,
      action: 'part_labor_set_from_estimate',
      detail: {
        item_number: part.item_number,
        labor_hours_before: part.labor_hours,
        labor_hours_after: hours,
        draft_estimates_filled: fill.estimates.map(e => e.estimate_number || e.id),
      },
    });

    return NextResponse.json({
      success: true,
      hours,
      filledEstimates: fill.estimates,
      // The part itself saved; only the draft fill fell short.
      fillError: fill.error,
    });
  } catch (err: any) {
    console.error('part labor update error:', err);
    return NextResponse.json({ error: err.message || 'Update failed' }, { status: 500 });
  }
}
