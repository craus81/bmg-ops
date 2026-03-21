import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/vehicles/delete-scanned
 * Body: { vehicleId: string }
 * Deletes a scanned_vehicles record and its photos.
 * Uses service role to bypass RLS.
 */
export async function POST(req: NextRequest) {
  try {
    const { vehicleId } = await req.json();

    if (!vehicleId) {
      return NextResponse.json({ error: 'vehicleId required' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Delete photos first (FK constraint)
    await supabase
      .from('vehicle_photos')
      .delete()
      .eq('vehicle_id', vehicleId);

    // Delete the scanned vehicle
    const { error } = await supabase
      .from('scanned_vehicles')
      .delete()
      .eq('id', vehicleId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Delete scanned vehicle error:', err);
    return NextResponse.json({ error: err.message || 'Failed to delete vehicle' }, { status: 500 });
  }
}
