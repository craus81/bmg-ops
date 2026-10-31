// /api/purchasing/bill-fix (src/lib/bill-fix.ts): who can open it while
// fixing bills is switched off and once it's on, finding a bill, what the Fix
// screen is told of one, and what one press of Fix bill does: the fix worked
// out again from the bill as NetSuite has it now, nothing sent when the bill
// changed since the page read it or the vendor already has a bill of the
// number typed, sent to NetSuite once however often it's pressed, one fix of
// a bill at a time, NetSuite's refusal and an answer that never came told
// apart, and Books' own copy following with each part's purchase order line.
// Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const USER = 'p0000000-0000-4000-8000-000000000001';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    roles: ['admin'] as string[],
    hasPartsOrdering: true,
    seesMoney: true,
    tables: {} as Record<string, Record<string, any>[]>,
    calls: [] as Array<[string, Record<string, any>]>,
    /** Tables and functions that answer with an error. */
    failing: new Set<string>(),
    companies: [] as Array<Record<string, any>>,
  };
  const netsuite = {
    getVendorBillRecord: vi.fn(),
    getVendorBillAmounts: vi.fn(),
    patchVendorBill: vi.fn(),
    findVendorBill: vi.fn(),
    getOrderLineIds: vi.fn(),
  };
  const saveFixed = vi.fn();

  const likeToRegex = (pattern: string) => new RegExp(`^${pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.')).join('.*')}$`, 'i');
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
      : { data: sorted(rows().filter((r) => filters.every((f) => f(r)))).slice(0, limit).map((r) => ({ ...r })), error: null });
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return builder; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return builder; },
      // jsonb @>: every object asked for is in the row's list, with every field it names.
      contains: (c: string, v: string) => {
        const wanted = JSON.parse(v) as Array<Record<string, unknown>>;
        filters.push((r) => Array.isArray(r[c]) && wanted.every((w) => r[c].some((x: Record<string, unknown>) => Object.entries(w).every(([k, val]) => x?.[k] === val))));
        return builder;
      },
      or: (expr: string) => {
        const conds = expr.split(',').map((cond) => {
          const m = cond.match(/^(\w+)\.ilike\.(.*)$/);
          if (!m) throw new Error(`stand-in can't read ${cond}`);
          return (r: Record<string, any>) => likeToRegex(m[2]).test(String(r[m[1]] ?? ''));
        });
        filters.push((r) => conds.some((c) => c(r)));
        return builder;
      },
      order: (c: string, o: { ascending?: boolean } = {}) => { sorts.push([c, o.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }
  // What migration 472's functions do, in memory.
  const fixes = () => (state.tables.bill_fixes ??= []);
  const rpcs: Record<string, (p: Record<string, any>) => unknown> = {
    bill_fix_claim: (p) => {
      const mine = fixes().find((r) => r.id === p.id);
      if (mine && (mine.status === 'fixed' || mine.status === 'sending')) return { claimed: false, state: mine.status };
      if (fixes().some((r) => r.bill_netsuite_id === p.bill_netsuite_id && r.status === 'sending')) return { claimed: false, state: 'busy' };
      const row = {
        id: p.id, bill_netsuite_id: p.bill_netsuite_id, bill_number: p.bill_number, vendor_netsuite_id: p.vendor_netsuite_id,
        vendor_name: p.vendor_name, reason: p.reason, changes: p.changes, patch: p.patch, replace_lists: p.replace_lists,
        total_before_cents: p.total_before_cents, total_expected_cents: p.total_expected_cents, total_after_cents: null,
        status: 'sending', error: null, own_copy: null, own_copy_version: null, created_by: p.by, created_at: '2026-12-02T15:00:00Z',
      };
      if (mine) Object.assign(mine, row); else fixes().push(row);
      return { claimed: true };
    },
    bill_fix_finish: (p) => {
      const mine = fixes().find((r) => r.id === p.id && r.status === 'sending');
      if (mine) Object.assign(mine, { error: null, ...p, id: mine.id });
      return { finished: !!mine };
    },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: { p: Record<string, any> }) => {
      state.calls.push([fn, args.p]);
      if (state.failing.has(fn)) return { data: null, error: { message: `${fn} didn't answer` } };
      return { data: rpcs[fn](args.p), error: null };
    },
  };
  return { state, netsuite, saveFixed, service };
});

vi.mock('@/lib/api-auth', () => ({
  requireFeature: vi.fn(async (_req: unknown, feature: string) => (h.state.hasPartsOrdering && feature === 'parts_ordering'
    ? { user: { id: 'p0000000-0000-4000-8000-000000000001' }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
  profileCanSeeMoney: vi.fn(async () => h.state.seesMoney),
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/books/own-bills', () => ({ saveFixedOwnBill: h.saveFixed }));
vi.mock('@/lib/books/snap-a-bill', () => ({
  readCompanies: vi.fn(async () => h.state.companies),
  readAccounts: vi.fn(async () => new Map([
    ['610', { id: '610', number: '6100', name: 'Shop Supplies', type: 'Expense', companies: ['BMG', '1084'] }],
    ['620', { id: '620', number: '6200', name: 'Freight', type: 'Expense', companies: ['BMG'] }],
    ['630', { id: '630', number: '6300', name: 'Tools', type: 'Expense', companies: ['BMG'] }],
    ['640', { id: '640', number: '6400', name: 'Rent', type: 'Expense', companies: ['1084'] }],
    ['690', { id: '690', number: '900', name: 'Small tools', type: 'Expense', companies: ['BMG'] }],
  ])),
}));

const { state, netsuite, saveFixed } = h;

import { GET, POST } from '../app/api/purchasing/bill-fix/route';
import { requireFeature } from '@/lib/api-auth';
import { readAccounts } from '@/lib/books/snap-a-bill';
import { logAudit } from '@/lib/audit';

/** Bill B-100 from Acme Supply Co, billed off PO123: two expense lines, two shelves, NetSuite's subtotal and a light. */
const RECORD = {
  id: '3001', tranId: 'B-100', tranDate: '2026-12-01', dueDate: '2026-12-31', terms: { id: '2', refName: 'Net 30' },
  entity: { id: '4001', refName: 'Acme Supply Co' }, subsidiary: { id: '2', refName: 'BMG' }, location: { id: '1', refName: "O'Fallon" },
  memo: 'Shop supplies', createdFrom: { id: '2001', refName: 'Purchase Order #PO123' }, lastModifiedDate: '2026-12-01T15:04:05Z',
  userTotal: 545.1, status: { id: 'A', refName: 'Open' },
  expense: {
    items: [
      { line: 1, account: { id: '610', refName: '6100 Shop Supplies' }, amount: 200.05, memo: 'Gloves' },
      { line: 2, account: { id: '620', refName: '6200 Freight' }, amount: 45.05 },
    ],
  },
  item: {
    items: [
      { line: 1, item: { id: '55', refName: 'Racks : SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125, amount: 250, description: 'Shelf unit', orderDoc: { id: '2001' }, orderLine: 1 },
      { line: 2, item: { id: '-2', refName: 'Subtotal' }, itemType: 'Subtotal', amount: 250 },
      { line: 3, item: { id: '57', refName: 'LIGHT-2' }, itemType: 'InvtPart', quantity: 1, rate: 50, amount: 50, orderDoc: { id: '2001' }, orderLine: 2 },
    ],
  },
};
const AMOUNTS = { success: true, totalCents: 54510, owedCents: 54510, status: 'Bill : Open', voided: false };
/** The bill after the fix below: B-100A, with three shelves. */
const FIXED_RECORD = {
  ...RECORD, tranId: 'B-100A', lastModifiedDate: '2026-12-02T15:00:01Z', userTotal: 670.1,
  item: { items: [{ ...RECORD.item.items[0], quantity: 3, amount: 375 }, RECORD.item.items[1], RECORD.item.items[2]] },
};
const FIXED_AMOUNTS = { ...AMOUNTS, totalCents: 67010, owedCents: 67010 };
const COMPANIES = [
  { id: 'g1', code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }] },
  { id: 'g2', code: '1084', name: '1084 Cool Springs', subsidiaryId: '3', locations: [] },
];
const REQUEST = 'b0000000-0000-4000-8000-000000000001';

const get = (query: string) => GET(new NextRequest(`https://app.test/api/purchasing/bill-fix?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/purchasing/bill-fix', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const signature = async () => (await (await get('bill=3001')).json()).signature as string;
/** The vendor's number was typed wrong, and three shelves came, not two. */
const NUMBER_AND_SHELF = async () => ({
  requestId: REQUEST, billId: '3001', signature: await signature(), reason: 'Billed two, three came',
  header: { number: 'B-100A' }, lines: [{ list: 'item', line: 1, quantity: 3 }],
});
/** Only the memo, which nothing else hangs on. */
const MEMO = async () => ({ requestId: REQUEST, billId: '3001', signature: await signature(), reason: 'Memo says the month', header: { memo: 'Shop supplies, December' } });

const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'bill_fixes', is_on: on }, { piece: 'invoice_fixes', is_on: !on }]; };

beforeEach(() => {
  state.roles = ['admin'];
  state.hasPartsOrdering = true;
  state.seesMoney = true;
  state.companies = COMPANIES;
  state.tables = {
    gl_netsuite_lists: [{ kind: 'term', netsuite_id: '2', details: { days_until_net_due: 30 } }],
    gl_own_bills: [{ netsuite_id: '3001', version: 1, fixed_at: null }],
    profiles: [{ id: USER, full_name: 'Sam Example' }],
  };
  switchOn(false);
  state.calls.length = 0;
  state.failing = new Set();
  vi.clearAllMocks();
  netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: RECORD });
  netsuite.getVendorBillAmounts.mockResolvedValue(AMOUNTS);
  netsuite.findVendorBill.mockResolvedValue(null);
  netsuite.getOrderLineIds.mockImplementation(async (order: string) => new Map([[1, `9${order}1`], [2, `9${order}2`]]));
  netsuite.patchVendorBill.mockImplementation(async () => {
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: FIXED_RECORD });
    netsuite.getVendorBillAmounts.mockResolvedValue(FIXED_AMOUNTS);
    return { success: true };
  });
  saveFixed.mockResolvedValue({ saved: true, version: 2 });
});

afterEach(() => vi.restoreAllMocks());

describe('while fixing bills is switched off', () => {
  it("shows Fix a Bill to super admins only, and never to someone who can't see prices", async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    expect(requireFeature).toHaveBeenCalledWith(expect.anything(), 'parts_ordering');
    state.roles = ['super_admin'];
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true });
    state.seesMoney = false;
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.hasPartsOrdering = false;
    expect((await get('status=1')).status).toBe(403);
  });

  it('lets a super admin see what a fix would send, and nobody else', async () => {
    const refused = await get('bill=3001');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Fixing bills is switched off until January 1, 2027.', switchedOff: true });
    expect((await get('find=acme')).status).toBe(403);
    expect(netsuite.getVendorBillRecord).not.toHaveBeenCalled();

    state.roles = ['super_admin'];
    const res = await get('bill=3001');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      switchedOn: false,
      offText: 'Fixing bills is switched off until January 1, 2027. You can see what a fix would send; nothing goes to NetSuite.',
      bill: { id: '3001', number: 'B-100', vendorName: 'Acme Supply Co', totalCents: 54510, owedCents: 54510, dueDate: '2026-12-31', termsId: '2', poNumber: 'PO123' },
      allows: { header: true, lines: true, why: null },
      termsDays: 30,
      fixes: [],
      ownCopy: { version: 1, fixedAt: null },
    });
    expect(body.bill.lines).toHaveLength(5);
    expect(body.signature).toMatch(/^[0-9a-f]{32}$/);
    expect(netsuite.getVendorBillRecord).toHaveBeenCalledWith('3001');
    expect(netsuite.getVendorBillAmounts).toHaveBeenCalledWith('3001');

    state.seesMoney = false;
    const hidden = await get('bill=3001');
    expect(hidden.status).toBe(403);
    expect(await hidden.json()).toEqual({ error: 'Forbidden: this account cannot see billing' });

    // Nor to anyone without Parts Ordering.
    state.seesMoney = true;
    state.hasPartsOrdering = false;
    expect((await get('bill=3001')).status).toBe(403);
    expect((await post({ requestId: REQUEST })).status).toBe(403);
  });

  it('sends nothing to NetSuite, even for a super admin', async () => {
    state.roles = ['super_admin'];
    const res = await post(await NUMBER_AND_SHELF());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Fixing bills is switched off until January 1, 2027. Nothing was sent to NetSuite.', switchedOff: true });
    expect(netsuite.findVendorBill).not.toHaveBeenCalled();
    expect(netsuite.patchVendorBill).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
    expect(saveFixed).not.toHaveBeenCalled();
  });
});

describe('once fixing bills is switched on', () => {
  beforeEach(() => switchOn(true));

  it('lets admins with Parts Ordering who see prices use it, and nobody else', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });
    const res = await get('bill=3001');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ switchedOn: true, offText: null });
    state.roles = ['super_admin'];
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });

    state.roles = ['shop_tech'];
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: false });
    const tech = await get('bill=3001');
    expect(tech.status).toBe(403);
    expect(await tech.json()).toEqual({ error: 'Bills are fixed by admins.' });
    expect((await post({ requestId: REQUEST })).status).toBe(403);

    state.roles = ['admin'];
    state.seesMoney = false;
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: false });
    expect(await (await get('bill=3001')).json()).toEqual({ error: 'Forbidden: this account cannot see billing' });
    expect(netsuite.patchVendorBill).not.toHaveBeenCalled();
  });

  it("says when NetSuite has no such bill, or couldn't be read", async () => {
    const bad = await get('bill=30x1');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Bad bill id' });
    expect((await get('')).status).toBe(400);
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite 404: gone', notFound: true });
    const missing = await get('bill=3002');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'NetSuite has no bill with id 3002.' });
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite request timed out' });
    const slow = await get('bill=3001');
    expect(slow.status).toBe(502);
    expect(await slow.json()).toEqual({ error: 'NetSuite request timed out' });
    expect(netsuite.getVendorBillRecord).toHaveBeenLastCalledWith('3001');
  });

  it('finds bills in the copy of NetSuite\'s bills by number or vendor, newest first', async () => {
    const bill = (id: string, tranid: string | null, date: string, vendor: string, over: Record<string, unknown> = {}) => ({
      netsuite_id: id, tran_type: 'VendBill', tranid, trandate: date, vendor_name: vendor, total: '545.10', voided: false, gone_at: null, ...over,
    });
    state.tables.gl_netsuite_bills = [
      bill('3001', 'B-100', '2026-12-01', 'Acme Supply Co'),
      bill('3002', 'INV-77', '2026-12-03', 'Widget Works', { total: 19.99, voided: true }),
      bill('3003', null, '2026-12-03', 'Acme Supply Co', { total: '0' }),
      bill('3004', 'B-100', '2026-12-04', 'Acme Supply Co', { tran_type: 'VendCred' }),
      bill('3005', 'B-1000', '2026-12-05', 'Acme Supply Co', { gone_at: '2026-12-06T00:00:00Z' }),
    ];
    expect(await (await get('find=')).json()).toEqual({
      bills: [
        { id: '3003', number: null, date: '2026-12-03', vendorName: 'Acme Supply Co', totalCents: 0, voided: false },
        { id: '3002', number: 'INV-77', date: '2026-12-03', vendorName: 'Widget Works', totalCents: 1999, voided: true },
        { id: '3001', number: 'B-100', date: '2026-12-01', vendorName: 'Acme Supply Co', totalCents: 54510, voided: false },
      ],
    });
    const ids = async (typed: string) => ((await (await get(`find=${encodeURIComponent(typed)}`)).json()).bills as Array<{ id: string }>).map((b) => b.id);
    expect(await ids('acme')).toEqual(['3003', '3001']);
    expect(await ids('b 100')).toEqual(['3001']);
    expect(await ids('B-100')).toEqual(['3001']);
    expect(await ids('works inv')).toEqual([]);
    expect(await ids('inv 77')).toEqual(['3002']);
    expect(await ids('--')).toEqual(['3003', '3002', '3001']);

    state.tables.gl_netsuite_bills = Array.from({ length: 20 }, (_, i) => bill(String(4000 + i), `B-${i}`, '2026-11-01', 'Acme Supply Co'));
    const many = await ids('');
    expect(many).toHaveLength(15);
    expect(many[0]).toBe('4019');

    state.failing = new Set(['gl_netsuite_bills']);
    const unread = await get('find=acme');
    expect(unread.status).toBe(500);
    expect(await unread.json()).toEqual({ error: "couldn't search the copy of NetSuite's bills (gl_netsuite_bills can't be read)" });
  });

  it("offers the accounts the bill's company uses, in number order", async () => {
    expect((await (await get('bill=3001')).json()).accounts).toEqual([
      { id: '690', name: '900 Small tools' },
      { id: '610', name: '6100 Shop Supplies' },
      { id: '620', name: '6200 Freight' },
      { id: '630', name: '6300 Tools' },
    ]);
    expect(readAccounts).toHaveBeenCalledWith(h.service, COMPANIES);

    // A bill for a company FleetSuite doesn't keep books for has none; nor one with no company, whatever a company lacks.
    vi.mocked(readAccounts).mockClear();
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: { ...RECORD, subsidiary: { id: '9' } } });
    expect((await (await get('bill=3001')).json()).accounts).toEqual([]);
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: { ...RECORD, subsidiary: null } });
    state.companies = [...COMPANIES, { id: 'g3', code: 'NEW', name: 'New company', subsidiaryId: null, locations: [] }];
    expect((await (await get('bill=3001')).json()).accounts).toEqual([]);
    expect(readAccounts).not.toHaveBeenCalled();
  });

  it("knows the bill's terms, and a vendor credit FleetSuite made against it", async () => {
    const shown = async () => (await get('bill=3001')).json();
    state.tables.gl_netsuite_lists = [];
    expect(await shown()).toMatchObject({ termsDays: null });
    state.tables.gl_netsuite_lists = [{ kind: 'tax_code', netsuite_id: '2', details: { days_until_net_due: 30 } }];
    expect(await shown()).toMatchObject({ termsDays: null });
    for (const days of [-5, 30.5, 'soon', null]) {
      state.tables.gl_netsuite_lists = [{ kind: 'term', netsuite_id: '2', details: { days_until_net_due: days } }];
      expect(await shown()).toMatchObject({ termsDays: null });
    }
    state.tables.gl_netsuite_lists = [{ kind: 'term', netsuite_id: '2', details: { days_until_net_due: '45' } }];
    expect(await shown()).toMatchObject({ termsDays: 45 });
    state.tables.gl_netsuite_lists = [{ kind: 'term', netsuite_id: '2', details: { days_until_net_due: 0 } }];
    expect(await shown()).toMatchObject({ termsDays: 0 });
    // With no terms it's due the day it's dated.
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: { ...RECORD, terms: null } });
    state.failing = new Set(['gl_netsuite_lists']);
    expect(await shown()).toMatchObject({ termsDays: 0 });
    state.failing = new Set();
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: RECORD });

    // One being made counts, and one made; one NetSuite refused doesn't, nor one applied to another bill.
    const credit = (over: Record<string, unknown>) => ({
      id: 'v1', applied: [{ billId: '3001', billNumber: 'B-100', cents: 5000 }], netsuite_vendor_credit_id: null, claimed_at: null, ...over,
    });
    state.tables.typed_vendor_credits = [credit({})];
    expect((await shown()).allows.lines).toBe(true);
    state.tables.typed_vendor_credits = [credit({ applied: [{ billId: '3002', billNumber: 'B-101', cents: 5000 }], netsuite_vendor_credit_id: '6001' })];
    expect((await shown()).allows.lines).toBe(true);
    state.tables.typed_vendor_credits = [credit({ claimed_at: '2026-12-02T15:00:00Z' })];
    expect((await shown()).allows.lines).toBe(false);
    state.tables.typed_vendor_credits = [credit({ applied: [{ billId: '3002', billNumber: 'B-101', cents: 100 }, { billId: '3001', billNumber: 'B-100', cents: 5000 }], netsuite_vendor_credit_id: '6001' })];
    expect((await shown()).allows).toEqual({
      header: true, lines: false,
      why: 'FleetSuite made a vendor credit against it, so only its number, memo and due date can be fixed. To take more off it, make another vendor credit.',
    });
  });

  it("fixes only the number, memo and due date when NetSuite can't say what's owed", async () => {
    netsuite.getVendorBillAmounts.mockResolvedValue({ success: false, error: 'NetSuite SuiteQL error (503): busy' });
    const shown = await (await get('bill=3001')).json();
    expect(shown.bill).toMatchObject({ totalCents: 54510, owedCents: null, status: 'Open' });
    expect(shown.allows).toEqual({ header: true, lines: false, why: "NetSuite didn't say what's still owed on it, so only its number, memo and due date can be fixed." });
    const lines = await post(await NUMBER_AND_SHELF());
    expect(lines.status).toBe(400);
    expect(await lines.json()).toEqual({
      error: "NetSuite didn't say what's still owed on it, so only its number, memo and due date can be fixed.",
      problems: ["NetSuite didn't say what's still owed on it, so only its number, memo and due date can be fixed."],
    });
    expect((await post(await MEMO())).status).toBe(200);
    expect(netsuite.patchVendorBill).toHaveBeenCalledWith('3001', { memo: 'Shop supplies, December' }, { replace: [] });
  });

  it("says what couldn't be read, and sends nothing", async () => {
    const form = await NUMBER_AND_SHELF();
    for (const table of ['typed_vendor_credits', 'gl_netsuite_lists', 'bill_fixes', 'gl_own_bills']) {
      state.failing = new Set([table]);
      const res = await get('bill=3001');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: `${table} can't be read` });
    }
    state.failing = new Set(['typed_vendor_credits']);
    const facts = await post(form);
    expect(facts.status).toBe(500);
    expect(await facts.json()).toEqual({ error: "typed_vendor_credits can't be read" });
    state.failing = new Set(['bill_fix_claim']);
    const claim = await post(form);
    expect(claim.status).toBe(500);
    expect(await claim.json()).toEqual({ error: "bill_fix_claim didn't answer" });
    state.failing = new Set();
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite 404: gone', notFound: true });
    const gone = await post(form);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'NetSuite has no bill with id 3001.' });
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite request timed out' });
    expect((await post(form)).status).toBe(502);
    expect(netsuite.patchVendorBill).not.toHaveBeenCalled();
  });

  it("fixes the bill in NetSuite once, Books' own copy following, and lists the fix", async () => {
    const form = { ...(await NUMBER_AND_SHELF()), reason: '  Billed two, three came ' };
    const res = await post(form);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, billNumber: 'B-100A', changes: ['Number B-100 → B-100A', 'SHELF-1 quantity 2 → 3'],
      totalBeforeCents: 54510, totalAfterCents: 67010, ownCopy: 'fixed',
    });
    expect(netsuite.findVendorBill).toHaveBeenCalledWith('4001', 'B-100A');
    expect(netsuite.patchVendorBill).toHaveBeenCalledWith('3001', { tranId: 'B-100A', item: { items: [{ line: 1, quantity: 3, amount: 375 }] } }, { replace: [] });
    expect(netsuite.getOrderLineIds).toHaveBeenCalledWith('2001');
    expect(saveFixed).toHaveBeenCalledWith(h.service, {
      netsuiteId: '3001',
      fixed: {
        number: 'B-100A', date: '2026-12-01',
        lines: [
          { accountId: '610', itemId: null, itemNumber: null, description: 'Gloves', quantity: null, rate: null, cents: 20005, poLineId: null },
          { accountId: '620', itemId: null, itemNumber: null, description: null, quantity: null, rate: null, cents: 4505, poLineId: null },
          { accountId: null, itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', quantity: 3, rate: 125, cents: 37500, poLineId: '920011' },
          { accountId: null, itemId: '57', itemNumber: 'LIGHT-2', description: null, quantity: 1, rate: 50, cents: 5000, poLineId: '920012' },
        ],
      },
      fixId: REQUEST,
      by: USER,
    });
    expect(state.calls[0]).toEqual(['bill_fix_claim', {
      id: REQUEST, bill_netsuite_id: '3001', bill_number: 'B-100', vendor_netsuite_id: '4001', vendor_name: 'Acme Supply Co',
      reason: 'Billed two, three came', changes: ['Number B-100 → B-100A', 'SHELF-1 quantity 2 → 3'],
      patch: { tranId: 'B-100A', item: { items: [{ line: 1, quantity: 3, amount: 375 }] } }, replace_lists: [],
      total_before_cents: 54510, total_expected_cents: 67010, by: USER,
    }]);
    expect(state.calls[1]).toEqual(['bill_fix_finish', { id: REQUEST, status: 'fixed', total_after_cents: 67010, own_copy: 'fixed', own_copy_version: 2 }]);
    expect(state.tables.bill_fixes).toEqual([expect.objectContaining({ id: REQUEST, status: 'fixed', error: null, total_after_cents: 67010, own_copy: 'fixed', own_copy_version: 2 })]);
    expect(logAudit).toHaveBeenCalledWith(h.service, {
      actorId: USER, table: 'bill_fixes', recordId: REQUEST, action: 'fix',
      detail: {
        netsuite_bill_id: '3001', bill: 'B-100', vendor: 'Acme Supply Co', changes: ['Number B-100 → B-100A', 'SHELF-1 quantity 2 → 3'],
        replace: [], total_before: '$545.10', total_after: '$670.10', own_copy: 'fixed',
      },
    });

    // The same form pressed again: NetSuite's bill changed since that page read it, so nothing goes.
    const again = await post(form);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'Bill B-100A changed in NetSuite since this page opened. Nothing was sent. Reload it and make the fix again.', stale: true });
    // Made again on the bill as it is now, there's nothing left to change.
    const redone = await post(await NUMBER_AND_SHELF());
    expect(redone.status).toBe(400);
    expect((await redone.json()).error).toBe('Nothing has changed yet.');
    expect(netsuite.patchVendorBill).toHaveBeenCalledTimes(1);

    const shown = await (await get('bill=3001')).json();
    expect(shown.fixes).toEqual([{
      id: REQUEST, at: '2026-12-02T15:00:00Z', by: 'Sam Example', reason: 'Billed two, three came',
      changes: ['Number B-100 → B-100A', 'SHELF-1 quantity 2 → 3'], status: 'fixed', error: null,
      totalBeforeCents: 54510, totalAfterCents: 67010, ownCopy: 'fixed',
    }]);
  });

  it("says what an earlier press did, and doesn't send it twice", async () => {
    // NetSuite's copy not showing the fix yet, the same form pressed again is the same fix.
    netsuite.patchVendorBill.mockResolvedValue({ success: true });
    const form = await NUMBER_AND_SHELF();
    expect((await post(form)).status).toBe(200);
    const same = await post(form);
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ success: true, already: true, billNumber: 'B-100', changes: ['Number B-100 → B-100A', 'SHELF-1 quantity 2 → 3'] });
    expect(netsuite.patchVendorBill).toHaveBeenCalledTimes(1);
    expect(saveFixed).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it("lists the bill's own fixes, newest first, twenty at most", async () => {
    const row = (end: string, bill: string, at: string, over: Record<string, unknown> = {}) => ({
      id: `b0000000-0000-4000-8000-0000000000${end}`, bill_netsuite_id: bill, reason: 'Wrong number', changes: ['Number B-10 → B-100'],
      status: 'fixed', error: null, total_before_cents: 54510, total_after_cents: 54510, own_copy: 'none', created_by: null, created_at: at, ...over,
    });
    state.tables.profiles.push({ id: 'p0000000-0000-4000-8000-000000000002', full_name: null });
    state.tables.bill_fixes = [
      row('0a', '3001', '2026-12-02T15:00:00Z', { created_by: USER }), row('0b', '3002', '2026-12-04T15:00:00Z'),
      row('0c', '3001', '2026-12-03T15:00:00Z', { created_by: 'p0000000-0000-4000-8000-000000000002', changes: null }),
      row('0d', '3001', '2026-12-03T15:00:00Z', { status: 'refused', error: 'The period is closed.', total_after_cents: null, own_copy: null }),
    ];
    const { fixes } = await (await get('bill=3001')).json();
    expect(fixes.map((f: { id: string }) => f.id.slice(-2))).toEqual(['0d', '0c', '0a']);
    expect(fixes[0]).toMatchObject({ status: 'refused', error: 'The period is closed.', totalAfterCents: null, ownCopy: null, by: null });
    expect(fixes[1]).toMatchObject({ by: null, changes: [] });
    expect(fixes[2]).toMatchObject({ by: 'Sam Example', ownCopy: 'none', changes: ['Number B-10 → B-100'] });

    state.tables.bill_fixes = Array.from({ length: 25 }, (_, i) => row(String(10 + i), '3001', `2026-12-${String(i + 1).padStart(2, '0')}T15:00:00Z`));
    const many = (await (await get('bill=3001')).json()).fixes;
    expect(many).toHaveLength(20);
    expect(many[0].at).toBe('2026-12-25T15:00:00Z');
  });

  it('sends nothing when the bill changed since the page opened, or the fix has a problem', async () => {
    const stale = await post({ ...(await NUMBER_AND_SHELF()), signature: 'not-what-netsuite-has-now' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: 'Bill B-100 changed in NetSuite since this page opened. Nothing was sent. Reload it and make the fix again.', stale: true,
    });
    const unsaid = await post({ ...(await NUMBER_AND_SHELF()), reason: ' ' });
    expect(unsaid.status).toBe(400);
    expect(await unsaid.json()).toEqual({ error: "Say why it's being fixed.", problems: ["Say why it's being fixed."] });
    const gone = await post({ ...(await NUMBER_AND_SHELF()), lines: [{ list: 'item', line: 9, quantity: 3 }] });
    expect(gone.status).toBe(400);
    expect((await gone.json()).error).toBe("Line 9 isn't on bill B-100 any more. Reload and try again.");
    // An account another company's bills go to isn't one this bill's lines can.
    const elsewhere = await post({ ...(await NUMBER_AND_SHELF()), add: [{ accountId: '640', amount: 10 }] });
    expect(elsewhere.status).toBe(400);
    expect((await elsewhere.json()).error).toBe("New line 1: pick an account this company's bills can go to.");
    for (const body of [{ requestId: 'not-a-uuid' }, { billId: '30x1' }, { lines: [{ list: 'note', line: 1 }] }, { add: [{ accountId: '630' }] }]) {
      const res = await post({ ...(await NUMBER_AND_SHELF()), ...body });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Invalid request');
    }
    expect(netsuite.patchVendorBill).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it("won't give the bill a number the vendor's other bill has, and sends nothing when NetSuite can't say", async () => {
    const renumber = async (number: string) => post({ ...(await MEMO()), header: { number } });
    netsuite.findVendorBill.mockResolvedValueOnce({ billId: '3009', billNumber: 'B-200' });
    const taken = await renumber(' b-200 ');
    expect(taken.status).toBe(400);
    expect((await taken.json()).error).toBe("Acme Supply Co already has a bill numbered B-200 in NetSuite. Each of a vendor's bills has its own number.");
    expect(netsuite.findVendorBill).toHaveBeenLastCalledWith('4001', 'b-200');
    netsuite.findVendorBill.mockResolvedValueOnce({ billId: '3009', billNumber: '' });
    expect((await (await renumber('b-200')).json()).error).toBe("Acme Supply Co already has a bill numbered b-200 in NetSuite. Each of a vendor's bills has its own number.");

    netsuite.findVendorBill.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503): busy'));
    const unsure = await renumber(' B-200 ');
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({ error: "Couldn't ask NetSuite whether another of the vendor's bills is numbered B-200: NetSuite SuiteQL error (503): busy. Nothing was sent." });
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: { ...RECORD, entity: null } });
    const vendorless = await renumber('B-200');
    expect(vendorless.status).toBe(502);
    expect((await vendorless.json()).error).toBe("Couldn't ask NetSuite whether another of the vendor's bills is numbered B-200: NetSuite gave the bill no vendor. Nothing was sent.");
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: RECORD });
    expect(netsuite.findVendorBill).toHaveBeenCalledTimes(3);

    // NetSuite isn't asked of a number that doesn't change, is left blank or is too long to be one.
    for (const number of [' B-100 ', ' ', 'B'.repeat(41)]) await renumber(number);
    expect(netsuite.findVendorBill).toHaveBeenCalledTimes(3);
    expect(netsuite.patchVendorBill).not.toHaveBeenCalled();

    // The bill found is this one, its case changed: that's the fix.
    netsuite.findVendorBill.mockResolvedValueOnce({ billId: '3001', billNumber: 'B-100' });
    const recased = await renumber('b-100');
    expect(recased.status).toBe(200);
    expect((await recased.json()).changes).toEqual(['Number B-100 → b-100']);
    expect(netsuite.findVendorBill).toHaveBeenLastCalledWith('4001', 'b-100');
    expect(netsuite.patchVendorBill).toHaveBeenCalledWith('3001', { tranId: 'b-100' }, { replace: [] });
  });

  it('asks NetSuite of a number as long as one can be', async () => {
    const res = await post({ ...(await MEMO()), header: { number: 'B'.repeat(40) } });
    expect(res.status).toBe(200);
    expect(netsuite.findVendorBill).toHaveBeenCalledWith('4001', 'B'.repeat(40));
  });

  it('works the fix out from what NetSuite has, not what the page says', async () => {
    const res = await post({
      ...(await NUMBER_AND_SHELF()), header: {},
      lines: [{ list: 'expense', line: 2, accountId: '630' }, { list: 'item', line: 3, remove: true }],
      add: [{ accountId: '630', amount: 10, memo: ' Tape ' }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).changes).toEqual(['6200 Freight → 6300 Tools', 'Took off LIGHT-2 (1 × $50.00)', 'Added 6300 Tools ($10.00)']);
    expect(netsuite.patchVendorBill).toHaveBeenCalledWith('3001', {
      expense: { items: [{ line: 2, account: { id: '630' } }, { account: { id: '630' }, amount: 10, memo: 'Tape' }] },
      item: { items: [{ line: 1 }, { line: 2 }] },
    }, { replace: ['item'] });
    expect(state.tables.bill_fixes[0]).toMatchObject({ replace_lists: ['item'], total_expected_cents: 50510 });
    expect(saveFixed.mock.calls[0][1].fixed.lines).toEqual([
      { accountId: '610', itemId: null, itemNumber: null, description: 'Gloves', quantity: null, rate: null, cents: 20005, poLineId: null },
      { accountId: '630', itemId: null, itemNumber: null, description: null, quantity: null, rate: null, cents: 4505, poLineId: null },
      { accountId: null, itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', quantity: 2, rate: 125, cents: 25000, poLineId: '920011' },
      { accountId: '630', itemId: null, itemNumber: null, description: 'Tape', quantity: null, rate: null, cents: 1000, poLineId: null },
    ]);
    expect(logAudit).toHaveBeenCalledWith(h.service, expect.objectContaining({ detail: expect.objectContaining({ replace: ['item'] }) }));
  });

  it("moves the due date with the date by the bill's terms, and leaves it to NetSuite when FleetSuite can't tell them", async () => {
    const res = await post({ ...(await MEMO()), header: { date: '2026-12-05' } });
    expect(res.status).toBe(200);
    expect((await res.json()).changes).toEqual(['Date Dec 1, 2026 → Dec 5, 2026', 'Due Dec 31, 2026 → Jan 4, 2027']);
    expect(netsuite.patchVendorBill).toHaveBeenLastCalledWith('3001', { tranDate: '2026-12-05', dueDate: '2027-01-04' }, { replace: [] });
    expect(saveFixed.mock.calls[0][1].fixed).toMatchObject({ number: 'B-100', date: '2026-12-05' });

    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: RECORD });
    netsuite.getVendorBillAmounts.mockResolvedValue(AMOUNTS);
    state.tables.gl_netsuite_lists = [];
    const unknown = await post({ ...(await MEMO()), requestId: 'b0000000-0000-4000-8000-000000000002', header: { date: '2026-12-05' } });
    expect((await unknown.json()).changes).toEqual(['Date Dec 1, 2026 → Dec 5, 2026']);
    expect(netsuite.patchVendorBill).toHaveBeenLastCalledWith('3001', { tranDate: '2026-12-05' }, { replace: [] });
  });

  it("lets the same form try again when NetSuite refused, and says when it can't tell whether the fix went in", async () => {
    netsuite.patchVendorBill.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): The period is closed. ' });
    const refused = await post(await NUMBER_AND_SHELF());
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "NetSuite didn't take the fix: NetSuite error (400): The period is closed. Nothing changed." });
    expect(state.tables.bill_fixes[0]).toMatchObject({ status: 'refused', error: 'NetSuite error (400): The period is closed. ' });
    expect(state.calls[1]).toEqual(['bill_fix_finish', { id: REQUEST, status: 'refused', error: 'NetSuite error (400): The period is closed. ' }]);
    expect(saveFixed).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();

    netsuite.patchVendorBill.mockResolvedValueOnce({ success: false });
    expect(await (await post(await NUMBER_AND_SHELF())).json()).toEqual({ error: "NetSuite didn't take the fix: NetSuite didn't answer. Nothing changed." });
    expect(state.tables.bill_fixes[0]).toMatchObject({ status: 'refused', error: "NetSuite didn't answer" });

    netsuite.patchVendorBill.mockResolvedValueOnce({ success: false, error: 'NetSuite took too long to answer', unsure: true });
    const unsure = await post(await NUMBER_AND_SHELF());
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({
      error: "NetSuite took too long to answer, so FleetSuite can't tell whether the fix went in. Reload the bill: if the change is there, it went in; if it isn't, fix it again.",
      unsure: true,
    });
    expect(state.tables.bill_fixes[0]).toMatchObject({ status: 'unsure' });

    const retried = await post(await NUMBER_AND_SHELF());
    expect(retried.status).toBe(200);
    expect(state.tables.bill_fixes).toHaveLength(1);
    expect(state.tables.bill_fixes[0]).toMatchObject({ status: 'fixed', error: null });
    expect(netsuite.patchVendorBill).toHaveBeenCalledTimes(4);
  });

  it('sends one fix of a bill at a time', async () => {
    state.tables.bill_fixes = [{ id: 'b0000000-0000-4000-8000-000000000009', bill_netsuite_id: '3001', status: 'sending' }];
    const busy = await post(await NUMBER_AND_SHELF());
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'Another fix of bill B-100 is being sent now. Reload it in a minute and check it before fixing it again.' });
    state.tables.bill_fixes = [{ id: REQUEST, bill_netsuite_id: '3001', status: 'sending' }];
    const pressed = await post(await NUMBER_AND_SHELF());
    expect(pressed.status).toBe(409);
    expect(await pressed.json()).toEqual({ error: "This fix is being sent now. Don't press again: reload the bill in a minute to see it." });
    expect(netsuite.patchVendorBill).not.toHaveBeenCalled();
  });

  it("finishes the fix whatever becomes of Books' own copy", async () => {
    const press = async (end: string, then?: () => void) => {
      netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: RECORD });
      netsuite.getVendorBillAmounts.mockResolvedValue(AMOUNTS);
      const form = { ...(await MEMO()), requestId: `b0000000-0000-4000-8000-00000000000${end}` };
      then?.();
      return (await post(form)).json();
    };
    const fixOf = (end: string) => state.tables.bill_fixes.find((r) => r.id.endsWith(end));

    // No copy of the bill: nothing to follow, and its purchase orders aren't read.
    state.tables.gl_own_bills = [];
    expect(await press('1')).toEqual({
      success: true, billNumber: 'B-100', changes: ['Memo changed'], totalBeforeCents: 54510, totalAfterCents: 67010, ownCopy: 'none',
    });
    expect(fixOf('1')).toMatchObject({ status: 'fixed', own_copy: 'none', own_copy_version: null });
    expect(saveFixed).not.toHaveBeenCalled();
    expect(netsuite.getOrderLineIds).not.toHaveBeenCalled();

    // Copies that can't be read are tried, not taken for none.
    state.tables.gl_own_bills = [{ netsuite_id: '3001', version: 1, fixed_at: null }];
    expect(await press('2', () => { state.failing = new Set(['gl_own_bills']); })).toMatchObject({ ownCopy: 'fixed' });
    expect(saveFixed).toHaveBeenCalledTimes(1);
    state.failing = new Set();

    saveFixed.mockResolvedValueOnce({ saved: false, none: true, reason: 'no copy' });
    expect(await press('3')).toMatchObject({ ownCopy: 'none' });
    expect(fixOf('3')).toMatchObject({ own_copy: 'none', own_copy_version: null });

    saveFixed.mockResolvedValueOnce({ saved: false, reason: 'the copy changed while the fix was being made' });
    expect(await press('4')).toMatchObject({
      success: true, ownCopy: 'not_saved',
      warning: "Books' own copy of the bill didn't follow (the copy changed while the fix was being made). The fix is in NetSuite.",
    });

    // A save that says it saved but gives no version isn't counted as saved.
    saveFixed.mockResolvedValueOnce({ saved: true });
    expect(await press('5')).toMatchObject({ ownCopy: 'not_saved', warning: "Books' own copy of the bill didn't follow (it said nothing back). The fix is in NetSuite." });
    expect(fixOf('5')).toMatchObject({ status: 'fixed', own_copy: 'not_saved', own_copy_version: null });

    // Nor one that says it didn't save, whatever version it gives.
    saveFixed.mockResolvedValueOnce({ saved: false, version: 2, reason: 'the copy is gone' });
    expect(await press('6')).toMatchObject({ ownCopy: 'not_saved' });
    expect(fixOf('6')).toMatchObject({ own_copy: 'not_saved', own_copy_version: null });

    // A bill NetSuite gave no date can't have a copy.
    saveFixed.mockClear();
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: { ...RECORD, tranDate: null } });
    netsuite.getVendorBillAmounts.mockResolvedValue(AMOUNTS);
    const undated = await (await post({ ...(await MEMO()), requestId: 'b0000000-0000-4000-8000-000000000007' })).json();
    expect(undated).toMatchObject({ success: true, ownCopy: 'not_saved', warning: "Books' own copy of the bill didn't follow (NetSuite gave the bill no date). The fix is in NetSuite." });
    expect(saveFixed).not.toHaveBeenCalled();
  });

  it('answers that the fix went in when it couldn\'t be marked fixed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const form = await MEMO();
    state.failing = new Set(['bill_fix_finish']);
    const res = await post(form);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, ownCopy: 'fixed' });
    expect(logged).toHaveBeenCalledWith(`[bill fix] ${REQUEST} went in but wasn't marked fixed: bill_fix_finish didn't answer`);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it("names each part's purchase order line in Books' copy where the order can be read", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const linesSaved = () => saveFixed.mock.calls.at(-1)![1].fixed.lines.map((l: { itemNumber: string | null; poLineId: string | null }) => [l.itemNumber, l.poLineId]);

    netsuite.getOrderLineIds.mockResolvedValueOnce(new Map([[1, '920011']]));
    await post(await MEMO());
    expect(linesSaved()).toEqual([[null, null], [null, null], ['SHELF-1', '920011'], ['LIGHT-2', null]]);

    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: RECORD });
    netsuite.getVendorBillAmounts.mockResolvedValue(AMOUNTS);
    netsuite.getOrderLineIds.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503): busy'));
    expect((await post({ ...(await MEMO()), requestId: 'b0000000-0000-4000-8000-000000000002' })).status).toBe(200);
    expect(linesSaved()).toEqual([[null, null], [null, null], ['SHELF-1', null], ['LIGHT-2', null]]);
    expect(logged).toHaveBeenCalledWith("[bill fix] couldn't read purchase order 2001's lines: NetSuite SuiteQL error (503): busy");

    // Five orders at most are read; a line of a sixth goes without.
    const six = ['2001', '2002', '2003', '2004', '2005', '2006'].map((order, i) => ({
      line: i + 1, item: { id: String(60 + i), refName: `PART-${i + 1}` }, itemType: 'InvtPart', quantity: 1, rate: 10, amount: 10, orderDoc: { id: order }, orderLine: 1,
    }));
    const sixOrders = { ...RECORD, userTotal: 60, expense: { items: [] }, item: { items: six } };
    const sixAmounts = { ...AMOUNTS, totalCents: 6000, owedCents: 6000 };
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: sixOrders });
    netsuite.getVendorBillAmounts.mockResolvedValue(sixAmounts);
    netsuite.getOrderLineIds.mockClear();
    expect((await post({ ...(await MEMO()), requestId: 'b0000000-0000-4000-8000-000000000003' })).status).toBe(200);
    expect(netsuite.getOrderLineIds.mock.calls.map((c) => c[0])).toEqual(['2001', '2002', '2003', '2004', '2005']);
    expect(linesSaved()).toEqual([['PART-1', '920011'], ['PART-2', '920021'], ['PART-3', '920031'], ['PART-4', '920041'], ['PART-5', '920051'], ['PART-6', null]]);

    // A part whose order line NetSuite didn't name doesn't send FleetSuite to read its order.
    const unnamed = { ...RECORD, item: { items: RECORD.item.items.map((it) => (it.line === 3 ? { ...it, orderDoc: { id: '2007' }, orderLine: null } : it)) } };
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: unnamed });
    netsuite.getVendorBillAmounts.mockResolvedValue(AMOUNTS);
    netsuite.getOrderLineIds.mockClear();
    expect((await post({ ...(await MEMO()), requestId: 'b0000000-0000-4000-8000-000000000004' })).status).toBe(200);
    expect(netsuite.getOrderLineIds.mock.calls.map((c) => c[0])).toEqual(['2001']);
    expect(linesSaved()).toEqual([[null, null], [null, null], ['SHELF-1', '920011'], ['LIGHT-2', null]]);
  });

  it("shows NetSuite's total as unknown when it can't be read back", async () => {
    const form = await NUMBER_AND_SHELF();
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: true, record: RECORD })
      .mockResolvedValueOnce({ success: false, error: 'NetSuite request timed out' });
    expect(await (await post(form)).json()).toMatchObject({ success: true, totalAfterCents: null });
    expect(state.tables.bill_fixes[0]).toMatchObject({ status: 'fixed', total_after_cents: null });
    expect(logAudit).toHaveBeenCalledWith(h.service, expect.objectContaining({ detail: expect.objectContaining({ total_after: null }) }));

    // A read that throws is the same; and with only the record read, its own total is the one.
    state.tables.bill_fixes = [];
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: RECORD });
    netsuite.getVendorBillAmounts.mockResolvedValue(AMOUNTS);
    const again = await NUMBER_AND_SHELF();
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: true, record: RECORD }).mockRejectedValueOnce(new Error('socket hang up'));
    expect(await (await post(again)).json()).toMatchObject({ success: true, totalAfterCents: null });

    state.tables.bill_fixes = [];
    netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: RECORD });
    netsuite.getVendorBillAmounts.mockResolvedValue(AMOUNTS);
    const third = await NUMBER_AND_SHELF();
    netsuite.getVendorBillAmounts.mockResolvedValueOnce(AMOUNTS).mockResolvedValueOnce({ success: false, error: 'NetSuite SuiteQL error (503): busy' });
    expect(await (await post(third)).json()).toMatchObject({ success: true, totalAfterCents: 67010 });
  });
});
