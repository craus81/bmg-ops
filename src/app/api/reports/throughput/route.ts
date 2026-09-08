import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { loadThroughput, PIPELINES, type PipelineKey } from '@/lib/throughput';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/throughput?pipeline=vehicles|graphics|cni&days=N (R6-12)
 *
 * Cycle-time and throughput over one pipeline's status history: per-stage
 * median and p90 dwell, the bottleneck (only with enough samples to mean
 * anything), turnaround trended by month, rework from backward transitions
 * with their typed reasons, plus per-person completions (graphics) and
 * arrival-forecast accuracy (vehicles).
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const params = req.nextUrl.searchParams;
  const key = params.get('pipeline') || 'vehicles';
  if (!(key in PIPELINES)) return NextResponse.json({ error: 'unknown pipeline' }, { status: 400 });

  const rawDays = Number(params.get('days'));
  const days = Number.isFinite(rawDays) && rawDays >= 7 && rawDays <= 730 ? Math.floor(rawDays) : 180;
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const report = await loadThroughput(supabase, key as PipelineKey, sinceIso);
    return NextResponse.json({ ...report, days });
  } catch (err: any) {
    console.error('throughput report failed:', err);
    return NextResponse.json({ error: err?.message || 'Report failed' }, { status: 500 });
  }
}
