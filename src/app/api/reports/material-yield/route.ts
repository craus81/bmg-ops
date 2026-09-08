import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import { summarizeYield, yieldTotals, type YieldLine } from '@/lib/material-yield';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Material yield & scrap (R6-6): how much of every roll actually ended up
 * as graphic. Reads the logged material lines, which have carried the roll
 * area since R6-1 and the graphic area since this round.
 *
 * Coverage is reported, never hidden: lines with no recorded graphic area
 * are counted separately rather than being scored as total waste.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'graphics_production', 'sales']);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, z.object({
    start: z.string().regex(DATE_RE).optional(),
    end: z.string().regex(DATE_RE).optional(),
  }));
  if (q.error) return q.error;

  const end = q.data.end || new Date().toISOString().slice(0, 10);
  const start = q.data.start || new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const endNext = new Date(new Date(end + 'T00:00:00Z').getTime() + 86_400_000).toISOString().slice(0, 10);

  try {
    const { data, error } = await fetchAllRows<any>((from, to) => service
      .from('graphics_job_materials')
      .select('graphics_job_id, material_name, substrate_id, category, quantity_sqft, graphic_sqft, cost, created_at')
      // Only roll-billed categories can have scrap: premask and ink bill on
      // graphic area, where waste is not a concept.
      .in('category', ['vinyl', 'laminate'])
      .gte('created_at', start)
      .lt('created_at', endNext)
      .order('created_at').order('id')
      .range(from, to));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const lines: YieldLine[] = (data || []).map((m: any) => ({
      materialName: m.material_name,
      substrateId: m.substrate_id,
      rollSqft: m.quantity_sqft != null ? Number(m.quantity_sqft) : null,
      graphicSqft: m.graphic_sqft != null ? Number(m.graphic_sqft) : null,
      cost: m.cost != null ? Number(m.cost) : null,
    }));

    const films = summarizeYield(lines);
    const totals = yieldTotals(films);
    const jobs = new Set((data || []).map((m: any) => m.graphics_job_id));

    return NextResponse.json({
      range: { start, end },
      films,
      totals,
      jobsCovered: jobs.size,
      // Yield only exists for lines the roll plan wrote; say so plainly.
      note: totals.measuredLines === 0
        ? 'No line in this window recorded both roll and graphic area — log material from a roll plan and yield starts accruing.'
        : null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Report failed' }, { status: 500 });
  }
}
