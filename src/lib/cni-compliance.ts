import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * Installer Compliance Autopilot & Eligibility Gate (R6-8).
 *
 * One computed "eligible for work" answer per company and per installer:
 * required documents on file, agreements accepted, insurance unexpired.
 * Nothing is cached — a stored `compliant` flag would go stale the moment a
 * certificate expired overnight and would need its own reconciliation job.
 *
 * THE HONESTY RULE THIS FILE TURNS ON: an insurance certificate with NO
 * expiry date recorded is not compliant. It is UNKNOWN, and unknown is not
 * "fine" — nobody can tell whether that PDF covers today. Treating a missing
 * date as valid is exactly how a lapsed certificate keeps a company working;
 * so it reads as `incomplete` with the reason stated, distinct from `lapsed`
 * (a date that has passed) and from `missing` (no certificate at all).
 *
 * The gate WARNS, it does not hard-block. Assigning a non-compliant company
 * is possible and is recorded as an override with a written reason — the
 * same shape as the estimate approval override — because a hard block on a
 * dataset that has never been audited would stop the business on day one,
 * and an unloggable workaround is worse than a logged exception.
 */

/** Days before expiry a warning goes out; 0 is the lapse itself. */
export const WARN_THRESHOLDS = [30, 14, 7, 3, 0] as const;

export type ComplianceState = 'compliant' | 'expiring' | 'lapsed' | 'incomplete';
export type SubjectType = 'company' | 'installer';

export type FailureReason = 'missing' | 'undated' | 'expired' | 'not_accepted';

export interface Requirement {
  key: string;
  label: string;
  met: boolean;
  /** Why it is not met, in the words the person fixing it needs. */
  detail: string | null;
  /** Machine-readable form of the same thing. Counting on this instead of
   *  pattern-matching `detail` means rewording a message can never silently
   *  change a total. */
  reason?: FailureReason;
}

export interface ComplianceStatus {
  subjectType: SubjectType;
  subjectId: string;
  name: string;
  /** Every requirement met AND insurance not expired. */
  eligible: boolean;
  state: ComplianceState;
  requirements: Requirement[];
  /** Labels of the unmet requirements, for a one-line summary. */
  blocking: string[];
  insuranceExpiry: string | null;
  /** Days until the certificate expires; negative once lapsed. Null when no
   *  date is on file — which is NOT the same as "plenty of time". */
  daysToExpiry: number | null;
}

export interface CompanySubject {
  id: string;
  name: string | null;
  w9_file_path?: string | null;
  insurance_cert_path?: string | null;
  insurance_expiry?: string | null;
}

export interface InstallerSubject {
  user_id: string;
  company_name?: string | null;
  full_name?: string | null;
  w9_file_path?: string | null;
  insurance_cert_path?: string | null;
  insurance_expiry?: string | null;
  terms_accepted_at?: string | null;
  install_expectations_accepted_at?: string | null;
  timeline_agreement_accepted_at?: string | null;
}

const DAY = 86_400_000;

/** Whole days from `today` (YYYY-MM-DD) to an expiry date. Pure. */
export function daysUntil(expiry: string | null | undefined, today: string): number | null {
  if (!expiry) return null;
  const a = Date.parse(`${String(expiry).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / DAY);
}

/**
 * The insurance requirement, which is the one with three distinct failure
 * modes people confuse: no certificate, a certificate with no date, and a
 * date that has passed. Each says something different about what to do.
 */
function insuranceRequirement(
  certPath: string | null | undefined,
  expiry: string | null | undefined,
  days: number | null,
): Requirement {
  if (!certPath) {
    return { key: 'insurance_cert', label: 'Insurance certificate', met: false, detail: 'No certificate on file.', reason: 'missing' };
  }
  if (days == null) {
    return {
      key: 'insurance_cert', label: 'Insurance certificate', met: false, reason: 'undated',
      detail: 'A certificate is on file but no expiry date was recorded, so nobody can tell whether it covers today.',
    };
  }
  if (days < 0) {
    return {
      key: 'insurance_cert', label: 'Insurance certificate', met: false, reason: 'expired',
      detail: `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago (${expiry}).`,
    };
  }
  return { key: 'insurance_cert', label: 'Insurance certificate', met: true, detail: null };
}

function finish(
  subjectType: SubjectType,
  subjectId: string,
  name: string,
  requirements: Requirement[],
  expiry: string | null,
  days: number | null,
): ComplianceStatus {
  const blocking = requirements.filter(r => !r.met).map(r => r.label);
  const eligible = blocking.length === 0;
  const state: ComplianceState = eligible
    ? (days != null && days <= WARN_THRESHOLDS[0] ? 'expiring' : 'compliant')
    : (days != null && days < 0 ? 'lapsed' : 'incomplete');
  return {
    subjectType, subjectId, name, eligible, state, requirements, blocking,
    insuranceExpiry: expiry || null, daysToExpiry: days,
  };
}

const agreement = (key: string, label: string, at: string | null | undefined): Requirement =>
  at
    ? { key, label, met: true, detail: null }
    : { key, label, met: false, detail: 'Not accepted in the portal.', reason: 'not_accepted' };

/** A company's eligibility. Company-level docs only — per-person documents
 *  live on cni_profiles and are evaluated separately (migration 110). */
export function evaluateCompany(c: CompanySubject, today: string): ComplianceStatus {
  const days = daysUntil(c.insurance_expiry, today);
  return finish('company', c.id, c.name || 'Unnamed company', [
    { key: 'w9', label: 'W-9', met: !!c.w9_file_path, detail: c.w9_file_path ? null : 'No W-9 on file.', ...(c.w9_file_path ? {} : { reason: 'missing' as const }) },
    insuranceRequirement(c.insurance_cert_path, c.insurance_expiry, days),
  ], c.insurance_expiry || null, days);
}

/** An individual installer's eligibility: their own documents plus the three
 *  agreements the portal asks them to accept. */
export function evaluateInstaller(p: InstallerSubject, today: string): ComplianceStatus {
  const days = daysUntil(p.insurance_expiry, today);
  return finish('installer', p.user_id, p.full_name || p.company_name || 'Installer', [
    { key: 'w9', label: 'W-9', met: !!p.w9_file_path, detail: p.w9_file_path ? null : 'No W-9 on file.', ...(p.w9_file_path ? {} : { reason: 'missing' as const }) },
    insuranceRequirement(p.insurance_cert_path, p.insurance_expiry, days),
    agreement('terms', 'Terms accepted', p.terms_accepted_at),
    agreement('install_expectations', 'Install expectations accepted', p.install_expectations_accepted_at),
    agreement('timeline_agreement', 'Timeline agreement accepted', p.timeline_agreement_accepted_at),
  ], p.insurance_expiry || null, days);
}

/**
 * Which warning rung is due, given days-to-expiry and the rungs already
 * sent for THIS expiry date. Pure.
 *
 * Returns the LOWEST threshold that has been reached and not yet sent — so a
 * certificate that was never warned about and is 5 days out fires the "7
 * days" warning once, not four warnings in a row. A renewed certificate has
 * a new expiry and therefore no sent rungs, which re-arms the ladder.
 */
export function dueThreshold(days: number | null, alreadySent: number[]): number | null {
  if (days == null) return null;
  const sent = new Set(alreadySent);
  const reached = WARN_THRESHOLDS.filter(t => days <= t && !sent.has(t));
  if (reached.length === 0) return null;
  return Math.min(...reached);
}

export const thresholdLabel = (t: number, days: number) =>
  t === 0
    ? (days === 0 ? 'expires today' : `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`)
    : `expires in ${days} day${days === 1 ? '' : 's'}`;

/* ── loaders ─────────────────────────────────────────────────────────── */

export interface ComplianceOverview {
  companies: ComplianceStatus[];
  installers: ComplianceStatus[];
  totals: {
    companies: number;
    companiesEligible: number;
    companiesExpiring: number;
    installers: number;
    installersEligible: number;
    /** Subjects whose certificate is on file with no date — the count that
     *  makes "how many are we actually sure about" answerable. */
    undatedCertificates: number;
  };
  today: string;
}

/** The America/Chicago calendar date — the shop calendar the rest of the app
 *  counts days on. */
export const shopToday = (at: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(at);

/**
 * Company ids that are actually installer companies: they staff an installer
 * profile, or they have been assigned to / invited onto a CNI job. Anything
 * else in `companies` is out of scope for installer compliance.
 */
export async function cniCompanyIds(service: SupabaseClient): Promise<Set<string>> {
  const [staffed, assigned, invited] = await Promise.all([
    fetchAllRows<any>((from, to) => service
      .from('profiles').select('company_id')
      .not('company_id', 'is', null)
      .or('role.eq.installer,roles.cs.{installer}')
      .order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('cni_jobs').select('assigned_company_id')
      .not('assigned_company_id', 'is', null)
      .order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('cni_job_invites').select('company_id')
      .not('company_id', 'is', null)
      .order('id').range(from, to)),
  ]);
  const out = new Set<string>();
  for (const r of staffed.data || []) out.add(r.company_id);
  for (const r of assigned.data || []) out.add(r.assigned_company_id);
  for (const r of invited.data || []) out.add(r.company_id);
  return out;
}

export async function loadComplianceOverview(
  service: SupabaseClient,
  today: string = shopToday(),
): Promise<ComplianceOverview> {
  // SCOPE: `companies` is the app's one company table (migration 110 —
  // "CNI uses the EXISTING companies table"), so it holds rows that have
  // nothing to do with installing. Judging those non-compliant would fill
  // this panel with companies that were never asked for a W-9. In scope is
  // a company that either staffs an installer or has been put on a CNI job.
  const [companyRes, installerRes] = await Promise.all([
    fetchAllRows<any>((from, to) => service
      .from('companies')
      .select('id, name, w9_file_path, insurance_cert_path, insurance_expiry')
      .order('name').order('id')
      .range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('cni_profiles')
      .select('user_id, company_name, w9_file_path, insurance_cert_path, insurance_expiry, terms_accepted_at, install_expectations_accepted_at, timeline_agreement_accepted_at')
      .order('user_id')
      .range(from, to)),
  ]);
  if (companyRes.error) throw new Error(companyRes.error.message);
  if (installerRes.error) throw new Error(installerRes.error.message);

  // Installer display names come from profiles, not cni_profiles — a CNI
  // profile's company_name is the business, not the person.
  const ids = (installerRes.data || []).map(p => p.user_id);
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await service.from('profiles').select('id, full_name').in('id', ids.slice(i, i + 200));
    for (const p of data || []) if (p.full_name) names.set(p.id, p.full_name);
  }

  const inScope = await cniCompanyIds(service);
  const companies = (companyRes.data || [])
    .filter(c => inScope.has(c.id))
    .map(c => evaluateCompany(c, today));
  const installers = (installerRes.data || [])
    .map(p => evaluateInstaller({ ...p, full_name: names.get(p.user_id) || null }, today));

  const undated = [...companies, ...installers]
    .filter(s => s.requirements.some(r => r.reason === 'undated'))
    .length;

  return {
    companies: companies.sort(sortWorstFirst),
    installers: installers.sort(sortWorstFirst),
    totals: {
      companies: companies.length,
      companiesEligible: companies.filter(c => c.eligible).length,
      companiesExpiring: companies.filter(c => c.state === 'expiring').length,
      installers: installers.length,
      installersEligible: installers.filter(i => i.eligible).length,
      undatedCertificates: undated,
    },
    today,
  };
}

/** Worst first: lapsed, then incomplete, then expiring soonest, then clean. */
const STATE_RANK: Record<ComplianceState, number> = { lapsed: 0, incomplete: 1, expiring: 2, compliant: 3 };
function sortWorstFirst(a: ComplianceStatus, b: ComplianceStatus): number {
  const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (byState !== 0) return byState;
  return (a.daysToExpiry ?? 9999) - (b.daysToExpiry ?? 9999);
}

/** One company's status — the gate's read on the assign/invite path. */
export async function companyCompliance(
  service: SupabaseClient,
  companyId: string,
  today: string = shopToday(),
): Promise<ComplianceStatus | null> {
  const { data } = await service
    .from('companies')
    .select('id, name, w9_file_path, insurance_cert_path, insurance_expiry')
    .eq('id', companyId)
    .maybeSingle();
  return data ? evaluateCompany(data, today) : null;
}

/* ── the daily sweep ─────────────────────────────────────────────────── */

export interface SweepResult {
  checked: number;
  warned: number;
  /** Subjects that needed no warning today. */
  quiet: number;
  errors: string[];
}

export interface SweepDeps {
  /** Ping the people who can fix it. Never throws. */
  notify: (userIds: string[], payload: { type: string; title: string; body: string; url: string; force?: boolean }) => Promise<void>;
  /** Installers at a company — the audience for a company-level warning. */
  companyInstallers: (companyId: string) => Promise<string[]>;
  /** CNI staff, who chase the paperwork. They get ONE digest per run. */
  staffIds: () => Promise<string[]>;
  installerProfileUrl: string;
  consoleUrl: string;
}

/**
 * Warn about insurance that is running out, once per rung.
 *
 * Only subjects with an expiry DATE are warned: an undated certificate is a
 * compliance problem the panel shows, but there is no date to count down to
 * and inventing a warning for it would be noise on a fact nobody can act on
 * by waiting.
 *
 * Notices are recorded BEFORE the send, keyed to (subject, expiry,
 * threshold). A send that then fails costs one warning; a crash between
 * sending and recording would re-send every morning, which is how people
 * learn to ignore the alert.
 */
export async function sweepCompliance(
  service: SupabaseClient,
  deps: SweepDeps,
  today: string = shopToday(),
): Promise<SweepResult> {
  const overview = await loadComplianceOverview(service, today);
  const subjects = [...overview.companies, ...overview.installers].filter(s => s.insuranceExpiry);
  const result: SweepResult = { checked: subjects.length, warned: 0, quiet: 0, errors: [] };
  if (subjects.length === 0) return result;

  const { data: notices, error } = await fetchAllRows<any>((from, to) => service
    .from('cni_compliance_notices')
    .select('subject_type, subject_id, expiry, threshold')
    .order('subject_id').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);

  const sentByKey = new Map<string, number[]>();
  for (const n of notices || []) {
    const key = `${n.subject_type}:${n.subject_id}:${String(n.expiry).slice(0, 10)}`;
    const arr = sentByKey.get(key) || [];
    arr.push(Number(n.threshold));
    sentByKey.set(key, arr);
  }

  const staff = await deps.staffIds().catch(() => [] as string[]);
  const staffLines: string[] = [];

  for (const s of subjects) {
    const expiry = String(s.insuranceExpiry).slice(0, 10);
    const key = `${s.subjectType}:${s.subjectId}:${expiry}`;
    const threshold = dueThreshold(s.daysToExpiry, sentByKey.get(key) || []);
    if (threshold == null) { result.quiet += 1; continue; }

    // Record first: a duplicate insert loses the race and skips the send.
    const { error: claimErr } = await service
      .from('cni_compliance_notices')
      .insert({ subject_type: s.subjectType, subject_id: s.subjectId, expiry, threshold });
    if (claimErr) {
      if (claimErr.code !== '23505') result.errors.push(`${s.name}: ${claimErr.message}`);
      continue;
    }

    const when = thresholdLabel(threshold, s.daysToExpiry!);
    const lapsed = (s.daysToExpiry ?? 0) < 0;
    const audience = s.subjectType === 'installer'
      ? [s.subjectId]
      : await deps.companyInstallers(s.subjectId).catch(() => [] as string[]);

    if (audience.length > 0) {
      await deps.notify(audience, {
        type: 'cni_compliance',
        title: lapsed ? 'Your insurance certificate has expired' : `Insurance ${when}`,
        body: lapsed
          ? `The certificate on file for ${s.name} ${when}. New work cannot be assigned until a current one is uploaded. Open your profile to upload it and enter the new expiry date.`
          : `The certificate on file for ${s.name} ${when}. Upload the renewal and enter the new expiry date on your profile — the flag clears itself.`,
        url: deps.installerProfileUrl,
        // External installer audience: no preference rows to consult, and
        // this is addressed to them about their own eligibility.
        force: true,
      }).catch((e: any) => result.errors.push(`${s.name} notify: ${e?.message || e}`));
    }

    staffLines.push(`${s.name} — insurance ${when}`);
    result.warned += 1;
  }

  // ONE digest for staff, however many subjects moved today. The first run
  // after this ships will find every stale certificate at once; twenty
  // separate pings that morning is how an alert gets muted on day one.
  if (staff.length > 0 && staffLines.length > 0) {
    await deps.notify(staff, {
      type: 'cni_compliance',
      title: staffLines.length === 1
        ? 'An installer\u2019s insurance needs attention'
        : `${staffLines.length} installers\u2019 insurance needs attention`,
      body: `${staffLines.join('\n')}\n\nEach has been asked to upload a current certificate. Anyone lapsed is no longer eligible for work.`,
      url: deps.consoleUrl,
    }).catch((e: any) => result.errors.push(`staff digest: ${e?.message || e}`));
  }
  return result;
}
