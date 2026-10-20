import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireSuperAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { FEATURES, EDITABLE_ROLES, canGrantToRole, roleDefaultFeatures, type FeatureKey } from '@/lib/features';

export const dynamic = 'force-dynamic';

/**
 * More → Admin → Permissions: role-wide switches (migration 418).
 * Super admins only (owner decision 2026-10-20). The table has no write
 * policy, so this service-role route is the only way in.
 */

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const { data, error } = await getSupabase()
    .from('role_feature_settings')
    .select('role, feature, granted, updated_at');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ settings: data || [] });
}

const Schema = z.object({
  role: z.string().refine(r => EDITABLE_ROLES.includes(r), 'That role can’t be edited here'),
  // granted: the switch's new position. A position equal to the role's code
  // default clears the row, so "Reset" and flipping back are the same thing.
  changes: z.array(z.object({
    feature: z.string().refine(f => f in FEATURES, 'Unknown feature'),
    granted: z.boolean(),
  })).min(1).max(200),
});

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { role, changes } = parsed.data;

  const refused = changes.filter(c => c.granted && !canGrantToRole(role, c.feature));
  if (refused.length > 0) {
    return NextResponse.json({
      error: `These can't be turned on for this role: ${refused.map(c => FEATURES[c.feature as FeatureKey]).join(', ')}`,
    }, { status: 400 });
  }

  const defaults = roleDefaultFeatures(role);
  const toClear = changes.filter(c => defaults.has(c.feature as FeatureKey) === c.granted).map(c => c.feature);
  const toSet = changes
    .filter(c => defaults.has(c.feature as FeatureKey) !== c.granted)
    .map(c => ({ role, feature: c.feature, granted: c.granted, updated_by: auth.user.id, updated_at: new Date().toISOString() }));

  const supabase = getSupabase();
  if (toClear.length > 0) {
    const { error } = await supabase.from('role_feature_settings').delete().eq('role', role).in('feature', toClear);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (toSet.length > 0) {
    const { error } = await supabase.from('role_feature_settings').upsert(toSet, { onConflict: 'role,feature' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'role_feature_settings',
    recordId: role,
    action: 'update_role_permissions',
    detail: { changes },
  });

  const { data, error } = await supabase
    .from('role_feature_settings')
    .select('role, feature, granted, updated_at');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ settings: data || [] });
}
