import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const Schema = z.object({ vehicleId: z.string().uuid() });

/**
 * POST /api/vehicles/delete
 * Deletes a fleet_checkins vehicle and its status history.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { vehicleId } = parsed.data;

  try {

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Delete status history first (FK constraint)
    await supabase
      .from('vehicle_status_history')
      .delete()
      .eq('vehicle_id', vehicleId);

    // Delete the vehicle
    const { error } = await supabase
      .from('fleet_checkins')
      .delete()
      .eq('id', vehicleId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Delete vehicle error:', err);
    return NextResponse.json({ error: err.message || 'Failed to delete vehicle' }, { status: 500 });
  }
}
