import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { loadSlaBoard } from '@/lib/invite-sla';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createServiceClient();

/**
 * GET /api/cni/invite-sla (R6-8) — every job still looking for an installer,
 * with each invite's state aged against the SLA. Worst first.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  try {
    return NextResponse.json(await loadSlaBoard(supabase));
  } catch (err: any) {
    console.error('cni invite SLA board failed:', err);
    return NextResponse.json({ error: err?.message || 'Failed' }, { status: 500 });
  }
}
