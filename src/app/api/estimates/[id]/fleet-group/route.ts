import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { fleetMembers } from '@/lib/estimate-fleet';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/estimates/[id]/fleet-group — the other estimates of this
 * estimate's fleet order (migration 410), for the builder's Fleet group
 * strip. An estimate in no group answers an empty list.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  try {
    const { data: est } = await supabase.from('estimates').select('id, fleet_group_id').eq('id', params.id).maybeSingle();
    if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    if (!est.fleet_group_id) return NextResponse.json({ groupId: null, members: [] });
    const members = await fleetMembers(supabase, est.fleet_group_id);
    return NextResponse.json({ groupId: est.fleet_group_id, members });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * DELETE /api/estimates/[id]/fleet-group — take this estimate out of its
 * fleet order (it was added by mistake, or this vehicle's build changed).
 * The other estimates stay grouped.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  try {
    const { data: est } = await supabase.from('estimates').select('id, estimate_number, fleet_group_id').eq('id', params.id).maybeSingle();
    if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    if (!est.fleet_group_id) return NextResponse.json({ success: true });
    const { error } = await supabase.from('estimates').update({ fleet_group_id: null }).eq('id', est.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'estimates',
      recordId: est.id,
      action: 'estimate_left_fleet_group',
      detail: { fleet_group_id: est.fleet_group_id, estimate_number: est.estimate_number },
    });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
