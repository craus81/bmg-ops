import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff, getProfileRoles } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { weekWindows, countByWeek, type WeekWindows } from '@/lib/my-week';
import { addDays } from '@/lib/shop-week';
import { canSeeMoney } from '@/lib/money-visibility';
import { GRAPHICS_ACTIVE_STATUSES, GRAPHICS_AWAITING_STATUSES } from '@/lib/graphics-status';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const IN_SHOP = ['received', 'checked_in', 'in_progress', 'stuck_parts', 'stuck_graphics'];
const VIEWS = ['tech', 'graphics', 'sales'] as const;
type View = typeof VIEWS[number];

type Result = { error: { message: string } | null };
const firstError = (...rs: Result[]) => rs.find(r => r.error)?.error || null;

/**
 * GET /api/my/week?view=tech|graphics|sales — the signed-in person's own week
 * for the personal Home screen: what they got done Monday through today, the
 * same span last week, and what's up next for them.
 *
 * Strictly self-scoped. Counts only for techs and graphics (owner decision
 * 2026-09-29: many are hourly, so earnings stay off Home); the sales view
 * adds the value won, and only for roles that may see money.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const me = auth.user.id as string;
  const viewParam = req.nextUrl.searchParams.get('view') || 'tech';
  if (!(VIEWS as readonly string[]).includes(viewParam)) {
    return NextResponse.json({ error: 'Unknown view' }, { status: 400 });
  }
  const view = viewParam as View;

  const w = weekWindows(new Date());
  const nextWeekEnd = addDays(w.today, 6);

  // Everyone: upfit tasks and their own calendar.
  const [tasksDone, openTasks, events] = await Promise.all([
    fetchAllRows<{ id: string; completed_at: string }>((from, to) =>
      service.from('upfit_project_tasks').select('id, completed_at')
        .eq('completed_by', me).gte('completed_at', w.lastStart.toISOString())
        .order('completed_at').order('id').range(from, to)),
    service.from('upfit_project_tasks')
      .select('id, title, due_date, project_id, upfit_projects(project_name)')
      .eq('assigned_to', me).is('completed_at', null)
      .order('due_date', { ascending: true, nullsFirst: false }).order('id').limit(10),
    service.from('calendar_events')
      .select('id, title, event_date, event_time')
      .eq('user_id', me).is('completed_at', null).is('linked_graphics_job_id', null)
      .gte('event_date', w.today).lte('event_date', nextWeekEnd)
      .order('event_date').order('event_time', { ascending: true, nullsFirst: true }).limit(10),
  ]);
  const commonErr = firstError(tasksDone, openTasks, events);
  if (commonErr) return NextResponse.json({ error: commonErr.message }, { status: 500 });

  const roleBlock = view === 'tech' ? await loadTech(me, w, nextWeekEnd)
    : view === 'graphics' ? await loadGraphics(me, w)
    : await loadSales(me, w, nextWeekEnd, canSeeMoney(getProfileRoles(auth.profile)));
  if ('error' in roleBlock) return NextResponse.json({ error: roleBlock.error }, { status: 500 });

  return NextResponse.json({
    view,
    weekStart: w.weekStart,
    today: w.today,
    done: {
      tasks: countByWeek(tasksDone.data, t => t.completed_at, w),
      ...roleBlock.done,
    },
    next: {
      tasks: (openTasks.data || []).map((t: any) => ({
        id: t.id,
        title: t.title,
        due: t.due_date,
        projectId: t.project_id,
        project: t.upfit_projects?.project_name || null,
      })),
      events: (events.data || []).map(e => ({ id: e.id, title: e.title, date: e.event_date, time: e.event_time })),
      ...roleBlock.next,
    },
  });
}

// ─── Field + shop techs ───────────────────────────────────────────
async function loadTech(me: string, w: WeekWindows, nextWeekEnd: string) {
  const since = w.lastStart.toISOString();
  const [scans, credits, checkins, statusMoves, assignedDirect, assignedVia, arrivals] = await Promise.all([
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
    service.from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, status, promised_back_date, scheduled_upfit_date')
      .eq('assigned_to', me).in('status', IN_SHOP).is('archived_at', null).limit(50),
    service.from('job_assignments').select('job_id').eq('job_type', 'scanned_vehicle').eq('user_id', me)
      .order('assigned_at', { ascending: false }).limit(200),
    service.from('shop_inbound')
      .select('id, vehicle_desc, customer_name, work_summary, expected_date')
      .eq('status', 'expected').not('expected_date', 'is', null).lte('expected_date', nextWeekEnd)
      .order('expected_date').order('id').limit(10),
  ]);
  const err = firstError(scans, credits, checkins, statusMoves, assignedDirect, assignedVia, arrivals);
  if (err) return { error: err.message };

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
    if (error) return { error: error.message };
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

  return {
    done: {
      installs: countByWeek(installList, i => i.at, w),
      vehiclesInstalled: countByWeek(installList, i => i.at, w, i => i.vin),
      checkedIn: countByWeek(checkins.data, c => c.created_at, w),
      completed: countByWeek(statusMoves.data, s => s.created_at, w, s => s.vehicle_id),
    },
    next: {
      vehicles: myVehicles,
      vehiclesTotal: vehicles.size,
      arrivals: (arrivals.data || []).map(a => ({
        id: a.id,
        label: a.vehicle_desc || a.work_summary || 'Vehicle',
        customer: a.customer_name,
        date: a.expected_date,
      })),
    },
  };
}

// ─── Graphics production ──────────────────────────────────────────
async function loadGraphics(me: string, w: WeekWindows) {
  const since = w.lastStart.toISOString();
  const [finished, sent, approved, assignedDirect, assignedVia, waiting] = await Promise.all([
    // A job is "done" for the print floor when it moves to Ready / Ready for
    // Pickup — that's when it leaves the board's Active tab.
    fetchAllRows<{ id: string; job_id: string; created_at: string }>((from, to) =>
      service.from('graphics_status_history').select('id, job_id, created_at')
        .eq('changed_by', me).in('to_status', GRAPHICS_AWAITING_STATUSES).gte('created_at', since)
        .order('created_at').order('id').range(from, to)),
    fetchAllRows<{ id: string; sent_at: string }>((from, to) =>
      service.from('graphics_proof_rounds').select('id, sent_at')
        .eq('sent_by', me).gte('sent_at', since)
        .order('sent_at').order('id').range(from, to)),
    fetchAllRows<{ id: string; decided_at: string }>((from, to) =>
      service.from('graphics_proof_rounds').select('id, decided_at')
        .eq('sent_by', me).eq('outcome', 'approved').gte('decided_at', since)
        .order('decided_at').order('id').range(from, to)),
    service.from('graphics_jobs')
      .select('id, job_number, title, customer, status, due_date')
      .eq('assigned_to', me).in('status', GRAPHICS_ACTIVE_STATUSES).limit(50),
    service.from('job_assignments').select('job_id').eq('job_type', 'graphics_job').eq('user_id', me)
      .order('assigned_at', { ascending: false }).limit(200),
    service.from('graphics_proof_rounds')
      .select('id, job_id, round_number, sent_at, graphics_jobs(job_number, title, customer)')
      .eq('sent_by', me).eq('outcome', 'pending').not('sent_at', 'is', null)
      .order('sent_at').order('id').limit(10),
  ]);
  const err = firstError(finished, sent, approved, assignedDirect, assignedVia, waiting);
  if (err) return { error: err.message };

  const jobs = new Map<string, any>();
  for (const j of assignedDirect.data || []) jobs.set(j.id, j);
  const viaIds = (assignedVia.data || []).map(a => a.job_id).filter(id => !jobs.has(id));
  if (viaIds.length > 0) {
    const { data: more, error } = await service.from('graphics_jobs')
      .select('id, job_number, title, customer, status, due_date')
      .in('id', viaIds).in('status', GRAPHICS_ACTIVE_STATUSES);
    if (error) return { error: error.message };
    for (const j of more || []) jobs.set(j.id, j);
  }
  const myJobs = [...jobs.values()]
    .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'))
    .slice(0, 10)
    .map(j => ({ id: j.id, label: j.title || j.job_number, jobNumber: j.job_number, customer: j.customer, status: j.status, due: j.due_date }));

  return {
    done: {
      jobsFinished: countByWeek(finished.data, f => f.created_at, w, f => f.job_id),
      proofsSent: countByWeek(sent.data, s => s.sent_at, w),
      proofsApproved: countByWeek(approved.data, a => a.decided_at, w),
    },
    next: {
      graphicsJobs: myJobs,
      graphicsJobsTotal: jobs.size,
      proofsWaiting: (waiting.data || []).map((p: any) => ({
        id: p.id,
        jobId: p.job_id,
        label: p.graphics_jobs?.title || p.graphics_jobs?.job_number || 'Graphics job',
        customer: p.graphics_jobs?.customer || null,
        round: p.round_number,
        sentAt: p.sent_at,
      })),
    },
  };
}

// ─── Sales ────────────────────────────────────────────────────────
async function loadSales(me: string, w: WeekWindows, nextWeekEnd: string, money: boolean) {
  const since = w.lastStart.toISOString();
  const [created, won, followUps, awaiting, reminders, deals] = await Promise.all([
    fetchAllRows<{ id: string; created_at: string }>((from, to) =>
      service.from('estimates').select('id, created_at')
        .eq('created_by', me).gte('created_at', since)
        .order('created_at').order('id').range(from, to)),
    fetchAllRows<{ id: string; customer_approved_at: string; grand_total: number | null }>((from, to) =>
      service.from('estimates').select('id, customer_approved_at, grand_total')
        .eq('created_by', me).gte('customer_approved_at', since)
        .order('customer_approved_at').order('id').range(from, to)),
    fetchAllRows<{ id: string; created_at: string }>((from, to) =>
      service.from('quote_followups').select('id, created_at')
        .eq('created_by', me).gte('created_at', since)
        .order('created_at').order('id').range(from, to)),
    service.from('estimates')
      .select('id, estimate_number, title, customer_name, grand_total, updated_at, last_followup_at')
      .eq('created_by', me).eq('status', 'sent')
      .order('updated_at').order('id').limit(10),
    service.from('prospect_reminders')
      .select('id, title, due_at, prospect_id')
      .eq('created_by', me).is('completed_at', null)
      .lte('due_at', `${nextWeekEnd}T23:59:59`)
      .order('due_at').order('id').limit(10),
    service.from('prospect_opportunities')
      .select('id, title, value, expected_close_date, prospect_id, stage')
      .eq('created_by', me).in('stage', ['lead', 'quoted', 'negotiating'])
      .lte('expected_close_date', addDays(w.today, 30))
      .order('expected_close_date').order('id').limit(10),
  ]);
  const err = firstError(created, won, followUps, awaiting, reminders, deals);
  if (err) return { error: err.message };

  const wonThis = won.data.filter(e => {
    const t = new Date(e.customer_approved_at).getTime();
    return t >= w.thisStart.getTime() && t <= w.thisEnd.getTime();
  });
  const wonValue = wonThis.reduce((s, e) => s + Number(e.grand_total || 0), 0);

  return {
    done: {
      estimatesCreated: countByWeek(created.data, e => e.created_at, w),
      estimatesWon: countByWeek(won.data, e => e.customer_approved_at, w),
      followUps: countByWeek(followUps.data, f => f.created_at, w),
      ...(money ? { wonValue: Math.round(wonValue) } : {}),
    },
    next: {
      estimatesAwaiting: (awaiting.data || []).map(e => ({
        id: e.id,
        label: e.title || e.estimate_number,
        customer: e.customer_name,
        total: money ? Number(e.grand_total || 0) : null,
        since: e.last_followup_at || e.updated_at,
      })),
      reminders: (reminders.data || []).map(r => ({ id: r.id, title: r.title, due: String(r.due_at).slice(0, 10), prospectId: r.prospect_id })),
      deals: (deals.data || []).map(d => ({
        id: d.id,
        title: d.title,
        value: money && d.value != null ? Number(d.value) : null,
        close: d.expected_close_date,
        prospectId: d.prospect_id,
      })),
    },
  };
}
