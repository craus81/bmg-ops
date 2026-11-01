// /api/inventory/adjust and /api/inventory/adjust/approvals with approving
// adjustments (src/lib/inventory-adjust-approvals.ts, migration 494): Adjust
// posts at once while it's switched off, asks for approval once it's on, and
// does neither for a part with one open or when it can't tell; an ask is
// worked out against NetSuite's live count and kept once; a super admin who
// didn't ask approves it, which posts it as the change worked out then, and
// what NetSuite answers decides what's kept; it's turned down with why,
// withdrawn by whoever asked, or settled by hand. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const JESSIE = 'a0000000-0000-4000-8000-000000000002';
const ASK = 'c0000000-0000-4000-8000-000000000001';
const ASK2 = 'c0000000-0000-4000-8000-000000000002';
const ASK3 = 'c0000000-0000-4000-8000-000000000003';
const PRESS = 'c0000000-0000-4000-8000-000000000009';
const HITCH = 'b0000000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => {
  const state = {
    userId: '',
    name: '' as string | null,
    roles: [] as string[],
    admin: true,
    switchOn: false,
    switchError: null as string | null,
    tables: {} as Record<string, Record<string, any>[]>,
    failing: {} as Record<string, string>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    answers: {} as Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }>,
  };
  const adjust = {
    adjustInventory: vi.fn(),
    adjustLocationId: vi.fn(async () => '1'),
    liveLocationStock: vi.fn(async () => ({ onHand: 7, available: 5 })),
  };
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    let limit = Infinity;
    let statuses = '';
    const run = () => {
      // Failing for the whole table, or (as 'table:status,status') for one list of statuses.
      const failed = state.failing[table] ?? state.failing[`${table}:${statuses}`];
      if (failed) return { data: null, error: { message: failed } };
      const rows = (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return { data: rows.slice(0, limit).map((r) => ({ ...r })), error: null };
    };
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      in: (c: string, vs: unknown[]) => {
        if (c === 'status') statuses = vs.join(',');
        filters.push((r) => vs.includes(r[c]));
        return builder;
      },
      order: () => builder,
      limit: (n: number) => { limit = n; return builder; },
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
      state.rpcs.push([fn, args.p]);
      const answer = state.answers[fn];
      return answer ? answer(args.p) : { data: null, error: { message: `nothing answers ${fn}` } };
    },
  };
  return { state, adjust, service };
});

vi.mock('@/lib/api-auth', () => ({
  requireAdmin: vi.fn(async () => (h.state.admin
    ? { user: { id: h.state.userId }, profile: { roles: h.state.roles, full_name: h.state.name } }
    : { user: { id: h.state.userId }, profile: { roles: h.state.roles }, error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/inventory-adjust', async () => ({ ...(await vi.importActual('@/lib/inventory-adjust-shared')), ...h.adjust }));
vi.mock('@/lib/books/switches', () => ({
  readSwitch: vi.fn(async (_service: unknown, piece: string) => {
    expect(piece).toBe('adjustment_approvals');
    if (h.state.switchError) throw new Error(h.state.switchError);
    return h.state.switchOn;
  }),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));

const { state, adjust } = h;

import { logAudit } from '@/lib/audit';
import { GET as getAdjust, POST as postAdjust } from '../app/api/inventory/adjust/route';
import { GET as getApprovals, POST as postApprovals } from '../app/api/inventory/adjust/approvals/route';

/** An ask as the table keeps it: Jessie's, taking two damaged hitch receivers off seven. */
const row = (over: Record<string, unknown> = {}) => ({
  id: ASK, part_id: HITCH, netsuite_item_id: '5512', item_number: 'HX-2200', location_id: '1', mode: 'delta', entered_qty: -2,
  on_hand_then: 7, change: -2, reason: 'Damaged', note: 'Box crushed', status: 'waiting', asked_by: JESSIE, asked_by_name: 'Jessie',
  asked_at: '2027-04-06T14:00:00Z', sent_by_name: null, sent_at: null, decided_by_name: null, decided_at: null, why: null,
  netsuite_adjustment_number: null, error: null, warning: null, ...over,
});
const answer = (data: unknown) => () => ({ data, error: null });

const getReq = (url: string) => new NextRequest(`http://localhost${url}`);
const postReq = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const adjustBody = (over: Record<string, unknown> = {}) => ({ netsuiteId: '5512', mode: 'delta', qty: -2, reason: 'Damaged', note: ' Box crushed ', askId: PRESS, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  state.userId = JESSIE;
  state.name = 'Jessie';
  state.roles = ['admin'];
  state.admin = true;
  state.switchOn = false;
  state.switchError = null;
  state.tables = {
    netsuite_parts: [{ id: HITCH, netsuite_id: '5512', item_number: 'HX-2200', item_type: 'InvtPart', display_name: 'Hitch receiver' }],
    inventory_adjustments: [],
    inventory_adjustment_asks: [],
  };
  state.failing = {};
  state.rpcs = [];
  state.answers = {};
  adjust.adjustLocationId.mockImplementation(async () => '1');
  adjust.liveLocationStock.mockImplementation(async () => ({ onHand: 7, available: 5 }));
  adjust.adjustInventory.mockImplementation(async () => ({ ok: true, adjustmentNumber: 'INVADJ1042', change: -2, onHandBefore: 7, onHand: 5, available: 3 }));
});

describe('Adjust while approving adjustments is switched off', () => {
  it('posts at once, as it always has', async () => {
    const res = await postAdjust(postReq('/api/inventory/adjust', adjustBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, adjustmentNumber: 'INVADJ1042', onHand: 5 });
    expect(adjust.adjustInventory).toHaveBeenCalledWith(h.service, {
      netsuiteId: '5512', mode: 'delta', qty: -2, reason: 'Damaged', note: ' Box crushed ', userId: JESSIE, userName: 'Jessie',
    });
    expect(state.rpcs).toEqual([]);
    // A note is cut to 500 characters, as it always was.
    await postAdjust(postReq('/api/inventory/adjust', adjustBody({ note: 'x'.repeat(600) })));
    expect(adjust.adjustInventory.mock.calls.at(-1)![1].note).toBe('x'.repeat(500));
  });

  it('shows the pop-up whether it asks, and the part\'s last asks', async () => {
    state.tables.inventory_adjustment_asks = [row({ status: 'turned_down', why: 'Recount', decided_by_name: 'Craig', decided_at: '2027-04-06T15:00:00Z' })];
    const res = await getAdjust(getReq('/api/inventory/adjust?netsuiteId=5512'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ onHand: 7, available: 5, history: [], approvals: false, approvalsError: null });
    expect(json.asks).toEqual([expect.objectContaining({ id: ASK, status: 'turned_down', why: 'Recount', change: -2, mine: true })]);
    state.userId = CRAIG;
    expect((await (await getAdjust(getReq('/api/inventory/adjust?netsuiteId=5512'))).json()).asks[0].mine).toBe(false);

    // The last five only, and the same while NetSuite's count can't be read.
    state.tables.inventory_adjustment_asks = Array.from({ length: 6 }, (_, i) => row({
      id: `c0000000-0000-4000-8000-00000000010${i}`, status: 'withdrawn', decided_at: '2027-04-06T15:00:00Z',
    }));
    expect((await (await getAdjust(getReq('/api/inventory/adjust?netsuiteId=5512'))).json()).asks).toHaveLength(5);
    adjust.liveLocationStock.mockImplementation(async () => { throw new Error('NetSuite is down'); });
    const down = await getAdjust(getReq('/api/inventory/adjust?netsuiteId=5512'));
    expect(down.status).toBe(502);
    const shown = await down.json();
    expect(shown).toMatchObject({ error: "Couldn't read the current count from NetSuite: NetSuite is down", approvals: false, approvalsError: null });
    expect(shown.asks).toHaveLength(5);
  });

  it("can't tell, so it says so and posts nothing", async () => {
    state.switchError = 'connection refused';
    const shown = await (await getAdjust(getReq('/api/inventory/adjust?netsuiteId=5512'))).json();
    expect(shown).toMatchObject({ approvals: null, approvalsError: "Couldn't tell whether adjustments need approval, so none can be made now: connection refused" });
    const res = await postAdjust(postReq('/api/inventory/adjust', adjustBody()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Couldn't tell whether adjustments need approval, so nothing was posted: connection refused");

    state.switchError = null;
    state.failing.inventory_adjustment_asks = 'timeout';
    expect(await (await getAdjust(getReq('/api/inventory/adjust?netsuiteId=5512'))).json())
      .toMatchObject({ approvals: null, approvalsError: "Couldn't read the adjustments asked for, so none can be made now: timeout", asks: [] });
    expect((await postAdjust(postReq('/api/inventory/adjust', adjustBody()))).status).toBe(503);
    // Neither read, it says the first.
    state.switchError = 'connection refused';
    expect((await (await getAdjust(getReq('/api/inventory/adjust?netsuiteId=5512'))).json()).approvalsError)
      .toBe("Couldn't tell whether adjustments need approval, so none can be made now: connection refused");
    expect(adjust.adjustInventory).not.toHaveBeenCalled();
  });

  it('posts nothing for a part with one open, switched on or off', async () => {
    state.tables.inventory_adjustment_asks = [row({ status: 'unsure', sent_at: '2027-04-06T15:00:00Z' })];
    for (const on of [false, true]) {
      state.switchOn = on;
      const res = await postAdjust(postReq('/api/inventory/adjust', adjustBody({ qty: 3, reason: 'Found' })));
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe(
        "HX-2200 has an adjustment that NetSuite didn't say whether it took, asked by Jessie: Take 2 away · 7 on hand then → 5. "
        + "It's approved, turned down or withdrawn on Adjustments to approve before another can be made.",
      );
      expect(json.open).toMatchObject({ id: ASK, mine: true });
    }
    // Someone else's open one isn't theirs to withdraw.
    state.userId = CRAIG;
    expect((await (await postAdjust(postReq('/api/inventory/adjust', adjustBody()))).json()).open).toMatchObject({ id: ASK, mine: false });
    // Decided ones don't hold it.
    state.switchOn = false;
    state.tables.inventory_adjustment_asks = [row({ status: 'made', sent_at: '2027-04-06T15:00:00Z', decided_at: '2027-04-06T15:00:00Z' })];
    expect((await postAdjust(postReq('/api/inventory/adjust', adjustBody()))).status).toBe(200);
    expect(adjust.adjustInventory).toHaveBeenCalledTimes(1);
  });

  it('refuses a part without a NetSuite id before reading anything', async () => {
    const res = await postAdjust(postReq('/api/inventory/adjust', adjustBody({ netsuiteId: 'HX-2200' })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('This part has no NetSuite id.');
  });
});

describe('Adjust once approving adjustments is switched on', () => {
  beforeEach(() => {
    state.switchOn = true;
    state.answers.inventory_adjustment_ask = (p) => ({ data: { state: 'asked', ask: row({ id: p.id, note: p.note }) }, error: null });
  });

  it('asks instead, worked out against NetSuite\'s count now, and posts nothing', async () => {
    const res = await postAdjust(postReq('/api/inventory/adjust', adjustBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ asked: true, ask: { id: PRESS, status: 'waiting', change: -2 }, onHand: 7, available: 5 });
    expect(state.rpcs).toEqual([['inventory_adjustment_ask', {
      id: PRESS, by: JESSIE, by_name: 'Jessie', part_id: HITCH, netsuite_item_id: '5512', item_number: 'HX-2200', location_id: '1',
      mode: 'delta', entered_qty: -2, on_hand_then: 7, reason: 'Damaged', note: 'Box crushed',
    }]]);
    expect(adjust.liveLocationStock).toHaveBeenCalledWith('5512', '1');
    expect(adjust.adjustInventory).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(h.service, {
      actorId: JESSIE, table: 'inventory_adjustment_asks', recordId: PRESS, action: 'ask',
      detail: { item_number: 'HX-2200', mode: 'delta', change: -2, reason: 'Damaged' },
    });
  });

  it('keeps a press sent twice once, and says when the shelf has one already', async () => {
    state.answers.inventory_adjustment_ask = answer({ state: 'same', ask: row({ id: PRESS }) });
    const same = await postAdjust(postReq('/api/inventory/adjust', adjustBody()));
    expect(same.status).toBe(200);
    expect((await same.json()).asked).toBe(true);
    expect(logAudit).not.toHaveBeenCalled();

    state.answers.inventory_adjustment_ask = answer({ state: 'waiting', ask: row({ asked_by: CRAIG, asked_by_name: 'Craig' }) });
    const waiting = await postAdjust(postReq('/api/inventory/adjust', adjustBody()));
    expect(waiting.status).toBe(409);
    const json = await waiting.json();
    expect(json.error).toMatch(/^HX-2200 has an adjustment waiting for approval, asked by Craig: Take 2 away/);
    expect(json.open).toMatchObject({ id: ASK, mine: false });

    // A press without an id of its own still gets one.
    state.answers.inventory_adjustment_ask = (p) => ({ data: { state: 'asked', ask: row({ id: p.id }) }, error: null });
    await postAdjust(postReq('/api/inventory/adjust', adjustBody({ askId: 'press-1' })));
    expect(state.rpcs.at(-1)![1].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(state.rpcs.at(-1)![1].id).not.toBe(PRESS);
  });

  it("checks it as Adjust does, and asks nothing it can't post", async () => {
    const refused = async (body: Record<string, unknown>, status: number, error: string) => {
      const res = await postAdjust(postReq('/api/inventory/adjust', adjustBody(body)));
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(error);
    };
    await refused({ reason: 'Stolen' }, 400, 'Pick a reason.');
    await refused({ mode: 'set' }, 400, 'Unknown entry type.');
    await refused({ netsuiteId: '9999' }, 404, "That part isn't in FleetSuite's parts list.");
    await refused({ qty: 1.5 }, 400, 'Enter a whole number.');
    await refused({ qty: -8 }, 400, "That would leave -1 on hand. NetSuite can't go below 0. Check the count.");
    await refused({ mode: 'count', qty: 7 }, 400, 'NetSuite already shows 7 on hand. Nothing to adjust.');
    adjust.liveLocationStock.mockImplementation(async () => ({ onHand: 9.5, available: 9.5 }));
    await refused({ mode: 'count', qty: 12 }, 400,
      "NetSuite shows 9.5 on hand, which isn't a whole number, so a shelf count can't be asked for. Add or remove a whole number instead.");
    adjust.liveLocationStock.mockImplementation(async () => { throw new Error('NetSuite is down'); });
    await refused({}, 502, "Couldn't read the current count from NetSuite: NetSuite is down");
    state.tables.netsuite_parts[0].item_type = 'NonInvtPart';
    await refused({}, 400, "HX-2200 isn't an inventory item in NetSuite, so it has no stock to adjust.");
    state.failing.netsuite_parts = 'denied';
    await refused({}, 500, "Couldn't read the parts list: denied");
    expect(state.rpcs).toEqual([]);

    state.failing = {};
    state.tables.netsuite_parts[0].item_type = 'InvtPart';
    adjust.liveLocationStock.mockImplementation(async () => ({ onHand: 7, available: 5 }));
    state.answers.inventory_adjustment_ask = () => ({ data: null, error: { message: 'check constraint' } });
    await refused({}, 500, "Couldn't keep the adjustment asked for: check constraint");

    // A part the parts list has no type for is asked for, as Adjust would post it.
    state.answers.inventory_adjustment_ask = (p) => ({ data: { state: 'asked', ask: row({ id: p.id }) }, error: null });
    state.tables.netsuite_parts[0].item_type = null;
    expect((await postAdjust(postReq('/api/inventory/adjust', adjustBody()))).status).toBe(200);
    expect(adjust.adjustInventory).not.toHaveBeenCalled();
  });

  it('works a shelf count out as the count less NetSuite\'s count', async () => {
    await postAdjust(postReq('/api/inventory/adjust', adjustBody({ mode: 'count', qty: 12, note: '' })));
    expect(state.rpcs[0][1]).toMatchObject({ mode: 'count', entered_qty: 12, on_hand_then: 7, note: null });
  });

  it('asks at the location Adjust posts at, with the note cut to 500 characters', async () => {
    adjust.adjustLocationId.mockImplementation(async () => '7');
    await postAdjust(postReq('/api/inventory/adjust', adjustBody({ note: `  ${'x'.repeat(600)}` })));
    expect(adjust.liveLocationStock).toHaveBeenLastCalledWith('5512', '7');
    expect(state.rpcs.at(-1)![1]).toMatchObject({ location_id: '7', note: 'x'.repeat(498) });
  });
});

describe('Adjustments to approve', () => {
  beforeEach(() => {
    state.userId = CRAIG;
    state.name = 'Craig';
    state.roles = ['super_admin'];
    state.answers.inventory_adjustment_claim = (p) => ({
      data: { state: 'claimed', ask: row({ status: 'sending', sent_by: p.by, sent_by_name: p.by_name, sent_at: '2027-04-07T14:00:00Z' }) }, error: null,
    });
    state.answers.inventory_adjustment_made = answer({ made: true });
    state.answers.inventory_adjustment_let_go = answer({ let_go: true });
    state.answers.inventory_adjustment_unsure = answer({ unsure: true });
  });
  const act = (body: Record<string, unknown>) => postApprovals(postReq('/api/inventory/adjust/approvals', { id: ASK, ...body }));
  const said = async (res: Response) => ({ status: res.status, ...(await res.json()) });

  it('tells the Inventory page how many are open, and lists them with the decided ones', async () => {
    state.tables.inventory_adjustment_asks = [
      row(), row({ id: PRESS, status: 'made', sent_at: 'x', decided_at: '2027-04-06T16:00:00Z', decided_by_name: 'Craig', part_id: null }),
      row({ id: ASK2, status: 'turned_down', why: 'Recount', decided_at: '2027-04-06T15:00:00Z' }),
      row({ id: ASK3, status: 'withdrawn', decided_at: '2027-04-06T14:30:00Z' }),
    ];
    expect(await said(await getApprovals(getReq('/api/inventory/adjust/approvals?status=1')))).toEqual({ status: 200, on: false, open: 1, canApprove: true });
    state.switchError = 'down';
    state.roles = ['admin'];
    expect(await said(await getApprovals(getReq('/api/inventory/adjust/approvals?status=1')))).toEqual({ status: 200, on: null, open: 1, canApprove: false });
    state.switchError = null;
    const list = await said(await getApprovals(getReq('/api/inventory/adjust/approvals')));
    expect(list).toMatchObject({ status: 200, on: false, superAdmin: false, me: CRAIG });
    expect(list.open).toEqual([expect.objectContaining({ id: ASK, displayName: 'Hitch receiver', status: 'waiting' })]);
    expect(list.decided).toEqual([
      expect.objectContaining({ id: PRESS, displayName: null, status: 'made' }),
      expect.objectContaining({ id: ASK2, displayName: 'Hitch receiver', status: 'turned_down', why: 'Recount' }),
      expect.objectContaining({ id: ASK3, status: 'withdrawn' }),
    ]);
    const failed = async (url: string, failing: Record<string, string>, error: string) => {
      state.failing = failing;
      expect(await said(await getApprovals(getReq(url)))).toEqual({ status: 500, error: `Couldn't read the adjustments asked for: ${error}` });
    };
    await failed('/api/inventory/adjust/approvals', { inventory_adjustment_asks: 'timeout' }, 'timeout');
    await failed('/api/inventory/adjust/approvals', { 'inventory_adjustment_asks:waiting,sending,unsure': 'open timeout' }, 'open timeout');
    await failed('/api/inventory/adjust/approvals', { 'inventory_adjustment_asks:made,turned_down,withdrawn': 'decided timeout' }, 'decided timeout');
    await failed('/api/inventory/adjust/approvals?status=1', { 'inventory_adjustment_asks:waiting,sending,unsure': 'open timeout' }, 'open timeout');
    await failed('/api/inventory/adjust/approvals', { netsuite_parts: 'denied' }, "couldn't read the parts list (denied)");
  });

  it('posts one a super admin who didn\'t ask approves, as the change worked out when it was asked', async () => {
    adjust.adjustInventory.mockImplementation(async () => ({ ok: true, adjustmentNumber: 'INVADJ1042', change: -2, onHandBefore: 6, onHand: 4, available: 2 }));
    expect(await said(await act({ action: 'approve' }))).toEqual({ status: 200, made: true, adjustmentNumber: 'INVADJ1042', onHand: 4, available: 2 });
    expect(adjust.adjustInventory).toHaveBeenCalledWith(h.service, {
      netsuiteId: '5512', mode: 'delta', qty: -2, reason: 'Damaged', note: 'Box crushed', userId: JESSIE, userName: 'Jessie, approved by Craig',
    });
    expect(state.rpcs).toEqual([
      ['inventory_adjustment_claim', { id: ASK, by: CRAIG, by_name: 'Craig' }],
      ['inventory_adjustment_made', { id: ASK, netsuite_number: 'INVADJ1042', warning: null }],
    ]);
    expect(logAudit).toHaveBeenCalledWith(h.service, expect.objectContaining({
      actorId: CRAIG, recordId: ASK, action: 'approve', detail: { item_number: 'HX-2200', mode: 'delta', change: -2, reason: 'Damaged', netsuite_number: 'INVADJ1042' },
    }));

    // Whoever asked gone, it's the approver's; posted but not kept, it says so.
    state.answers.inventory_adjustment_claim = answer({ state: 'claimed', ask: row({ status: 'sending', asked_by: null, asked_by_name: null }) });
    state.answers.inventory_adjustment_made = answer({ made: false });
    adjust.adjustInventory.mockImplementation(async () => ({ ok: true, adjustmentNumber: null, change: -2, onHandBefore: 7, onHand: 5, available: 3, warning: 'history' }));
    expect(await said(await act({ action: 'approve' }))).toMatchObject({
      status: 200, made: true, warning: 'NetSuite posted it, but someone had settled it meanwhile. Check it on Adjustments to approve.',
    });
    expect(adjust.adjustInventory).toHaveBeenLastCalledWith(h.service, expect.objectContaining({ userId: CRAIG, userName: 'Someone, approved by Craig' }));
    expect(state.rpcs.at(-1)).toEqual(['inventory_adjustment_made', { id: ASK, netsuite_number: null, warning: 'history' }]);
    state.answers.inventory_adjustment_made = () => ({ data: null, error: { message: 'down' } });
    expect((await said(await act({ action: 'approve' }))).warning)
      .toBe("NetSuite posted it, but FleetSuite couldn't keep that (down). Five minutes after it was approved, say it's in NetSuite on Adjustments to approve.");
  });

  it('posts a shelf count as the change worked out when it was asked', async () => {
    state.answers.inventory_adjustment_claim = answer({
      state: 'claimed',
      ask: row({ status: 'sending', mode: 'count', entered_qty: 12, on_hand_then: 9, change: 3, reason: 'Count correction', note: null }),
    });
    expect((await act({ action: 'approve' })).status).toBe(200);
    expect(adjust.adjustInventory).toHaveBeenCalledWith(h.service, expect.objectContaining({ mode: 'delta', qty: 3, reason: 'Count correction', note: null }));
  });

  it("doesn't post one it can't claim", async () => {
    const cases: Array<[string, number, string]> = [
      ['own', 403, "You asked for this one, so a super admin who didn't ask approves it."],
      ['gone', 404, "That adjustment isn't there any more."],
      ['sending', 409, "It's being posted to NetSuite already."],
      ['unsure', 409, "It was posted, but NetSuite didn't say whether it took it. Check NetSuite, then say whether it's there."],
      ['made', 409, "It's made in NetSuite already."],
      ['turned_down', 409, 'It was turned down already.'],
      ['withdrawn', 409, 'It was withdrawn already.'],
    ];
    for (const [claimed, status, error] of cases) {
      state.answers.inventory_adjustment_claim = answer({ state: claimed, ask: row() });
      expect(await said(await act({ action: 'approve' }))).toEqual({ status, error });
    }
    expect(adjust.adjustInventory).not.toHaveBeenCalled();
  });

  it('puts one NetSuite refused back to wait, and keeps one it can\'t tell about', async () => {
    adjust.adjustInventory.mockImplementation(async () => ({ ok: false, status: 400, error: "That would leave -1 on hand. NetSuite can't go below 0. Check the count." }));
    expect(await said(await act({ action: 'approve' }))).toEqual({
      status: 400, error: "That would leave -1 on hand. NetSuite can't go below 0. Check the count. Nothing was posted, and it's waiting for approval again.",
    });
    expect(state.rpcs.at(-1)).toEqual(['inventory_adjustment_let_go', { id: ASK, error: "That would leave -1 on hand. NetSuite can't go below 0. Check the count." }]);
    adjust.adjustInventory.mockImplementation(async () => ({ ok: false, status: 502, error: 'NetSuite refused the adjustment (400): Invalid account' }));
    expect(await said(await act({ action: 'approve' }))).toEqual({
      status: 502, error: 'NetSuite refused the adjustment (400): Invalid account. Nothing was posted, and it\'s waiting for approval again.',
    });
    state.answers.inventory_adjustment_let_go = () => ({ data: null, error: { message: 'down' } });
    expect(await said(await act({ action: 'approve' }))).toEqual({
      status: 502,
      error: "NetSuite refused the adjustment (400): Invalid account. Nothing was posted, but FleetSuite couldn't put it back to wait. "
        + "Five minutes after it was approved, say it isn't in NetSuite on Adjustments to approve.",
    });
    expect(logAudit).not.toHaveBeenCalled();

    for (const error of ["Couldn't reach NetSuite: fetch failed", 'NetSuite refused the adjustment (503): Service Unavailable']) {
      adjust.adjustInventory.mockImplementation(async () => ({ ok: false, status: 502, error }));
      expect(await said(await act({ action: 'approve' }))).toEqual({
        status: 502, unsure: true,
        error: `${error}. NetSuite may have posted it. Check NetSuite's inventory adjustments for HX-2200, then say whether it's there.`,
      });
      expect(state.rpcs.at(-1)).toEqual(['inventory_adjustment_unsure', { id: ASK, error }]);
    }
    adjust.adjustInventory.mockImplementation(async () => { throw new Error('socket hang up'); });
    state.answers.inventory_adjustment_unsure = answer({ unsure: false });
    expect(await said(await act({ action: 'approve' }))).toEqual({
      status: 502, unsure: true,
      error: "Couldn't reach NetSuite: socket hang up. NetSuite may have posted it. Check NetSuite's inventory adjustments for HX-2200, then say whether it's there once five minutes have passed.",
    });
    state.answers.inventory_adjustment_unsure = () => ({ data: null, error: { message: 'down' } });
    expect((await said(await act({ action: 'approve' }))).error).toMatch(/then say whether it's there once five minutes have passed\.$/);
    expect(logAudit).toHaveBeenCalledWith(h.service, expect.objectContaining({
      actorId: CRAIG, recordId: ASK, action: 'approve_unsure', detail: { item_number: 'HX-2200', mode: 'delta', change: -2, reason: 'Damaged' },
    }));
  });

  it('turns one down with why, or lets whoever asked withdraw it', async () => {
    expect(await said(await act({ action: 'turn_down' }))).toEqual({ status: 400, error: 'Say why it is turned down.' });
    expect(await said(await act({ action: 'turn_down', why: '   ' }))).toEqual({ status: 400, error: 'Say why it is turned down.' });
    expect(await said(await act({ action: 'turn_down', why: 'x'.repeat(301) }))).toEqual({ status: 400, error: 'Keep why to 300 characters.' });
    state.answers.inventory_adjustment_turn_down = answer({ state: 'own', ask: row() });
    expect(await said(await act({ action: 'turn_down', why: 'No' }))).toEqual({ status: 403, error: 'You asked for this one, so withdraw it instead.' });
    state.answers.inventory_adjustment_turn_down = (p) => ({ data: { state: 'turned_down', ask: row({ status: 'turned_down', why: p.why, decided_at: 'x' }) }, error: null });
    expect(await said(await act({ action: 'turn_down', why: '  Count the shelf again  ' }))).toMatchObject({ status: 200, ask: { status: 'turned_down', why: 'Count the shelf again' } });
    expect(state.rpcs.at(-1)).toEqual(['inventory_adjustment_turn_down', { id: ASK, by: CRAIG, by_name: 'Craig', why: 'Count the shelf again' }]);
    expect(logAudit).toHaveBeenCalledWith(h.service, expect.objectContaining({
      actorId: CRAIG, recordId: ASK, action: 'turn_down',
      detail: { item_number: 'HX-2200', mode: 'delta', change: -2, reason: 'Damaged', why: 'Count the shelf again' },
    }));
    expect((await act({ action: 'turn_down', why: 'x'.repeat(300) })).status).toBe(200);
    state.answers.inventory_adjustment_turn_down = () => ({ data: null, error: { message: 'connection lost' } });
    expect(await said(await act({ action: 'turn_down', why: 'No' }))).toEqual({ status: 500, error: 'connection lost' });

    // Withdrawing is whoever asked's, admin or not.
    state.userId = JESSIE;
    state.name = 'Jessie';
    state.roles = ['admin'];
    expect(await said(await act({ action: 'turn_down', why: 'No' }))).toEqual({ status: 403, error: 'Only a super admin approves, turns down or settles an adjustment.' });
    expect(await said(await act({ action: 'approve' }))).toMatchObject({ status: 403 });
    state.answers.inventory_adjustment_withdraw = answer({ state: 'not_yours', ask: row() });
    expect(await said(await act({ action: 'withdraw' }))).toEqual({ status: 403, error: 'Only whoever asked withdraws it. A super admin turns it down instead.' });
    state.answers.inventory_adjustment_withdraw = answer({ state: 'withdrawn', ask: row({ status: 'withdrawn', decided_at: 'x' }) });
    expect(await said(await act({ action: 'withdraw' }))).toMatchObject({ status: 200, ask: { status: 'withdrawn' } });
    expect(state.rpcs.at(-1)).toEqual(['inventory_adjustment_withdraw', { id: ASK, by: JESSIE, by_name: 'Jessie' }]);
    expect(logAudit).toHaveBeenLastCalledWith(h.service, expect.objectContaining({
      actorId: JESSIE, recordId: ASK, action: 'withdraw', detail: { item_number: 'HX-2200', mode: 'delta', change: -2, reason: 'Damaged' },
    }));
    expect(adjust.adjustInventory).not.toHaveBeenCalled();
  });

  it('settles one NetSuite didn\'t say about, by hand', async () => {
    expect(await said(await act({ action: 'settle' }))).toEqual({ status: 400, error: "Say whether it's in NetSuite." });
    expect(await said(await act({ action: 'settle', made: true, number: 'x'.repeat(61) }))).toEqual({ status: 400, error: "Keep NetSuite's number to 60 characters." });
    state.answers.inventory_adjustment_settle = answer({ state: 'not_yet', ask: row({ status: 'sending' }) });
    expect(await said(await act({ action: 'settle', made: false }))).toEqual({
      status: 409, error: "It's still being posted. If it's still stuck five minutes after it was approved, say then whether it's in NetSuite.",
    });
    state.answers.inventory_adjustment_settle = answer({ state: 'made', ask: row({ status: 'made' }) });
    expect(await said(await act({ action: 'settle', made: false }))).toEqual({ status: 409, error: "It's made in NetSuite already." });
    state.answers.inventory_adjustment_settle = answer({ state: 'waiting', ask: row() });
    expect(await said(await act({ action: 'settle', made: true }))).toEqual({ status: 409, error: "It's waiting for approval, so there's nothing to settle." });
    expect(logAudit).not.toHaveBeenCalled();
    state.answers.inventory_adjustment_settle = (p) => ({
      data: { state: 'made', settled: true, ask: row({ status: 'made', netsuite_adjustment_number: p.netsuite_number }) }, error: null,
    });
    expect(await said(await act({ action: 'settle', made: true, number: ' INVADJ1050 ' }))).toMatchObject({ status: 200, ask: { netsuiteNumber: 'INVADJ1050' } });
    expect(state.rpcs.at(-1)).toEqual(['inventory_adjustment_settle', { id: ASK, by: CRAIG, by_name: 'Craig', made: true, netsuite_number: 'INVADJ1050' }]);
    expect(logAudit).toHaveBeenLastCalledWith(h.service, expect.objectContaining({
      actorId: CRAIG, recordId: ASK, action: 'settle_made',
      detail: { item_number: 'HX-2200', mode: 'delta', change: -2, reason: 'Damaged', netsuite_number: 'INVADJ1050' },
    }));
    expect((await act({ action: 'settle', made: true, number: 'N'.repeat(60) })).status).toBe(200);
    state.answers.inventory_adjustment_settle = answer({ state: 'waiting', settled: true, ask: row({ error: 'Not in NetSuite, said Craig' }) });
    expect(await said(await act({ action: 'settle', made: false, number: '' }))).toMatchObject({ status: 200, ask: { status: 'waiting' } });
    expect(state.rpcs.at(-1)![1].netsuite_number).toBeNull();
    expect(logAudit).toHaveBeenLastCalledWith(h.service, expect.objectContaining({
      actorId: CRAIG, recordId: ASK, action: 'settle_not_made', detail: { item_number: 'HX-2200', mode: 'delta', change: -2, reason: 'Damaged' },
    }));
    expect(adjust.adjustInventory).not.toHaveBeenCalled();
  });

  it('refuses what it doesn\'t know', async () => {
    expect((await act({ action: 'post' })).status).toBe(400);
    expect((await postApprovals(postReq('/api/inventory/adjust/approvals', { action: 'approve', id: 'ask-1' }))).status).toBe(400);
    state.admin = false;
    expect((await act({ action: 'withdraw' })).status).toBe(403);
    expect((await getApprovals(getReq('/api/inventory/adjust/approvals'))).status).toBe(403);
    expect(state.rpcs).toEqual([]);
  });
});
