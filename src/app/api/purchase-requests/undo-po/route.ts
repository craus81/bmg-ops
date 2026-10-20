import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { undoCreatedPoOrder } from '@/lib/po-undo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(50) });

/**
 * POST /api/purchase-requests/undo-po — take a part ordered with Create PO
 * back off its NetSuite PO and put its requests back in the queue
 * (po-undo.ts). `ids` are the requests one PO line holds.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;
  const admin = await requireAdmin(req);
  if (admin.error) return admin.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const res = await undoCreatedPoOrder(createServiceClient(), parsed.data.ids);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ success: true, ...res });
}
