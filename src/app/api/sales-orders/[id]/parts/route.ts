import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff, requireAdmin, getProfileRoles, isAdminRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { loadSoPartsCover, currentPartItems } from '@/lib/so-parts-cover-server';

export const dynamic = 'force-dynamic';

const isNsId = (s: string) => /^\d{1,15}$/.test(s);

/**
 * GET /api/sales-orders/[id]/parts — is every part on this sales order on a
 * vendor PO or in stock (src/lib/so-parts-cover.ts). cover is null when the
 * order has no part lines, or is billed / closed / cancelled.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!isNsId(params.id)) return NextResponse.json({ error: 'Not a NetSuite sales order id' }, { status: 400 });
  try {
    const cover = (await loadSoPartsCover(createServiceClient(), [params.id])).get(params.id) || null;
    return NextResponse.json({ cover, canMark: isAdminRole(getProfileRoles(auth.profile)) });
  } catch (e: any) {
    return NextResponse.json({ error: `Couldn't check the parts: ${e?.message || e}` }, { status: 500 });
  }
}

const Schema = z.object({ mark: z.boolean() });

/**
 * POST /api/sales-orders/[id]/parts {mark} — an admin marks the order
 * "Parts ordered" by hand, or takes the mark off (migration 521). The mark
 * remembers the parts on the order now, so a part added later voids it.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  if (!isNsId(params.id)) return NextResponse.json({ error: 'Not a NetSuite sales order id' }, { status: 400 });
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const service = createServiceClient();
  const { data: so, error } = await service.from('netsuite_sales_orders').select('id').eq('netsuite_id', params.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!so) return NextResponse.json({ error: "FleetSuite hasn't copied this sales order from NetSuite yet. Try again in a couple of hours." }, { status: 404 });

  let patch: Record<string, unknown>;
  if (parsed.data.mark) {
    const { data: prof } = await service.from('profiles').select('full_name').eq('id', auth.user.id).maybeSingle();
    patch = {
      parts_marked_at: new Date().toISOString(),
      parts_marked_by: auth.user.id,
      parts_marked_by_name: (prof?.full_name as string) || null,
      parts_marked_items: await currentPartItems(service, so.id),
    };
  } else {
    patch = { parts_marked_at: null, parts_marked_by: null, parts_marked_by_name: null, parts_marked_items: null };
  }
  const { error: upErr } = await service.from('netsuite_sales_orders').update(patch).eq('id', so.id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  const cover = (await loadSoPartsCover(service, [params.id]).catch(() => new Map())).get(params.id) || null;
  return NextResponse.json({ success: true, cover });
}
