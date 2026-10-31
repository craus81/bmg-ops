// /api/inventory-transfers (src/lib/inventory-transfers.ts): who can open it
// while inventory transfers are switched off and once they're on, finding the
// items to move, what saving and deleting a draft send the database, and how
// Move makes the transfer in NetSuite once: from its lines as they're kept,
// under the transfer's own External ID however often it's pressed, never
// moving more than NetSuite has where it moves from, let go when NetSuite
// refuses and held when it can't tell. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const STAFF = 'd0000000-0000-4000-8000-000000000001';
const BOSS = 'd0000000-0000-4000-8000-000000000002';
const CRAIG = 'd0000000-0000-4000-8000-000000000003';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    userId: '',
    roles: [] as string[],
    admin: true,
    clock: 0,
    tables: {} as Record<string, Record<string, any>[]>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    answers: {} as Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }>,
    /** Runs once, just before the next delete or update: someone else acting between the route's read and its write. */
    meanwhile: null as (() => void) | null,
    /** What each search asked the parts list for. */
    searches: [] as string[],
  };
  const netsuite = {
    findInventoryTransfer: vi.fn(),
    createInventoryTransfer: vi.fn(),
    getLocationOnHand: vi.fn(),
  };

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // An in-memory stand-in for the tables the route reads and writes.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    let patch: Record<string, any> | null = null;
    let remove = false;
    let returning = false;
    let limit = Infinity;
    let badId: unknown = null;
    const rows = () => (state.tables[table] ??= []);
    const run = () => {
      // Postgres won't compare a uuid column with text that isn't one.
      if (badId !== null) return { data: null, error: { message: `invalid input syntax for type uuid: "${badId}"` } };
      if ((remove || patch) && state.meanwhile) { const m = state.meanwhile; state.meanwhile = null; m(); }
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
        if (c === 'id' && table === 'inventory_transfers' && !UUID.test(String(v))) badId = v;
        filters.push((r) => r[c] === v);
        return builder;
      },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      // Only the parts search's col.imatch."pattern",…, Postgres's [:alnum:] read as JavaScript's.
      or: (expr: string) => {
        state.searches.push(expr);
        const parts = expr.split(',').map((p) => {
          const [, col, re] = p.match(/^(\w+)\.imatch\."(.*)"$/)!;
          return [col, new RegExp(re.replace(/\[:alnum:\]/g, 'a-zA-Z0-9'), 'i')] as const;
        });
        filters.push((r) => parts.some(([col, re]) => re.test(String(r[col] ?? ''))));
        return builder;
      },
      not: (c: string, op: string, v: unknown) => { expect(op).toBe('is'); expect(v).toBeNull(); filters.push((r) => r[c] != null); return builder; },
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
    { id: 'g1', code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }, { id: '7', name: 'Service van' }] },
    { id: 'g2', code: '1084', name: '1084 Cool Springs', subsidiaryId: null as string | null, locations: [{ id: '20', name: 'Cool Springs' }, { id: '21', name: 'Back lot' }] },
  ];
  return { state, netsuite, service, companies };
});

// Inventory Adjust's wall: admins, and Jessie is one.
vi.mock('@/lib/api-auth', () => ({
  requireAdmin: vi.fn(async () => (h.state.admin
    ? { user: { id: h.state.userId }, profile: { roles: h.state.roles } }
    : { user: { id: h.state.userId }, profile: { roles: h.state.roles }, error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/books/snap-a-bill', () => ({ readCompanies: vi.fn(async () => h.companies) }));

const { state, netsuite } = h;

import { logAudit } from '@/lib/audit';
import { partSearchOrFilter } from '@/lib/loose-search';
import { GET, POST } from '../app/api/inventory-transfers/route';

const T = (n: number) => `f0000000-0000-4000-8000-00000000000${n}`;
const DRAFT = T(1);
const MADE = T(3);
const NEW = T(4);

/** Brackets and wire for the service van. */
const LINES = [
  { item_netsuite_id: '501', item_number: 'BRK-100', quantity: 4 },
  { item_netsuite_id: '502', item_number: 'WIRE-14', quantity: 12.5 },
];
const SEEN = '2027-01-15T15:00:00.123456+00:00';
const transfer = (id: string, over: Record<string, unknown> = {}) => ({
  id, company: 'BMG', tran_date: '2027-01-15', from_location_id: '1', to_location_id: '7', memo: 'Stock for the van', lines: LINES,
  status: 'draft', created_by: STAFF, created_at: '2027-01-15T15:00:00Z', updated_by: STAFF, updated_at: SEEN,
  sent_by: null, sent_at: null, netsuite_transfer_id: null, netsuite_number: null, error: null, ...over,
});

const get = (query: string) => GET(new NextRequest(`https://app.test/api/inventory-transfers?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/inventory-transfers', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const rpcNames = () => state.rpcs.map(([fn]) => fn);
const rowOf = (id: string) => state.tables.inventory_transfers.find((r) => r.id === id)!;
const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'inventory_transfers', is_on: on }, { piece: 'journal_entries', is_on: !on }]; };
const as = (userId: string, roles: string[]) => { state.userId = userId; state.roles = roles; };
const stamp = () => `2027-01-16T10:00:${String((state.clock += 1)).padStart(2, '0')}.000001+00:00`;
const move = (id = DRAFT, updatedAt = SEEN) => post({ action: 'move', id, updatedAt });

/** The functions migration 470 adds, as the route counts on them answering. */
function answers() {
  const find = (id: string) => (state.tables.inventory_transfers ??= []).find((r) => r.id === id);
  state.answers = {
    inventory_transfer_save: (p) => {
      const fields = {
        company: p.company, tran_date: p.tran_date, from_location_id: p.from_location_id || null, to_location_id: p.to_location_id || null,
        memo: p.memo?.trim() || null, lines: p.lines, updated_by: p.by, updated_at: stamp(),
      };
      const r = find(p.id);
      if (!r) {
        state.tables.inventory_transfers.push(transfer(p.id, { ...fields, created_by: p.by }));
        return { data: { saved: true, status: 'draft', updated_at: fields.updated_at }, error: null };
      }
      if (r.status !== 'draft') return { data: { saved: false, status: r.status, updated_at: r.updated_at }, error: null };
      Object.assign(r, fields);
      return { data: { saved: true, status: 'draft', updated_at: r.updated_at }, error: null };
    },
    inventory_transfer_claim: (p) => {
      if (!p.by) return { data: null, error: { message: 'inventory transfers: a send needs who sent it' } };
      const r = find(p.id);
      if (!r) return { data: { state: 'gone' }, error: null };
      if (r.status === 'made') return { data: { state: 'made', netsuite_transfer_id: r.netsuite_transfer_id, netsuite_number: r.netsuite_number }, error: null };
      if (r.status === 'sending') return { data: { state: 'moving', transfer: { ...r } }, error: null };
      if (r.updated_at !== p.updated_at) return { data: { state: 'changed' }, error: null };
      const whole = r.lines.length > 0 && r.lines.every((l: any) => l.item_netsuite_id && l.quantity > 0)
        && r.from_location_id && r.to_location_id && r.from_location_id !== r.to_location_id && r.memo?.trim();
      if (!whole) return { data: null, error: { message: `inventory transfers: transfer ${r.id} needs a memo, two different locations and one line or more, each an item and a quantity` } };
      Object.assign(r, { status: 'sending', sent_by: p.by, sent_at: new Date().toISOString(), error: null });
      return { data: { state: 'claimed', transfer: { ...r } }, error: null };
    },
    inventory_transfer_let_go: (p) => {
      const r = find(p.id);
      if (!r || r.status !== 'sending') return { data: { let_go: false }, error: null };
      Object.assign(r, { status: 'draft', sent_by: null, sent_at: null, error: p.error });
      return { data: { let_go: true }, error: null };
    },
    inventory_transfer_made: (p) => {
      const r = find(p.id);
      if (!r || r.status !== 'sending') return { data: { made: false }, error: null };
      Object.assign(r, { status: 'made', netsuite_transfer_id: p.netsuite_transfer_id, netsuite_number: p.netsuite_number ?? null, error: null });
      return { data: { made: true }, error: null };
    },
  };
}

beforeEach(() => {
  as(STAFF, ['admin']);
  state.admin = true;
  state.clock = 0;
  state.searches = [];
  state.meanwhile = null;
  state.tables = {
    inventory_transfers: [
      transfer(DRAFT, { error: "NetSuite error (400): The period is closed." }),
      transfer(MADE, { status: 'made', sent_by: BOSS, sent_at: '2027-01-14T18:00:00Z', netsuite_transfer_id: '9001', netsuite_number: 'IT-12' }),
    ],
    netsuite_parts: [
      { netsuite_id: '501', item_number: 'BRK-100', display_name: 'Bracket kit', item_type: 'InvtPart', is_active: true },
      { netsuite_id: '502', item_number: 'WIRE-14', display_name: '14 ga wire, feet', item_type: 'InvtPart', is_active: true },
      { netsuite_id: '503', item_number: 'BRK-LABOR', display_name: 'Bracket install', item_type: 'Service', is_active: true },
      { netsuite_id: '504', item_number: 'BRK-OLD', display_name: null, item_type: 'InvtPart', is_active: false },
      { netsuite_id: '505', item_number: 'BRK-200', display_name: 'Bracket, large', item_type: null, is_active: true },
      { netsuite_id: null, item_number: 'BRK-LOCAL', display_name: 'Not in NetSuite', item_type: null, is_active: true },
    ],
    gl_netsuite_stock_counts: [
      { item_id: '501', location_id: '1', quantity: '10', read_at: '2027-01-15T14:43:00Z' },
      { item_id: '501', location_id: '7', quantity: 2, read_at: '2027-01-15T14:43:00Z' },
      { item_id: '502', location_id: '1', quantity: '250.5', read_at: '2027-01-15T14:43:05Z' },
      { item_id: '502', location_id: null, quantity: 300, read_at: '2027-01-15T14:43:09Z' },
    ],
    profiles: [{ id: STAFF, full_name: 'Sam Staff' }, { id: BOSS, full_name: 'Bo Boss' }, { id: CRAIG, full_name: null }],
  };
  switchOn(false);
  state.rpcs.length = 0;
  answers();
  vi.clearAllMocks();
  // A test that stops early leaves answers queued; the next starts with none.
  netsuite.findInventoryTransfer.mockReset();
  netsuite.createInventoryTransfer.mockReset();
  netsuite.getLocationOnHand.mockReset();
  netsuite.findInventoryTransfer.mockResolvedValue(null);
  netsuite.createInventoryTransfer.mockResolvedValue({ success: true, transferId: '9002' });
  netsuite.getLocationOnHand.mockImplementation(async (_loc: string, ids: string[]) => new Map(ids.map((id) => [id, 100])));
});

const SAVE = {
  action: 'save', id: NEW, company: 'BMG', date: '2027-01-20', fromLocationId: '1', toLocationId: '7', memo: ' Van restock ',
  lines: [{ itemId: '501', quantity: 2 }, { itemId: '599', quantity: 1 }, { itemId: null, quantity: 0 }],
};

describe('while inventory transfers are switched off', () => {
  it('shows Inventory Transfers to super admins only, and nobody who is not an admin', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    as(BOSS, ['super_admin']);
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true });
    state.admin = false;
    expect((await get('status=1')).status).toBe(403);
  });

  it('lets a super admin see the transfers, with the items on them and where NetSuite counts them, and nobody else', async () => {
    const refused = await get('');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Inventory transfers are switched off until January 1, 2027.', switchedOff: true });

    as(BOSS, ['super_admin']);
    const res = await get('');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      companies: [
        { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }, { id: '7', name: 'Service van' }] },
        { code: '1084', name: '1084 Cool Springs', subsidiaryId: null, locations: [{ id: '20', name: 'Cool Springs' }, { id: '21', name: 'Back lot' }] },
      ],
      me: BOSS,
      superAdmin: true,
      switchedOn: false,
      offText: "Inventory transfers are switched off until January 1, 2027. You can make and save transfers to see what they'd send; nothing is moved in NetSuite.",
    });
    expect(body.transfers.find((t: { id: string }) => t.id === DRAFT)).toEqual({
      id: DRAFT, company: 'BMG', date: '2027-01-15', fromLocationId: '1', toLocationId: '7', memo: 'Stock for the van',
      lines: [{ itemId: '501', quantity: 4, itemNumber: 'BRK-100' }, { itemId: '502', quantity: 12.5, itemNumber: 'WIRE-14' }],
      status: 'draft', createdBy: 'Sam Staff', createdById: STAFF, createdAt: '2027-01-15T15:00:00Z', updatedBy: 'Sam Staff', updatedAt: SEEN,
      sentBy: null, sentAt: null, transferId: null, number: null, error: 'NetSuite error (400): The period is closed.',
    });
    expect(body.transfers.find((t: { id: string }) => t.id === MADE)).toMatchObject({ status: 'made', sentBy: 'Bo Boss', transferId: '9001', number: 'IT-12' });
    expect(body.items).toEqual({
      501: { id: '501', number: 'BRK-100', name: 'Bracket kit', type: 'InvtPart', active: true },
      502: { id: '502', number: 'WIRE-14', name: '14 ga wire, feet', type: 'InvtPart', active: true },
    });
    // Counts NetSuite gave company-wide aren't where anything is.
    expect(body.counts).toEqual({ 501: { 1: 10, 7: 2 }, 502: { 1: 250.5 } });
    expect(body.countsReadAt).toBe('2027-01-15T14:43:05Z');

    // Someone with no name on their profile is still someone.
    rowOf(DRAFT).updated_by = CRAIG;
    expect((await (await get('')).json()).transfers.find((t: { id: string }) => t.id === DRAFT).updatedBy).toBe('Someone');

    // Only the last 25 moved are listed; one asked for by its id is there too, and a broken id still opens the list.
    const OLD = 'f0000000-0000-4000-8000-000000000099';
    for (let n = 0; n < 25; n += 1) {
      state.tables.inventory_transfers.push(transfer(`e0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, {
        status: 'made', sent_at: '2027-01-14T18:00:00Z', netsuite_transfer_id: `80${n}`,
      }));
    }
    state.tables.inventory_transfers.push(transfer(OLD, { status: 'made', sent_at: '2027-01-01T18:00:00Z', netsuite_transfer_id: '7999' }));
    const listed = async (q: string) => (await (await get(q)).json()).transfers.map((t: { id: string }) => t.id) as string[];
    expect(await listed('')).toHaveLength(26);
    expect(await listed('')).not.toContain(OLD);
    expect(await listed(`id=${OLD}`)).toContain(OLD);
    expect((await get('id=not-an-id')).status).toBe(200);
  });

  it('lets a super admin make, save and delete drafts, and moves nothing, even for them', async () => {
    as(BOSS, ['super_admin']);
    expect(await (await post(SAVE)).json()).toEqual({ success: true, updatedAt: expect.any(String) });
    expect(rowOf(NEW)).toMatchObject({ status: 'draft', created_by: BOSS });

    const moved = await move(NEW, rowOf(NEW).updated_at);
    expect(moved.status).toBe(403);
    expect(await moved.json()).toEqual({ error: 'Inventory transfers are switched off until January 1, 2027. It was saved, and nothing was moved in NetSuite.', switchedOff: true });
    expect(rowOf(NEW).status).toBe('draft');

    expect(await (await post({ action: 'delete', id: NEW })).json()).toEqual({ success: true });
    expect(state.tables.inventory_transfers.map((r) => r.id)).toEqual([DRAFT, MADE]);
    expect(rpcNames()).toEqual(['inventory_transfer_save']);
    expect(netsuite.findInventoryTransfer).not.toHaveBeenCalled();
    expect(netsuite.getLocationOnHand).not.toHaveBeenCalled();
    expect(netsuite.createInventoryTransfer).not.toHaveBeenCalled();
  });
});

describe('once inventory transfers are switched on', () => {
  beforeEach(() => switchOn(true));

  it('lets admins use them, and nobody else in', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });
    expect((await get('')).status).toBe(200);
    state.admin = false;
    expect((await get('')).status).toBe(403);
    expect((await post(SAVE)).status).toBe(403);
    expect(rpcNames()).toEqual([]);
  });

  it("finds active parts NetSuite keeps stock of, by the search rule every search box uses, with NetSuite's count of each", async () => {
    const found = await (await get('q=brk')).json();
    expect(found.items.map((i: { number: string }) => i.number)).toEqual(['BRK-100', 'BRK-200']);
    expect(found.items[0]).toEqual({ id: '501', number: 'BRK-100', name: 'Bracket kit', type: 'InvtPart', active: true });
    expect(found.counts).toEqual({ 501: { 1: 10, 7: 2 } });
    expect(found.countsReadAt).toBe('2027-01-15T14:43:00Z');
    expect(state.searches).toEqual([partSearchOrFilter(['item_number'], ['display_name', 'description'], 'brk')]);
    // By name or description, and a part number typed without its dash.
    expect((await (await get('q=feet')).json()).items.map((i: { number: string }) => i.number)).toEqual(['WIRE-14']);
    expect((await (await get('q=brk100')).json()).items.map((i: { number: string }) => i.number)).toEqual(['BRK-100']);

    // Nothing for one letter, and what's typed never changes the search's shape.
    expect(await (await get('q=b')).json()).toEqual({ items: [], counts: {} });
    await get(`q=${encodeURIComponent(' brk%_,(x)\\ ')}`);
    expect(state.searches[3]).toBe(partSearchOrFilter(['item_number'], ['display_name', 'description'], 'brk x'));
    // What's typed past 60 characters isn't searched for.
    const long = `brk${'x'.repeat(61)}`;
    await get(`q=${long}`);
    expect(state.searches.at(-1)).toBe(partSearchOrFilter(['item_number'], ['display_name', 'description'], long.slice(0, 60)));
    state.admin = false;
    expect((await get('q=brk')).status).toBe(403);
  });

  it('saves a draft as typed, each item with its number, and refuses a company or day there is no such thing as', async () => {
    expect(await (await post(SAVE)).json()).toEqual({ success: true, updatedAt: '2027-01-16T10:00:01.000001+00:00' });
    expect(state.rpcs).toEqual([['inventory_transfer_save', {
      p: {
        id: NEW, company: 'BMG', tran_date: '2027-01-20', from_location_id: '1', to_location_id: '7', memo: ' Van restock ', by: STAFF,
        lines: [
          { item_netsuite_id: '501', item_number: 'BRK-100', quantity: 2 },
          { item_netsuite_id: '599', item_number: null, quantity: 1 },
          { item_netsuite_id: null, item_number: null, quantity: 0 },
        ],
      },
    }]]);
    expect(rowOf(NEW)).toMatchObject({ memo: 'Van restock', created_by: STAFF });
    // Half typed is fine for a draft.
    expect((await post({ ...SAVE, fromLocationId: null, toLocationId: null, memo: null, lines: [] })).status).toBe(200);
    expect(state.rpcs[1][1].p).toMatchObject({ from_location_id: '', to_location_id: '', memo: '', lines: [] });
    // A quantity a sum left a speck past four places is kept to four.
    expect((await post({ ...SAVE, lines: [{ itemId: '502', quantity: 0.1 + 0.2 }] })).status).toBe(200);
    expect(state.rpcs[2][1].p.lines).toEqual([{ item_netsuite_id: '502', item_number: 'WIRE-14', quantity: 0.3 }]);

    const company = await post({ ...SAVE, company: 'ACME' });
    expect(company.status).toBe(400);
    expect(await company.json()).toEqual({ error: "There's no company ACME in Books." });
    const day = await post({ ...SAVE, date: '2027-02-30' });
    expect(day.status).toBe(400);
    expect(await day.json()).toEqual({ error: "2027-02-30 isn't a day on the calendar." });

    const made = await post({ ...SAVE, id: MADE });
    expect(made.status).toBe(409);
    expect(await made.json()).toEqual({ error: "It wasn't saved. It's in NetSuite already.", status: 'made' });
    state.answers.inventory_transfer_save = () => ({ data: null, error: { message: 'inventory transfers: a transfer takes 100 lines at most' } });
    const refused = await post(SAVE);
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: 'inventory transfers: a transfer takes 100 lines at most' });
  });

  it('deletes a draft for whoever started it or a super admin, and nothing else', async () => {
    expect(await (await post({ action: 'delete', id: MADE })).json()).toEqual({ error: "Only a draft can be deleted. It's in NetSuite already." });
    rowOf(DRAFT).created_by = BOSS;
    const theirs = await post({ action: 'delete', id: DRAFT });
    expect(theirs.status).toBe(403);
    expect(await theirs.json()).toEqual({ error: 'Only whoever started a draft, or a super admin, can delete it.' });
    expect(logAudit).not.toHaveBeenCalled();

    // A super admin can delete anyone's.
    as(CRAIG, ['super_admin']);
    expect(await (await post({ action: 'delete', id: DRAFT })).json()).toEqual({ success: true });
    expect(state.tables.inventory_transfers.map((r) => r.id)).toEqual([MADE]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: CRAIG, table: 'inventory_transfers', recordId: DRAFT, action: 'delete',
      detail: { company: 'BMG', date: '2027-01-15', from: '1', to: '7', memo: 'Stock for the van', lines: 2 },
    });
    expect(await (await post({ action: 'delete', id: DRAFT })).json()).toEqual({ success: true, already: true });

    // Moved between the route reading it and deleting it: it stays.
    as(STAFF, ['admin']);
    state.tables.inventory_transfers.push(transfer(NEW));
    state.meanwhile = () => { rowOf(NEW).status = 'sending'; };
    const raced = await post({ action: 'delete', id: NEW });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toEqual({ error: "It wasn't deleted: Move was pressed on it just now." });
    expect(rowOf(NEW).status).toBe('sending');
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it("makes the transfer once in NetSuite, from its lines as they're kept, and keeps NetSuite's number", async () => {
    netsuite.findInventoryTransfer.mockResolvedValueOnce(null).mockResolvedValueOnce({ transferId: '9002', number: 'IT-13' });
    const res = await move();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, transferId: '9002', number: 'IT-13' });
    expect(rowOf(DRAFT)).toMatchObject({ status: 'made', sent_by: STAFF, netsuite_transfer_id: '9002', netsuite_number: 'IT-13', error: null });
    expect(rpcNames()).toEqual(['inventory_transfer_claim', 'inventory_transfer_made']);
    expect(state.rpcs[0][1]).toEqual({ p: { id: DRAFT, by: STAFF, updated_at: SEEN } });
    expect(netsuite.findInventoryTransfer).toHaveBeenNthCalledWith(1, `fleetsuite-it-${DRAFT}`);
    expect(netsuite.getLocationOnHand).toHaveBeenCalledWith('1', ['501', '502']);
    expect(netsuite.createInventoryTransfer).toHaveBeenCalledWith({
      subsidiaryId: '2', tranDate: '2027-01-15', memo: 'Stock for the van', externalId: `fleetsuite-it-${DRAFT}`,
      fromLocationId: '1', toLocationId: '7', lines: [{ itemId: '501', quantity: 4 }, { itemId: '502', quantity: 12.5 }],
    });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: STAFF, table: 'inventory_transfers', recordId: DRAFT, action: 'move',
      detail: {
        netsuite_transfer_id: '9002', company: 'BMG', date: '2027-01-15', from: "O'Fallon", to: 'Service van',
        lines: ['4 × BRK-100', '12.5 × WIRE-14'], found_in_netsuite: false,
      },
    });

    // Pressed again: it says what it made, and makes nothing.
    expect(await (await move()).json()).toEqual({ success: true, already: true, transferId: '9002', number: 'IT-13' });
    expect(netsuite.createInventoryTransfer).toHaveBeenCalledTimes(1);
  });

  it("names it by NetSuite's id when NetSuite doesn't say its number, and still answers when keeping it fails", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    netsuite.findInventoryTransfer.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('timeout'));
    state.answers.inventory_transfer_made = () => ({ data: null, error: { message: 'connection reset' } });
    expect(await (await move()).json()).toEqual({ success: true, transferId: '9002', number: null });
    expect(log.mock.calls.map((c) => c[0])).toEqual([`[inventory-transfers] transfer ${DRAFT} made as NetSuite transfer 9002 but not kept: connection reset`]);
    log.mockRestore();
  });

  it('moves nothing when it changed since, it was deleted, or its lines no longer make a transfer', async () => {
    const changed = await move(DRAFT, '2027-01-15T15:00:00Z');
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'It was changed since you opened it. Reload and check it, then press Move again. Nothing was moved.' });
    const gone = await move(NEW);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "There's no such transfer: it was deleted." });

    // The bracket kit stopped being active in NetSuite after the draft was saved.
    state.tables.netsuite_parts[0].is_active = false;
    const stale = await move();
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({
      error: "Line 1: BRK-100 isn't active in NetSuite. Nothing was moved.",
      problems: ["Line 1: BRK-100 isn't active in NetSuite."],
    });
    expect(rowOf(DRAFT)).toMatchObject({ status: 'draft', sent_by: null, error: "Line 1: BRK-100 isn't active in NetSuite." });
    state.tables.netsuite_parts[0].is_active = true;

    // A company with no NetSuite subsidiary sends nothing either.
    Object.assign(rowOf(DRAFT), { company: '1084', from_location_id: '20', to_location_id: '21' });
    const sub = await move();
    expect(sub.status).toBe(400);
    expect((await sub.json()).error).toBe("1084 Cool Springs has no NetSuite subsidiary in Books, so NetSuite can't take its transfers. Nothing was moved.");
    // Nor one the database won't take as whole.
    Object.assign(rowOf(DRAFT), { company: 'BMG', from_location_id: '1', to_location_id: '1' });
    expect((await move()).status).toBe(500);
    expect(rowOf(DRAFT).status).toBe('draft');

    expect(netsuite.findInventoryTransfer).not.toHaveBeenCalled();
    expect(netsuite.createInventoryTransfer).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("makes none when NetSuite has the transfer already, or can't say whether it has", async () => {
    netsuite.findInventoryTransfer.mockResolvedValueOnce({ transferId: '9003', number: 'IT-14' });
    expect(await (await move()).json()).toEqual({ success: true, already: true, transferId: '9003', number: 'IT-14' });
    expect(rowOf(DRAFT)).toMatchObject({ status: 'made', netsuite_transfer_id: '9003' });
    expect((logAudit as any).mock.calls[0][1].detail.found_in_netsuite).toBe(true);
    // Moved already: its count isn't read again.
    expect(netsuite.getLocationOnHand).not.toHaveBeenCalled();

    state.tables.inventory_transfers.push(transfer(NEW));
    netsuite.findInventoryTransfer.mockRejectedValueOnce(new Error('timeout'));
    const cant = await move(NEW);
    expect(cant.status).toBe(502);
    expect(await cant.json()).toEqual({ error: "Couldn't check NetSuite for this transfer (timeout). Nothing was moved. Try again." });
    expect(rowOf(NEW)).toMatchObject({ status: 'draft', error: "Couldn't check NetSuite for this transfer (timeout)." });
    expect(netsuite.createInventoryTransfer).not.toHaveBeenCalled();
  });

  it('never moves more than NetSuite has where it moves from', async () => {
    netsuite.getLocationOnHand.mockResolvedValueOnce(new Map([['501', 3], ['502', 12.5]]));
    const short = await move();
    expect(short.status).toBe(409);
    expect(await short.json()).toEqual({ error: "NetSuite has 3 of BRK-100 at O'Fallon now, fewer than the 4 moving. Nothing was moved." });
    expect(rowOf(DRAFT)).toMatchObject({ status: 'draft', error: "NetSuite has 3 of BRK-100 at O'Fallon now, fewer than the 4 moving." });

    // One NetSuite has none of there counts as none.
    netsuite.getLocationOnHand.mockResolvedValueOnce(new Map([['501', 4]]));
    expect((await (await move()).json()).error).toBe("NetSuite has 0 of WIRE-14 at O'Fallon now, fewer than the 12.5 moving. Nothing was moved.");

    netsuite.getLocationOnHand.mockRejectedValueOnce(new Error('timeout'));
    const cant = await move();
    expect(cant.status).toBe(502);
    expect(await cant.json()).toEqual({ error: "Couldn't read NetSuite's count at O'Fallon (timeout). Nothing was moved. Try again." });
    expect(netsuite.createInventoryTransfer).not.toHaveBeenCalled();

    // Exactly what's there moves.
    netsuite.getLocationOnHand.mockResolvedValueOnce(new Map([['501', 4], ['502', 12.5]]));
    expect((await move()).status).toBe(200);
  });

  it("lets go when NetSuite refuses it, and holds it when NetSuite can't tell whether it made it", async () => {
    netsuite.createInventoryTransfer.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): The period is closed.' });
    const refused = await move();
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: 'NetSuite error (400): The period is closed.' });
    expect(rowOf(DRAFT)).toMatchObject({ status: 'draft', error: 'NetSuite error (400): The period is closed.' });

    netsuite.createInventoryTransfer.mockResolvedValueOnce({ success: false, error: 'NetSuite error (503): Busy', unsure: true });
    const unsure = await move();
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({
      error: "NetSuite error (503): Busy FleetSuite can't tell whether NetSuite made it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.",
      unsure: true,
    });
    expect(rowOf(DRAFT)).toMatchObject({ status: 'sending', error: 'NetSuite error (503): Busy' });

    // Made by another press just before it's held: it stays made, with nothing said against it.
    Object.assign(rowOf(DRAFT), { status: 'draft', sent_at: null, error: null });
    netsuite.createInventoryTransfer.mockResolvedValueOnce({ success: false, error: 'NetSuite error (503): Busy', unsure: true });
    state.meanwhile = () => { Object.assign(rowOf(DRAFT), { status: 'made', netsuite_transfer_id: '9005' }); };
    expect((await move()).status).toBe(502);
    expect(rowOf(DRAFT)).toMatchObject({ status: 'made', netsuite_transfer_id: '9005', error: null });

    // Made with no id said is refused like any other.
    Object.assign(rowOf(DRAFT), { status: 'draft', sent_at: null, netsuite_transfer_id: null });
    netsuite.createInventoryTransfer.mockResolvedValueOnce({ success: true });
    expect(await (await move()).json()).toEqual({ error: "NetSuite didn't make the transfer." });
    expect(rowOf(DRAFT).status).toBe('draft');
  });

  it("won't make it twice while a press is being made, and asks NetSuite what became of one left a while", async () => {
    as(CRAIG, ['admin']);
    Object.assign(rowOf(DRAFT), { status: 'sending', sent_by: BOSS, sent_at: new Date(Date.now() - 2 * 60_000).toISOString() });
    const now = await move();
    expect(now.status).toBe(409);
    expect(await now.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });
    expect(netsuite.findInventoryTransfer).not.toHaveBeenCalled();

    // Left a while: NetSuite made it, so it's kept as made, even going to a location the company no longer has.
    Object.assign(rowOf(DRAFT), { to_location_id: '9', sent_at: new Date(Date.now() - 6 * 60_000).toISOString() });
    netsuite.findInventoryTransfer.mockResolvedValueOnce({ transferId: '9004', number: 'IT-15' });
    expect(await (await move()).json()).toEqual({ success: true, already: true, transferId: '9004', number: 'IT-15' });
    expect(rowOf(DRAFT)).toMatchObject({ status: 'made', netsuite_transfer_id: '9004' });
    expect((logAudit as any).mock.calls[0][1].detail).toMatchObject({ from: "O'Fallon", to: 'location 9', found_in_netsuite: true });
    expect(netsuite.createInventoryTransfer).not.toHaveBeenCalled();

    // Or it didn't, and it's a draft again.
    Object.assign(rowOf(DRAFT), { status: 'sending', netsuite_transfer_id: null, sent_at: new Date(Date.now() - 6 * 60_000).toISOString() });
    const none = await move();
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: "NetSuite has no transfer from this press, so it's a draft again." });
    expect(rowOf(DRAFT)).toMatchObject({ status: 'draft', error: "NetSuite has no transfer from this press, so it's a draft again." });

    Object.assign(rowOf(DRAFT), { status: 'sending', sent_at: new Date(Date.now() - 6 * 60_000).toISOString() });
    netsuite.findInventoryTransfer.mockRejectedValueOnce(new Error('timeout'));
    const cant = await move();
    expect(cant.status).toBe(502);
    expect(await cant.json()).toEqual({ error: "Couldn't ask NetSuite what became of this transfer (timeout). Try again." });
    expect(rowOf(DRAFT).status).toBe('sending');
    expect(netsuite.createInventoryTransfer).not.toHaveBeenCalled();
  });

  it("refuses a body that isn't a transfer's ids, locations and quantities", async () => {
    for (const body of [
      { ...SAVE, id: 'not-an-id' }, { ...SAVE, date: '20/01/2027' }, { ...SAVE, company: '' },
      { ...SAVE, fromLocationId: "O'Fallon" }, { ...SAVE, toLocationId: 7 },
      { ...SAVE, lines: [{ itemId: '501', quantity: -1 }] },
      { ...SAVE, lines: [{ itemId: '501', quantity: 1_000_001 }] },
      { ...SAVE, lines: [{ itemId: '501', quantity: 0.00015 }] },
      { ...SAVE, lines: [{ itemId: 'BRK-100', quantity: 1 }] },
      { ...SAVE, memo: 'm'.repeat(301) },
      { ...SAVE, lines: Array.from({ length: 101 }, () => ({ itemId: '501', quantity: 1 })) },
      { action: 'move', id: DRAFT }, { action: 'move', id: 'x', updatedAt: SEEN }, { action: 'adjust', id: DRAFT },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(rpcNames()).toEqual([]);
  });
});
