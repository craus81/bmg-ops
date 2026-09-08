import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { materialKey } from '@/lib/roll-stock';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Reorder policy per material (R6-2). Reading is staff — the printer
 * operator should see the point they're running against; setting it is
 * admin, since a point is what makes the nightly sweep spend money.
 */

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { data, error } = await service
    .from('material_stock_settings')
    .select('id, kind, material_key, material_name, substrate_id, unit, reorder_at, order_up_to, vendor_name, item_number, updated_at')
    .order('material_name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ settings: data || [] });
}

const UpsertSchema = z.object({
  kind: z.enum(['film', 'premask', 'ink']),
  materialName: z.string().min(1).max(200),
  substrateId: z.string().uuid().nullable().optional(),
  /** null = watched but never auto-ordered (the parts reorder semantics). */
  reorderAt: z.number().min(0).max(100000).nullable(),
  orderUpTo: z.number().min(0).max(100000).nullable(),
  vendorName: z.string().max(200).nullable().optional(),
  itemNumber: z.string().max(120).nullable().optional(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpsertSchema);
  if (parsed.error) return parsed.error;
  const b = parsed.data;

  if (b.reorderAt != null && b.orderUpTo != null && b.orderUpTo <= b.reorderAt) {
    return NextResponse.json(
      { error: 'Order-up-to has to be above the reorder point, or the sweep would raise a request for nothing.' },
      { status: 400 },
    );
  }

  const { error } = await service.from('material_stock_settings').upsert({
    kind: b.kind,
    material_key: materialKey(b.materialName),
    material_name: b.materialName.trim(),
    substrate_id: b.substrateId ?? null,
    unit: b.kind === 'ink' ? 'cartridge' : 'ft',
    reorder_at: b.reorderAt,
    order_up_to: b.orderUpTo,
    vendor_name: b.vendorName?.trim() || null,
    item_number: b.itemNumber?.trim() || null,
    updated_by: auth.user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'kind,material_key' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'material_stock_settings',
    recordId: `${b.kind}:${materialKey(b.materialName)}`,
    action: 'material_reorder_point_set',
    detail: { ...b },
  });
  return NextResponse.json({ ok: true });
}
