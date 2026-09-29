import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature, requireAdmin } from '@/lib/api-auth';
import { autoMatchPurchaseRequests } from '@/lib/purchase-request-po-match';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/purchase-requests/match-pos — run the request → NetSuite PO
 * match now (it also runs after every vendor PO sync and Parts Mail scan).
 * Admin only: it marks requests ordered.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;
  const admin = await requireAdmin(req);
  if (admin.error) return admin.error;

  const result = await autoMatchPurchaseRequests(createServiceClient());
  if (result.error) return NextResponse.json({ error: result.error, ...result }, { status: 500 });
  return NextResponse.json({ success: true, ...result });
}
