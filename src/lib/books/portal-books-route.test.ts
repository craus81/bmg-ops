// The customer portal's billing (src/lib/portal-billing.ts and the routes
// under /api/portal/[token] and /api/customer/billing) with "Portal billing
// on FleetSuite's books" off and on (migration 505): off, it reads NetSuite
// as before; on, BMG's books in FleetSuite, here made-up agings and copies
// of NetSuite's documents, without asking NetSuite for any invoice.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// The routes take their client as they load, before the fake below is filled in.
const service = vi.hoisted(() => ({}) as {
  from: (table: string) => unknown;
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/magic-link-approval', () => ({ checkRateLimit: vi.fn(async () => true), getRequestIp: () => '203.0.113.9' }));
const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACME = '11111111-1111-4111-8111-111111111111';
const BRAVO = '22222222-2222-4222-8222-222222222222';
vi.mock('@/lib/portal-token', () => ({
  resolvePortalCustomer: vi.fn(async (_s: unknown, token: string) => (token === TOKEN
    ? { id: ACME, netsuite_id: '9001', company_name: 'Acme Fleet', email: 'ap@acme.example' }
    : null)),
}));
let roles = ['customer'];
vi.mock('@/lib/api-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 'u1' }, profile: { role: roles[0], roles } })),
  isAdminRole: (r: string[]) => r.includes('admin') || r.includes('super_admin'),
}));
const netsuite = vi.hoisted(() => ({
  getNetSuitePdf: vi.fn(),
  suiteqlQueryAll: vi.fn(),
  transactionUrl: vi.fn((page: string, id: string | number) => `https://ns.example/${page}/${id}`),
}));
vi.mock('@/lib/netsuite', () => ({ ...netsuite, isSuiteqlError: () => false, suiteqlQuery: vi.fn() }));
const statement = vi.hoisted(() => ({ fetchStatementInvoices: vi.fn() }));
vi.mock('@/lib/financials-data', async (actual) => ({ ...(await actual<object>()), ...statement }));
const pdfs = vi.hoisted(() => ({ generateStatementPdf: vi.fn() }));
vi.mock('@/lib/statement-pdf-server', () => pdfs);
const mail = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/resend', () => mail);
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { GET as portalBilling } from '../../app/api/portal/[token]/billing/route';
import { GET as customerBilling } from '../../app/api/customer/billing/route';
import { GET as invoicePdf } from '../../app/api/portal/[token]/invoice-pdf/route';
import { POST as ask } from '../../app/api/portal/[token]/ask/route';
import { GET as statementPdf, POST as emailStatement } from '../../app/api/portal/[token]/statement/route';

/**
 * Made-up books. Acme (NetSuite's customer 9001) has INV101, a month late
 * with $800 of $1,000 open, and INV102, not yet due; NetSuite has INV103
 * open but FleetSuite's books have it paid; Acme's credit memo CM7 and
 * Bravo's INV201 (NetSuite's customer 9002) aren't Acme's invoices. INV401
 * is under no FleetSuite customer in the books (the ledger mirror hasn't
 * matched NetSuite's customer yet) but NetSuite names Acme on it.
 */
const TABLES: Record<string, Array<Record<string, unknown>>> = {
  external_contacts: [{ id: 'xc1', customer_id: ACME, is_primary: true, email: 'ap@acme.example' }],
  ledger_invoices: [
    { id: 'li1', source: 'netsuite', external_id: 'CustInvc/101', external_ref: '101', total: 1000, po_number: 'PO-77', customer_netsuite_id: '9001' },
    { id: 'li2', source: 'netsuite', external_id: 'CustInvc/102', external_ref: '102', total: 500, po_number: null, customer_netsuite_id: '9001' },
    { id: 'li3', source: 'netsuite', external_id: 'CustInvc/201', external_ref: '201', total: 900, po_number: null, customer_netsuite_id: '9002' },
    // NetSuite's open items name Acme on INV401, which the mirror still has under Bravo.
    { id: 'li4', source: 'netsuite', external_id: 'CustInvc/401', external_ref: '401', total: 75, po_number: null, customer_netsuite_id: '9002' },
    { id: 'li5', source: 'quickbooks', external_id: 'CustInvc/102', external_ref: '102', total: 999, po_number: 'Not this one', customer_netsuite_id: '9001' },
  ],
  gl_netsuite_open_items: [
    { netsuite_id: '101', entity_id: '9001' },
    // NetSuite's open items name nobody on INV102, so the ledger mirror's customer counts.
    { netsuite_id: '102', entity_id: '' },
    { netsuite_id: '103', entity_id: '9001' },
    { netsuite_id: '201', entity_id: '9002' },
    { netsuite_id: '401', entity_id: '9001' },
  ],
};

let switchOn = true;
let linked = true;
/** Open documents a test adds to the books'. */
let extraRows: Array<ReturnType<typeof row>> = [];
let syncState: Record<string, string | null>;
/** A table or function whose read fails. */
let failing: string | null = null;
const reads: string[] = [];

/** One of the books' open documents, as gl_party_open_documents returns it. */
const row = (party: string, doc: string, number: string, type: string, date: string, due: string | null, netsuite: string, fleetsuite = netsuite) => ({
  party, doc, type, number, date, netsuite_due: due, fleetsuite_due: due, netsuite, fleetsuite, netsuite_lines: true, fleetsuite_lines: true,
});

const RPCS: Record<string, (args: Record<string, unknown>) => unknown> = {
  gl_party_balances: () => ({
    accounts: [],
    opening: { total: '0', named: '0', complete: true },
    parties: [
      { party: ACME, name: 'Acme Fleet', netsuite_ids: ['9001'], opening: '0', netsuite: '1310.00', fleetsuite: '1250.00', documents: 4, differing: 1, members: null, members_count: null },
      { party: BRAVO, name: 'Bravo Trucking', netsuite_ids: ['9002'], opening: '0', netsuite: '900.00', fleetsuite: '900.00', documents: 1, differing: 0, members: null, members_count: null },
      { party: '', name: null, netsuite_ids: [], opening: '0', netsuite: '75.00', fleetsuite: '75.00', documents: 1, differing: 0, members: null, members_count: null },
    ],
  }),
  gl_party_open_documents: () => ({
    linked,
    documents: 6 + extraRows.length,
    parties: [],
    rows: [
      row(ACME, '101', 'INV101', 'CustInvc', '2026-09-01', '2026-10-01', '800.00'),
      row(ACME, '102', 'INV102', 'CustInvc', '2026-10-21', '2026-11-20', '500.00'),
      row(ACME, '103', 'INV103', 'CustInvc', '2026-10-26', '2026-11-25', '60.00', '0'),
      row(ACME, '107', 'CM7', 'CustCred', '2026-09-01', null, '-50.00'),
      row(BRAVO, '201', 'INV201', 'CustInvc', '2026-10-25', '2026-11-24', '900.00'),
      row('', '401', 'INV401', 'CustInvc', '2026-09-25', '2026-10-25', '75.00'),
      ...extraRows,
    ],
  }),
};

/** Just enough of supabase-js for the portal's billing. */
function query(table: string) {
  reads.push(table);
  const where: Array<(r: Record<string, unknown>) => boolean> = [];
  let range: [number, number] | null = null;
  const rows = () => {
    const all = table === 'books_switches' ? [{ piece: 'portal_books', is_on: switchOn }]
      : table === 'sync_state' ? Object.entries(syncState).map(([sync_type, last_synced_at]) => ({ sync_type, last_synced_at }))
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
const rpcs: string[] = [];
Object.assign(service, {
  from: query,
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push(name);
    if (failing === name) return { data: null, error: { message: `${name} failed` } };
    return { data: RPCS[name]?.(args) ?? null, error: RPCS[name] ? null : { message: `No ${name}` } };
  },
});

/** NetSuite's own open invoice for Acme, as the portal read it before. */
const NETSUITE_INVOICE = {
  id: '101', tranid: 'INV101', date: '2026-09-01', dueDate: '2026-10-01', po: 'PO-77', customer: 'Acme Fleet (NetSuite)', entityId: '9001',
  total: 1000, unpaid: 1000, daysPastDue: 32, bucket: 'd31_60', nsUrl: 'https://ns.example/custinvc/101', status: 'open',
};

// Each test starts ten minutes after the last, past the portal's five-minute cache.
let clock = Date.parse('2026-11-02T18:00:00Z');
const at = (minutesAgo: number) => new Date(clock - minutesAgo * 60_000).toISOString();
const url = (path: string) => `https://go.bmgfleet.com${path}`;
const get = (path: string) => new NextRequest(url(path));
const post = (path: string, body?: unknown) => new NextRequest(url(path), {
  method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' },
});
const params = { params: { token: TOKEN } };
const BOOKS_READS = ['gl_party_balances', 'gl_party_open_documents'];

beforeEach(() => {
  clock += 10 * 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(clock));
  switchOn = true;
  linked = true;
  extraRows = [];
  failing = null;
  roles = ['customer'];
  syncState = { books_netsuite_gl: at(55), books_invoice_posting: at(12), books_netsuite_open_items: at(31) };
  TABLES.profiles = [{ id: 'u1', customer_netsuite_id: '9001' }];
  reads.length = 0;
  rpcs.length = 0;
  for (const f of [...Object.values(netsuite), ...Object.values(statement), ...Object.values(pdfs), ...Object.values(mail)]) f.mockReset();
  netsuite.transactionUrl.mockImplementation((page: string, id: string | number) => `https://ns.example/${page}/${id}`);
  netsuite.getNetSuitePdf.mockImplementation(async (_kind: string, id: string) => ({ success: true, pdfBase64: Buffer.from(`PDF ${id}`).toString('base64'), filename: `Invoice_${id}.pdf` }));
  statement.fetchStatementInvoices.mockResolvedValue({ invoices: [NETSUITE_INVOICE], unpaidColumn: true });
  pdfs.generateStatementPdf.mockResolvedValue({ ok: true, buffer: Buffer.from('STATEMENT'), filename: 'Statement_Acme.pdf' });
  mail.sendEmail.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Portal billing on FleetSuite's books, switched on", () => {
  it("lists the customer's open invoices from BMG's books, as of when the books last caught up, without asking NetSuite", async () => {
    const res = await portalBilling(get(`/api/portal/${TOKEN}/billing`), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ready',
      company: 'Acme Fleet',
      balance: 1375,
      pastDue: 875,
      invoiceCount: 3,
      aging: { current: 500, d1_30: 75, d31_60: 800, d61_90: 0, d90plus: 0 },
      invoices: [
        { id: '101', tranid: 'INV101', date: '2026-09-01', dueDate: '2026-10-01', po: 'PO-77', total: 1000, unpaid: 800, daysPastDue: 32 },
        { id: '401', tranid: 'INV401', date: '2026-09-25', dueDate: '2026-10-25', po: null, total: 75, unpaid: 75, daysPastDue: 8 },
        { id: '102', tranid: 'INV102', date: '2026-10-21', dueDate: '2026-11-20', po: null, total: 500, unpaid: 500, daysPastDue: 0 },
      ],
      generatedAt: new Date(clock).toISOString(),
      asOf: at(55),
    });
    expect(statement.fetchStatementInvoices).not.toHaveBeenCalled();
    expect(netsuite.suiteqlQueryAll).not.toHaveBeenCalled();
    expect(rpcs).toEqual(expect.arrayContaining(BOOKS_READS));
  });

  it("shows a logged-in customer their own, and an admin any customer's", async () => {
    const own = await (await customerBilling(get('/api/customer/billing'))).json();
    expect(own).toMatchObject({ linked: true, balance: 1375, invoiceCount: 3, asOf: at(55) });
    roles = ['admin'];
    const bravo = await (await customerBilling(get('/api/customer/billing?customerId=9002'))).json();
    expect(bravo).toMatchObject({ linked: true, balance: 900, invoiceCount: 1, invoices: [expect.objectContaining({ id: '201', unpaid: 900 })] });
    expect(statement.fetchStatementInvoices).not.toHaveBeenCalled();
  });

  it("hands over an invoice's PDF only when the books list it as the customer's, and takes a question only about one of theirs", async () => {
    const res = await invoicePdf(get(`/api/portal/${TOKEN}/invoice-pdf?id=401`), params);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PDF 401');
    // Bravo's, the one FleetSuite's books have paid, and the credit memo aren't Acme's open invoices.
    for (const id of ['201', '103', '107']) {
      expect((await invoicePdf(get(`/api/portal/${TOKEN}/invoice-pdf?id=${id}`), params)).status).toBe(404);
    }
    expect(netsuite.getNetSuitePdf.mock.calls).toEqual([['invoice', '401']]);
    const asked = await ask(post(`/api/portal/${TOKEN}/ask`, { invoiceId: '201', invoiceNumber: 'INV201', message: 'Is this ours?' }), params);
    expect([asked.status, await asked.json()]).toEqual([404, { status: 'invalid' }]);
    expect(reads).not.toContain('customer_threads');
  });

  it("puts the books' invoices on the statement, dated when the books caught up, and emails it to the customer's own address", async () => {
    const res = await statementPdf(get(`/api/portal/${TOKEN}/statement`), params);
    expect(res.status).toBe(200);
    expect(pdfs.generateStatementPdf).toHaveBeenCalledWith(service, {
      customer: 'Acme Fleet', scope: 'open', asOf: at(55),
      invoices: [
        expect.objectContaining({ id: '101', unpaid: 800, status: 'open' }),
        expect.objectContaining({ id: '102', unpaid: 500, status: 'open' }),
        expect.objectContaining({ id: '401', unpaid: 75, status: 'open' }),
      ],
    });
    const sent = await emailStatement(post(`/api/portal/${TOKEN}/statement`), params);
    expect(await sent.json()).toEqual({ success: true, sentTo: 'a…@acme.example', attached: 4 });
    expect(pdfs.generateStatementPdf.mock.calls.map(([, data]) => data.asOf)).toEqual([at(55), at(55)]);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendEmail.mock.calls[0][0]).toBe('ap@acme.example');
    expect(mail.sendEmail.mock.calls[0][2]).toContain('Your current balance is <b>$1,375.00</b> across 3 open invoices.');
    // The most overdue first.
    expect(netsuite.getNetSuitePdf.mock.calls.map(([, id]) => id)).toEqual(['101', '401', '102']);
  });

  it('keeps an answer for five minutes, and never serves NetSuite\'s once the switch goes on, nor the books\' once it goes off', async () => {
    switchOn = false;
    expect((await (await portalBilling(get(`/api/portal/${TOKEN}/billing`), params)).json()).balance).toBe(1000);
    switchOn = true;
    expect((await (await portalBilling(get(`/api/portal/${TOKEN}/billing`), params)).json()).balance).toBe(1375);
    vi.setSystemTime(new Date(clock + 4 * 60_000));
    rpcs.length = 0;
    expect((await (await portalBilling(get(`/api/portal/${TOKEN}/billing`), params)).json()).balance).toBe(1375);
    expect(rpcs).toEqual([]);
    switchOn = false;
    expect((await (await portalBilling(get(`/api/portal/${TOKEN}/billing`), params)).json()).balance).toBe(1000);
    expect(statement.fetchStatementInvoices).toHaveBeenCalledTimes(1);
  });

  it("lists an invoice the books have open that NetSuite has paid, going by the ledger mirror's customer", async () => {
    // INV104 is paid in NetSuite, so it isn't in NetSuite's open items, but FleetSuite's books have $120 open on it.
    extraRows = [row(ACME, '104', 'INV104', 'CustInvc', '2026-10-28', '2026-11-27', '0', '120.00')];
    TABLES.ledger_invoices.push({ id: 'li6', source: 'netsuite', external_id: 'CustInvc/104', external_ref: '104', total: 120, po_number: 'PO-80', customer_netsuite_id: '9001' });
    try {
      const body = await (await portalBilling(get(`/api/portal/${TOKEN}/billing`), params)).json();
      expect(body).toMatchObject({ balance: 1495, invoiceCount: 4 });
      expect(body.invoices).toContainEqual({ id: '104', tranid: 'INV104', date: '2026-10-28', dueDate: '2026-11-27', po: 'PO-80', total: 120, unpaid: 120, daysPastDue: 0 });
    } finally {
      TABLES.ledger_invoices.pop();
    }
  });

  it("refuses a customer whose NetSuite id isn't one, before reading anything", async () => {
    TABLES.profiles = [{ id: 'u1', customer_netsuite_id: '9001 OR 1=1' }];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await customerBilling(get('/api/customer/billing'));
      expect([res.status, errors.mock.calls[0][1]]).toEqual([502, new Error('Invalid entity id')]);
    } finally {
      errors.mockRestore();
    }
    expect(reads).toEqual(['profiles']);
    expect(rpcs).toEqual([]);
  });

  it("says billing is unavailable, without falling back to NetSuite, when the books can't be read or are behind", async () => {
    const unavailable = { error: 'Billing is temporarily unavailable — try again in a few minutes.' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cases: Array<[() => void, string]> = [
        [() => { failing = 'gl_party_open_documents'; }, "Couldn't read FleetSuite's books: gl_party_open_documents failed"],
        [() => { failing = 'gl_netsuite_open_items'; }, "Couldn't read FleetSuite's books: Couldn't read gl_netsuite_open_items"],
        [() => { failing = 'ledger_invoices'; }, "Couldn't read FleetSuite's books: Couldn't read ledger_invoices"],
        [() => { failing = 'sync_state'; }, "Couldn't read FleetSuite's books: Couldn't read sync_state"],
        [() => { linked = false; }, "Couldn't read FleetSuite's books: BMG isn't linked to its NetSuite subsidiary"],
        [() => { syncState.books_invoice_posting = null; }, "Couldn't read FleetSuite's books: the posting run hasn't finished a run"],
        [() => { syncState.books_netsuite_open_items = at(24 * 60 + 1); },
          `Couldn't read FleetSuite's books: the books haven't caught up with NetSuite since ${at(24 * 60 + 1)}`],
      ];
      for (const [setUp, why] of cases) {
        failing = null;
        linked = true;
        syncState = { books_netsuite_gl: at(55), books_invoice_posting: at(12), books_netsuite_open_items: at(31) };
        setUp();
        errors.mockClear();
        const res = await portalBilling(get(`/api/portal/${TOKEN}/billing`), params);
        expect([why, res.status, await res.json()]).toEqual([why, 502, unavailable]);
        expect(errors.mock.calls[0][1]).toEqual(new Error(why));
      }
      expect(statement.fetchStatementInvoices).not.toHaveBeenCalled();
      expect(netsuite.getNetSuitePdf).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("Portal billing on FleetSuite's books, switched off", () => {
  it('reads NetSuite as before, and nothing of the books', async () => {
    switchOn = false;
    const body = await (await portalBilling(get(`/api/portal/${TOKEN}/billing`), params)).json();
    expect(body).toMatchObject({
      status: 'ready', balance: 1000, pastDue: 1000, invoiceCount: 1,
      invoices: [{ id: '101', tranid: 'INV101', date: '2026-09-01', dueDate: '2026-10-01', po: 'PO-77', total: 1000, unpaid: 1000, daysPastDue: 32 }],
      generatedAt: new Date(clock).toISOString(),
    });
    expect(body).not.toHaveProperty('asOf');
    expect(statement.fetchStatementInvoices).toHaveBeenCalledWith('9001', { scope: 'open' });
    expect(rpcs).toEqual([]);
    expect(reads).toEqual(['books_switches']);
  });

  it("reads NetSuite when the switch can't be read, and refuses an id that isn't NetSuite's", async () => {
    failing = 'books_switches';
    expect((await (await customerBilling(get('/api/customer/billing'))).json()).balance).toBe(1000);
    expect(statement.fetchStatementInvoices).toHaveBeenCalledWith('9001', { scope: 'open' });
    roles = ['super_admin'];
    TABLES.profiles = [];
    expect(await (await customerBilling(get('/api/customer/billing?customerId=12a'))).json()).toEqual({ linked: false });
    expect(statement.fetchStatementInvoices).toHaveBeenCalledTimes(1);
  });

  it("leaves NetSuite's statement dated when it's made, and still guards each PDF", async () => {
    switchOn = false;
    await statementPdf(get(`/api/portal/${TOKEN}/statement`), params);
    expect(pdfs.generateStatementPdf).toHaveBeenCalledWith(service, expect.objectContaining({ customer: 'Acme Fleet (NetSuite)', asOf: undefined }));
    expect((await invoicePdf(get(`/api/portal/${TOKEN}/invoice-pdf?id=102`), params)).status).toBe(404);
    expect((await invoicePdf(get(`/api/portal/${TOKEN}/invoice-pdf?id=101`), params)).status).toBe(200);
  });
});
