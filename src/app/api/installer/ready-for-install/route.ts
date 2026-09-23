import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/installer/ready-for-install
 *
 * Returns vehicles whose matched graphics job is in 'ready' or 'shipped' status,
 * AND the vehicle itself is still in an active status (received / in_progress).
 *
 * Readiness = fleet_checkin.status IN (received, in_progress)
 *           AND matched_graphics_job_id IS NOT NULL
 *           AND matched graphics job status IN (ready, shipped)
 *
 * Also returns `unmatchedJobs`: graphics jobs in 'ready' that no vehicle
 * check-in points at — field, other-location and CNI installs, or a shop
 * vehicle that hasn't arrived. Those left the graphics board's Active tab
 * (owner decision, 2026-09-23) and this is the installers' view of them.
 * Nobody is assigned to install them yet, so they come back only without
 * `mine=1`.
 *
 * Query params:
 *   mine=1    -> only vehicles assigned to the current user (via fleet_checkins.assigned_to
 *               or via job_assignments[job_type=scanned_vehicle]); no unmatchedJobs.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const mineOnly = searchParams.get('mine') === '1';
  const userId = auth.user.id;

  // 1. Load active checkins with a matched graphics_job
  const { data: checkins, error: checkinsErr } = await supabase
    .from('fleet_checkins')
    .select(`
      id,
      vin,
      vehicle_year,
      vehicle_make,
      vehicle_model,
      customer_name,
      sales_order_number,
      sales_order_memo,
      status,
      notes,
      scheduled_upfit_date,
      assigned_to,
      matched_graphics_job_id,
      created_at
    `)
    .in('status', ['received', 'in_progress'])
    .not('matched_graphics_job_id', 'is', null)
    .is('archived_at', null)
    .order('scheduled_upfit_date', { ascending: true, nullsFirst: false });

  if (checkinsErr) {
    return NextResponse.json({ error: checkinsErr.message }, { status: 500 });
  }
  const unmatchedJobs = mineOnly ? [] : await loadUnmatchedReadyJobs();
  if (unmatchedJobs === null) {
    return NextResponse.json({ error: 'Could not read ready graphics jobs' }, { status: 500 });
  }

  if (!checkins || checkins.length === 0) {
    return NextResponse.json({ vehicles: [], unmatchedJobs });
  }

  // 2. Load the graphics jobs and filter to ready/shipped
  const graphicsIds = Array.from(new Set(
    checkins.map(c => c.matched_graphics_job_id).filter(Boolean)
  )) as string[];

  const { data: graphicsJobs } = await supabase
    .from('graphics_jobs')
    .select(`
      id,
      job_number,
      title,
      part_number,
      status,
      scheduled_install_date,
      updated_at
    `)
    .in('id', graphicsIds)
    .in('status', ['ready', 'shipped']);

  const graphicsById = new Map((graphicsJobs || []).map(g => [g.id, g]));

  // 3. If mine filter, figure out which checkins are assigned to this user
  let mineCheckinIds = new Set<string>();
  if (mineOnly) {
    // Direct assignment
    for (const c of checkins) {
      if (c.assigned_to === userId) mineCheckinIds.add(c.id);
    }
    // Via job_assignments
    const { data: assignments } = await supabase
      .from('job_assignments')
      .select('job_id')
      .eq('job_type', 'scanned_vehicle')
      .eq('user_id', userId)
      .in('job_id', checkins.map(c => c.id));
    for (const a of assignments || []) mineCheckinIds.add(a.job_id);
  }

  // 4. Join + shape output
  const now = Date.now();
  const vehicles = checkins
    .filter(c => graphicsById.has(c.matched_graphics_job_id!))
    .filter(c => !mineOnly || mineCheckinIds.has(c.id))
    .map(c => {
      const g = graphicsById.get(c.matched_graphics_job_id!)!;
      const readySince = g.updated_at ? new Date(g.updated_at).getTime() : null;
      const daysInReady = readySince
        ? Math.floor((now - readySince) / (1000 * 60 * 60 * 24))
        : null;
      return {
        id: c.id,
        vin: c.vin,
        vehicleYear: c.vehicle_year,
        vehicleMake: c.vehicle_make,
        vehicleModel: c.vehicle_model,
        customerName: c.customer_name,
        salesOrderNumber: c.sales_order_number,
        salesOrderMemo: c.sales_order_memo,
        status: c.status,
        notes: c.notes,
        scheduledUpfitDate: c.scheduled_upfit_date,
        assignedTo: c.assigned_to,
        graphicsJob: {
          id: g.id,
          jobNumber: g.job_number,
          title: g.title,
          partNumber: g.part_number,
          status: g.status,
          scheduledInstallDate: g.scheduled_install_date,
          updatedAt: g.updated_at,
        },
        daysInReady,
        stale: daysInReady !== null && daysInReady > 7,
      };
    });

  return NextResponse.json({ vehicles, count: vehicles.length, unmatchedJobs });
}

const daysSince = (iso: string | null, now: number): number | null =>
  iso ? Math.floor((now - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)) : null;

/**
 * Ready graphics jobs with no vehicle check-in matched to them. A check-in in
 * ANY state counts as matched — a job whose vehicle already left belongs to
 * that vehicle, not to "no vehicle yet". Null on a read error.
 */
async function loadUnmatchedReadyJobs() {
  const { data: jobs, error } = await supabase
    .from('graphics_jobs')
    .select('id, job_number, title, part_number, customer, install_location, scheduled_install_date, updated_at')
    .eq('status', 'ready')
    .order('scheduled_install_date', { ascending: true, nullsFirst: false })
    .order('id');
  if (error) return null;
  if (!jobs || jobs.length === 0) return [];

  const matched = new Set<string>();
  const ids = jobs.map(j => j.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data: rows, error: matchErr } = await supabase
      .from('fleet_checkins')
      .select('matched_graphics_job_id')
      .in('matched_graphics_job_id', ids.slice(i, i + 200));
    if (matchErr) return null;
    for (const r of rows || []) if (r.matched_graphics_job_id) matched.add(r.matched_graphics_job_id);
  }

  const now = Date.now();
  return jobs
    .filter(j => !matched.has(j.id))
    .map(j => {
      const daysInReady = daysSince(j.updated_at, now);
      return {
        id: j.id,
        jobNumber: j.job_number,
        title: j.title,
        partNumber: j.part_number,
        customer: j.customer,
        installLocation: j.install_location,
        // 'N/A' is a legacy placeholder some jobs carry, not a date.
        scheduledInstallDate: j.scheduled_install_date && j.scheduled_install_date !== 'N/A'
          ? j.scheduled_install_date.slice(0, 10) : null,
        daysInReady,
        stale: daysInReady !== null && daysInReady > 7,
      };
    });
}
