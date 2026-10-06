import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFinancials } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { PAYROLL_ROLE_KEYS } from '@/lib/paychex-payroll';

export const dynamic = 'force-dynamic';

const PostSchema = z.object({
  links: z.array(z.object({
    paychexEmployeeId: z.string().min(1).max(50),
    /** null unlinks. */
    profileId: z.string().uuid().nullable(),
    /** Payroll role (migration 341). Omitted = leave as is; null clears it. */
    role: z.enum(PAYROLL_ROLE_KEYS).nullable().optional(),
  })).min(1).max(500),
});

/**
 * POST /api/reports/paychex-payroll/links
 *
 * Save Paychex employee → FleetSuite person matches (migration 340) and
 * payroll roles (migration 341). One person per Paychex ID and one Paychex
 * ID per person; a profile already linked elsewhere is moved, never doubled.
 * Every entry carries its person match; `role` is only touched when sent.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { links } = parsed.data;

  const profileIds = links.map(l => l.profileId).filter(Boolean) as string[];
  if (new Set(profileIds).size !== profileIds.length) {
    return NextResponse.json({ error: 'The same person is matched to two Paychex employees.' }, { status: 400 });
  }

  const service = createServiceClient();
  const empIds = links.map(l => l.paychexEmployeeId);

  // Clear these employees' links and any link these people hold elsewhere,
  // then write the new set.
  const { error: delErr } = await service.from('payroll_employee_links').delete().in('paychex_employee_id', empIds);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  if (profileIds.length) {
    const { error: delProfErr } = await service.from('payroll_employee_links').delete().in('profile_id', profileIds);
    if (delProfErr) return NextResponse.json({ error: delProfErr.message }, { status: 500 });
  }
  const rows = links
    .filter(l => l.profileId)
    .map(l => ({ paychex_employee_id: l.paychexEmployeeId, profile_id: l.profileId, linked_by: auth.user.id }));
  if (rows.length) {
    const { error } = await service.from('payroll_employee_links').insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Roles: upsert the ones set, delete the ones cleared.
  const roleSets = links.filter(l => l.role).map(l => ({
    paychex_employee_id: l.paychexEmployeeId, role: l.role!, set_by: auth.user.id, set_at: new Date().toISOString(),
  }));
  const roleClears = links.filter(l => l.role === null).map(l => l.paychexEmployeeId);
  if (roleSets.length) {
    const { error } = await service.from('payroll_employee_roles').upsert(roleSets, { onConflict: 'paychex_employee_id' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (roleClears.length) {
    const { error } = await service.from('payroll_employee_roles').delete().in('paychex_employee_id', roleClears);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'payroll_employee_links',
    recordId: 'batch',
    action: 'paychex_people_matched',
    detail: { linked: rows.length, unlinked: links.length - rows.length, rolesSet: roleSets.length, rolesCleared: roleClears.length },
  });
  return NextResponse.json({ saved: links.length });
}
