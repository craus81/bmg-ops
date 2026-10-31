// /api/card-charges (src/lib/card-charges.ts): who can open it while card
// charges are switched off and once they're on, what adding a Chase download,
// coding charges and taking a file back off send the database, and what one
// press of Send does: the month's charges claimed and worked out again as
// they're kept, checked against what the page showed, made once in NetSuite
// under the press's own External ID however often it's pressed, the claim let
// go when NetSuite refuses and kept when it can't tell, and Books' own copy
// kept. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    roles: ['admin'] as string[],
    hasPayments: true,
    tables: {} as Record<string, Record<string, any>[]>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    answers: {} as Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }>,
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
    let range: [number, number] | null = null;
    const rows = () => (state.tables[table] ??= []);
    const run = () => {
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (remove) {
        state.tables[table] = rows().filter((r) => !matched.includes(r));
        return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (patch) {
        for (const r of matched) Object.assign(r, patch);
        return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      const out = matched.slice(0, limit);
      return { data: (range ? out.slice(range[0], range[1] + 1) : out).map((r) => ({ ...r })), error: null };
    };
    const builder: any = {
      select: () => { if (patch || remove) returning = true; return builder; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      order: () => builder,
      limit: (n: number) => { limit = n; return builder; },
      range: (from: number, to: number) => { range = [from, to]; return builder; },
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
  // The accounts a charge can go to, and (asked for by type) the card accounts.
  const accounts = (types?: readonly string[]) => new Map(types
    ? [
      ['900', { id: '900', number: '2100', name: 'Company card', type: 'credit_card', companies: ['BMG'] }],
      ['901', { id: '901', number: '2101', name: 'Second card', type: 'credit_card', companies: ['1084'] }],
      ['903', { id: '903', number: '2103', name: 'Fuel card', type: 'other_current_liability', companies: ['BMG'] }],
      ['909', { id: '909', number: '2109', name: 'Closed card', type: 'credit_card', companies: [] as string[] }],
    ]
    : [
      ['620', { id: '620', number: '5200', name: 'Freight in', type: 'cost_of_goods_sold', companies: ['BMG'] }],
      ['610', { id: '610', number: '5100', name: 'Shop supplies', type: 'expense', companies: ['BMG', '1084'] }],
      ['640', { id: '640', number: '6400', name: 'Dues', type: 'expense', companies: ['1084'] }],
      ['699', { id: '699', number: '9999', name: 'Closed out', type: 'expense', companies: [] as string[] }],
    ]);
  return { state, netsuite, service, companies, accounts };
});

vi.mock('@/lib/api-auth', () => ({
  requireFeature: vi.fn(async (_req: unknown, feature: string) => (h.state.hasPayments && feature === 'vendor_payments'
    ? { user: { id: 'd0000000-0000-4000-8000-000000000001' }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/books/snap-a-bill', () => ({
  readCompanies: vi.fn(async () => h.companies),
  readAccounts: vi.fn(async (_s: unknown, _c: unknown, types?: readonly string[]) => h.accounts(types)),
}));

const { state, netsuite } = h;

import { logAudit } from '@/lib/audit';
import { GET, POST } from '../app/api/card-charges/route';

const USER = 'd0000000-0000-4000-8000-000000000001';
const SEND = 'b0000000-0000-4000-8000-000000000001';
const MADE_SEND = 'b0000000-0000-4000-8000-000000000009';
const IMPORT_1 = 'a0000000-0000-4000-8000-000000000001';
const IMPORT_2 = 'a0000000-0000-4000-8000-000000000002';
const NEW_IMPORT = 'a0000000-0000-4000-8000-000000000003';
const OTHER_IMPORT = 'a0000000-0000-4000-8000-000000000004';
const C = (n: number) => `c0000000-0000-4000-8000-00000000000${n}`;

const charge = (n: number, over: Record<string, unknown> = {}) => ({
  id: C(n), import_id: IMPORT_1, company: 'BMG', card_account_netsuite_id: '900', charge_date: '2027-01-03', post_date: '2027-01-04',
  description: 'ACME HARDWARE #1234', merchant_key: 'ACME HARDWARE', category: 'Home', chase_type: 'Sale', cents: 12550, card: '1234',
  account_netsuite_id: '610', memo: null, remembered: false, send_id: null, ...over,
});
/** A purchase, money back from the same merchant, and a marketplace order: $147.60 onto the card in January. */
const CLAIMED = [
  charge(1),
  charge(2, { charge_date: '2027-01-07', post_date: '2027-01-07', description: 'ACME HARDWARE #5678', chase_type: 'Return', cents: -2000 }),
  charge(3, {
    charge_date: '2027-01-07', post_date: '2027-01-08', description: 'WIDGETS MKTPL*AB1CD2', merchant_key: 'WIDGETS MKTPL', cents: 4210, card: null,
    account_netsuite_id: '620', memo: 'Shelf bins', remembered: true,
  }),
];
const SEND_BODY = { action: 'send', sendId: SEND, company: 'BMG', cardId: '900', month: '2027-01', expectedCount: 3, expectedTotalCents: 14760 };
const m1 = 'ACME HARDWARE #1234 · Jan 3 · card 1234';
const m2 = 'ACME HARDWARE #5678 · Jan 7 · card 1234';
const m3 = 'WIDGETS MKTPL*AB1CD2 · Jan 7 · Shelf bins';

const get = (query: string) => GET(new NextRequest(`https://app.test/api/card-charges?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/card-charges', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const rpcNames = () => state.rpcs.map(([fn]) => fn);
const sendRow = () => state.tables.card_charge_sends.find((s) => s.id === SEND);
const claimAs = (answer: Record<string, unknown>) => { state.answers.card_charges_claim = () => ({ data: answer, error: null }); };
const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'card_charges', is_on: on }, { piece: 'vendor_credits', is_on: !on }]; };

beforeEach(() => {
  state.roles = ['admin'];
  state.hasPayments = true;
  state.tables = {
    card_charge_imports: [
      { id: IMPORT_2, company: 'BMG', card_account_netsuite_id: '900', file_name: 'february.csv', charges: 2, added: 1, already: 1, remembered: 1, payments: 0, created_at: '2027-02-05T10:00:00Z' },
      { id: IMPORT_1, company: 'BMG', card_account_netsuite_id: '900', file_name: 'january.csv', charges: 4, added: 4, already: 0, remembered: 0, payments: 1, created_at: '2027-02-01T10:00:00Z' },
    ],
    card_charges: [
      charge(1),
      charge(4, { import_id: IMPORT_2, charge_date: '2027-02-02', post_date: '2027-02-03', description: 'BOLT BARN', merchant_key: 'BOLT BARN', cents: 999, account_netsuite_id: null }),
      charge(5, { charge_date: '2026-12-30', send_id: MADE_SEND }),
      charge(6, { import_id: OTHER_IMPORT, card_account_netsuite_id: '901', company: '1084', description: 'OTHER CARD' }),
    ],
    card_charge_sends: [{
      id: MADE_SEND, company: 'BMG', card_account_netsuite_id: '900', month: '2027-01-01', tran_date: '2027-01-31', charge_count: 1, net_cents: 12550,
      total_cents: 12550, claimed_at: '2027-02-01T11:00:00Z', netsuite_journal_id: '7001', netsuite_number: 'JE-500', error: null, created_at: '2027-02-01T11:00:00Z',
    }],
  };
  switchOn(false);
  state.rpcs.length = 0;
  state.answers = {
    card_charges_import: (p) => ({ data: { added: p.rows.length, already: 0, remembered: 0, payments: p.payments, again: false }, error: null }),
    card_charges_code: (p) => ({ data: { coded: p.changes.length, held: 0 }, error: null }),
    card_charges_claim: (p) => {
      state.tables.card_charge_sends.push({ id: p.send_id, card_account_netsuite_id: p.card_account_netsuite_id, claimed_at: new Date().toISOString() });
      return { data: { state: 'claimed', charges: CLAIMED }, error: null };
    },
    card_charges_let_go: (p) => {
      const s = state.tables.card_charge_sends.find((r) => r.id === p.send_id);
      if (s && !s.netsuite_journal_id) Object.assign(s, { claimed_at: null, error: p.error });
      return { data: { let_go: s ? CLAIMED.length : 0 }, error: null };
    },
    gl_own_journal_entry_save: (p) => ({ data: { saved: true, lines: p.lines.length }, error: null }),
  };
  vi.clearAllMocks();
  // A test that stops early leaves answers queued; the next starts with none.
  netsuite.findJournalEntry.mockReset();
  netsuite.createJournalEntry.mockReset();
  netsuite.findJournalEntry.mockResolvedValue(null);
  netsuite.createJournalEntry.mockResolvedValue({ success: true, journalId: '7002' });
});

describe('while card charges are switched off', () => {
  it('shows Card Charges to super admins with Payments only', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.roles = ['super_admin'];
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true });
    state.hasPayments = false;
    expect((await get('status=1')).status).toBe(403);
  });

  it("lets a super admin see the card's charges, sends and files, and nobody else", async () => {
    const refused = await get('');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Card charges are switched off until January 1, 2027.', switchedOff: true });

    state.roles = ['super_admin'];
    const res = await get('');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      companies: [{ code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2' }, { code: '1084', name: '1084 Cool Springs', subsidiaryId: '3' }],
      company: 'BMG',
      cardAccounts: [
        { id: '900', number: '2100', name: 'Company card', type: 'credit_card', companies: ['BMG'] },
        { id: '903', number: '2103', name: 'Fuel card', type: 'other_current_liability', companies: ['BMG'] },
      ],
      accounts: [
        { id: '610', number: '5100', name: 'Shop supplies', type: 'expense', companies: ['BMG', '1084'] },
        { id: '620', number: '5200', name: 'Freight in', type: 'cost_of_goods_sold', companies: ['BMG'] },
      ],
      cardId: '900',
      charges: [
        {
          id: C(1), date: '2027-01-03', description: 'ACME HARDWARE #1234', card: '1234', cents: 12550, accountId: '610', memo: null,
          postDate: '2027-01-04', merchantKey: 'ACME HARDWARE', category: 'Home', type: 'Sale', remembered: false,
        },
        {
          id: C(4), date: '2027-02-02', description: 'BOLT BARN', card: '1234', cents: 999, accountId: null, memo: null,
          postDate: '2027-02-03', merchantKey: 'BOLT BARN', category: 'Home', type: 'Sale', remembered: false,
        },
      ],
      sends: [{
        id: MADE_SEND, month: '2027-01', date: '2027-01-31', count: 1, netCents: 12550, totalCents: 12550, state: 'made', journalId: '7001',
        number: 'JE-500', error: null, at: '2027-02-01T11:00:00Z',
      }],
      imports: [
        { id: IMPORT_2, fileName: 'february.csv', charges: 2, added: 1, already: 1, remembered: 1, payments: 0, unsent: 1, at: '2027-02-05T10:00:00Z' },
        { id: IMPORT_1, fileName: 'january.csv', charges: 4, added: 4, already: 0, remembered: 0, payments: 1, unsent: 1, at: '2027-02-01T10:00:00Z' },
      ],
      firstSendMonth: '2027-01',
      maxPerEntry: 250,
      switchedOn: false,
      offText: 'Card charges are switched off until January 1, 2027. You can add and code charges to see what a send would make; nothing goes to NetSuite.',
    });
  });

  it("opens another company's card, and its own first card when the one asked for isn't its", async () => {
    state.roles = ['super_admin'];
    const other = await (await get('company=1084&card=900')).json();
    expect(other).toMatchObject({ company: '1084', cardId: '901', cardAccounts: [{ id: '901' }], accounts: [{ id: '610' }, { id: '640' }] });
    expect(other.charges.map((c: { id: string }) => c.id)).toEqual([C(6)]);
    expect((await (await get('company=NOPE')).json()).company).toBe('BMG');

    // The card picked, else the one a file was last added to, else the company's first.
    state.tables.card_charge_imports.unshift({ id: OTHER_IMPORT, company: 'BMG', card_account_netsuite_id: '903', created_at: '2027-02-06T10:00:00Z' });
    expect((await (await get('')).json()).cardId).toBe('903');
    expect((await (await get('card=900')).json()).cardId).toBe('900');
    expect((await (await get('card=901')).json()).cardId).toBe('903');
    state.tables.card_charge_imports = [];
    expect((await (await get('')).json()).cardId).toBe('900');
  });

  it("lists each send as made, being made or refused, with NetSuite's reason only when it wasn't made", async () => {
    state.roles = ['super_admin'];
    const send = (id: string, over: Record<string, unknown>) => ({
      id, company: 'BMG', card_account_netsuite_id: '900', month: '2027-01-01', tran_date: null, charge_count: null, net_cents: null, total_cents: null,
      claimed_at: null, netsuite_journal_id: null, netsuite_number: null, error: null, created_at: '2027-02-01T11:00:00Z', ...over,
    });
    state.tables.card_charge_sends = [
      send(SEND, { claimed_at: '2027-02-01T11:00:00Z', netsuite_journal_id: '7002', error: 'NetSuite error (503): Server busy', net_cents: '14760' }),
      send(MADE_SEND, { claimed_at: '2027-02-01T11:00:00Z' }),
      send(NEW_IMPORT, { error: 'NetSuite error (400): The period is closed.' }),
    ];
    const { sends } = await (await get('')).json();
    expect(sends.map((s: Record<string, unknown>) => [s.state, s.error, s.netCents])).toEqual([
      ['made', null, 14760],
      ['making', null, null],
      ['refused', 'NetSuite error (400): The period is closed.', null],
    ]);
  });

  it('lets a super admin add, code and take back charges, and sends nothing to NetSuite, even for them', async () => {
    state.roles = ['super_admin'];
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n01/03/2027,01/04/2027,ACME HARDWARE #1234,Home,Sale,-125.50,';
    expect((await post({ action: 'import', importId: NEW_IMPORT, company: 'BMG', cardId: '900', csv })).status).toBe(200);
    expect((await post({ action: 'code', company: 'BMG', cardId: '900', changes: [{ id: C(4), accountId: '610' }] })).status).toBe(200);
    expect((await post({ action: 'undo', importId: IMPORT_2 })).status).toBe(200);

    const res = await post(SEND_BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Card charges are switched off until January 1, 2027. Nothing was sent to NetSuite.', switchedOff: true });
    expect(rpcNames()).toEqual(['card_charges_import', 'card_charges_code']);
    expect(netsuite.findJournalEntry).not.toHaveBeenCalled();
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();

    state.roles = ['admin'];
    expect((await post({ action: 'undo', importId: IMPORT_1 })).status).toBe(403);
  });
});

describe('once card charges are switched on', () => {
  beforeEach(() => switchOn(true));

  it('lets anyone with Payments use them, and nobody else', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });
    expect(await (await get('')).json()).toMatchObject({ switchedOn: true, offText: null });
    state.hasPayments = false;
    expect((await get('')).status).toBe(403);
    expect((await post(SEND_BODY)).status).toBe(403);
    expect(state.rpcs).toEqual([]);
  });

  it("adds a download's charges, says how many were new, and refuses a file it can't read", async () => {
    const csv = [
      'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
      '01/03/2027,01/04/2027,ACME HARDWARE #1234,Home,Sale,-125.50,',
      '01/08/2027,01/08/2027,AUTOMATIC PAYMENT - THANK,,Payment,500.00,',
      '01/09/2027,01/09/2027,ZERO DOLLAR AUTH,Shopping,Sale,0.00,',
    ].join('\n');
    const body = { action: 'import', importId: NEW_IMPORT, company: 'BMG', cardId: '900', fileName: 'activity.csv', csv };
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, added: 1, already: 0, remembered: 0, payments: 1, again: false, zero: 1 });
    expect(state.rpcs).toEqual([['card_charges_import', { p: {
      import_id: NEW_IMPORT, company: 'BMG', card_account_netsuite_id: '900', file_name: 'activity.csv', payments: 1, imported_by: USER,
      rows: [{
        charge_date: '2027-01-03', post_date: '2027-01-04', description: 'ACME HARDWARE #1234', merchant_key: 'ACME HARDWARE', category: 'Home',
        chase_type: 'Sale', cents: 12550, card: null, chase_memo: null, fingerprint: '2027-01-03|2027-01-04|ACME HARDWARE #1234|12550|#1',
      }],
    } }]]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: USER, table: 'card_charge_imports', recordId: NEW_IMPORT, action: 'create',
      detail: { card: '900', file: 'activity.csv', added: 1, already: 0, remembered: 0 },
    });

    // The same file sent twice in one go is one import, logged once.
    state.answers.card_charges_import = () => ({ data: { added: 1, already: 0, remembered: 0, payments: 1, again: true }, error: null });
    expect(await (await post(body)).json()).toMatchObject({ success: true, again: true });
    expect(logAudit).toHaveBeenCalledTimes(1);

    const bad = await post({ ...body, csv: 'Date,Name,Value\n01/03/2027,ACME,-1.00' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/^This isn't a Chase card download/);
    expect(state.rpcs).toHaveLength(2);
  });

  it("refuses a company it doesn't have, and a card that isn't the company's card account", async () => {
    const csv = 'Transaction Date,Description,Amount\n01/03/2027,ACME,-1.00';
    const nope = await post({ action: 'import', importId: NEW_IMPORT, company: 'NOPE', cardId: '900', csv });
    expect(nope.status).toBe(400);
    expect(await nope.json()).toEqual({ error: "There's no company NOPE in Books." });
    for (const cardId of ['901', '909', '610']) {
      const res = await post({ action: 'import', importId: NEW_IMPORT, company: 'BMG', cardId, csv });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "That isn't a card account BMG Fleet can use." });
    }
    expect(state.rpcs).toEqual([]);
  });

  it("codes charges to accounts the company can use, never the card's own", async () => {
    const res = await post({ action: 'code', company: 'BMG', cardId: '900', changes: [{ id: C(1), accountId: '620', memo: 'Brackets' }, { id: C(4), accountId: null }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, coded: 2, held: 0 });
    expect(state.rpcs).toEqual([['card_charges_code', { p: {
      card_account_netsuite_id: '900', by: USER,
      changes: [{ id: C(1), account_netsuite_id: '620', memo: 'Brackets' }, { id: C(4), account_netsuite_id: null, memo: '' }],
    } }]]);

    const own = await post({ action: 'code', company: 'BMG', cardId: '900', changes: [{ id: C(1), accountId: '900' }] });
    expect(own.status).toBe(400);
    expect(await own.json()).toEqual({ error: "A charge can't go to the card's own account." });
    for (const accountId of ['640', '699', '12345']) {
      const res2 = await post({ action: 'code', company: 'BMG', cardId: '900', changes: [{ id: C(1), accountId }] });
      expect(res2.status).toBe(400);
      expect(await res2.json()).toEqual({ error: "A charge goes to an account BMG Fleet can't use. Nothing was saved." });
    }
    expect((await post({ action: 'code', company: 'BMG', cardId: '900', changes: [] })).status).toBe(400);
    expect(state.rpcs).toHaveLength(1);
  });

  it("takes a file's charges back off, all but the ones sent", async () => {
    const res = await post({ action: 'undo', importId: IMPORT_1 });
    expect(await res.json()).toEqual({ success: true, removed: 1 });
    expect(state.tables.card_charges.map((c) => c.id)).toEqual([C(4), C(5), C(6)]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), { actorId: USER, table: 'card_charge_imports', recordId: IMPORT_1, action: 'undo', detail: { removed: 1 } });
  });

  it("sends a month as one journal entry in NetSuite, keeps Books' copy, and answers what an earlier press made", async () => {
    netsuite.findJournalEntry.mockResolvedValueOnce(null).mockResolvedValueOnce({ journalId: '7002', number: 'JE-501' });
    const res = await post(SEND_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, journalId: '7002', number: 'JE-501', count: 3, totalCents: 14760 });
    expect(state.rpcs[0]).toEqual(['card_charges_claim', { p: {
      send_id: SEND, company: 'BMG', card_account_netsuite_id: '900', month: '2027-01-01', max: 250, created_by: USER,
    } }]);
    expect(netsuite.findJournalEntry).toHaveBeenNthCalledWith(1, `fleetsuite-card-${SEND}`);
    expect(netsuite.createJournalEntry).toHaveBeenCalledWith({
      subsidiaryId: '2', tranDate: '2027-01-07', memo: '2100 Company card charges, January 2027, from FleetSuite', externalId: `fleetsuite-card-${SEND}`,
      lines: [
        { accountId: '610', debit: 125.5, memo: m1 }, { accountId: '900', credit: 125.5, memo: m1 },
        { accountId: '610', credit: 20, memo: m2 }, { accountId: '900', debit: 20, memo: m2 },
        { accountId: '620', debit: 42.1, memo: m3 }, { accountId: '900', credit: 42.1, memo: m3 },
      ],
    });
    expect(sendRow()).toMatchObject({
      netsuite_journal_id: '7002', netsuite_number: 'JE-501', charge_count: 3, net_cents: 14760, total_cents: 18760, tran_date: '2027-01-07', error: null,
    });
    expect(state.rpcs[1]).toEqual(['gl_own_journal_entry_save', { p: expect.objectContaining({
      netsuite_id: '7002', company: 'BMG', source: 'card_charges', made_from_id: SEND, netsuite_number: 'JE-501', tran_date: '2027-01-07',
      rule: 'card_charges@1', total: '187.60', made_by: USER,
    }) }]);
    expect(state.rpcs[1][1].p.lines).toHaveLength(6);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: USER, table: 'card_charge_sends', recordId: SEND, action: 'create',
      detail: { netsuite_journal_id: '7002', card: '900', month: '2027-01', charges: 3, net: '$147.60', found_in_netsuite: false },
    });

    claimAs({ state: 'made', netsuite_journal_id: '7002', netsuite_number: 'JE-501', charge_count: 3, total_cents: 18760, net_cents: 14760 });
    const again = await post(SEND_BODY);
    expect(await again.json()).toEqual({ success: true, already: true, journalId: '7002', number: 'JE-501', count: 3, totalCents: 18760 });
    expect(netsuite.createJournalEntry).toHaveBeenCalledTimes(1);
    expect(rpcNames()).toEqual(['card_charges_claim', 'gl_own_journal_entry_save', 'card_charges_claim']);
  });

  it(`sends nothing from before January 2027, the months the bookkeeper's journal entries have`, async () => {
    const res = await post({ ...SEND_BODY, month: '2026-12' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "December 2026 is before January 2027: its card charges are on the bookkeeper's journal entries in NetSuite already. Nothing was sent.",
    });
    expect(state.rpcs).toEqual([]);
  });

  it('says what stops a month: charges with no account, or none to send', async () => {
    claimAs({ state: 'uncoded', uncoded: 2 });
    const two = await post(SEND_BODY);
    expect(two.status).toBe(409);
    expect(await two.json()).toEqual({ error: '2 charges in January 2027 have no account yet. Code them, then send. Nothing was sent.' });
    claimAs({ state: 'uncoded', uncoded: 1 });
    expect(await (await post(SEND_BODY)).json()).toEqual({ error: 'One charge in January 2027 has no account yet. Code it, then send. Nothing was sent.' });
    claimAs({ state: 'nothing' });
    const none = await post(SEND_BODY);
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'January 2027 has no charges to send.' });
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
  });

  it('lets go of the charges when they changed under the page, or no longer make a journal entry', async () => {
    const changed = await post({ ...SEND_BODY, expectedTotalCents: 16760 });
    expect(changed.status).toBe(409);
    const why = 'January 2027 now has 3 charges for $147.60, not what the page showed.';
    expect(await changed.json()).toEqual({ error: `${why} Nothing was sent. Reload and check them.` });
    expect(state.rpcs[1]).toEqual(['card_charges_let_go', { p: { send_id: SEND, error: why } }]);
    expect(sendRow()).toMatchObject({ claimed_at: null, error: why });

    for (const over of [{ expectedCount: 2 }, { expectedCount: undefined }, { expectedTotalCents: undefined }]) {
      expect((await post({ ...SEND_BODY, sendId: 'b0000000-0000-4000-8000-000000000002', ...over })).status).toBe(409);
    }

    claimAs({ state: 'claimed', charges: [CLAIMED[0], { ...CLAIMED[1], account_netsuite_id: '640' }] });
    const stale = await post({ ...SEND_BODY, expectedCount: 2, expectedTotalCents: 10550 });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({ error: "The charge from ACME HARDWARE #5678 on Jan 7 goes to an account BMG Fleet can't use. Nothing was sent." });
    expect(netsuite.findJournalEntry).not.toHaveBeenCalled();
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
  });

  it("won't send twice while a press is being made, and asks NetSuite what became of one left a while", async () => {
    claimAs({ state: 'making', claimed_at: new Date().toISOString(), charges: CLAIMED });
    const fresh = await post(SEND_BODY);
    expect(fresh.status).toBe(409);
    expect(await fresh.json()).toEqual({ error: "January 2027's charges are being sent now. Don't press again: reload in a minute to see them." });
    expect(netsuite.findJournalEntry).not.toHaveBeenCalled();

    state.tables.card_charge_sends.push({ id: SEND, card_account_netsuite_id: '900', claimed_at: '2027-01-31T10:00:00Z' });
    claimAs({ state: 'making', claimed_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(), charges: CLAIMED });
    netsuite.findJournalEntry.mockResolvedValueOnce({ journalId: '7003', number: 'JE-502' });
    const found = await post(SEND_BODY);
    expect(await found.json()).toEqual({ success: true, already: true, journalId: '7003', number: 'JE-502', count: 3, totalCents: 14760 });
    expect(sendRow()).toMatchObject({ netsuite_journal_id: '7003', netsuite_number: 'JE-502', charge_count: 3 });
    expect(rpcNames()).toEqual(['card_charges_claim', 'card_charges_claim', 'gl_own_journal_entry_save']);

    netsuite.findJournalEntry.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503): busy'));
    const unasked = await post(SEND_BODY);
    expect(unasked.status).toBe(502);
    expect(await unasked.json()).toEqual({ error: "Couldn't ask NetSuite what became of this send (NetSuite SuiteQL error (503): busy). Try again." });

    sendRow()!.netsuite_journal_id = null;
    const gone = await post(SEND_BODY);
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({ error: 'NetSuite has no journal entry from this send, so its charges are back to send again.' });
    expect(state.rpcs.at(-1)).toEqual(['card_charges_let_go', { p: { send_id: SEND, error: 'NetSuite has no journal entry from this send, so its charges are back to send again.' } }]);
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
  });

  it("makes none when NetSuite has the press's journal entry already, or can't say whether it has", async () => {
    netsuite.findJournalEntry.mockResolvedValueOnce({ journalId: '7004', number: '' });
    const there = await post(SEND_BODY);
    expect(await there.json()).toEqual({ success: true, already: true, journalId: '7004', number: null, count: 3, totalCents: 14760 });

    netsuite.findJournalEntry.mockRejectedValueOnce(new Error('timed out'));
    const unsure = await post({ ...SEND_BODY, sendId: 'b0000000-0000-4000-8000-000000000002' });
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({ error: "Couldn't check NetSuite for this send (timed out). Nothing was sent. Try again." });
    expect(state.rpcs.at(-1)).toEqual(['card_charges_let_go', { p: { send_id: 'b0000000-0000-4000-8000-000000000002', error: "Couldn't check NetSuite for this send (timed out)." } }]);
    expect(netsuite.createJournalEntry).not.toHaveBeenCalled();
  });

  it("lets go when NetSuite refuses it, and keeps the charges held when it can't tell whether it made it", async () => {
    netsuite.createJournalEntry.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): The period is closed.' });
    const refused = await post(SEND_BODY);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: 'NetSuite error (400): The period is closed.' });
    expect(sendRow()).toMatchObject({ claimed_at: null, error: 'NetSuite error (400): The period is closed.' });
    expect(rpcNames()).toEqual(['card_charges_claim', 'card_charges_let_go']);

    state.tables.card_charge_sends = [];
    state.rpcs.length = 0;
    netsuite.createJournalEntry.mockResolvedValueOnce({ success: false, error: 'NetSuite error (503): Server busy', unsure: true });
    const unsure = await post(SEND_BODY);
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({
      error: "NetSuite error (503): Server busy FleetSuite can't tell whether NetSuite made it, so the charges stay held. Press Send again in a few minutes and FleetSuite will ask NetSuite.",
      unsure: true,
    });
    expect(sendRow()).toMatchObject({ error: 'NetSuite error (503): Server busy' });
    expect(sendRow()!.claimed_at).toEqual(expect.any(String));
    expect(rpcNames()).toEqual(['card_charges_claim']);
  });

  it("says when Books couldn't keep its copy, and still answers that the journal entry is made", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.answers.gl_own_journal_entry_save = () => ({ data: null, error: { message: "gl: own journal entry 7002's debits and credits don't match its total" } });
    const res = await post(SEND_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, journalId: '7002', number: null, count: 3, totalCents: 14760,
      warning: "Books didn't keep its copy (gl: own journal entry 7002's debits and credits don't match its total). The journal entry is in NetSuite.",
    });
    expect(sendRow()).toMatchObject({ netsuite_journal_id: '7002' });

    // A copy saved already is no warning.
    state.answers.gl_own_journal_entry_save = () => ({ data: { saved: false, lines: 0 }, error: null });
    expect(await (await post({ ...SEND_BODY, sendId: 'b0000000-0000-4000-8000-000000000002' })).json())
      .toEqual({ success: true, journalId: '7002', number: null, count: 3, totalCents: 14760 });
  });

  it("refuses a body that names things that aren't ids or months", async () => {
    for (const over of [{ sendId: 'press-1' }, { cardId: 'card' }, { month: '2027-13' }, { month: '2027-1' }, { expectedCount: 0 }, { expectedCount: 251 }]) {
      expect((await post({ ...SEND_BODY, ...over })).status).toBe(400);
    }
    expect((await post({ action: 'import', importId: NEW_IMPORT, company: 'BMG', cardId: '900', csv: '' })).status).toBe(400);
    expect((await post({ action: 'pay', company: 'BMG' })).status).toBe(400);
    expect(state.rpcs).toEqual([]);
  });
});
