// /api/invoices/payment (src/lib/receive-payment.ts): who can open it while
// receiving payments is switched off and once it's on, and what one press of
// Receive payment does: the payment worked out again from what NetSuite has
// open now, a check FleetSuite has from the customer already turned away, the
// payment made once in NetSuite under the press's own External ID however
// often it's pressed, let go when NetSuite refuses, held when NetSuite can't
// say and asked about later, checked against what NetSuite shows open after,
// and Books' own copy kept. Made-up data.
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
    getPaymentInvoices: vi.fn(),
    getInvoicesOpen: vi.fn(),
    findCustomerPayment: vi.fn(),
    createCustomerPayment: vi.fn(),
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
      gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return builder; },
      order: (c: string, o?: { ascending?: boolean }) => { sorts.push([c, o?.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      update: (p: Record<string, any>) => { patch = p; return builder; },
      maybeSingle: async () => ({ data: run().data?.[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  // received_payment_claim, _let_go and _made as migration 485 has them, on the in-memory table.
  const presses = () => (state.tables.received_payments ??= []);
  const content = (p: Record<string, any>) => ({
    company: p.company, customer_netsuite_id: p.customer_netsuite_id, customer_name: p.customer_name || null,
    started_from_invoice_id: p.started_from_invoice_id, received_date: p.received_date, method: p.method,
    reference: p.reference || null, memo: p.memo || null, amount_cents: p.amount_cents, applied: p.applied,
  });
  const rpcs: Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }> = {
    received_payment_claim: (p) => {
      if (state.beforeClaim) { const first = state.beforeClaim; state.beforeClaim = null; first(); }
      const now = new Date().toISOString();
      const r = presses().find((x) => x.id === p.id);
      if (!r) {
        const row = {
          id: p.id, ...content(p), status: 'sending', sent_by: p.by, sent_at: now, netsuite_payment_id: null, netsuite_number: null,
          error: null, warning: null, created_by: p.by, created_at: now, updated_at: now,
        };
        presses().push(row);
        return { data: { state: 'claimed', payment: { ...row } }, error: null };
      }
      if (r.status === 'made') return { data: { state: 'made', netsuite_payment_id: r.netsuite_payment_id, netsuite_number: r.netsuite_number }, error: null };
      if (r.status === 'sending') return { data: { state: 'sending', payment: { ...r } }, error: null };
      Object.assign(r, content(p), { status: 'sending', sent_by: p.by, sent_at: now, error: null, updated_at: now });
      return { data: { state: 'claimed', payment: { ...r } }, error: null };
    },
    received_payment_let_go: (p) => {
      const r = presses().find((x) => x.id === p.id && x.status === 'sending');
      if (r) Object.assign(r, { status: 'open', sent_by: null, sent_at: null, error: p.error });
      return { data: { let_go: !!r }, error: null };
    },
    received_payment_made: (p) => {
      if (state.madeError) return { data: null, error: state.madeError };
      const r = presses().find((x) => x.id === p.id && x.status === 'sending');
      if (r) Object.assign(r, { status: 'made', netsuite_payment_id: p.netsuite_payment_id, netsuite_number: p.netsuite_number, error: null, warning: p.warning });
      return { data: { made: !!r }, error: null };
    },
    gl_own_payment_save: (p) => state.ownSave ?? { data: { saved: true, lines: p.applications.length }, error: null },
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
import { GET, POST } from '../app/api/invoices/payment/route';

const P = (n: number) => `b0000000-0000-4000-8000-00000000000${n}`;
const REQUEST = P(1);
const NOW = '2026-10-31T17:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

const OPEN = [
  { id: '8990', number: 'INV1990', date: '2026-09-03', dueDate: '2026-10-03', po: 'PO-77', totalCents: 120000, openCents: 40010 },
  { id: '9001', number: 'INV2001', date: '2026-10-01', dueDate: '2026-10-31', po: null, totalCents: 25000, openCents: 25000 },
];
const READ = {
  invoice: { id: '9001', number: 'INV2001', customerId: '501', customerName: 'Acme Plumbing', subsidiaryId: '2', openCents: 25000 },
  open: OPEN,
  elsewhere: 1,
};
/** Acme's check 10442 for both its open invoices. */
const CHECK = {
  requestId: REQUEST, invoiceId: '9001', date: '2026-10-30', method: 'check', reference: '10442', memo: 'September',
  amountCents: 65010, applied: [{ invoiceId: '9001', cents: 25000 }, { invoiceId: '8990', cents: 40010 }],
};

const get = (query: string) => GET(new NextRequest(`https://app.test/api/invoices/payment?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/invoices/payment', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'customer_payments', is_on: on }]; };
const press = (id: string) => state.tables.received_payments?.find((r) => r.id === id);
const rpcNames = () => state.rpcs.map(([fn]) => fn);
/** A press made earlier from the same customer. */
const earlier = (over: Record<string, any>) => ({
  id: P(9), company: 'BMG', customer_netsuite_id: '501', customer_name: 'Acme Plumbing', received_date: '2026-10-29', method: 'check',
  reference: '10442', memo: null, amount_cents: 10000, applied: [{ invoice_netsuite_id: '8980', invoice_number: 'INV1980', cents: 10000 }],
  status: 'made', sent_by: OTHER, sent_at: ago(60 * 48), netsuite_payment_id: '7100', netsuite_number: 'PYMT-300', error: null, warning: null,
  created_at: ago(60 * 48), ...over,
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
    received_payments: [],
  };
  state.rpcs.length = 0;
  state.ownSave = null;
  state.madeError = null;
  state.beforeClaim = null;
  switchOn(true);
  vi.clearAllMocks();
  for (const fn of Object.values(netsuite)) fn.mockReset();
  netsuite.getPaymentInvoices.mockResolvedValue(READ);
  netsuite.findCustomerPayment.mockResolvedValueOnce(null).mockResolvedValue({ paymentId: '7101', number: 'PYMT-301' });
  netsuite.createCustomerPayment.mockResolvedValue({ success: true, paymentId: '7101' });
  netsuite.getInvoicesOpen.mockResolvedValue(new Map([['8990', 0], ['9001', 0]]));
});

afterEach(() => { vi.useRealTimers(); });

describe('while receiving payments is switched off', () => {
  beforeEach(() => switchOn(false));

  it('shows the Payment button to super admins only, and to nobody who can\'t see prices', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.roles = ['super_admin'];
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true });
    state.canSeeMoney = false;
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.hasInvoicing = false;
    expect((await get('status=1')).status).toBe(403);
  });

  it('lets a super admin see what it would send, and nobody else', async () => {
    const refused = await get('invoice=9001');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Receiving payments is switched off until payments move into FleetSuite during 2027.', switchedOff: true });
    expect(netsuite.getPaymentInvoices).not.toHaveBeenCalled();

    state.roles = ['super_admin'];
    const res = await get('invoice=9001');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      today: '2026-10-31',
      customer: { id: '501', name: 'Acme Plumbing' },
      company: 'BMG',
      invoice: { id: '9001', number: 'INV2001', openCents: 25000 },
      open: OPEN,
      elsewhere: 1,
      earlier: [],
      switchedOn: false,
      offText: 'Receiving payments is switched off until payments move into FleetSuite during 2027. You can see what it would send; nothing goes to NetSuite.',
    });
    expect(netsuite.getPaymentInvoices).toHaveBeenCalledWith('9001');
  });

  it('sends nothing, for a super admin either', async () => {
    state.roles = ['super_admin'];
    const res = await post(CHECK);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Receiving payments is switched off until payments move into FleetSuite during 2027. Nothing was sent to NetSuite.', switchedOff: true,
    });
    expect(netsuite.getPaymentInvoices).not.toHaveBeenCalled();
    expect(netsuite.createCustomerPayment).not.toHaveBeenCalled();
    expect(state.rpcs).toEqual([]);
  });
});

describe('once receiving payments is on', () => {
  it("opens to anyone with Invoicing who can see prices", async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });
    const res = await get('invoice=9001');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ switchedOn: true, offText: null, company: 'BMG' });

    state.canSeeMoney = false;
    for (const res2 of [await get('invoice=9001'), await post(CHECK)]) {
      expect(res2.status).toBe(403);
      expect(await res2.json()).toEqual({ error: 'Forbidden: this account cannot see billing' });
    }
    state.canSeeMoney = true;
    state.hasInvoicing = false;
    expect((await get('invoice=9001')).status).toBe(403);
    expect((await post(CHECK)).status).toBe(403);
    expect(netsuite.createCustomerPayment).not.toHaveBeenCalled();
  });

  it("says when the invoice can't be read", async () => {
    expect((await get('invoice=INV2001')).status).toBe(400);
    netsuite.getPaymentInvoices.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (400): bad column'));
    const failed = await get('invoice=9001');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Couldn't read the invoices from NetSuite (NetSuite SuiteQL error (400): bad column)." });
    netsuite.getPaymentInvoices.mockResolvedValueOnce({ invoice: null, open: [], elsewhere: 0 });
    const missing = await get('invoice=9002');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'NetSuite has no invoice with id 9002.' });
    netsuite.getPaymentInvoices.mockResolvedValueOnce({ ...READ, invoice: { ...READ.invoice, subsidiaryId: '9' } });
    expect(await (await get('invoice=9001')).json()).toMatchObject({ company: null });
  });

  it("lists what FleetSuite received from the customer lately, made or being made, newest first", async () => {
    state.tables.received_payments = [
      earlier({ id: P(5), created_at: ago(60 * 24), received_date: '2026-10-30', method: 'ach', reference: '0187', amount_cents: 5000 }),
      earlier({ id: P(6), created_at: ago(60 * 24 * 61) }),
      earlier({ id: P(7), status: 'open', netsuite_payment_id: null, netsuite_number: null, error: 'NetSuite error (400): no' }),
      earlier({ id: P(8), customer_netsuite_id: '777' }),
      earlier({ id: P(9), created_at: ago(30), status: 'sending', netsuite_payment_id: null, netsuite_number: null, warning: null }),
      earlier({ id: P(4), created_at: ago(60 * 72), warning: 'NetSuite shows INV1980 with $100.00 open now.' }),
    ];
    const body = await (await get('invoice=9001')).json();
    expect(body.earlier).toEqual([
      {
        id: P(9), paymentId: null, number: null, date: '2026-10-29', method: 'check', reference: '10442', amountCents: 10000,
        invoices: ['INV1980'], making: true, warning: null, at: ago(30),
      },
      {
        id: P(5), paymentId: '7100', number: 'PYMT-300', date: '2026-10-30', method: 'ach', reference: '0187', amountCents: 5000,
        invoices: ['INV1980'], making: false, warning: null, at: ago(60 * 24),
      },
      {
        id: P(4), paymentId: '7100', number: 'PYMT-300', date: '2026-10-29', method: 'check', reference: '10442', amountCents: 10000,
        invoices: ['INV1980'], making: false, warning: 'NetSuite shows INV1980 with $100.00 open now.', at: ago(60 * 72),
      },
    ]);
  });

  it('makes the payment once in NetSuite, applied as worked out, and keeps Books\' own copy', async () => {
    const res = await post(CHECK);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, paymentId: '7101', number: 'PYMT-301', amountCents: 65010 });

    expect(netsuite.getPaymentInvoices).toHaveBeenCalledWith('9001');
    expect(netsuite.findCustomerPayment.mock.calls).toEqual([[`fleetsuite-cp-${REQUEST}`], [`fleetsuite-cp-${REQUEST}`]]);
    expect(netsuite.createCustomerPayment).toHaveBeenCalledTimes(1);
    expect(netsuite.createCustomerPayment).toHaveBeenCalledWith({
      externalId: `fleetsuite-cp-${REQUEST}`, customerId: '501', subsidiaryId: '2', tranDate: '2026-10-30', amount: 650.1,
      checkNumber: '10442', memo: 'Check 10442 · September',
      apply: [{ invoiceId: '8990', amount: 400.1 }, { invoiceId: '9001', amount: 250 }],
    });
    expect(netsuite.getInvoicesOpen).toHaveBeenCalledWith(['8990', '9001']);

    expect(rpcNames()).toEqual(['received_payment_claim', 'received_payment_made', 'gl_own_payment_save']);
    expect(state.rpcs[0][1].p).toEqual({
      id: REQUEST, by: STAFF, company: 'BMG', customer_netsuite_id: '501', customer_name: 'Acme Plumbing', started_from_invoice_id: '9001',
      received_date: '2026-10-30', method: 'check', reference: '10442', memo: 'September', amount_cents: 65010,
      applied: [
        { invoice_netsuite_id: '8990', invoice_number: 'INV1990', cents: 40010 },
        { invoice_netsuite_id: '9001', invoice_number: 'INV2001', cents: 25000 },
      ],
    });
    expect(press(REQUEST)).toMatchObject({ status: 'made', netsuite_payment_id: '7101', netsuite_number: 'PYMT-301', warning: null });
    expect(state.rpcs[2][1].p).toEqual({
      netsuite_id: '7101', netsuite_number: 'PYMT-301', company: 'BMG', made_from_id: REQUEST, customer_netsuite_id: '501', customer_id: 'c1',
      payment_date: '2026-10-30', method: 'check', reference: '10442', memo: 'Check 10442 · September', deposited_to: 'undeposited_funds',
      amount: '650.10', made_by: STAFF,
      applications: [
        { line_no: 1, invoice_netsuite_id: '8990', invoice_number: 'INV1990', amount: '400.10' },
        { line_no: 2, invoice_netsuite_id: '9001', invoice_number: 'INV2001', amount: '250.00' },
      ],
    });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: STAFF, table: 'received_payments', recordId: REQUEST, action: 'create',
      detail: {
        netsuite_payment_id: '7101', netsuite_number: 'PYMT-301', company: 'BMG', customer: 'Acme Plumbing', date: '2026-10-30',
        method: 'check', reference: '10442', total: '$650.10', invoices: 2, found_in_netsuite: false, applied_as_sent: true,
      },
    });

    // Pressed again, by anyone: it's made, and nothing goes to NetSuite.
    state.userId = OTHER;
    const again = await post({ ...CHECK, amountCents: 1, applied: [] });
    expect(await again.json()).toEqual({ success: true, already: true, paymentId: '7101', number: 'PYMT-301', amountCents: 65010 });
    expect(netsuite.createCustomerPayment).toHaveBeenCalledTimes(1);
    expect(netsuite.getPaymentInvoices).toHaveBeenCalledTimes(1);
  });

  it('takes an ACH payment of part of one invoice, with no number on NetSuite\'s side', async () => {
    netsuite.findCustomerPayment.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ paymentId: '7102', number: '' });
    netsuite.createCustomerPayment.mockResolvedValueOnce({ success: true, paymentId: '7102' });
    netsuite.getInvoicesOpen.mockResolvedValueOnce(new Map([['8990', 30010]]));
    const res = await post({ ...CHECK, method: 'ach', reference: '', memo: '', amountCents: 10000, applied: [{ invoiceId: '8990', cents: 10000 }] });
    expect(await res.json()).toEqual({ success: true, paymentId: '7102', number: null, amountCents: 10000 });
    expect(netsuite.createCustomerPayment.mock.calls[0][0]).toMatchObject({ amount: 100, checkNumber: null, memo: 'ACH', apply: [{ invoiceId: '8990', amount: 100 }] });
    expect(press(REQUEST)).toMatchObject({ status: 'made', method: 'ach', reference: null, netsuite_number: null });
  });

  it("works it out again from what NetSuite has open now, and sends nothing that doesn't fit", async () => {
    netsuite.getPaymentInvoices.mockResolvedValue({ ...READ, open: [OPEN[0], { ...OPEN[1], openCents: 10000 }] });
    const res = await post(CHECK);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'INV2001 has $100.00 open in NetSuite now, less than the $250.00 it pays. Nothing was sent.',
      problems: ['INV2001 has $100.00 open in NetSuite now, less than the $250.00 it pays.'],
    });
    netsuite.getPaymentInvoices.mockResolvedValue({ ...READ, open: [OPEN[1]] });
    expect((await (await post(CHECK)).json()).problems).toEqual([
      "Invoice 8990 isn't open for this customer in NetSuite now, so nothing can be paid on it.",
      'It pays $250.00 of the $650.10: put the other $400.10 on an invoice, or change the amount.',
    ]);
    expect((await (await post({ ...CHECK, date: '2026-11-01', applied: [CHECK.applied[0]], amountCents: 25000 })).json()).problems)
      .toEqual(["A payment can't be dated after today."]);
    expect((await post({ ...CHECK, method: 'cash' })).status).toBe(400);
    expect((await post({ ...CHECK, requestId: 'not-a-uuid' })).status).toBe(400);
    expect(state.rpcs).toEqual([]);
    expect(netsuite.createCustomerPayment).not.toHaveBeenCalled();
  });

  it("sends nothing for an invoice NetSuite doesn't have, or whose company isn't in Books", async () => {
    netsuite.getPaymentInvoices.mockRejectedValueOnce(new Error('socket hang up'));
    const failed = await post(CHECK);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Couldn't read the invoices from NetSuite (socket hang up). Nothing was sent." });
    netsuite.getPaymentInvoices.mockResolvedValueOnce({ invoice: null, open: [], elsewhere: 0 });
    expect((await post(CHECK)).status).toBe(404);
    for (const subsidiaryId of ['9', null]) {
      netsuite.getPaymentInvoices.mockResolvedValueOnce({ ...READ, invoice: { ...READ.invoice, subsidiaryId } });
      const res = await post(CHECK);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invoice INV2001's company isn't in Books, so FleetSuite can't tell whose payment this is. Nothing was sent." });
    }
    expect(state.rpcs).toEqual([]);
    expect(netsuite.createCustomerPayment).not.toHaveBeenCalled();
  });

  it('turns away a check FleetSuite has from the customer already, made or being made', async () => {
    state.tables.received_payments = [earlier({ reference: '#10442' })];
    const res = await post(CHECK);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Check #10442 from Acme Plumbing was received in FleetSuite already, on Oct 29, 2026 (PYMT-300). Nothing was sent. If it's another check with the same number, add a letter to its number.",
    });
    state.tables.received_payments = [earlier({ status: 'sending', netsuite_payment_id: null, netsuite_number: null })];
    expect((await (await post(CHECK)).json()).error).toBe(
      "Check 10442 from Acme Plumbing was received in FleetSuite already, on Oct 29, 2026, and is being made in NetSuite. Nothing was sent. If it's another check with the same number, add a letter to its number.",
    );
    expect(state.rpcs).toEqual([]);

    // Not one that was let go, another customer's, an ACH payment's, or another number.
    for (const over of [
      { status: 'open', netsuite_payment_id: null, netsuite_number: null }, { customer_netsuite_id: '777' }, { method: 'ach' }, { reference: '10442A' },
    ]) {
      state.tables.received_payments = [earlier(over)];
      state.rpcs.length = 0;
      netsuite.findCustomerPayment.mockReset().mockResolvedValueOnce(null).mockResolvedValue({ paymentId: '7101', number: 'PYMT-301' });
      expect((await post(CHECK)).status).toBe(200);
      expect(rpcNames()[0]).toBe('received_payment_claim');
    }
  });

  it("finishes a payment NetSuite has already under the press's name, without making another", async () => {
    netsuite.findCustomerPayment.mockReset().mockResolvedValue({ paymentId: '7101', number: 'PYMT-301' });
    const res = await post(CHECK);
    expect(await res.json()).toEqual({ success: true, already: true, paymentId: '7101', number: 'PYMT-301', amountCents: 65010 });
    expect(netsuite.createCustomerPayment).not.toHaveBeenCalled();
    expect(press(REQUEST)).toMatchObject({ status: 'made', netsuite_payment_id: '7101' });
    expect(rpcNames()).toEqual(['received_payment_claim', 'received_payment_made', 'gl_own_payment_save']);
    expect((logAudit as any).mock.calls[0][1].detail).toMatchObject({ found_in_netsuite: true, applied_as_sent: true });
  });

  it("lets go and sends nothing when it can't ask NetSuite first, so the same form can be sent again", async () => {
    netsuite.findCustomerPayment.mockReset().mockRejectedValueOnce(new Error("FleetSuite can't see NetSuite's customer payments, so it can't tell whether this one was made"));
    const res = await post(CHECK);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Couldn't check NetSuite for this payment (FleetSuite can't see NetSuite's customer payments, so it can't tell whether this one was made). Nothing was sent. Try again.",
    });
    expect(netsuite.createCustomerPayment).not.toHaveBeenCalled();
    expect(press(REQUEST)).toMatchObject({ status: 'open', sent_at: null });

    netsuite.findCustomerPayment.mockResolvedValueOnce(null).mockResolvedValue({ paymentId: '7101', number: 'PYMT-301' });
    expect(await (await post(CHECK)).json()).toMatchObject({ success: true, paymentId: '7101' });
    expect(netsuite.createCustomerPayment).toHaveBeenCalledTimes(1);
  });

  it('lets go when NetSuite refuses it, with why, and takes the same form again', async () => {
    netsuite.createCustomerPayment.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): The period is closed.' });
    const res = await post(CHECK);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'NetSuite error (400): The period is closed. Nothing was paid.' });
    expect(press(REQUEST)).toMatchObject({ status: 'open', error: 'NetSuite error (400): The period is closed.' });
    expect(rpcNames()).toEqual(['received_payment_claim', 'received_payment_let_go']);

    netsuite.findCustomerPayment.mockResolvedValueOnce(null).mockResolvedValue({ paymentId: '7101', number: 'PYMT-301' });
    const again = await post({ ...CHECK, date: '2026-10-31' });
    expect(await again.json()).toMatchObject({ success: true, paymentId: '7101' });
    expect(netsuite.createCustomerPayment.mock.calls[1][0]).toMatchObject({ tranDate: '2026-10-31' });
    expect(press(REQUEST)).toMatchObject({ status: 'made', received_date: '2026-10-31', error: null });
  });

  it("holds a payment NetSuite may have made, and asks NetSuite about it once it's been a while", async () => {
    netsuite.createCustomerPayment.mockResolvedValueOnce({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
    const res = await post(CHECK);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "NetSuite didn't answer (socket hang up). FleetSuite can't tell whether NetSuite made it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.",
      unsure: true,
    });
    expect(press(REQUEST)).toMatchObject({ status: 'sending', error: "NetSuite didn't answer (socket hang up)." });
    expect(rpcNames()).toEqual(['received_payment_claim']);

    // Asked again straight away: nothing is asked or sent.
    vi.clearAllMocks();
    const soon = await post(CHECK);
    expect(soon.status).toBe(409);
    expect(await soon.json()).toEqual({
      error: "NetSuite didn't say whether it made this payment (NetSuite didn't answer (socket hang up).). Press Ask NetSuite in a few minutes and FleetSuite will find out.",
      unsure: true,
    });
    expect(netsuite.findCustomerPayment).not.toHaveBeenCalled();
    expect(netsuite.getPaymentInvoices).not.toHaveBeenCalled();

    // Six minutes on, someone else asks and NetSuite has it: it's made, and Books' copy says who sent it.
    vi.setSystemTime(new Date(Date.parse(NOW) + 6 * 60_000));
    state.userId = OTHER;
    netsuite.findCustomerPayment.mockReset().mockResolvedValue({ paymentId: '7103', number: 'PYMT-303' });
    const asked = await post(CHECK);
    expect(await asked.json()).toEqual({ success: true, already: true, paymentId: '7103', number: 'PYMT-303', amountCents: 65010 });
    expect(netsuite.createCustomerPayment).not.toHaveBeenCalled();
    expect(press(REQUEST)).toMatchObject({ status: 'made', netsuite_payment_id: '7103', error: null });
    const copy = state.rpcs.at(-1);
    expect(copy?.[0]).toBe('gl_own_payment_save');
    expect(copy?.[1].p).toMatchObject({ netsuite_id: '7103', made_from_id: REQUEST, made_by: STAFF });
  });

  it("lets go of a held payment NetSuite doesn't have, and keeps holding it when NetSuite can't say", async () => {
    state.tables.received_payments = [earlier({
      id: REQUEST, status: 'sending', sent_by: STAFF, sent_at: ago(10), netsuite_payment_id: null, netsuite_number: null, error: 'NetSuite error (503): busy',
    })];
    netsuite.findCustomerPayment.mockReset().mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503): busy'));
    const cant = await post(CHECK);
    expect(cant.status).toBe(502);
    expect(await cant.json()).toEqual({ error: "Couldn't ask NetSuite what became of this payment (NetSuite SuiteQL error (503): busy). Try again.", unsure: true });
    expect(press(REQUEST)).toMatchObject({ status: 'sending' });

    netsuite.findCustomerPayment.mockResolvedValueOnce(null);
    const none = await post(CHECK);
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'NetSuite has no payment from this press, so nothing was paid. Check the invoices and press Receive payment again.' });
    expect(press(REQUEST)).toMatchObject({ status: 'open', error: 'NetSuite has no payment from this press, so nothing was paid.' });
    expect(netsuite.createCustomerPayment).not.toHaveBeenCalled();
  });

  it("says it's being made when pressed again while it is", async () => {
    state.tables.received_payments = [earlier({ id: REQUEST, status: 'sending', sent_at: ago(1), netsuite_payment_id: null, netsuite_number: null })];
    const res = await post(CHECK);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });
    expect(netsuite.findCustomerPayment).not.toHaveBeenCalled();
  });

  it('says what became of the form when another press of it got to the claim first', async () => {
    const theirs = (over: Record<string, any>) => () => {
      state.tables.received_payments.push(earlier({ id: REQUEST, sent_by: OTHER, sent_at: NOW, created_at: NOW, ...over }));
    };
    state.beforeClaim = theirs({ status: 'sending', netsuite_payment_id: null, netsuite_number: null });
    const making = await post(CHECK);
    expect(making.status).toBe(409);
    expect(await making.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });

    state.tables.received_payments = [];
    state.beforeClaim = theirs({ amount_cents: 65010 });
    expect(await (await post(CHECK)).json()).toEqual({ success: true, already: true, paymentId: '7100', number: 'PYMT-300', amountCents: 65010 });
    expect(netsuite.findCustomerPayment).not.toHaveBeenCalled();
    expect(netsuite.createCustomerPayment).not.toHaveBeenCalled();
  });

  it("says so when NetSuite didn't apply it the way FleetSuite sent it, and keeps that on the press", async () => {
    netsuite.getInvoicesOpen.mockResolvedValueOnce(new Map([['8990', 0], ['9001', 25000]]));
    const res = await post(CHECK);
    const warning = 'NetSuite shows INV2001 with $250.00 open now, not the $0.00 this payment leaves. Look at the payment in NetSuite: it may not be applied the way FleetSuite sent it.';
    expect(await res.json()).toEqual({ success: true, paymentId: '7101', number: 'PYMT-301', amountCents: 65010, warning });
    expect(press(REQUEST)).toMatchObject({ status: 'made', warning });
    expect((logAudit as any).mock.calls[0][1].detail).toMatchObject({ applied_as_sent: false });

    // Shown again when it's pressed again.
    expect(await (await post(CHECK)).json()).toEqual({ success: true, already: true, paymentId: '7101', number: 'PYMT-301', amountCents: 65010, warning });
  });

  it("says so when it can't read the invoices back, or keep Books' copy, and the payment stands", async () => {
    netsuite.getInvoicesOpen.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (429): too many'));
    state.ownSave = { data: null, error: { message: 'gl: company BMG doesn\'t exist' } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(CHECK);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, paymentId: '7101', number: 'PYMT-301', amountCents: 65010,
      warning: "FleetSuite couldn't read the invoices back from NetSuite to check how it applied the payment (NetSuite SuiteQL error (429): too many). Look at the payment in NetSuite.",
      booksWarning: "Books didn't keep its copy (gl: company BMG doesn't exist). The payment is in NetSuite.",
    });
    expect(press(REQUEST)).toMatchObject({ status: 'made' });
  });

  it("shows the payment made when NetSuite's number can't be read after, or keeping it on the press fails", async () => {
    netsuite.findCustomerPayment.mockReset().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('busy'));
    state.madeError = { message: 'connection reset' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await (await post(CHECK)).json()).toEqual({ success: true, paymentId: '7101', number: null, amountCents: 65010 });
    expect(rpcNames()).toEqual(['received_payment_claim', 'received_payment_made', 'gl_own_payment_save']);
  });
});
