import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin, requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Shop-wide consumable rates (R6-1): the fallback $/ft² for ink and
 * premask when a film in the catalog doesn't carry its own. Reading is
 * admin (cost data); writing is super-admin, matching the shop labor cost
 * rate — it moves every graphics job's reported material cost.
 *
 * Both are per PRINTED ft², not roll ft²: ink and tape only ever touch the
 * graphic, never the blank margins the nesting engine left.
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
    .select('default_ink_cost_per_sqft, default_premask_cost_per_sqft')
    .eq('id', 1)
    .maybeSingle();
  return NextResponse.json({
    inkCostPerSqft: data?.default_ink_cost_per_sqft != null ? Number(data.default_ink_cost_per_sqft) : null,
    premaskCostPerSqft: data?.default_premask_cost_per_sqft != null ? Number(data.default_premask_cost_per_sqft) : null,
  });
}

const UpdateSchema = z.object({
  /** null clears the fallback — lines then log unpriced rather than $0. */
  inkCostPerSqft: z.number().min(0).max(100).nullable(),
  premaskCostPerSqft: z.number().min(0).max(100).nullable(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;

  const supabase = getSupabase();
  const { data: before } = await supabase
    .from('quote_settings')
    .select('default_ink_cost_per_sqft, default_premask_cost_per_sqft')
    .eq('id', 1)
    .maybeSingle();

  const { error } = await supabase.from('quote_settings').upsert({
    id: 1,
    default_ink_cost_per_sqft: parsed.data.inkCostPerSqft,
    default_premask_cost_per_sqft: parsed.data.premaskCostPerSqft,
    updated_at: new Date().toISOString(),
    updated_by: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'quote_settings',
    recordId: '1',
    action: 'material_defaults_changed',
    detail: {
      from: {
        ink: before?.default_ink_cost_per_sqft != null ? Number(before.default_ink_cost_per_sqft) : null,
        premask: before?.default_premask_cost_per_sqft != null ? Number(before.default_premask_cost_per_sqft) : null,
      },
      to: { ink: parsed.data.inkCostPerSqft, premask: parsed.data.premaskCostPerSqft },
    },
  });
  return NextResponse.json(parsed.data);
}
