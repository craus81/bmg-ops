import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, isAdminRole } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { rolesOf, canActOnCniJob } from '@/lib/cni-access';
import { getOpenCniShift, getFieldRate } from '@/lib/pay-credits';
import { FIELD_ROLES, memberViews, cniRoster, fieldRoster, shopRoster } from '@/lib/shifts';
import { getOpenShopShift, getShopLaborForCheckins } from '@/lib/shop-labor';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const GetSchema = z.object({
  cniJobId: z.string().uuid().optional(),
  context: z.enum(['cni', 'field']).optional(),
  shiftId: z.string().uuid().optional(),
  checkinId: z.string().uuid().optional(),
});

/**
 * Shift context for the scanning UIs:
 *   GET /api/shifts?cniJobId=…               → open shift + company roster + rate
 *   GET /api/shifts?context=field&shiftId=…  → that shift + field roster + rate
 *   GET /api/shifts?context=field            → field roster only (pre-shift)
 *   GET /api/shifts?checkinId=…              → open SHOP shift + shop roster +
 *                                              logged hours (R3-21 pick-list timer)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, GetSchema);
  if (q.error) return q.error;
  const isAdmin = isAdminRole(rolesOf(auth.profile));

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

  if (q.data.checkinId) {
    // Shop timer context (R3-21): internal floor roles only — the FIELD_ROLES
    // wall keeps external CNI installers out even though the pick-list page
    // itself admits them for their own install views.
    if (!rolesOf(auth.profile).some(r => FIELD_ROLES.includes(r))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { data: checkin } = await service
      .from('fleet_checkins')
      .select('id')
      .eq('id', q.data.checkinId)
      .maybeSingle();
    if (!checkin) return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });
    const open = await getOpenShopShift(service, q.data.checkinId);
    const shift = open ? { ...open, members: await memberViews(service, open.id) } : null;
    const labor = (await getShopLaborForCheckins(service, [q.data.checkinId])).get(q.data.checkinId);
    return NextResponse.json({
      shift,
      roster: await shopRoster(service),
      // Hours only — the blended COST rate is admin-side job costing and
      // never returned here.
      loggedHours: labor?.hours ?? 0,
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
        // Field techs are payroll employees — per-vehicle rates are internal
        // pricing (some mirror CNI vendor payouts) and stay admin-only. Credits
        // are still priced server-side at scan time regardless.
        if (isAdmin) ratePerVehicle = await getFieldRate(service, data.part_number);
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
  context: z.enum(['cni', 'field', 'shop', 'graphics']),
  cniJobId: z.string().uuid().optional().nullable(),
  checkinId: z.string().uuid().optional().nullable(),
  graphicsJobId: z.string().uuid().optional().nullable(),
  taskTag: z.enum(['print', 'cut', 'laminate', 'design', 'other']).optional().nullable(),
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
  const { context, cniJobId, checkinId, graphicsJobId, partNumber } = parsed.data;
  const isAdmin = isAdminRole(rolesOf(auth.profile));

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
  } else if (context === 'shop') {
    // R3-21 pick-list timer: internal floor roles only, one open shift per
    // check-in, and — job costing only — never a rate and never credits.
    if (!rolesOf(auth.profile).some(r => FIELD_ROLES.includes(r))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!checkinId) return NextResponse.json({ error: 'checkinId required' }, { status: 400 });
    const { data: checkin } = await service
      .from('fleet_checkins')
      .select('id')
      .eq('id', checkinId)
      .maybeSingle();
    if (!checkin) return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });
    const existing = await getOpenShopShift(service, checkinId);
    if (existing) {
      return NextResponse.json({ shift: { ...existing, members: await memberViews(service, existing.id) }, existing: true });
    }
    allowedIds = new Set((await shopRoster(service)).map(r => r.profile_id));
    allowedIds.add(auth.user.id);
  } else if (context === 'graphics') {
    // R6-6 print-room timer: same shape as the shop timer — one open shift
    // per graphics job, costing only, never a rate and never credits. The
    // print room is graphics production, so that is the roster.
    const roles = rolesOf(auth.profile);
    if (!roles.some(r => ['graphics_production', 'production', 'admin', 'super_admin'].includes(r))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!graphicsJobId) return NextResponse.json({ error: 'graphicsJobId required' }, { status: 400 });
    const { data: gjob } = await service
      .from('graphics_jobs').select('id').eq('id', graphicsJobId).maybeSingle();
    if (!gjob) return NextResponse.json({ error: 'Graphics job not found' }, { status: 404 });
    const { data: openShift } = await service
      .from('work_shifts')
      .select('*')
      .eq('context', 'graphics')
      .eq('graphics_job_id', graphicsJobId)
      .is('ended_at', null)
      .maybeSingle();
    if (openShift) {
      return NextResponse.json({ shift: { ...openShift, members: await memberViews(service, openShift.id) }, existing: true });
    }
    const { data: crew } = await service
      .from('profiles').select('id, role, roles').eq('status', 'approved')
      .or('role.in.(graphics_production,production,admin,super_admin),roles.cs.{graphics_production},roles.cs.{production}');
    allowedIds = new Set((crew || []).map((p: any) => p.id));
    allowedIds.add(auth.user.id);
  } else {
    if (!rolesOf(auth.profile).some(r => FIELD_ROLES.includes(r))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    allowedIds = new Set((await fieldRoster(service)).map(r => r.profile_id));
    allowedIds.add(auth.user.id);
    // Admin-only, same as GET: field techs don't see per-vehicle rates.
    if (isAdmin) ratePerVehicle = await getFieldRate(service, partNumber);
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
      fleet_checkin_id: context === 'shop' ? checkinId : null,
      graphics_job_id: context === 'graphics' ? graphicsJobId : null,
      task_tag: context === 'graphics' ? (parsed.data.taskTag || null) : null,
      part_number: (context === 'shop' || context === 'graphics') ? null : (partNumber || null),
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
