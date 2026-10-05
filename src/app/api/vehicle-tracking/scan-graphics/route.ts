import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { scanCheckinForGraphics } from '@/lib/graphics-scan';

const serviceSupabase = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({ vehicleId: z.string().uuid() });

/**
 * POST /api/vehicle-tracking/scan-graphics { vehicleId }
 *
 * Scans the vehicle's linked NetSuite sales orders and estimate for graphics
 * lines (vinyl, Graphics Install Labor, …) so the status row can show the
 * Graphics steps. Called after an SO is linked and when a never-scanned
 * vehicle is opened on In-Shop. See src/lib/graphics-scan.ts.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  try {
    const result = await scanCheckinForGraphics(serviceSupabase, parsed.data.vehicleId);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error('scan-graphics error:', err);
    return NextResponse.json({ error: 'Scan failed' }, { status: 500 });
  }
}
