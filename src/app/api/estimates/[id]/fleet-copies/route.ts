import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { copyEstimate, estimateIsLocked } from '@/lib/estimate-copy';
import { fleetMembers, unitKey } from '@/lib/estimate-fleet';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  vehicles: z.array(z.object({
    unitNumber: z.string().trim().min(1, 'Every vehicle needs a unit number').max(40),
    vin: z.string().trim().max(17).optional().nullable(),
  })).min(1).max(25),
  /** The estimate's own unit number, when it has none yet. */
  sourceUnitNumber: z.string().trim().max(40).optional().nullable(),
  /** One customer PO for the whole order: every copy keeps it. */
  keepPo: z.boolean().optional(),
});

/**
 * POST /api/estimates/[id]/fleet-copies — "Copy for more vehicles"
 * (Craig, 2026-10-19). The same build on several vehicles gets one
 * estimate per vehicle, since each becomes its own sales order and work
 * order. This makes the copies in one step, each with its unit number and
 * VIN, and puts them and the source in one fleet group (migration 410).
 *
 * Copies are always new drafts, never revisions, whatever the source's
 * state: an approved estimate for unit 101 can be copied for unit 102.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { vehicles, keepPo } = parsed.data;

  try {
    const { data: source } = await supabase
      .from('estimates')
      .select('id, estimate_number, unit_number, fleet_group_id, customer_approved, status, netsuite_so_id')
      .eq('id', params.id)
      .maybeSingle();
    if (!source) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

    // The source needs a unit number too, or the group can't tell its
    // vehicles apart. A locked estimate keeps what it has.
    let sourceUnit = String(source.unit_number || '').trim();
    const givenSourceUnit = String(parsed.data.sourceUnitNumber || '').trim();
    if (!sourceUnit && givenSourceUnit && !estimateIsLocked(source)) sourceUnit = givenSourceUnit;
    if (!sourceUnit) {
      return NextResponse.json({ error: `Give ${source.estimate_number} its own unit number first.` }, { status: 400 });
    }

    const groupId: string = source.fleet_group_id || randomUUID();
    const existing = source.fleet_group_id ? await fleetMembers(supabase, groupId) : [];
    const taken = new Set([sourceUnit, ...existing.map(m => m.unit_number)].map(unitKey).filter(Boolean));
    const repeats: string[] = [];
    for (const v of vehicles) {
      const k = unitKey(v.unitNumber);
      if (taken.has(k)) repeats.push(v.unitNumber);
      taken.add(k);
    }
    if (repeats.length > 0) {
      return NextResponse.json({ error: `Unit ${repeats.join(', ')} is already in this order. Each vehicle needs its own unit number.` }, { status: 400 });
    }

    const sourceUpdate: Record<string, any> = {};
    if (!source.fleet_group_id) sourceUpdate.fleet_group_id = groupId;
    if (sourceUnit !== String(source.unit_number || '').trim()) sourceUpdate.unit_number = sourceUnit;
    if (Object.keys(sourceUpdate).length > 0) {
      const { error } = await supabase.from('estimates').update(sourceUpdate).eq('id', source.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // One at a time: estimate numbers come from a sequence, and a failure
    // part way still leaves the copies already made in the group.
    const created: Array<{ id: string; estimate_number: string; unit_number: string }> = [];
    for (const v of vehicles) {
      const vin = String(v.vin || '').trim().toUpperCase() || null;
      const r = await copyEstimate(supabase, source.id, auth.user.id, {
        groupId,
        unitNumber: v.unitNumber,
        vin,
        keepPo: !!keepPo,
      });
      if (r.status >= 400) {
        const made = created.map(c => c.estimate_number).join(', ');
        return NextResponse.json({
          error: `Stopped at unit ${v.unitNumber}: ${r.body?.error || 'unknown error'}.${made ? ` Already made: ${made}.` : ''}`,
          created,
          groupId,
        }, { status: r.status });
      }
      created.push({ id: r.body.id, estimate_number: r.body.estimate_number, unit_number: v.unitNumber });
    }

    return NextResponse.json({ success: true, groupId, created });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
