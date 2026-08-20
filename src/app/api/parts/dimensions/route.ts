import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const dim = z.coerce.number().min(0.5).max(300);

const PatchSchema = z.object({
  partId: z.string().uuid(),
  /** W×D×H travel together: a partial set can't place a part in 3D, so the
   *  API refuses to store one. null (all three) clears the dims. */
  widthIn: dim.nullable(),
  depthIn: dim.nullable(),
  heightIn: dim.nullable(),
  weightLb: z.coerce.number().min(0.1).max(2000).optional().nullable(),
  mountType: z.enum(['floor', 'wall', 'door', 'partition', 'ceiling', 'accessory']).optional().nullable(),
});

/**
 * PATCH /api/parts/dimensions — author a part's installed footprint for the
 * 3D upfit designer (migration 213). Values written here are stamped
 * dims_source='manual', which the vendor-site import and the PDF-vision
 * script never overwrite — a human's tape measure outranks a scrape.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const { partId, widthIn, depthIn, heightIn, weightLb, mountType } = parsed.data;

  const dims = [widthIn, depthIn, heightIn];
  const allSet = dims.every(d => d != null);
  const allNull = dims.every(d => d == null);
  if (!allSet && !allNull) {
    return NextResponse.json({ error: 'Width, depth, and height must be set together (or all cleared)' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {
    width_in: widthIn,
    depth_in: depthIn,
    height_in: heightIn,
    dims_source: allSet ? 'manual' : null,
  };
  if (weightLb !== undefined) updates.weight_lb = weightLb;
  if (mountType !== undefined) updates.mount_type = mountType;

  const { error } = await supabase.from('netsuite_parts').update(updates).eq('id', partId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
