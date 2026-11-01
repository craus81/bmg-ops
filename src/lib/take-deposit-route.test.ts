// /api/sales-orders/deposit (src/lib/take-deposit.ts): who can open it while
// taking deposits is switched off and once it's on, and what one press of
// Take deposit does: the deposit worked out again from the order as NetSuite
// has it now and the deposits on it already, a check FleetSuite has from the
// customer already turned away, the deposit made once in NetSuite under the
// press's own External ID however often it's pressed, let go when NetSuite
// refuses, held when NetSuite can't say and asked about later, and Books' own
// copy kept. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const STAFF = 'd0000000-0000-4000-8000-000000000001';
const OTHER = 'd0000000-0000-4000-8000-000000000002';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    userId: '',
    roles: [] as string[],
    hasInvoicing: true,
    canSeeMoney: true,
    tables: {} as Record<string, Record<string, any>[]>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    ownSave: null as null | { data: unknown; error: { message: string } | null },
    madeError: null as null | { message: string },
    /** Runs once, just before the next claim: another press of the same form getting there first. */
    beforeClaim: null as (() => void) | null,
  };
  const netsuite = {
    getDepositSalesOrder: vi.fn(),
    findCustomerDeposit: vi.fn(),
    createCustomerDeposit: vi.fn(),
  };

  // An in-memory stand-in for the tables the route reads and writes.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    const sorts: Array<[string, boolean]> = [];
    let patch: Record<string, any> | null = null;
    let limit = Infinity;
    const rows = () => (state.tables[table] ??= []);
    const run = () => {
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (patch) {
        for (const r of matched) Object.assign(r, patch);
        return { data: null, error: null };
      }
      const sorted = [...matched].sort((a, b) => {
        for (const [c, asc] of sorts) {
          const d = String(a[c]).localeCompare(String(b[c]));
          if (d !== 0) return asc ? d : -d;
        }
        return 0;
      });
      return { data: sorted.slice(0, limit).map((r) => ({ ...r })), error: null };
    };
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return builder; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return builder; },
      // jsonb @> on an array: every element asked for is matched by one the row has.
      contains: (c: string, want: Array<Record<string, unknown>>) => {
        filters.push((r) => want.every((w) => ((r[c] ?? []) as Array<Record<string, unknown>>)
          .some((have) => Object.entries(w).every(([k, v]) => have[k] === v))));
        return builder;
      },
      order: (c: string, o?: { ascending?: boolean }) => { sorts.push([c, o?.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      update: (p: Record<string, any>) => { patch = p; return builder; },
      maybeSingle: async () => ({ data: run().data?.[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  // received_deposit_claim, _let_go and _made as migration 486 has them, on the in-memory table.
  const presses = () => (state.tables.received_deposits ??= []);
  const content = (p: Record<string, any>) => ({
    company: p.company, customer_netsuite_id: p.customer_netsuite_id, customer_name: p.customer_name || null,
    sales_order_netsuite_id: p.sales_order_netsuite_id, sales_order_number: p.sales_order_number || null, received_date: p.received_date,
    method: p.method, reference: p.reference || null, memo: p.memo || null, amount_cents: p.amount_cents,
  });
  const rpcs: Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }> = {
    received_deposit_claim: (p) => {
      if (state.beforeClaim) { const first = state.beforeClaim; state.beforeClaim = null; first(); }
      const now = new Date().toISOString();
      const r = presses().find((x) => x.id === p.id);
      if (!r) {
        const row = {
          id: p.id, ...content(p), status: 'sending', sent_by: p.by, sent_at: now, netsuite_deposit_id: null, netsuite_number: null,
          error: null, created_by: p.by, created_at: now, updated_at: now,
        };
        presses().push(row);
        return { data: { state: 'claimed', deposit: { ...row } }, error: null };
      }
      if (r.status === 'made') return { data: { state: 'made', netsuite_deposit_id: r.netsuite_deposit_id, netsuite_number: r.netsuite_number }, error: null };
      if (r.status === 'sending') return { data: { state: 'sending', deposit: { ...r } }, error: null };
      Object.assign(r, content(p), { status: 'sending', sent_by: p.by, sent_at: now, error: null, updated_at: now });
      return { data: { state: 'claimed', deposit: { ...r } }, error: null };
    },
    received_deposit_let_go: (p) => {
      const r = presses().find((x) => x.id === p.id && x.status === 'sending');
      if (r) Object.assign(r, { status: 'open', sent_by: null, sent_at: null, error: p.error });
      return { data: { let_go: !!r }, error: null };
    },
    received_deposit_made: (p) => {
      if (state.madeError) return { data: null, error: state.madeError };
      const r = presses().find((x) => x.id === p.id && x.status === 'sending');
      if (r) Object.assign(r, { status: 'made', netsuite_deposit_id: p.netsuite_deposit_id, netsuite_number: p.netsuite_number, error: null });
      return { data: { made: !!r }, error: null };
    },
    gl_own_deposit_save: () => state.ownSave ?? { data: { saved: true }, error: null },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, args]);
      return rpcs[fn] ? rpcs[fn](args.p) : { data: null, error: { message: `nothing answers ${fn}` } };
    },
  };
  return { state, netsuite, service };
});

vi.mock('@/lib/api-auth', () => ({
  requireFeature: vi.fn(async () => (h.state.hasInvoicing
    ? { user: { id: h.state.userId }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  profileCanSeeMoney: vi.fn(async () => h.state.canSeeMoney),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));

const { state, netsuite } = h;

import { logAudit } from '@/lib/audit';
import { GET, POST } from '../app/api/sales-orders/deposit/route';

const P = (n: number) => `b0000000-0000-4000-8000-00000000000${n}`;
const REQUEST = P(1);
const NOW = '2026-10-31T17:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

const ORDER = {
  id: '4521', number: 'SO1450', customerId: '501', customerName: 'Acme Plumbing', subsidiaryId: '2', date: '2026-10-02',
  status: 'B', statusName: 'Pending Fulfillment', totalCents: 1250040,
};
/** Acme's check 10442, half down on SO1450... near enough. */
const CHECK = {
  requestId: REQUEST, salesOrderId: '4521', date: '2026-10-30', method: 'check', reference: '10442', memo: 'half down', amountCents: 250050,
};
const EXTERNAL = `fleetsuite-cd-${REQUEST}`;

const get = (query: string) => GET(new NextRequest(`https://app.test/api/sales-orders/deposit?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/sales-orders/deposit', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'customer_deposits', is_on: on }]; };
const press = (id: string) => state.tables.received_deposits?.find((r) => r.id === id);
const rpcNames = () => state.rpcs.map(([fn]) => fn);
/** A deposit taken earlier from the same customer, on another of its orders. */
const earlier = (over: Record<string, any>) => ({
  id: P(9), company: 'BMG', customer_netsuite_id: '501', customer_name: 'Acme Plumbing', sales_order_netsuite_id: '4400',
  sales_order_number: 'SO1400', received_date: '2026-10-29', method: 'check', reference: '10442', memo: null, amount_cents: 100000,
  status: 'made', sent_by: OTHER, sent_at: ago(60 * 48), netsuite_deposit_id: '7300', netsuite_number: 'DEP-40', error: null,
  created_at: ago(60 * 48), ...over,
});
/** A customer deposit in the books' copy of NetSuite's, on SO1450. */
const copied = (over: Record<string, any>) => ({
  netsuite_id: '7299', tran_type: 'CustDep', tranid: 'DEP-29', trandate: '2026-10-01', total: '50.00', voided: false, gone_at: null,
  links: [{ netsuite_id: '4521', type: 'SalesOrd', number: 'SO1450', amount: 50, link_type: 'Order' }], ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  state.userId = STAFF;
  state.roles = ['admin'];
  state.hasInvoicing = true;
  state.canSeeMoney = true;
  state.tables = {
    gl_companies: [{ code: 'BMG', netsuite_subsidiary_id: '2' }, { code: '1084', netsuite_subsidiary_id: '3' }],
    customers: [{ id: 'c1', netsuite_id: '501' }],
    received_deposits: [],
    received_payments: [],
    gl_netsuite_deposits: [],
  };
  state.rpcs.length = 0;
  state.ownSave = null;
  state.madeError = null;
  state.beforeClaim = null;
  switchOn(true);
  vi.clearAllMocks();
  for (const fn of Object.values(netsuite)) fn.mockReset();
  netsuite.getDepositSalesOrder.mockResolvedValue(ORDER);
  netsuite.findCustomerDeposit.mockResolvedValueOnce(null).mockResolvedValue({ depositId: '7303', number: 'DEP-43' });
  netsuite.createCustomerDeposit.mockResolvedValue({ success: true, depositId: '7303' });
});

afterEach(() => { vi.useRealTimers(); });

describe('while taking deposits is switched off', () => {
  beforeEach(() => switchOn(false));

  it("shows the Deposit button to super admins only, and to nobody who can't see prices", async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.roles = ['super_admin'];
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true });
    state.canSeeMoney = false;
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.hasInvoicing = false;
    expect((await get('status=1')).status).toBe(403);
  });

  it('lets a super admin see what it would send, and nobody else', async () => {
    const refused = await get('so=4521');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Taking deposits is switched off until deposits move into FleetSuite during 2027.', switchedOff: true });
    expect(netsuite.getDepositSalesOrder).not.toHaveBeenCalled();

    state.roles = ['super_admin'];
    const res = await get('so=4521');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      today: '2026-10-31',
      customer: { id: '501', name: 'Acme Plumbing' },
      company: 'BMG',
      order: { id: '4521', number: 'SO1450', date: '2026-10-02', status: 'B', statusName: 'Pending Fulfillment', totalCents: 1250040 },
      onOrder: [],
      switchedOn: false,
      offText: 'Taking deposits is switched off until deposits move into FleetSuite during 2027. You can see what it would send; nothing goes to NetSuite.',
    });
    expect(netsuite.getDepositSalesOrder).toHaveBeenCalledWith('4521');
  });

  it('sends nothing, for a super admin either', async () => {
    state.roles = ['super_admin'];
    const res = await post(CHECK);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Taking deposits is switched off until deposits move into FleetSuite during 2027. Nothing was sent to NetSuite.', switchedOff: true,
    });
    expect(netsuite.getDepositSalesOrder).not.toHaveBeenCalled();
    expect(netsuite.createCustomerDeposit).not.toHaveBeenCalled();
    expect(state.rpcs).toEqual([]);
  });
});

describe('once taking deposits is on', () => {
  it('opens to anyone with Invoicing who can see prices', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });
    const res = await get('so=4521');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ switchedOn: true, offText: null, company: 'BMG' });

    state.canSeeMoney = false;
    for (const res2 of [await get('so=4521'), await post(CHECK)]) {
      expect(res2.status).toBe(403);
      expect(await res2.json()).toEqual({ error: 'Forbidden: this account cannot see billing' });
    }
    state.canSeeMoney = true;
    state.hasInvoicing = false;
    expect((await get('so=4521')).status).toBe(403);
    expect((await post(CHECK)).status).toBe(403);
    expect(netsuite.createCustomerDeposit).not.toHaveBeenCalled();
  });

  it("says when the order can't be read", async () => {
    for (const q of ['so=SO1450', 'so=', '']) {
      const bad = await get(q);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'Bad sales order id' });
    }
    netsuite.getDepositSalesOrder.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (400): bad column'));
    const failed = await get('so=4521');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Couldn't read the sales order from NetSuite (NetSuite SuiteQL error (400): bad column)." });
    netsuite.getDepositSalesOrder.mockResolvedValueOnce(null);
    const missing = await get('so=4522');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'NetSuite has no sales order with id 4522.' });
    for (const subsidiaryId of ['9', null]) {
      netsuite.getDepositSalesOrder.mockResolvedValueOnce({ ...ORDER, subsidiaryId });
      expect(await (await get('so=4521')).json()).toMatchObject({ company: null });
    }
    netsuite.getDepositSalesOrder.mockResolvedValueOnce({ ...ORDER, subsidiaryId: '3' });
    expect(await (await get('so=4521')).json()).toMatchObject({ company: '1084' });
  });

  it("lists the deposits on the order, FleetSuite's and NetSuite's, each once, oldest first", async () => {
    state.tables.received_deposits = [
      earlier({ id: P(5), sales_order_netsuite_id: '4521', sales_order_number: 'SO1450', netsuite_deposit_id: '7301', netsuite_number: 'DEP-41', received_date: '2026-10-20' }),
      earlier({
        id: P(6), sales_order_netsuite_id: '4521', status: 'sending', netsuite_deposit_id: null, netsuite_number: null, received_date: '2026-10-29',
        amount_cents: 5000, sent_at: ago(1), created_at: ago(1),
      }),
      earlier({ id: P(7), sales_order_netsuite_id: '4521', status: 'open', netsuite_deposit_id: null, netsuite_number: null, error: 'NetSuite error (400): no' }),
      earlier({ id: P(8) }),
    ];
    state.tables.gl_netsuite_deposits = [
      copied({ netsuite_id: '7301', tranid: 'DEP-41', trandate: '2026-10-20', total: '1000.00' }),
      copied({ netsuite_id: '7200', tranid: 'DEP-30', trandate: '2026-10-05', total: '200.00' }),
      copied({ netsuite_id: '7201', voided: true }),
      copied({ netsuite_id: '7202', gone_at: ago(60) }),
      copied({ netsuite_id: '7203', links: [{ netsuite_id: '4400', type: 'SalesOrd', number: 'SO1400', amount: 50, link_type: 'Order' }] }),
      copied({ netsuite_id: '7204', tran_type: 'CustPymt' }),
    ];
    expect((await (await get('so=4521')).json()).onOrder).toEqual([
      { netsuiteId: '7200', number: 'DEP-30', date: '2026-10-05', cents: 20000, inFleetSuite: false, making: false },
      { netsuiteId: '7301', number: 'DEP-41', date: '2026-10-20', cents: 100000, inFleetSuite: true, making: false },
      { netsuiteId: null, number: null, date: '2026-10-29', cents: 5000, inFleetSuite: true, making: true },
    ]);
  });

  it("makes the deposit once in NetSuite, on the order, and keeps Books' own copy", async () => {
    const res = await post(CHECK);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, depositId: '7303', number: 'DEP-43', amountCents: 250050 });

    expect(netsuite.getDepositSalesOrder).toHaveBeenCalledWith('4521');
    expect(netsuite.findCustomerDeposit.mock.calls).toEqual([[EXTERNAL], [EXTERNAL]]);
    expect(netsuite.createCustomerDeposit).toHaveBeenCalledTimes(1);
    expect(netsuite.createCustomerDeposit).toHaveBeenCalledWith({
      externalId: EXTERNAL, customerId: '501', subsidiaryId: '2', salesOrderId: '4521', tranDate: '2026-10-30', amount: 2500.5,
      checkNumber: '10442', memo: 'Check 10442 · half down',
    });

    expect(rpcNames()).toEqual(['received_deposit_claim', 'received_deposit_made', 'gl_own_deposit_save']);
    expect(state.rpcs[0][1].p).toEqual({
      id: REQUEST, by: STAFF, company: 'BMG', customer_netsuite_id: '501', customer_name: 'Acme Plumbing', sales_order_netsuite_id: '4521',
      sales_order_number: 'SO1450', received_date: '2026-10-30', method: 'check', reference: '10442', memo: 'half down', amount_cents: 250050,
    });
    expect(state.rpcs[1][1].p).toEqual({ id: REQUEST, netsuite_deposit_id: '7303', netsuite_number: 'DEP-43' });
    expect(press(REQUEST)).toMatchObject({ status: 'made', netsuite_deposit_id: '7303', netsuite_number: 'DEP-43' });
    expect(state.rpcs[2][1].p).toEqual({
      netsuite_id: '7303', netsuite_number: 'DEP-43', company: 'BMG', made_from_id: REQUEST, customer_netsuite_id: '501', customer_id: 'c1',
      sales_order_netsuite_id: '4521', sales_order_number: 'SO1450', deposit_date: '2026-10-30', method: 'check', reference: '10442',
      memo: 'Check 10442 · half down', deposited_to: 'undeposited_funds', amount: '2500.50', made_by: STAFF,
    });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: STAFF, table: 'received_deposits', recordId: REQUEST, action: 'create',
      detail: {
        netsuite_deposit_id: '7303', netsuite_number: 'DEP-43', company: 'BMG', customer: 'Acme Plumbing', sales_order: 'SO1450',
        date: '2026-10-30', method: 'check', reference: '10442', total: '$2,500.50', found_in_netsuite: false,
      },
    });

    // Pressed again, by anyone: it's made, and nothing goes to NetSuite.
    state.userId = OTHER;
    const again = await post({ ...CHECK, amountCents: 1 });
    expect(await again.json()).toEqual({ success: true, already: true, depositId: '7303', number: 'DEP-43', amountCents: 250050 });
    expect(netsuite.createCustomerDeposit).toHaveBeenCalledTimes(1);
    expect(netsuite.getDepositSalesOrder).toHaveBeenCalledTimes(1);
  });

  it("takes an ACH deposit on 1084's order, with no number on NetSuite's side", async () => {
    netsuite.getDepositSalesOrder.mockResolvedValue({ ...ORDER, subsidiaryId: '3' });
    netsuite.findCustomerDeposit.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ depositId: '7304', number: '' });
    netsuite.createCustomerDeposit.mockResolvedValueOnce({ success: true, depositId: '7304' });
    const res = await post({ ...CHECK, method: 'ach', reference: '', memo: '', amountCents: 10000 });
    expect(await res.json()).toEqual({ success: true, depositId: '7304', number: null, amountCents: 10000 });
    expect(netsuite.createCustomerDeposit.mock.calls[0][0]).toMatchObject({ subsidiaryId: '3', amount: 100, checkNumber: null, memo: 'ACH' });
    expect(press(REQUEST)).toMatchObject({ status: 'made', company: '1084', method: 'ach', reference: null, netsuite_number: null });
    expect(state.rpcs[2][1].p).toMatchObject({ company: '1084', netsuite_number: null, memo: 'ACH', amount: '100.00' });
  });

  it("works it out again from the order as NetSuite has it now and the deposits on it, and sends nothing that doesn't fit", async () => {
    netsuite.getDepositSalesOrder.mockResolvedValueOnce({ ...ORDER, status: 'G', statusName: 'Billed' });
    const billed = await post(CHECK);
    expect(billed.status).toBe(400);
    expect(await billed.json()).toEqual({
      error: 'SO1450 is billed in NetSuite already: receive the payment on its invoice instead. Nothing was sent.',
      problems: ['SO1450 is billed in NetSuite already: receive the payment on its invoice instead.'],
    });

    state.tables.received_deposits = [earlier({ id: P(5), sales_order_netsuite_id: '4521', netsuite_deposit_id: '7301', amount_cents: 1000000 })];
    state.tables.gl_netsuite_deposits = [copied({ netsuite_id: '7200', total: '2000.00' }), copied({ netsuite_id: '7301', total: '10000.00' })];
    expect((await (await post(CHECK)).json()).problems).toEqual([
      'SO1450 has $500.40 left after the $12,000.00 in deposits on it, less than the $2,500.50 deposit.',
    ]);
    expect((await (await post({ ...CHECK, date: '2026-11-01', amountCents: 50040 })).json()).problems)
      .toEqual(["A deposit can't be dated after today."]);
    expect((await post({ ...CHECK, method: 'cash' })).status).toBe(400);
    expect((await post({ ...CHECK, requestId: 'not-a-uuid' })).status).toBe(400);
    expect((await post({ ...CHECK, salesOrderId: 'SO1450' })).status).toBe(400);
    expect(state.rpcs).toEqual([]);
    expect(netsuite.createCustomerDeposit).not.toHaveBeenCalled();
  });

  it("doesn't count a press of the same form that got to the claim while NetSuite was being read", async () => {
    netsuite.getDepositSalesOrder.mockImplementationOnce(async () => {
      state.tables.received_deposits.push(earlier({
        id: REQUEST, sales_order_netsuite_id: '4521', status: 'sending', sent_by: OTHER, sent_at: NOW, created_at: NOW,
        netsuite_deposit_id: null, netsuite_number: null, amount_cents: 700000,
      }));
      return ORDER;
    });
    const res = await post({ ...CHECK, amountCents: 700000 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });
    expect(netsuite.createCustomerDeposit).not.toHaveBeenCalled();
  });

  it("sends nothing for an order NetSuite doesn't have, or whose company isn't in Books", async () => {
    netsuite.getDepositSalesOrder.mockRejectedValueOnce(new Error('socket hang up'));
    const failed = await post(CHECK);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Couldn't read the sales order from NetSuite (socket hang up). Nothing was sent." });
    netsuite.getDepositSalesOrder.mockResolvedValueOnce(null);
    const missing = await post(CHECK);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'NetSuite has no sales order with id 4521. Nothing was sent.' });
    for (const subsidiaryId of ['9', null]) {
      netsuite.getDepositSalesOrder.mockResolvedValueOnce({ ...ORDER, subsidiaryId });
      const res = await post(CHECK);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "SO1450's company isn't in Books, so FleetSuite can't tell whose deposit this is. Nothing was sent." });
    }
    expect(state.rpcs).toEqual([]);
    expect(netsuite.createCustomerDeposit).not.toHaveBeenCalled();
  });

  it('turns away a check FleetSuite has from the customer already, as a deposit or a payment, made or being made', async () => {
    const tail = " Nothing was sent. If it's another check with the same number, add a letter to its number.";
    state.tables.received_deposits = [earlier({ reference: '#10442' })];
    const res = await post(CHECK);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `Check #10442 from Acme Plumbing was taken in FleetSuite already, on Oct 29, 2026, as a deposit on SO1400 (DEP-40).${tail}`,
    });
    state.tables.received_deposits = [earlier({ status: 'sending', netsuite_deposit_id: null, netsuite_number: null, sales_order_number: null })];
    expect((await (await post(CHECK)).json()).error).toBe(
      `Check 10442 from Acme Plumbing was taken in FleetSuite already, on Oct 29, 2026, as a deposit on a sales order, and is being made in NetSuite.${tail}`,
    );
    state.tables.received_deposits = [];
    state.tables.received_payments = [{
      id: P(8), customer_netsuite_id: '501', method: 'check', reference: '10442', received_date: '2026-10-28', status: 'made',
      netsuite_number: 'PYMT-300', created_at: ago(60 * 72),
    }];
    expect((await (await post(CHECK)).json()).error).toBe(
      `Check 10442 from Acme Plumbing was taken in FleetSuite already, on Oct 28, 2026, as a payment (PYMT-300).${tail}`,
    );
    state.tables.received_payments[0].netsuite_number = null;
    expect((await (await post(CHECK)).json()).error).toBe(
      `Check 10442 from Acme Plumbing was taken in FleetSuite already, on Oct 28, 2026, as a payment.${tail}`,
    );
    expect(state.rpcs).toEqual([]);

    // Not one that was let go, another customer's, an ACH deposit's, or another number.
    state.tables.received_payments = [];
    for (const over of [
      { status: 'open', netsuite_deposit_id: null, netsuite_number: null }, { customer_netsuite_id: '777' }, { method: 'ach' }, { reference: '10442A' },
    ]) {
      state.tables.received_deposits = [earlier(over)];
      state.rpcs.length = 0;
      netsuite.findCustomerDeposit.mockReset().mockResolvedValueOnce(null).mockResolvedValue({ depositId: '7303', number: 'DEP-43' });
      expect((await post(CHECK)).status).toBe(200);
      expect(rpcNames()[0]).toBe('received_deposit_claim');
      state.tables.received_deposits = [];
    }
    // Nor an ACH deposit whose reference is a check's number, nor a payment that was let go.
    state.tables.received_deposits = [earlier({ reference: '0187' })];
    state.tables.received_payments = [{
      id: P(8), customer_netsuite_id: '501', method: 'check', reference: '10442', received_date: '2026-10-28', status: 'open',
      netsuite_number: null, created_at: ago(60),
    }];
    for (const body of [{ ...CHECK, requestId: P(5), method: 'ach', reference: '0187' }, { ...CHECK, requestId: P(6) }]) {
      state.rpcs.length = 0;
      netsuite.findCustomerDeposit.mockReset().mockResolvedValueOnce(null).mockResolvedValue({ depositId: '7303', number: 'DEP-43' });
      expect((await post(body)).status).toBe(200);
      expect(rpcNames()[0]).toBe('received_deposit_claim');
    }
  });

  it("finishes a deposit NetSuite has already under the press's name, without making another", async () => {
    netsuite.findCustomerDeposit.mockReset().mockResolvedValue({ depositId: '7303', number: 'DEP-43' });
    const res = await post(CHECK);
    expect(await res.json()).toEqual({ success: true, already: true, depositId: '7303', number: 'DEP-43', amountCents: 250050 });
    expect(netsuite.createCustomerDeposit).not.toHaveBeenCalled();
    expect(press(REQUEST)).toMatchObject({ status: 'made', netsuite_deposit_id: '7303' });
    expect(rpcNames()).toEqual(['received_deposit_claim', 'received_deposit_made', 'gl_own_deposit_save']);
    expect((logAudit as any).mock.calls[0][1].detail).toMatchObject({ found_in_netsuite: true });

    netsuite.findCustomerDeposit.mockReset().mockResolvedValue({ depositId: '7306', number: '' });
    expect(await (await post({ ...CHECK, requestId: P(2), reference: '10443' })).json()).toEqual({
      success: true, already: true, depositId: '7306', number: null, amountCents: 250050,
    });
  });

  it("lets go and sends nothing when it can't ask NetSuite first, so the same form can be sent again", async () => {
    netsuite.findCustomerDeposit.mockReset().mockRejectedValueOnce(new Error("FleetSuite can't see NetSuite's customer deposits, so it can't tell whether this one was made"));
    const res = await post(CHECK);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Couldn't check NetSuite for this deposit (FleetSuite can't see NetSuite's customer deposits, so it can't tell whether this one was made). Nothing was sent. Try again.",
    });
    expect(netsuite.createCustomerDeposit).not.toHaveBeenCalled();
    expect(press(REQUEST)).toMatchObject({ status: 'open', sent_at: null });

    netsuite.findCustomerDeposit.mockResolvedValueOnce(null).mockResolvedValue({ depositId: '7303', number: 'DEP-43' });
    expect(await (await post(CHECK)).json()).toMatchObject({ success: true, depositId: '7303' });
    expect(netsuite.createCustomerDeposit).toHaveBeenCalledTimes(1);
  });

  it('lets go when NetSuite refuses it, with why, and takes the same form again', async () => {
    netsuite.createCustomerDeposit.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): The period is closed.' });
    const res = await post(CHECK);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'NetSuite error (400): The period is closed. No deposit was taken.' });
    expect(press(REQUEST)).toMatchObject({ status: 'open', error: 'NetSuite error (400): The period is closed.' });
    expect(rpcNames()).toEqual(['received_deposit_claim', 'received_deposit_let_go']);

    netsuite.findCustomerDeposit.mockResolvedValueOnce(null).mockResolvedValue({ depositId: '7303', number: 'DEP-43' });
    const again = await post({ ...CHECK, date: '2026-10-31' });
    expect(await again.json()).toMatchObject({ success: true, depositId: '7303' });
    expect(netsuite.createCustomerDeposit.mock.calls[1][0]).toMatchObject({ tranDate: '2026-10-31' });
    expect(press(REQUEST)).toMatchObject({ status: 'made', received_date: '2026-10-31', error: null });
  });

  it('lets go when NetSuite answers with no deposit and says nothing more', async () => {
    netsuite.createCustomerDeposit.mockResolvedValueOnce({ success: true });
    const res = await post(CHECK);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "NetSuite didn't make the deposit. No deposit was taken." });
    expect(press(REQUEST)).toMatchObject({ status: 'open', error: "NetSuite didn't make the deposit." });
  });

  it("holds a deposit NetSuite may have made, and asks NetSuite about it once it's been a while", async () => {
    netsuite.createCustomerDeposit.mockResolvedValueOnce({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
    const res = await post(CHECK);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "NetSuite didn't answer (socket hang up). FleetSuite can't tell whether NetSuite made it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.",
      unsure: true,
    });
    expect(press(REQUEST)).toMatchObject({ status: 'sending', error: "NetSuite didn't answer (socket hang up)." });
    expect(rpcNames()).toEqual(['received_deposit_claim']);

    // Asked again straight away, or at five minutes: nothing is asked or sent.
    for (const minutes of [0, 5]) {
      vi.clearAllMocks();
      vi.setSystemTime(new Date(Date.parse(NOW) + minutes * 60_000));
      const soon = await post(CHECK);
      expect(soon.status).toBe(409);
      expect(await soon.json()).toEqual({
        error: "NetSuite didn't say whether it made this deposit (NetSuite didn't answer (socket hang up).). Press Ask NetSuite in a few minutes and FleetSuite will find out.",
        unsure: true,
      });
      expect(netsuite.findCustomerDeposit).not.toHaveBeenCalled();
      expect(netsuite.getDepositSalesOrder).not.toHaveBeenCalled();
    }

    // Six minutes on, someone else asks and NetSuite has it: it's made, and Books' copy says who sent it.
    vi.setSystemTime(new Date(Date.parse(NOW) + 6 * 60_000));
    state.userId = OTHER;
    netsuite.findCustomerDeposit.mockReset().mockResolvedValue({ depositId: '7305', number: 'DEP-45' });
    const asked = await post(CHECK);
    expect(await asked.json()).toEqual({ success: true, already: true, depositId: '7305', number: 'DEP-45', amountCents: 250050 });
    expect(netsuite.findCustomerDeposit).toHaveBeenCalledWith(EXTERNAL);
    expect(netsuite.createCustomerDeposit).not.toHaveBeenCalled();
    expect(press(REQUEST)).toMatchObject({ status: 'made', netsuite_deposit_id: '7305', error: null });
    const copy = state.rpcs.at(-1);
    expect(copy?.[0]).toBe('gl_own_deposit_save');
    expect(copy?.[1].p).toMatchObject({ netsuite_id: '7305', made_from_id: REQUEST, made_by: STAFF });
    expect((logAudit as any).mock.calls[0][1]).toMatchObject({ actorId: OTHER, detail: { found_in_netsuite: true } });
  });

  it("lets go of a held deposit NetSuite doesn't have, and keeps holding it when NetSuite can't say", async () => {
    state.tables.received_deposits = [earlier({
      id: REQUEST, sales_order_netsuite_id: '4521', status: 'sending', sent_by: STAFF, sent_at: ago(10), netsuite_deposit_id: null,
      netsuite_number: null, error: 'NetSuite error (503): busy',
    })];
    netsuite.findCustomerDeposit.mockReset().mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503): busy'));
    const cant = await post(CHECK);
    expect(cant.status).toBe(502);
    expect(await cant.json()).toEqual({ error: "Couldn't ask NetSuite what became of this deposit (NetSuite SuiteQL error (503): busy). Try again.", unsure: true });
    expect(press(REQUEST)).toMatchObject({ status: 'sending' });

    netsuite.findCustomerDeposit.mockResolvedValueOnce(null);
    const none = await post(CHECK);
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'NetSuite has no deposit from this press, so none was taken. Check the order and press Take deposit again.' });
    expect(press(REQUEST)).toMatchObject({ status: 'open', error: 'NetSuite has no deposit from this press, so none was taken.' });
    expect(netsuite.createCustomerDeposit).not.toHaveBeenCalled();
  });

  it("says it's being made when pressed again while it is", async () => {
    state.tables.received_deposits = [earlier({ id: REQUEST, status: 'sending', sent_at: ago(1), netsuite_deposit_id: null, netsuite_number: null })];
    const res = await post(CHECK);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });
    expect(netsuite.findCustomerDeposit).not.toHaveBeenCalled();
    expect(netsuite.getDepositSalesOrder).not.toHaveBeenCalled();
  });

  it('says what became of the form when another press of it got to the claim first', async () => {
    const theirs = (over: Record<string, any>) => () => {
      state.tables.received_deposits.push(earlier({ id: REQUEST, sent_by: OTHER, sent_at: NOW, created_at: NOW, ...over }));
    };
    state.beforeClaim = theirs({ status: 'sending', netsuite_deposit_id: null, netsuite_number: null });
    const making = await post(CHECK);
    expect(making.status).toBe(409);
    expect(await making.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });

    state.tables.received_deposits = [];
    state.beforeClaim = theirs({ amount_cents: 250050 });
    expect(await (await post(CHECK)).json()).toEqual({ success: true, already: true, depositId: '7300', number: 'DEP-40', amountCents: 250050 });
    expect(netsuite.findCustomerDeposit).not.toHaveBeenCalled();
    expect(netsuite.createCustomerDeposit).not.toHaveBeenCalled();
  });

  it("says so when it can't keep Books' copy, and the deposit stands", async () => {
    state.ownSave = { data: null, error: { message: "gl: company BMG doesn't exist" } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(CHECK);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, depositId: '7303', number: 'DEP-43', amountCents: 250050,
      booksWarning: "Books didn't keep its copy (gl: company BMG doesn't exist). The deposit is in NetSuite.",
    });
    expect(press(REQUEST)).toMatchObject({ status: 'made' });

    // A copy that's there already is kept.
    state.ownSave = { data: { saved: false }, error: null };
    netsuite.findCustomerDeposit.mockReset().mockResolvedValue({ depositId: '7306', number: 'DEP-46' });
    expect(await (await post({ ...CHECK, requestId: P(2), reference: '10443' })).json()).toEqual({
      success: true, already: true, depositId: '7306', number: 'DEP-46', amountCents: 250050,
    });
  });

  it("shows the deposit made when NetSuite's number can't be read after, or keeping it on the press fails", async () => {
    netsuite.findCustomerDeposit.mockReset().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('busy'));
    state.madeError = { message: 'connection reset' };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await (await post(CHECK)).json()).toEqual({ success: true, depositId: '7303', number: null, amountCents: 250050 });
    expect(rpcNames()).toEqual(['received_deposit_claim', 'received_deposit_made', 'gl_own_deposit_save']);
    expect(log).toHaveBeenCalledWith(`[deposits] press ${REQUEST} made as NetSuite deposit 7303 but not kept: connection reset`);
  });
});
