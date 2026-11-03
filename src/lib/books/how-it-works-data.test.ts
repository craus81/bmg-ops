// What Books → How the books work shows next to its words (Books part 88,
// src/lib/books/how-it-works-data.ts): how much each rule posted and any
// rule the journal holds that isn't written down, who holds each step and
// each level now, who has two-step sign-in, the switches, the last runs,
// backup and drill, the chart of accounts and the CPA's last review; and a
// part that can't be read is named while the rest still shows. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  backups: vi.fn(),
  drills: vi.fn(),
}));
vi.mock('./backups', () => ({ loadBackups: h.backups }));
vi.mock('./restore-drill', () => ({ loadDrills: h.drills }));

import { loadHowItWorks, reviewerAs, rulesFingerprint } from './how-it-works-data';
import { POSTING_RULES, RULE_IDS } from './how-it-works';
import { SWITCHES } from './switches';

const NOW = new Date('2026-11-03T15:00:00Z');
const BMG = 'c0000000-0000-4000-8000-00000000b001';
const COOL = 'c0000000-0000-4000-8000-000000001084';
const PAT = 'a0000000-0000-4000-8000-000000000001';
const SAM = 'a0000000-0000-4000-8000-000000000002';
const KIM = 'a0000000-0000-4000-8000-000000000003';
const LEE = 'a0000000-0000-4000-8000-000000000004';
const ROBIN = 'a0000000-0000-4000-8000-000000000005';
const GONE = 'a0000000-0000-4000-8000-000000000006';

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let failing: Record<string, string>;
let factors: Record<string, Array<{ factor_type: string; status: string; created_at: string }> | 'error'>;
let ruleUse: Row[] | 'error';

/** A read of `table` as PostgREST answers it: equality filters, sorted as asked, then ranges and limits. */
function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  const orders: Array<[string, boolean]> = [];
  let slice: [number, number] | null = null;
  let one = false;
  const compare = (a: Row, b: Row) => {
    for (const [k, up] of orders) {
      const [x, y] = [a[k] as string | number | null | undefined, b[k] as string | number | null | undefined];
      if (x === y) continue;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * (up ? 1 : -1);
    }
    return 0;
  };
  const run = () => {
    if (failing[table]) return { data: null, error: { message: failing[table] } };
    let rows = (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v)).sort(compare);
    if (slice) rows = rows.slice(slice[0], slice[1] + 1);
    return { data: one ? rows[0] ?? null : rows, error: null };
  };
  const q: any = {
    select: () => q,
    eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
    order: (k: string, opts?: { ascending?: boolean }) => { orders.push([k, opts?.ascending !== false]); return q; },
    range: (from: number, to: number) => { slice = [from, to]; return q; },
    limit: (n: number) => { slice = [0, n - 1]; return q; },
    maybeSingle: () => { one = true; return q; },
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return q;
}

const service: any = {
  from: (table: string) => query(table),
  rpc: async (name: string) => {
    expect(name).toBe('gl_posting_rule_use');
    return ruleUse === 'error' ? { data: null, error: { message: 'boom' } } : { data: ruleUse, error: null };
  },
  auth: {
    admin: {
      mfa: {
        listFactors: async ({ userId }: { userId: string }) => {
          const f = factors[userId];
          if (f === 'error') return { data: null, error: { message: 'auth is down' } };
          return { data: { factors: f ?? [] }, error: null };
        },
      },
    },
  },
};

const totp = { factor_type: 'totp', status: 'verified', created_at: '2026-11-02T23:00:00Z' };

beforeEach(() => {
  failing = {};
  ruleUse = [
    { company: 'BMG', posting_rule: 'invoice@1', entries: '41', reversed: '2', first_date: '2025-01-02', last_date: '2026-11-02' },
    { company: '1084', posting_rule: 'journal_entry@1', entries: '12', reversed: '0', first_date: '2025-01-31', last_date: '2026-10-31' },
    { company: 'BMG', posting_rule: 'made_up@3', entries: '1', reversed: '0', first_date: '2026-05-05', last_date: '2026-05-05' },
  ];
  factors = { [PAT]: [totp], [KIM]: [], [LEE]: 'error' };
  tables = {
    gl_companies: [
      { id: COOL, code: '1084', name: '1084 Cool Springs', books_live_from: null },
      { id: BMG, code: 'BMG', name: 'BMG Fleet Installations', books_live_from: null },
    ],
    gl_periods: [
      { company_id: BMG, period_start: '2026-08-01', status: 'closed' },
      { company_id: BMG, period_start: '2026-09-01', status: 'closed' },
      { company_id: COOL, period_start: '2026-07-01', status: 'closed' },
    ],
    gl_year_closes: [{ company_id: BMG, year: 2025, status: 'closed' }],
    profiles: [
      { id: PAT, full_name: 'Pat Owner', email: 'pat@example.com', role: 'super_admin', roles: ['admin', 'super_admin'], status: 'approved', deactivated: false },
      { id: SAM, full_name: 'Sam Sales', email: 'sam@example.com', role: 'sales', roles: null, status: 'approved', deactivated: false },
      { id: KIM, full_name: 'Kim Books', email: 'kim@example.com', role: 'bookkeeper', roles: ['bookkeeper'], status: 'approved', deactivated: false },
      { id: LEE, full_name: 'Lee CPA', email: 'lee@example.com', role: 'cpa', roles: ['cpa'], status: 'approved', deactivated: false },
      { id: ROBIN, full_name: null, email: 'robin@example.com', role: 'finance', roles: ['finance'], status: 'pending', deactivated: false },
      { id: GONE, full_name: 'Gone Admin', email: 'gone@example.com', role: 'admin', roles: ['admin'], status: 'approved', deactivated: true },
    ],
    user_feature_overrides: [{ user_id: KIM, feature: 'vendor_payments', granted: true }],
    role_feature_settings: [],
    books_switches: [{ piece: 'credit_memos', is_on: true, changed_by: PAT, changed_at: '2026-11-01T12:00:00Z' }],
    books_rules_reviews: [],
    sync_state: [
      { sync_type: 'books_invoice_posting', updated_at: '2026-11-03T13:52:00Z' },
      { sync_type: 'books_netsuite_gl', updated_at: '2026-11-03T13:30:00Z' },
    ],
    gl_accounts: [
      { id: '1', number: '10100', name: 'First Bank Operating', account_type: 'bank', company_id: BMG, active: true, is_summary: false, is_control: false },
      { id: '2', number: '11000', name: 'Accounts Receivable', account_type: 'accounts_receivable', company_id: null, active: true, is_summary: false, is_control: true },
      { id: '3', number: '40000', name: 'Sales', account_type: 'income', company_id: null, active: true, is_summary: true, is_control: false },
      { id: '4', number: '23700', name: 'Printer Loan', account_type: 'long_term_liability', company_id: BMG, active: false, is_summary: false, is_control: false },
    ],
  };
  h.backups.mockReset().mockResolvedValue({
    backups: [], due: false, next: '2026-11-04T08:11:00.000Z', storageProblem: null,
    lastMade: { id: 'b1', startedAt: '2026-11-03T08:11:00.000Z', finishedAt: '2026-11-03T08:12:40.000Z', status: 'made' },
  });
  h.drills.mockReset().mockResolvedValue({
    drills: [], newest: null, next: '2026-11-04T08:51:00.000Z',
    lastPassed: { id: 'd1', startedAt: '2026-11-03T08:51:00.000Z', finishedAt: '2026-11-03T08:53:10.000Z', status: 'passed' },
  });
});

describe('loadHowItWorks', () => {
  it("shows each company's live date, last closed month and closed years", async () => {
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(view.companies).toEqual([
      { code: '1084', name: '1084 Cool Springs', liveFrom: null, closedThrough: '2026-07', yearsClosed: [] },
      { code: 'BMG', name: 'BMG Fleet Installations', liveFrom: null, closedThrough: '2026-09', yearsClosed: [2025] },
    ]);
    expect(view.asOf).toBe('2026-11-03T15:00:00.000Z');
    expect(view.problems).toEqual([]);
  });

  it("counts what each written rule posted, and names one the journal holds that isn't written down", async () => {
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(view.rules.map((r) => r.id)).toEqual(POSTING_RULES.map((r) => r.id));
    expect(view.rules.find((r) => r.id === 'invoice@1')!.use).toEqual([
      { company: 'BMG', entries: 41, reversed: 2, firstDate: '2025-01-02', lastDate: '2026-11-02' },
    ]);
    expect(view.rules.find((r) => r.id === 'journal_entry@1')!.use[0].company).toBe('1084');
    expect(view.rules.find((r) => r.id === 'payment@1')!.use).toEqual([]);
    expect(view.unwritten).toEqual([{ company: 'BMG', rule: 'made_up@3', entries: 1 }]);
  });

  it('names who holds each step now, from roles and what each person was given, leaving out anyone not approved or switched off', async () => {
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    const step = (key: string) => view.steps.find((s) => s.key === key)!;
    expect(step('invoice')).toMatchObject({ who: 'Anyone with Invoicing', people: ['Pat Owner', 'Sam Sales'], switchOn: null, switchName: null });
    expect(step('credit_memo')).toMatchObject({ switchName: 'Credit memos', switchOn: true, posts: ['credit_memo@1'] });
    expect(step('payment')).toMatchObject({ switchName: 'Receiving payments', switchOn: false });
    expect(step('rent_mortgage').people).toEqual(['Kim Books', 'Pat Owner']);
    expect(step('read').people).toEqual(['Kim Books', 'Lee CPA', 'Pat Owner']);
    expect(step('switches').people).toEqual(['Pat Owner']);
    expect(step('pay_vendors').approval).toBe("A super admin who didn't ask approves it.");
    const everyone = view.steps.flatMap((s) => s.people ?? []);
    expect(everyone).not.toContain('Gone Admin');
    expect(everyone).not.toContain('robin@example.com');
  });

  it("reads a login's old Production role as Graphics Production, as the guards do", async () => {
    tables.profiles.push({ id: 'a0000000-0000-4000-8000-000000000007', full_name: 'Dee Graphics', email: 'dee@example.com', role: 'production', roles: null, status: 'approved', deactivated: false });
    // More → Admin → Permissions gave Graphics Production Invoicing.
    tables.role_feature_settings = [{ role: 'graphics_production', feature: 'invoicing', granted: true }];
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(view.steps.find((s) => s.key === 'invoice')!.people).toEqual(['Dee Graphics', 'Pat Owner', 'Sam Sales']);
  });

  it("names who has each level of the books, and who has two-step sign-in, unknown where it couldn't be read", async () => {
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(view.levels.map((l) => [l.level, l.people])).toEqual([['owner', ['Pat Owner']], ['keep', ['Kim Books']], ['read', ['Lee CPA']]]);
    expect(view.twoStep).toEqual({
      on: false,
      people: [
        { name: 'Kim Books', roles: 'Bookkeeper', setUp: false },
        { name: 'Lee CPA', roles: 'CPA', setUp: null },
        { name: 'Pat Owner', roles: 'Super Admin', setUp: true },
      ],
    });
  });

  it('shows the switches, the jobs in Central time, the last runs, backup and drill', async () => {
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(view.switches!.find((s) => s.name === 'Credit memos')).toEqual({
      name: 'Credit memos', what: SWITCHES.credit_memos.what, on: true, changedAt: '2026-11-01T12:00:00Z', later: null,
    });
    expect(view.switches!.find((s) => s.name === 'Receiving payments')!.later).toMatch(/^Stays off on January 1/);
    expect(view.jobs.find((j) => j.name === 'Backup')!.when).toBe('Every day at 2:11 AM Central');
    expect(view.lastPosting).toBe('2026-11-03T13:52:00Z');
    expect(view.lastCopy).toBe('2026-11-03T13:30:00Z');
    expect(view.backups).toMatchObject({ lastMade: '2026-11-03T08:12:40.000Z', lastDrillPassed: '2026-11-03T08:53:10.000Z', problem: null });
  });

  it('lays out the chart of accounts with each type and company by name', async () => {
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(view.accounts).toEqual([
      { number: '10100', name: 'First Bank Operating', type: 'Bank', company: 'BMG', active: true, heading: false, control: false },
      { number: '11000', name: 'Accounts Receivable', type: 'Accounts receivable', company: 'Both', active: true, heading: false, control: true },
      { number: '23700', name: 'Printer Loan', type: 'Long-term liability', company: 'BMG', active: false, heading: false, control: false },
      { number: '40000', name: 'Sales', type: 'Income', company: 'Both', active: true, heading: true, control: false },
    ]);
  });

  it('reads the whole chart, a thousand accounts at a time', async () => {
    tables.gl_accounts = Array.from({ length: 2345 }, (_, i) => ({
      id: String(i), number: String(10000 + i), name: `Made-up ${i}`, account_type: 'expense', company_id: BMG, active: true, is_summary: false, is_control: false,
    }));
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(view.accounts).toHaveLength(2345);
    expect(view.accounts!.at(-1)!.number).toBe('12344');
  });

  it("says the CPA hasn't reviewed it yet, and who can mark it", async () => {
    const cpa = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(cpa.review).toMatchObject({ state: 'never', last: null, canMark: true, fingerprint: rulesFingerprint() });
    expect((await loadHowItWorks(service, { roles: ['admin', 'super_admin'] }, NOW)).review.canMark).toBe(true);
    expect((await loadHowItWorks(service, { roles: ['bookkeeper'] }, NOW)).review.canMark).toBe(false);
  });

  it("says a review is current while the words are as reviewed, and what's changed since when they aren't", async () => {
    tables.books_rules_reviews = [{
      id: 'r1', reviewed_at: '2026-11-03T14:00:00Z', reviewed_by_name: 'Lee CPA', reviewed_as: 'cpa',
      rules: [...RULE_IDS], fingerprint: rulesFingerprint(), note: 'Read the PDF dated Nov 3.',
    }];
    const current = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(current.review).toMatchObject({
      state: 'current', added: [], gone: [],
      last: { reviewedAt: '2026-11-03T14:00:00Z', reviewedByName: 'Lee CPA', reviewedAs: 'cpa', note: 'Read the PDF dated Nov 3.' },
    });

    tables.books_rules_reviews = [{ ...tables.books_rules_reviews[0], rules: RULE_IDS.filter((r) => r !== 'bank@1').concat('old@1'), fingerprint: 'f'.repeat(64) }];
    const changed = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(changed.review).toMatchObject({ state: 'changed', added: ['bank@1'], gone: ['old@1'], reworded: false });
  });

  it('goes by the newest review', async () => {
    tables.books_rules_reviews = [
      { id: 'r2', reviewed_at: '2026-11-03T14:00:00Z', reviewed_by_name: 'Lee CPA', reviewed_as: 'cpa', rules: [...RULE_IDS], fingerprint: rulesFingerprint(), note: null },
      { id: 'r1', reviewed_at: '2026-10-01T14:00:00Z', reviewed_by_name: 'Lee CPA', reviewed_as: 'cpa', rules: ['old@1'], fingerprint: 'f'.repeat(64), note: null },
    ];
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(view.review).toMatchObject({ state: 'current', last: { reviewedAt: '2026-11-03T14:00:00Z' } });
  });

  it("names a part that can't be read and shows the rest", async () => {
    ruleUse = 'error';
    failing.profiles = 'profiles are down';
    failing.gl_accounts = 'accounts are down';
    h.backups.mockRejectedValue(new Error("couldn't read the backups (storage)"));
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(view.problems).toEqual([
      "What each rule posted: couldn't count what each rule posted (boom).",
      "Who holds each step: couldn't read who signs in (profiles are down).",
      "The backups: couldn't read the backups (storage).",
      "The chart of accounts: couldn't read the chart of accounts (accounts are down).",
    ]);
    expect(view.problems).toHaveLength(4);
    expect(view.rules.every((r) => r.use.length === 0)).toBe(true);
    expect(view.steps.every((s) => s.people === null)).toBe(true);
    expect(view.levels.every((l) => l.people === null)).toBe(true);
    expect(view.twoStep.people).toBeNull();
    expect(view.accounts).toBeNull();
    expect(view.backups.lastMade).toBeNull();
    expect(view.backups.lastDrillPassed).toBe('2026-11-03T08:53:10.000Z');
    expect(view.companies).toHaveLength(2);
  });

  it("doesn't say a switch is off when the switches couldn't be read", async () => {
    failing.books_switches = 'switches are down';
    const view = await loadHowItWorks(service, { roles: ['cpa'] }, NOW);
    expect(view.switches).toBeNull();
    expect(view.steps.find((s) => s.key === 'credit_memo')!.switchOn).toBeNull();
    expect(view.twoStep.on).toBeNull();
    expect(view.problems).toEqual(["The switches: switches are down."]);
  });
});

describe('reviewerAs', () => {
  it('is the CPA for the CPA, a super admin for a super admin, and nobody else', () => {
    expect(reviewerAs(['cpa'])).toBe('cpa');
    expect(reviewerAs(['super_admin', 'cpa'])).toBe('cpa');
    expect(reviewerAs(['admin', 'super_admin'])).toBe('super_admin');
    expect(reviewerAs(['bookkeeper'])).toBeNull();
    expect(reviewerAs(['admin'])).toBeNull();
  });
});

describe('rulesFingerprint', () => {
  it('is the SHA-256 of how the rules are written, the same each time', () => {
    expect(rulesFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(rulesFingerprint()).toBe(rulesFingerprint());
  });
});
