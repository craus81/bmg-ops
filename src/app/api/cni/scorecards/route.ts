import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { loadCniScorecards } from '@/lib/cni-scorecards';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * GET /api/cni/scorecards (R5-12): auto-computed installer + company
 * scorecards from raw CNI history — current 90 days with the prior 90 as
 * trend. Computed live (small tables, full history available immediately);
 * consumed by the roster, the bid-review page, and the companies list.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  try {
    const cards = await loadCniScorecards(service);
    return NextResponse.json(cards);
  } catch (e: any) {
    console.error('cni scorecards failed:', e);
    return NextResponse.json({ error: e.message || 'Scorecards failed' }, { status: 500 });
  }
}
