import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { createClient as createServiceClient } from '@supabase/supabase-js';

const serviceSupabase = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const VALID_STATUSES = ['pending', 'in_progress', 'stuck', 'complete', 'n/a'];

/**
 * POST /api/vehicle-tracking/graphics-install-status
 *
 * Drives the graphics install lane on a fleet_checkin (migration 085). The
 * lane is independent of the upfit lane in fleet_checkins.status — both run
 * in parallel during a vehicle's in-shop visit.
 *
 * On 'complete', the migration-085 trigger also flips the linked
 * graphics_jobs.status to 'installed' so the production team's view stays
 * in sync without double-entry.
 *
 * Body: { vehicleId, newStatus, note? }
 */
export async function POST(request: Request) {
  const auth = await requireStaff(request as NextRequest);
  if (auth.error) return auth.error;
  const user = auth.user;

  try {
    const body = await request.json();
    const { vehicleId, newStatus, note } = body;

    if (!vehicleId || !newStatus) {
      return NextResponse.json({ error: 'vehicleId and newStatus are required' }, { status: 400 });
    }
    if (!VALID_STATUSES.includes(newStatus)) {
      return NextResponse.json({ error: 'Invalid graphics install status' }, { status: 400 });
    }

    const { data: vehicle, error: vErr } = await serviceSupabase
      .from('fleet_checkins')
      .select('id, vin, graphics_install_status, matched_graphics_job_id')
      .eq('id', vehicleId)
      .single();
    if (vErr || !vehicle) {
      return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 });
    }

    const fromStatus = vehicle.graphics_install_status as string;
    if (fromStatus === newStatus) {
      return NextResponse.json({ success: true, noop: true, vehicleId, fromStatus, toStatus: newStatus });
    }

    const updatePayload: Record<string, any> = {
      graphics_install_status: newStatus,
    };
    if (newStatus === 'complete') {
      updatePayload.graphics_install_completed_at = new Date().toISOString();
      updatePayload.graphics_install_completed_by = user.id;
    } else if (fromStatus === 'complete' && newStatus !== 'complete') {
      // Re-opening a completed lane — clear the completion stamp so the
      // record reflects the current truth.
      updatePayload.graphics_install_completed_at = null;
      updatePayload.graphics_install_completed_by = null;
    }
    if (typeof note === 'string') {
      updatePayload.graphics_install_notes = note.trim() || null;
    }

    const { error: updErr } = await serviceSupabase
      .from('fleet_checkins')
      .update(updatePayload)
      .eq('id', vehicleId);
    if (updErr) {
      return NextResponse.json({ error: 'Failed to update graphics install status: ' + updErr.message }, { status: 500 });
    }

    // Drop a marker into vehicle_status_history so the timeline shows the
    // graphics-lane events alongside the upfit-lane events. Prefixed so
    // the existing UI still renders it without code changes; richer
    // surfacing can come later via a `lane` column.
    await serviceSupabase.from('vehicle_status_history').insert({
      vehicle_id: vehicleId,
      from_status: `graphics:${fromStatus}`,
      to_status: `graphics:${newStatus}`,
      note: note?.trim() || null,
      changed_by: user.id,
    });

    return NextResponse.json({
      success: true,
      vehicleId,
      fromStatus,
      toStatus: newStatus,
    });
  } catch (err: any) {
    console.error('graphics-install-status error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
