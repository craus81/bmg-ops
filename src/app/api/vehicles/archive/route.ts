import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/vehicles/archive
 * Body: { vehicleId: string, unarchive?: boolean }
 * Archives or unarchives a fleet_checkins vehicle.
 * Uses service role to bypass RLS.
 */
export async function POST(req: NextRequest) {
  try {
    const { vehicleId, unarchive } = await req.json();

    if (!vehicleId) {
      return NextResponse.json({ error: 'vehicleId required' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { error } = await supabase
      .from('fleet_checkins')
      .update({ archived_at: unarchive ? null : new Date().toISOString() })
      .eq('id', vehicleId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Archive vehicle error:', err);
    return NextResponse.json({ error: err.message || 'Failed to archive vehicle' }, { status: 500 });
  }
}
