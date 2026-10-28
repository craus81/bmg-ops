import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { fleetMembers } from '@/lib/estimate-fleet';
import { fleetJobFor, noteFleetKitsChanged } from '@/lib/graphics-fleet';
import { estimateIsLocked } from '@/lib/estimate-copy';
import { estimateCustomerKey } from '@/lib/estimate-batch';
import { validateBody, z } from '@/lib/validate';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

/**
 * GET /api/estimates/[id]/fleet-group — the other estimates of this
 * estimate's fleet order (migration 410), for the builder's Fleet group
 * strip, with the order's graphics job (migration 411) if it has one. An
 * estimate in no group answers an empty list. `joinable` is the same
 * customer's other estimates that could join it (see POST).
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  try {
    const { data: est } = await supabase.from('estimates').select(`id, fleet_group_id, ${CUSTOMER_COLUMNS}`).eq('id', params.id).maybeSingle();
    if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    const joinable = await joinableFor(est);
    if (!est.fleet_group_id) return NextResponse.json({ groupId: null, members: [], joinable });
    const [members, job] = await Promise.all([
      fleetMembers(supabase, est.fleet_group_id),
      fleetJobFor(supabase, est.fleet_group_id),
    ]);
    return NextResponse.json({ groupId: est.fleet_group_id, members, job, joinable });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

const CUSTOMER_COLUMNS = 'customer_id, prospect_id, customer_netsuite_id, customer_name';
const JOINABLE_COLUMNS = `id, estimate_number, title, unit_number, grand_total, status, customer_approved, netsuite_so_id, fleet_group_id, created_at, ${CUSTOMER_COLUMNS}`;

/**
 * The same customer's estimates that can join this one's fleet order: in no
 * order yet and still open (not approved, not on a sales order). Newest
 * first, at most 50.
 */
async function joinableFor(est: any): Promise<any[]> {
  let q = supabase.from('estimates').select(JOINABLE_COLUMNS).is('fleet_group_id', null).neq('id', est.id);
  if (est.customer_id) q = q.eq('customer_id', est.customer_id);
  else if (est.prospect_id) q = q.eq('prospect_id', est.prospect_id);
  else if (est.customer_netsuite_id) q = q.eq('customer_netsuite_id', est.customer_netsuite_id);
  else if (est.customer_name) q = q.ilike('customer_name', String(est.customer_name).trim());
  else return [];
  const { data } = await q.order('created_at', { ascending: false }).limit(80);
  return (data || [])
    .filter(e => !estimateIsLocked(e) && e.status !== 'rejected' && estimateCustomerKey(e) === estimateCustomerKey(est))
    .slice(0, 50)
    .map(e => ({ id: e.id, estimate_number: e.estimate_number, title: e.title, unit_number: e.unit_number, grand_total: e.grand_total, status: e.status }));
}

const JoinSchema = z.object({ joinIds: z.array(z.string().uuid()).min(1).max(25) });

/**
 * POST /api/estimates/[id]/fleet-group — join estimates that were built on
 * their own into this one's fleet order (Craig, 2026-10-28, thread "Bulk
 * email estimates to customers"), starting an order when this estimate has
 * none. From then on they are one order exactly as if made with "Copy for
 * more vehicles": Send for Approval offers them all in one email, and the
 * order's graphics job has a kit for each. Only the same customer's open
 * estimates that are in no other order can join.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, JoinSchema);
  if (parsed.error) return parsed.error;
  const joinIds = [...new Set(parsed.data.joinIds.filter(id => id !== params.id))];
  if (joinIds.length === 0) return NextResponse.json({ error: 'Pick another estimate to join.' }, { status: 400 });

  try {
    const { data: est } = await supabase.from('estimates').select(`id, estimate_number, fleet_group_id, ${CUSTOMER_COLUMNS}`).eq('id', params.id).maybeSingle();
    if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    const { data: rows, error: loadErr } = await supabase.from('estimates').select(JOINABLE_COLUMNS).in('id', joinIds);
    if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
    const byId = new Map((rows || []).map(r => [r.id, r]));
    for (const id of joinIds) {
      const e = byId.get(id);
      if (!e) return NextResponse.json({ error: 'One of the picked estimates no longer exists. Reload and try again.' }, { status: 404 });
      if (estimateCustomerKey(e) !== estimateCustomerKey(est)) {
        return NextResponse.json({ error: `${e.estimate_number} is for ${e.customer_name || 'another customer'}. Only ${est.customer_name || 'this customer'}'s estimates can join.` }, { status: 400 });
      }
      if (estimateIsLocked(e)) {
        return NextResponse.json({ error: `${e.estimate_number} is approved or on a sales order, so it can't join an order.` }, { status: 400 });
      }
      if (e.fleet_group_id && e.fleet_group_id !== est.fleet_group_id) {
        return NextResponse.json({ error: `${e.estimate_number} is already in another fleet order. Take it out of that one first.` }, { status: 400 });
      }
    }

    const groupId: string = est.fleet_group_id || randomUUID();
    if (!est.fleet_group_id) {
      const { error } = await supabase.from('estimates').update({ fleet_group_id: groupId }).eq('id', est.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const { error: joinErr } = await supabase.from('estimates').update({ fleet_group_id: groupId }).in('id', joinIds);
    if (joinErr) return NextResponse.json({ error: joinErr.message }, { status: 500 });

    const joined = joinIds.map(id => byId.get(id)!);
    await noteFleetKitsChanged(
      supabase,
      groupId,
      `${joined.map(e => `${e.estimate_number} (unit ${e.unit_number || '?'})`).join(', ')} joined the fleet order.`,
      auth.user.id,
    );
    for (const e of joined) {
      await logAudit(supabase, {
        actorId: auth.user.id,
        table: 'estimates',
        recordId: e.id,
        action: 'estimate_joined_fleet_group',
        detail: { fleet_group_id: groupId, estimate_number: e.estimate_number, joined_to: est.estimate_number },
      });
    }
    return NextResponse.json({ success: true, groupId, joined: joined.length });
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
    const { data: est } = await supabase.from('estimates').select('id, estimate_number, unit_number, fleet_group_id').eq('id', params.id).maybeSingle();
    if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    if (!est.fleet_group_id) return NextResponse.json({ success: true });
    const { error } = await supabase.from('estimates').update({ fleet_group_id: null }).eq('id', est.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await noteFleetKitsChanged(supabase, est.fleet_group_id, `${est.estimate_number} (unit ${est.unit_number || '?'}) was taken out of the fleet order.`, auth.user.id);
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
