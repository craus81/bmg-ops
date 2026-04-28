import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/vehicle-tracking/[id]/refresh-checklist
 *
 * Deletes existing job_tasks for the vehicle and re-instantiates from the
 * currently-active install_checklist_templates row matching the vehicle's
 * category (mixed by default, falling back to upfit when the vehicle has
 * no matched graphics job). Lets users pick up template changes on a
 * vehicle that's already in_progress.
 *
 * Admin-only because this destroys check-off progress for the vehicle.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  // Admin gate
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles, status')
    .eq('id', auth.user.id)
    .single();
  const roles: string[] = profile?.roles?.length ? profile.roles : [profile?.role];
  if (!roles.includes('admin')) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const { data: vehicle } = await supabase
    .from('fleet_checkins')
    .select('id, matched_graphics_job_id')
    .eq('id', params.id)
    .single();
  if (!vehicle) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 });

  const preferredCategory = vehicle.matched_graphics_job_id ? 'mixed' : 'upfit';
  const { data: template } = await supabase
    .from('install_checklist_templates')
    .select('id, items, install_category')
    .eq('is_active', true)
    .in('install_category', [preferredCategory, 'mixed'])
    .order('install_category', { ascending: preferredCategory !== 'mixed' })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!template?.items || !Array.isArray(template.items)) {
    return NextResponse.json({ error: 'No active template found' }, { status: 404 });
  }

  await supabase
    .from('job_tasks')
    .delete()
    .eq('job_type', 'fleet_checkin')
    .eq('job_id', params.id);

  const rows = (template.items as Array<{ label: string; required?: boolean; key?: string }>)
    .filter((i) => i?.label)
    .map((item, i) => ({
      job_type: 'fleet_checkin',
      job_id: params.id,
      label: item.label,
      required: item.required === true,
      sort_order: i,
      template_id: template.id,
      task_key: item.key || null,
    }));

  if (rows.length > 0) {
    await supabase.from('job_tasks').insert(rows);
  }

  return NextResponse.json({ ok: true, count: rows.length, templateId: template.id });
}
