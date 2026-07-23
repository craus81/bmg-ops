import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { syncVendorPos } from '@/lib/vendor-po-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/parts-mail/sync-pos — admin-triggered vendor-PO sync from NetSuite,
 * the very job the 2-hour cron runs (step 3b). Exposed here so "no PO matches"
 * can be diagnosed and fixed on the spot: it returns how many POs moved this
 * run and — the number that matters — how many vendor POs are on file at all.
 * A totalPos of 0 means the sync isn't pulling from NetSuite (a sync problem),
 * not that the typed PO number is wrong.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  try {
    const result = await syncVendorPos(service);
    const { count } = await service
      .from('netsuite_vendor_pos')
      .select('*', { count: 'exact', head: true });
    return NextResponse.json({
      ok: true,
      synced: result.synced,
      lines: result.lines,
      modified: result.modified,
      totalPos: count ?? 0,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err).slice(0, 300) },
      { status: 500 },
    );
  }
}
