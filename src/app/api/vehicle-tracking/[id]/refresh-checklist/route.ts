import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { loadChecklistTemplate, buildTaskRows } from '@/lib/install-checklist';
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
  const auth = await requireStaff(req);
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

  // Shared lookup with update-status (exact category first, 'mixed' fallback,
  // newest active wins) — the two routes used to disagree on both ordering
  // and tiebreak, so "Reset checklist" could produce a different checklist
  // than the automatic instantiation.
  const preferredCategory = vehicle.matched_graphics_job_id ? 'mixed' : 'upfit';
  const template = await loadChecklistTemplate(supabase, preferredCategory);

  if (!template) {
    return NextResponse.json({ error: 'No active template found' }, { status: 404 });
  }

  await supabase
    .from('job_tasks')
    .delete()
    .eq('job_type', 'fleet_checkin')
    .eq('job_id', params.id);

  const rows = buildTaskRows(template, params.id);

  if (rows.length > 0) {
    await supabase.from('job_tasks').insert(rows);
  }

  return NextResponse.json({ ok: true, count: rows.length, templateId: template.id });
}
