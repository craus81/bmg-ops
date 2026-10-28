/**
 * Job scheduling alerts (Craig, 2026-10-28, thread "Explain what ready to
 * schedule triggers"). The job page's parts banner used to say "ready to
 * schedule" and leave it there. Now whoever has "Schedules installs" ticked
 * (Jessie) is told, in two steps:
 *
 *   reserve   every part is in stock but not all reserved: check the shelf,
 *             then tap Reserve available on the job.
 *   schedule  every part is reserved and there is no drop-off date: call
 *             the customer and set it.
 *
 * Reserving on the job page sends "schedule" right away; the hourly sweep
 * (/api/cron/job-schedule-alerts) catches everything else from synced data.
 * Each step goes once per job (upfit_projects.schedule_alert_step,
 * migration 450). Craig is copied while he watches how it works
 * (notification_preferences.copy_new_alerts).
 *
 * Staff only: nothing here reaches a customer.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { notifyMany } from './notify';
import { deepLinks } from './deep-links';
import { installSchedulerIds } from './install-scheduling';
import { computePartsReadinessBoard } from './parts-readiness';
import { scheduleStep, type ScheduleStep } from './job-schedule-alerts-state';

export { scheduleStep, type ScheduleStep };

type Verdict = 'reserved' | 'ready' | 'waiting' | 'short';

/** Everyone ticked "Copy me on new alerts" (Craig, for now). */
export async function newAlertWatcherIds(service: { from: (table: string) => any }): Promise<string[]> {
  const { data } = await service
    .from('notification_preferences')
    .select('user_id')
    .eq('copy_new_alerts', true);
  return [...new Set(((data || []) as any[]).map(r => r.user_id as string).filter(Boolean))];
}

/** Who hears about a job's scheduling step: the schedulers plus the watchers. */
export async function scheduleAlertRecipients(service: SupabaseClient): Promise<string[]> {
  const [schedulers, watchers] = await Promise.all([installSchedulerIds(service), newAlertWatcherIds(service)]);
  return [...new Set([...schedulers, ...watchers])];
}

const PROJECT_FIELDS = 'id, project_name, customer_name, status, netsuite_so_id, netsuite_so_number, customer_dropoff_date, schedule_alert_step';

interface ProjectRow {
  id: string;
  project_name: string | null;
  customer_name: string | null;
  status: string | null;
  netsuite_so_id: string | null;
  netsuite_so_number: string | null;
  customer_dropoff_date: string | null;
  schedule_alert_step: string | null;
}

const jobLabel = (p: ProjectRow) => p.project_name || p.customer_name || 'Job';

function messageFor(p: ProjectRow, step: ScheduleStep) {
  const so = p.netsuite_so_number || 'the sales order';
  const customer = p.customer_name || 'the customer';
  if (step === 'reserve') {
    return {
      type: 'job_reserve_parts',
      title: `Reserve parts: ${jobLabel(p)}`,
      body: `Every part on ${so} shows in stock but isn't reserved for this job yet. Check the shelf, then tap Reserve available on the job. You'll get a "Ready to schedule" alert once they're reserved.`,
      url: deepLinks.upfitProject(p.id, { focus: 'parts' }),
    };
  }
  return {
    type: 'job_ready_to_schedule',
    title: `Ready to schedule: ${jobLabel(p)}`,
    body: `Every part on ${so} is reserved for this job. Call ${customer} and set the drop-off date on the job.`,
    url: deepLinks.upfitProject(p.id, { focus: 'dates' }),
  };
}

/**
 * Bring one job's alert up to date with its verdict: send the step if it
 * is new, clear the remembered step if the job no longer needs anything.
 * The claim is a conditional update, so two runs can't both send it.
 * Returns the step sent, if any. Best-effort; never throws.
 */
export async function syncJobScheduleAlert(
  service: SupabaseClient,
  project: ProjectRow,
  verdict: Verdict | null | undefined,
  opts: { recipients?: string[]; only?: ScheduleStep } = {},
): Promise<ScheduleStep | null> {
  try {
    const step = scheduleStep(project, verdict);
    if (!step) {
      // No verdict means the sweep couldn't judge the job (unsynced SO or
      // items), not that it moved on: keep the step so it can't repeat.
      if (project.schedule_alert_step && !opts.only && verdict) {
        await service.from('upfit_projects')
          .update({ schedule_alert_step: null, schedule_alert_at: null })
          .eq('id', project.id)
          .eq('schedule_alert_step', project.schedule_alert_step);
      }
      return null;
    }
    if (opts.only && step !== opts.only) return null;
    if (project.schedule_alert_step === step) return null;

    const { data: claimed } = await service.from('upfit_projects')
      .update({ schedule_alert_step: step, schedule_alert_at: new Date().toISOString() })
      .eq('id', project.id)
      .or(`schedule_alert_step.is.null,schedule_alert_step.neq.${step}`)
      .select('id');
    if (!claimed || claimed.length === 0) return null;

    const ids = opts.recipients ?? await scheduleAlertRecipients(service);
    if (ids.length > 0) await notifyMany(ids, messageFor(project, step));
    return step;
  } catch (err) {
    console.error('job schedule alert failed:', err);
    return null;
  }
}

/** Someone just changed reservations on the job page: if that finished the
 *  reserving, send "Ready to schedule" now rather than at the next sweep. */
export async function afterReservationChange(service: SupabaseClient, projectId: string, verdict: Verdict | null | undefined) {
  if (verdict !== 'reserved') return;
  const { data } = await service.from('upfit_projects').select(PROJECT_FIELDS).eq('id', projectId).maybeSingle();
  if (data) await syncJobScheduleAlert(service, data as ProjectRow, verdict, { only: 'schedule' });
}

/** Open jobs with a sales order, the ones a parts verdict can exist for. */
async function openJobsWithSo(service: SupabaseClient): Promise<ProjectRow[]> {
  const { data, error } = await service.from('upfit_projects')
    .select(PROJECT_FIELDS)
    .not('netsuite_so_id', 'is', null)
    .not('status', 'in', '(completed,cancelled)')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data || []) as ProjectRow[];
}

async function verdictsFor(service: SupabaseClient, projects: ProjectRow[]) {
  const out: Record<string, Verdict> = {};
  for (let i = 0; i < projects.length; i += 100) {
    const board = await computePartsReadinessBoard(service, projects.slice(i, i + 100).map(p => p.id));
    for (const [id, r] of Object.entries(board)) out[id] = r.verdict;
  }
  return out;
}

/** The hourly sweep: every open job's step, sent once. */
export async function runJobScheduleSweep(service: SupabaseClient) {
  const projects = await openJobsWithSo(service);
  const verdicts = await verdictsFor(service, projects);
  const recipients = await scheduleAlertRecipients(service);
  let reserve = 0;
  let schedule = 0;
  for (const p of projects) {
    const sent = await syncJobScheduleAlert(service, p, verdicts[p.id], { recipients });
    if (sent === 'reserve') reserve++;
    if (sent === 'schedule') schedule++;
  }
  return { checked: projects.length, reserve, schedule, recipients: recipients.length };
}

export interface ReadyToScheduleRow {
  id: string;
  label: string;
  customer: string | null;
  soNumber: string | null;
  step: ScheduleStep;
}

/** Home's "Ready to schedule" list: jobs to reserve, then jobs to book. */
export async function readyToScheduleRows(service: SupabaseClient): Promise<ReadyToScheduleRow[]> {
  const projects = await openJobsWithSo(service);
  const verdicts = await verdictsFor(service, projects);
  const rows: ReadyToScheduleRow[] = [];
  for (const p of projects) {
    const step = scheduleStep(p, verdicts[p.id]);
    if (!step) continue;
    rows.push({ id: p.id, label: jobLabel(p), customer: p.customer_name, soNumber: p.netsuite_so_number, step });
  }
  // Booking first: those jobs are one call away from the calendar.
  return rows.sort((a, b) => (a.step === b.step ? 0 : a.step === 'schedule' ? -1 : 1));
}
