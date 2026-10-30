import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { adjustInventory, adjustLocationId, liveLocationStock } from '@/lib/inventory-adjust';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/inventory/adjust?netsuiteId=123
 *   NetSuite's live O'Fallon on hand / available for the Adjust pop-up, and
 *   the part's recent adjustments.
 *
 * POST /api/inventory/adjust { netsuiteId, mode: 'delta'|'count', qty, reason, note }
 *   Posts a NetSuite Inventory Adjustment (src/lib/inventory-adjust.ts).
 *
 * Admins only (Craig 2026-10-30: admins plus Jessie, who is an admin).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const netsuiteId = req.nextUrl.searchParams.get('netsuiteId') || '';
  if (!/^\d+$/.test(netsuiteId)) return NextResponse.json({ error: 'netsuiteId required' }, { status: 400 });

  const service = createServiceClient();
  const { data: history } = await service
    .from('inventory_adjustments')
    .select('id, change, reason, note, netsuite_adjustment_number, created_by_name, created_at')
    .eq('netsuite_item_id', netsuiteId)
    .order('created_at', { ascending: false })
    .limit(10);

  try {
    const stock = await liveLocationStock(netsuiteId, await adjustLocationId());
    return NextResponse.json({ ...stock, history: history || [] });
  } catch (e: any) {
    return NextResponse.json({ error: `Couldn't read the current count from NetSuite: ${e.message}`, history: history || [] }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const result = await adjustInventory(createServiceClient(), {
    netsuiteId: String(body?.netsuiteId ?? ''),
    mode: body?.mode,
    qty: Number(body?.qty),
    reason: String(body?.reason ?? ''),
    note: typeof body?.note === 'string' ? body.note.slice(0, 500) : null,
    userId: auth.user!.id,
    userName: auth.profile?.full_name || null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
