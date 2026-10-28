import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import {
  ORDER_STATUS_ESTIMATE_COLUMNS, ensureOrderStatusToken, isEstimateApproved, loadOrderStatus, orderStatusUrl,
} from '@/lib/order-status-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/estimates/[id]/order-status — the rep's view of the customer's
 * Order status page (migration 449): the link (minted on first look once
 * the estimate is approved), where the page stands, and who sent the
 * approval confirmation / marked all parts in.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  const supabase = createServiceClient();

  const { data: estimate } = await supabase
    .from('estimates')
    .select(ORDER_STATUS_ESTIMATE_COLUMNS)
    .eq('id', params.id)
    .maybeSingle();
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  const est = estimate as any;
  if (!isEstimateApproved(est)) return NextResponse.json({ approved: false });

  const nameIds = [est.approval_confirmation_sent_by, est.parts_all_in_by].filter(Boolean);
  const [token, view, { data: people }] = await Promise.all([
    ensureOrderStatusToken(supabase, est),
    loadOrderStatus(supabase, est),
    nameIds.length
      ? supabase.from('profiles').select('id, full_name').in('id', nameIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const nameOf = (id: string | null) => (people || []).find((p: any) => p.id === id)?.full_name || null;

  return NextResponse.json({
    approved: true,
    url: orderStatusUrl(token),
    approvedBy: est.customer_responder || null,
    confirmation: est.approval_confirmation_sent_at
      ? { at: est.approval_confirmation_sent_at, by: nameOf(est.approval_confirmation_sent_by) }
      : null,
    partsAllIn: est.parts_all_in_at ? { at: est.parts_all_in_at, by: nameOf(est.parts_all_in_by) } : null,
    ...view,
  });
}
