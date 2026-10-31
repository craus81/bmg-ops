// /api/invoices/credit-memo (src/lib/credit-memo.ts): who can open it while
// credit memos are switched off and once they're on, and what one press of
// Make credit memo does: the credit memo worked out again from the invoice as
// NetSuite has it now, made once in NetSuite however often it's pressed, the
// claim let go when NetSuite refuses, and Books' own copy kept. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    roles: ['admin'] as string[],
    hasInvoicing: true,
    tables: {} as Record<string, Record<string, any>[]>,
    rpcs: [] as Array<[string, Record<string, unknown>]>,
  };
  const netsuite = {
    getInvoiceRecord: vi.fn(),
    createCreditMemoFromInvoice: vi.fn(),
    getInvoiceCreditMemos: vi.fn(),
    suiteqlQuery: vi.fn(),
  };
  // An in-memory stand-in for the tables the route reads and writes.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    let patch: Record<string, any> | null = null;
    let returning = false;
    const rows = () => (state.tables[table] ??= []);
    const run = () => {
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (patch) {
        for (const r of matched) Object.assign(r, patch);
        return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: matched.map((r) => ({ ...r })), error: null };
    };
    const builder: any = {
      select: () => { if (patch) returning = true; return builder; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return builder; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return builder; },
      order: () => builder,
      update: (p: Record<string, any>) => { patch = p; return builder; },
      maybeSingle: async () => ({ data: run().data?.[0] ?? null, error: null }),
      insert: async (row: Record<string, any>) => {
        if (rows().some((r) => r.id === row.id)) return { error: { code: '23505', message: 'duplicate key value' } };
        rows().push({ ...row });
        return { error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, unknown>) => { state.rpcs.push([fn, args]); return { data: { saved: true, lines: 1 }, error: null }; },
  };
  return { state, netsuite, service };
});

vi.mock('@/lib/api-auth', () => ({
  requireFeature: vi.fn(async () => (h.state.hasInvoicing
    ? { user: { id: 'p0000000-0000-4000-8000-000000000001' }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));

const { state, netsuite } = h;

import { GET, POST } from '../app/api/invoices/credit-memo/route';

const RECORD = {
  id: '7001', tranId: 'INV9001', tranDate: '2026-10-20', entity: { id: '9001', refName: 'Acme Fleet Services' },
  location: { id: '1', refName: "O'Fallon" }, otherRefNum: 'PO-77',
  subtotal: 351, taxTotal: 29.79, total: 380.79, amountRemaining: 380.79, taxRate: 8.488, status: { refName: 'Open' },
  item: { items: [
    { line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125.5, amount: 251, description: 'Shelf unit', isTaxable: true },
    { line: 2, item: { id: '57', refName: 'LIGHT-2' }, itemType: 'InvtPart', quantity: 1, rate: 100, amount: 100, isTaxable: true },
  ] },
};
const REQUEST = 'b0000000-0000-4000-8000-000000000001';

const get = (query: string) => GET(new NextRequest(`https://app.test/api/invoices/credit-memo?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/invoices/credit-memo', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
/** One of the two shelf units back on the shelf: 125.50 plus 10.65 of tax. */
const ONE_SHELF = { requestId: REQUEST, invoiceId: '7001', reason: 'Returned', lines: [{ line: 1, quantity: 1, price: 125.5 }], added: [], expectedTotalCents: 13615 };

const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'credit_memos', is_on: on }]; };

beforeEach(() => {
  state.roles = ['admin'];
  state.hasInvoicing = true;
  state.tables = { quote_settings: [{ id: 1, netsuite_credit_item_id: '900', netsuite_credit_item_number: 'CREDIT' }], customers: [{ id: 'c1', netsuite_id: '9001' }] };
  switchOn(false);
  state.rpcs.length = 0;
  vi.clearAllMocks();
  netsuite.getInvoiceRecord.mockResolvedValue({ success: true, record: RECORD });
  netsuite.getInvoiceCreditMemos.mockResolvedValue({ success: true, creditMemos: [] });
  netsuite.createCreditMemoFromInvoice.mockResolvedValue({ success: true, creditMemoId: '8001', creditMemoNumber: 'CM1001' });
});

describe('while credit memos are switched off', () => {
  it('shows the Credit button to super admins only', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.roles = ['super_admin'];
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true });
    state.hasInvoicing = false;
    expect((await get('status=1')).status).toBe(403);
  });

  it('lets a super admin see what it would send, and nobody else', async () => {
    const refused = await get('invoice=7001');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ switchedOff: true });

    state.roles = ['super_admin'];
    const res = await get('invoice=7001');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      switchedOn: false,
      offText: 'Credit memos are switched off until January 1, 2027. You can see what it would send; nothing goes to NetSuite.',
      creditItem: { id: '900', itemNumber: 'CREDIT' },
      invoice: { number: 'INV9001', totalCents: 38079, taxRate: 0.08488 },
      earlier: { fleetsuite: [], lines: [], netsuite: [], netsuiteError: null },
    });
  });

  it('sends nothing to NetSuite, even for a super admin', async () => {
    state.roles = ['super_admin'];
    const res = await post(ONE_SHELF);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Credit memos are switched off until January 1, 2027. Nothing was sent to NetSuite.', switchedOff: true });
    expect(netsuite.createCreditMemoFromInvoice).not.toHaveBeenCalled();
    expect(state.tables.invoice_credit_memos ?? []).toEqual([]);
  });
});

describe('once credit memos are switched on', () => {
  beforeEach(() => switchOn(true));

  it('lets anyone with Invoicing use them', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });
    const res = await get('invoice=7001');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ switchedOn: true, offText: null });
    expect((await get('invoice=abc')).status).toBe(400);
  });

  it('makes the credit memo in NetSuite once, keeps Books its copy, and says what an earlier press did', async () => {
    const res = await post(ONE_SHELF);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, creditMemoId: '8001', creditMemoNumber: 'CM1001', totalCents: 13615, invoiceNumber: 'INV9001' });
    expect(netsuite.createCreditMemoFromInvoice).toHaveBeenCalledWith({
      invoiceId: '7001',
      lines: [{ item: { id: '55' }, quantity: 1, price: { id: '-1' }, rate: 125.5, description: 'Shelf unit', isTaxable: true }],
      memo: 'Returned',
    });
    expect(state.tables.invoice_credit_memos).toEqual([expect.objectContaining({
      id: REQUEST, invoice_netsuite_id: '7001', total_cents: 13615, netsuite_credit_memo_id: '8001', netsuite_credit_memo_number: 'CM1001', error: null,
    })]);
    expect(state.rpcs).toEqual([['gl_own_credit_memo_save', { p: expect.objectContaining({ netsuite_id: '8001', customer_id: 'c1', total: '136.15' }) }]]);

    const again = await post(ONE_SHELF);
    expect(await again.json()).toMatchObject({ success: true, already: true, creditMemoId: '8001' });
    expect(netsuite.createCreditMemoFromInvoice).toHaveBeenCalledTimes(1);
  });

  it('counts what earlier credit memos took against a new one', async () => {
    await post({ ...ONE_SHELF, lines: [{ line: 1, quantity: 2, price: 125.5 }], expectedTotalCents: 27230 });
    const res = await post({ ...ONE_SHELF, requestId: 'b0000000-0000-4000-8000-000000000002' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('SHELF-1: only $0.00 of this line is left to credit.');
    const shown = await (await get('invoice=7001')).json();
    expect(shown.earlier.fleetsuite).toEqual([expect.objectContaining({ creditMemoId: '8001', number: 'CM1001', totalCents: 27230, making: false })]);
  });

  it("sends nothing when the invoice changed since the page opened, or the form doesn't add up", async () => {
    const changed = await post({ ...ONE_SHELF, expectedTotalCents: 12550 });
    expect(changed.status).toBe(409);
    expect((await changed.json()).error).toContain('the credit now comes to $136.15, not $125.50');
    const unsaid = await post({ ...ONE_SHELF, reason: ' ' });
    expect(unsaid.status).toBe(400);
    expect((await unsaid.json()).error).toBe("Say why it's being credited.");
    expect(netsuite.createCreditMemoFromInvoice).not.toHaveBeenCalled();
  });

  it('lets go of the claim when NetSuite refuses, so the same form can try again', async () => {
    netsuite.createCreditMemoFromInvoice.mockResolvedValueOnce({ success: false, error: 'Invalid item reference' });
    const refused = await post(ONE_SHELF);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: 'Invalid item reference' });
    expect(state.tables.invoice_credit_memos[0]).toMatchObject({ claimed_at: null, error: 'Invalid item reference' });
    expect(state.tables.invoice_credit_memos[0].netsuite_credit_memo_id ?? null).toBeNull();
    expect(state.rpcs).toEqual([]);

    const retried = await post(ONE_SHELF);
    expect(retried.status).toBe(200);
    expect(state.tables.invoice_credit_memos[0]).toMatchObject({ netsuite_credit_memo_id: '8001', error: null });
    expect(netsuite.createCreditMemoFromInvoice).toHaveBeenCalledTimes(2);
  });

  it("counts another press still being made against what's left, and not one NetSuite refused", async () => {
    const taken = [{ invoiceLine: 1, cents: 25100, quantity: 2, backToStock: true }];
    state.tables.invoice_credit_memos = [{ id: 'b0000000-0000-4000-8000-000000000009', invoice_netsuite_id: '7001', claimed_at: '2026-10-31T12:00:00Z', netsuite_credit_memo_id: null, lines: taken }];
    const res = await post(ONE_SHELF);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('SHELF-1: only $0.00 of this line is left to credit.');

    state.tables.invoice_credit_memos = [{ id: 'b0000000-0000-4000-8000-000000000009', invoice_netsuite_id: '7001', claimed_at: null, netsuite_credit_memo_id: null, error: 'Invalid item reference', lines: taken }];
    expect((await post(ONE_SHELF)).status).toBe(200);
  });

  it("won't make a second credit memo while the first press is still being made", async () => {
    state.tables.invoice_credit_memos = [{ id: REQUEST, invoice_netsuite_id: '7001', claimed_at: '2026-10-31T12:00:00Z', netsuite_credit_memo_id: null }];
    const res = await post(ONE_SHELF);
    expect(res.status).toBe(409);
    expect(netsuite.createCreditMemoFromInvoice).not.toHaveBeenCalled();
  });
});
