import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { computePartsReadiness } from '@/lib/parts-readiness';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.discriminatedUnion('action', [
  // Set one part's reserved quantity for a project (0 releases it).
  z.object({
    action: z.literal('set'),
    projectId: z.string().uuid(),
    itemNumber: z.string().trim().min(1).max(120),
    quantity: z.number().min(0).max(100000),
  }),
  // Reserve everything currently free that this project still needs.
  z.object({ action: z.literal('allocate_all'), projectId: z.string().uuid() }),
  // Free every active reservation this project holds.
  z.object({ action: z.literal('release_all'), projectId: z.string().uuid() }),
]);

async function setAllocation(projectId: string, itemNumber: string, quantity: number, userId: string) {
  if (quantity <= 0) {
    await service.from('part_allocations')
      .update({ status: 'released', released_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('item_number', itemNumber)
      .eq('status', 'reserved');
    return;
  }
  await service.from('part_allocations').upsert({
    project_id: projectId,
    item_number: itemNumber,
    quantity,
    status: 'reserved',
    released_at: null,
    created_by: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'project_id,item_number' });
}

/**
 * POST /api/upfit-projects/allocations — manage a project's stock
 * reservations. Returns the recomputed readiness so the card refreshes in
 * one round trip.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  if (body.action === 'set') {
    // Cap at what's actually free so a typo can't reserve phantom stock.
    const readiness = await computePartsReadiness(service, body.projectId);
    const row = readiness.parts?.find(p => p.item_number === body.itemNumber.toUpperCase());
    if (body.quantity > 0 && row) {
      const max = row.allocated + row.free;
      if (body.quantity > max) {
        return NextResponse.json({ error: `Only ${max} available to reserve for ${row.item_number} (free stock ${row.free} + already reserved ${row.allocated}).` }, { status: 422 });
      }
    }
    await setAllocation(body.projectId, body.itemNumber.toUpperCase(), body.quantity, auth.user!.id);
  } else if (body.action === 'allocate_all') {
    const readiness = await computePartsReadiness(service, body.projectId);
    if (!readiness.available) return NextResponse.json({ error: readiness.reason || 'Readiness unavailable' }, { status: 422 });
    for (const row of readiness.parts || []) {
      if (row.allocatable <= 0) continue;
      await setAllocation(body.projectId, row.item_number, row.allocated + row.allocatable, auth.user!.id);
    }
  } else {
    await service.from('part_allocations')
      .update({ status: 'released', released_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('project_id', body.projectId)
      .eq('status', 'reserved');
  }

  const readiness = await computePartsReadiness(service, body.projectId);
  return NextResponse.json(readiness);
}
