import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * Auto-computed CNI installer scorecards (R5-12): coordinators decided who
 * gets work on hand-typed ratings that went stale and a jobs_completed
 * counter nothing increments. The system already records every fact those
 * ratings guess at — status changes, photo verdicts, invite/bid times,
 * per-VIN completions — so scorecards are COMPUTED from raw history on
 * request, current 90 days plus the prior 90 for trend. No rollup table:
 * the raw timestamps go back to each capture's beginning, which is the
 * backfill the audit doc says is possible.
 *
 * Two grains (the doc's attribution trap): companies (assignment is
 * company-level since the CNI redesign — cni_jobs.assigned_company_id) and
 * individual installers (legacy assigned_installer_id, photo uploaders,
 * invite/bid responders).
 *
 * Photo first-pass respects the R3-2 effective-set rule: photos group per
 * (job, vin, type) and only the FIRST decided photo of each set counts —
 * a reshoot never double-counts the denial that caused it.
 */

export interface CniScorecard {
  jobsCompleted: number;
  /** Among completed jobs that HAD a deadline: % completed on/before it. */
  onTimeRate: number | null;
  onTimeSamples: number;
  /** % of photo sets whose FIRST decided photo passed (approved or conditional). */
  photoFirstPassRate: number | null;
  photoSets: number;
  photoDenials: number;
  medianResponseHours: number | null;
  responseSamples: number;
  /** Declined ÷ responded bids. */
  declineRate: number | null;
  vehiclesCompleted: number;
}

export interface CniScorecardWithTrend extends CniScorecard {
  prev: CniScorecard;
}

export interface CniFacts {
  jobs: { id: string; companyId: string | null; installerId: string | null; deadline: string | null }[];
  /** First transition per job into a completed status. */
  completions: { jobId: string; at: string }[];
  photos: { jobId: string; vinId: string | null; photoType: string; uploadedBy: string | null; uploadedAt: string; reviewStatus: string }[];
  invites: { jobId: string; installerId: string; sentAt: string }[];
  bids: { jobId: string; installerId: string; response: string; respondedAt: string }[];
  vins: { jobId: string; completedAt: string }[];
  /** profiles.company_id per installer user — company attribution for invites/bids/photos. */
  companyByUser: Record<string, string | null>;
}

const emptyCard = (): CniScorecard => ({
  jobsCompleted: 0, onTimeRate: null, onTimeSamples: 0,
  photoFirstPassRate: null, photoSets: 0, photoDenials: 0,
  medianResponseHours: null, responseSamples: 0, declineRate: null,
  vehiclesCompleted: 0,
});

interface Tally {
  completed: number; onTime: number; withDeadline: number;
  photoSets: number; photoFirstPass: number; photoDenials: number;
  responseHours: number[]; responded: number; declined: number;
  vins: number;
}
const emptyTally = (): Tally => ({
  completed: 0, onTime: 0, withDeadline: 0,
  photoSets: 0, photoFirstPass: 0, photoDenials: 0,
  responseHours: [], responded: 0, declined: 0, vins: 0,
});

function finishTally(t: Tally): CniScorecard {
  const hours = [...t.responseHours].sort((a, b) => a - b);
  const mid = Math.floor(hours.length / 2);
  return {
    jobsCompleted: t.completed,
    onTimeRate: t.withDeadline > 0 ? Math.round((t.onTime / t.withDeadline) * 100) : null,
    onTimeSamples: t.withDeadline,
    photoFirstPassRate: t.photoSets > 0 ? Math.round((t.photoFirstPass / t.photoSets) * 100) : null,
    photoSets: t.photoSets,
    photoDenials: t.photoDenials,
    medianResponseHours: hours.length > 0
      ? Math.round((hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2) * 10) / 10
      : null,
    responseSamples: hours.length,
    declineRate: t.responded > 0 ? Math.round((t.declined / t.responded) * 100) : null,
    vehiclesCompleted: t.vins,
  };
}

/** Compute both grains for [start, end) and [prevStart, start). Pure. */
export function computeCniScorecards(
  facts: CniFacts,
  prevStart: string,
  start: string,
): { companies: Record<string, CniScorecardWithTrend>; installers: Record<string, CniScorecardWithTrend> } {
  const jobById = new Map(facts.jobs.map(j => [j.id, j]));
  type Grain = 'companies' | 'installers';
  const tallies: Record<Grain, Map<string, { cur: Tally; prev: Tally }>> = {
    companies: new Map(), installers: new Map(),
  };
  const bump = (grain: Grain, key: string | null | undefined, at: string, fn: (t: Tally) => void) => {
    if (!key) return;
    const window = at >= start ? 'cur' : at >= prevStart ? 'prev' : null;
    if (!window) return;
    let entry = tallies[grain].get(key);
    if (!entry) { entry = { cur: emptyTally(), prev: emptyTally() }; tallies[grain].set(key, entry); }
    fn(entry[window]);
  };
  const bumpBoth = (jobId: string, at: string, fn: (t: Tally) => void, installerKey?: string | null) => {
    const job = jobById.get(jobId);
    bump('companies', job?.companyId, at, fn);
    bump('installers', installerKey !== undefined ? installerKey : job?.installerId, at, fn);
  };

  for (const c of facts.completions) {
    const job = jobById.get(c.jobId);
    const day = c.at.slice(0, 10);
    const onTime = job?.deadline ? day <= job.deadline : null;
    bumpBoth(c.jobId, c.at, t => {
      t.completed++;
      if (onTime != null) { t.withDeadline++; if (onTime) t.onTime++; }
    });
  }

  // Effective photo sets: first DECIDED photo per (job, vin, type).
  const sets = new Map<string, { at: string; passed: boolean; denied: boolean; uploadedBy: string | null }>();
  const sorted = [...facts.photos].sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
  for (const p of sorted) {
    if (p.reviewStatus === 'pending') continue;
    const key = `${p.jobId}|${p.vinId || 'job'}|${p.photoType}`;
    if (sets.has(key)) continue; // only the FIRST decided photo of the set counts
    sets.set(key, {
      at: p.uploadedAt,
      passed: p.reviewStatus === 'approved' || p.reviewStatus === 'conditionally_approved',
      denied: p.reviewStatus === 'denied',
      uploadedBy: p.uploadedBy,
    });
  }
  for (const [key, s] of sets) {
    const jobId = key.split('|')[0];
    bumpBoth(jobId, s.at, t => {
      t.photoSets++;
      if (s.passed) t.photoFirstPass++;
      if (s.denied) t.photoDenials++;
    }, s.uploadedBy || null);
  }

  // Invite → response times; declines among responses.
  const bidByPair = new Map(facts.bids.map(b => [`${b.jobId}|${b.installerId}`, b]));
  for (const inv of facts.invites) {
    const bid = bidByPair.get(`${inv.jobId}|${inv.installerId}`);
    if (!bid) continue;
    const hours = (new Date(bid.respondedAt).getTime() - new Date(inv.sentAt).getTime()) / 3_600_000;
    if (hours < 0) continue;
    const fn = (t: Tally) => {
      t.responseHours.push(hours);
      t.responded++;
      if (bid.response === 'declined') t.declined++;
    };
    bump('installers', inv.installerId, inv.sentAt, fn);
    bump('companies', facts.companyByUser[inv.installerId], inv.sentAt, fn);
  }

  for (const v of facts.vins) {
    bumpBoth(v.jobId, v.completedAt, t => { t.vins++; });
  }

  const out = { companies: {} as Record<string, CniScorecardWithTrend>, installers: {} as Record<string, CniScorecardWithTrend> };
  for (const grain of ['companies', 'installers'] as const) {
    for (const [key, entry] of tallies[grain]) {
      out[grain][key] = { ...finishTally(entry.cur), prev: finishTally(entry.prev) };
    }
  }
  return out;
}

const COMPLETED_STATUSES = ['completed_pending_review', 'approved_closed'];

export async function loadCniScorecards(service: SupabaseClient, windowDays = 90): Promise<{
  windowDays: number;
  companies: Record<string, CniScorecardWithTrend>;
  installers: Record<string, CniScorecardWithTrend>;
}> {
  const start = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const prevStart = new Date(Date.now() - 2 * windowDays * 86_400_000).toISOString();

  const [jobsRes, historyRes, photosRes, invitesRes, bidsRes, vinsRes] = await Promise.all([
    fetchAllRows<any>((from, to) => service
      .from('cni_jobs')
      .select('id, assigned_company_id, assigned_installer_id, deadline')
      .order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('cni_job_status_history')
      .select('job_id, to_status, created_at')
      .in('to_status', COMPLETED_STATUSES)
      .gte('created_at', prevStart)
      .order('created_at').order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('cni_job_photos')
      .select('job_id, vin_id, photo_type, uploaded_by, uploaded_at, review_status')
      .gte('uploaded_at', prevStart)
      .order('uploaded_at').order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('cni_job_invites')
      .select('job_id, installer_id, sent_at')
      .gte('sent_at', prevStart)
      .order('sent_at').order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('cni_job_bids')
      .select('job_id, installer_id, response, responded_at')
      .gte('responded_at', prevStart)
      .order('responded_at').order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('cni_job_vins')
      .select('job_id, completed_at')
      .not('completed_at', 'is', null)
      .gte('completed_at', prevStart)
      .order('completed_at').order('id').range(from, to)),
  ]);
  for (const r of [jobsRes, historyRes, photosRes, invitesRes, bidsRes, vinsRes]) {
    if (r.error) throw new Error(r.error.message);
  }

  // First completion transition per job only.
  const seen = new Set<string>();
  const completions: CniFacts['completions'] = [];
  for (const h of historyRes.data || []) {
    if (seen.has(h.job_id)) continue;
    seen.add(h.job_id);
    completions.push({ jobId: h.job_id, at: h.created_at });
  }

  // Company attribution for invite/bid/photo actors.
  const userIds = [...new Set([
    ...(invitesRes.data || []).map((i: any) => i.installer_id),
    ...(photosRes.data || []).map((p: any) => p.uploaded_by),
  ].filter(Boolean))] as string[];
  const companyByUser: Record<string, string | null> = {};
  for (let i = 0; i < userIds.length; i += 200) {
    const { data } = await service
      .from('profiles').select('id, company_id').in('id', userIds.slice(i, i + 200));
    for (const p of data || []) companyByUser[p.id] = p.company_id || null;
  }

  const facts: CniFacts = {
    jobs: (jobsRes.data || []).map((j: any) => ({
      id: j.id, companyId: j.assigned_company_id, installerId: j.assigned_installer_id, deadline: j.deadline,
    })),
    completions,
    photos: (photosRes.data || []).map((p: any) => ({
      jobId: p.job_id, vinId: p.vin_id, photoType: p.photo_type,
      uploadedBy: p.uploaded_by, uploadedAt: p.uploaded_at, reviewStatus: p.review_status,
    })),
    invites: (invitesRes.data || []).map((i: any) => ({ jobId: i.job_id, installerId: i.installer_id, sentAt: i.sent_at })),
    bids: (bidsRes.data || []).map((b: any) => ({ jobId: b.job_id, installerId: b.installer_id, response: b.response, respondedAt: b.responded_at })),
    vins: (vinsRes.data || []).map((v: any) => ({ jobId: v.job_id, completedAt: v.completed_at })),
    companyByUser,
  };

  return { windowDays, ...computeCniScorecards(facts, prevStart, start) };
}

/** Compact chip text ("12 jobs · 92% on time · 88% photo pass · ~5h response"). */
export function cniChipText(s: CniScorecard): string | null {
  const parts: string[] = [];
  if (s.jobsCompleted > 0) parts.push(`${s.jobsCompleted} job${s.jobsCompleted !== 1 ? 's' : ''}`);
  if (s.onTimeRate != null) parts.push(`${s.onTimeRate}% on time`);
  if (s.photoFirstPassRate != null) parts.push(`${s.photoFirstPassRate}% photo first-pass`);
  if (s.medianResponseHours != null) parts.push(`~${s.medianResponseHours}h response`);
  if (s.declineRate != null && s.declineRate > 0) parts.push(`${s.declineRate}% declines`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
