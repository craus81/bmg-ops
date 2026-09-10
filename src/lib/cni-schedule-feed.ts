/**
 * The installer schedule feed (R6-8): a CNI company's confirmed BMG work,
 * rendered as an iCalendar subscription their own calendar app pulls.
 *
 * Two rules shape everything here.
 *
 * ONLY A CONFIRMED DATE BOOKS A DAY. `proposed_schedule_*` is a suggestion
 * nobody has agreed to yet; writing it into a crew's calendar as a normal
 * event is how someone drives to a site on a day the customer never
 * accepted. Proposals stay out.
 *
 * BUT AN UNSCHEDULED JOB IS NOT NOTHING. Work assigned to a company with a
 * deadline and no agreed install date is the job that quietly slides. It
 * rides along as a TRANSPARENT / TENTATIVE marker on the deadline, titled
 * so it cannot be read as a booked day — it blocks no time and says "no
 * install date set" in the summary itself. The moment real dates are
 * confirmed the marker's UID leaves the feed and the real event takes over.
 *
 * All events are all-day (VALUE=DATE) because the underlying columns are
 * DATEs — there is no start time on record, and inventing 8am would put a
 * wrong fact in someone's calendar in whatever timezone their phone is set
 * to. All-day sidesteps timezones entirely.
 */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildCalendar, type IcsEvent } from './ics';
import { deepLinks } from './deep-links';
import { fetchAllRows } from './fetch-all';

/** Statuses where the work is finished — no "due, not scheduled" marker. */
export const CLOSED_STATUSES = ['completed_pending_review', 'approved_closed'];

/** How far back finished work stays visible, and how far ahead we publish. */
export const WINDOW_DAYS_BACK = 90;
export const WINDOW_DAYS_AHEAD = 365;

export interface FeedJob {
  id: string;
  job_number?: string | null;
  title?: string | null;
  customer_name?: string | null;
  status?: string | null;
  deadline?: string | null;
  confirmed_schedule_start?: string | null;
  confirmed_schedule_end?: string | null;
  /** Stamped the moment the dates were agreed — see changedAt below. */
  schedule_confirmed_at?: string | null;
  updated_at?: string | null;
  address?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null;
  site_contact_name?: string | null;
  site_contact_phone?: string | null;
  /** Vehicles on the job — the single number that tells a crew how long a day it is. */
  vinCount?: number | null;
}

export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app').replace(/\/$/, '');
}

/** The subscribe URL. The `.ics` suffix rides on the token segment: some
 *  calendar clients still decide what a URL is by its extension. */
export function scheduleFeedUrl(token: string): string {
  return `${appBaseUrl()}/api/cni/schedule/${token}.ics`;
}

/** `webcal://` hands the URL straight to the desktop calendar app instead of
 *  downloading a one-time snapshot — the difference between a subscription
 *  that keeps updating and a copy frozen at the moment they clicked. */
export function webcalFeedUrl(token: string): string {
  return scheduleFeedUrl(token).replace(/^https?:\/\//, 'webcal://');
}

/** "123 Main St, Springfield, IL 62704" — blanks dropped, null when empty. */
export function formatAddress(address: FeedJob['address']): string | null {
  if (!address) return null;
  const line1 = String(address.street || '').trim();
  const cityState = [String(address.city || '').trim(), String(address.state || '').trim()]
    .filter(Boolean).join(', ');
  const tail = [cityState, String(address.zip || '').trim()].filter(Boolean).join(' ');
  const out = [line1, tail].filter(Boolean).join(', ');
  return out || null;
}

/**
 * The best timestamp we actually have for "when did this event last change".
 *
 * `cni_jobs.updated_at` has no trigger behind it and no writer sets it, so on
 * most rows it is really the creation time — using it alone would put a
 * confidently wrong LAST-MODIFIED on every booking. `schedule_confirmed_at`
 * IS stamped at the moment the dates were agreed, which is exactly when a
 * scheduled event's content changed, so it leads. The later of the two wins,
 * which also means this improves on its own if updated_at ever starts being
 * maintained.
 */
export function changedAt(job: FeedJob): string | null {
  const stamps = [job.schedule_confirmed_at, job.updated_at]
    .map(v => (v ? Date.parse(v) : NaN))
    .filter(t => !Number.isNaN(t));
  if (stamps.length === 0) return null;
  return new Date(Math.max(...stamps)).toISOString();
}

/**
 * SEQUENCE must rise when an event changes or strict clients ignore the
 * update. There is no version counter on cni_jobs, so it is derived from
 * changedAt in MINUTES since 2020 — small enough to stay well inside the
 * 32-bit range clients assume (raw epoch seconds would not be), and monotonic
 * in the only thing that matters, which is that a later edit sorts after an
 * earlier one. Two edits inside one minute share a number. That is a soft
 * floor rather than a hole: this is a PUBLISH feed, which clients re-read
 * whole and diff, not an iTIP invitation where SEQUENCE arbitrates.
 */
const SEQ_EPOCH = Date.parse('2020-01-01T00:00:00Z');
export function sequenceFor(updatedAt?: string | null): number {
  const t = updatedAt ? Date.parse(updatedAt) : NaN;
  if (Number.isNaN(t) || t <= SEQ_EPOCH) return 0;
  return Math.floor((t - SEQ_EPOCH) / 60_000);
}

const jobLabel = (job: FeedJob): string =>
  String(job.title || job.job_number || 'BMG job').trim() || 'BMG job';

/**
 * The body of the event. Everything a crew needs before they can open a
 * laptop: who it's for, how many vehicles, where, who to call on arrival,
 * and a link into the job.
 *
 * The site contact's PHONE is here and their email is not — a number is
 * what a crew uses from the truck, and an email address on an unauthenticated
 * feed is a scrapeable address that buys the field nothing.
 */
export function buildDescription(job: FeedJob, base = appBaseUrl()): string {
  const lines: string[] = [];
  if (job.job_number) lines.push(`Job ${job.job_number}`);
  if (job.customer_name) lines.push(`Customer: ${job.customer_name}`);
  if (job.vinCount != null) {
    lines.push(`${job.vinCount} vehicle${job.vinCount === 1 ? '' : 's'}`);
  }
  const address = formatAddress(job.address);
  if (address) lines.push(`Site: ${address}`);
  const contact = [job.site_contact_name, job.site_contact_phone].filter(Boolean).join(' — ');
  if (contact) lines.push(`Site contact: ${contact}`);
  // The customer-facing due date, alongside the days actually booked. A crew
  // that can see both knows whether a slip has any room in it.
  if (job.deadline) lines.push(`Customer deadline: ${String(job.deadline).slice(0, 10)}`);
  lines.push('');
  lines.push(`${base}${deepLinks.installerJob(job.id)}`);
  return lines.join('\n');
}

/**
 * The calendar events for one job: at most one. A confirmed range wins; a
 * job with no agreed dates but a deadline gets the marker described at the
 * top of this file; anything else contributes nothing.
 */
export function jobEvents(job: FeedJob, base = appBaseUrl()): IcsEvent[] {
  const description = buildDescription(job, base);
  const location = formatAddress(job.address);
  const url = `${base}${deepLinks.installerJob(job.id)}`;
  const changed = changedAt(job);
  const sequence = sequenceFor(changed);
  const start = job.confirmed_schedule_start ? String(job.confirmed_schedule_start).slice(0, 10) : null;

  if (start) {
    // No confirmed end is a one-day job, not an open-ended one. And an end
    // BEFORE the start is bad data, not a zero-length event: DTEND <= DTSTART
    // makes strict clients drop the whole event, so it collapses to the
    // start day and the job stays visible.
    const rawEnd = job.confirmed_schedule_end ? String(job.confirmed_schedule_end).slice(0, 10) : null;
    const end = rawEnd && rawEnd >= start ? rawEnd : start;
    return [{
      uid: `cni-${job.id}@bmgfleet.com`,
      start,
      end,
      summary: `${jobLabel(job)}${job.customer_name ? ` — ${job.customer_name}` : ''}`,
      description,
      location,
      url,
      status: 'CONFIRMED',
      sequence,
      updatedAt: changed,
    }];
  }

  const deadline = job.deadline ? String(job.deadline).slice(0, 10) : null;
  if (!deadline) return [];
  if (CLOSED_STATUSES.includes(String(job.status || ''))) return [];
  return [{
    // A DIFFERENT uid from the scheduled event on purpose: once dates are
    // confirmed this one simply stops appearing in the feed and the client
    // drops it, instead of a booked job inheriting "no install date set".
    uid: `cni-${job.id}-due@bmgfleet.com`,
    start: deadline,
    end: deadline,
    summary: `Due (no install date set): ${jobLabel(job)}`,
    description: `No install date has been agreed for this job yet — open it to propose dates.\n\n${description}`,
    // No LOCATION on purpose, even though the site address is known: a
    // calendar app treats it as somewhere you are going that day, and
    // nobody is travelling to this site on its deadline. The address is
    // still in the body for whoever opens it.
    url,
    // TENTATIVE says nobody has agreed to this date; transparent means it
    // does not book the crew's time. Both are needed — a tentative event
    // that still shows them busy would block real work off their calendar.
    status: 'TENTATIVE',
    transparent: true,
    sequence,
    updatedAt: changed,
  }];
}

export interface FeedResult {
  ics: string;
  counts: { scheduled: number; unscheduled: number; jobs: number };
}

export function buildFeed(
  jobs: FeedJob[],
  opts: { companyName: string; base?: string; now?: string },
): FeedResult {
  const base = opts.base ?? appBaseUrl();
  const events = jobs.flatMap(j => jobEvents(j, base));
  return {
    ics: buildCalendar(events, {
      name: `BMG installs — ${opts.companyName}`,
      refreshMinutes: 60,
      now: opts.now,
    }),
    counts: {
      scheduled: events.filter(e => e.status !== 'TENTATIVE').length,
      unscheduled: events.filter(e => e.status === 'TENTATIVE').length,
      jobs: jobs.length,
    },
  };
}

/** YYYY-MM-DD, `days` from `from`. */
export function shiftDate(from: Date, days: number): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The company's jobs inside the publish window. A job counts when its
 * confirmed range OR its deadline lands in the window, so recently finished
 * work stays in the calendar (a week that empties itself out looks like the
 * feed broke) without publishing the entire history.
 */
export async function loadCompanyJobs(
  service: SupabaseClient,
  companyId: string,
  now = new Date(),
): Promise<FeedJob[]> {
  const from = shiftDate(now, -WINDOW_DAYS_BACK);
  const to = shiftDate(now, WINDOW_DAYS_AHEAD);

  // cni_jobs grows without bound, so every read of it paginates (the
  // PostgREST 1000-row cap is silent). Ordered by id as the unique
  // tiebreaker so pages can't skip or repeat.
  const { data: rows, error } = await fetchAllRows<any>((lo, hi) =>
    service
      .from('cni_jobs')
      .select('id, job_number, title, customer_name, status, deadline, confirmed_schedule_start, confirmed_schedule_end, schedule_confirmed_at, updated_at, address, site_contact_name, site_contact_phone')
      .eq('assigned_company_id', companyId)
      .order('confirmed_schedule_start', { ascending: true, nullsFirst: false })
      .order('id')
      .range(lo, hi),
  );
  if (error) throw new Error(error.message);

  const inWindow = (rows || []).filter((j: any) => {
    const start = j.confirmed_schedule_start ? String(j.confirmed_schedule_start).slice(0, 10) : null;
    const end = j.confirmed_schedule_end ? String(j.confirmed_schedule_end).slice(0, 10) : start;
    if (start) return (end || start) >= from && start <= to;
    const deadline = j.deadline ? String(j.deadline).slice(0, 10) : null;
    return deadline != null && deadline >= from && deadline <= to;
  });
  if (inWindow.length === 0) return [];

  // Vehicle counts in grouped reads rather than a query per job. Chunked
  // because `.in()` rides in the URL: a company with a long history would
  // build a query string long enough to be rejected outright, and a feed that
  // 500s for the busiest installer is the wrong failure to design in.
  const ids = inWindow.map((j: any) => j.id);
  const vinCounts = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data: vins } = await fetchAllRows<{ job_id: string; id: string }>((lo, hi) =>
      service.from('cni_job_vins').select('job_id, id').in('job_id', slice).order('id').range(lo, hi),
    );
    for (const v of vins || []) vinCounts.set(v.job_id, (vinCounts.get(v.job_id) || 0) + 1);
  }

  return inWindow.map((j: any) => ({ ...j, vinCount: vinCounts.get(j.id) ?? null }));
}

/**
 * The company's current feed token, minting one when none exists (or always,
 * with `regenerate`). A regenerate never reuses the old value: the point of
 * regenerating is that every existing subscription stops resolving.
 */
export async function ensureScheduleToken(
  service: SupabaseClient,
  company: { id: string; schedule_token?: string | null; schedule_token_created_at?: string | null },
  opts: { regenerate?: boolean } = {},
): Promise<{ token: string; createdAt: string; changed: boolean }> {
  if (company.schedule_token && !opts.regenerate) {
    return {
      token: company.schedule_token,
      createdAt: company.schedule_token_created_at || new Date().toISOString(),
      changed: false,
    };
  }
  const token = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const { error } = await service
    .from('companies')
    .update({ schedule_token: token, schedule_token_created_at: createdAt })
    .eq('id', company.id);
  if (error) throw new Error(`Could not save the calendar link: ${error.message}`);
  return { token, createdAt, changed: true };
}
