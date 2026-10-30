import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { syncInventoryQuantities } from '@/lib/inventory-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET /api/cron/inventory-sync
 *
 * On hand / available from NetSuite every 15 minutes (Craig 2026-10-30,
 * "quicker inventory data"). Split out of the 2-hour netsuite-sync cron;
 * one SuiteQL read, and only changed parts are written.
 */
export async function GET(req: NextRequest) {
  // Allow Vercel Cron with the shared secret; anyone else needs an admin
  // session (manual trigger from the app). Fails closed if CRON_SECRET is
  // not configured.
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const result = await syncInventoryQuantities(createServiceClient());
    return NextResponse.json({ status: 'ok', ...result });
  } catch (err: any) {
    console.error('[cron] Inventory sweep error:', err.message);
    return NextResponse.json({ status: 'error', error: err.message }, { status: 500 });
  }
}
