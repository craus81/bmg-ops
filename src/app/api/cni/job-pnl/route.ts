import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { loadJobPnl } from '@/lib/cni-pnl';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/cni/job-pnl?jobId=… (R6-8) — one job's revenue, installer cost,
 * margin BEFORE materials, and budget standing, per job and per vehicle.
 * Every figure the numbers cannot see is returned in `caveats`.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, z.object({ jobId: z.string().uuid() }));
  if (q.error) return q.error;

  try {
    const pnl = await loadJobPnl(supabase, q.data.jobId);
    if (!pnl) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    return NextResponse.json(pnl);
  } catch (err: any) {
    console.error('cni job P&L failed:', err);
    return NextResponse.json({ error: err?.message || 'Failed' }, { status: 500 });
  }
}
