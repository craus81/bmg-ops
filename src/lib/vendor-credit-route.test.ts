// /api/purchasing/vendor-credit (src/lib/vendor-credit.ts): who can open it
// while vendor credits are switched off and once they're on, and what one
// press of Make vendor credit does: the credit worked out again from the
// copies and the vendor's bills as NetSuite has them now, made once in
// NetSuite however often it's pressed and never twice under the vendor's
// number, the claim let go when NetSuite refuses, and Books' own copy kept.
// Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    roles: ['admin'] as string[],
    hasPartsOrdering: true,
    tables: {} as Record<string, Record<string, any>[]>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    rpcError: null as string | null,
  };
  const netsuite = {
    getVendorOpenBills: vi.fn(),
    findVendorCredit: vi.fn(),
    createVendorCredit: vi.fn(),
    getVendorBillRecord: vi.fn(),
    getVendorBillAmounts: vi.fn(),
    getBillPostings: vi.fn(),
  };

  // typed_vendor_credits_once: one press holds a vendor's credit number while it's claimed or made.
  const numberKey = (r: Record<string, any>) => `${r.vendor_netsuite_id}|${String(r.credit_number ?? '').trim().toUpperCase()}`;
  const holds = (r: Record<string, any>) => r.claimed_at != null || r.netsuite_vendor_credit_id != null;
  const clashes = (table: string, all: Record<string, any>[], row: Record<string, any>, selfId: unknown) =>
    table === 'typed_vendor_credits' && holds(row) && all.some((r) => r.id !== selfId && holds(r) && numberKey(r) === numberKey(row));

  const likeToRegex = (pattern: string) => new RegExp(`^${pattern.replace(/\\(.)|([%_])|([^\\%_]+)/g, (_m, esc, wild, text) =>
    esc !== undefined ? esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : wild ? (wild === '%' ? '.*' : '.')
        : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}$`, 'i');
  const orCondition = (cond: string): ((r: Record<string, any>) => boolean) => {
    let m = cond.match(/^(\w+)\.not\.is\.null$/);
    if (m) { const col = m[1]; return (r) => r[col] != null; }
    m = cond.match(/^(\w+)\.ilike\.(.*)$/);
    if (m) { const [, col, pat] = m; return (r) => likeToRegex(pat).test(String(r[col] ?? '')); }
    m = cond.match(/^(\w+)\.imatch\."(.*)"$/);
    if (m) { const [, col, re] = m; return (r) => new RegExp(re.replace(/\[\^\[:alnum:\]\]/g, '[^a-zA-Z0-9]'), 'i').test(String(r[col] ?? '')); }
    throw new Error(`stand-in can't read ${cond}`);
  };

  // An in-memory stand-in for the tables the route reads and writes.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    let patch: Record<string, any> | null = null;
    let returning = false;
    let limit = Infinity;
    const rows = () => (state.tables[table] ??= []);
    const run = () => {
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (patch) {
        for (const r of matched) {
          if (clashes(table, rows(), { ...r, ...patch }, r.id)) return { data: null, error: { code: '23505', message: 'duplicate key value violates typed_vendor_credits_once' } };
        }
        for (const r of matched) Object.assign(r, patch);
        return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: matched.slice(0, limit).map((r) => ({ ...r })), error: null };
    };
    const builder: any = {
      select: () => { if (patch) returning = true; return builder; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return builder; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      not: (c: string, op: string, v: unknown) => {
        if (op !== 'is' || v !== null) throw new Error(`stand-in can't do not.${op}`);
        filters.push((r) => r[c] != null);
        return builder;
      },
      ilike: (c: string, pat: string) => { filters.push((r) => likeToRegex(pat).test(String(r[c] ?? ''))); return builder; },
      or: (expr: string) => {
        const conds = (expr.match(/(?:[^,"]|"[^"]*")+/g) ?? []).map(orCondition);
        filters.push((r) => conds.some((c) => c(r)));
        return builder;
      },
      order: () => builder,
      limit: (n: number) => { limit = n; return builder; },
      update: (p: Record<string, any>) => { patch = p; return builder; },
      maybeSingle: async () => {
        const res = run();
        return { data: (res.data as any[] | null)?.[0] ?? null, error: res.error };
      },
      insert: async (row: Record<string, any>) => {
        if (rows().some((r) => r.id === row.id) || clashes(table, rows(), row, row.id)) return { error: { code: '23505', message: 'duplicate key value' } };
        rows().push({ ...row });
        return { error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, args]);
      return state.rpcError ? { data: null, error: { message: state.rpcError } } : { data: { saved: true, lines: args.p.lines.length }, error: null };
    },
  };

  const companies = [
    { id: 'g1', code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }, { id: '5', name: 'Mobile' }] },
    { id: 'g2', code: '1084', name: '1084 Cool Springs', subsidiaryId: '3', locations: [] },
  ];
  const accounts = () => new Map([
    ['610', { id: '610', number: '5100', name: 'Shop supplies', type: 'Expense', companies: ['BMG', '1084'] }],
    ['699', { id: '699', number: '9999', name: 'Closed out', type: 'Expense', companies: [] as string[] }],
  ]);
  const vendors = [{ id: '4001', name: 'Acme Racks', entityId: null, termsId: null, expenseAccountId: '610' }];
  return { state, netsuite, service, companies, accounts, vendors };
});

vi.mock('@/lib/api-auth', () => ({
  requireFeature: vi.fn(async () => (h.state.hasPartsOrdering
    ? { user: { id: 'p0000000-0000-4000-8000-000000000001' }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/books/snap-a-bill', () => ({
  readCompanies: vi.fn(async () => h.companies),
  readAccounts: vi.fn(async () => h.accounts()),
  readVendor: vi.fn(async (_s: unknown, id: string) => h.vendors.find((v) => v.id === id) ?? null),
  searchVendors: vi.fn(async (_s: unknown, typed: string) => h.vendors.filter((v) => v.name.toLowerCase().includes(typed.toLowerCase()))),
  snapToday: () => '2026-10-31',
}));

const { state, netsuite } = h;

import { GET, POST } from '../app/api/purchasing/vendor-credit/route';

const REQUEST = 'b0000000-0000-4000-8000-000000000001';
const OTHER_PRESS = 'b0000000-0000-4000-8000-000000000002';
const BILLS = [
  { id: '3002', number: 'B-101', date: '2026-08-15', dueDate: '2026-09-15', openCents: 5000 },
  { id: '3001', number: 'B-100', date: '2026-09-01', dueDate: null, openCents: 20000 },
];
const PARTS = [
  { netsuite_id: '55', item_number: 'SHELF-1', display_name: 'Shelf', description: 'Shelf unit', item_type: 'InvtPart', purchase_price: '120', vendor_cost: '125.50', quantity_on_hand: '4', is_active: true },
  { netsuite_id: '56', item_number: 'SHELF-OLD', display_name: 'Old shelf', description: null, item_type: 'InvtPart', purchase_price: '90', vendor_cost: null, quantity_on_hand: '0', is_active: false },
  { netsuite_id: '70', item_number: 'DECAL-9', display_name: 'Decal', description: null, item_type: 'NonInvtPart', purchase_price: '0', vendor_cost: null, quantity_on_hand: null, is_active: true },
  { netsuite_id: '80', item_number: 'RACK-ASM', display_name: 'Rack assembly', description: 'Ladder rack, built', item_type: 'Assembly', purchase_price: '310', vendor_cost: '0', quantity_on_hand: '2', is_active: true },
];

const get = (query: string) => GET(new NextRequest(`https://app.test/api/purchasing/vendor-credit?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/purchasing/vendor-credit', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
/** One shelf unit going back and a $20 fee back to Shop supplies, $145.50, with $50 of it against bill B-101. */
const ONE = {
  requestId: REQUEST, company: 'BMG', vendorId: '4001', number: 'VC-77', date: '2026-10-30', locationId: '1', reason: 'Returned shelf',
  lines: [{ kind: 'part', itemId: '55', quantity: 1, rate: 125.5 }, { kind: 'account', accountId: '610', amount: 20, memo: 'Restock fee back' }],
  applied: [{ billId: '3002', amount: 50 }],
  expectedTotalCents: 14550,
};
const rowsOf = () => state.tables.typed_vendor_credits ?? [];
/** Bill B-100 from Acme Racks, as NetSuite has it: an expense line and a shelf billed off a purchase order. */
const BILL_RECORD = {
  id: '3001', tranId: 'B-100', tranDate: '2026-09-01', entity: { id: '4001', refName: 'Acme Racks' }, subsidiary: { id: '2' }, location: { id: '1' },
  userTotal: 345.05, status: { refName: 'Open' },
  expense: { items: [{ line: 1, account: { id: '610', refName: '5100 Shop supplies' }, amount: 95.05, memo: 'Gloves' }] },
  item: { items: [{ line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125, amount: 250, orderDoc: { id: '2001' }, orderLine: 1 }] },
};
/** What it posted: payables, Shop supplies, and the account received stock is held against. */
const BILL_POSTINGS = [
  { lineId: '0', accountId: '200', debitCents: 0, creditCents: 34505, payables: true, memo: null },
  { lineId: '1', accountId: '610', debitCents: 9505, creditCents: 0, payables: false, memo: 'Gloves' },
  { lineId: '2', accountId: '140', debitCents: 25000, creditCents: 0, payables: false, memo: null },
];

const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'vendor_credits', is_on: on }, { piece: 'credit_memos', is_on: !on }]; };

beforeEach(() => {
  state.roles = ['admin'];
  state.hasPartsOrdering = true;
  state.tables = { netsuite_parts: PARTS.map((p) => ({ ...p })) };
  switchOn(false);
  state.rpcs.length = 0;
  state.rpcError = null;
  vi.clearAllMocks();
  netsuite.getVendorOpenBills.mockResolvedValue({ success: true, bills: BILLS, credits: [{ id: '6001', number: 'VC-1', date: '2026-09-04', dueDate: null, openCents: 1234 }] });
  netsuite.findVendorCredit.mockResolvedValue(null);
  netsuite.createVendorCredit.mockResolvedValue({ success: true, vendorCreditId: '6002' });
  netsuite.getVendorBillRecord.mockResolvedValue({ success: true, record: BILL_RECORD });
  netsuite.getVendorBillAmounts.mockResolvedValue({ success: true, totalCents: 34505, owedCents: 34505, status: 'Bill : Open', voided: false });
  netsuite.getBillPostings.mockResolvedValue({ success: true, rows: BILL_POSTINGS });
});

describe('while vendor credits are switched off', () => {
  it('shows Vendor Credits to super admins only', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.roles = ['super_admin'];
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true });
    state.hasPartsOrdering = false;
    expect((await get('status=1')).status).toBe(403);
  });

  it('lets a super admin see what it would send, and nobody else', async () => {
    const refused = await get('');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Vendor credits are switched off until January 1, 2027.', switchedOff: true });
    expect((await get('vendors=acme')).status).toBe(403);
    expect((await get('bill=3001')).status).toBe(403);
    expect(netsuite.getVendorBillRecord).not.toHaveBeenCalled();

    state.roles = ['super_admin'];
    const res = await get('');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      companies: [
        { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2', locations: [{ id: '1', name: "O'Fallon" }, { id: '5', name: 'Mobile' }] },
        { code: '1084', name: '1084 Cool Springs', subsidiaryId: '3', locations: [] },
      ],
      accounts: [{ id: '610', number: '5100', name: 'Shop supplies', companies: ['BMG', '1084'] }],
      today: '2026-10-31',
      stockLocationId: '1',
      recent: [],
      switchedOn: false,
      offText: 'Vendor credits are switched off until January 1, 2027. You can see what it would send; nothing goes to NetSuite.',
    });
  });

  it('sends nothing to NetSuite, even for a super admin', async () => {
    state.roles = ['super_admin'];
    const res = await post(ONE);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Vendor credits are switched off until January 1, 2027. Nothing was sent to NetSuite.', switchedOff: true });
    expect(netsuite.findVendorCredit).not.toHaveBeenCalled();
    expect(netsuite.createVendorCredit).not.toHaveBeenCalled();
    expect(rowsOf()).toEqual([]);
  });
});

describe('once vendor credits are switched on', () => {
  beforeEach(() => switchOn(true));

  it('lets admins with Parts Ordering use them, and nobody else', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });
    const res = await get('');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ switchedOn: true, offText: null });

    state.roles = ['shop_tech'];
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: false });
    const tech = await get('');
    expect(tech.status).toBe(403);
    expect(await tech.json()).toEqual({ error: 'Vendor credits are made by admins.' });
    expect((await post(ONE)).status).toBe(403);
    expect(netsuite.createVendorCredit).not.toHaveBeenCalled();
  });

  it('finds vendors and the active parts that can go back', async () => {
    expect(await (await get('vendors=acme')).json()).toEqual({ vendors: [{ id: '4001', name: 'Acme Racks' }] });
    expect(await (await get('parts=shelf')).json()).toEqual({
      parts: [{ id: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', stock: true, cost: 125.5, onHand: 4 }],
    });
    expect(await (await get('parts=shelf1')).json()).toMatchObject({ parts: [{ id: '55' }] });
    expect(await (await get('parts=decal')).json()).toEqual({
      parts: [{ id: '70', itemNumber: 'DECAL-9', description: 'Decal', stock: false, cost: null, onHand: null }],
    });
    expect(await (await get('parts=rack')).json()).toEqual({
      parts: [{ id: '80', itemNumber: 'RACK-ASM', description: 'Ladder rack, built', stock: true, cost: 310, onHand: 2 }],
    });
    expect(await (await get('parts=s')).json()).toEqual({ parts: [] });
  });

  it("reads the vendor's open bills and credits from NetSuite for the company", async () => {
    const res = await get('vendor=4001&company=BMG');
    expect(await res.json()).toEqual({
      vendor: { id: '4001', name: 'Acme Racks', expenseAccountId: '610' },
      openBills: BILLS,
      openCredits: [{ id: '6001', number: 'VC-1', date: '2026-09-04', dueDate: null, openCents: 1234 }],
      openError: null,
    });
    expect(netsuite.getVendorOpenBills).toHaveBeenCalledWith('4001', '2');

    netsuite.getVendorOpenBills.mockResolvedValueOnce({ success: false, error: 'timed out' });
    expect(await (await get('vendor=4001&company=NOPE')).json()).toMatchObject({ openBills: null, openCredits: null, openError: 'timed out' });
    expect(netsuite.getVendorOpenBills).toHaveBeenLastCalledWith('4001', null);

    expect((await get('vendor=40x1&company=BMG')).status).toBe(400);
    const missing = await get('vendor=4999&company=BMG');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "That vendor isn't in FleetSuite's copy of NetSuite's vendors." });
  });

  it('fills in a vendor credit for all of a bill, from what it posted, applied to what is open on it', async () => {
    const res = await get('bill=3001');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      prefill: {
        billId: '3001', billNumber: 'B-100', vendor: { id: '4001', name: 'Acme Racks' }, company: 'BMG', locationId: '1',
        number: 'VOID-B-100', reason: 'Undoes bill B-100',
        lines: [{ accountId: '610', amount: 95.05, memo: 'Gloves' }, { accountId: '140', amount: 250, memo: null }],
        applyCents: 34505, why: null,
      },
    });
    for (const fn of [netsuite.getVendorBillRecord, netsuite.getVendorBillAmounts, netsuite.getBillPostings]) expect(fn).toHaveBeenCalledWith('3001');

    // Part paid: what's still open on it is what the credit takes off it.
    netsuite.getVendorBillAmounts.mockResolvedValueOnce({ success: true, totalCents: 34505, owedCents: 10000, status: 'Bill : Partially Paid', voided: false });
    expect((await (await get('bill=3001')).json()).prefill).toMatchObject({ applyCents: 10000 });
    // When NetSuite can't say what's open, nothing is applied, and the bill is picked by hand.
    netsuite.getVendorBillAmounts.mockResolvedValueOnce({ success: false, error: 'busy' });
    expect((await (await get('bill=3001')).json()).prefill).toMatchObject({ applyCents: 0, why: null });
  });

  it("fills in what it can of a bill without a number, a vendor or one of the company's locations", async () => {
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: true, record: { ...BILL_RECORD, tranId: '', entity: null, location: { id: '7' } } });
    expect((await (await get('bill=3001')).json()).prefill).toMatchObject({
      billNumber: null, vendor: null, locationId: null, number: 'VOID-3001', reason: 'Undoes NetSuite bill 3001',
    });
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: true, record: { ...BILL_RECORD, location: { id: '5' } } });
    expect((await (await get('bill=3001')).json()).prefill).toMatchObject({ locationId: '5' });
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: true, record: { ...BILL_RECORD, location: null } });
    expect((await (await get('bill=3001')).json()).prefill).toMatchObject({ locationId: null });

    // What it posted that can't be read, or doesn't add up, is entered by hand.
    netsuite.getBillPostings.mockResolvedValueOnce({ success: false, error: 'NetSuite SuiteQL error (503): busy' });
    expect((await (await get('bill=3001')).json()).prefill).toMatchObject({
      lines: [], why: "Couldn't read what bill B-100 posted from NetSuite (NetSuite SuiteQL error (503): busy), so enter its lines by hand.",
    });
    netsuite.getBillPostings.mockResolvedValueOnce({ success: true, rows: BILL_POSTINGS.slice(0, 2) });
    expect((await (await get('bill=3001')).json()).prefill).toMatchObject({
      lines: [], why: 'What bill B-100 posted comes to $95.05, not its total of $345.05, so enter this one by hand.',
    });
  });

  it("won't fill in a vendor credit for a bill NetSuite hasn't got, has voided, or keeps for another company", async () => {
    const bad = await get('bill=30x1');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Bad bill id' });
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite 404', notFound: true });
    const missing = await get('bill=3009');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'NetSuite has no bill with id 3009.' });
    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite request timed out' });
    const slow = await get('bill=3001');
    expect(slow.status).toBe(502);
    expect(await slow.json()).toEqual({ error: 'NetSuite request timed out' });

    netsuite.getVendorBillAmounts.mockResolvedValueOnce({ success: true, totalCents: 34505, owedCents: 0, status: 'Bill : Voided', voided: true });
    const voided = await get('bill=3001');
    expect(voided.status).toBe(409);
    expect(await voided.json()).toEqual({ error: "Bill B-100 is voided in NetSuite, so there's nothing to credit." });

    netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: true, record: { ...BILL_RECORD, subsidiary: { id: '9' } } });
    const elsewhere = await get('bill=3001');
    expect(elsewhere.status).toBe(409);
    expect(await elsewhere.json()).toEqual({ error: "Bill B-100 is for a company FleetSuite doesn't keep books for." });
    // A bill naming no company isn't one FleetSuite has without one either.
    h.companies.push({ id: 'g3', code: 'NEW', name: 'New Co', subsidiaryId: null as unknown as string, locations: [] });
    try {
      netsuite.getVendorBillRecord.mockResolvedValueOnce({ success: true, record: { ...BILL_RECORD, subsidiary: null } });
      expect((await get('bill=3001')).status).toBe(409);
    } finally {
      h.companies.pop();
    }
  });

  it('makes the vendor credit in NetSuite once, keeps Books its copy, and says what an earlier press did', async () => {
    const res = await post(ONE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, vendorCreditId: '6002', number: 'VC-77', vendorName: 'Acme Racks', totalCents: 14550, appliedCents: 5000 });
    expect(netsuite.findVendorCredit).toHaveBeenCalledWith('4001', 'VC-77');
    expect(netsuite.getVendorOpenBills).toHaveBeenCalledWith('4001', '2');
    expect(netsuite.createVendorCredit).toHaveBeenCalledWith({
      vendorId: '4001', tranId: 'VC-77', tranDate: '2026-10-30', subsidiaryId: '2', locationId: '1', memo: 'Returned shelf',
      expenses: [{ accountId: '610', amount: 20, memo: 'Restock fee back' }],
      items: [{ itemId: '55', quantity: 1, rate: 125.5, amount: 125.5 }],
      apply: [{ billId: '3002', amount: 50 }],
    });
    expect(rowsOf()).toEqual([expect.objectContaining({
      id: REQUEST, company: 'BMG', vendor_netsuite_id: '4001', vendor_name: 'Acme Racks', credit_number: 'VC-77', credit_date: '2026-10-30',
      location_netsuite_id: '1', reason: 'Returned shelf', total_cents: 14550, applied_cents: 5000, netsuite_vendor_credit_id: '6002', error: null,
      created_by: 'p0000000-0000-4000-8000-000000000001',
      applied: [{ billId: '3002', billNumber: 'B-101', cents: 5000 }],
      lines: [
        { kind: 'part', accountId: null, itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', quantity: 1, rate: 125.5, cents: 12550 },
        { kind: 'account', accountId: '610', itemId: null, itemNumber: null, description: 'Restock fee back', quantity: null, rate: null, cents: 2000 },
      ],
    })]);
    expect(rowsOf()[0].claimed_at).toEqual(expect.any(String));
    expect(state.rpcs).toEqual([['gl_own_vendor_credit_save', { p: expect.objectContaining({
      netsuite_id: '6002', company: 'BMG', made_from_id: REQUEST, vendor_netsuite_id: '4001', vendor_name: 'Acme Racks', total: '145.50', applied: '50.00',
      applied_to: [{ bill_netsuite_id: '3002', bill_number: 'B-101', amount: '50.00' }], rule: 'vendor_credit@1',
    }) }]]);

    const again = await post(ONE);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ success: true, already: true, vendorCreditId: '6002', number: 'VC-77', vendorName: 'Acme Racks', totalCents: 14550 });
    expect(netsuite.createVendorCredit).toHaveBeenCalledTimes(1);
    expect(state.rpcs).toHaveLength(1);

    const recent = await (await get('')).json();
    expect(recent.recent).toEqual([expect.objectContaining({ id: REQUEST, vendorName: 'Acme Racks', number: 'VC-77', totalCents: 14550, vendorCreditId: '6002', state: 'made', error: null })]);
  });

  it("reads the vendor's bills only when the credit is applied to some", async () => {
    const res = await post({ ...ONE, applied: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ appliedCents: 0 });
    expect(netsuite.getVendorOpenBills).not.toHaveBeenCalled();
    expect(netsuite.createVendorCredit.mock.calls[0][0].apply).toEqual([]);
  });

  it("sends nothing when the form has problems, the bills changed, or NetSuite's bills can't be read", async () => {
    const unsaid = await post({ ...ONE, reason: ' ' });
    expect(unsaid.status).toBe(400);
    expect(await unsaid.json()).toEqual({ error: 'Say why the vendor gave the credit.' });

    netsuite.getVendorOpenBills.mockResolvedValueOnce({ success: true, bills: [BILLS[1]], credits: [] });
    const paid = await post(ONE);
    expect(paid.status).toBe(400);
    expect((await paid.json()).error).toBe("NetSuite bill 3002 isn't open in NetSuite any more. Reload and try again.");

    netsuite.getVendorOpenBills.mockResolvedValueOnce({ success: false, error: 'timed out' });
    const unread = await post(ONE);
    expect(unread.status).toBe(502);
    expect(await unread.json()).toEqual({ error: "Couldn't read the vendor's open bills from NetSuite (timed out). Nothing was sent." });

    const changed = await post({ ...ONE, expectedTotalCents: 12550 });
    expect(changed.status).toBe(409);
    expect((await changed.json()).error).toBe('The credit now comes to $145.50, not the $125.50 the page showed. Nothing was sent. Reload and check it.');

    const inactive = await post({ ...ONE, lines: [{ kind: 'part', itemId: '56', quantity: 1, rate: 90 }], applied: [], expectedTotalCents: 9000 });
    expect(inactive.status).toBe(400);
    expect((await inactive.json()).error).toBe("Line 1: that part isn't in FleetSuite's copy of NetSuite's items.");

    expect(netsuite.findVendorCredit).not.toHaveBeenCalled();
    expect(netsuite.createVendorCredit).not.toHaveBeenCalled();
    expect(rowsOf()).toEqual([]);
  });

  it('refuses a body that names things that aren\'t NetSuite ids', async () => {
    expect((await post({ ...ONE, vendorId: '40x1' })).status).toBe(400);
    expect((await post({ ...ONE, requestId: 'press-1' })).status).toBe(400);
    expect((await post({ ...ONE, lines: [{ kind: 'note', text: 'x' }] })).status).toBe(400);
    expect(netsuite.createVendorCredit).not.toHaveBeenCalled();
  });

  it('never enters the same credit from the vendor twice, and sends nothing when NetSuite can\'t say', async () => {
    netsuite.findVendorCredit.mockResolvedValueOnce({ vendorCreditId: '6000', number: 'VC-77' });
    const there = await post(ONE);
    expect(there.status).toBe(409);
    expect(await there.json()).toEqual({ error: 'NetSuite already has vendor credit VC-77 from Acme Racks. Nothing was sent.', vendorCreditId: '6000' });

    netsuite.findVendorCredit.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503): busy'));
    const unsure = await post(ONE);
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({ error: "Couldn't check NetSuite for vendor credit VC-77 (NetSuite SuiteQL error (503): busy). Nothing was sent. Try again." });

    expect(netsuite.createVendorCredit).not.toHaveBeenCalled();
    expect(rowsOf()).toEqual([]);
  });

  it('lets go of the claim when NetSuite refuses, so the same form can try again', async () => {
    netsuite.createVendorCredit.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): Invalid apply reference key 3002.' });
    const refused = await post(ONE);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: 'NetSuite error (400): Invalid apply reference key 3002.' });
    expect(rowsOf()[0]).toMatchObject({ claimed_at: null, error: 'NetSuite error (400): Invalid apply reference key 3002.' });
    expect(rowsOf()[0].netsuite_vendor_credit_id ?? null).toBeNull();
    expect(state.rpcs).toEqual([]);
    const shown = await (await get('')).json();
    expect(shown.recent).toEqual([expect.objectContaining({ state: 'refused', error: 'NetSuite error (400): Invalid apply reference key 3002.' })]);

    const retried = await post(ONE);
    expect(retried.status).toBe(200);
    expect(rowsOf()).toHaveLength(1);
    expect(rowsOf()[0]).toMatchObject({ netsuite_vendor_credit_id: '6002', error: null });
    expect(rowsOf()[0].claimed_at).toEqual(expect.any(String));
    expect(netsuite.createVendorCredit).toHaveBeenCalledTimes(2);
  });

  it("won't make a second vendor credit while the first press is still being made", async () => {
    state.tables.typed_vendor_credits = [{ id: REQUEST, vendor_netsuite_id: '4001', credit_number: 'VC-77', claimed_at: '2026-10-31T12:00:00Z', netsuite_vendor_credit_id: null }];
    const res = await post(ONE);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This vendor credit is already being made. Don't press again: reload in a minute to see it." });
    expect(netsuite.createVendorCredit).not.toHaveBeenCalled();
    const shown = await (await get('')).json();
    expect(shown.recent).toEqual([expect.objectContaining({ state: 'making', error: null })]);
  });

  it("won't make the vendor's number twice from two screens, whatever its case or spaces", async () => {
    state.tables.typed_vendor_credits = [{ id: OTHER_PRESS, vendor_netsuite_id: '4001', vendor_name: 'Acme Racks', credit_number: 'VC-77', claimed_at: '2026-10-31T12:00:00Z', netsuite_vendor_credit_id: null }];
    const making = await post({ ...ONE, number: ' vc-77 ' });
    expect(making.status).toBe(409);
    expect(await making.json()).toEqual({ error: 'Vendor credit vc-77 from this vendor is being made from another screen right now. Nothing was sent from this one.' });

    state.tables.typed_vendor_credits[0].netsuite_vendor_credit_id = '6000';
    const made = await post(ONE);
    expect(made.status).toBe(409);
    expect(await made.json()).toEqual({ error: 'FleetSuite already made vendor credit VC-77 from Acme Racks. Nothing was sent.' });
    expect(netsuite.createVendorCredit).not.toHaveBeenCalled();
    expect(rowsOf()).toHaveLength(1);
  });

  it("doesn't let a press NetSuite refused, or another vendor's credit of the same number, hold the number", async () => {
    state.tables.typed_vendor_credits = [
      { id: OTHER_PRESS, vendor_netsuite_id: '4001', credit_number: 'VC-77', claimed_at: null, netsuite_vendor_credit_id: null, error: 'Invalid item' },
      { id: 'b0000000-0000-4000-8000-000000000003', vendor_netsuite_id: '4777', credit_number: 'VC-77', claimed_at: '2026-10-31T12:00:00Z', netsuite_vendor_credit_id: '5999' },
    ];
    expect((await post(ONE)).status).toBe(200);
    expect(netsuite.createVendorCredit).toHaveBeenCalledTimes(1);
  });

  it('names the press that made the number, not an older one NetSuite refused', async () => {
    state.tables.typed_vendor_credits = [
      { id: 'b0000000-0000-4000-8000-000000000004', vendor_netsuite_id: '4001', credit_number: 'VC-77', claimed_at: null, netsuite_vendor_credit_id: null, error: 'Invalid item' },
      { id: OTHER_PRESS, vendor_netsuite_id: '4001', vendor_name: 'Acme Racks', credit_number: 'VC-77', claimed_at: '2026-10-31T12:00:00Z', netsuite_vendor_credit_id: '6000' },
    ];
    const res = await post(ONE);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'FleetSuite already made vendor credit VC-77 from Acme Racks. Nothing was sent.' });
    expect(netsuite.createVendorCredit).not.toHaveBeenCalled();
  });

  it("re-takes a refused form's claim only while nobody else holds its number", async () => {
    netsuite.createVendorCredit.mockResolvedValueOnce({ success: false, error: 'Invalid item' });
    await post(ONE);
    state.tables.typed_vendor_credits.push({ id: OTHER_PRESS, vendor_netsuite_id: '4001', vendor_name: 'Acme Racks', credit_number: 'VC-77', claimed_at: '2026-10-31T12:00:00Z', netsuite_vendor_credit_id: '6003' });
    const res = await post(ONE);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'FleetSuite already made vendor credit VC-77 from Acme Racks. Nothing was sent.' });
    expect(netsuite.createVendorCredit).toHaveBeenCalledTimes(1);
  });

  it("says when Books couldn't keep its copy, and still answers that the vendor credit is made", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.rpcError = 'gl_own_vendor_credit_save: vendor credit 6002 lines don\'t add up to its total';
    const res = await post(ONE);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, vendorCreditId: '6002',
      warning: "Books didn't keep its copy (gl_own_vendor_credit_save: vendor credit 6002 lines don't add up to its total). The vendor credit is in NetSuite.",
    });
  });
});
