// /api/invoices/fix (src/lib/invoice-fix.ts): who can open it while fixing
// invoices is switched off and once it's on, and what one press of Fix
// invoice does: the fix worked out again from the invoice as NetSuite has it
// now, nothing sent when the invoice changed since the page read it, sent to
// NetSuite once however often it's pressed, one fix of an invoice at a time,
// NetSuite's refusal and an answer that never came told apart, and Books' own
// copy following. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    roles: ['admin'] as string[],
    hasInvoicing: true,
    seesMoney: true,
    tables: {} as Record<string, Record<string, any>[]>,
    calls: [] as Array<[string, Record<string, any>]>,
    /** Tables and functions that answer with an error. */
    failing: new Set<string>(),
  };
  const netsuite = { getInvoiceRecord: vi.fn(), patchInvoice: vi.fn() };
  const saveFixed = vi.fn();
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
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return builder; },
      order: (c: string, o: { ascending?: boolean } = {}) => { sorts.push([c, o.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }
  // What migration 471's functions do, in memory.
  const fixes = () => (state.tables.invoice_fixes ??= []);
  const rpcs: Record<string, (p: Record<string, any>) => unknown> = {
    invoice_fix_claim: (p) => {
      const mine = fixes().find((r) => r.id === p.id);
      if (mine && (mine.status === 'fixed' || mine.status === 'sending')) return { claimed: false, state: mine.status };
      if (fixes().some((r) => r.invoice_netsuite_id === p.invoice_netsuite_id && r.status === 'sending')) return { claimed: false, state: 'busy' };
      const row = {
        id: p.id, invoice_netsuite_id: p.invoice_netsuite_id, invoice_number: p.invoice_number,
        customer_netsuite_id: p.customer_netsuite_id, customer_name: p.customer_name, reason: p.reason, changes: p.changes, patch: p.patch,
        replace_lines: p.replace_lines, total_before_cents: p.total_before_cents, total_expected_cents: p.total_expected_cents,
        total_after_cents: null, status: 'sending', error: null, own_copy: null, own_copy_version: null, created_by: p.by,
        created_at: '2026-12-02T15:00:00Z',
      };
      if (mine) Object.assign(mine, row); else fixes().push(row);
      return { claimed: true };
    },
    invoice_fix_finish: (p) => {
      const mine = fixes().find((r) => r.id === p.id && r.status === 'sending');
      if (mine) Object.assign(mine, { ...p, id: mine.id });
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
  requireFeature: vi.fn(async () => (h.state.hasInvoicing
    ? { user: { id: 'p0000000-0000-4000-8000-000000000001' }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
  profileCanSeeMoney: vi.fn(async () => h.state.seesMoney),
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/books/own-invoices', () => ({ saveFixedOwnInvoice: h.saveFixed }));

const { state, netsuite, saveFixed } = h;

import { GET, POST } from '../app/api/invoices/fix/route';
import { logAudit } from '@/lib/audit';

const RECORD = {
  id: '7001', tranId: 'INV9001', tranDate: '2026-12-01', dueDate: '2026-12-31', terms: { id: '2', refName: 'Net 30' },
  entity: { id: '9001', refName: 'Acme Fleet Services' }, location: { id: '1', refName: "O'Fallon" }, otherRefNum: 'PO-77',
  memo: '', lastModifiedDate: '2026-12-01T15:04:05Z',
  subtotal: 351, taxTotal: 29.79, total: 380.79, amountRemaining: 380.79, taxRate: 8.488, status: { refName: 'Open' },
  item: { items: [
    { line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125.5, amount: 251, description: 'Shelf unit', isTaxable: true },
    { line: 2, item: { id: '57', refName: 'LIGHT-2' }, itemType: 'InvtPart', quantity: 1, rate: 100, amount: 100, isTaxable: true },
  ] },
};
/** After the fix: three shelves, 125.50 more, NetSuite's tax a cent under FleetSuite's line by line. */
const FIXED_RECORD = { ...RECORD, lastModifiedDate: '2026-12-02T15:00:01Z', subtotal: 476.5, taxTotal: 40.44, total: 516.94, amountRemaining: 516.94 };
const REQUEST = 'b0000000-0000-4000-8000-000000000001';

const get = (query: string) => GET(new NextRequest(`https://app.test/api/invoices/fix?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/invoices/fix', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const signature = async () => (await (await get('invoice=7001')).json()).signature as string;
/** A third shelf, with a new PO number. */
const THIRD_SHELF = async () => ({
  requestId: REQUEST, invoiceId: '7001', signature: await signature(), reason: 'Billed two, fitted three',
  header: { poNumber: 'PO-78' }, lines: [{ line: 1, quantity: 3 }],
});

const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'invoice_fixes', is_on: on }]; };

beforeEach(() => {
  state.roles = ['admin'];
  state.hasInvoicing = true;
  state.seesMoney = true;
  state.tables = {
    customers: [{ id: 'c1', netsuite_id: '9001', tax_exempt: false }],
    gl_netsuite_lists: [{ kind: 'term', netsuite_id: '2', details: { days_until_net_due: 30 } }],
    gl_own_invoices: [{ netsuite_id: '7001', version: 1, fixed_at: null }],
    netsuite_parts: [{ netsuite_id: '501', item_number: 'BRK-100', display_name: 'Bracket', description: 'Bracket kit', item_type: 'InvtPart', taxable_override: null }],
    profiles: [{ id: 'p0000000-0000-4000-8000-000000000001', full_name: 'Sam Example' }],
  };
  switchOn(false);
  state.calls.length = 0;
  state.failing = new Set();
  vi.clearAllMocks();
  netsuite.getInvoiceRecord.mockResolvedValue({ success: true, record: RECORD });
  netsuite.patchInvoice.mockImplementation(async () => {
    netsuite.getInvoiceRecord.mockResolvedValue({ success: true, record: FIXED_RECORD });
    return { success: true };
  });
  saveFixed.mockResolvedValue({ saved: true, version: 2 });
});

describe('while fixing invoices is switched off', () => {
  it('shows the Fix button to super admins only, and never to someone who can\'t see prices', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.roles = ['super_admin'];
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true });
    state.seesMoney = false;
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.hasInvoicing = false;
    expect((await get('status=1')).status).toBe(403);
  });

  it('lets a super admin see what a fix would send, and nobody else', async () => {
    const refused = await get('invoice=7001');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ switchedOff: true, error: 'Fixing invoices is switched off until January 1, 2027.' });

    state.roles = ['super_admin'];
    const res = await get('invoice=7001');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      switchedOn: false,
      offText: 'Fixing invoices is switched off until January 1, 2027. You can see what a fix would send; nothing goes to NetSuite.',
      invoice: { number: 'INV9001', totalCents: 38079, dueDate: '2026-12-31', termsId: '2' },
      allows: { header: true, lines: true, why: null },
      termsDays: 30,
      untaxed: null,
      fixes: [],
      ownCopy: { version: 1, fixedAt: null },
    });
    expect(body.signature).toMatch(/^[0-9a-f]{32}$/);

    state.seesMoney = false;
    const hidden = await get('invoice=7001');
    expect(hidden.status).toBe(403);
    expect(await hidden.json()).toEqual({ error: 'Forbidden: this account cannot see billing' });

    // Nor to anyone without Invoicing.
    state.seesMoney = true;
    state.hasInvoicing = false;
    expect((await get('invoice=7001')).status).toBe(403);
    expect((await post({ requestId: REQUEST })).status).toBe(403);
  });

  it('sends nothing to NetSuite, even for a super admin', async () => {
    state.roles = ['super_admin'];
    const res = await post(await THIRD_SHELF());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Fixing invoices is switched off until January 1, 2027. Nothing was sent to NetSuite.', switchedOff: true });
    expect(netsuite.patchInvoice).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });
});

describe('once fixing invoices is switched on', () => {
  beforeEach(() => switchOn(true));

  it('lets anyone with Invoicing who sees prices use it', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });
    const res = await get('invoice=7001');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ switchedOn: true, offText: null });
    expect((await get('invoice=abc')).status).toBe(400);
    netsuite.getInvoiceRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite 404: gone', notFound: true });
    const missing = await get('invoice=7002');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'NetSuite has no invoice with id 7002.' });
  });

  it("knows the invoice's terms, a tax-exempt customer, work at Social Circle, and a credit memo FleetSuite made", async () => {
    state.tables.gl_netsuite_lists = [];
    expect(await (await get('invoice=7001')).json()).toMatchObject({ termsDays: null });
    state.tables.gl_netsuite_lists = [{ kind: 'term', netsuite_id: '2', details: { days_until_net_due: -5 } }];
    expect(await (await get('invoice=7001')).json()).toMatchObject({ termsDays: null });
    netsuite.getInvoiceRecord.mockResolvedValue({ success: true, record: { ...RECORD, terms: null } });
    expect(await (await get('invoice=7001')).json()).toMatchObject({ termsDays: 0 });
    state.tables.customers = [{ id: 'c1', netsuite_id: '9001', tax_exempt: true }];
    expect(await (await get('invoice=7001')).json()).toMatchObject({ untaxed: 'exempt_customer' });
    // A customer FleetSuite doesn't have isn't counted tax-exempt, nor one FleetSuite has twice and only once exempt.
    state.tables.customers = [];
    expect(await (await get('invoice=7001')).json()).toMatchObject({ untaxed: null });
    state.tables.customers = [{ id: 'c1', netsuite_id: '9001', tax_exempt: true }, { id: 'c2', netsuite_id: '9001', tax_exempt: false }];
    expect(await (await get('invoice=7001')).json()).toMatchObject({ untaxed: null });
    netsuite.getInvoiceRecord.mockResolvedValue({ success: true, record: { ...RECORD, location: { id: '5', refName: 'Social Circle' } } });
    expect(await (await get('invoice=7001')).json()).toMatchObject({ untaxed: 'georgia' });
    // One being made counts too; one NetSuite refused doesn't.
    state.tables.invoice_credit_memos = [{ invoice_netsuite_id: '7001', netsuite_credit_memo_id: null, claimed_at: null }];
    expect((await (await get('invoice=7001')).json()).allows.lines).toBe(true);
    state.tables.invoice_credit_memos = [{ invoice_netsuite_id: '7001', netsuite_credit_memo_id: null, claimed_at: '2026-12-02T15:00:00Z' }];
    expect((await (await get('invoice=7001')).json()).allows.lines).toBe(false);
    state.tables.invoice_credit_memos = [{ invoice_netsuite_id: '7001', netsuite_credit_memo_id: '8001', claimed_at: null }];
    expect((await (await get('invoice=7001')).json()).allows).toEqual({
      header: true, lines: false,
      why: 'FleetSuite made a credit memo against it, so only its PO number, memo and VIN can be fixed. To take more off it, make another credit memo.',
    });
  });

  it("takes the invoice's rate from its tax code when the invoice doesn't give it", async () => {
    const { taxRate: _rate, ...unrated } = RECORD;
    netsuite.getInvoiceRecord.mockResolvedValue({ success: true, record: { ...unrated, taxItem: { id: '77' } } });
    expect((await (await get('invoice=7001')).json()).invoice).toMatchObject({ taxRate: 0.084872, taxRateFrom: 'worked_out' });
    state.tables.gl_netsuite_lists.push({ kind: 'tax_code', netsuite_id: '77', details: { rate: '8.488%' } });
    expect((await (await get('invoice=7001')).json()).invoice).toMatchObject({ taxRate: 0.08488, taxRateFrom: 'tax_code' });
    // A rate of nothing isn't one.
    state.tables.gl_netsuite_lists.at(-1)!.details = { rate: '0%' };
    expect((await (await get('invoice=7001')).json()).invoice).toMatchObject({ taxRate: 0.084872, taxRateFrom: 'worked_out' });
  });

  it("says what couldn't be read, and sends nothing", async () => {
    const form = await THIRD_SHELF();
    for (const table of ['invoice_credit_memos', 'gl_netsuite_lists', 'customers', 'invoice_fixes', 'gl_own_invoices']) {
      state.failing = new Set([table]);
      const res = await get('invoice=7001');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: `${table} can't be read` });
    }
    state.failing = new Set(['netsuite_parts']);
    const parts = await post({ ...form, add: [{ itemId: '501', quantity: 1, price: 10 }] });
    expect(parts.status).toBe(500);
    expect(await parts.json()).toEqual({ error: "netsuite_parts can't be read" });
    state.failing = new Set(['invoice_fix_claim']);
    const claim = await post(form);
    expect(claim.status).toBe(500);
    expect(await claim.json()).toEqual({ error: "invoice_fix_claim didn't answer" });
    expect(netsuite.patchInvoice).not.toHaveBeenCalled();
  });

  it("fixes the invoice in NetSuite once, Books' own copy following, and says what an earlier press did", async () => {
    const form = { ...(await THIRD_SHELF()), reason: '  Billed two, fitted three ' };
    const res = await post(form);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, invoiceNumber: 'INV9001', changes: ['PO number PO-77 → PO-78', 'SHELF-1 quantity 2 → 3'],
      totalBeforeCents: 38079, totalAfterCents: 51694, ownCopy: 'fixed',
    });
    expect(netsuite.patchInvoice).toHaveBeenCalledWith('7001', { otherRefNum: 'PO-78', item: { items: [{ line: 1, quantity: 3 }] } }, { replace: false });
    expect(saveFixed).toHaveBeenCalledWith(h.service, {
      netsuiteId: '7001',
      fixed: {
        date: '2026-12-01', poNumber: 'PO-78', memo: '', vin: '',
        lines: [
          { itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', quantity: 3, rate: 125.5, cents: 37650, orderLine: null },
          { itemId: '57', itemNumber: 'LIGHT-2', description: null, quantity: 1, rate: 100, cents: 10000, orderLine: null },
        ],
      },
      fixId: REQUEST,
      by: 'p0000000-0000-4000-8000-000000000001',
    });
    expect(state.tables.invoice_fixes).toEqual([expect.objectContaining({
      id: REQUEST, invoice_netsuite_id: '7001', invoice_number: 'INV9001', customer_netsuite_id: '9001', customer_name: 'Acme Fleet Services',
      reason: 'Billed two, fitted three', status: 'fixed', total_before_cents: 38079, total_expected_cents: 51695,
      total_after_cents: 51694, own_copy: 'fixed', own_copy_version: 2, replace_lines: false,
    })]);
    expect(logAudit).toHaveBeenCalledWith(h.service, expect.objectContaining({
      table: 'invoice_fixes', recordId: REQUEST, action: 'fix',
      detail: expect.objectContaining({ invoice: 'INV9001', total_before: '$380.79', total_after: '$516.94', own_copy: 'fixed' }),
    }));

    // The same form pressed again: NetSuite's invoice changed since that page read it, so nothing goes.
    const again = await post(form);
    expect(again.status).toBe(409);
    expect(netsuite.patchInvoice).toHaveBeenCalledTimes(1);

    // Pressed again with the invoice as it is now, it's the same fix: NetSuite isn't sent it twice.
    const same = await post({ ...(await THIRD_SHELF()) });
    expect(await same.json()).toMatchObject({ success: true, already: true });
    expect(netsuite.patchInvoice).toHaveBeenCalledTimes(1);

    const shown = await (await get('invoice=7001')).json();
    expect(shown.fixes).toEqual([{
      id: REQUEST, at: '2026-12-02T15:00:00Z', by: 'Sam Example', reason: 'Billed two, fitted three',
      changes: ['PO number PO-77 → PO-78', 'SHELF-1 quantity 2 → 3'], status: 'fixed', error: null,
      totalBeforeCents: 38079, totalAfterCents: 51694, ownCopy: 'fixed',
    }]);
  });

  it("lists the invoice's own fixes, newest first", async () => {
    const row = (end: string, invoice: string, at: string) => ({
      id: `b0000000-0000-4000-8000-00000000000${end}`, invoice_netsuite_id: invoice, reason: 'Wrong PO', changes: ['PO number PO-77 → PO-78'],
      status: 'fixed', error: null, total_before_cents: 38079, total_after_cents: 38079, own_copy: 'none', created_by: null, created_at: at,
    });
    state.tables.invoice_fixes = [
      row('a', '7001', '2026-12-02T15:00:00Z'), row('b', '7002', '2026-12-04T15:00:00Z'),
      row('c', '7001', '2026-12-03T15:00:00Z'), row('d', '7001', '2026-12-03T15:00:00Z'),
    ];
    const { fixes } = await (await get('invoice=7001')).json();
    expect(fixes.map((f: { id: string }) => f.id.slice(-1))).toEqual(['d', 'c', 'a']);
    expect(fixes[0]).toMatchObject({ by: null, ownCopy: 'none' });
  });

  it('sends nothing when the invoice changed since the page opened, or the fix has a problem', async () => {
    const stale = await post({ ...(await THIRD_SHELF()), signature: 'not-what-netsuite-has-now' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: 'Invoice INV9001 changed in NetSuite since this page opened. Nothing was sent. Reload it and make the fix again.', stale: true,
    });
    const unsaid = await post({ ...(await THIRD_SHELF()), reason: ' ' });
    expect(unsaid.status).toBe(400);
    expect(await unsaid.json()).toEqual({ error: "Say why it's being fixed.", problems: ["Say why it's being fixed."] });
    const unknown = await post({ ...(await THIRD_SHELF()), add: [{ itemId: '599', quantity: 1, price: 5 }] });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("New line 1: that item isn't in the parts list. Take the line off and pick the item again.");
    const bad = await post({ ...(await THIRD_SHELF()), requestId: 'not-a-uuid' });
    expect(bad.status).toBe(400);
    expect(netsuite.patchInvoice).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it('works the fix out from what NetSuite has, not what the page says', async () => {
    const res = await post({ ...(await THIRD_SHELF()), lines: [{ line: 1, quantity: 3 }, { line: 2, remove: true }], add: [{ itemId: '501', quantity: 2, price: 10 }] });
    expect(res.status).toBe(200);
    expect(netsuite.patchInvoice).toHaveBeenCalledWith('7001', {
      otherRefNum: 'PO-78',
      item: { items: [
        { line: 1, quantity: 3 },
        { item: { id: '501' }, quantity: 2, price: { id: '-1' }, rate: 10, description: 'Bracket kit', isTaxable: true },
      ] },
    }, { replace: true });
    expect(state.tables.invoice_fixes[0]).toMatchObject({ replace_lines: true });
  });

  it('adds lines as the parts list has their items: number, tax and description', async () => {
    state.tables.netsuite_parts.push(
      { netsuite_id: '502', item_number: 'HOURS', display_name: 'Hours', description: 'Shop labor', item_type: 'Service', taxable_override: null },
      { netsuite_id: '504', item_number: 'DECAL-1', display_name: 'Door decal', description: null, item_type: 'NonInvtPart', taxable_override: false },
    );
    const res = await post({
      ...(await THIRD_SHELF()), header: {}, lines: [],
      add: [{ itemId: '501', quantity: 1, price: 10 }, { itemId: '502', quantity: 1, price: 95 }, { itemId: '504', quantity: 2, price: 15 }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).changes).toEqual(['Added BRK-100 (1 × $10.00)', 'Added HOURS (1 × $95.00)', 'Added DECAL-1 (2 × $15.00)']);
    expect(netsuite.patchInvoice).toHaveBeenCalledWith('7001', { item: { items: [
      { item: { id: '501' }, quantity: 1, price: { id: '-1' }, rate: 10, description: 'Bracket kit', isTaxable: true },
      { item: { id: '502' }, quantity: 1, price: { id: '-1' }, rate: 95, description: 'Shop labor', isTaxable: false },
      { item: { id: '504' }, quantity: 2, price: { id: '-1' }, rate: 15, description: 'Door decal', isTaxable: false },
    ] } }, { replace: false });
  });

  it("moves the date and leaves NetSuite the due date when FleetSuite can't tell the terms", async () => {
    state.tables.gl_netsuite_lists = [];
    const res = await post({ ...(await THIRD_SHELF()), header: { date: '2026-12-05' }, lines: [] });
    expect(res.status).toBe(200);
    expect((await res.json()).changes).toEqual(['Date Dec 1, 2026 → Dec 5, 2026']);
    expect(netsuite.patchInvoice).toHaveBeenCalledWith('7001', { tranDate: '2026-12-05' }, { replace: false });
  });

  it("lets the same form try again when NetSuite refused, and says when it can't tell whether the fix went in", async () => {
    netsuite.patchInvoice.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): The period is closed.' });
    const refused = await post(await THIRD_SHELF());
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "NetSuite didn't take the fix: NetSuite error (400): The period is closed. Nothing changed." });
    expect(state.tables.invoice_fixes[0]).toMatchObject({ status: 'refused', error: 'NetSuite error (400): The period is closed.' });
    expect(saveFixed).not.toHaveBeenCalled();

    netsuite.patchInvoice.mockResolvedValueOnce({ success: false, error: 'NetSuite took too long to answer', unsure: true });
    const unsure = await post(await THIRD_SHELF());
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({
      error: "NetSuite took too long to answer, so FleetSuite can't tell whether the fix went in. Reload the invoice: if the change is there, it went in; if it isn't, fix it again.",
      unsure: true,
    });
    expect(state.tables.invoice_fixes[0]).toMatchObject({ status: 'unsure' });

    const retried = await post(await THIRD_SHELF());
    expect(retried.status).toBe(200);
    expect(state.tables.invoice_fixes).toHaveLength(1);
    expect(state.tables.invoice_fixes[0]).toMatchObject({ status: 'fixed', error: null });
    expect(netsuite.patchInvoice).toHaveBeenCalledTimes(3);
  });

  it('sends one fix of an invoice at a time', async () => {
    state.tables.invoice_fixes = [{ id: 'b0000000-0000-4000-8000-000000000009', invoice_netsuite_id: '7001', status: 'sending' }];
    const busy = await post(await THIRD_SHELF());
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toBe('Another fix of invoice INV9001 is being sent now. Reload it in a minute and check it before fixing it again.');
    state.tables.invoice_fixes = [{ id: REQUEST, invoice_netsuite_id: '7001', status: 'sending' }];
    const pressed = await post(await THIRD_SHELF());
    expect(pressed.status).toBe(409);
    expect((await pressed.json()).error).toBe("This fix is being sent now. Don't press again: reload the invoice in a minute to see it.");
    expect(netsuite.patchInvoice).not.toHaveBeenCalled();
  });

  it("finishes the fix whatever becomes of Books' own copy", async () => {
    saveFixed.mockResolvedValueOnce({ saved: false, none: true, reason: 'no copy' });
    expect(await (await post(await THIRD_SHELF())).json()).toMatchObject({ success: true, ownCopy: 'none' });
    expect(state.tables.invoice_fixes[0]).toMatchObject({ status: 'fixed', own_copy: 'none', own_copy_version: null });

    netsuite.getInvoiceRecord.mockResolvedValue({ success: true, record: RECORD });
    saveFixed.mockResolvedValueOnce({ saved: false, reason: 'the copy changed while the fix was being made' });
    const notSaved = await (await post({ ...(await THIRD_SHELF()), requestId: 'b0000000-0000-4000-8000-000000000002' })).json();
    expect(notSaved).toMatchObject({
      success: true, ownCopy: 'not_saved',
      warning: "Books' own copy of the invoice didn't follow (the copy changed while the fix was being made). The fix is in NetSuite.",
    });

    // A save that says it saved but gives no version isn't counted as saved.
    netsuite.getInvoiceRecord.mockResolvedValue({ success: true, record: RECORD });
    saveFixed.mockResolvedValueOnce({ saved: true });
    const odd = await (await post({ ...(await THIRD_SHELF()), requestId: 'b0000000-0000-4000-8000-000000000003' })).json();
    expect(odd).toMatchObject({ ownCopy: 'not_saved', warning: "Books' own copy of the invoice didn't follow (it said nothing back). The fix is in NetSuite." });
    expect(state.tables.invoice_fixes[2]).toMatchObject({ status: 'fixed', own_copy: 'not_saved', own_copy_version: null });

    // Nor one that says it didn't save, whatever version it gives.
    netsuite.getInvoiceRecord.mockResolvedValue({ success: true, record: RECORD });
    saveFixed.mockResolvedValueOnce({ saved: false, version: 2, reason: 'the copy is gone' });
    const unsaved = await (await post({ ...(await THIRD_SHELF()), requestId: 'b0000000-0000-4000-8000-000000000004' })).json();
    expect(unsaved).toMatchObject({ ownCopy: 'not_saved' });
    expect(state.tables.invoice_fixes[3]).toMatchObject({ own_copy: 'not_saved', own_copy_version: null });
  });

  it("shows NetSuite's total as unknown when it can't be read back", async () => {
    netsuite.patchInvoice.mockResolvedValueOnce({ success: true });
    const before = await THIRD_SHELF();
    netsuite.getInvoiceRecord.mockResolvedValueOnce({ success: true, record: RECORD })
      .mockResolvedValueOnce({ success: false, error: 'NetSuite request timed out' });
    expect(await (await post(before)).json()).toMatchObject({ success: true, totalAfterCents: null });
    expect(state.tables.invoice_fixes[0]).toMatchObject({ status: 'fixed', total_after_cents: null });
  });
});
