// The two-hourly NetSuite sync's customer and contact phases (src/app/api/cron/netsuite-sync) once FleetSuite's record
// wins (src/lib/fleetsuite-records.ts): a customer FleetSuite has keeps its name, email, phone and billing address,
// NetSuite's fills a blank, what NetSuite has instead is noted, a new customer comes in as before, and a contact
// FleetSuite has stays as it is; while it's off, NetSuite's comes over FleetSuite's as it always has. The other phases
// are held. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, any>>>,
  failing: new Set<string>(),
  upserts: [] as Array<{ table: string; row: Record<string, any>; opts: Record<string, any> }>,
  notes: [] as Array<Array<Record<string, any>>>,
  noteError: null as string | null,
  heartbeats: [] as string[],
  netsuite: { customers: [] as Array<Record<string, any>>, addresses: [] as Array<Record<string, any>> | Error, contacts: [] as Array<Record<string, any>> },
}));

vi.mock('@/lib/netsuite', () => ({
  suiteqlQueryAll: vi.fn(async (q: string) => {
    if (/FROM customer c\s+WHERE c\.isinactive/.test(q)) return h.netsuite.customers;
    if (q.includes('customerAddressbook')) {
      if (h.netsuite.addresses instanceof Error) throw h.netsuite.addresses;
      return h.netsuite.addresses;
    }
    if (q.includes('FROM contact c')) return h.netsuite.contacts;
    return [];
  }),
  updateCustomer: vi.fn(),
  patchEntityRecord: vi.fn(),
}));
vi.mock('@/lib/api-auth', () => ({ requireAdmin: vi.fn(async () => ({ error: new Response('Forbidden', { status: 403 }) })) }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async (_s: unknown, type: string) => { h.heartbeats.push(type); return { ok: true }; }) }));
vi.mock('@/lib/po-invoice-sync', () => ({ syncPoInvoices: vi.fn(async () => ({})) }));
vi.mock('@/lib/po-invoice-verify', () => ({ verifyPoInvoiceQuantities: vi.fn(async () => ({})) }));
vi.mock('@/lib/vendor-po-sync', () => ({ syncVendorPos: vi.fn(async () => ({})) }));
vi.mock('@/lib/purchase-request-po-match', () => ({ autoMatchPurchaseRequests: vi.fn(async () => ({})) }));
vi.mock('@/lib/sales-order-sync', () => ({ syncSalesOrders: vi.fn(async () => ({})) }));
vi.mock('@/lib/vendor-bill-sync', () => ({ syncVendorBillPayments: vi.fn(async () => ({})), syncPayoutBillPayments: vi.fn(async () => ({})) }));
vi.mock('@/lib/ar-payment-sync', () => ({ syncArInvoicePayments: vi.fn(async () => ({})) }));
vi.mock('@/lib/estimate-close-sync', () => ({ closeConvertedEstimates: vi.fn(async () => ({})) }));
vi.mock('@/lib/so-invoices', () => ({ syncVehicleInvoices: vi.fn(async () => ({})) }));
vi.mock('@/lib/estimate-invoices', () => ({ syncEstimateInvoices: vi.fn(async () => ({})) }));
vi.mock('@/lib/vendor-master', () => ({ syncVendors: vi.fn(async () => ({})) }));
vi.mock('@/lib/netsuite-creators', () => ({ syncNetsuiteCreators: vi.fn(async () => ({})) }));
vi.mock('@/lib/customer-tax-exempt-sync', () => ({ syncNetsuiteTaxExempt: vi.fn(async () => ({})) }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => {
    const from = (table: string) => {
      const filters: Array<(r: Record<string, any>) => boolean> = [];
      const run = () => (h.failing.has(table)
        ? { data: null, error: { message: `${table} said no` } }
        : { data: (h.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null });
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
        not: (c: string) => { filters.push((r) => r[c] !== null && r[c] !== undefined); return q; },
        order: () => q,
        range: async () => run(),
        single: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
        upsert: async (row: Record<string, any>, opts: Record<string, any> = {}) => { h.upserts.push({ table, row, opts }); return { error: null }; },
        then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(run()).then(done, failed),
      };
      return q;
    };
    return {
      from,
      rpc: async (fn: string, args: { p: Array<Record<string, any>> }) => {
        expect(fn).toBe('note_record_differences');
        h.notes.push(args.p);
        return h.noteError ? { data: null, error: { message: h.noteError } } : { data: { opened: args.p.filter((s) => s.differs).length, closed: 0 }, error: null };
      },
    };
  },
}));

import { GET } from '../app/api/cron/netsuite-sync/route';

const cron = () => new NextRequest('https://go.bmgfleet.com/api/cron/netsuite-sync', { headers: { authorization: 'Bearer cron-secret' } });

/** Acme as FleetSuite has it: its own name and email, no phone, and its billing address. */
const ACME_CRM = {
  id: 'p-acme', netsuite_id: '2001', company_name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: null,
  address: '100 Main St', address2: null, city: "O'Fallon", state: 'MO', zip: '63366',
};
/** Acme as someone changed it in NetSuite, and a customer FleetSuite hasn't got. */
const NETSUITE_CUSTOMERS = [
  { id: 2001, companyname: 'Acme Fleet', entityid: 'C-2001', email: 'ap@acmefleet.example', phone: '636-555-0100', parent: 2001 },
  { id: 2002, companyname: 'Harbor Fleet', entityid: 'C-2002', email: 'hi@harbor.example', phone: null, parent: null },
];
const ADDRESSES = [
  { customer_id: 2001, addr1: '200 Oak Ave', addr2: null, city: 'St. Charles', state: 'MO', zip: '63301' },
  { customer_id: 2002, addr1: '9 Dock Rd', addr2: 'Bay 2', city: 'Springfield', state: 'MO', zip: '65802' },
];
const CONTACT = { contact_id: 77, entity_name: 'Pat Doe', firstname: 'Pat', lastname: 'Doe', email: 'pat@new.example', phone: '555-0177', customer_id: 2001 };

const written = (table: string, netsuiteId: string) => h.upserts.find((u) => u.table === table && u.row.netsuite_id === netsuiteId)?.row;

beforeEach(() => {
  process.env.CRON_SECRET = 'cron-secret';
  h.tables = {
    books_switches: [{ piece: 'fleetsuite_records', is_on: true }],
    prospects: [{ ...ACME_CRM }],
    sync_state: [],
    record_differences: [],
  };
  h.failing = new Set();
  h.upserts = [];
  h.notes = [];
  h.noteError = null;
  h.heartbeats = [];
  h.netsuite = { customers: structuredClone(NETSUITE_CUSTOMERS), addresses: structuredClone(ADDRESSES), contacts: [] };
});

describe("the two-hourly sync once FleetSuite's record wins", () => {
  it("keeps a known customer's name, email and billing address, NetSuite's filling its blank phone, and notes the rest", async () => {
    const json = await (await GET(cron())).json();
    expect(json.customers).toMatchObject({ modified: 2, customersSynced: 2, prospectsSynced: 2, changedInNetsuite: 3 });
    expect(written('prospects', '2001')).toMatchObject({
      company_name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: '636-555-0100',
      address: '100 Main St', address2: null, city: "O'Fallon", state: 'MO', zip: '63366',
    });
    expect(written('customers', '2001')).toMatchObject({
      company_name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: '636-555-0100', address: "100 Main St, O'Fallon, MO, 63366",
      // What only NetSuite keeps still comes.
      entity_id: 'C-2001', netsuite_parent_id: null,
    });
    expect(h.notes).toEqual([[
      { kind: 'customer', netsuite_id: '2001', name: 'Acme Fleet Services', field: 'name', fleetsuite: 'Acme Fleet Services', netsuite: 'Acme Fleet', differs: true },
      { kind: 'customer', netsuite_id: '2001', name: 'Acme Fleet Services', field: 'email', fleetsuite: 'billing@acmefleet.example', netsuite: 'ap@acmefleet.example', differs: true },
      { kind: 'customer', netsuite_id: '2001', name: 'Acme Fleet Services', field: 'address',
        fleetsuite: { addr1: '100 Main St', addr2: '', city: "O'Fallon", state: 'MO', zip: '63366' },
        netsuite: { addr1: '200 Oak Ave', addr2: '', city: 'St. Charles', state: 'MO', zip: '63301' }, differs: true },
    ]]);
    expect(h.heartbeats).toContain('netsuite_customers');
  });

  it("brings in a customer FleetSuite hasn't got as NetSuite has it", async () => {
    await GET(cron());
    expect(written('prospects', '2002')).toMatchObject({
      company_name: 'Harbor Fleet', email: 'hi@harbor.example', phone: null, address: '9 Dock Rd', address2: 'Bay 2', city: 'Springfield', state: 'MO', zip: '65802',
    });
    expect(written('customers', '2002')).toMatchObject({ company_name: 'Harbor Fleet', address: '9 Dock Rd, Bay 2, Springfield, MO, 65802' });
  });

  it("leaves the address columns alone when NetSuite's addresses couldn't be read", async () => {
    h.netsuite.addresses = new Error('NetSuite SuiteQL error (500)');
    await GET(cron());
    for (const table of ['prospects', 'customers']) {
      for (const id of ['2001', '2002']) expect(Object.keys(written(table, id)!)).not.toContain('address');
    }
    expect(h.notes[0].map((s) => s.field)).toEqual(['name', 'email']);
  });

  it("writes nothing over FleetSuite's customers when it can't read them, and doesn't move on", async () => {
    h.failing.add('prospects');
    const json = await (await GET(cron())).json();
    expect(json.customers).toEqual({ error: "Couldn't read FleetSuite's customers: prospects said no" });
    expect(h.upserts.filter((u) => u.table === 'customers' || u.table === 'prospects')).toEqual([]);
    expect(h.heartbeats).not.toContain('netsuite_customers');
  });

  it("writes nothing over FleetSuite's customers or contacts when it can't tell whether it's on, and doesn't move on", async () => {
    h.failing.add('books_switches');
    h.netsuite.contacts = [CONTACT];
    const json = await (await GET(cron())).json();
    const why = "Couldn't tell whether FleetSuite's record wins: books_switches said no";
    expect(json.customers).toEqual({ error: why });
    expect(json.contacts).toEqual({ error: why });
    expect(h.upserts.filter((u) => ['customers', 'prospects', 'prospect_contacts'].includes(u.table))).toEqual([]);
    expect(h.heartbeats).not.toContain('netsuite_customers');
    expect(h.heartbeats).not.toContain('netsuite_contacts');
  });

  it("reads the customers again next time when what NetSuite has instead can't be noted", async () => {
    h.noteError = 'deadlock';
    const json = await (await GET(cron())).json();
    expect(json.customers).toEqual({ error: "Couldn't note what NetSuite has instead: deadlock" });
    expect(h.heartbeats).not.toContain('netsuite_customers');
  });

  it('leaves a contact FleetSuite has as it is, and still brings in a new one', async () => {
    h.netsuite.contacts = [CONTACT];
    await GET(cron());
    expect(h.upserts.filter((u) => u.table === 'prospect_contacts')).toEqual([{
      table: 'prospect_contacts',
      row: { prospect_id: 'p-acme', name: 'Pat Doe', title: null, email: 'pat@new.example', phone: '555-0177' },
      opts: { onConflict: 'prospect_id,name', ignoreDuplicates: true },
    }]);
  });
});

describe("the two-hourly sync while FleetSuite's record wins is off", () => {
  beforeEach(() => { h.tables.books_switches[0].is_on = false; });

  it("copies NetSuite's over FleetSuite's record, as it always has, and notes nothing", async () => {
    h.netsuite.contacts = [CONTACT];
    const json = await (await GET(cron())).json();
    expect(json.customers).toEqual({ modified: 2, customersSynced: 2, prospectsSynced: 2, syncStateWrite: { ok: true } });
    expect(written('prospects', '2001')).toMatchObject({
      company_name: 'Acme Fleet', email: 'ap@acmefleet.example', phone: '636-555-0100', address: '200 Oak Ave', address2: null, city: 'St. Charles', zip: '63301',
    });
    expect(written('customers', '2001')).toMatchObject({ company_name: 'Acme Fleet', address: '200 Oak Ave, St. Charles, MO, 63301' });
    expect(h.notes).toEqual([]);
    expect(h.upserts.find((u) => u.table === 'prospect_contacts')?.opts).toEqual({ onConflict: 'prospect_id,name' });
  });

  it('clears an address NetSuite no longer has, and names a customer without a name by its entity ID', async () => {
    h.netsuite.addresses = [];
    h.netsuite.customers = [{ id: 2003, companyname: null, entityid: 'C-2003', email: null, phone: null, parent: 2003 }];
    await GET(cron());
    expect(written('prospects', '2003')).toMatchObject({ company_name: 'C-2003', address: null, address2: null, city: null, state: null, zip: null });
    expect(written('customers', '2003')).toMatchObject({ company_name: 'C-2003', address: null, netsuite_parent_id: null });
  });
});
