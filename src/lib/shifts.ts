/**
 * Shared shift helpers for the /api/shifts/* routes: rosters, member views,
 * and the "may this user touch this shift?" check. Server-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// Internal roles allowed to run field shifts on /scan.
export const FIELD_ROLES = ['admin', 'field_tech', 'shop_tech', 'graphics_production', 'sales'];

export interface ShiftMemberView {
  profile_id: string;
  full_name: string;
  share_weight: number;
}

export async function memberViews(service: SupabaseClient, shiftId: string): Promise<ShiftMemberView[]> {
  const { data: members } = await service
    .from('work_shift_members')
    .select('profile_id, share_weight')
    .eq('shift_id', shiftId)
    .is('removed_at', null);
  if (!members || members.length === 0) return [];
  const { data: profiles } = await service
    .from('profiles')
    .select('id, full_name')
    .in('id', members.map(m => m.profile_id));
  const names = new Map((profiles || []).map(p => [p.id, p.full_name]));
  return members.map(m => ({
    profile_id: m.profile_id,
    full_name: names.get(m.profile_id) || 'Unknown',
    share_weight: Number(m.share_weight),
  }));
}

/**
 * Roster of approved installers at a company: profiles assigned to it (via
 * profiles.company_id) that carry an installer role. The company list is the
 * shared `companies` table, so membership comes straight from access-granting.
 */
export async function cniRoster(service: SupabaseClient, companyId: string): Promise<{ profile_id: string; full_name: string }[]> {
  const { data: profiles } = await service
    .from('profiles')
    .select('id, full_name, role, roles')
    .eq('company_id', companyId)
    .eq('status', 'approved')
    .or('role.eq.installer,roles.cs.{installer}')
    .order('full_name');
  return (profiles || []).map(p => ({ profile_id: p.id, full_name: p.full_name }));
}

/** Curated field-installer roster: flagged profiles plus field techs. */
export async function fieldRoster(service: SupabaseClient): Promise<{ profile_id: string; full_name: string }[]> {
  const { data } = await service
    .from('profiles')
    .select('id, full_name, role, roles, is_field_installer')
    .eq('status', 'approved')
    .or('is_field_installer.eq.true,role.eq.field_tech,roles.cs.{field_tech}')
    .order('full_name');
  return (data || []).map(p => ({ profile_id: p.id, full_name: p.full_name }));
}

export interface ShiftRow {
  id: string;
  context: 'cni' | 'field';
  cni_job_id: string | null;
  part_number: string | null;
  started_by: string;
  ended_at: string | null;
}

export async function loadShift(service: SupabaseClient, shiftId: string): Promise<ShiftRow | null> {
  const { data } = await service
    .from('work_shifts')
    .select('id, context, cni_job_id, part_number, started_by, ended_at')
    .eq('id', shiftId)
    .maybeSingle();
  return (data as ShiftRow) || null;
}

/**
 * Anyone currently on the shift can manage it (tag/untag/end) — not just
 * whoever started it — so a shift is never stranded if the starter leaves
 * early. Admins and the starter always can.
 */
export async function canManageShift(
  service: SupabaseClient,
  userId: string,
  shift: ShiftRow,
  isAdmin: boolean,
): Promise<boolean> {
  if (isAdmin || shift.started_by === userId) return true;
  const { data } = await service
    .from('work_shift_members')
    .select('id')
    .eq('shift_id', shift.id)
    .eq('profile_id', userId)
    .is('removed_at', null)
    .limit(1);
  return !!(data && data.length > 0);
}

/** Profile ids eligible to be tagged onto this shift. */
export async function eligibleMemberIds(service: SupabaseClient, shift: ShiftRow): Promise<Set<string>> {
  if (shift.context === 'cni' && shift.cni_job_id) {
    const { data: job } = await service
      .from('cni_jobs')
      .select('assigned_company_id, assigned_installer_id')
      .eq('id', shift.cni_job_id)
      .single();
    const ids = new Set<string>();
    if (job?.assigned_company_id) {
      for (const r of await cniRoster(service, job.assigned_company_id)) ids.add(r.profile_id);
    }
    if (job?.assigned_installer_id) ids.add(job.assigned_installer_id);
    return ids;
  }
  return new Set((await fieldRoster(service)).map(r => r.profile_id));
}
