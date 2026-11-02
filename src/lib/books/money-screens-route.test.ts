// Home → Financials' routes (src/app/api/reports/financials and the lists
// under it) with "Financials on FleetSuite's books" off and on (migration
// 504): off, they read NetSuite as before; on, BMG's books in FleetSuite,
// here a made-up chart, journal and agings, without touching NetSuite.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let allowed = true;
vi.mock('@/lib/api-auth', () => ({
  requireFinancials: vi.fn(async () => (allowed
    ? { user: { id: 'u1' }, profile: { role: 'super_admin', roles: ['super_admin'] } }
    : { error: new Response('Forbidden', { status: 403 }) })),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
const netsuite = vi.hoisted(() => ({
  suiteqlQueryAll: vi.fn(),
  getAccountBalancesFromRestlet: vi.fn(),
  getIncomeStatementFromRestlet: vi.fn(),
  getCollectionsFromRestlet: vi.fn(),
  transactionUrl: vi.fn((page: string, id: string | number) => `https://ns.example/${page}/${id}`),
}));
vi.mock('@/lib/netsuite', () => ({ ...netsuite, isSuiteqlError: () => false, suiteqlQuery: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET as summaryRoute } from '../../app/api/reports/financials/route';
import { GET as arRoute } from '../../app/api/reports/financials/ar-invoices/route';
import { GET as apRoute } from '../../app/api/reports/financials/ap-bills/route';
import { GET as accountsRoute } from '../../app/api/reports/financials/accounts/route';
import { GET as pnlRoute } from '../../app/api/reports/financials/pnl/route';

const ACME = '11111111-1111-4111-8111-111111111111';
const BRAVO = '22222222-2222-4222-8222-222222222222';

const account = (id: string, ns: string, number: string, name: string, type: string, company: string | null = null) => ({
  id, netsuite_account_id: ns, number, name, account_type: type, parent_id: null, company_id: company,
  statement: ['income', 'expense'].includes(type) ? 'income_statement' : 'balance_sheet',
});

/** Made-up chart: Checking, 1084's own bank, payables, a card, sales tax, sales, wages and rent. */
const TABLES: Record<string, Array<Record<string, unknown>>> = {
  gl_companies: [
    { id: 'co-1084', code: '1084', name: '1084 Cool Springs', legal_name: null, netsuite_subsidiary_id: '2' },
    { id: 'co-bmg', code: 'BMG', name: 'Example Fleet', legal_name: 'Example Fleet Upfitters LLC', netsuite_subsidiary_id: '1' },
  ],
  gl_accounts: [
    account('a10', '10', '1000', 'Checking', 'bank'),
    account('a18', '18', '1080', "1084's bank", 'bank', 'co-1084'),
    account('a20', '20', '2000', 'Payables', 'accounts_payable'),
    account('a21', '21', '2100', 'Chase card', 'credit_card'),
    account('a22', '22', '2200', 'Sales tax', 'other_current_liability'),
    account('a40', '40', '4000', 'Sales', 'income'),
    account('a61', '61', '6010', 'Wages', 'expense'),
    account('a65', '65', '6500', 'Rent', 'expense'),
  ],
  // The ledger mirror keeps NetSuite's invoices and credit memos by type and id; QuickBooks' have ids of their own.
  ledger_invoices: [
    { id: 'li1', source: 'netsuite', external_id: 'CustInvc/101', external_ref: '101', total: 1000, po_number: 'PO-77' },
    { id: 'li2', source: 'quickbooks', external_id: 'CustInvc/102', external_ref: '102', total: 999, po_number: 'Not this one' },
    { id: 'li3', source: 'netsuite', external_id: 'CustCred/107', external_ref: '107', total: 50, po_number: 'RMA-9' },
    { id: 'li4', source: 'netsuite', external_id: 'CustCred/201', external_ref: '201', total: 999, po_number: 'Not this one' },
  ],
  // The books' copy of NetSuite's bills; ledger_bills is QuickBooks'.
  gl_netsuite_bills: [{ netsuite_id: '4001', tran_type: 'VendBill', total: 900, memo: 'Oct parts' }],
  ledger_bills: [{ id: 'lb1', source: 'netsuite', external_id: '4003', total: 999, memo: 'Not this one' }],
};

let switchOn = true;
/** A second customer and vendor, for the lists' order: Bravo Trucking and Steel Inc. */
let second = false;
let syncState: Record<string, { last_result: unknown; updated_at: string }>;
/** A table or function whose read fails. */
let failing: string | null = null;
const reads: string[] = [];

const RPCS: Record<string, (args: Record<string, unknown>) => unknown> = {
  // $10,000 in Checking, $3,000 in 1084's bank and $500 owed on the card before 2025.
  gl_netsuite_totals: () => ({
    opening: [
      { netsuite_account_id: '10', debit: '10000.00', credit: '0.00' },
      { netsuite_account_id: '18', debit: '3000.00', credit: '0.00' },
      { netsuite_account_id: '21', debit: '0.00', credit: '500.00' },
    ],
    netsuite: [],
  }),
  // October: $1,000 of sales with $70 of tax, $300 of wages and $600 of rent paid from Checking.
  gl_books_totals: () => [
    { account: '40', month: '2026-10-01', debit: '0.00', credit: '1000.00' },
    { account: '22', month: '2026-10-01', debit: '0.00', credit: '70.00' },
    { account: '61', month: '2026-10-01', debit: '300.00', credit: '0.00' },
    { account: '65', month: '2026-10-01', debit: '600.00', credit: '0.00' },
    { account: '10', month: '2026-10-01', debit: '0.00', credit: '900.00' },
  ],
  // Acme owes $1,250; BMG owes Parts Co $1,000, $1,100 in NetSuite's books. With a second of each, Bravo owes
  // $820, a $900 invoice not yet due less an $80 payment not applied yet, and BMG owes Steel Inc $200, 48 days late.
  gl_party_balances: (args) => {
    const party = (id: string, name: string, netsuite: string, fleetsuite: string) => ({
      party: id, name, netsuite_ids: [id], opening: '0', netsuite, fleetsuite, documents: 1, differing: 0, members: null, members_count: null,
    });
    return {
      accounts: [],
      opening: { total: '0', named: '0', complete: true },
      parties: args.p_kind === 'customer'
        ? [party(ACME, 'Acme Fleet', '1250.00', '1250.00'), ...(second ? [party(BRAVO, 'Bravo Trucking', '820.00', '820.00')] : [])]
        : [party('7001', 'Parts Co', '-1100.00', '-1000.00'), ...(second ? [party('7002', 'Steel Inc', '-200.00', '-200.00')] : [])],
    };
  },
  gl_party_open_documents: (args) => {
    const row = (doc: string, number: string, type: string, date: string, due: string | null, amount: string, party: string) => ({
      party, doc, type, number, date, netsuite_due: due, fleetsuite_due: due, netsuite: amount, fleetsuite: amount, netsuite_lines: true, fleetsuite_lines: true,
    });
    return {
      linked: true,
      documents: 3,
      parties: [],
      rows: args.p_kind === 'customer'
        ? [row('101', 'INV101', 'CustInvc', '2026-09-01', '2026-10-01', '800.00', ACME), row('102', 'INV102', 'CustInvc', '2026-10-21', '2026-11-20', '500.00', ACME),
          row('107', 'CM7', 'CustCred', '2026-09-01', null, '-50.00', ACME),
          ...(second ? [row('201', 'INV201', 'CustInvc', '2026-10-25', '2026-11-24', '900.00', BRAVO)] : [])]
        : [row('4001', 'VB1', 'VendBill', '2026-09-20', '2026-10-20', '-900.00', '7001'), row('4002', 'VC1', 'VendCred', '2026-10-25', null, '30.00', '7001'),
          ...(second ? [row('4003', 'VB2', 'VendBill', '2026-08-16', '2026-09-15', '-200.00', '7002')] : [])],
    };
  },
  gl_books_collections: () => ({ total: '2200.00', count: 6 }),
};

/** Just enough of supabase-js for the Financials routes. */
function query(table: string) {
  reads.push(table);
  const where: Array<(r: Record<string, unknown>) => boolean> = [];
  let range: [number, number] | null = null;
  const rows = () => {
    const all = table === 'books_switches' ? [{ piece: 'money_screens', is_on: switchOn }]
      : table === 'sync_state' ? Object.entries(syncState).map(([sync_type, s]) => ({ sync_type, ...s }))
        : TABLES[table] ?? [];
    const kept = all.filter((r) => where.every((w) => w(r)));
    return range ? kept.slice(range[0], range[1] + 1) : kept;
  };
  const answer = () => (failing === table ? { data: null, error: { message: `Couldn't read ${table}` } } : { data: rows(), error: null });
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (column: string, value: unknown) => { where.push((r) => r[column] === value); return q; },
    in: (column: string, values: unknown[]) => { where.push((r) => values.includes(r[column])); return q; },
    range: (from: number, to: number) => { range = [from, to]; return q; },
    maybeSingle: async () => {
      const a = answer();
      return a.error ? a : { data: a.data![0] ?? null, error: null };
    },
    then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(answer()).then(done, failed),
  };
  return q;
}
const rpcs: Array<[string, Record<string, unknown>]> = [];
const service = {
  from: query,
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push([name, args]);
    if (failing === name) return { data: null, error: { message: `${name} failed` } };
    return { data: RPCS[name]?.(args) ?? null, error: RPCS[name] ? null : { message: `No ${name}` } };
  },
};

const get = (path: string) => new NextRequest(`https://go.bmgfleet.com${path}`);
const bookReads = () => rpcs.map(([name]) => name);
const anyNetSuite = () => Object.values(netsuite).filter((f) => f !== netsuite.transactionUrl).some((f) => f.mock.calls.length > 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T18:00:00Z'));
  vi.stubEnv('NETSUITE_PAYROLL_ACCOUNT_IDS', '61');
  allowed = true;
  switchOn = true;
  second = false;
  failing = null;
  syncState = {
    books_invoice_posting: { last_result: { partial: false }, updated_at: '2026-11-02T17:48:00Z' },
    books_netsuite_lists: { last_result: { taxAccounts: [{ tax_code_id: '5', account_id: '22', lines: 12 }] }, updated_at: '2026-11-02T06:00:00Z' },
  };
  rpcs.length = 0;
  reads.length = 0;
  for (const f of Object.values(netsuite)) f.mockClear();
  netsuite.suiteqlQueryAll.mockResolvedValue([]);
  netsuite.getAccountBalancesFromRestlet.mockResolvedValue({ success: true, balances: {} });
  netsuite.getIncomeStatementFromRestlet.mockResolvedValue({ success: true, rows: [{ accountId: '40', accountName: 'Sales', accountType: 'Income', segment: null, amount: -5000 }] });
  netsuite.getCollectionsFromRestlet.mockResolvedValue({ success: true, total: -500, count: 2 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Financials on FleetSuite's books, switched on", () => {
  it("adds up the tiles from BMG's books: cash, what customers owe and what BMG owes, without 1084's", async () => {
    const res = await summaryRoute(get('/api/reports/financials'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ar: {
        total: 1250, pastDue: 750, openCount: 3,
        buckets: { current: 500, d1_30: 0, d31_60: 800, d61_90: -50, d90plus: 0 },
        topOverdue: [{ key: `e:${ACME}`, customer: 'Acme Fleet', amount: 750, days: 32 }],
        notOpen: 0,
      },
      ap: { vendorBills: 1000, cardOwed: 500, salesTax: 70, total: 1570 },
      cash: 9100,
      net: 8780,
      config: { balancesOk: true, balancesError: null, bankConfigured: true, cardConfigured: true, apConfigured: true, salesTaxConfigured: true },
      books: { company: 'BMG', name: 'Example Fleet', postedAt: '2026-11-02T17:48:00Z', postingError: null, postingPartial: false },
    });
    expect(anyNetSuite()).toBe(false);
    expect(rpcs.filter(([name]) => name.startsWith('gl_party')).map(([name, args]) => [name, args])).toEqual(expect.arrayContaining([
      ['gl_party_balances', { p_company: 'BMG', p_kind: 'customer' }],
      ['gl_party_open_documents', { p_company: 'BMG', p_kind: 'customer' }],
      ['gl_party_balances', { p_company: 'BMG', p_kind: 'vendor' }],
    ]));
    expect(rpcs.filter(([name]) => ['gl_netsuite_totals', 'gl_books_totals'].includes(name)).map(([, args]) => args.p_company)).toEqual(['BMG', 'BMG']);
  });

  it('lists the open invoices and credit memos behind the A/R tile, most overdue first, then the largest, with their totals and POs, and what is not in one', async () => {
    second = true;
    const body = await (await arRoute(get('/api/reports/financials/ar-invoices'))).json();
    expect(body).toEqual({
      success: true,
      unpaidColumn: true,
      notOpen: -80,
      invoices: [
        expect.objectContaining({ id: '107', tranid: 'CM7', po: 'RMA-9', total: -50, unpaid: -50, daysPastDue: 62, bucket: 'd61_90', creditMemo: true, nsUrl: 'https://ns.example/custcred/107' }),
        expect.objectContaining({ id: '101', tranid: 'INV101', po: 'PO-77', total: 1000, unpaid: 800, daysPastDue: 32, entityId: ACME, nsUrl: 'https://ns.example/custinvc/101' }),
        expect.objectContaining({ id: '201', tranid: 'INV201', customer: 'Bravo Trucking', po: null, total: 900, unpaid: 900, daysPastDue: 0, entityId: BRAVO }),
        // Only NetSuite's copy of a document gives its total and PO.
        expect.objectContaining({ id: '102', po: null, total: 500, unpaid: 500, daysPastDue: 0, bucket: 'current' }),
      ],
    });
    expect(anyNetSuite()).toBe(false);
  });

  it('lists the open bills and bill credits behind the A/P tile, most overdue first, with their memos', async () => {
    second = true;
    const body = await (await apRoute(get('/api/reports/financials/ap-bills'))).json();
    expect(body).toEqual({
      success: true,
      unpaidColumn: true,
      notOpen: 130,
      bills: [
        expect.objectContaining({ id: '4003', tranid: 'VB2', vendor: 'Steel Inc', memo: null, total: 200, unpaid: 200, daysPastDue: 48 }),
        expect.objectContaining({ id: '4001', tranid: 'VB1', vendor: 'Parts Co', memo: 'Oct parts', total: 900, unpaid: 900, daysPastDue: 13 }),
        expect.objectContaining({ id: '4002', tranid: 'VC1', memo: null, total: -30, unpaid: -30, daysPastDue: 8, billCredit: true, nsUrl: 'https://ns.example/vendcred/4002' }),
      ],
    });
  });

  it('lists the accounts behind cash, the cards and sales tax, and leaves out a link NetSuite cannot give', async () => {
    const body = await (await accountsRoute(get('/api/reports/financials/accounts'))).json();
    expect(body).toEqual({
      success: true,
      bank: [{ id: '10', name: '1000 Checking', type: 'bank', balance: 9100 }],
      card: [{ id: '21', name: '2100 Chase card', type: 'credit_card', balance: 500 }],
      ap: [],
      salesTax: [{ id: '22', name: '2200 Sales tax', type: 'other_current_liability', balance: 70 }],
      has: { bank: true, card: true, ap: true, salesTax: true },
    });
    netsuite.transactionUrl.mockImplementation(() => { throw new Error('Missing NetSuite environment variables'); });
    const ar = await (await arRoute(get('/api/reports/financials/ar-invoices'))).json();
    expect(ar.invoices.map((i: { nsUrl: string }) => i.nsUrl)).toEqual(['', '', '']);
    netsuite.transactionUrl.mockImplementation((page: string, id: string | number) => `https://ns.example/${page}/${id}`);
  });

  it("reads the band's period from BMG's books, payroll apart, with what customers paid on its days", async () => {
    const body = await (await pnlRoute(get('/api/reports/financials/pnl?period=last-month'))).json();
    expect(body).toEqual({
      period: {
        key: 'last-month', label: 'Last month', from: '2026-10-01', to: '2026-10-31', directional: false,
        pnl: {
          income: 1000, cogs: 0, expense: 600, payroll: 300, otherIncome: 0, otherExpense: 0, grossMargin: 1000, grossMarginPct: 100,
          netProfit: 100, netProfitPct: 10, laborPct: 30, accountCount: 3,
        },
        collections: { total: 2200, count: 6 },
        error: null,
      },
      options: [
        { key: 'mtd', label: 'This month' }, { key: 'last-month', label: 'Last month' }, { key: 'qtd', label: 'Quarter to date' },
        { key: 'ytd', label: 'Year to date' }, { key: 'last-year', label: 'Last year' },
      ],
      payrollConfigured: true,
      books: { company: 'BMG', name: 'Example Fleet', postedAt: '2026-11-02T17:48:00Z', postingError: null, postingPartial: false },
    });
    expect(rpcs.find(([name]) => name === 'gl_books_collections')).toEqual(['gl_books_collections', { p_company: 'BMG', p_from: '2026-10-01', p_to: '2026-10-31' }]);
    expect(anyNetSuite()).toBe(false);

    // A period it doesn't know is last month, and this month is November so far.
    expect((await (await pnlRoute(get('/api/reports/financials/pnl?period=forever'))).json()).period.key).toBe('last-month');
    const mtd = await (await pnlRoute(get('/api/reports/financials/pnl?period=mtd'))).json();
    expect(mtd.period).toMatchObject({ from: '2026-11-01', to: '2026-11-02', directional: true, pnl: { income: 0, accountCount: 0 } });

    // With no payroll accounts named, wages are an expense like rent.
    vi.stubEnv('NETSUITE_PAYROLL_ACCOUNT_IDS', '');
    const unnamed = await (await pnlRoute(get('/api/reports/financials/pnl?period=last-month'))).json();
    expect(unnamed.payrollConfigured).toBe(false);
    expect(unnamed.period.pnl).toMatchObject({ expense: 900, payroll: 0, netProfit: 100 });
  });

  it("says plainly when the books can't be read, on the tiles, the lists and the band", async () => {
    for (const [fails, why] of [['gl_party_balances', 'gl_party_balances failed'], ['gl_books_totals', 'gl_books_totals failed'], ['gl_accounts', "Couldn't read gl_accounts"]]) {
      failing = fails;
      const res = await summaryRoute(get('/api/reports/financials'));
      expect([fails, res.status, await res.json()]).toEqual([fails, 500, { error: `Couldn't read FleetSuite's books: ${why}` }]);
    }
    failing = 'gl_party_open_documents';
    expect((await arRoute(get('/api/reports/financials/ar-invoices'))).status).toBe(500);
    expect((await apRoute(get('/api/reports/financials/ap-bills'))).status).toBe(500);
    failing = 'ledger_invoices';
    expect(await (await arRoute(get('/api/reports/financials/ar-invoices'))).json()).toEqual({ error: "Couldn't read FleetSuite's books: Couldn't read ledger_invoices" });
    failing = 'gl_netsuite_bills';
    expect(await (await apRoute(get('/api/reports/financials/ap-bills'))).json()).toEqual({ error: "Couldn't read FleetSuite's books: Couldn't read gl_netsuite_bills" });
    failing = 'sync_state';
    expect((await accountsRoute(get('/api/reports/financials/accounts'))).status).toBe(500);
    failing = 'gl_books_collections';
    const band = await pnlRoute(get('/api/reports/financials/pnl'));
    expect(band.status).toBe(200);
    const failed = await band.json();
    expect(failed.period).toMatchObject({ pnl: null, collections: null, error: "Couldn't read FleetSuite's books: gl_books_collections failed" });
    expect(failed.books).toEqual({ company: 'BMG', name: 'BMG', postedAt: null, postingError: null, postingPartial: false });
    expect(anyNetSuite()).toBe(false);
  });

  it('says when the last posting run went wrong or stopped for time, and when BMG has no books', async () => {
    syncState.books_invoice_posting.last_result = { error: 'Deadlock', partial: true };
    expect((await (await summaryRoute(get('/api/reports/financials'))).json()).books).toEqual({
      company: 'BMG', name: 'Example Fleet', postedAt: '2026-11-02T17:48:00Z', postingError: 'Deadlock', postingPartial: true,
    });
    syncState.books_invoice_posting.last_result = { partial: true };
    expect((await (await pnlRoute(get('/api/reports/financials/pnl'))).json()).books).toEqual({
      company: 'BMG', name: 'Example Fleet', postedAt: '2026-11-02T17:48:00Z', postingError: null, postingPartial: true,
    });
    const companies = TABLES.gl_companies;
    TABLES.gl_companies = companies.filter((c) => c.code !== 'BMG');
    try {
      expect(await (await summaryRoute(get('/api/reports/financials'))).json()).toEqual({ error: "Couldn't read FleetSuite's books: FleetSuite's books have no company BMG" });
    } finally {
      TABLES.gl_companies = companies;
    }
  });

  it('counts no sales tax until NetSuite says where it posts it', async () => {
    delete syncState.books_netsuite_lists;
    const body = await (await summaryRoute(get('/api/reports/financials'))).json();
    expect(body.ap).toEqual({ vendorBills: 1000, cardOwed: 500, salesTax: 0, total: 1500 });
    expect(body.config.salesTaxConfigured).toBe(false);
  });
});

describe("Financials on FleetSuite's books, switched off", () => {
  it('reads NetSuite as before, and nothing from the books', async () => {
    switchOn = false;
    const summary = await (await summaryRoute(get('/api/reports/financials'))).json();
    expect(summary).not.toHaveProperty('books');
    expect(summary.ar.total).toBe(0);
    expect(netsuite.suiteqlQueryAll).toHaveBeenCalled();
    expect(netsuite.getAccountBalancesFromRestlet).toHaveBeenCalled();

    expect(await (await arRoute(get('/api/reports/financials/ar-invoices'))).json()).toEqual({ success: true, unpaidColumn: true, invoices: [] });
    expect(await (await apRoute(get('/api/reports/financials/ap-bills'))).json()).toEqual({ success: true, unpaidColumn: true, bills: [] });
    expect(await (await accountsRoute(get('/api/reports/financials/accounts'))).json()).toMatchObject({ success: true, bank: [], card: [] });
    const band = await (await pnlRoute(get('/api/reports/financials/pnl'))).json();
    expect(band.period).toMatchObject({ pnl: { income: 5000 }, collections: { total: 500, count: 2 } });
    expect(band).not.toHaveProperty('books');
    expect(bookReads()).toEqual([]);
    expect(reads.filter((t) => t !== 'books_switches')).toEqual([]);
  });

  it("reads NetSuite when the switch can't be read", async () => {
    failing = 'books_switches';
    await summaryRoute(get('/api/reports/financials'));
    expect(netsuite.suiteqlQueryAll).toHaveBeenCalled();
    expect(bookReads()).toEqual([]);
  });

  it("is the Financials tab's alone, on or off", async () => {
    allowed = false;
    for (const route of [summaryRoute, arRoute, apRoute, accountsRoute, pnlRoute]) {
      expect((await route(get('/api/reports/financials'))).status).toBe(403);
    }
    expect(reads).toEqual([]);
    expect(rpcs).toEqual([]);
    expect(anyNetSuite()).toBe(false);
  });
});
