import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { computeEstimateReadiness } from '@/lib/estimate-readiness';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/estimates/parts-readiness — "can we build what we just quoted?"
 *
 * A POST rather than a GET because the lines come from the builder's current
 * state, not from the last save: someone checking stock has usually just
 * finished typing, and answering about the saved copy would be answering the
 * wrong question. `estimateId` is optional and only decides which holds count
 * as this estimate's own, so an unsaved estimate still gets a real answer.
 */
const Schema = z.object({
  estimateId: z.string().uuid().nullish(),
  vehicleCount: z.number().int().min(1).max(10000).optional(),
  lines: z.array(z.object({
    item_number: z.string().trim().max(120).nullish(),
    quantity: z.union([z.number(), z.string()]).nullish(),
  })).max(500),
});

export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { estimateId, vehicleCount, lines } = parsed.data;

  try {
    const readiness = await computeEstimateReadiness(service, {
      estimateId: estimateId || null,
      lines,
      vehicleCount: vehicleCount ?? 1,
    });
    return NextResponse.json(readiness);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Stock check failed' }, { status: 500 });
  }
}
