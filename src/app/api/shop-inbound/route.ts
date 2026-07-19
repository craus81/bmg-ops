import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { syncShopInboundForGraphicsJob, syncShopInboundForUpfitProject } from '@/lib/shop-inbound';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SyncSchema = z.object({
  sourceType: z.enum(['graphics_job', 'upfit_project']),
  sourceId: z.string().uuid(),
});

/**
 * POST /api/shop-inbound — re-derive the shop_inbound row for one source
 * record. Pages ping this (fire-and-forget) after saving a graphics job or
 * upfit project; the sync itself is idempotent.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, SyncSchema);
  if (parsed.error) return parsed.error;
  const { sourceType, sourceId } = parsed.data;

  if (sourceType === 'graphics_job') {
    await syncShopInboundForGraphicsJob(service, sourceId);
  } else {
    await syncShopInboundForUpfitProject(service, sourceId);
  }
  return NextResponse.json({ ok: true });
}
