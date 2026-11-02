// /api/inventory/counts (src/lib/stock-counts.ts, Books part 69): who can open
// Counts while they're switched off and once they're on, what each way of
// choosing items puts on a count (everything on hand a part at a time, a
// search, items picked), leaving off what another open count has, what saving
// keeps (each count with NetSuite's live count as it's saved), and how Approve
// posts a count's differences once, as one NetSuite adjustment: only by a
// super admin who didn't ask, never taking NetSuite below 0, let go when
// NetSuite refuses and held when it can't tell. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const JESSIE = 'd0000000-0000-4000-8000-000000000001';
const BOSS = 'd0000000-0000-4000-8000-000000000002';
const CRAIG = 'd0000000-0000-4000-8000-000000000003';
const NAMES: Record<string, string | null> = { [JESSIE]: 'Jessie Test', [BOSS]: 'Bo Boss', [CRAIG]: null };

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    userId: '',
    roles: [] as string[],
    name: null as string | null,
    admin: true,
    seeMoney: true,
    tables: {} as Record<string, Record<string, any>[]>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    answers: {} as Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }>,
    /** NetSuite's live count of each item, by location. */
    live: {} as Record<string, Record<string, number>>,
  };
  const netsuite = {
    createCountAdjustment: vi.fn(),
    findCountAdjustment: vi.fn(),
    getInventoryAdjustmentAccountId: vi.fn(),
    getLocationOnHand: vi.fn(),
  };

  // An in-memory stand-in for the tables the route reads.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    const orders: Array<[string, boolean]> = [];
    let limit = Infinity;
    let range: [number, number] | null = null;
    const run = () => {
      const matched = (state.tables[table] ??= []).filter((r) => filters.every((f) => f(r)));
      matched.sort((a, b) => {
        for (const [c, up] of orders) {
          const x = a[c];
          const y = b[c];
          if (x === y) continue;
          if (x == null) return 1;
          if (y == null) return -1;
          const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : 1;
          return up ? d : -d;
        }
        return 0;
      });
      const kept = range ? matched.slice(range[0], range[1] + 1) : matched.slice(0, limit);
      return { data: kept.map((r) => ({ ...r })), error: null };
    };
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      // Only the parts search's col.imatch."pattern",…, Postgres's [:alnum:] read as JavaScript's.
      or: (expr: string) => {
        const parts = expr.split(',').map((p) => {
          const [, col, re] = p.match(/^(\w+)\.imatch\."(.*)"$/)!;
          return [col, new RegExp(re.replace(/\[:alnum:\]/g, 'a-zA-Z0-9'), 'i')] as const;
        });
        filters.push((r) => parts.some(([col, re]) => re.test(String(r[col] ?? ''))));
        return builder;
      },
      not: (c: string, op: string, v: unknown) => { expect(op).toBe('is'); expect(v).toBeNull(); filters.push((r) => r[c] != null); return builder; },
      order: (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      range: (from: number, to: number) => { range = [from, to]; return builder; },
      maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, args]);
      const answer = state.answers[fn];
      return answer ? answer(args.p ?? args) : { data: null, error: { message: `nothing answers ${fn}` } };
    },
  };

  const companies = [
    { id: 'g1', code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }, { id: '7', name: 'Service van' }] },
    // O'Fallon again, as two companies can list one location: it's counted once, as the first company's.
    {
      id: 'g2', code: '1084', name: '1084 Cool Springs', subsidiaryId: null as string | null,
      locations: [{ id: '20', name: 'Cool Springs' }, { id: '21', name: 'Back lot' }, { id: '1', name: "O'Fallon" }],
    },
  ];
  return { state, netsuite, service, companies };
});

// Inventory Adjust's wall: admins, and Jessie is one.
vi.mock('@/lib/api-auth', () => ({
  requireAdmin: vi.fn(async () => (h.state.admin
    ? { user: { id: h.state.userId }, profile: { roles: h.state.roles, full_name: h.state.name } }
    : { user: { id: h.state.userId }, profile: { roles: h.state.roles }, error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
  profileCanSeeMoney: vi.fn(async () => h.state.seeMoney),
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/books/snap-a-bill', () => ({ readCompanies: vi.fn(async () => h.companies) }));

const { state, netsuite } = h;

import { logAudit } from '@/lib/audit';
import { GET, POST } from '../app/api/inventory/counts/route';
import { NOT_NOW_TEXT, STALE_MS } from './stock-counts';

const C = (n: number) => `c0000000-0000-4000-8000-00000000000${n}`;
const DONE = C(1);
const OTHER = C(2);
const COUNTING = C(4);
const ASKED = C(5);
const NEW = C(6);
const NEXT = C(7);
const NONE = C(9);

const NOW = '2027-09-15T15:00:00.000Z';
const OFF = 'Counts are switched off until they start in the third quarter of 2027.';

const countRow = (id: string, over: Record<string, unknown> = {}): Record<string, any> => ({
  id, number: 0, location_id: '1', location_name: "O'Fallon", what: 'Everything NetSuite has on hand', count_date: '2027-09-15',
  status: 'counting', started_by: JESSIE, started_by_name: 'Jessie Test', started_at: '2027-09-15T13:00:00+00:00',
  asked_by: null, asked_by_name: null, asked_at: null, sent_by_name: null, sent_at: null, decided_by_name: null, decided_at: null,
  turned_down_by_name: null, turned_down_at: null, why: null, netsuite_adjustment_id: null, netsuite_adjustment_number: null, error: '',
  updated_at: '2027-09-15T13:00:00+00:00', ...over,
});
type ItemFacts = [id: string, number: string, name: string | null];
const lineRow = (countId: string, locationId: string, position: number, [id, number, name]: ItemFacts, over: Record<string, unknown> = {}) => ({
  count_id: countId, location_id: locationId, is_open: true, position, netsuite_item_id: id, item_number: number, display_name: name,
  on_hand_start: 9, counted: null, on_hand_then: null, counted_by_name: null, counted_at: null, ...over,
});
const HITCH: ItemFacts = ['812', 'HITCH-2', 'Hitch, 2 in.'];
const BALL: ItemFacts = ['813', 'BALL-2', 'Ball, 2 in.'];
const BIG: ItemFacts = ['816', 'HITCH-10', 'Hitch, 10k'];

const get = (query = '') => GET(new NextRequest(`https://app.test/api/inventory/counts${query ? `?${query}` : ''}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/inventory/counts', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const as = (userId: string, roles: string[]) => { state.userId = userId; state.roles = roles; state.name = NAMES[userId] ?? null; };
const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'stock_counts', is_on: on }, { piece: 'adjustment_approvals', is_on: !on }]; };
const rpcNames = () => state.rpcs.map(([fn]) => fn);
const argsOf = (fn: string) => state.rpcs.filter(([f]) => f === fn).map(([, a]) => a.p ?? a);
const rowOf = (id: string) => state.tables.stock_counts.find((r) => r.id === id)!;
const ok = (data: unknown) => ({ data, error: null });
const failed = (message: string) => ({ data: null, error: { message } });
const audited = () => (logAudit as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([, entry]) => entry);

/** The functions migration 499 adds, as the route counts on them answering. */
function answers() {
  const counts = () => state.tables.stock_counts;
  const find = (id: string) => counts().find((r) => r.id === id);
  const lines = () => state.tables.stock_count_lines;
  const notNow = (r: Record<string, any>) => ok({ state: 'not_now', status: r.status, count: { ...r } });
  state.answers = {
    stock_count_start: (p) => {
      const was = find(p.id);
      if (was) return ok({ state: 'same', count: { ...was } });
      const open = new Map(lines().filter((l) => l.location_id === p.location_id && l.is_open).map((l) => [l.netsuite_item_id, l]));
      const taken = p.lines.filter((l: any) => open.has(l.netsuite_item_id))
        .map((l: any) => ({ netsuite_item_id: l.netsuite_item_id, item_number: l.item_number, number: find(open.get(l.netsuite_item_id)!.count_id)!.number }));
      if (taken.length) return ok({ state: 'on_another', taken });
      const row = countRow(p.id, {
        number: Math.max(...counts().map((c) => c.number)) + 1, location_id: p.location_id, location_name: p.location_name, what: p.what,
        count_date: p.count_date, started_by: p.by, started_by_name: p.by_name, started_at: NOW, updated_at: NOW,
      });
      counts().push(row);
      p.lines.forEach((l: any, i: number) => lines().push(lineRow(p.id, p.location_id, i + 1, [l.netsuite_item_id, l.item_number, l.display_name], {
        on_hand_start: l.on_hand_start,
      })));
      return ok({ state: 'started', count: { ...row } });
    },
    stock_count_add: (p) => ok({ state: 'added', added: p.lines.length }),
    stock_count_save: (p) => ok({ state: 'saved', saved: p.lines.length }),
    stock_count_ask: (p) => {
      const r = find(p.id);
      if (!r) return ok({ state: 'gone' });
      if (r.status !== 'counting') return notNow(r);
      Object.assign(r, { status: 'asked', asked_by: p.by, asked_by_name: p.by_name, asked_at: NOW });
      return ok({ state: 'asked', count: { ...r } });
    },
    stock_count_finish: (p) => {
      const r = find(p.id)!;
      if (r.status !== 'counting') return notNow(r);
      Object.assign(r, { status: 'made', decided_by_name: p.by_name, decided_at: NOW });
      return ok({ state: 'finished', count: { ...r } });
    },
    stock_count_cancel: (p) => {
      const r = find(p.id)!;
      if (r.status !== 'counting') return notNow(r);
      Object.assign(r, { status: 'cancelled' });
      return ok({ state: 'cancelled', count: { ...r } });
    },
    stock_count_withdraw: (p) => {
      const r = find(p.id)!;
      if (r.status !== 'asked') return notNow(r);
      if (r.asked_by !== p.by) return ok({ state: 'not_yours' });
      Object.assign(r, { status: 'counting', asked_by: null, asked_by_name: null, asked_at: null });
      return ok({ state: 'withdrawn', count: { ...r } });
    },
    stock_count_turn_down: (p) => {
      const r = find(p.id)!;
      if (r.status !== 'asked') return notNow(r);
      if (r.asked_by === p.by) return ok({ state: 'own' });
      Object.assign(r, { status: 'counting', turned_down_by_name: p.by_name, turned_down_at: NOW, why: p.why });
      return ok({ state: 'turned_down', count: { ...r } });
    },
    stock_count_claim: (p) => {
      const r = find(p.id);
      if (!r) return ok({ state: 'gone' });
      if (r.status !== 'asked') return notNow(r);
      if (r.asked_by === p.by) return ok({ state: 'own' });
      Object.assign(r, { status: 'sending', sent_by_name: p.by_name, sent_at: NOW });
      // Each difference, as Postgres hands back a numeric.
      const changes = lines().filter((l) => l.count_id === p.id && l.counted !== null && l.counted !== l.on_hand_then)
        .map((l) => ({ netsuite_item_id: l.netsuite_item_id, item_number: l.item_number, change: String(l.counted - l.on_hand_then) }));
      return ok({ state: 'claimed', count: { ...r }, changes });
    },
    stock_count_let_go: (p) => {
      const r = find(p.id);
      if (!r || !['sending', 'unsure'].includes(r.status)) return ok({ let_go: false });
      Object.assign(r, { status: 'asked', sent_by_name: null, sent_at: null, error: p.error });
      return ok({ let_go: true });
    },
    stock_count_unsure: (p) => {
      const r = find(p.id);
      if (!r || r.status !== 'sending') return ok({ unsure: false });
      Object.assign(r, { status: 'unsure', error: p.error });
      return ok({ unsure: true });
    },
    stock_count_made: (p) => {
      const r = find(p.id);
      if (!r || !['sending', 'unsure'].includes(r.status)) return ok({ made: false });
      Object.assign(r, { status: 'made', netsuite_adjustment_id: p.netsuite_adjustment_id, netsuite_adjustment_number: p.netsuite_number });
      return ok({ made: true });
    },
    stock_count_blocked: () => ok([]),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  as(JESSIE, ['admin']);
  state.admin = true;
  state.seeMoney = true;
  state.tables = {
    stock_counts: [
      countRow(DONE, { number: 1, status: 'made', netsuite_adjustment_id: '7001', netsuite_adjustment_number: 'ADJ-40', updated_at: '2027-09-01T15:00:00+00:00' }),
      countRow(OTHER, { number: 2, started_by: BOSS, started_by_name: 'Bo Boss', what: 'Items matching “ball”' }),
      countRow(COUNTING, { number: 4, location_id: '20', location_name: 'Cool Springs', what: '2 items picked' }),
      countRow(ASKED, {
        number: 5, location_id: '7', location_name: 'Service van', status: 'asked', asked_by: JESSIE, asked_by_name: 'Jessie Test',
        asked_at: '2027-09-15T14:30:00+00:00',
      }),
    ],
    stock_count_lines: [
      lineRow(DONE, '1', 1, HITCH, { is_open: false, counted: 9, on_hand_then: 9 }),
      lineRow(OTHER, '1', 1, BALL, { on_hand_start: 4 }),
      lineRow(COUNTING, '20', 1, HITCH, { on_hand_start: 1 }),
      lineRow(COUNTING, '20', 2, BIG, { on_hand_start: 0, counted: 3, on_hand_then: 0, counted_by_name: 'Jessie Test' }),
      lineRow(ASKED, '7', 1, HITCH, { counted: 7, on_hand_then: 9, counted_by_name: 'Jessie Test', counted_at: '2027-09-15T14:00:00+00:00' }),
      lineRow(ASKED, '7', 2, BIG, { on_hand_start: 2, counted: 3.5, on_hand_then: 2, counted_by_name: 'Jessie Test', counted_at: '2027-09-15T14:01:00+00:00' }),
    ],
    netsuite_parts: [
      // An old row under HITCH-2's NetSuite id, listed first: the active one names it.
      { id: 'p0', netsuite_id: '812', item_number: 'HITCH-2-OLD', display_name: null, description: null, item_type: 'InvtPart', is_active: false },
      { id: 'p1', netsuite_id: '812', item_number: 'HITCH-2', display_name: 'Hitch, 2 in.', description: 'Receiver hitch', item_type: 'InvtPart', is_active: true },
      { id: 'p2', netsuite_id: '813', item_number: 'BALL-2', display_name: 'Ball, 2 in.', description: null, item_type: 'InvtPart', is_active: true },
      { id: 'p3', netsuite_id: '814', item_number: 'PIN-58', display_name: 'Pin, 5/8 in.', description: null, item_type: 'InvtPart', is_active: true },
      { id: 'p4', netsuite_id: '815', item_number: 'HITCH-LABOR', display_name: 'Hitch install', description: null, item_type: 'Service', is_active: true },
      { id: 'p5', netsuite_id: '816', item_number: 'HITCH-10', display_name: 'Hitch, 10k', description: null, item_type: null, is_active: true },
      { id: 'p6', netsuite_id: null, item_number: 'HITCH-LOCAL', display_name: 'Not in NetSuite', description: null, item_type: null, is_active: true },
    ],
    // An item NetSuite has that the parts list doesn't.
    gl_netsuite_lists: [{ kind: 'item', netsuite_id: '820', name: ' WIRE-14 ', details: { display_name: '14 ga wire' } }],
    gl_netsuite_stock_counts: [
      { item_id: '812', location_id: '1', quantity: 9, value: 112.5, read_at: '2027-09-15T12:43:00Z' },
      { item_id: '813', location_id: '1', quantity: 4, value: 50, read_at: '2027-09-15T12:43:00Z' },
      { item_id: '814', location_id: '1', quantity: 0, value: 0, read_at: '2027-09-15T12:43:00Z' },
      { item_id: '815', location_id: '1', quantity: 1, value: null, read_at: '2027-09-15T12:43:00Z' },
      { item_id: '816', location_id: '1', quantity: 2, value: 30, read_at: '2027-09-15T12:43:00Z' },
      { item_id: '820', location_id: '1', quantity: 3, value: 9, read_at: '2027-09-15T12:43:05Z' },
      { item_id: '812', location_id: '7', quantity: 9, value: 112.5, read_at: '2027-09-15T12:43:00Z' },
      { item_id: '816', location_id: '7', quantity: 2, value: 30, read_at: '2027-09-15T12:43:00Z' },
      { item_id: '812', location_id: '20', quantity: 1, value: 12.5, read_at: '2027-09-15T12:43:00Z' },
    ],
  };
  state.live = { 1: { 812: 9, 813: 4, 816: 2.25, 820: 3 }, 7: { 812: 9, 816: 2 }, 20: { 812: 1.00004, 816: 0 } };
  switchOn(false);
  state.rpcs.length = 0;
  answers();
  vi.clearAllMocks();
  // A test that stops early leaves answers queued; the next starts with none.
  for (const fn of Object.values(netsuite)) fn.mockReset();
  netsuite.getLocationOnHand.mockImplementation(async (location: string, ids: string[]) => {
    const live = state.live[location] ?? {};
    return new Map(ids.filter((id) => id in live).map((id) => [id, live[id]]));
  });
  netsuite.findCountAdjustment.mockResolvedValue(null);
  netsuite.getInventoryAdjustmentAccountId.mockResolvedValue('501');
  netsuite.createCountAdjustment.mockResolvedValue({ success: true, adjustmentId: '7003' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('while counts are switched off', () => {
  it('shows Counts to super admins only, with how many are open, and nobody who is not an admin', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false, open: 0 });
    as(BOSS, ['super_admin']);
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true, open: 3 });
    state.admin = false;
    expect((await get('status=1')).status).toBe(403);
    expect((await get('')).status).toBe(403);
  });

  it('keeps other admins out, and lets a super admin see the locations and the counts, open and done', async () => {
    state.tables.stock_counts.push(countRow(C(3), {
      number: 3, status: 'cancelled', decided_by_name: 'Bo Boss', decided_at: '2027-09-10T15:00:00+00:00', updated_at: '2027-09-10T15:00:00+00:00',
    }));
    const refused = await get('');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: OFF, switchedOff: true });
    expect((await post({ action: 'start', id: NEW, locationId: '1', kind: 'all' })).status).toBe(403);
    expect((await get(`id=${ASKED}`)).status).toBe(403);
    expect(rpcNames()).toEqual([]);

    as(BOSS, ['super_admin']);
    const body = await (await get('')).json();
    expect(body).toMatchObject({
      locations: [{ id: '21', name: 'Back lot' }, { id: '20', name: 'Cool Springs' }, { id: '1', name: "O'Fallon" }, { id: '7', name: 'Service van' }],
      defaultLocationId: '1',
      today: '2027-09-15',
      me: BOSS,
      superAdmin: true,
      switchedOn: false,
      offText: `${OFF} You can count and ask for approval to see what a count would post; nothing goes to NetSuite.`,
    });
    expect(body.open.map((c: any) => [c.label, c.status, c.progress])).toEqual([
      ['CNT-0002', 'counting', { items: 1, counted: 0 }],
      ['CNT-0004', 'counting', { items: 2, counted: 1 }],
      ['CNT-0005', 'asked', { items: 2, counted: 2 }],
    ]);
    expect(body.done.map((c: any) => [c.label, c.status, c.netsuiteNumber])).toEqual([['CNT-0003', 'cancelled', null], ['CNT-0001', 'made', 'ADJ-40']]);
  });

  it("starts at NetSuite's default location when it's one of Books', then O'Fallon", async () => {
    as(BOSS, ['super_admin']);
    vi.stubEnv('NETSUITE_DEFAULT_LOCATION_ID', '7');
    expect((await (await get('')).json()).defaultLocationId).toBe('7');
    vi.stubEnv('NETSUITE_DEFAULT_LOCATION_ID', '99');
    expect((await (await get('')).json()).defaultLocationId).toBe('1');
  });

  it("lets a super admin count and ask, to see what it would post, and posts nothing, even for them", async () => {
    as(BOSS, ['super_admin']);
    expect((await post({ action: 'start', id: NEW, locationId: '1', kind: 'all' })).status).toBe(200);
    expect((await post({ action: 'save', id: NEW, lines: [{ itemId: '812', counted: 8 }] })).status).toBe(200);
    as(CRAIG, ['super_admin']);
    const refused = await post({ action: 'approve', id: ASKED });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: `${OFF} Nothing was posted in NetSuite.`, switchedOff: true });
    expect(rowOf(ASKED).status).toBe('asked');
    expect(rpcNames()).toEqual(['stock_count_start', 'stock_count_save']);
    expect(netsuite.findCountAdjustment).not.toHaveBeenCalled();
    expect(netsuite.createCountAdjustment).not.toHaveBeenCalled();
  });
});

describe('once counts are switched on', () => {
  beforeEach(() => switchOn(true));

  it('lets admins use them', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true, open: 3 });
    const body = await (await get('')).json();
    expect(body).toMatchObject({ me: JESSIE, superAdmin: false, switchedOn: true, offText: null });
    expect(body.open).toHaveLength(3);
  });

  describe('choosing what to count', () => {
    it("previews everything on hand at a location, leaving off what another count has, without asking NetSuite", async () => {
      const res = await get('preview=1&location=1&kind=all');
      expect(res.status).toBe(200);
      // 814 has none on hand, and 815 is a service NetSuite keeps no stock of.
      expect(await res.json()).toEqual({
        items: 3, more: 0, matched: 4, what: 'Everything NetSuite has on hand, HITCH-2 to WIRE-14', first: 'HITCH-2', last: 'WIRE-14',
        leftOff: 1, leftOffText: 'BALL-2 is on CNT-0002.', readAt: '2027-09-15T12:43:05Z',
      });
      expect(netsuite.getLocationOnHand).not.toHaveBeenCalled();
    });

    it("previews a search of the parts list, and says what it can't count", async () => {
      expect(await (await get('preview=1&location=1&kind=search&q=hitch')).json()).toEqual({
        items: 2, more: 0, matched: 2, what: 'Items matching “hitch”', first: 'HITCH-2', last: 'HITCH-10', leftOff: 0, leftOffText: null, readAt: null,
      });
      const cases: Array<[string, number, string]> = [
        ['preview=1&location=99&kind=all', 400, "Pick one of Books' locations."],
        ['preview=1&location=21&kind=all', 400, 'NetSuite has nothing on hand at Back lot, as Books last read it.'],
        ['preview=1&location=7&kind=all', 409, 'Every one of them is on another open count already. HITCH-2, HITCH-10 are on CNT-0005.'],
        ['preview=1&location=1&kind=search&q=h', 400, 'Type at least two letters or numbers to search for.'],
        ['preview=1&location=1&kind=search&q=zzz', 400, 'No item FleetSuite keeps stock of matches “zzz”.'],
      ];
      for (const [q, status, error] of cases) {
        const res = await get(q);
        expect([q, res.status, await res.json()]).toEqual([q, status, { error }]);
      }
    });

    it('won\'t count a search that matches more than one count takes', async () => {
      const part = (n: number, prefix: string, type: string) => ({
        id: `${prefix}${n}`, netsuite_id: String(20000 + n + (prefix === 'l' ? 5000 : 0)), item_number: `${prefix === 'l' ? 'LABOR' : 'BULK'}-${n}`,
        display_name: null, description: null, item_type: type, is_active: true,
      });
      // 501 items NetSuite keeps stock of, and 1,000 services: too many rows to say how many of them it keeps stock of.
      state.tables.netsuite_parts.push(...Array.from({ length: 501 }, (_, i) => part(i + 1, 'b', 'InvtPart')));
      state.tables.netsuite_parts.push(...Array.from({ length: 1000 }, (_, i) => part(i + 1, 'l', 'Service')));
      for (const q of ['bulk', 'labor']) {
        const res = await get(`preview=1&location=1&kind=search&q=${q}`);
        expect([q, res.status, await res.json()]).toEqual([q, 400, {
          error: `More than 500 items match “${q}”. Narrow the search, or count everything on hand a part at a time.`,
        }]);
      }
    });

    it('finds items to pick, only ones NetSuite keeps stock of', async () => {
      expect(await (await get('q=hitch')).json()).toEqual({
        items: [
          { netsuiteItemId: '816', itemNumber: 'HITCH-10', displayName: 'Hitch, 10k' },
          { netsuiteItemId: '812', itemNumber: 'HITCH-2', displayName: 'Hitch, 2 in.' },
        ],
      });
      expect(await (await get('q=h')).json()).toEqual({ items: [] });
    });
  });

  describe('starting a count', () => {
    it("starts one of everything on hand, each item with NetSuite's live count, and a press sent twice starts one", async () => {
      const res = await post({ action: 'start', id: NEW, locationId: '1', kind: 'all' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        count: expect.objectContaining({
          id: NEW, label: 'CNT-0006', status: 'counting', locationId: '1', locationName: "O'Fallon", countDate: '2027-09-15',
          what: 'Everything NetSuite has on hand, HITCH-2 to WIRE-14', startedBy: JESSIE, startedByName: 'Jessie Test',
        }),
        more: 0, leftOff: 1, leftOffText: 'BALL-2 is on CNT-0002.',
      });
      expect(netsuite.getLocationOnHand).toHaveBeenCalledWith('1', ['812', '816', '820']);
      expect(argsOf('stock_count_start')).toEqual([{
        id: NEW, by: JESSIE, by_name: 'Jessie Test', location_id: '1', location_name: "O'Fallon",
        what: 'Everything NetSuite has on hand, HITCH-2 to WIRE-14', count_date: '2027-09-15',
        lines: [
          { netsuite_item_id: '812', part_id: 'p1', item_number: 'HITCH-2', display_name: 'Hitch, 2 in.', on_hand_start: 9 },
          { netsuite_item_id: '816', part_id: 'p5', item_number: 'HITCH-10', display_name: 'Hitch, 10k', on_hand_start: 2.25 },
          { netsuite_item_id: '820', part_id: null, item_number: 'WIRE-14', display_name: '14 ga wire', on_hand_start: 3 },
        ],
      }]);
      expect(audited()).toEqual([{
        actorId: JESSIE, table: 'stock_counts', recordId: NEW, action: 'start',
        detail: { count: 'CNT-0006', location: "O'Fallon", what: 'Everything NetSuite has on hand, HITCH-2 to WIRE-14', items: 3 },
      }]);

      const again = await post({ action: 'start', id: NEW, locationId: '1', kind: 'all' });
      expect(await again.json()).toEqual({ count: expect.objectContaining({ id: NEW, label: 'CNT-0006' }), same: true });
      expect(argsOf('stock_count_start')).toHaveLength(1);
      expect(audited()).toHaveLength(1);
    });

    it('counts everything on hand 500 at a time, in shelf order, the next count taking the rest', async () => {
      const bulk = Array.from({ length: 505 }, (_, i) => ({
        id: `b${i}`, netsuite_id: String(9001 + i), item_number: `BULK-${i + 1}`, display_name: null, description: null, item_type: 'InvtPart', is_active: true,
      }));
      state.tables.netsuite_parts.push(...[...bulk].reverse());
      state.tables.gl_netsuite_stock_counts.push(...bulk.map((b) => ({ item_id: b.netsuite_id, location_id: '20', quantity: 2, value: 4, read_at: NOW })));

      const first = await (await post({ action: 'start', id: NEW, locationId: '20', kind: 'all' })).json();
      expect(first).toMatchObject({ count: { what: 'Everything NetSuite has on hand, BULK-1 to BULK-500' }, more: 5, leftOff: 1, leftOffText: 'HITCH-2 is on CNT-0004.' });
      const lines = argsOf('stock_count_start')[0].lines;
      expect(lines).toHaveLength(500);
      expect([lines[0].item_number, lines[1].item_number, lines[9].item_number, lines[499].item_number]).toEqual(['BULK-1', 'BULK-2', 'BULK-10', 'BULK-500']);
      // One read of NetSuite's live counts for the lot.
      expect(netsuite.getLocationOnHand).toHaveBeenCalledTimes(1);

      const rest = await (await post({ action: 'start', id: NEXT, locationId: '20', kind: 'all' })).json();
      expect(rest).toMatchObject({
        count: { label: 'CNT-0007', what: 'Everything NetSuite has on hand, BULK-501 to BULK-505' },
        more: 0, leftOff: 501, leftOffText: 'HITCH-2 is on CNT-0004. BULK-1, BULK-2, BULK-3, BULK-4, BULK-5 and 495 more are on CNT-0006.',
      });
      expect(argsOf('stock_count_start')[1].lines.map((l: any) => l.item_number)).toEqual(['BULK-501', 'BULK-502', 'BULK-503', 'BULK-504', 'BULK-505']);
    });

    it('starts a count of a search, or of items picked, even ones only NetSuite names', async () => {
      const searched = await (await post({ action: 'start', id: NEW, locationId: '1', kind: 'search', q: '  hitch ', countDate: '2027-09-15' })).json();
      expect(searched.count).toMatchObject({ what: 'Items matching “hitch”', countDate: '2027-09-15' });
      expect(argsOf('stock_count_start')[0].lines.map((l: any) => l.item_number)).toEqual(['HITCH-2', 'HITCH-10']);

      const picked = await (await post({ action: 'start', id: NEXT, locationId: '7', kind: 'picked', itemIds: ['820', '820'], countDate: '2027-09-14' })).json();
      expect(picked.count).toMatchObject({ what: '1 item picked', countDate: '2027-09-14' });
      // NetSuite has none of it in the van.
      expect(argsOf('stock_count_start')[1]).toMatchObject({
        count_date: '2027-09-14', lines: [{ netsuite_item_id: '820', part_id: null, item_number: 'WIRE-14', display_name: '14 ga wire', on_hand_start: 0 }],
      });
    });

    it("says why it can't start one, and starts nothing", async () => {
      // NetSuite's list has 821 with no name.
      state.tables.gl_netsuite_lists.push({ kind: 'item', netsuite_id: '821', name: '  ', details: null });
      const cases: Array<[Record<string, unknown>, number, string]> = [
        [{ locationId: '99', kind: 'all' }, 400, "There's no location 99 in Books."],
        [{ locationId: '1', kind: 'picked', itemIds: [] }, 400, 'Pick an item to count.'],
        [{ locationId: '1', kind: 'picked', itemIds: ['999'] }, 400, "FleetSuite's parts list has no item 999."],
        [{ locationId: '1', kind: 'picked', itemIds: ['821'] }, 400, "FleetSuite's parts list has no item 821."],
        [{ locationId: '1', kind: 'picked', itemIds: ['815', '812'] }, 400, "HITCH-LABOR isn't an item NetSuite keeps stock of."],
        [{ locationId: '1', kind: 'picked', itemIds: ['813'] }, 409, 'Every one of them is on another open count already. BALL-2 is on CNT-0002.'],
        [{ locationId: '1', kind: 'all', countDate: '2027-09-16' }, 400, "A count can't be dated after today."],
        [{ locationId: '1', kind: 'all', countDate: '2027-02-30' }, 400, "2027-02-30 isn't a day on the calendar."],
      ];
      for (const [body, status, error] of cases) {
        const res = await post({ action: 'start', id: NEW, ...body });
        expect([body, res.status, await res.json()]).toEqual([body, status, { error }]);
      }
      expect((await post({ action: 'start', id: 'not-an-id', locationId: '1', kind: 'all' })).status).toBe(400);
      expect((await post({ action: 'start', id: NEW, locationId: '1', kind: 'everything' })).status).toBe(400);
      expect(rpcNames()).toEqual([]);
      expect(netsuite.getLocationOnHand).not.toHaveBeenCalled();
    });

    it("starts nothing when NetSuite's live count can't be read or another count took an item meanwhile, and keeps a press once", async () => {
      netsuite.getLocationOnHand.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503)'));
      const unread = await post({ action: 'start', id: NEW, locationId: '1', kind: 'all' });
      expect(unread.status).toBe(502);
      expect(await unread.json()).toEqual({ error: "Couldn't read NetSuite's count at O'Fallon (NetSuite SuiteQL error (503)). Nothing was started; try again." });
      expect(rpcNames()).toEqual([]);

      const taken = [{ netsuite_item_id: '812', item_number: 'HITCH-2', number: 9 }];
      state.answers.stock_count_start = () => ok({ state: 'on_another', taken });
      const raced = await post({ action: 'start', id: NEW, locationId: '1', kind: 'all' });
      expect(raced.status).toBe(409);
      expect(await raced.json()).toEqual({
        error: "Some of these went on another count just now. HITCH-2 is on CNT-0009. Press Start again and they'll be left off.", taken,
      });

      // The same press, sent again, got in between reading the count and starting it: it's kept once.
      state.answers.stock_count_start = () => ok({ state: 'same', count: countRow(NEW, { number: 6 }) });
      const twice = await post({ action: 'start', id: NEW, locationId: '1', kind: 'all' });
      expect(twice.status).toBe(200);
      expect(await twice.json()).toMatchObject({ count: { id: NEW, label: 'CNT-0006' }, same: true });
      expect(audited()).toEqual([]);
    });
  });

  describe('adding items and saving what was counted', () => {
    it('adds items in shelf order with their live counts, and says why it can\'t', async () => {
      state.live[20][813] = 2.00004;
      expect(await (await post({ action: 'add', id: COUNTING, itemIds: ['820', '813', '813'] })).json()).toEqual({ added: 2 });
      expect(netsuite.getLocationOnHand).toHaveBeenCalledWith('20', ['820', '813']);
      expect(argsOf('stock_count_add')).toEqual([{
        id: COUNTING, by: JESSIE, lines: [
          // To the four places a count keeps.
          { netsuite_item_id: '813', part_id: 'p2', item_number: 'BALL-2', display_name: 'Ball, 2 in.', on_hand_start: 2 },
          { netsuite_item_id: '820', part_id: null, item_number: 'WIRE-14', display_name: '14 ga wire', on_hand_start: 0 },
        ],
      }]);

      const cases: Array<[Record<string, unknown>, number, Record<string, unknown>]> = [
        [{ id: NONE, itemIds: ['813'] }, 404, { error: "There's no such count." }],
        [{ id: ASKED, itemIds: ['813'] }, 409, { error: NOT_NOW_TEXT.asked, status: 'asked' }],
        [{ id: COUNTING, itemIds: ['999'] }, 400, { error: "FleetSuite's parts list has no item 999." }],
        [{ id: COUNTING, itemIds: ['815'] }, 400, { error: "HITCH-LABOR isn't an item NetSuite keeps stock of." }],
      ];
      for (const [body, status, answer] of cases) {
        const res = await post({ action: 'add', ...body });
        expect([body, res.status, await res.json()]).toEqual([body, status, answer]);
      }

      netsuite.getLocationOnHand.mockRejectedValueOnce(new Error('timeout'));
      const unread = await post({ action: 'add', id: COUNTING, itemIds: ['813'] });
      expect([unread.status, await unread.json()]).toEqual([502, { error: "Couldn't read NetSuite's count at Cool Springs (timeout). Nothing was added; try again." }]);

      const taken = [{ netsuite_item_id: '813', item_number: 'BALL-2', number: 2 }];
      state.answers.stock_count_add = () => ok({ state: 'on_another', taken });
      const raced = await post({ action: 'add', id: COUNTING, itemIds: ['813'] });
      expect([raced.status, await raced.json()]).toEqual([409, { error: 'BALL-2 is on CNT-0002. Nothing was added.', taken }]);

      state.answers.stock_count_add = () => ok({ state: 'too_many', on_it: 499 });
      const full = await post({ action: 'add', id: COUNTING, itemIds: ['813', '820'] });
      expect([full.status, await full.json()]).toEqual([409, { error: 'A count takes 500 items at most, and this one has 499. Start another count for the rest.' }]);
      expect(argsOf('stock_count_add')).toHaveLength(3);
    });

    it("saves only the boxes sent, each count kept with NetSuite's count as it's saved", async () => {
      const res = await post({ action: 'save', id: COUNTING, lines: [{ itemId: '812', counted: 1.5 }, { itemId: '816', counted: null }] });
      expect(await res.json()).toEqual({ saved: 2 });
      // Only what was counted is read, to the four places a count is kept.
      expect(netsuite.getLocationOnHand).toHaveBeenCalledTimes(1);
      expect(netsuite.getLocationOnHand).toHaveBeenCalledWith('20', ['812']);
      expect(argsOf('stock_count_save')).toEqual([{
        id: COUNTING, by: JESSIE, by_name: 'Jessie Test', count_date: null,
        lines: [{ netsuite_item_id: '812', counted: 1.5, on_hand_then: 1 }, { netsuite_item_id: '816', counted: null, on_hand_then: null }],
      }]);

      // Clearing a box asks NetSuite nothing, and the count's day goes with it.
      netsuite.getLocationOnHand.mockClear();
      expect((await post({ action: 'save', id: COUNTING, countDate: '2027-09-14', lines: [{ itemId: '816', counted: null }] })).status).toBe(200);
      expect(netsuite.getLocationOnHand).not.toHaveBeenCalled();
      expect(argsOf('stock_count_save')[1]).toEqual({
        id: COUNTING, by: JESSIE, by_name: 'Jessie Test', count_date: '2027-09-14', lines: [{ netsuite_item_id: '816', counted: null, on_hand_then: null }],
      });
      // An item NetSuite has none of is kept against 0.
      await post({ action: 'save', id: COUNTING, lines: [{ itemId: '813', counted: 2 }] });
      expect(argsOf('stock_count_save')[2].lines).toEqual([{ netsuite_item_id: '813', counted: 2, on_hand_then: 0 }]);
    });

    it("saves nothing that can't be kept right", async () => {
      const cases: Array<[Record<string, unknown>, number, Record<string, unknown>]> = [
        [{ id: COUNTING, lines: [{ itemId: '812', counted: 1 }, { itemId: '812', counted: 2 }] }, 400, { error: 'An item is saved twice.' }],
        [{ id: COUNTING, countDate: '2027-09-16', lines: [] }, 400, { error: "A count can't be dated after today." }],
        [{ id: COUNTING, lines: [{ itemId: '812', counted: -1 }] }, 400, {
          error: 'Invalid request', details: [{ path: 'lines.0.counted', message: "A count can't be below 0." }],
        }],
        [{ id: COUNTING, lines: [{ itemId: '812', counted: 1.23456 }] }, 400, {
          error: 'Invalid request', details: [{ path: 'lines.0.counted', message: 'A count takes 4 places at most.' }],
        }],
        [{ id: NONE, lines: [] }, 404, { error: "There's no such count." }],
        [{ id: ASKED, lines: [{ itemId: '812', counted: 1 }] }, 409, { error: NOT_NOW_TEXT.asked, status: 'asked' }],
      ];
      for (const [body, status, answer] of cases) {
        const res = await post({ action: 'save', ...body });
        expect([body, res.status, await res.json()]).toEqual([body, status, answer]);
      }
      expect(rpcNames()).toEqual([]);

      netsuite.getLocationOnHand.mockRejectedValueOnce(new Error('timeout'));
      const unread = await post({ action: 'save', id: COUNTING, lines: [{ itemId: '812', counted: 1 }] });
      expect([unread.status, await unread.json()]).toEqual([502, {
        error: "Couldn't read NetSuite's count at Cool Springs (timeout), so nothing was saved: each count is kept with NetSuite's count as it's saved. Try again.",
      }]);
      expect(rpcNames()).toEqual([]);

      state.answers.stock_count_save = () => ok({ state: 'not_on_count', missing: ['813'] });
      const stale = await post({ action: 'save', id: COUNTING, lines: [{ itemId: '813', counted: 1 }] });
      expect([stale.status, await stale.json()]).toEqual([409, { error: "Some of these aren't on the count. Reload it, then save again." }]);
      // Asked for between the route's read and its save.
      state.answers.stock_count_save = () => ok({ state: 'not_now', status: 'asked' });
      const late = await post({ action: 'save', id: COUNTING, lines: [{ itemId: '812', counted: 1 }] });
      expect([late.status, await late.json()]).toEqual([409, { error: NOT_NOW_TEXT.asked, status: 'asked' }]);
    });
  });

  describe('asking, finishing and stopping', () => {
    it("asks for approval, or says why it can't", async () => {
      const res = await post({ action: 'ask', id: COUNTING });
      expect((await res.json()).count).toMatchObject({ id: COUNTING, status: 'asked', askedBy: JESSIE, askedByName: 'Jessie Test' });
      expect(argsOf('stock_count_ask')).toEqual([{ id: COUNTING, by: JESSIE, by_name: 'Jessie Test' }]);
      expect(audited()).toEqual([{ actorId: JESSIE, table: 'stock_counts', recordId: COUNTING, action: 'ask', detail: { count: 'CNT-0004', location: 'Cool Springs' } }]);

      const blocked = [{ netsuite_item_id: '812', item_number: 'HITCH-2', why: 'adjusted', by_name: 'Bo Boss', at: NOW }];
      const cases: Array<[unknown, number, Record<string, unknown>]> = [
        [{ state: 'blocked', blocked }, 409, {
          error: 'HITCH-2 was adjusted with Adjust by Bo Boss after it was counted, so its difference may be corrected already. Count it again.',
          blocked: [{ netsuiteItemId: '812', itemNumber: 'HITCH-2', why: 'adjusted', byName: 'Bo Boss', at: NOW }],
        }],
        [{ state: 'none_counted' }, 400, { error: 'Nothing on it is counted yet.' }],
        [{ state: 'no_differences' }, 409, { error: "Every item counted matches NetSuite, so there's nothing to approve. Press Finish instead." }],
        // A second press doesn't read as asking.
        [{ state: 'not_now', status: 'asked' }, 409, { error: NOT_NOW_TEXT.asked, status: 'asked' }],
        [{ state: 'gone' }, 404, { error: "There's no such count." }],
      ];
      for (const [answer, status, body] of cases) {
        state.answers.stock_count_ask = () => ok(answer);
        const r = await post({ action: 'ask', id: COUNTING });
        expect([answer, r.status, await r.json()]).toEqual([answer, status, body]);
      }
      expect(audited()).toHaveLength(1);
    });

    it('finishes a count with nothing to post', async () => {
      expect((await (await post({ action: 'finish', id: COUNTING })).json()).count).toMatchObject({ id: COUNTING, status: 'made', decidedByName: 'Jessie Test' });
      expect(audited().map((a) => a.action)).toEqual(['finish']);
      const again = await post({ action: 'finish', id: COUNTING });
      expect([again.status, await again.json()]).toEqual([409, { error: "It's done already.", status: 'made' }]);
      state.answers.stock_count_finish = () => ok({ state: 'differences' });
      const differs = await post({ action: 'finish', id: COUNTING });
      expect([differs.status, await differs.json()]).toEqual([409, { error: 'Some items counted differ from NetSuite, so ask for approval instead.' }]);
      state.answers.stock_count_finish = () => ok({ state: 'none_counted' });
      expect((await post({ action: 'finish', id: COUNTING })).status).toBe(400);
    });

    it('lets whoever started a count, or a super admin, stop it', async () => {
      const refused = await post({ action: 'cancel', id: OTHER });
      expect([refused.status, await refused.json()]).toEqual([403, { error: 'Only whoever started a count, or a super admin, can stop it.' }]);
      expect(rpcNames()).toEqual([]);
      expect((await (await post({ action: 'cancel', id: COUNTING })).json()).count.status).toBe('cancelled');
      // Stopping one that's stopped already, or that's waiting for approval, isn't stopping it.
      const again = await post({ action: 'cancel', id: COUNTING });
      expect([again.status, await again.json()]).toEqual([409, { error: 'It was stopped.', status: 'cancelled' }]);
      as(CRAIG, ['super_admin']);
      expect((await (await post({ action: 'cancel', id: OTHER })).json()).count.status).toBe('cancelled');
      const asked = await post({ action: 'cancel', id: ASKED });
      expect([asked.status, await asked.json()]).toEqual([409, { error: NOT_NOW_TEXT.asked, status: 'asked' }]);
      expect((await post({ action: 'cancel', id: NONE })).status).toBe(404);
      expect(audited().map((a) => [a.action, a.detail.count])).toEqual([['cancel', 'CNT-0004'], ['cancel', 'CNT-0002']]);
    });

    it("lets only whoever asked withdraw, and only a super admin who didn't ask turn one down, saying why", async () => {
      const notTheirs = await post({ action: 'turn_down', id: ASKED, why: 'Recount' });
      expect([notTheirs.status, await notTheirs.json()]).toEqual([403, { error: 'Only a super admin turns down a count.' }]);

      as(BOSS, ['super_admin']);
      const withdrawn = await post({ action: 'withdraw', id: ASKED });
      expect([withdrawn.status, await withdrawn.json()]).toEqual([403, { error: 'Only whoever asked withdraws it. A super admin turns it down instead.' }]);
      for (const [why, error] of [['  ', 'Say why it is turned down.'], ['x'.repeat(301), 'Keep why to 300 characters.']]) {
        const res = await post({ action: 'turn_down', id: ASKED, why });
        expect([res.status, await res.json()]).toEqual([400, { error }]);
      }
      const turned = await (await post({ action: 'turn_down', id: ASKED, why: ' Recount the hitches ' })).json();
      expect(turned.count).toMatchObject({ status: 'counting', turnedDownByName: 'Bo Boss', why: 'Recount the hitches' });
      expect(argsOf('stock_count_turn_down')).toEqual([{ id: ASKED, by: BOSS, by_name: 'Bo Boss', why: 'Recount the hitches' }]);
      expect(audited()).toEqual([{
        actorId: BOSS, table: 'stock_counts', recordId: ASKED, action: 'turn_down', detail: { count: 'CNT-0005', location: 'Service van', why: 'Recount the hitches' },
      }]);

      const counting = await post({ action: 'turn_down', id: ASKED, why: 'Recount' });
      expect([counting.status, await counting.json()]).toEqual([409, { error: NOT_NOW_TEXT.counting, status: 'counting' }]);

      Object.assign(rowOf(ASKED), { status: 'asked', asked_by: JESSIE });
      as(JESSIE, ['admin', 'super_admin']);
      const own = await post({ action: 'turn_down', id: ASKED, why: 'Recount' });
      expect([own.status, await own.json()]).toEqual([403, { error: 'You asked for this one, so withdraw it instead.' }]);
      expect((await (await post({ action: 'withdraw', id: ASKED })).json()).count.status).toBe('counting');
      const twice = await post({ action: 'withdraw', id: ASKED });
      expect([twice.status, await twice.json()]).toEqual([409, { error: NOT_NOW_TEXT.counting, status: 'counting' }]);
    });
  });

  describe('approving a count', () => {
    beforeEach(() => as(BOSS, ['super_admin']));
    const approve = (id = ASKED) => post({ action: 'approve', id });
    const waiting = " Nothing was posted, and it's waiting for approval again.";

    it("posts its differences as one adjustment at its location, under the count's own External ID", async () => {
      // Counted yesterday, approved today: it's dated the count's day.
      rowOf(ASKED).count_date = '2027-09-14';
      netsuite.findCountAdjustment.mockResolvedValueOnce(null).mockResolvedValueOnce({ adjustmentId: '7003', number: 'ADJ-41' });
      const res = await approve();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ made: true, adjustmentId: '7003', number: 'ADJ-41' });
      expect(argsOf('stock_count_claim')).toEqual([{ id: ASKED, by: BOSS, by_name: 'Bo Boss' }]);
      expect(netsuite.findCountAdjustment.mock.calls).toEqual([[`fleetsuite-count-${ASKED}`], [`fleetsuite-count-${ASKED}`]]);
      expect(netsuite.getLocationOnHand).toHaveBeenCalledWith('7', ['812', '816']);
      expect(netsuite.createCountAdjustment.mock.calls).toEqual([[{
        externalId: `fleetsuite-count-${ASKED}`, subsidiaryId: '2', accountId: '501', locationId: '7', tranDate: '2027-09-14',
        memo: 'FleetSuite count CNT-0005 at Service van · by Jessie Test, approved by Bo Boss',
        lines: [{ itemId: '812', adjustQtyBy: -2 }, { itemId: '816', adjustQtyBy: 1.5 }],
      }]]);
      expect(argsOf('stock_count_made')).toEqual([{ id: ASKED, netsuite_adjustment_id: '7003', netsuite_number: 'ADJ-41' }]);
      expect(rowOf(ASKED)).toMatchObject({ status: 'made', netsuite_adjustment_id: '7003', netsuite_adjustment_number: 'ADJ-41' });
      // No dollar amounts are kept.
      expect(audited()).toEqual([{
        actorId: BOSS, table: 'stock_counts', recordId: ASKED, action: 'approve',
        detail: { count: 'CNT-0005', location: 'Service van', netsuite_adjustment_id: '7003', items: 2 },
      }]);
    });

    it("takes an item to 0 but never below, and puts the count back to wait when it would", async () => {
      state.live[7] = { 812: 2, 816: 2 };
      expect((await approve()).status).toBe(200);

      Object.assign(rowOf(ASKED), { status: 'asked' });
      state.live[7] = { 812: 1, 816: 2 };
      netsuite.createCountAdjustment.mockClear();
      const below = await approve();
      const why = "NetSuite has 1 of HITCH-2 at Service van now, so taking off 2 would leave it below 0. Turn it down so it's counted again.";
      expect([below.status, await below.json()]).toEqual([409, { error: `${why}${waiting}` }]);
      expect(argsOf('stock_count_let_go')).toEqual([{ id: ASKED, error: why }]);
      expect(rowOf(ASKED)).toMatchObject({ status: 'asked', error: why });
      expect(netsuite.createCountAdjustment).not.toHaveBeenCalled();
    });

    it("refuses anyone but a super admin who didn't ask", async () => {
      as(JESSIE, ['admin']);
      const admin = await approve();
      expect([admin.status, await admin.json()]).toEqual([403, { error: "Only a super admin who didn't ask approves a count." }]);
      as(JESSIE, ['admin', 'super_admin']);
      const own = await approve();
      expect([own.status, await own.json()]).toEqual([403, { error: "You asked for this one, so a super admin who didn't ask approves it." }]);
      expect(rpcNames()).toEqual(['stock_count_claim']);
      expect(rowOf(ASKED).status).toBe('asked');
      expect(netsuite.findCountAdjustment).not.toHaveBeenCalled();
    });

    it("won't post what can't be posted as counted, or a count that's being posted or done", async () => {
      state.answers.stock_count_claim = () => ok({ state: 'blocked', blocked: [{ netsuite_item_id: '816', item_number: 'HITCH-10', why: 'asked', by_name: null }] });
      const held = await approve();
      expect([held.status, (await held.json()).error]).toEqual([409,
        "HITCH-10 has an adjustment asked for by someone on Adjustments to approve. Once it's decided, count it again. Turn it down so they're counted again."]);
      answers();

      Object.assign(rowOf(ASKED), { status: 'sending', sent_at: NOW });
      const sending = await approve();
      expect([sending.status, await sending.json()]).toEqual([409, { error: "It's being posted to NetSuite now. Don't press again: reload in a minute to see it." }]);
      rowOf(ASKED).sent_at = new Date(Date.parse(NOW) - STALE_MS).toISOString();
      const stale = await approve();
      expect([stale.status, await stale.json()]).toEqual([409, {
        error: "A press of Approve hasn't heard back from NetSuite for a while. Press Ask NetSuite to find out what became of it.",
      }]);
      const done = await approve(DONE);
      expect([done.status, await done.json()]).toEqual([409, { error: "It's done already.", status: 'made' }]);
      expect((await approve(NONE)).status).toBe(404);
      expect(netsuite.findCountAdjustment).not.toHaveBeenCalled();
      expect(netsuite.createCountAdjustment).not.toHaveBeenCalled();
    });

    it('takes the adjustment NetSuite has already, and never posts a count twice', async () => {
      netsuite.findCountAdjustment.mockResolvedValueOnce({ adjustmentId: '7002', number: '' });
      expect(await (await approve()).json()).toEqual({ made: true, adjustmentId: '7002', number: null, already: true });
      expect(netsuite.createCountAdjustment).not.toHaveBeenCalled();
      expect(argsOf('stock_count_made')).toEqual([{ id: ASKED, netsuite_adjustment_id: '7002', netsuite_number: null }]);
      expect(audited().map((a) => [a.action, a.detail])).toEqual([['approve_found', { count: 'CNT-0005', location: 'Service van', netsuite_adjustment_id: '7002', items: 2 }]]);
    });

    it("lets it go when NetSuite refuses or can't be asked, and holds it when NetSuite doesn't say", async () => {
      const tries: Array<[() => void, string]> = [
        [() => netsuite.findCountAdjustment.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503)')),
          "Couldn't check NetSuite for this count's adjustment (NetSuite SuiteQL error (503))."],
        [() => netsuite.getInventoryAdjustmentAccountId.mockRejectedValueOnce(new Error('NetSuite has no account 52000 Inventory Adjustment')),
          "Couldn't find 52000 Inventory Adjustment in NetSuite (NetSuite has no account 52000 Inventory Adjustment)."],
        [() => netsuite.getLocationOnHand.mockRejectedValueOnce(new Error('timeout')), "Couldn't read NetSuite's count at Service van (timeout)."],
        [() => netsuite.createCountAdjustment.mockResolvedValueOnce({ success: false, error: 'NetSuite refused the adjustment (400): Invalid item reference key 816.' }),
          'NetSuite refused the adjustment (400): Invalid item reference key 816.'],
      ];
      for (const [arrange, why] of tries) {
        arrange();
        const res = await approve();
        expect([res.status, await res.json()]).toEqual([502, { error: `${why}${waiting}` }]);
        expect(rowOf(ASKED)).toMatchObject({ status: 'asked', error: why });
      }
      expect(argsOf('stock_count_made')).toEqual([]);

      netsuite.createCountAdjustment.mockResolvedValueOnce({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
      const unsure = await approve();
      expect([unsure.status, await unsure.json()]).toEqual([502, {
        error: "NetSuite didn't answer (socket hang up). FleetSuite can't tell whether NetSuite posted it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.",
        unsure: true,
      }]);
      expect(rowOf(ASKED)).toMatchObject({ status: 'unsure', error: "NetSuite didn't answer (socket hang up)." });
      expect(argsOf('stock_count_let_go')).toHaveLength(4);
      expect(audited().map((a) => [a.action, a.detail])).toEqual([['approve_unsure', { count: 'CNT-0005', location: 'Service van', items: 2 }]]);
    });

    it("says so when nothing differs, its location is gone, or it can't be put back to wait", async () => {
      for (const l of state.tables.stock_count_lines.filter((x) => x.count_id === ASKED)) l.on_hand_then = l.counted;
      const same = await approve();
      expect([same.status, await same.json()]).toEqual([409, { error: `Nothing on it differs from NetSuite.${waiting}` }]);

      for (const l of state.tables.stock_count_lines.filter((x) => x.count_id === ASKED)) l.on_hand_then = 2;
      rowOf(ASKED).location_id = '8';
      const gone = await approve();
      expect([gone.status, await gone.json()]).toEqual([409, { error: `Service van isn't one of Books' locations any more.${waiting}` }]);

      state.answers.stock_count_let_go = () => failed('connection lost');
      Object.assign(rowOf(ASKED), { status: 'asked' });
      const stuck = await approve();
      expect([stuck.status, await stuck.json()]).toEqual([409, {
        error: "Service van isn't one of Books' locations any more. Nothing was posted, but FleetSuite couldn't put it back to wait for approval (connection lost). Five minutes after it was approved, press Ask NetSuite.",
      }]);
      expect(netsuite.createCountAdjustment).not.toHaveBeenCalled();
    });

    it("names no subsidiary for a company with one, and says it's made when FleetSuite can't keep that", async () => {
      Object.assign(rowOf(ASKED), { location_id: '20', location_name: 'Cool Springs' });
      state.live[20] = { 812: 9, 816: 2 };
      as(CRAIG, ['super_admin']);
      netsuite.findCountAdjustment.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('timeout'));
      state.answers.stock_count_made = () => failed('connection lost');
      expect(await (await approve()).json()).toEqual({
        made: true, adjustmentId: '7003', number: null,
        warning: "NetSuite has it as adjustment 7003, but FleetSuite couldn't keep that (connection lost). Press Ask NetSuite on the count to keep it.",
      });
      expect(netsuite.createCountAdjustment.mock.calls[0][0]).toMatchObject({
        subsidiaryId: null, locationId: '20', memo: 'FleetSuite count CNT-0005 at Cool Springs · by Jessie Test, approved by a super admin',
      });

      answers();
      Object.assign(rowOf(ASKED), { status: 'asked' });
      state.answers.stock_count_made = () => ok({ made: false });
      expect((await (await approve()).json()).warning).toBe('NetSuite has it, but the count had moved on meanwhile. Reload it.');
    });
  });
});

describe('asking NetSuite what became of a press', () => {
  beforeEach(() => as(BOSS, ['super_admin']));
  const check = (id = ASKED) => post({ action: 'check', id });

  it('finds the adjustment a press made, or puts the count back to wait, even while counts are off', async () => {
    Object.assign(rowOf(ASKED), { status: 'unsure', sent_by_name: 'Bo Boss', sent_at: NOW });
    netsuite.findCountAdjustment.mockResolvedValueOnce({ adjustmentId: '7003', number: 'ADJ-41' });
    expect(await (await check()).json()).toEqual({ made: true, adjustmentId: '7003', number: 'ADJ-41', already: true });
    expect(netsuite.findCountAdjustment).toHaveBeenCalledWith(`fleetsuite-count-${ASKED}`);
    expect(rowOf(ASKED)).toMatchObject({ status: 'made', netsuite_adjustment_id: '7003' });

    Object.assign(rowOf(ASKED), { status: 'unsure', netsuite_adjustment_id: null });
    const why = "NetSuite has no adjustment from this press, so it's waiting for approval again.";
    expect(await (await check()).json()).toEqual({ letGo: true, message: why });
    expect(rowOf(ASKED)).toMatchObject({ status: 'asked', error: why });
    expect(audited().map((a) => [a.action, a.detail])).toEqual([
      ['approve_found', { count: 'CNT-0005', location: 'Service van', netsuite_adjustment_id: '7003' }],
      ['check_none', { count: 'CNT-0005', location: 'Service van' }],
    ]);
    expect(netsuite.createCountAdjustment).not.toHaveBeenCalled();
  });

  it('asks only once a press needs it, and only for a super admin', async () => {
    switchOn(true);
    as(JESSIE, ['admin']);
    const admin = await check();
    expect([admin.status, await admin.json()]).toEqual([403, { error: 'Only a super admin asks NetSuite about a count.' }]);

    as(BOSS, ['super_admin']);
    const asked = await check();
    expect([asked.status, await asked.json()]).toEqual([409, { error: NOT_NOW_TEXT.asked, status: 'asked' }]);
    Object.assign(rowOf(ASKED), { status: 'sending', sent_at: new Date(Date.parse(NOW) - STALE_MS + 1000).toISOString() });
    const early = await check();
    expect([early.status, await early.json()]).toEqual([409, { error: "It's being posted to NetSuite now. Ask NetSuite once five minutes have passed." }]);
    expect(netsuite.findCountAdjustment).not.toHaveBeenCalled();
    expect((await check(NONE)).status).toBe(404);

    rowOf(ASKED).sent_at = new Date(Date.parse(NOW) - STALE_MS).toISOString();
    netsuite.findCountAdjustment.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503)'));
    const unasked = await check();
    expect([unasked.status, await unasked.json()]).toEqual([502, { error: "Couldn't ask NetSuite what became of this count (NetSuite SuiteQL error (503)). Try again." }]);
    expect(rowOf(ASKED).status).toBe('sending');

    state.answers.stock_count_let_go = () => ok({ let_go: false });
    const moved = await check();
    expect([moved.status, await moved.json()]).toEqual([409, { error: 'It moved on meanwhile. Reload it.' }]);
  });
});

describe('one count', () => {
  beforeEach(() => as(BOSS, ['super_admin']));

  it("opens a count with its items, what's held back, and what each is worth to whoever sees money", async () => {
    state.answers.stock_count_blocked = (p) => {
      expect(p).toEqual({ p_id: ASKED });
      return ok([{ netsuite_item_id: '816', item_number: 'HITCH-10', why: 'asked', by_name: 'Brian Test', at: NOW }]);
    };
    const body = await (await get(`id=${ASKED}`)).json();
    expect(body.count).toMatchObject({ id: ASKED, label: 'CNT-0005', status: 'asked', askedByName: 'Jessie Test' });
    expect(body.lines).toEqual([
      {
        netsuiteItemId: '812', itemNumber: 'HITCH-2', displayName: 'Hitch, 2 in.', position: 1, onHandStart: 9, counted: 7, onHandThen: 9,
        countedByName: 'Jessie Test', countedAt: '2027-09-15T14:00:00+00:00',
      },
      {
        netsuiteItemId: '816', itemNumber: 'HITCH-10', displayName: 'Hitch, 10k', position: 2, onHandStart: 2, counted: 3.5, onHandThen: 2,
        countedByName: 'Jessie Test', countedAt: '2027-09-15T14:01:00+00:00',
      },
    ]);
    expect(body.blocked).toEqual([{ netsuiteItemId: '816', itemNumber: 'HITCH-10', why: 'asked', byName: 'Brian Test', at: NOW }]);
    expect(body).toMatchObject({ averages: { 812: 12.5, 816: 15 }, seeMoney: true, today: '2027-09-15', me: BOSS, superAdmin: true, switchedOn: false });

    state.seeMoney = false;
    expect(await (await get(`id=${ASKED}`)).json()).toMatchObject({ averages: null, seeMoney: false });

    // A count that's done has nothing held back.
    state.rpcs.length = 0;
    expect((await (await get(`id=${DONE}`)).json()).blocked).toEqual([]);
    expect(rpcNames()).toEqual([]);
    for (const id of [NONE, 'not-an-id']) {
      const res = await get(`id=${id}`);
      expect([res.status, await res.json()]).toEqual([404, { error: "There's no such count." }]);
    }
  });
});
