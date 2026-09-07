import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin, requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * The blended hourly COST of shop labor (Settings → Shop Labor Cost Rate,
 * migration 269) — what an hour of floor time costs the company, used by
 * the vehicle-margin report to price pick-list timer hours (R3-21, job
 * costing only). One number by owner decision: no per-tech wages live in
 * the app. Reading is admin-only (it's cost data); writing is super-admin,
 * matching the labor-item and sales-tax precedents — it moves every
 * reported margin.
 */

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { data } = await getSupabase()
    .from('quote_settings')
    .select('shop_labor_cost_rate')
    .eq('id', 1)
    .maybeSingle();
  return NextResponse.json({ rate: data?.shop_labor_cost_rate != null ? Number(data.shop_labor_cost_rate) : null });
}

const UpdateSchema = z.object({
  /** $/hour; null clears the setting (margin then shows hours only). */
  rate: z.number().min(0).max(500).nullable(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;

  const supabase = getSupabase();
  const { data: before } = await supabase
    .from('quote_settings')
    .select('shop_labor_cost_rate')
    .eq('id', 1)
    .maybeSingle();

  const { error } = await supabase.from('quote_settings').upsert({
    id: 1,
    shop_labor_cost_rate: parsed.data.rate,
    updated_at: new Date().toISOString(),
    updated_by: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'quote_settings',
    recordId: '1',
    action: 'shop_labor_rate_changed',
    detail: {
      from: before?.shop_labor_cost_rate != null ? Number(before.shop_labor_cost_rate) : null,
      to: parsed.data.rate,
    },
  });
  return NextResponse.json({ rate: parsed.data.rate });
}
