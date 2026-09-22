import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { rankCompanies, nextBestCompany, type CompanyMatch } from './invite-matching';

/**
 * Invite & Bid SLA Engine (R6-8).
 *
 * An unanswered invite is the CNI pipeline's quiet failure: the coordinator
 * assumes it is being considered, the installer never opened the portal, and
 * the job sits there until the deadline is close enough to hurt. This ages
 * every invite against a clock, re-pings once, and tells the coordinator
 * when a job has nobody coming.
 *
 * Two wording rules the panel is built around, because both are easy to get
 * wrong in a way that misleads:
 *
 *  - "Unseen" means THE PORTAL never recorded a view. It does not mean the
 *    installer is ignoring you — they may have the email, or have called.
 *    The label says "no view recorded", because that is the fact we have.
 *  - A job whose invites were all DECLINED is not "waiting on responses".
 *    It has its answer and the answer is no. That is more urgent than
 *    silence, not less, and it gets its own state rather than being lumped
 *    in with the unanswered.
 */

/** Hours an invite may sit unanswered before it is late. */
export const SLA_HOURS = 48;

export type InviteState = 'unseen' | 'seen_unanswered' | 'interested' | 'declined';

export const STATE_LABEL: Record<InviteState, string> = {
  unseen: 'No view recorded',
  seen_unanswered: 'Opened, no answer',
  interested: 'Interested',
  declined: 'Declined',
};

export interface InviteInput {
  id: string;
  jobId: string;
  companyId: string | null;
  companyName: string | null;
  sentAt: string;
  seenAt: string | null;
  repingedAt: string | null;
  response: 'interested' | 'declined' | null;
  declineReason: string | null;
  respondedAt: string | null;
}

export interface InviteAging extends InviteInput {
  state: InviteState;
  hoursOut: number;
  /** Hours from sent to answered, for the ones that did answer. */
  hoursToRespond: number | null;
  /** Unanswered and past the SLA. An answered invite is never breached,
   *  however slow the answer was — the clock is for chasing, not scoring. */
  breached: boolean;
}

const HOUR = 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pure. `now` is an ISO instant. */
export function ageInvite(i: InviteInput, now: string): InviteAging {
  const sent = Date.parse(i.sentAt);
  const nowMs = Date.parse(now);
  const hoursOut = Number.isFinite(sent) ? Math.max(0, round1((nowMs - sent) / HOUR)) : 0;
  const state: InviteState = i.response === 'interested' ? 'interested'
    : i.response === 'declined' ? 'declined'
    : i.seenAt ? 'seen_unanswered'
    : 'unseen';
  const answered = state === 'interested' || state === 'declined';
  const respondedMs = i.respondedAt ? Date.parse(i.respondedAt) : NaN;
  return {
    ...i,
    state,
    hoursOut,
    hoursToRespond: answered && Number.isFinite(respondedMs) && Number.isFinite(sent)
      ? Math.max(0, round1((respondedMs - sent) / HOUR))
      : null,
    breached: !answered && hoursOut > SLA_HOURS,
  };
}

export type JobSlaState = 'ok' | 'waiting' | 'late' | 'all_declined' | 'no_invites';

export const JOB_STATE_LABEL: Record<JobSlaState, string> = {
  ok: 'Has an interested installer',
  waiting: 'Waiting on responses',
  late: 'Past SLA with no takers',
  all_declined: 'Everyone declined',
  no_invites: 'Nobody invited yet',
};

export interface JobSla {
  jobId: string;
  jobNumber: string | null;
  title: string | null;
  status: string | null;
  deadline: string | null;
  invites: InviteAging[];
  interested: number;
  declined: number;
  unanswered: number;
  breachedInvites: number;
  /** Hours since the OLDEST invite went out. Null with no invites. */
  oldestHoursOut: number | null;
  state: JobSlaState;
  alertedAt: string | null;
}

/**
 * One job's standing. Pure.
 *
 * `all_declined` outranks `late`: knowing nobody is coming is a different
 * and more actionable problem than not knowing yet, and rolling it into
 * "past SLA" would hide the certainty.
 */
export function jobSla(
  job: { id: string; jobNumber: string | null; title: string | null; status: string | null; deadline: string | null; alertedAt: string | null },
  invites: InviteAging[],
): JobSla {
  const interested = invites.filter(i => i.state === 'interested').length;
  const declined = invites.filter(i => i.state === 'declined').length;
  const unanswered = invites.length - interested - declined;
  const breachedInvites = invites.filter(i => i.breached).length;
  const oldestHoursOut = invites.length ? Math.max(...invites.map(i => i.hoursOut)) : null;

  const state: JobSlaState =
    invites.length === 0 ? 'no_invites'
    : interested > 0 ? 'ok'
    : unanswered === 0 ? 'all_declined'
    : breachedInvites > 0 ? 'late'
    : 'waiting';

  return {
    jobId: job.id, jobNumber: job.jobNumber, title: job.title, status: job.status,
    deadline: job.deadline, invites, interested, declined, unanswered,
    breachedInvites, oldestHoursOut, state, alertedAt: job.alertedAt,
  };
}

/** States that mean a coordinator has to do something. */
export const NEEDS_ACTION: JobSlaState[] = ['late', 'all_declined', 'no_invites'];

/** Jobs still looking for an installer — the only ones an invite SLA is
 *  about. Once a company is assigned the clock is irrelevant. */
export const OPEN_STATUSES = ['awaiting_assignment', 'bidding_open'];

/* ── loader ──────────────────────────────────────────────────────────── */

export interface SlaBoard {
  jobs: JobSla[];
  totals: {
    open: number;
    late: number;
    allDeclined: number;
    noInvites: number;
    /** Median hours to a response across ANSWERED invites in the window —
     *  the number that says whether 48h is even the right SLA. Null until
     *  there are answers to measure. */
    medianResponseHours: number | null;
    answeredSamples: number;
  };
  slaHours: number;
  generatedAt: string;
}

export async function loadSlaBoard(service: SupabaseClient, now = new Date().toISOString()): Promise<SlaBoard> {
  const { data: jobs, error } = await fetchAllRows<any>((from, to) => service
    .from('cni_jobs')
    .select('id, job_number, title, status, deadline, invite_sla_alerted_at')
    .in('status', OPEN_STATUSES)
    .order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const jobRows = jobs || [];
  if (jobRows.length === 0) {
    return {
      jobs: [],
      totals: { open: 0, late: 0, allDeclined: 0, noInvites: 0, medianResponseHours: null, answeredSamples: 0 },
      slaHours: SLA_HOURS, generatedAt: now,
    };
  }

  const jobIds = jobRows.map(j => j.id);
  const invitesByJob = new Map<string, InviteInput[]>();
  const companyNames = new Map<string, string>();
  const bids = new Map<string, any>();

  for (let i = 0; i < jobIds.length; i += 100) {
    const slice = jobIds.slice(i, i + 100);
    const [invRes, bidRes] = await Promise.all([
      fetchAllRows<any>((from, to) => service
        .from('cni_job_invites')
        .select('id, job_id, company_id, sent_at, seen_at, repinged_at')
        .in('job_id', slice).order('job_id').order('id').range(from, to)),
      fetchAllRows<any>((from, to) => service
        .from('cni_job_bids')
        .select('job_id, company_id, response, decline_reason, responded_at')
        .in('job_id', slice).order('job_id').order('id').range(from, to)),
    ]);
    if (invRes.error) throw new Error(invRes.error.message);
    if (bidRes.error) throw new Error(bidRes.error.message);
    for (const b of bidRes.data || []) bids.set(`${b.job_id}:${b.company_id || ''}`, b);
    for (const r of invRes.data || []) {
      const arr = invitesByJob.get(r.job_id) || [];
      arr.push({
        id: r.id, jobId: r.job_id, companyId: r.company_id || null, companyName: null,
        sentAt: r.sent_at, seenAt: r.seen_at || null, repingedAt: r.repinged_at || null,
        response: null, declineReason: null, respondedAt: null,
      });
      invitesByJob.set(r.job_id, arr);
    }
  }

  const companyIds = [...new Set([...invitesByJob.values()].flat().map(i => i.companyId).filter(Boolean))] as string[];
  for (let i = 0; i < companyIds.length; i += 200) {
    const { data } = await service.from('companies').select('id, name').in('id', companyIds.slice(i, i + 200));
    for (const c of data || []) companyNames.set(c.id, c.name || 'Unnamed company');
  }

  const answered: number[] = [];
  const out: JobSla[] = jobRows.map(j => {
    const aged = (invitesByJob.get(j.id) || []).map(inv => {
      const bid = bids.get(`${j.id}:${inv.companyId || ''}`);
      const withBid: InviteInput = {
        ...inv,
        companyName: inv.companyId ? (companyNames.get(inv.companyId) || null) : null,
        response: bid?.response || null,
        declineReason: bid?.decline_reason || null,
        respondedAt: bid?.responded_at || null,
      };
      const a = ageInvite(withBid, now);
      if (a.hoursToRespond != null) answered.push(a.hoursToRespond);
      return a;
    }).sort((x, y) => y.hoursOut - x.hoursOut);

    return jobSla({
      id: j.id, jobNumber: j.job_number, title: j.title, status: j.status,
      deadline: j.deadline, alertedAt: j.invite_sla_alerted_at || null,
    }, aged);
  }).sort(worstFirst);

  return {
    jobs: out,
    totals: {
      open: out.length,
      late: out.filter(j => j.state === 'late').length,
      allDeclined: out.filter(j => j.state === 'all_declined').length,
      noInvites: out.filter(j => j.state === 'no_invites').length,
      medianResponseHours: median(answered),
      answeredSamples: answered.length,
    },
    slaHours: SLA_HOURS,
    generatedAt: now,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round1(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

const JOB_RANK: Record<JobSlaState, number> = { all_declined: 0, late: 1, no_invites: 2, waiting: 3, ok: 4 };
function worstFirst(a: JobSla, b: JobSla): number {
  const byState = JOB_RANK[a.state] - JOB_RANK[b.state];
  if (byState !== 0) return byState;
  return (b.oldestHoursOut ?? 0) - (a.oldestHoursOut ?? 0);
}

/** The next company to try, from the R6-5 ranking, excluding everyone
 *  already invited. Re-exported so the SLA alert can name a name instead of
 *  saying "try someone else". */
export { rankCompanies, nextBestCompany };
export type { CompanyMatch };

/* ── the sweep pass ──────────────────────────────────────────────────── */

export interface SlaSweepResult {
  jobsChecked: number;
  invitesRepinged: number;
  jobsAlerted: number;
  errors: string[];
}

export interface SlaSweepDeps {
  notify: (userIds: string[], payload: { type: string; title: string; body: string; url: string; force?: boolean }) => Promise<void>;
  companyInstallers: (companyId: string) => Promise<string[]>;
  staffIds: () => Promise<string[]>;
  installerJobUrl: (jobId: string) => string;
  adminJobUrl: (jobId: string) => string;
  /** The R6-5 ranking's top pick excluding everyone already invited, so the
   *  alert can name a company instead of saying "try someone else". Returns
   *  null when the ranking is unavailable or has nothing left to suggest. */
  suggestNext: (jobId: string, alreadyInvited: string[]) => Promise<{ companyId: string; companyName: string } | null>;
}

/**
 * Pass 2 of the shared CNI sweep: re-ping unanswered invites past the SLA,
 * once each, and tell the coordinator about jobs with nobody coming.
 *
 * Both nudges are once-only by design. A re-ping every morning trains an
 * installer to filter the sender, and a daily "still no takers" on a job the
 * coordinator already saw and chose to wait on is the alert that gets muted.
 * The stamps are written BEFORE the send: a failed send costs one nudge,
 * whereas a crash between sending and stamping repeats it forever.
 */
export async function sweepInviteSla(
  service: SupabaseClient,
  deps: SlaSweepDeps,
  now = new Date().toISOString(),
): Promise<SlaSweepResult> {
  const board = await loadSlaBoard(service, now);
  const result: SlaSweepResult = { jobsChecked: board.jobs.length, invitesRepinged: 0, jobsAlerted: 0, errors: [] };

  for (const job of board.jobs) {
    // 1. Re-ping breached invites that have never been automatically nudged.
    for (const inv of job.invites) {
      if (!inv.breached || inv.repingedAt || !inv.companyId) continue;
      const { error } = await service
        .from('cni_job_invites')
        .update({ repinged_at: now })
        .eq('id', inv.id)
        .is('repinged_at', null);
      if (error) { result.errors.push(`re-ping ${inv.id}: ${error.message}`); continue; }

      const installers = await deps.companyInstallers(inv.companyId).catch(() => [] as string[]);
      if (installers.length > 0) {
        await deps.notify(installers, {
          type: 'cni_invite_reminder',
          title: `Still open: ${job.jobNumber || job.title || 'a BMG job'}`,
          body: `You were invited ${Math.round(inv.hoursOut / 24)} day${Math.round(inv.hoursOut / 24) === 1 ? '' : 's'} ago and we have not heard back.`
            + `${job.deadline ? ` The job is needed by ${job.deadline}.` : ''} Open it to say yes or no — a no is genuinely useful, it lets us move on.`,
          url: deps.installerJobUrl(job.jobId),
          // External installer audience, addressed to them about their own invite.
          force: true,
        }).catch((e: any) => result.errors.push(`re-ping notify ${inv.id}: ${e?.message || e}`));
      }
      result.invitesRepinged += 1;
    }

    // 2. Alert the coordinator when the job has no takers, once per job.
    if (!NEEDS_ACTION.includes(job.state) || job.state === 'no_invites') continue;
    if (job.alertedAt) continue;

    const { error: stampErr } = await service
      .from('cni_jobs')
      .update({ invite_sla_alerted_at: now })
      .eq('id', job.jobId)
      .is('invite_sla_alerted_at', null);
    if (stampErr) { result.errors.push(`alert stamp ${job.jobId}: ${stampErr.message}`); continue; }

    const staff = await deps.staffIds().catch(() => [] as string[]);
    if (staff.length > 0) {
      const invited = job.invites.map(i => i.companyId).filter(Boolean) as string[];
      const next = await deps.suggestNext(job.jobId, invited).catch(() => null);
      const declinedWhy = job.invites
        .filter(i => i.state === 'declined' && i.declineReason)
        .map(i => `${i.companyName || 'A company'}: ${i.declineReason}`);

      await deps.notify(staff, {
        type: 'cni_invite_sla',
        title: job.state === 'all_declined'
          ? `Nobody accepted ${job.jobNumber || job.title || 'a CNI job'}`
          : `No answer on ${job.jobNumber || job.title || 'a CNI job'}`,
        body: [
          job.state === 'all_declined'
            ? `All ${job.declined} invited compan${job.declined === 1 ? 'y' : 'ies'} declined.`
            : `${job.unanswered} of ${job.invites.length} invites are past ${SLA_HOURS}h with no answer.`,
          ...(declinedWhy.length ? ['', 'Reasons given:', ...declinedWhy] : []),
          ...(next ? ['', `Next best match not yet invited: ${next.companyName}.`] : []),
        ].join('\n'),
        url: deps.adminJobUrl(job.jobId),
      }).catch((e: any) => result.errors.push(`alert notify ${job.jobId}: ${e?.message || e}`));
    }
    result.jobsAlerted += 1;
  }
  return result;
}
