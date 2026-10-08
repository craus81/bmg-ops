import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { markRequestsOrdered } from '@/lib/purchase-request-po-match';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  poNumber: z.string().trim().min(1, 'Enter the PO number').max(40),
});

/**
 * POST /api/purchase-requests/mark-ordered — an admin marks pending requests
 * ordered on a PO placed outside the queue (migration 349). The PO number is
 * required; the requests link to that NetSuite PO now if it's mirrored, or
 * after the next sync if not. Undo is /api/purchase-requests/unmatch.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;
  const admin = await requireAdmin(req);
  if (admin.error) return admin.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const res = await markRequestsOrdered(createServiceClient(), {
    ids: [...new Set(parsed.data.ids)],
    poNumber: parsed.data.poNumber,
    userId: admin.user.id,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({
    success: true,
    marked: res.result.marked,
    poNumber: res.result.po?.tranid || null,
    linked: !!res.result.po,
    notOnPo: res.result.notOnPo,
  });
}
