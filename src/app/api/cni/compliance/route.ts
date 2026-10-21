import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { loadComplianceOverview } from '@/lib/cni-compliance';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createServiceClient();

/**
 * GET /api/cni/compliance (R6-8)
 *
 * Every company and installer with their computed eligibility, worst first.
 * Nothing is cached — a stored flag would go stale the night a certificate
 * expired. Document PATHS are deliberately not returned: this answers "are
 * they eligible", not "hand me the files".
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  try {
    return NextResponse.json(await loadComplianceOverview(supabase));
  } catch (err: any) {
    console.error('cni compliance overview failed:', err);
    return NextResponse.json({ error: err?.message || 'Failed' }, { status: 500 });
  }
}
