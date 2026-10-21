import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { syncLinkedDelivery } from '@/lib/delivery-sync';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createServiceClient();
}

const text = z.string().max(2000).optional().nullable();

const Schema = z.object({
  source: z.enum(['estimate', 'upfit_project', 'graphics_job']),
  id: z.string().uuid(),
  delivery: z.object({
    method: z.enum(['direct_ship', 'onsite_install', 'customer_pickup', 'bmg_shop']).optional().nullable(),
    shipSpeed: z.string().max(40).optional().nullable(),
    address: text,
    contactName: z.string().max(200).optional().nullable(),
    contactPhone: z.string().max(200).optional().nullable(),
    notes: text,
    installer: z.enum(['bmg_crew', 'cni']).optional().nullable(),
  }),
});

/**
 * POST /api/delivery — save a delivery method on an estimate, upfit project
 * or graphics job AND on every record linked to it (src/lib/delivery-sync.ts).
 * Returns what else was updated so the screen can say so.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { source, id, delivery } = parsed.data;

  try {
    const updated = await syncLinkedDelivery(getSupabase(), source, id, delivery);
    return NextResponse.json({ success: true, updated });
  } catch (e: any) {
    return NextResponse.json({ error: `Delivery didn't save on every linked record: ${e?.message || 'unknown error'}` }, { status: 500 });
  }
}
