import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { unmatchPurchaseRequest } from '@/lib/purchase-request-po-match';

export const dynamic = 'force-dynamic';

const Schema = z.object({ id: z.string().uuid() });

/**
 * POST /api/purchase-requests/unmatch — undo an automatic PO match. The
 * request goes back to pending (any split-off remainder folds back in) and
 * won't be matched to that PO again.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;
  const admin = await requireAdmin(req);
  if (admin.error) return admin.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const res = await unmatchPurchaseRequest(createServiceClient(), parsed.data.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ success: true });
}
