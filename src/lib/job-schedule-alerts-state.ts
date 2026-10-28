/**
 * The pure half of job scheduling alerts (src/lib/job-schedule-alerts.ts),
 * safe to import from client components.
 *
 * Craig (2026-10-28): when a job's parts are in stock but not reserved,
 * whoever schedules installs checks the shelf and reserves them; once every
 * part is reserved they call the customer and set the drop-off date.
 */

export type ScheduleStep = 'reserve' | 'schedule';

/** Job statuses past scheduling: in the bay, done, or cancelled. */
const PAST_SCHEDULING = new Set(['in_progress', 'scheduled_pickup', 'completed', 'cancelled']);

/**
 * What the job needs from the scheduler right now, from its parts verdict:
 * reserve (all in stock, not all reserved), schedule (all reserved, no
 * drop-off date yet), or nothing.
 */
export function scheduleStep(
  project: { status?: string | null; customer_dropoff_date?: string | null },
  verdict: 'reserved' | 'ready' | 'waiting' | 'short' | null | undefined,
): ScheduleStep | null {
  if (PAST_SCHEDULING.has(project.status || '')) return null;
  if (verdict === 'ready') return 'reserve';
  if (verdict === 'reserved' && !project.customer_dropoff_date) return 'schedule';
  return null;
}
