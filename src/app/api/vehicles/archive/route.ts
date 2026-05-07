import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const Schema = z.object({
  vehicleId: z.string().uuid(),
  unarchive: z.boolean().optional(),
});

/**
 * POST /api/vehicles/archive
 * Archives or unarchives a fleet_checkins vehicle.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { vehicleId, unarchive } = parsed.data;

  try {

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
