import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { syncInventoryQuantities } from '@/lib/inventory-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET  /api/inventory/refresh — when stock numbers last came from NetSuite.
 * POST /api/inventory/refresh — pull them now (the Inventory page's Refresh
 *      chip); the same sweep the 15-minute cron runs.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const { data } = await createServiceClient()
    .from('sync_state')
    .select('last_synced_at')
    .eq('sync_type', 'netsuite_inventory')
    .maybeSingle();
  return NextResponse.json({ lastSyncedAt: data?.last_synced_at || null });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  try {
    const result = await syncInventoryQuantities(createServiceClient());
    return NextResponse.json({ ...result, lastSyncedAt: new Date().toISOString() });
  } catch (e: any) {
    return NextResponse.json({ error: `Couldn't refresh from NetSuite: ${e.message}` }, { status: 502 });
  }
}
