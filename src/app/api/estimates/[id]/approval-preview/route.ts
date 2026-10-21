import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { loadEstimateApprovalView } from '@/lib/estimate-approval-view';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createServiceClient();
}

/**
 * GET /api/estimates/[id]/approval-preview — the estimate exactly as the
 * customer's approval page shows it, for the staff preview.
 *
 * Keyed by estimate id behind the estimates feature gate, never by the approval token:
 * the token stays server-side (see stripApprovalSecrets in the estimates
 * route) so a staff holder can't open the customer's page and forge an
 * E-SIGN acceptance. Read-only — there is no POST here; approving is the
 * customer's action on their own link.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const view = await loadEstimateApprovalView(getSupabase(), params.id);
  if (!view) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json(view);
}
