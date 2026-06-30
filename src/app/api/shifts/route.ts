import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { rolesOf, canActOnCniJob } from '@/lib/cni-access';
import { getOpenCniShift, getFieldRate } from '@/lib/pay-credits';
import { FIELD_ROLES, memberViews, cniRoster, fieldRoster } from '@/lib/shifts';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const GetSchema = z.object({
  cniJobId: z.string().uuid().optional(),
  context: z.enum(['cni', 'field']).optional(),
  shiftId: z.string().uuid().optional(),
});

/**
 * Shift context for the scanning UIs:
 *   GET /api/shifts?cniJobId=…               → open shift + company roster + rate
 *   GET /api/shifts?context=field&shiftId=…  → that shift + field roster + rate
 *   GET /api/shifts?context=field            → field roster only (pre-shift)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, GetSchema);
  if (q.error) return q.error;
  const isAdmin = rolesOf(auth.profile).includes('admin');

  if (q.data.cniJobId) {
    const { data: job } = await service
      .from('cni_jobs')
      .select('id, assigned_installer_id, assigned_company_id, pay_per_vehicle')
      .eq('id', q.data.cniJobId)
      .single();
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (!isAdmin && !(await canActOnCniJob(service, auth.user.id, job))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const open = await getOpenCniShift(service, q.data.cniJobId);
    const shift = open ? { ...open, members: await memberViews(service, open.id) } : null;
    const roster = job.assigned_company_id ? await cniRoster(service, job.assigned_company_id) : [];
    return NextResponse.json({
      shift,
      roster,
      ratePerVehicle: job.pay_per_vehicle != null ? Number(job.pay_per_vehicle) : null,
    });
  }

  if (q.data.context === 'field') {
    if (!rolesOf(auth.profile).some(r => FIELD_ROLES.includes(r))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    let shift = null;
    let ratePerVehicle: number | null = null;
    if (q.data.shiftId) {
      const { data } = await service
        .from('work_shifts')
        .select('id, started_by, started_at, ended_at, part_number')
        .eq('id', q.data.shiftId)
        .eq('context', 'field')
        .maybeSingle();
      if (data && !data.ended_at) {
        shift = { id: data.id, started_by: data.started_by, started_at: data.started_at, members: await memberViews(service, data.id) };
        ratePerVehicle = await getFieldRate(service, data.part_number);
      }
    }
    return NextResponse.json({ shift, roster: await fieldRoster(service), ratePerVehicle });
  }

  return NextResponse.json({ error: 'cniJobId or context=field required' }, { status: 400 });
}

const MemberInput = z.object({
  profileId: z.string().uuid(),
  weight: z.number().positive().max(99).optional(),
});

const StartSchema = z.object({
  context: z.enum(['cni', 'field']),
  cniJobId: z.string().uuid().optional().nullable(),
  partNumber: z.string().trim().max(120).optional().nullable(),
  partDescription: z.string().trim().max(300).optional().nullable(),
  billableCustomer: z.string().trim().max(200).optional().nullable(),
  locationId: z.string().uuid().optional().nullable(),
  locationName: z.string().trim().max(200).optional().nullable(),
  members: z.array(MemberInput).max(50).default([]),
});

/**
 * Start a shift and tag the crew. The caller is always on the crew (whoever
 * scans is present). If a CNI job already has an open shift, that one is
 * returned instead of starting a second.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, StartSchema);
  if (parsed.error) return parsed.error;
  const { context, cniJobId, partNumber } = parsed.data;
  const isAdmin = rolesOf(auth.profile).includes('admin');

  let allowedIds: Set<string>;
  let ratePerVehicle: number | null = null;

  if (context === 'cni') {
    if (!cniJobId) return NextResponse.json({ error: 'cniJobId required' }, { status: 400 });
    const { data: job } = await service
      .from('cni_jobs')
      .select('id, assigned_installer_id, assigned_company_id, pay_per_vehicle')
      .eq('id', cniJobId)
      .single();
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (!isAdmin && !(await canActOnCniJob(service, auth.user.id, job))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const existing = await getOpenCniShift(service, cniJobId);
    if (existing) {
      return NextResponse.json({ shift: { ...existing, members: await memberViews(service, existing.id) }, existing: true });
    }
    const roster = job.assigned_company_id ? await cniRoster(service, job.assigned_company_id) : [];
    allowedIds = new Set(roster.map(r => r.profile_id));
    allowedIds.add(auth.user.id); // legacy assigned installer may predate company link
    ratePerVehicle = job.pay_per_vehicle != null ? Number(job.pay_per_vehicle) : null;
  } else {
    if (!rolesOf(auth.profile).some(r => FIELD_ROLES.includes(r))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    allowedIds = new Set((await fieldRoster(service)).map(r => r.profile_id));
    allowedIds.add(auth.user.id);
    ratePerVehicle = await getFieldRate(service, partNumber);
  }

  const members = new Map<string, number>();
  for (const m of parsed.data.members) {
    if (!allowedIds.has(m.profileId)) {
      return NextResponse.json({ error: 'One or more crew members are not eligible for this shift' }, { status: 400 });
    }
    members.set(m.profileId, m.weight ?? 1);
  }
  // Whoever scans is on the crew — except an admin (e.g. previewing the
  // installer portal or starting a shift on a crew's behalf), who may tag a
  // crew that doesn't include themselves.
  if (!isAdmin || members.size === 0) members.set(auth.user.id, members.get(auth.user.id) ?? 1);

  // The part the crew picked for this shift (CNI field-shift model, §1.2): for
  // CNI it bills every completed vehicle; for field it drives the rate lookup.
  const { data: shift, error } = await service
    .from('work_shifts')
    .insert({
      context,
      cni_job_id: context === 'cni' ? cniJobId : null,
      part_number: partNumber || null,
      part_description: context === 'cni' ? (parsed.data.partDescription || null) : null,
      billable_customer: context === 'cni' ? (parsed.data.billableCustomer || null) : null,
      location_id: parsed.data.locationId || null,
      location_name: parsed.data.locationName || null,
      started_by: auth.user.id,
    })
    .select('id, started_by, started_at')
    .single();
  if (error || !shift) {
    return NextResponse.json({ error: 'Failed to start shift: ' + (error?.message || 'unknown') }, { status: 500 });
  }

  const { error: memErr } = await service.from('work_shift_members').insert(
    [...members.entries()].map(([profileId, weight]) => ({
      shift_id: shift.id,
      profile_id: profileId,
      share_weight: weight,
      added_by: auth.user.id,
    })),
  );
  if (memErr) {
    return NextResponse.json({ error: 'Failed to tag crew: ' + memErr.message }, { status: 500 });
  }

  return NextResponse.json({
    shift: { ...shift, members: await memberViews(service, shift.id) },
    ratePerVehicle,
  });
}
