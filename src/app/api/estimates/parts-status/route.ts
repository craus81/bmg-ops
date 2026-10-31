import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { loadEstimatePartsStages } from '@/lib/estimate-parts-status';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * POST /api/estimates/parts-status — the Approved / Parts ordered / Parts in
 * stock tag for each estimate given (see src/lib/estimate-parts-stage.ts).
 * Estimates with no tag (not approved, or the job is billed) are left out.
 *
 * One id = the estimate page's banner: stock is asked of NetSuite live. More
 * = a list: stock comes from the mirror and at most 40 stock checks run.
 */
const Schema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { ids } = parsed.data;

  try {
    const single = ids.length === 1;
    const stages = await loadEstimatePartsStages(service, ids, {
      liveStock: single,
      maxStockChecks: single ? 1 : 40,
    });
    return NextResponse.json({ stages });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Could not load parts status' }, { status: 500 });
  }
}
