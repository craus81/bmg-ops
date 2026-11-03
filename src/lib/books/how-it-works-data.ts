/**
 * What Books → How the books work shows next to the words in
 * how-it-works.ts (Books part 88, docs/books.md "How the books work"): how
 * much each posting rule has posted and any rule the journal holds that
 * isn't written down (gl_posting_rule_use, migration 510), who holds each
 * step now, who has two-step sign-in, the switches, when the books last
 * posted and copied, the last backup and restore drill, the chart of
 * accounts, and the CPA's last review next to the rules as they're written
 * now.
 *
 * Each part is read on its own: one that can't be read is named in
 * `problems` and left out, and the rest still shows. Reads only; nothing is
 * written here.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveFeatures } from '@/lib/features';
import { loadRoleFeatureSettings } from '@/lib/role-feature-settings';
import { TWO_STEP_ROLES, verifiedAuthenticators } from '@/lib/two-step';
import { ROLE_LABELS, type AppRole } from '@/lib/types';
import type { BooksAccess } from './access';
import { loadBackups } from './backups';
import {
  ABOUT_TEXT, ACCOUNT_TYPE_NAMES, BACKUP_TEXT, BOOKS_JOBS, BOOKS_LEVELS, CONTROLS, DATABASE_ACCESS, DATABASE_RULES, IRS_RECORDS,
  MONEY_STEPS, POSTING_RULES, RECORDS_KEPT, REVERSAL_TEXT, RULE_IDS, WORKED_OUT_RULES,
  canTake, reviewState, rulesText, scheduleText, whoText,
  type AccountRow, type CompanyView, type HowItWorksView, type PersonAccess, type ReviewRow, type ReviewedAs,
  type RuleUse, type StepView, type TwoStepPerson,
} from './how-it-works';
import { BOOKS_INVOICE_POSTING } from './invoice-posting';
import { BOOKS_GL_SYNC } from './netsuite-gl';
import { loadDrills } from './restore-drill';
import { SWITCHES, readSwitches, type SwitchPiece } from './switches';

/** SHA-256 of how the rules are written down now, as a review keeps it. */
export const rulesFingerprint = (): string => createHash('sha256').update(rulesText(), 'utf8').digest('hex');

/** Who a viewer marks a review as, or null when they can't mark one: the CPA, or a super admin writing down the CPA's review on paper. */
export function reviewerAs(roles: readonly string[]): ReviewedAs | null {
  if (roles.includes('cpa')) return 'cpa';
  if (roles.includes('super_admin')) return 'super_admin';
  return null;
}

const PAGE = 1000;

interface Person extends PersonAccess {
  id: string;
  name: string;
}

const nameOf = (p: { full_name?: string | null; email?: string | null }) => p.full_name?.trim() || p.email?.trim() || 'Someone';
const byName = (a: string, b: string) => a.localeCompare(b);

function rolesOf(p: { role?: string | null; roles?: string[] | null }): string[] {
  const raw = Array.isArray(p.roles) && p.roles.length ? p.roles : p.role ? [p.role] : [];
  return raw.map((r) => (r === 'production' ? 'graphics_production' : r));
}

/** Everyone who can sign in, with what the guards see of them. */
async function loadPeople(service: SupabaseClient): Promise<Person[]> {
  const [profiles, overrides, roleSettings] = await Promise.all([
    service.from('profiles').select('id, full_name, email, role, roles, deactivated').eq('status', 'approved'),
    service.from('user_feature_overrides').select('user_id, feature, granted'),
    loadRoleFeatureSettings(service),
  ]);
  if (profiles.error) throw new Error(`couldn't read who signs in (${profiles.error.message})`);
  if (overrides.error) throw new Error(`couldn't read what each person was given (${overrides.error.message})`);
  const given = new Map<string, Array<{ feature: string; granted: boolean }>>();
  for (const o of (overrides.data ?? []) as Array<{ user_id: string; feature: string; granted: boolean }>) {
    given.set(o.user_id, [...(given.get(o.user_id) ?? []), { feature: o.feature, granted: o.granted }]);
  }
  return ((profiles.data ?? []) as Array<{ id: string; full_name: string | null; email: string | null; role: string | null; roles: string[] | null; deactivated: boolean | null }>)
    .filter((p) => p.deactivated !== true)
    .map((p) => {
      const roles = rolesOf(p);
      return { id: p.id, name: nameOf(p), roles, features: resolveFeatures(roles, given.get(p.id) ?? [], roleSettings) as ReadonlySet<string> };
    })
    .sort((a, b) => byName(a.name, b.name));
}

async function loadCompanies(service: SupabaseClient): Promise<{ views: CompanyView[]; codes: Map<string, string> }> {
  const [companies, periods, years] = await Promise.all([
    service.from('gl_companies').select('id, code, name, books_live_from').order('code'),
    service.from('gl_periods').select('company_id, period_start').eq('status', 'closed'),
    service.from('gl_year_closes').select('company_id, year').eq('status', 'closed'),
  ]);
  if (companies.error) throw new Error(`couldn't read the companies (${companies.error.message})`);
  if (periods.error) throw new Error(`couldn't read the closed months (${periods.error.message})`);
  if (years.error) throw new Error(`couldn't read the closed years (${years.error.message})`);
  const rows = (companies.data ?? []) as Array<{ id: string; code: string; name: string; books_live_from: string | null }>;
  const views = rows.map((c) => {
    const months = ((periods.data ?? []) as Array<{ company_id: string; period_start: string }>)
      .filter((p) => p.company_id === c.id).map((p) => String(p.period_start).slice(0, 7)).sort();
    const closedYears = ((years.data ?? []) as Array<{ company_id: string; year: number }>)
      .filter((y) => y.company_id === c.id).map((y) => Number(y.year)).sort((a, b) => a - b);
    return { code: c.code, name: c.name, liveFrom: c.books_live_from, closedThrough: months.at(-1) ?? null, yearsClosed: closedYears };
  });
  return { views, codes: new Map(rows.map((c) => [c.id, c.code])) };
}

async function loadRuleUse(service: SupabaseClient): Promise<Array<RuleUse & { rule: string }>> {
  const { data, error } = await service.rpc('gl_posting_rule_use');
  if (error) throw new Error(`couldn't count what each rule posted (${error.message})`);
  return ((data ?? []) as Array<{ company: string; posting_rule: string; entries: number | string; reversed: number | string; first_date: string; last_date: string }>)
    .map((r) => ({
      rule: r.posting_rule, company: r.company, entries: Number(r.entries), reversed: Number(r.reversed),
      firstDate: String(r.first_date), lastDate: String(r.last_date),
    }));
}

async function loadAccounts(service: SupabaseClient, companyCode: Map<string, string>): Promise<AccountRow[]> {
  const rows: Array<{ number: string | null; name: string; account_type: string; company_id: string | null; active: boolean; is_summary: boolean | null; is_control: boolean | null }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await service.from('gl_accounts')
      .select('number, name, account_type, company_id, active, is_summary, is_control')
      .order('number', { ascending: true, nullsFirst: false }).order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`couldn't read the chart of accounts (${error.message})`);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < PAGE) break;
  }
  return rows.map((a) => ({
    number: a.number ?? '',
    name: a.name,
    type: ACCOUNT_TYPE_NAMES[a.account_type] ?? a.account_type,
    company: a.company_id ? companyCode.get(a.company_id) ?? 'Unknown' : 'Both',
    active: a.active !== false,
    heading: a.is_summary === true,
    control: a.is_control === true,
  }));
}

async function lastReview(service: SupabaseClient): Promise<ReviewRow | null> {
  const { data, error } = await service.from('books_rules_reviews')
    .select('reviewed_at, reviewed_by_name, reviewed_as, rules, fingerprint, note')
    .order('reviewed_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (error) throw new Error(`couldn't read the CPA's reviews (${error.message})`);
  const r = data?.[0] as { reviewed_at: string; reviewed_by_name: string; reviewed_as: ReviewedAs; rules: string[]; fingerprint: string; note: string | null } | undefined;
  return r ? { reviewedAt: r.reviewed_at, reviewedByName: r.reviewed_by_name, reviewedAs: r.reviewed_as, rules: r.rules, fingerprint: r.fingerprint, note: r.note } : null;
}

async function lastRun(service: SupabaseClient, key: string): Promise<string | null> {
  const { data, error } = await service.from('sync_state').select('updated_at').eq('sync_type', key).maybeSingle();
  if (error) throw new Error(`couldn't read when the books last ran (${error.message})`);
  return (data as { updated_at?: string | null } | null)?.updated_at ?? null;
}

/** Whether each money-role holder has an authenticator set up; null for one that couldn't be read. */
async function twoStepPeople(service: SupabaseClient, people: readonly Person[]): Promise<TwoStepPerson[]> {
  const holders = people.filter((p) => p.roles.some((r) => TWO_STEP_ROLES.includes(r)));
  return Promise.all(holders.map(async (p) => {
    let setUp: boolean | null = null;
    try {
      const { data, error } = await service.auth.admin.mfa.listFactors({ userId: p.id });
      if (!error) setUp = verifiedAuthenticators(data?.factors).length > 0;
    } catch { /* left unknown */ }
    const roles = p.roles.filter((r) => TWO_STEP_ROLES.includes(r)).map((r) => ROLE_LABELS[r as AppRole] ?? r).join(', ');
    return { name: p.name, roles, setUp };
  }));
}

function levelOf(roles: readonly string[]): BooksAccess | null {
  if (roles.includes('super_admin')) return 'owner';
  if (roles.includes('bookkeeper')) return 'keep';
  if (roles.includes('cpa')) return 'read';
  return null;
}

/** One part, or null with why it couldn't be read, kept in the page's order whichever read finishes first. */
function parts() {
  const problems: Array<string | null> = [];
  return {
    read: async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
      const at = problems.push(null) - 1;
      try {
        return await read();
      } catch (err) {
        problems[at] = `${what}: ${err instanceof Error ? err.message : String(err)}.`;
        return null;
      }
    },
    problems: () => problems.filter((p): p is string => p !== null),
  };
}

/** Books → How the books work, as of now, for someone with these roles. */
export async function loadHowItWorks(service: SupabaseClient, viewer: { roles: readonly string[] }, now = new Date()): Promise<HowItWorksView> {
  const part = parts();
  const [companies, use, switches, people, review, lastPosting, lastCopy, backups, drills] = await Promise.all([
    part.read('The companies', () => loadCompanies(service)),
    part.read('What each rule posted', () => loadRuleUse(service)),
    part.read('The switches', () => readSwitches(service)),
    part.read('Who holds each step', () => loadPeople(service)),
    part.read("The CPA's last review", () => lastReview(service)),
    part.read('The last posting run', () => lastRun(service, BOOKS_INVOICE_POSTING)),
    part.read("The last copy of NetSuite's general ledger", () => lastRun(service, BOOKS_GL_SYNC)),
    part.read('The backups', () => loadBackups(service, now)),
    part.read('The restore drills', () => loadDrills(service, now)),
  ]);
  const [accounts, twoStep] = await Promise.all([
    part.read('The chart of accounts', () => loadAccounts(service, companies?.codes ?? new Map())),
    people ? part.read('Who has two-step sign-in', () => twoStepPeople(service, people)) : Promise.resolve(null),
  ]);

  const switchOn = new Map<SwitchPiece, boolean>((switches ?? []).map((s) => [s.piece, s.on]));
  const onOf = (piece: SwitchPiece | undefined) => (piece ? (switches ? switchOn.get(piece) ?? false : null) : null);
  const written = new Set(POSTING_RULES.map((r) => r.id));

  const steps: StepView[] = MONEY_STEPS.map((s) => ({
    key: s.key,
    area: s.area,
    step: s.step,
    where: s.where,
    who: whoText(s),
    note: s.note ?? null,
    approval: s.approval?.text ?? null,
    posts: [...(s.posts ?? [])],
    switchName: s.switch ? SWITCHES[s.switch].name : null,
    switchOn: onOf(s.switch),
    people: people ? people.filter((p) => canTake(s, p)).map((p) => p.name) : null,
  }));

  const fingerprint = rulesFingerprint();
  const state = reviewState(review, { rules: RULE_IDS, fingerprint });

  return {
    asOf: now.toISOString(),
    about: ABOUT_TEXT,
    companies: companies?.views ?? [],
    rules: POSTING_RULES.map((r) => ({
      ...r,
      use: (use ?? []).filter((u) => u.rule === r.id).map(({ rule: _rule, ...u }) => u),
    })),
    unwritten: (use ?? []).filter((u) => !written.has(u.rule)).map((u) => ({ company: u.company, rule: u.rule, entries: u.entries })),
    workedOut: WORKED_OUT_RULES.map((r) => ({ ...r, switchName: r.switch ? SWITCHES[r.switch].name : null, switchOn: onOf(r.switch) })),
    reversals: REVERSAL_TEXT,
    steps,
    levels: (['owner', 'keep', 'read'] as const).map((level) => ({
      level,
      ...BOOKS_LEVELS[level],
      people: people ? people.filter((p) => levelOf(p.roles) === level).map((p) => p.name) : null,
    })),
    twoStep: { on: onOf('two_step_sign_in'), people: twoStep },
    database: DATABASE_RULES.map((r) => r.text),
    databaseAccess: DATABASE_ACCESS,
    controls: [...CONTROLS],
    switches: switches
      ? switches.map((s) => ({ name: SWITCHES[s.piece].name, what: SWITCHES[s.piece].what, on: s.on, changedAt: s.changedAt, later: SWITCHES[s.piece].later ?? null }))
      : null,
    jobs: BOOKS_JOBS.map((j) => ({ name: j.name, what: j.what, when: scheduleText(j.schedule, now) })),
    lastPosting,
    lastCopy,
    backups: {
      text: [...BACKUP_TEXT],
      lastMade: backups?.lastMade ? backups.lastMade.finishedAt ?? backups.lastMade.startedAt : null,
      lastDrillPassed: drills?.lastPassed ? drills.lastPassed.finishedAt ?? drills.lastPassed.startedAt : null,
      problem: backups?.storageProblem ?? null,
    },
    records: [...RECORDS_KEPT],
    irs: IRS_RECORDS,
    review: { ...state, fingerprint, canMark: reviewerAs(viewer.roles) !== null },
    accounts,
    problems: part.problems(),
  };
}
