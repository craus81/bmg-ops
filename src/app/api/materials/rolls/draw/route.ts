import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { materialKey, planDraw, type StockRoll } from '@/lib/roll-stock';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Draw stock off the shelf (R6-2) — the write half of "Log material from
 * plan". FIFO planning stays server-side so the tested allocator is the
 * only thing that decides which roll gets cut, and each decrement is a
 * GUARDED update: `.eq('remaining_qty', <what we read>)` means two people
 * logging the same job at once cannot both take the last thirty feet. A
 * roll that loses the race is reported back as contended rather than
 * silently over-drawn.
 *
 * Drawing NEVER fails the caller's material log: the job's consumption is
 * a fact whether or not the shelf count agrees, so a shortfall comes back
 * as information the card can show.
 */

const DrawSchema = z.object({
  materialName: z.string().min(1).max(200),
  kind: z.enum(['film', 'premask', 'ink']),
  quantity: z.number().min(0).max(100000),
  graphicsJobId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DrawSchema);
  if (parsed.error) return parsed.error;
  const { materialName, kind, quantity, graphicsJobId } = parsed.data;
  if (quantity <= 0) return NextResponse.json({ ok: true, drawn: 0, shortfall: 0, rollsTouched: 0 });

  const key = materialKey(materialName);
  const { data, error } = await service
    .from('material_rolls')
    .select('id, substrate_id, material_name, kind, unit, width_in, remaining_qty, received_at, status')
    .eq('kind', kind)
    .eq('status', 'open')
    .order('received_at')
    .order('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rolls: StockRoll[] = (data || [])
    .filter((r: any) => materialKey(r.material_name) === key)
    .map((r: any) => ({
      id: r.id,
      substrateId: r.substrate_id,
      materialName: r.material_name,
      kind: r.kind,
      unit: r.unit,
      widthIn: r.width_in != null ? Number(r.width_in) : null,
      remainingQty: Number(r.remaining_qty),
      receivedAt: r.received_at,
      status: r.status,
    }));

  const plan = planDraw(rolls, quantity);
  const byId = new Map(rolls.map(r => [r.id, r]));
  let drawn = 0;
  let touched = 0;
  const contended: string[] = [];

  for (const a of plan.allocations) {
    const before = byId.get(a.rollId)!;
    const after = Math.round((before.remainingQty - a.take) * 10) / 10;
    const { data: updated, error: upErr } = await service
      .from('material_rolls')
      .update({
        remaining_qty: after,
        status: after <= 0 ? 'depleted' : 'open',
        updated_at: new Date().toISOString(),
      })
      .eq('id', a.rollId)
      .eq('remaining_qty', before.remainingQty)
      .select('id');
    if (upErr) { contended.push(a.rollId); continue; }
    if (!updated || updated.length === 0) { contended.push(a.rollId); continue; }
    drawn = Math.round((drawn + a.take) * 10) / 10;
    touched++;
  }

  if (graphicsJobId && plan.allocations.length > 0) {
    // Point this job's most recent line for the material at the roll it
    // actually came off, so a decrement is traceable to its cause.
    const first = plan.allocations[0].rollId;
    const { data: line } = await service
      .from('graphics_job_materials')
      .select('id')
      .eq('graphics_job_id', graphicsJobId)
      .is('roll_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (line?.id) await service.from('graphics_job_materials').update({ roll_id: first }).eq('id', line.id);
  }

  return NextResponse.json({
    ok: true,
    drawn,
    shortfall: plan.shortfall,
    rollsTouched: touched,
    splitAcrossRolls: plan.splitAcrossRolls,
    contended: contended.length,
  });
}
