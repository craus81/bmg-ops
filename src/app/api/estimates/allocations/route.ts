import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { computeEstimateReadiness, type EstimateReadinessLine } from '@/lib/estimate-readiness';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/estimates/allocations — hold stock for a quote, or let it go.
 *
 * The mirror of /api/upfit-projects/allocations, with the same two safety
 * rails: a reservation is capped at what is genuinely free (a typo must not
 * be able to hold stock that isn't there), and the recomputed readiness
 * comes back in the same round trip so the panel can't show a stale number
 * right after you changed it.
 *
 * Lines ride along because reserving happens from the builder, against what
 * is on screen — see the readiness route for why that is the honest input.
 */
const LineSchema = z.object({
  item_number: z.string().trim().max(120).nullish(),
  quantity: z.union([z.number(), z.string()]).nullish(),
});

const Schema = z.discriminatedUnion('action', [
  // Set one part's held quantity for this estimate (0 releases it).
  z.object({
    action: z.literal('set'),
    estimateId: z.string().uuid(),
    vehicleCount: z.number().int().min(1).max(10000).optional(),
    lines: z.array(LineSchema).max(500),
    itemNumber: z.string().trim().min(1).max(120),
    quantity: z.number().min(0).max(100000),
  }),
  // Hold everything currently free that this estimate still needs.
  z.object({
    action: z.literal('allocate_all'),
    estimateId: z.string().uuid(),
    vehicleCount: z.number().int().min(1).max(10000).optional(),
    lines: z.array(LineSchema).max(500),
  }),
  // Free every hold this estimate has.
  z.object({
    action: z.literal('release_all'),
    estimateId: z.string().uuid(),
    vehicleCount: z.number().int().min(1).max(10000).optional(),
    lines: z.array(LineSchema).max(500),
  }),
]);

async function setAllocation(estimateId: string, itemNumber: string, quantity: number, userId: string) {
  if (quantity <= 0) {
    await service.from('part_allocations')
      .update({ status: 'released', released_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('estimate_id', estimateId)
      .eq('item_number', itemNumber)
      .eq('status', 'reserved');
    return;
  }
  await service.from('part_allocations').upsert({
    estimate_id: estimateId,
    project_id: null,
    item_number: itemNumber,
    quantity,
    status: 'reserved',
    released_at: null,
    created_by: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'estimate_id,item_number' });
}

/**
 * A quote can only hold stock while it is still a live quote. Once it has a
 * sales order the upfit project's readiness card owns the reservation, and a
 * rejected quote has no claim on anything — migration 320's trigger releases
 * both, so letting a new hold in afterwards would quietly recreate the
 * double-count the trigger exists to prevent.
 */
async function assertHoldable(estimateId: string): Promise<string | null> {
  const { data: est } = await service
    .from('estimates')
    .select('id, estimate_number, status, netsuite_so_id, netsuite_so_number')
    .eq('id', estimateId)
    .maybeSingle();
  if (!est) return 'Estimate not found.';
  if (est.netsuite_so_id) {
    return `${est.estimate_number} is already a sales order (${est.netsuite_so_number || est.netsuite_so_id}) — reserve its parts on the upfit project instead.`;
  }
  if (est.status === 'rejected') return `${est.estimate_number} was rejected, so it can't hold stock.`;
  return null;
}

export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const readinessInput = {
    estimateId: body.estimateId,
    lines: body.lines as EstimateReadinessLine[],
    vehicleCount: body.vehicleCount ?? 1,
  };

  if (body.action === 'release_all') {
    await service.from('part_allocations')
      .update({ status: 'released', released_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('estimate_id', body.estimateId)
      .eq('status', 'reserved');
  } else {
    const blocked = await assertHoldable(body.estimateId);
    if (blocked) return NextResponse.json({ error: blocked }, { status: 422 });

    const readiness = await computeEstimateReadiness(service, readinessInput);

    if (body.action === 'set') {
      const itemNumber = body.itemNumber.trim().toUpperCase();
      const row = readiness.parts.find(p => p.item_number === itemNumber);
      if (body.quantity > 0) {
        if (!row) {
          return NextResponse.json({ error: `${itemNumber} isn't a line on this estimate.` }, { status: 422 });
        }
        if (row.uncatalogued) {
          return NextResponse.json({ error: `${itemNumber} isn't in the parts catalog, so there's no stock to hold.` }, { status: 422 });
        }
        const max = row.allocated + row.free;
        if (body.quantity > max) {
          return NextResponse.json({ error: `Only ${max} available to reserve for ${itemNumber} (free stock ${row.free} + already held ${row.allocated}).` }, { status: 422 });
        }
      }
      await setAllocation(body.estimateId, itemNumber, body.quantity, auth.user!.id);
    } else {
      for (const row of readiness.parts) {
        if (row.allocatable <= 0) continue;
        await setAllocation(body.estimateId, row.item_number, row.allocated + row.allocatable, auth.user!.id);
      }
    }
  }

  const readiness = await computeEstimateReadiness(service, readinessInput);
  return NextResponse.json(readiness);
}
