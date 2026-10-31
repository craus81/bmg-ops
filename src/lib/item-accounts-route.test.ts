// /api/item-accounts (src/lib/item-accounts.ts): who can open it while item accounts are switched off and once
// they're on, finding an item, what the screen is told, and what one press of Save does: the change worked out again
// from the item as NetSuite has it now, nothing sent when the item changed since the page read it, sent to NetSuite
// once however often it's pressed, one change of an item at a time, NetSuite's refusal and an answer that never came
// told apart, and the new accounts noted in the copy of NetSuite's items. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const USER = 'p0000000-0000-4000-8000-000000000001';
  const state = {
    roles: ['admin'] as string[],
    features: new Set<string>(['vendor_payments']),
    seesMoney: true,
    tables: {} as Record<string, Record<string, any>[]>,
    calls: [] as Array<[string, Record<string, any>]>,
    /** Tables and functions that answer with an error. */
    failing: new Set<string>(),
    /** NetSuite's items, by 'inventoryItem:501'. */
    records: {} as Record<string, Record<string, any>>,
  };
  const netsuite = {
    getItemRecord: vi.fn(),
    patchItemRecordFields: vi.fn(),
    isSuiteqlError: vi.fn(() => false),
    suiteqlQueryAll: vi.fn(),
  };
  const companies = [{ id: 'c1', code: 'BMG', name: 'BMG Fleet Installations', subsidiaryId: '1', locations: [] }];
  const acct = (id: string, number: string, name: string, type: string, companies: string[] = ['BMG']) => ({ id, number, name, type, companies });
  // The chart as readAccounts gives it for an item's kinds of account: none can use an account of another kind.
  const CHART = [
    acct('101', '40000', 'Sales', 'income'),
    acct('102', '4100', 'Install Labor', 'income'),
    acct('103', '49000', 'Other Income', 'other_income'),
    acct('104', '50000', 'Cost of Goods Sold', 'cost_of_goods_sold'),
    acct('105', '58000', 'Parts COGS', 'cost_of_goods_sold'),
    acct('106', '19000', 'Inventory Asset', 'other_current_asset'),
    acct('107', '10100', 'Checking', 'bank', []),
    acct('108', '60000', 'Shop Supplies', 'expense'),
    acct('110', '40500', 'Old Sales', 'income', []),
    acct('111', '40600', 'Sister Co Sales', 'income', ['1084']),
  ];
  const chart = () => new Map(CHART.map((a) => [a.id, { ...a, companies: [...a.companies] }]));

  const likeToRegex = (pattern: string) => new RegExp(`^${pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.')).join('.*')}$`, 'i');
  /** A column, or a field of a JSON column as PostgREST reads `details->>item_type`. */
  const valueOf = (r: Record<string, any>, c: string) => {
    const json = /^(\w+)->>(\w+)$/.exec(c);
    return json ? r[json[1]]?.[json[2]] ?? null : r[c];
  };
  // An in-memory stand-in for the tables the route reads.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    const sorts: Array<[string, boolean]> = [];
    let limit = Infinity;
    const rows = () => (state.tables[table] ??= []);
    const sorted = (list: Record<string, any>[]) => [...list].sort((a, b) => {
      for (const [c, ascending] of sorts) if (a[c] !== b[c]) return (a[c] < b[c] ? -1 : 1) * (ascending ? 1 : -1);
      return 0;
    });
    const run = () => (state.failing.has(table)
      ? { data: null, error: { message: `${table} can't be read` } }
      : { data: sorted(rows().filter((r) => filters.every((f) => f(r)))).slice(0, limit).map((r) => structuredClone(r)), error: null });
    const ilike = (c: string, pattern: string) => (r: Record<string, any>) => likeToRegex(pattern).test(String(valueOf(r, c) ?? ''));
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => valueOf(r, c) === v); return builder; },
      is: (c: string, v: unknown) => { filters.push((r) => (valueOf(r, c) ?? null) === v); return builder; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(valueOf(r, c))); return builder; },
      ilike: (c: string, pattern: string) => { filters.push(ilike(c, pattern)); return builder; },
      or: (spec: string) => {
        const either = spec.split(',').map((part) => {
          const [, c, op, v] = /^([\w>-]+)\.(\w+)\.(.*)$/.exec(part)!;
          if (op !== 'ilike') throw new Error(`the stand-in doesn't know .or(${op})`);
          return ilike(c, v);
        });
        filters.push((r) => either.some((f) => f(r)));
        return builder;
      },
      order: (c: string, o: { ascending?: boolean } = {}) => { sorts.push([c, o.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }
  // What migrations 473 and 478's functions, and the lists' apply, do, in memory.
  const changes = () => (state.tables.detail_changes ??= []);
  const rpcs: Record<string, (p: Record<string, any>) => unknown> = {
    detail_change_claim: (p) => {
      const mine = changes().find((r) => r.id === p.id);
      if (mine && (mine.record_type !== p.record_type || mine.netsuite_id !== p.netsuite_id)) {
        throw new Error(`detail changes: ${p.id} is a change of another record`);
      }
      if (mine && (mine.status === 'changed' || mine.status === 'sending')) return { claimed: false, state: mine.status };
      if (changes().some((r) => r.record_type === p.record_type && r.netsuite_id === p.netsuite_id && r.status === 'sending')) {
        return { claimed: false, state: 'busy' };
      }
      const row = {
        id: p.id, record_type: p.record_type, netsuite_id: p.netsuite_id, name: p.name, reason: p.reason, changes: p.changes, patch: p.patch,
        status: 'sending', error: null, created_by: p.by, created_at: '2026-12-02T15:00:00Z',
      };
      if (mine) Object.assign(mine, row); else changes().push(row);
      return { claimed: true };
    },
    detail_change_finish: (p) => {
      const mine = changes().find((r) => r.id === p.id && r.status === 'sending');
      if (mine) Object.assign(mine, { status: p.status, error: p.error ?? null });
      return { finished: !!mine };
    },
    gl_netsuite_lists_apply: (p) => {
      for (const row of p.rows) {
        const have = (state.tables.gl_netsuite_lists ?? []).find((r) => r.kind === p.kind && r.netsuite_id === row.netsuite_id);
        if (have) Object.assign(have, structuredClone(row));
      }
      return { changed: p.rows.length };
    },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: { p: Record<string, any> }) => {
      state.calls.push([fn, structuredClone(args.p)]);
      if (state.failing.has(fn)) return { data: null, error: { message: `${fn} didn't answer` } };
      try {
        return { data: rpcs[fn](args.p), error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
  return { USER, state, netsuite, service, rpcs, companies, chart, CHART };
});

vi.mock('@/lib/api-auth', () => ({
  requireFeature: vi.fn(async (_req: unknown, feature: string) => (h.state.features.has(feature)
    ? { user: { id: h.USER }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
  profileCanSeeMoney: vi.fn(async () => h.state.seesMoney),
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/books/snap-a-bill', () => ({
  readCompanies: vi.fn(async () => h.companies),
  readAccounts: vi.fn(async () => h.chart()),
}));

const { USER, state, netsuite } = h;

import * as route from '../app/api/item-accounts/route';
import { requireFeature } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { readAccounts, readCompanies } from '@/lib/books/snap-a-bill';
import { ITEM_ACCOUNT_KINDS } from '@/lib/item-accounts';

/** 51-2002, an inventory item, its cost of goods sold and inventory asset accounts swapped at set-up. */
const HITCH = {
  id: '501', itemId: '51-2002', displayName: 'Hitch ball mount', isInactive: false,
  incomeAccount: { id: '101', refName: 'Sales' },
  cogsAccount: { id: '106', refName: '19000 Inventory Asset' },
  assetAccount: { id: '105', refName: '58000 Parts COGS' },
};
/** 06-2000, a non-inventory item only bought, filed under the third record type tried. */
const TOWELS = { id: '502', itemId: '06-2000', displayName: 'Shop towels', isInactive: false, expenseAccount: { id: '108', refName: 'Shop Supplies' } };
/** 30-1000, a kit. */
const KIT = { id: '503', itemId: '30-1000', displayName: 'Wiring kit', isInactive: 'F', incomeAccount: { id: '101', refName: 'Sales' } };

const itemRow = (id: string, name: string, itemType: string, over: Record<string, any> = {}) => ({
  kind: 'item', netsuite_id: id, name, parent_netsuite_id: null, active: true, gone_at: null, details: { item_type: itemType }, ...over,
});
const COPY = () => [
  itemRow('501', '51-2002', 'InvtPart', { details: { item_type: 'InvtPart', display_name: 'Hitch ball mount', income_account: '101', asset_account: '105' } }),
  itemRow('502', '06-2000', 'NonInvtPart', { details: { item_type: 'NonInvtPart', display_name: 'Shop towels', expense_account: '108' } }),
  itemRow('503', '30-1000', 'Kit', { details: { item_type: 'Kit', display_name: 'Wiring kit', income_account: '101' } }),
  itemRow('504', 'DISC-10', 'Discount'),
  itemRow('505', '51-2010', 'InvtPart', { active: false, details: { item_type: 'InvtPart', display_name: 'Hitch pin' } }),
  itemRow('506', '51-2002-OLD', 'InvtPart', { gone_at: '2026-11-01T00:00:00Z' }),
  itemRow('9999', '99-9999', 'InvtPart'),
  { kind: 'customer', netsuite_id: '501', name: 'Hitch Haulers', parent_netsuite_id: null, active: true, gone_at: null, details: {} },
];
const REQUEST = 'd0000000-0000-4000-8000-000000000001';
const OFF = 'Changing item accounts is switched off until January 1, 2027.';
const SWAPPED = ['Cost of goods sold account 19000 Inventory Asset → 58000 Parts COGS', 'Inventory asset account 58000 Parts COGS → 19000 Inventory Asset'];

const request = (path: string, body?: Record<string, unknown>) => new NextRequest(`https://app.test${path}`, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const get = (query: string) => route.GET(request(`/api/item-accounts?${query}`));
const post = (body: Record<string, unknown>) => route.POST(request('/api/item-accounts', body));
const signature = async (id = '501') => (await (await get(`item=${id}`)).json()).signature as string;
/** Swaps 51-2002's two accounts back. */
const SWAP = async () => ({
  requestId: REQUEST, itemId: '501', signature: await signature(), reason: '  Swapped at set-up ', accounts: { cogsAccount: '105', assetAccount: '106' },
});

const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'item_accounts', is_on: on }, { piece: 'customer_vendor_details', is_on: !on }]; };

beforeEach(() => {
  state.roles = ['admin'];
  state.features = new Set(['vendor_payments']);
  state.seesMoney = true;
  state.records = {
    'inventoryItem:501': structuredClone(HITCH), 'nonInventoryPurchaseItem:502': structuredClone(TOWELS), 'kitItem:503': structuredClone(KIT),
  };
  state.tables = { gl_netsuite_lists: COPY(), profiles: [{ id: USER, full_name: 'Sam Example' }] };
  switchOn(false);
  state.calls.length = 0;
  state.failing = new Set();
  vi.clearAllMocks();
  netsuite.getItemRecord.mockImplementation(async (types: string[], id: string) => {
    for (const type of types) {
      const rec = state.records[`${type}:${id}`];
      if (rec) return { success: true, recordType: type, record: structuredClone(rec) };
    }
    return { success: false, error: `NetSuite has no item with id ${id}.`, notFound: true };
  });
  // NetSuite takes the change: the item reads back with it.
  netsuite.patchItemRecordFields.mockImplementation(async (type: string, id: string, body: Record<string, { id: string }>) => {
    const rec = state.records[`${type}:${id}`];
    for (const [field, account] of Object.entries(body)) rec[field] = { id: account.id, refName: h.CHART.find((a) => a.id === account.id)?.name };
    return { success: true };
  });
});

afterEach(() => vi.restoreAllMocks());

describe('while item accounts are switched off', () => {
  it("shows Item Accounts to super admins only, and never to someone who can't see prices", async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.roles = ['super_admin'];
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true });
    state.seesMoney = false;
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    expect(requireFeature).toHaveBeenCalledWith(expect.anything(), 'vendor_payments');
    state.features = new Set(['credit_applications']);
    expect((await get('status=1')).status).toBe(403);
    expect((await get('item=501')).status).toBe(403);
    expect((await post({ requestId: REQUEST })).status).toBe(403);
  });

  it('lets a super admin see what a change would send, and nobody else', async () => {
    const refused = await get('item=501');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: OFF, switchedOff: true });
    expect(await (await get('find=hitch')).json()).toEqual({ error: OFF, switchedOff: true });
    expect(netsuite.getItemRecord).not.toHaveBeenCalled();

    state.roles = ['super_admin'];
    const res = await get('item=501');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      item: {
        id: '501', recordType: 'inventoryItem', number: '51-2002', displayName: 'Hitch ball mount', inactive: false,
        accounts: {
          incomeAccount: { id: '101', name: 'Sales' }, cogsAccount: { id: '106', name: '19000 Inventory Asset' }, assetAccount: { id: '105', name: '58000 Parts COGS' },
        },
      },
      chart: h.CHART.filter((a) => a.companies.includes('BMG')),
      signature: expect.stringMatching(/^[0-9a-f]{32}$/),
      changes: [],
      switchedOn: false,
      offText: `${OFF} You can see what a change would send; nothing goes to NetSuite.`,
    });
    expect(netsuite.getItemRecord).toHaveBeenCalledWith(['inventoryItem'], '501');
    expect(readCompanies).toHaveBeenCalledWith(h.service);
    expect(readAccounts).toHaveBeenCalledWith(h.service, h.companies, ITEM_ACCOUNT_KINDS);

    state.seesMoney = false;
    const hidden = await get('item=501');
    expect(hidden.status).toBe(403);
    expect(await hidden.json()).toEqual({ error: 'Forbidden: this account cannot see billing' });
  });

  it('sends nothing to NetSuite, even for a super admin', async () => {
    state.roles = ['super_admin'];
    const res = await post(await SWAP());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true });
    state.roles = ['admin'];
    expect(await (await post(await SWAP())).json()).toEqual({ error: OFF, switchedOff: true });
    expect(netsuite.patchItemRecordFields).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });
});

describe('once item accounts are switched on', () => {
  beforeEach(() => switchOn(true));

  it('lets anyone with Payments who sees prices use it', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });
    state.roles = ['office'];
    expect(await (await get('item=501')).json()).toMatchObject({ switchedOn: true, offText: null });
    state.seesMoney = false;
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: false });
    expect((await get('item=501')).status).toBe(403);
    expect((await post(await SWAP())).status).toBe(403);
    expect(netsuite.patchItemRecordFields).not.toHaveBeenCalled();
  });

  it("finds items in the copy of NetSuite's items by number or display name, active ones first, of the kinds changed here", async () => {
    const found = async (typed: string) => (await (await get(`find=${encodeURIComponent(typed)}`)).json()).items;
    expect(await found('hitch')).toEqual([
      { id: '501', number: '51-2002', displayName: 'Hitch ball mount', active: true },
      { id: '505', number: '51-2010', displayName: 'Hitch pin', active: false },
    ]);
    const ids = async (typed: string) => ((await found(typed)) as Array<{ id: string }>).map((i) => i.id);
    expect(await ids('51-20')).toEqual(['501', '505']);
    expect(await ids('HITCH, ball')).toEqual(['501']);
    expect(await ids('ball hitch')).toEqual([]);
    expect(await ids('towels')).toEqual(['502']);
    expect(await ids('disc')).toEqual([]);
    expect(await ids('')).toEqual(['502', '503', '501', '9999', '505']);
    expect(await ids('%')).toEqual(['502', '503', '501', '9999', '505']);
    expect((await found('99-9999'))[0]).toEqual({ id: '9999', number: '99-9999', displayName: null, active: true });

    state.tables.gl_netsuite_lists.push(...Array.from({ length: 20 }, (_, i) => itemRow(String(7000 + i), `77-${String(i).padStart(2, '0')}`, 'Service')));
    const many = await found('77');
    expect(many).toHaveLength(15);
    expect(many[0].number).toBe('77-00');

    state.failing = new Set(['gl_netsuite_lists']);
    const unread = await get('find=hitch');
    expect(unread.status).toBe(500);
    expect(await unread.json()).toEqual({ error: "couldn't search the copy of NetSuite's items (gl_netsuite_lists can't be read)" });
  });

  it("says when an item can't be opened here, and why", async () => {
    for (const query of ['item=50a', 'item=', '']) {
      const bad = await get(query);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'Bad item id' });
    }
    const uncopied = await get('item=8888');
    expect(uncopied.status).toBe(404);
    expect(await uncopied.json()).toEqual({ error: "Item 8888 isn't in the copy of NetSuite's items yet. The copy catches up every two hours." });
    expect((await get('item=506')).status).toBe(404);
    const discount = await get('item=504');
    expect(discount.status).toBe(400);
    expect(await discount.json()).toEqual({
      error: "DISC-10 is a kind of item whose accounts aren't changed here: only an inventory item, an assembly, a kit, a non-inventory item, a service or an other charge is.",
    });
    expect(netsuite.getItemRecord).not.toHaveBeenCalled();
    const missing = await get('item=9999');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'NetSuite has no item with id 9999.' });
    netsuite.getItemRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite took too long to answer' });
    const slow = await get('item=501');
    expect(slow.status).toBe(502);
    expect(await slow.json()).toEqual({ error: 'NetSuite took too long to answer' });

    state.failing = new Set(['gl_netsuite_lists']);
    const unread = await get('item=501');
    expect(unread.status).toBe(500);
    expect(await unread.json()).toEqual({ error: "couldn't read the copy of NetSuite's items (gl_netsuite_lists can't be read)" });
    state.failing = new Set(['detail_changes']);
    expect(await (await get('item=501')).json()).toEqual({ error: "detail_changes can't be read" });
    state.failing = new Set();
    vi.mocked(readAccounts).mockRejectedValueOnce(new Error("couldn't read the accounts (gl_accounts can't be read)"));
    expect(await (await get('item=501')).json()).toEqual({ error: "couldn't read the accounts (gl_accounts can't be read)" });
  });

  it('reads each item under its own record type, and shows the accounts it has whatever they are', async () => {
    const towels = await (await get('item=502')).json();
    expect(netsuite.getItemRecord).toHaveBeenCalledWith(['nonInventoryResaleItem', 'nonInventorySaleItem', 'nonInventoryPurchaseItem'], '502');
    expect(towels.item).toEqual({
      id: '502', recordType: 'nonInventoryPurchaseItem', number: '06-2000', displayName: 'Shop towels', inactive: false,
      accounts: { expenseAccount: { id: '108', name: 'Shop Supplies' } },
    });
    expect((await (await get('item=503')).json()).item.recordType).toBe('kitItem');

    state.records['inventoryItem:501'].incomeAccount = { id: '110', refName: 'Old Sales' };
    state.records['inventoryItem:501'].assetAccount = { id: '107', refName: 'Checking' };
    const shown = (await (await get('item=501')).json()).chart.map((a: { id: string }) => a.id);
    expect(shown).toEqual(['101', '102', '103', '104', '105', '106', '107', '108', '110']);
  });

  it("changes the item's accounts in NetSuite once, notes them in the copy, and lists the change", async () => {
    const form = await SWAP();
    const res = await post(form);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, changes: SWAPPED });
    const sent = { cogsAccount: { id: '105' }, assetAccount: { id: '106' } };
    expect(netsuite.patchItemRecordFields).toHaveBeenCalledWith('inventoryItem', '501', sent);
    expect(state.calls).toEqual([
      ['detail_change_claim', {
        id: REQUEST, record_type: 'item', netsuite_id: '501', name: '51-2002', reason: 'Swapped at set-up', changes: SWAPPED, patch: sent, by: USER,
      }],
      ['detail_change_finish', { id: REQUEST, status: 'changed' }],
      ['gl_netsuite_lists_apply', {
        kind: 'item',
        rows: [{
          netsuite_id: '501', name: '51-2002', parent_netsuite_id: null, active: true,
          details: { item_type: 'InvtPart', display_name: 'Hitch ball mount', income_account: '101', asset_account: '106' },
        }],
      }],
    ]);
    expect(state.tables.gl_netsuite_lists.find((r) => r.kind === 'item' && r.netsuite_id === '501')?.details)
      .toEqual({ item_type: 'InvtPart', display_name: 'Hitch ball mount', income_account: '101', asset_account: '106' });
    expect(state.tables.gl_netsuite_lists.find((r) => r.kind === 'customer')?.details).toEqual({});
    expect(state.tables.detail_changes).toEqual([expect.objectContaining({ id: REQUEST, status: 'changed', error: null })]);
    expect(logAudit).toHaveBeenCalledWith(h.service, {
      actorId: USER, table: 'detail_changes', recordId: REQUEST, action: 'change_item_accounts',
      detail: { netsuite_item_id: '501', item: '51-2002', kind: 'Inventory item', changes: SWAPPED, sent },
    });

    // The same form pressed again: NetSuite's item changed since that page read it, so nothing goes.
    const again = await post(form);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: '51-2002 changed in NetSuite since this page opened. Nothing was sent. Reload it and make the change again.', stale: true,
    });
    const redone = await post(await SWAP());
    expect(redone.status).toBe(400);
    expect(await redone.json()).toEqual({ error: 'Nothing has changed yet.', problems: ['Nothing has changed yet.'] });
    expect(netsuite.patchItemRecordFields).toHaveBeenCalledTimes(1);

    // Its own changes, not those of the customer NetSuite gives the same id.
    state.tables.detail_changes.push({
      id: 'd0000000-0000-4000-8000-000000000009', record_type: 'customer', netsuite_id: '501', reason: 'New terms', changes: ['Terms Net 30 → Net 45'],
      status: 'changed', error: null, created_by: null, created_at: '2026-12-03T15:00:00Z',
    });
    expect((await (await get('item=501')).json()).changes).toEqual([{
      id: REQUEST, at: '2026-12-02T15:00:00Z', by: 'Sam Example', reason: 'Swapped at set-up', changes: SWAPPED, status: 'changed', error: null,
    }]);
  });

  it('notes in the copy only the accounts it keeps, under the record type the item was read as', async () => {
    const cogs = await post({ requestId: REQUEST, itemId: '501', signature: await signature(), reason: 'Parts cost', accounts: { cogsAccount: '104' } });
    expect(cogs.status).toBe(200);
    expect(state.calls.map(([fn]) => fn)).toEqual(['detail_change_claim', 'detail_change_finish']);

    state.calls.length = 0;
    const second = 'd0000000-0000-4000-8000-000000000002';
    const towels = await post({ requestId: second, itemId: '502', signature: await signature('502'), reason: 'Shop costs', accounts: { expenseAccount: '104' } });
    expect(await towels.json()).toEqual({ success: true, changes: ['Expense account 60000 Shop Supplies → 50000 Cost of Goods Sold'] });
    expect(netsuite.patchItemRecordFields).toHaveBeenLastCalledWith('nonInventoryPurchaseItem', '502', { expenseAccount: { id: '104' } });
    expect(state.calls[2]).toEqual(['gl_netsuite_lists_apply', {
      kind: 'item',
      rows: [{ netsuite_id: '502', name: '06-2000', parent_netsuite_id: null, active: true, details: { item_type: 'NonInvtPart', display_name: 'Shop towels', expense_account: '104' } }],
    }]);
    expect(logAudit).toHaveBeenLastCalledWith(h.service, expect.objectContaining({
      recordId: second, detail: expect.objectContaining({ kind: 'Non-inventory item for purchase', item: '06-2000' }),
    }));

    state.calls.length = 0;
    const kit = await post({ requestId: 'd0000000-0000-4000-8000-000000000003', itemId: '503', signature: await signature('503'), reason: 'Labor', accounts: { incomeAccount: '102' } });
    expect(kit.status).toBe(200);
    expect(state.calls[2][1].rows[0].details).toEqual({ item_type: 'Kit', display_name: 'Wiring kit', income_account: '102' });
  });

  it("finishes the change when the copy can't take the new accounts, or it can't be marked changed", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.failing = new Set(['gl_netsuite_lists_apply']);
    const res = await post(await SWAP());
    expect(res.status).toBe(200);
    expect(state.tables.detail_changes[0]).toMatchObject({ status: 'changed' });
    expect(error).toHaveBeenCalledWith("[item accounts] couldn't note 501's new accounts in the copy of NetSuite's items: gl_netsuite_lists_apply didn't answer");
    expect(logAudit).toHaveBeenCalledTimes(1);

    // Marking it changed failing is said in the log; the change is in NetSuite either way.
    state.failing = new Set(['detail_change_finish']);
    const second = 'd0000000-0000-4000-8000-000000000002';
    const kitForm = { requestId: second, itemId: '503', signature: await signature('503'), reason: 'Labor', accounts: { incomeAccount: '102' } };
    state.tables.gl_netsuite_lists = state.tables.gl_netsuite_lists.filter((r) => r.netsuite_id !== '503');
    state.tables.gl_netsuite_lists.push(itemRow('503', '30-1000', 'Kit', { gone_at: '2026-12-01T00:00:00Z' }));
    // Gone from the copy after the page opened: the press can't be worked out.
    expect((await post(kitForm)).status).toBe(404);
    state.tables.gl_netsuite_lists.push(itemRow('503', '30-1000', 'Kit'));
    state.calls.length = 0;
    const marked = await post(kitForm);
    expect(marked.status).toBe(200);
    expect(error).toHaveBeenCalledWith(`[item accounts] ${second} went in but wasn't marked changed: detail_change_finish didn't answer`);
    expect(state.calls.map(([fn]) => fn)).toEqual(['detail_change_claim', 'detail_change_finish', 'gl_netsuite_lists_apply']);
  });

  it("sends nothing when the item changed since the page opened, the change has a problem, or the form isn't one", async () => {
    const stale = await post({ ...(await SWAP()), signature: 'not-what-netsuite-has-now' });
    expect(stale.status).toBe(409);
    expect((await stale.json()).stale).toBe(true);
    const wrongKind = await post({ ...(await SWAP()), accounts: { assetAccount: '107' } });
    expect(wrongKind.status).toBe(400);
    expect(await wrongKind.json()).toEqual({
      error: "10100 Checking is a bank account: an item's inventory asset account is a current asset account.",
      problems: ["10100 Checking is a bank account: an item's inventory asset account is a current asset account."],
    });
    const twoProblems = await post({ ...(await SWAP()), reason: '', accounts: { expenseAccount: '108' } });
    expect(await twoProblems.json()).toEqual({
      error: "An inventory item has no expense account. Say why it's being changed.",
      problems: ['An inventory item has no expense account.', "Say why it's being changed."],
    });
    expect((await post({ ...(await SWAP()), accounts: { incomeAccount: '111' } })).status).toBe(400);
    for (const body of [
      { requestId: 'not-a-uuid' }, { itemId: '50a' }, { itemId: '' }, { signature: '' }, { reason: 'r'.repeat(1001) },
      { accounts: { cogs: '105' } }, { accounts: { cogsAccount: 'acct-105' } }, { accounts: { cogsAccount: 105 } },
    ]) {
      const res = await post({ ...(await SWAP()), ...body });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Invalid request');
    }
    expect(netsuite.patchItemRecordFields).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it("says what couldn't be read, and sends nothing", async () => {
    const form = await SWAP();
    state.failing = new Set(['detail_change_claim']);
    const claim = await post(form);
    expect(claim.status).toBe(500);
    expect(await claim.json()).toEqual({ error: "detail_change_claim didn't answer" });
    state.failing = new Set(['gl_netsuite_lists']);
    const unread = await post(form);
    expect(unread.status).toBe(500);
    expect(await unread.json()).toEqual({ error: "couldn't read the copy of NetSuite's items (gl_netsuite_lists can't be read)" });
    state.failing = new Set();
    vi.mocked(readAccounts).mockRejectedValueOnce(new Error("couldn't read the accounts (gl_accounts can't be read)"));
    const chartless = await post(form);
    expect(chartless.status).toBe(500);
    expect(await chartless.json()).toEqual({ error: "couldn't read the accounts (gl_accounts can't be read)" });
    netsuite.getItemRecord.mockResolvedValueOnce({ success: false, error: 'gone', notFound: true });
    const gone = await post(form);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'NetSuite has no item with id 501.' });
    netsuite.getItemRecord.mockResolvedValueOnce({ success: false, error: "Couldn't reach NetSuite: fetch failed" });
    expect((await post(form)).status).toBe(502);
    expect(netsuite.patchItemRecordFields).not.toHaveBeenCalled();
  });

  it("says what an earlier press did, and doesn't send it twice", async () => {
    // NetSuite not showing the change yet, the same form pressed again is the same change.
    netsuite.patchItemRecordFields.mockResolvedValue({ success: true });
    const form = await SWAP();
    expect((await post(form)).status).toBe(200);
    const same = await post(form);
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ success: true, already: true, changes: SWAPPED });
    expect(netsuite.patchItemRecordFields).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it('sends one change of an item at a time', async () => {
    state.tables.detail_changes = [{ id: 'd0000000-0000-4000-8000-000000000009', record_type: 'item', netsuite_id: '501', status: 'sending' }];
    const busy = await post(await SWAP());
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'Another change of 51-2002 is being sent now. Reload it in a minute and check it before changing it again.' });
    state.tables.detail_changes = [{ id: REQUEST, record_type: 'item', netsuite_id: '501', status: 'sending' }];
    const pressed = await post(await SWAP());
    expect(pressed.status).toBe(409);
    expect(await pressed.json()).toEqual({ error: "This change is being sent now. Don't press again: reload the item in a minute to see it." });
    // A claim that doesn't say it was taken sends nothing.
    state.tables.detail_changes = [];
    vi.spyOn(h.rpcs, 'detail_change_claim').mockReturnValue(null);
    expect(await (await post(await SWAP())).json()).toEqual({
      error: 'Another change of 51-2002 is being sent now. Reload it in a minute and check it before changing it again.',
    });
    expect(netsuite.patchItemRecordFields).not.toHaveBeenCalled();
  });

  it("lets the same form try again when NetSuite refused, and says when it can't tell whether the change went in", async () => {
    netsuite.patchItemRecordFields.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): Invalid value for cogsAccount. ' });
    const refused = await post(await SWAP());
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "NetSuite didn't take the change: NetSuite error (400): Invalid value for cogsAccount. Nothing changed." });
    expect(state.tables.detail_changes[0]).toMatchObject({ status: 'refused', error: 'NetSuite error (400): Invalid value for cogsAccount. ' });
    expect(state.calls[1]).toEqual(['detail_change_finish', { id: REQUEST, status: 'refused', error: 'NetSuite error (400): Invalid value for cogsAccount. ' }]);
    expect(state.calls).toHaveLength(2);
    expect(logAudit).not.toHaveBeenCalled();

    netsuite.patchItemRecordFields.mockResolvedValueOnce({ success: false });
    expect(await (await post(await SWAP())).json()).toEqual({ error: "NetSuite didn't take the change: NetSuite didn't answer. Nothing changed." });

    netsuite.patchItemRecordFields.mockResolvedValueOnce({ success: false, error: 'NetSuite took too long to answer', unsure: true });
    const unsure = await post(await SWAP());
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({
      error: "NetSuite took too long to answer, so FleetSuite can't tell whether the change went in. Reload the item: if the change is there, it went in; if it isn't, make it again.",
      unsure: true,
    });
    expect(state.tables.detail_changes[0]).toMatchObject({ status: 'unsure', error: 'NetSuite took too long to answer' });

    const retried = await post(await SWAP());
    expect(retried.status).toBe(200);
    expect(state.tables.detail_changes).toHaveLength(1);
    expect(state.tables.detail_changes[0]).toMatchObject({ status: 'changed', error: null });
    expect(netsuite.patchItemRecordFields).toHaveBeenCalledTimes(4);

    // A press of one item's form can't stand for another's.
    const borrowed = await post({ requestId: REQUEST, itemId: '503', signature: await signature('503'), reason: 'Labor', accounts: { incomeAccount: '102' } });
    expect(borrowed.status).toBe(500);
    expect(await borrowed.json()).toEqual({ error: `detail changes: ${REQUEST} is a change of another record` });
    expect(netsuite.patchItemRecordFields).toHaveBeenCalledTimes(4);
  });
});
