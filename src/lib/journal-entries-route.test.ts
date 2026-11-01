// /api/journal-entries (src/lib/typed-journal-entries.ts): who can open it
// while journal entries are switched off and once they're on, what saving and
// deleting a draft send the database, and how an entry is asked for approval,
// taken back, sent back with why, and approved: by a super admin who didn't
// ask, checked again as it's kept, made once in NetSuite under the entry's
// own External ID however often it's pressed, let go when NetSuite refuses
// and kept when it can't tell, with Books' own copy kept, and each step
// alerting whoever it's for and Craig. And the CPA's own adjustments journal
// (Books part 53): the CPA types and sees only its own, staff only the general
// one, super admins both. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const STAFF = 'd0000000-0000-4000-8000-000000000001';
const BOSS = 'd0000000-0000-4000-8000-000000000002';
const CRAIG = 'd0000000-0000-4000-8000-000000000003';
const OTHER = 'd0000000-0000-4000-8000-000000000004';
const CPA = 'd0000000-0000-4000-8000-000000000005';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    userId: '',
    roles: [] as string[],
    hasPayments: true,
    superAdmins: [] as string[],
    watchers: [] as string[],
    clock: 0,
    tables: {} as Record<string, Record<string, any>[]>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    answers: {} as Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }>,
    /** Runs once, just before the next delete: someone else acting between the route's read and its write. */
    meanwhile: null as (() => void) | null,
  };
  const netsuite = {
    findJournalEntry: vi.fn(),
    createJournalEntry: vi.fn(),
  };

  // An in-memory stand-in for the tables the route reads and writes.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    let patch: Record<string, any> | null = null;
    let remove = false;
    let returning = false;
    let limit = Infinity;
    const rows = () => (state.tables[table] ??= []);
    let badId: unknown = null;
    const run = () => {
      // Postgres won't compare a uuid column with text that isn't one.
      if (badId !== null) return { data: null, error: { message: `invalid input syntax for type uuid: "${badId}"` } };
      if (remove && state.meanwhile) { const m = state.meanwhile; state.meanwhile = null; m(); }
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (remove) {
        state.tables[table] = rows().filter((r) => !matched.includes(r));
        return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (patch) {
        for (const r of matched) Object.assign(r, patch);
        return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: matched.slice(0, limit).map((r) => ({ ...r })), error: null };
    };
    const builder: any = {
      select: () => { if (patch || remove) returning = true; return builder; },
      eq: (c: string, v: unknown) => {
        if (c === 'id' && table === 'typed_journal_entries' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))) badId = v;
        filters.push((r) => r[c] === v);
        return builder;
      },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      order: () => builder,
      limit: (n: number) => { limit = n; return builder; },
      update: (p: Record<string, any>) => { patch = p; return builder; },
      delete: () => { remove = true; return builder; },
      maybeSingle: async () => {
        const res = run();
        return { data: (res.data as any[] | null)?.[0] ?? null, error: res.error };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, args]);
      const answer = state.answers[fn];
      return answer ? answer(args.p) : { data: null, error: { message: `nothing answers ${fn}` } };
    },
  };

  const companies = [
    { id: 'g1', code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [] },
    { id: 'g2', code: '1084', name: '1084 Cool Springs', subsidiaryId: '3', locations: [] },
  ];
  // The chart, each account with the companies a typed line can use it for.
  const accounts = () => new Map([
    ['610', { id: '610', number: '6100', name: 'Depreciation', type: 'expense', companies: ['BMG'] }],
    ['230', { id: '230', number: '2300', name: 'Accrued wages', type: 'other_current_liability', companies: ['BMG', '1084'] }],
    ['150', { id: '150', number: '1590', name: 'Accumulated depreciation', type: 'fixed_asset', companies: ['BMG'] }],
    ['640', { id: '640', number: '6400', name: 'Dues', type: 'expense', companies: ['1084'] }],
    ['120', { id: '120', number: '1200', name: 'Accounts receivable', type: 'accounts_receivable', companies: [] as string[] }],
    ['699', { id: '699', number: '9999', name: 'Closed out', type: 'expense', companies: [] as string[] }],
  ]);
  return { state, netsuite, service, companies, accounts };
});

vi.mock('@/lib/api-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: h.state.userId }, profile: { roles: h.state.roles } })),
  profileHasFeature: vi.fn(async (_userId: string, _profile: unknown, feature: string) => h.state.hasPayments && feature === 'vendor_payments'),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/books/snap-a-bill', () => ({
  readCompanies: vi.fn(async () => h.companies),
  readAccounts: vi.fn(async () => h.accounts()),
}));
vi.mock('@/lib/notify', () => ({
  getSuperAdminIds: vi.fn(async (exclude?: string | null) => h.state.superAdmins.filter((id) => id !== exclude)),
  notifyMany: vi.fn(async () => {}),
}));
vi.mock('@/lib/new-alert-watchers', () => ({ newAlertWatcherIds: vi.fn(async () => h.state.watchers) }));

const { state, netsuite } = h;

import { logAudit } from '@/lib/audit';
import { notifyMany } from '@/lib/notify';
import { readAccounts } from '@/lib/books/snap-a-bill';
import { JOURNAL_LINE_ACCOUNT_TYPES } from '@/lib/typed-journal-entries';
import { GET, POST } from '../app/api/journal-entries/route';

const E = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`;
const DRAFT = E(1);
const WAITING = E(2);
const MADE = E(3);
const NEW = E(4);

/** January's depreciation: $1,250.00 to depreciation, against accumulated depreciation. */
const LINES = [
  { account_netsuite_id: '610', debit_cents: 125000, credit_cents: 0, memo: 'Shop truck' },
  { account_netsuite_id: '150', debit_cents: 0, credit_cents: 125000, memo: null },
];
const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id, journal: 'general', company: 'BMG', tran_date: '2027-01-31', memo: 'January depreciation', lines: LINES, total_cents: 125000, status: 'draft',
  created_by: STAFF, created_at: '2027-01-31T15:00:00Z', updated_by: STAFF, updated_at: '2027-01-31T15:00:00.123456+00:00',
  asked_by: null, asked_at: null, returned_by: null, returned_at: null, returned_reason: null, approved_by: null, approved_at: null,
  netsuite_journal_id: null, netsuite_number: null, error: null, ...over,
});
const ASKED_AT = '2027-01-31T16:00:00.654321+00:00';

const get = (query: string) => GET(new NextRequest(`https://app.test/api/journal-entries?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/journal-entries', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const rpcNames = () => state.rpcs.map(([fn]) => fn);
const rowOf = (id: string) => state.tables.typed_journal_entries.find((r) => r.id === id)!;
const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'journal_entries', is_on: on }, { piece: 'card_charges', is_on: !on }]; };
const as = (userId: string, roles: string[]) => { state.userId = userId; state.roles = roles; };
const stamp = () => `2027-02-01T10:00:${String((state.clock += 1)).padStart(2, '0')}.000001+00:00`;

/** The functions migration 469 adds, as the route counts on them answering. */
function answers() {
  const find = (id: string) => (state.tables.typed_journal_entries ??= []).find((r) => r.id === id);
  state.answers = {
    typed_journal_entry_save: (p) => {
      const total = p.lines.reduce((s: number, l: any) => s + l.debit_cents, 0);
      const fields = { company: p.company, tran_date: p.tran_date, memo: p.memo?.trim() || null, lines: p.lines, total_cents: total, updated_by: p.by, updated_at: stamp() };
      const journal = p.journal || 'general';
      const r = find(p.id);
      if (!r) {
        state.tables.typed_journal_entries.push(entry(p.id, { ...fields, journal, created_by: p.by }));
        return { data: { saved: true, status: 'draft', updated_at: fields.updated_at }, error: null };
      }
      if (r.journal !== journal) return { data: { saved: false, status: 'other_journal', journal: r.journal, updated_at: r.updated_at }, error: null };
      if (r.status !== 'draft') return { data: { saved: false, status: r.status, updated_at: r.updated_at }, error: null };
      Object.assign(r, fields);
      return { data: { saved: true, status: 'draft', updated_at: r.updated_at }, error: null };
    },
    typed_journal_entry_ask: (p) => {
      const r = find(p.id);
      if (!r) return { data: { state: 'gone' }, error: null };
      if (r.status !== 'draft') return { data: { state: r.status }, error: null };
      if (r.updated_at !== p.updated_at) return { data: { state: 'changed' }, error: null };
      Object.assign(r, { status: 'waiting', asked_by: p.by, asked_at: ASKED_AT, returned_by: null, returned_at: null, returned_reason: null, error: null });
      return { data: { state: 'asked', asked_at: ASKED_AT }, error: null };
    },
    typed_journal_entry_take_back: (p) => {
      const r = find(p.id);
      if (!r) return { data: { state: 'gone' }, error: null };
      if (r.status !== 'waiting') return { data: { state: r.status }, error: null };
      Object.assign(r, { status: 'draft', asked_by: null, asked_at: null, updated_by: p.by, updated_at: stamp() });
      return { data: { state: 'taken_back' }, error: null };
    },
    typed_journal_entry_send_back: (p) => {
      const r = find(p.id);
      if (!r) return { data: { state: 'gone' }, error: null };
      if (r.status !== 'waiting') return { data: { state: r.status }, error: null };
      Object.assign(r, { status: 'draft', asked_by: null, asked_at: null, returned_by: p.by, returned_at: stamp(), returned_reason: p.reason });
      return { data: { state: 'sent_back' }, error: null };
    },
    typed_journal_entry_claim: (p) => {
      if (!p.approver) return { data: null, error: { message: 'typed journal entries: an approval needs who approved it' } };
      const r = find(p.id);
      if (!r) return { data: { state: 'gone' }, error: null };
      if (r.status === 'made') return { data: { state: 'made', netsuite_journal_id: r.netsuite_journal_id, netsuite_number: r.netsuite_number }, error: null };
      if (r.status === 'sending') return { data: { state: 'making', entry: { ...r } }, error: null };
      if (r.status === 'draft') return { data: { state: 'draft' }, error: null };
      if (r.asked_at !== p.asked_at) return { data: { state: 'changed' }, error: null };
      if (r.asked_by === p.approver) return { data: { state: 'yours' }, error: null };
      Object.assign(r, { status: 'sending', approved_by: p.approver, approved_at: new Date().toISOString(), error: null });
      return { data: { state: 'claimed', entry: { ...r } }, error: null };
    },
    typed_journal_entry_let_go: (p) => {
      const r = find(p.id);
      if (!r || r.status !== 'sending') return { data: { let_go: false }, error: null };
      Object.assign(r, { status: 'waiting', approved_by: null, approved_at: null, error: p.error });
      return { data: { let_go: true }, error: null };
    },
    typed_journal_entry_made: (p) => {
      const r = find(p.id);
      if (!r || r.status !== 'sending') return { data: { made: false }, error: null };
      Object.assign(r, { status: 'made', netsuite_journal_id: p.netsuite_journal_id, netsuite_number: p.netsuite_number ?? null, error: null });
      return { data: { made: true }, error: null };
    },
    gl_own_journal_entry_save: (p) => ({ data: { saved: true, lines: p.lines.length }, error: null }),
  };
}

beforeEach(() => {
  as(STAFF, ['admin']);
  state.hasPayments = true;
  state.superAdmins = [BOSS, CRAIG];
  state.watchers = [CRAIG];
  state.clock = 0;
  state.tables = {
    typed_journal_entries: [
      entry(DRAFT, { returned_by: BOSS, returned_at: '2027-01-31T17:00:00Z', returned_reason: 'Split it by truck' }),
      entry(WAITING, { memo: 'Wages accrued', lines: [
        { account_netsuite_id: '610', debit_cents: 50000, credit_cents: 0, memo: null },
        { account_netsuite_id: '230', debit_cents: 0, credit_cents: 50000, memo: null },
      ], total_cents: 50000, status: 'waiting', created_by: OTHER, asked_by: STAFF, asked_at: ASKED_AT }),
      entry(MADE, { status: 'made', asked_by: STAFF, asked_at: ASKED_AT, approved_by: BOSS, approved_at: '2027-01-31T18:00:00Z', netsuite_journal_id: '7001', netsuite_number: 'JE-500' }),
    ],
    profiles: [{ id: STAFF, full_name: 'Sam Staff' }, { id: BOSS, full_name: 'Bo Boss' }, { id: CRAIG, full_name: null }, { id: CPA, full_name: 'Cass CPA' }],
  };
  switchOn(false);
  state.rpcs.length = 0;
  answers();
  vi.clearAllMocks();
  // A test that stops early leaves answers queued; the next starts with none.
  netsuite.findJournalEntry.mockReset();
  netsuite.createJournalEntry.mockReset();
  netsuite.findJournalEntry.mockResolvedValue(null);
  netsuite.createJournalEntry.mockResolvedValue({ success: true, journalId: '7002' });
});

const SAVE = {
  action: 'save', id: NEW, company: 'BMG', date: '2027-02-28', memo: ' February depreciation ',
  lines: [{ accountId: '610', debitCents: 125000, creditCents: 0, memo: ' Shop truck ' }, { accountId: '150', debitCents: 0, creditCents: 125000 }],
};

describe('while journal entries are switched off', () => {
  it('shows Journal Entries to super admins only, with the journals each types in, and lets nobody approve', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false, canApprove: false, journals: ['general'] });
    as(BOSS, ['super_admin']);
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true, canApprove: false, journals: ['general', 'cpa_adjustments'] });
    // A super admin types CPA adjustments by role, and in the general journal with Payments.
    state.hasPayments = false;
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true, canApprove: false, journals: ['cpa_adjustments'] });
    as(STAFF, ['admin']);
    expect((await get('status=1')).status).toBe(403);
  });

  it('lets a super admin see the entries, with who did what, and nobody else', async () => {
    const refused = await get('');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Journal entries are switched off until January 1, 2027.', switchedOff: true });

    as(BOSS, ['super_admin']);
    const res = await get('');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(readAccounts).toHaveBeenCalledWith(expect.anything(), h.companies, JOURNAL_LINE_ACCOUNT_TYPES);
    expect(body).toMatchObject({
      companies: [{ code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2' }, { code: '1084', name: '1084 Cool Springs', subsidiaryId: '3' }],
      me: BOSS,
      journals: ['general', 'cpa_adjustments'],
      superAdmin: true,
      switchedOn: false,
      offText: "Journal entries are switched off until January 1, 2027. You can type and save entries to see what they'd make; none is asked for approval or sent to NetSuite.",
    });
    // Only the accounts a line can go to, by number.
    expect(body.accounts.map((a: { id: string }) => a.id)).toEqual(['150', '230', '610', '640']);
    expect(body.entries.map((e: { id: string }) => e.id).sort()).toEqual([DRAFT, WAITING, MADE]);
    expect(body.entries.find((e: { id: string }) => e.id === DRAFT)).toEqual({
      id: DRAFT, journal: 'general', company: 'BMG', date: '2027-01-31', memo: 'January depreciation',
      lines: [
        { accountId: '610', debitCents: 125000, creditCents: 0, memo: 'Shop truck' },
        { accountId: '150', debitCents: 0, creditCents: 125000, memo: null },
      ],
      totalCents: 125000, status: 'draft',
      createdBy: 'Sam Staff', createdById: STAFF, createdAt: '2027-01-31T15:00:00Z', updatedBy: 'Sam Staff', updatedAt: '2027-01-31T15:00:00.123456+00:00',
      askedBy: null, askedById: null, askedAt: null,
      returnedBy: 'Bo Boss', returnedAt: '2027-01-31T17:00:00Z', returnedReason: 'Split it by truck',
      approvedBy: null, approvedAt: null, journalId: null, number: null, error: null,
    });
    expect(body.entries.find((e: { id: string }) => e.id === MADE)).toMatchObject({
      status: 'made', askedBy: 'Sam Staff', approvedBy: 'Bo Boss', journalId: '7001', number: 'JE-500',
    });
    // Someone with no name on their profile is still someone.
    state.tables.typed_journal_entries[0].updated_by = CRAIG;
    expect((await get('')).status).toBe(200);
    expect((await (await get('')).json()).entries.find((e: { id: string }) => e.id === DRAFT).updatedBy).toBe('Someone');

    // Only the last 25 made are listed; one asked for by its id is there too.
    const OLD = 'e0000000-0000-4000-8000-000000000099';
    for (let n = 0; n < 25; n += 1) {
      state.tables.typed_journal_entries.push(entry(`f0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, { status: 'made', netsuite_journal_id: `80${n}` }));
    }
    state.tables.typed_journal_entries.push(entry(OLD, { status: 'made', netsuite_journal_id: '7999' }));
    const listed = async (q: string) => (await (await get(q)).json()).entries.map((e: { id: string }) => e.id) as string[];
    expect(await listed('')).not.toContain(OLD);
    expect(await listed('')).toHaveLength(27);
    expect(await listed(`id=${OLD}`)).toContain(OLD);
    // A link with a broken id still opens the list.
    expect((await get('id=not-an-id')).status).toBe(200);
    expect(await listed('id=not-an-id')).not.toContain(OLD);
  });

  it('lets a super admin type, save and delete drafts, and asks and sends nothing, even for them', async () => {
    as(BOSS, ['super_admin']);
    expect(await (await post(SAVE)).json()).toEqual({ success: true, updatedAt: expect.any(String) });
    expect(rowOf(NEW)).toMatchObject({ status: 'draft', created_by: BOSS });

    const asked = await post({ action: 'ask', id: NEW, updatedAt: rowOf(NEW).updated_at });
    expect(asked.status).toBe(403);
    expect(await asked.json()).toEqual({ error: 'Journal entries are switched off until January 1, 2027. It was saved, and not asked for approval.', switchedOff: true });
    const approved = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(approved.status).toBe(403);
    expect(await approved.json()).toEqual({ error: 'Journal entries are switched off until January 1, 2027. Nothing was sent to NetSuite.', switchedOff: true });
    expect(rowOf(NEW).status).toBe('draft');
    expect(rowOf(WAITING).status).toBe('waiting');

    expect(await (await post({ action: 'delete', id: NEW })).json()).toEqual({ success: true });
    expect(state.tables.typed_journal_entries.map((r) => r.id)).toEqual([DRAFT, WAITING, MADE]);
    expect(rpcNames()).toEqual(['typed_journal_entry_save']);
    expect(netsuite.findJournalEntry).not.toHaveBeenCalled();
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
    expect(notifyMany).not.toHaveBeenCalled();
  });
});

describe('once journal entries are switched on', () => {
  beforeEach(() => switchOn(true));

  it('lets anyone with Payments use them, super admins approve, and nobody else in', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true, canApprove: false, journals: ['general'] });
    expect((await get('')).status).toBe(200);
    as(BOSS, ['super_admin']);
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true, canApprove: true, journals: ['general', 'cpa_adjustments'] });
    // Without Payments, a super admin has the CPA's adjustments and not the general journal.
    state.hasPayments = false;
    expect((await (await get('')).json()).entries).toEqual([]);
    const general = await post(SAVE);
    expect(general.status).toBe(403);
    expect(await general.json()).toEqual({ error: 'The general journal needs the Payments permission.' });
    for (const roles of [['admin'], ['bookkeeper'], ['finance', 'executive']]) {
      as(STAFF, roles);
      expect((await get('')).status, roles.join()).toBe(403);
      expect((await post(SAVE)).status, roles.join()).toBe(403);
    }
    expect(state.rpcs).toEqual([]);
  });

  it('saves a draft as typed, refuses a company or day there is no such thing as, and says why a draft that moved on is not saved', async () => {
    expect(await (await post(SAVE)).json()).toEqual({ success: true, updatedAt: '2027-02-01T10:00:01.000001+00:00' });
    expect(state.rpcs[0]).toEqual(['typed_journal_entry_save', {
      p: {
        id: NEW, journal: 'general', company: 'BMG', tran_date: '2027-02-28', memo: ' February depreciation ', by: STAFF,
        lines: [
          { account_netsuite_id: '610', debit_cents: 125000, credit_cents: 0, memo: 'Shop truck' },
          { account_netsuite_id: '150', debit_cents: 0, credit_cents: 125000, memo: null },
        ],
      },
    }]);
    // Half typed is fine for a draft: no memo, no account yet.
    expect((await post({ ...SAVE, memo: undefined, lines: [{ accountId: null, debitCents: 0, creditCents: 0 }] })).status).toBe(200);
    expect(state.rpcs[1][1].p).toMatchObject({ memo: '', lines: [{ account_netsuite_id: null, debit_cents: 0, credit_cents: 0, memo: null }] });

    const nope = await post({ ...SAVE, company: 'NOPE' });
    expect(nope.status).toBe(400);
    expect(await nope.json()).toEqual({ error: "There's no company NOPE in Books." });
    const feb30 = await post({ ...SAVE, date: '2027-02-30' });
    expect(feb30.status).toBe(400);
    expect(await feb30.json()).toEqual({ error: "2027-02-30 isn't a day on the calendar." });

    const waiting = await post({ ...SAVE, id: WAITING });
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toEqual({ error: "It wasn't saved. It's asked for approval: take it back to change it.", status: 'waiting' });
    const made = await post({ ...SAVE, id: MADE });
    expect(await made.json()).toEqual({ error: "It wasn't saved. It's in NetSuite already.", status: 'made' });
    expect(rpcNames()).toEqual(['typed_journal_entry_save', 'typed_journal_entry_save', 'typed_journal_entry_save', 'typed_journal_entry_save']);

    state.answers.typed_journal_entry_save = () => ({ data: { saved: false, status: 'gone' }, error: null });
    expect(await (await post(SAVE)).json()).toMatchObject({ error: "It wasn't saved. There's no such journal entry: it was deleted." });
    state.answers.typed_journal_entry_save = () => ({ data: null, error: { message: 'typed journal entries: each line is an account' } });
    const refused = await post(SAVE);
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: 'typed journal entries: each line is an account' });
  });

  it('deletes a draft for whoever started it or a super admin, and nothing else', async () => {
    expect((await post({ action: 'delete', id: WAITING })).status).toBe(409);
    expect(await (await post({ action: 'delete', id: MADE })).json()).toEqual({ error: "Only a draft can be deleted. It's in NetSuite already." });
    state.tables.typed_journal_entries[0].created_by = BOSS;
    const theirs = await post({ action: 'delete', id: DRAFT });
    expect(theirs.status).toBe(403);
    expect(await theirs.json()).toEqual({ error: 'Only whoever started a draft, or a super admin, can delete it.' });
    expect(logAudit).not.toHaveBeenCalled();

    // A super admin can delete anyone's.
    as(CRAIG, ['super_admin']);
    expect(await (await post({ action: 'delete', id: DRAFT })).json()).toEqual({ success: true });
    expect(state.tables.typed_journal_entries.map((r) => r.id)).toEqual([WAITING, MADE]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: CRAIG, table: 'typed_journal_entries', recordId: DRAFT, action: 'delete',
      detail: { journal: 'general', company: 'BMG', date: '2027-01-31', memo: 'January depreciation', total: '$1,250.00' },
    });
    expect(await (await post({ action: 'delete', id: DRAFT })).json()).toEqual({ success: true, already: true });
    as(STAFF, ['admin']);
    state.tables.typed_journal_entries.push(entry(NEW));
    // Asked for approval between the route reading it and deleting it: it stays.
    state.meanwhile = () => { rowOf(NEW).status = 'waiting'; };
    const raced = await post({ action: 'delete', id: NEW });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toEqual({ error: "It wasn't deleted: it was asked for approval just now." });
    expect(rowOf(NEW).status).toBe('waiting');
    expect(logAudit).toHaveBeenCalledTimes(1);
    rowOf(NEW).status = 'draft';
    expect(await (await post({ action: 'delete', id: NEW })).json()).toEqual({ success: true });
  });

  it('asks for approval of a draft its lines make whole, and tells the super admins who can approve it and Craig', async () => {
    const res = await post({ action: 'ask', id: DRAFT, updatedAt: '2027-01-31T15:00:00.123456+00:00' });
    expect(await res.json()).toEqual({ success: true, askedAt: ASKED_AT });
    expect(rowOf(DRAFT)).toMatchObject({ status: 'waiting', asked_by: STAFF, returned_reason: null });
    expect(state.rpcs).toEqual([['typed_journal_entry_ask', { p: { id: DRAFT, by: STAFF, updated_at: '2027-01-31T15:00:00.123456+00:00' } }]]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: STAFF, table: 'typed_journal_entries', recordId: DRAFT, action: 'ask_approval',
      detail: { journal: 'general', company: 'BMG', date: '2027-01-31', memo: 'January depreciation', total: '$1,250.00', lines: 2 },
    });
    expect(notifyMany).toHaveBeenCalledTimes(1);
    expect(notifyMany).toHaveBeenCalledWith([BOSS, CRAIG], {
      type: 'books_journal_entry_waiting',
      title: 'A journal entry is waiting for approval',
      body: 'BMG journal entry dated 2027-01-31 for $1,250.00: January depreciation. Approve it to make it in NetSuite, or send it back.',
      url: `/admin/journal-entries?id=${DRAFT}`,
      channels: ['in_app', 'push', 'email'],
    });
  });

  it('never tells the one who asked, and says when nobody else can approve it', async () => {
    as(CRAIG, ['super_admin']);
    state.superAdmins = [CRAIG];
    const res = await post({ action: 'ask', id: DRAFT, updatedAt: '2027-01-31T15:00:00.123456+00:00' });
    expect(await res.json()).toEqual({ success: true, askedAt: ASKED_AT, warning: "No one else can approve it yet: it needs a super admin who didn't ask." });
    expect(notifyMany).not.toHaveBeenCalled();
  });

  it("asks nothing when the lines don't make an entry, it changed since, or it isn't a draft", async () => {
    const at = '2027-01-31T15:00:00.123456+00:00';
    state.tables.typed_journal_entries[0].lines = [
      { account_netsuite_id: '120', debit_cents: 125000, credit_cents: 0, memo: null },
      { account_netsuite_id: '640', debit_cents: 0, credit_cents: 125000, memo: null },
    ];
    const bad = await post({ action: 'ask', id: DRAFT, updatedAt: at });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: 'Line 1 goes to 1200 Accounts receivable, and NetSuite needs a customer or vendor there: make it an invoice, credit memo, bill or vendor credit instead. It wasn\'t asked for approval.',
      problems: [
        'Line 1 goes to 1200 Accounts receivable, and NetSuite needs a customer or vendor there: make it an invoice, credit memo, bill or vendor credit instead.',
        "Line 2 goes to an account BMG Fleet can't use.",
      ],
    });
    state.tables.typed_journal_entries[0].lines = LINES;
    state.tables.typed_journal_entries[0].company = 'GONE';
    expect((await (await post({ action: 'ask', id: DRAFT, updatedAt: at })).json()).problems[0]).toBe('Pick the company.');
    state.tables.typed_journal_entries[0].company = 'BMG';
    expect(rpcNames()).toEqual([]);

    const changed = await post({ action: 'ask', id: DRAFT, updatedAt: '2027-01-31T15:00:00Z' });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'It was changed since you opened it. Reload and check it, then ask again.' });
    expect(await (await post({ action: 'ask', id: WAITING, updatedAt: at })).json()).toEqual({ error: "It's asked for approval: take it back to change it." });
    const gone = await post({ action: 'ask', id: NEW, updatedAt: at });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "There's no such journal entry: it was deleted." });
    expect(rpcNames()).toEqual(['typed_journal_entry_ask']);

    // Someone else asked between the route reading it and asking.
    state.answers.typed_journal_entry_ask = () => ({ data: { state: 'waiting' }, error: null });
    const raced = await post({ action: 'ask', id: DRAFT, updatedAt: at });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toEqual({ error: "It's asked for approval: take it back to change it." });
    expect(notifyMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('takes an ask back for whoever asked or started it, or a super admin', async () => {
    expect(await (await post({ action: 'take_back', id: WAITING })).json()).toEqual({ success: true });
    expect(rowOf(WAITING)).toMatchObject({ status: 'draft', asked_by: null, updated_by: STAFF });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), { actorId: STAFF, table: 'typed_journal_entries', recordId: WAITING, action: 'take_back' });
    const again = await post({ action: 'take_back', id: WAITING });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "It's a draft now: it was taken back or sent back." });

    Object.assign(rowOf(WAITING), { status: 'waiting', asked_by: BOSS, created_by: BOSS });
    as(CRAIG, ['admin']);
    const other = await post({ action: 'take_back', id: WAITING });
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: 'Only whoever asked, or a super admin, can take it back.' });
    as(CRAIG, ['super_admin']);
    expect((await post({ action: 'take_back', id: WAITING })).status).toBe(200);
    expect((await post({ action: 'take_back', id: NEW })).status).toBe(404);
    // Whoever started it can, though someone else asked.
    Object.assign(rowOf(WAITING), { status: 'waiting', asked_by: CRAIG, created_by: OTHER });
    as(OTHER, ['admin']);
    expect((await post({ action: 'take_back', id: WAITING })).status).toBe(200);

    // Approved between the route reading it and taking it back.
    Object.assign(rowOf(WAITING), { status: 'waiting', asked_by: OTHER });
    state.answers.typed_journal_entry_take_back = () => ({ data: { state: 'sending' }, error: null });
    vi.mocked(logAudit).mockClear();
    const raced = await post({ action: 'take_back', id: WAITING });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toEqual({ error: "It's being made in NetSuite." });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('sends an ask back with why, for a super admin, and tells whoever asked', async () => {
    const staff = await post({ action: 'send_back', id: WAITING, reason: 'Split it' });
    expect(staff.status).toBe(403);
    expect(await staff.json()).toEqual({ error: 'Only a super admin approves journal entries or sends them back.' });

    as(BOSS, ['super_admin']);
    expect((await post({ action: 'send_back', id: WAITING, reason: '   ' })).status).toBe(400);
    expect(await (await post({ action: 'send_back', id: WAITING, reason: ' Split it by truck ' })).json()).toEqual({ success: true });
    expect(state.rpcs).toEqual([['typed_journal_entry_send_back', { p: { id: WAITING, by: BOSS, reason: 'Split it by truck' } }]]);
    expect(rowOf(WAITING)).toMatchObject({ status: 'draft', returned_by: BOSS, returned_reason: 'Split it by truck' });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: BOSS, table: 'typed_journal_entries', recordId: WAITING, action: 'send_back', detail: { reason: 'Split it by truck' },
    });
    expect(notifyMany).toHaveBeenCalledWith([STAFF, OTHER, CRAIG], {
      type: 'books_journal_entry_decided',
      title: 'Your journal entry was sent back',
      body: 'BMG journal entry dated 2027-01-31 for $500.00: Wages accrued, sent back to be fixed: Split it by truck',
      url: `/admin/journal-entries?id=${WAITING}`,
      channels: ['in_app', 'push', 'email'],
    });
    // Pressed again, it's already back, and nobody hears twice.
    const again = await post({ action: 'send_back', id: WAITING, reason: 'Again' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "It's a draft now: it was taken back or sent back." });
    expect(notifyMany).toHaveBeenCalledTimes(1);
    expect((await post({ action: 'send_back', id: NEW, reason: 'Gone' })).status).toBe(404);
  });

  it("makes an approved entry once in NetSuite, as it's kept, keeps Books' copy, and tells whoever asked", async () => {
    as(BOSS, ['super_admin']);
    netsuite.findJournalEntry.mockResolvedValueOnce(null).mockResolvedValueOnce({ journalId: '7002', number: 'JE-501' });
    const res = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(await res.json()).toEqual({ success: true, journalId: '7002', number: 'JE-501', totalCents: 50000 });
    expect(netsuite.findJournalEntry).toHaveBeenCalledWith(`fleetsuite-je-${WAITING}`);
    expect(netsuite.createJournalEntry).toHaveBeenCalledTimes(1);
    expect(netsuite.createJournalEntry).toHaveBeenCalledWith({
      subsidiaryId: '2', tranDate: '2027-01-31', memo: 'Wages accrued', externalId: `fleetsuite-je-${WAITING}`,
      lines: [{ accountId: '610', debit: 500 }, { accountId: '230', credit: 500 }],
    });
    expect(rowOf(WAITING)).toMatchObject({ status: 'made', netsuite_journal_id: '7002', netsuite_number: 'JE-501', approved_by: BOSS });
    expect(rpcNames()).toEqual(['typed_journal_entry_claim', 'typed_journal_entry_made', 'gl_own_journal_entry_save']);
    expect(state.rpcs[0][1]).toEqual({ p: { id: WAITING, approver: BOSS, asked_at: ASKED_AT } });
    expect(state.rpcs[2][1].p).toMatchObject({
      netsuite_id: '7002', netsuite_number: 'JE-501', company: 'BMG', source: 'typed', made_from_id: WAITING, rule: 'typed_journal_entry@1',
      total: '500.00', made_by: BOSS, tran_date: '2027-01-31',
    });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: BOSS, table: 'typed_journal_entries', recordId: WAITING, action: 'approve',
      detail: {
        netsuite_journal_id: '7002', journal: 'general', company: 'BMG', date: '2027-01-31', lines: 2, total: '$500.00', asked_by: STAFF,
        found_in_netsuite: false,
      },
    });
    expect(notifyMany).toHaveBeenCalledWith([STAFF, OTHER, CRAIG], {
      type: 'books_journal_entry_decided',
      title: 'Your journal entry was approved',
      body: 'BMG journal entry dated 2027-01-31 for $500.00: Wages accrued, approved and made in NetSuite as JE-501.',
      url: `/admin/journal-entries?id=${WAITING}`,
      channels: ['in_app', 'push', 'email'],
    });

    // Pressed again, it answers what it made and makes nothing.
    vi.clearAllMocks();
    expect(await (await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT })).json())
      .toEqual({ success: true, already: true, journalId: '7002', number: 'JE-501' });
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
    expect(notifyMany).not.toHaveBeenCalled();
  });

  it("makes 1084's in its own subsidiary, named by NetSuite's id when NetSuite doesn't say its number", async () => {
    as(BOSS, ['super_admin']);
    Object.assign(rowOf(WAITING), { company: '1084', memo: null, lines: [
      { account_netsuite_id: '640', debit_cents: 50000, credit_cents: 0, memo: null },
      { account_netsuite_id: '230', debit_cents: 0, credit_cents: 50000, memo: null },
    ] });
    expect((await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT })).status).toBe(400);
    rowOf(WAITING).memo = 'Dues accrued';
    netsuite.findJournalEntry.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('timeout'));
    expect(await (await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT })).json()).toEqual({ success: true, journalId: '7002', number: null, totalCents: 50000 });
    expect(netsuite.createJournalEntry.mock.calls[0][0]).toMatchObject({ subsidiaryId: '3', memo: 'Dues accrued' });
    expect(rowOf(WAITING)).toMatchObject({ status: 'made', netsuite_number: null });
    expect((notifyMany as any).mock.calls[0][1].body).toBe('1084 journal entry dated 2027-01-31 for $500.00: Dues accrued, approved and made in NetSuite as journal entry 7002.');
  });

  it("lets only a super admin who didn't ask approve the ask they saw", async () => {
    const staff = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(staff.status).toBe(403);
    expect(await staff.json()).toEqual({ error: 'Only a super admin approves journal entries or sends them back.' });

    as(STAFF, ['super_admin']);
    const yours = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(yours.status).toBe(403);
    expect(await yours.json()).toEqual({ error: "You asked for this one, so a super admin who didn't ask approves it. Nothing was sent." });

    as(BOSS, ['super_admin']);
    const changed = await post({ action: 'approve', id: WAITING, askedAt: '2027-01-31T16:00:00Z' });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'It was taken back or asked for again since you opened it. Reload and check it. Nothing was sent.' });
    const draft = await post({ action: 'approve', id: DRAFT, askedAt: ASKED_AT });
    expect(draft.status).toBe(409);
    expect(await draft.json()).toEqual({ error: "It's a draft now: it was taken back or sent back. Nothing was sent." });
    expect((await post({ action: 'approve', id: NEW, askedAt: ASKED_AT })).status).toBe(404);
    expect(netsuite.findJournalEntry).not.toHaveBeenCalled();
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
    expect(rowOf(WAITING).status).toBe('waiting');
  });

  it("lets go of an approval whose lines no longer make an entry, and sends nothing", async () => {
    as(BOSS, ['super_admin']);
    rowOf(WAITING).lines = [
      { account_netsuite_id: '699', debit_cents: 50000, credit_cents: 0, memo: null },
      { account_netsuite_id: '230', debit_cents: 0, credit_cents: 50000, memo: null },
    ];
    const res = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Line 1 goes to an account BMG Fleet can't use. Nothing was sent.", problems: ["Line 1 goes to an account BMG Fleet can't use."] });
    expect(rowOf(WAITING)).toMatchObject({ status: 'waiting', error: "Line 1 goes to an account BMG Fleet can't use.", approved_by: null });
    expect(netsuite.findJournalEntry).not.toHaveBeenCalled();
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
  });

  it("makes none when NetSuite has the entry's journal entry already, or can't say whether it has", async () => {
    as(BOSS, ['super_admin']);
    netsuite.findJournalEntry.mockResolvedValueOnce({ journalId: '7003', number: 'JE-502' });
    expect(await (await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT })).json())
      .toEqual({ success: true, already: true, journalId: '7003', number: 'JE-502', totalCents: 50000 });
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
    expect(rowOf(WAITING)).toMatchObject({ status: 'made', netsuite_journal_id: '7003' });
    expect((logAudit as any).mock.calls[0][1].detail.found_in_netsuite).toBe(true);

    Object.assign(rowOf(WAITING), { status: 'waiting', netsuite_journal_id: null, netsuite_number: null, approved_by: null, approved_at: null });
    netsuite.findJournalEntry.mockRejectedValueOnce(new Error('NetSuite timed out'));
    const unsure = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({ error: "Couldn't check NetSuite for this entry (NetSuite timed out). Nothing was sent. Try again." });
    expect(rowOf(WAITING)).toMatchObject({ status: 'waiting', error: "Couldn't check NetSuite for this entry (NetSuite timed out)." });
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
  });

  it("lets go when NetSuite refuses it, and keeps it approved when NetSuite can't tell whether it made it", async () => {
    as(BOSS, ['super_admin']);
    netsuite.createJournalEntry.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): Period closed' });
    const refused = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: 'NetSuite error (400): Period closed' });
    expect(rowOf(WAITING)).toMatchObject({ status: 'waiting', error: 'NetSuite error (400): Period closed', approved_by: null });
    expect(notifyMany).not.toHaveBeenCalled();

    netsuite.createJournalEntry.mockResolvedValueOnce({ success: false, error: 'NetSuite error (503): Busy', unsure: true });
    const unsure = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({
      error: "NetSuite error (503): Busy FleetSuite can't tell whether NetSuite made it, so it stays approved. Press Ask NetSuite in a few minutes and FleetSuite will find out.",
      unsure: true,
    });
    expect(rowOf(WAITING)).toMatchObject({ status: 'sending', error: 'NetSuite error (503): Busy', approved_by: BOSS });

    netsuite.createJournalEntry.mockResolvedValueOnce({ success: true });
    rowOf(WAITING).status = 'waiting';
    const noId = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(await noId.json()).toEqual({ error: "NetSuite didn't make the journal entry." });
    expect(rowOf(WAITING).status).toBe('waiting');
  });

  it("won't make it twice while an approval is being made, and asks NetSuite what became of one left a while", async () => {
    as(CRAIG, ['super_admin']);
    Object.assign(rowOf(WAITING), { status: 'sending', approved_by: BOSS, approved_at: new Date(Date.now() - 2 * 60_000).toISOString() });
    const now = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(now.status).toBe(409);
    expect(await now.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });
    expect(netsuite.findJournalEntry).not.toHaveBeenCalled();

    // Left a while: NetSuite made it, so it's kept as made by whoever approved it.
    rowOf(WAITING).approved_at = new Date(Date.now() - 6 * 60_000).toISOString();
    netsuite.findJournalEntry.mockResolvedValueOnce({ journalId: '7004', number: 'JE-503' });
    expect(await (await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT })).json())
      .toEqual({ success: true, already: true, journalId: '7004', number: 'JE-503', totalCents: 50000 });
    expect(rowOf(WAITING)).toMatchObject({ status: 'made', netsuite_journal_id: '7004' });
    expect(state.rpcs.find(([fn]) => fn === 'gl_own_journal_entry_save')![1].p.made_by).toBe(BOSS);
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();

    // Or it didn't, and the entry waits for approval again.
    Object.assign(rowOf(WAITING), { status: 'sending', netsuite_journal_id: null, approved_at: new Date(Date.now() - 6 * 60_000).toISOString() });
    const none = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'NetSuite has no journal entry from this approval, so it waits for approval again.' });
    expect(rowOf(WAITING)).toMatchObject({ status: 'waiting', error: 'NetSuite has no journal entry from this approval, so it waits for approval again.' });

    Object.assign(rowOf(WAITING), { status: 'sending', approved_at: new Date(Date.now() - 6 * 60_000).toISOString() });
    netsuite.findJournalEntry.mockRejectedValueOnce(new Error('timeout'));
    const cant = await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT });
    expect(cant.status).toBe(502);
    expect(await cant.json()).toEqual({ error: "Couldn't ask NetSuite what became of this approval (timeout). Try again." });
    expect(rowOf(WAITING).status).toBe('sending');
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
  });

  it("says when Books couldn't keep its copy, and still answers that the journal entry is made", async () => {
    as(BOSS, ['super_admin']);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.answers.gl_own_journal_entry_save = () => ({ data: null, error: { message: "gl: own journal entry 7002's debits and credits don't match" } });
    expect(await (await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT })).json()).toEqual({
      success: true, journalId: '7002', number: null, totalCents: 50000,
      warning: "Books didn't keep its copy (gl: own journal entry 7002's debits and credits don't match). The journal entry is in NetSuite.",
    });
    state.answers.gl_own_journal_entry_save = () => ({ data: { saved: false, lines: 0 }, error: null });
    Object.assign(rowOf(DRAFT), { status: 'waiting', asked_by: STAFF, asked_at: ASKED_AT });
    expect(await (await post({ action: 'approve', id: DRAFT, askedAt: ASKED_AT })).json()).not.toHaveProperty('warning');
    log.mockRestore();
  });

  it('still answers when an alert or keeping the made entry fails', async () => {
    as(BOSS, ['super_admin']);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    (notifyMany as any).mockRejectedValueOnce(new Error('push down'));
    state.answers.typed_journal_entry_made = () => ({ data: null, error: { message: 'connection reset' } });
    expect(await (await post({ action: 'approve', id: WAITING, askedAt: ASKED_AT })).json()).toMatchObject({ success: true, journalId: '7002' });
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      `[journal-entries] entry ${WAITING} made as NetSuite journal entry 7002 but not kept: connection reset`,
      '[journal-entries] alert books_journal_entry_decided not sent: push down',
    ]);
    log.mockRestore();
  });

  it("refuses a body that isn't an entry's ids, whole cents and lines", async () => {
    for (const body of [
      { ...SAVE, id: 'not-an-id' }, { ...SAVE, date: '28/02/2027' }, { ...SAVE, company: '' },
      { ...SAVE, lines: [{ accountId: '610', debitCents: -1, creditCents: 0 }] },
      { ...SAVE, lines: [{ accountId: '610', debitCents: 1.5, creditCents: 0 }] },
      { ...SAVE, lines: [{ accountId: '610', debitCents: 10_000_000_001, creditCents: 0 }] },
      { ...SAVE, lines: [{ accountId: 'Shop', debitCents: 1, creditCents: 0 }] },
      { ...SAVE, lines: [{ accountId: '610', debitCents: 1, creditCents: 0, memo: 'm'.repeat(301) }] },
      { ...SAVE, memo: 'm'.repeat(301) }, { ...SAVE, journal: 'payroll' }, { ...SAVE, journal: 'CPA adjustments' },
      { ...SAVE, lines: Array.from({ length: 201 }, () => ({ accountId: '610', debitCents: 1, creditCents: 0 })) },
      { action: 'ask', id: DRAFT }, { action: 'approve', id: WAITING }, { action: 'send_back', id: WAITING, reason: 'r'.repeat(501) },
      { action: 'post', id: DRAFT },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(state.rpcs).toEqual([]);
  });
});

describe("the CPA's adjustments journal", () => {
  const CPA_DRAFT = E(5);
  const CPA_WAITING = E(6);
  /** The year's depreciation the CPA books: $9,600.00 to depreciation, against accumulated depreciation. */
  const YEAR = [
    { account_netsuite_id: '610', debit_cents: 960000, credit_cents: 0, memo: null },
    { account_netsuite_id: '150', debit_cents: 0, credit_cents: 960000, memo: null },
  ];
  const CPA_SAVE = { ...SAVE, id: NEW, journal: 'cpa_adjustments', date: '2026-12-31', memo: '2026 loan interest' };
  const ids = async (q = '') => ((await (await get(q)).json()).entries as Array<{ id: string; journal: string }>).map((e) => `${e.journal} ${e.id}`).sort();

  beforeEach(() => {
    switchOn(true);
    as(CPA, ['cpa']);
    state.hasPayments = false;
    state.tables.typed_journal_entries.push(
      entry(CPA_DRAFT, { journal: 'cpa_adjustments', tran_date: '2026-12-31', memo: '2026 depreciation', lines: YEAR, total_cents: 960000, created_by: CPA, updated_by: CPA }),
      entry(CPA_WAITING, {
        journal: 'cpa_adjustments', tran_date: '2026-12-31', memo: '2026 depreciation', lines: YEAR, total_cents: 960000,
        status: 'waiting', created_by: CPA, updated_by: CPA, asked_by: CPA, asked_at: ASKED_AT,
      }),
    );
  });

  it('shows the CPA its own journal and nothing else, once journal entries are on', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true, canApprove: false, journals: ['cpa_adjustments'] });
    expect(await ids()).toEqual([`cpa_adjustments ${CPA_DRAFT}`, `cpa_adjustments ${CPA_WAITING}`]);
    // Not even a general one asked for by its id.
    expect(await ids(`id=${DRAFT}`)).toEqual([`cpa_adjustments ${CPA_DRAFT}`, `cpa_adjustments ${CPA_WAITING}`]);
    expect((await (await get('')).json()).journals).toEqual(['cpa_adjustments']);

    // Staff with Payments see the general journal only, and super admins both.
    as(STAFF, ['admin']);
    state.hasPayments = true;
    expect(await ids()).toEqual([`general ${DRAFT}`, `general ${WAITING}`, `general ${MADE}`]);
    expect(await ids(`id=${CPA_DRAFT}`)).not.toContain(`cpa_adjustments ${CPA_DRAFT}`);
    as(BOSS, ['super_admin']);
    expect(await ids()).toHaveLength(5);

    // Switched off, the CPA is kept out like everyone but super admins.
    switchOn(false);
    as(CPA, ['cpa']);
    state.hasPayments = false;
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false, canApprove: false, journals: ['cpa_adjustments'] });
    const off = await get('');
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({ error: 'Journal entries are switched off until January 1, 2027.', switchedOff: true });
    expect((await post(CPA_SAVE)).status).toBe(403);
    expect(state.rpcs).toEqual([]);
  });

  it('lets the CPA type, change and ask for approval of CPA adjustments, and nothing in the general journal', async () => {
    expect(await (await post(CPA_SAVE)).json()).toEqual({ success: true, updatedAt: expect.any(String) });
    expect(state.rpcs[0][1].p).toMatchObject({ id: NEW, journal: 'cpa_adjustments', memo: '2026 loan interest', by: CPA });
    expect(rowOf(NEW)).toMatchObject({ journal: 'cpa_adjustments', status: 'draft', created_by: CPA });

    // The general journal isn't the CPA's, nor is an entry started there.
    const general = await post({ ...CPA_SAVE, id: E(7), journal: undefined });
    expect(general.status).toBe(403);
    expect(await general.json()).toEqual({ error: 'The general journal needs the Payments permission.' });
    const moved = await post({ ...CPA_SAVE, id: DRAFT });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({
      error: "It wasn't saved. It was started in another journal, and an entry stays in the journal it was started in.", status: 'other_journal',
    });
    expect(rowOf(DRAFT)).toMatchObject({ journal: 'general', memo: 'January depreciation' });
    for (const [action, extra] of [['ask', { updatedAt: rowOf(DRAFT).updated_at }], ['delete', {}], ['take_back', {}]] as const) {
      const res = await post({ action, id: action === 'take_back' ? WAITING : DRAFT, ...extra });
      expect(res.status, action).toBe(403);
      expect(await res.json(), action).toEqual({ error: 'The general journal needs the Payments permission.' });
    }
    expect(rowOf(WAITING).status).toBe('waiting');

    // Asked for, every super admin hears a CPA adjustment is waiting.
    expect(await (await post({ action: 'ask', id: CPA_DRAFT, updatedAt: rowOf(CPA_DRAFT).updated_at })).json()).toEqual({ success: true, askedAt: ASKED_AT });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ask_approval', detail: expect.objectContaining({ journal: 'cpa_adjustments', total: '$9,600.00' }),
    }));
    expect(notifyMany).toHaveBeenCalledWith([BOSS, CRAIG], {
      type: 'books_journal_entry_waiting',
      title: 'A CPA adjustment is waiting for approval',
      body: 'BMG CPA adjustment dated 2026-12-31 for $9,600.00: 2026 depreciation. Approve it to make it in NetSuite, or send it back.',
      url: `/admin/journal-entries?id=${CPA_DRAFT}`,
      channels: ['in_app', 'push', 'email'],
    });
    expect(await (await post({ action: 'take_back', id: CPA_DRAFT })).json()).toEqual({ success: true });

    // Its memo leaves room for what NetSuite's starts with.
    rowOf(CPA_DRAFT).memo = 'm'.repeat(285);
    const long = await post({ action: 'ask', id: CPA_DRAFT, updatedAt: rowOf(CPA_DRAFT).updated_at });
    expect(long.status).toBe(400);
    expect((await long.json()).problems).toEqual(['A CPA adjustment\'s memo takes 284 characters at most, as NetSuite\'s starts "CPA adjustment:".']);

    // And nobody but the CPA and super admins types one.
    as(STAFF, ['admin']);
    state.hasPayments = true;
    for (const body of [{ ...CPA_SAVE, id: E(8) }, { action: 'delete', id: CPA_DRAFT }, { action: 'ask', id: CPA_DRAFT, updatedAt: rowOf(CPA_DRAFT).updated_at }]) {
      const res = await post(body);
      expect(res.status, body.action).toBe(403);
      expect(await res.json(), body.action).toEqual({ error: 'Only the CPA and super admins type CPA adjustments.' });
    }
    expect(state.tables.typed_journal_entries.map((r) => r.id)).not.toContain(E(8));
  });

  it("is approved by a super admin, made in NetSuite with its memo starting \"CPA adjustment:\", and the CPA hears", async () => {
    const cpa = await post({ action: 'approve', id: CPA_WAITING, askedAt: ASKED_AT });
    expect(cpa.status).toBe(403);
    expect(await cpa.json()).toEqual({ error: 'Only a super admin approves journal entries or sends them back.' });

    as(BOSS, ['super_admin']);
    expect(await (await post({ action: 'approve', id: CPA_WAITING, askedAt: ASKED_AT })).json())
      .toEqual({ success: true, journalId: '7002', number: null, totalCents: 960000 });
    expect(netsuite.createJournalEntry).toHaveBeenCalledWith({
      subsidiaryId: '2', tranDate: '2026-12-31', memo: 'CPA adjustment: 2026 depreciation', externalId: `fleetsuite-je-${CPA_WAITING}`,
      lines: [{ accountId: '610', debit: 9600 }, { accountId: '150', credit: 9600 }],
    });
    expect(state.rpcs.find(([fn]) => fn === 'gl_own_journal_entry_save')![1].p).toMatchObject({
      source: 'typed', made_from_id: CPA_WAITING, memo: 'CPA adjustment: 2026 depreciation', total: '9600.00',
    });
    expect((logAudit as any).mock.calls.at(-1)[1]).toMatchObject({ action: 'approve', detail: { journal: 'cpa_adjustments' } });
    expect(notifyMany).toHaveBeenCalledWith([CPA, CRAIG], {
      type: 'books_journal_entry_decided',
      title: 'Your CPA adjustment was approved',
      body: 'BMG CPA adjustment dated 2026-12-31 for $9,600.00: 2026 depreciation, approved and made in NetSuite as journal entry 7002.',
      url: `/admin/journal-entries?id=${CPA_WAITING}`,
      channels: ['in_app', 'push', 'email'],
    });

    // Sent back, the CPA hears why.
    Object.assign(rowOf(CPA_DRAFT), { status: 'waiting', asked_by: CPA, asked_at: ASKED_AT });
    vi.mocked(notifyMany).mockClear();
    expect(await (await post({ action: 'send_back', id: CPA_DRAFT, reason: 'Use the loan schedule' })).json()).toEqual({ success: true });
    expect(vi.mocked(notifyMany).mock.calls[0][1]).toMatchObject({
      title: 'Your CPA adjustment was sent back',
      body: 'BMG CPA adjustment dated 2026-12-31 for $9,600.00: 2026 depreciation, sent back to be fixed: Use the loan schedule',
    });

    // A super admin without Payments approves the CPA's, and doesn't approve or send back the general journal's.
    state.hasPayments = false;
    for (const body of [{ action: 'approve', id: WAITING, askedAt: ASKED_AT }, { action: 'send_back', id: WAITING, reason: 'Split it' }]) {
      const general = await post(body);
      expect(general.status, body.action).toBe(403);
      expect(await general.json(), body.action).toEqual({ error: 'The general journal needs the Payments permission.' });
    }
    expect(rowOf(WAITING).status).toBe('waiting');
    expect(netsuite.createJournalEntry).toHaveBeenCalledTimes(1);
  });
});
