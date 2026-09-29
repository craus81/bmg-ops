import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { weekWindows, countByWeek } from '@/lib/my-week';
import { addDays } from '@/lib/shop-week';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const IN_SHOP = ['received', 'checked_in', 'in_progress', 'stuck_parts', 'stuck_graphics'];

/**
 * GET /api/my/week — the signed-in person's own week for the personal Home
 * screen (field + shop techs): what they got done Monday through today, the
 * same span last week, and what's up next for them.
 *
 * Strictly self-scoped and counts only — no dollar figures (owner decision
 * 2026-09-29: many techs are hourly, so earnings stay off Home).
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const me = auth.user.id as string;

  const w = weekWindows(new Date());
  const since = w.lastStart.toISOString();
  const nextWeekEnd = addDays(w.today, 6);

  const [scans, credits, checkins, statusMoves, tasksDone, assignedDirect, assignedVia, openTasks, events, arrivals] = await Promise.all([
    fetchAllRows<{ id: string; vin: string; scanned_at: string }>((from, to) =>
      service.from('scan_logs').select('id, vin, scanned_at')
        .eq('scanned_by', me).gte('scanned_at', since)
        .order('scanned_at').order('id').range(from, to)),
    // Crew credit: a vehicle a teammate scanned while this person was on the
    // shift counts for them too.
    fetchAllRows<{ id: string; scan_log_id: string | null; vin: string | null; created_at: string }>((from, to) =>
      service.from('install_credits').select('id, scan_log_id, vin, created_at')
        .eq('profile_id', me).eq('source', 'field').is('voided_at', null).gte('created_at', since)
        .order('created_at').order('id').range(from, to)),
    fetchAllRows<{ id: string; created_at: string }>((from, to) =>
      service.from('fleet_checkins').select('id, created_at')
        .eq('checked_in_by', me).gte('created_at', since)
        .order('created_at').order('id').range(from, to)),
    fetchAllRows<{ id: string; vehicle_id: string; created_at: string }>((from, to) =>
      service.from('vehicle_status_history').select('id, vehicle_id, created_at')
        .eq('changed_by', me).eq('to_status', 'complete').gte('created_at', since)
        .order('created_at').order('id').range(from, to)),
    fetchAllRows<{ id: string; completed_at: string }>((from, to) =>
      service.from('upfit_project_tasks').select('id, completed_at')
        .eq('completed_by', me).gte('completed_at', since)
        .order('completed_at').order('id').range(from, to)),
    service.from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, status, promised_back_date, scheduled_upfit_date')
      .eq('assigned_to', me).in('status', IN_SHOP).is('archived_at', null).limit(50),
    service.from('job_assignments').select('job_id').eq('job_type', 'scanned_vehicle').eq('user_id', me)
      .order('assigned_at', { ascending: false }).limit(200),
    service.from('upfit_project_tasks')
      .select('id, title, due_date, project_id, upfit_projects(project_name)')
      .eq('assigned_to', me).is('completed_at', null)
      .order('due_date', { ascending: true, nullsFirst: false }).order('id').limit(10),
    service.from('calendar_events')
      .select('id, title, event_date, event_time')
      .eq('user_id', me).is('completed_at', null).is('linked_graphics_job_id', null)
      .gte('event_date', w.today).lte('event_date', nextWeekEnd)
      .order('event_date').order('event_time', { ascending: true, nullsFirst: true }).limit(10),
    service.from('shop_inbound')
      .select('id, vehicle_desc, customer_name, work_summary, expected_date')
      .eq('status', 'expected').not('expected_date', 'is', null).lte('expected_date', nextWeekEnd)
      .order('expected_date').order('id').limit(10),
  ]);

  const failed = [scans, credits, checkins, statusMoves, tasksDone].find(r => r.error)
    || [assignedDirect, assignedVia, openTasks, events, arrivals].find(r => r.error);
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }

  // One install per scan, whether this person scanned it or was on the crew.
  const installs = new Map<string, { vin: string | null; at: string }>();
  for (const s of scans.data) installs.set(s.id, { vin: s.vin, at: s.scanned_at });
  for (const c of credits.data) {
    const key = c.scan_log_id || `credit-${c.id}`;
    if (!installs.has(key)) installs.set(key, { vin: c.vin, at: c.created_at });
  }
  const installList = [...installs.values()];

  // Vehicles assigned to me, directly or through a job assignment.
  const vehicles = new Map<string, any>();
  for (const v of assignedDirect.data || []) vehicles.set(v.id, v);
  const viaIds = (assignedVia.data || []).map(a => a.job_id).filter(id => !vehicles.has(id));
  if (viaIds.length > 0) {
    const { data: more, error } = await service.from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, status, promised_back_date, scheduled_upfit_date')
      .in('id', viaIds).in('status', IN_SHOP).is('archived_at', null);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const v of more || []) vehicles.set(v.id, v);
  }
  const dueOf = (v: any) => v.promised_back_date || v.scheduled_upfit_date || null;
  const myVehicles = [...vehicles.values()]
    .sort((a, b) => (dueOf(a) || '9999').localeCompare(dueOf(b) || '9999'))
    .slice(0, 10)
    .map(v => ({
      id: v.id,
      label: [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || v.vin,
      vin: v.vin,
      customer: v.customer_name,
      status: v.status,
      due: dueOf(v),
    }));

  return NextResponse.json({
    weekStart: w.weekStart,
    today: w.today,
    done: {
      installs: countByWeek(installList, i => i.at, w),
      vehiclesInstalled: countByWeek(installList, i => i.at, w, i => i.vin),
      checkedIn: countByWeek(checkins.data, c => c.created_at, w),
      completed: countByWeek(statusMoves.data, s => s.created_at, w, s => s.vehicle_id),
      tasks: countByWeek(tasksDone.data, t => t.completed_at, w),
    },
    next: {
      vehicles: myVehicles,
      vehiclesTotal: vehicles.size,
      tasks: (openTasks.data || []).map((t: any) => ({
        id: t.id,
        title: t.title,
        due: t.due_date,
        projectId: t.project_id,
        project: t.upfit_projects?.project_name || null,
      })),
      events: (events.data || []).map(e => ({ id: e.id, title: e.title, date: e.event_date, time: e.event_time })),
      arrivals: (arrivals.data || []).map(a => ({
        id: a.id,
        label: a.vehicle_desc || a.work_summary || 'Vehicle',
        customer: a.customer_name,
        date: a.expected_date,
      })),
    },
  });
}
