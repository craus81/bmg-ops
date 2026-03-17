import { createClient } from '@/lib/supabase-server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const supabase = createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { vehicleId, newStatus, note } = body;

    if (!vehicleId || !newStatus) {
      return NextResponse.json({ error: 'vehicleId and newStatus are required' }, { status: 400 });
    }

    const validStatuses = ['received', 'in_progress', 'stuck_parts', 'stuck_graphics', 'complete', 'shipped'];
    if (!validStatuses.includes(newStatus)) {
      return NextResponse.json({ error: 'Invalid status value' }, { status: 400 });
    }

    // Get current vehicle + user profile
    const [vehicleResult, profileResult] = await Promise.all([
      supabase.from('fleet_checkins').select('id, status').eq('id', vehicleId).single(),
      supabase.from('profiles').select('full_name, role').eq('id', user.id).single(),
    ]);

    if (vehicleResult.error || !vehicleResult.data) {
      return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 });
    }

    const currentStatus = vehicleResult.data.status;
    const userName = profileResult.data?.full_name || user.email || 'Unknown';

    // Update vehicle status
    const { error: updateError } = await supabase
      .from('fleet_checkins')
      .update({ status: newStatus })
      .eq('id', vehicleId);

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update status: ' + updateError.message }, { status: 500 });
    }

    // Log status change in history
    const { error: historyError } = await supabase
      .from('vehicle_status_history')
      .insert({
        vehicle_id: vehicleId,
        from_status: currentStatus,
        to_status: newStatus,
        note: note?.trim() || null,
        changed_by: user.id,
        changed_by_name: userName,
      });

    if (historyError) {
      console.error('Failed to log status history:', historyError);
    }

    return NextResponse.json({
      success: true,
      vehicleId,
      fromStatus: currentStatus,
      toStatus: newStatus,
    });
  } catch (err: any) {
    console.error('Vehicle tracking update error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
