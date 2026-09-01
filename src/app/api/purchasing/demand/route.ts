import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { computePartsDemand } from '@/lib/parts-demand';

export const dynamic = 'force-dynamic';
// Several paginated reads plus a chunked catalog lookup — the platform
// default is too tight when the open-job list is large.
export const maxDuration = 60;

/**
 * GET /api/purchasing/demand — every part needed to finish all open jobs,
 * rolled up by part number (src/lib/parts-demand.ts).
 *
 * Reads the synced NetSuite sales-order mirror and customer-approved
 * estimates that haven't become sales orders. Inventory is deliberately
 * NOT netted out; "on order" rides along as its own figure so the shop can
 * see what's covered without it being subtracted from the need.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;

  try {
    const result = await computePartsDemand(createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    ));
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    // A partial read would understate a number somebody orders against, so
    // the computation fails loudly rather than returning most of the truth.
    console.error('parts demand failed:', err?.message || err);
    return NextResponse.json(
      { error: String(err?.message || 'Could not build the parts demand list') },
      { status: 500 },
    );
  }
}
