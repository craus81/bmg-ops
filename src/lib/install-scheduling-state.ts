/**
 * The pure half of install scheduling (src/lib/install-scheduling.ts),
 * safe to import from client components: which jobs get installed, which
 * still need a date, and the long date the confirmation prints.
 */

/** Delivery methods whose job ends with an install someone has to book. */
export const INSTALLED_DELIVERY_METHODS = ['onsite_install', 'bmg_shop'] as const;

/** Statuses a job can't be scheduled from any more. */
export const DONE_STATUSES = ['shipped', 'picked_up', 'installed', 'cancelled'];

export interface SchedulableJob {
  delivery_method?: string | null;
  scheduled_install_date?: string | null;
  status?: string | null;
  customer_approved?: boolean | null;
}

/** An installed job (onsite or our shop) that isn't finished. */
export function isInstalledJob(job: SchedulableJob): boolean {
  return (INSTALLED_DELIVERY_METHODS as readonly string[]).includes(job.delivery_method || '')
    && !DONE_STATUSES.includes(job.status || '');
}

/** Approved, gets installed, and nobody has picked a date yet. "N/A" means
 *  someone decided there is no install, so it is not waiting on anyone. */
export function needsInstallDate(job: SchedulableJob): boolean {
  return !!job.customer_approved && isInstalledJob(job) && !job.scheduled_install_date;
}

/** "Wednesday, November 4, 2026" from YYYY-MM-DD (no timezone drift). */
export function longDate(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

