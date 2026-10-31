// The NetSuite syncs staff run by hand, the customer sync (src/app/api/netsuite/customers) and the contact sync
// (src/app/api/netsuite/contacts/sync), once FleetSuite's record wins (src/lib/fleetsuite-records.ts): a customer
// FleetSuite has keeps its name, email and phone, NetSuite's filling a blank, and its address, which these leave to the
// two-hourly sync; what NetSuite has instead is noted; a contact FleetSuite has stays as it is, taking only the link
// to NetSuite's contact it lacks. While it's off, NetSuite's comes over FleetSuite's as it always has. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, any>>>,
  failing: new Set<string>(),
  upserts: [] as Array<{ table: string; row: Record<string, any>; opts: Record<string, any> }>,
  updates: [] as Array<{ table: string; values: Record<string, any>; where: string[] }>,
  notes: [] as Array<Array<Record<string, any>>>,
  noteError: null as string | null,
  netsuite: {
    customers: [] as Array<Record<string, any>>,
    addresses: [] as Array<Record<string, any>>,
    contacts: [] as Array<Record<string, any>>,
    contactRoles: [] as Array<Record<string, any>>,
  },
}));

vi.mock('@/lib/netsuite', () => ({
  suiteqlQuery: vi.fn(),
  suiteqlQueryAll: vi.fn(async (q: string) => {
    if (/FROM customer c\s+WHERE c\.isinactive = 'F'\s+ORDER BY c\.companyname/.test(q)) return h.netsuite.customers;
    if (q.includes('customerAddressbook')) return h.netsuite.addresses;
    if (q.includes('FROM contact c')) return h.netsuite.contacts;
    return [];
  }),
  updateCustomer: vi.fn(),
  patchEntityRecord: vi.fn(),
}));
vi.mock('@/lib/netsuite-sends', () => ({
  netsuiteFetch: vi.fn(async () => ({ ok: true, json: async () => ({ contactRoles: { items: h.netsuite.contactRoles } }) })),
}));
vi.mock('@/lib/api-auth', () => ({ requireStaff: vi.fn(async () => ({ user: { id: 'a0000000-0000-4000-8000-000000000001' } })) }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => {
    const from = (table: string) => {
      const filters: Array<(r: Record<string, any>) => boolean> = [];
      const where: string[] = [];
      let values: Record<string, any> | null = null;
      const run = () => {
        if (h.failing.has(table)) return { data: null, error: { message: `${table} said no` } };
        if (values) { h.updates.push({ table, values, where }); return { data: null, error: null }; }
        return { data: (h.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
      };
      const q: any = {
        select: () => q,
        update: (v: Record<string, any>) => { values = v; return q; },
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); where.push(`${c} = ${v}`); return q; },
        is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); where.push(`${c} is ${v}`); return q; },
        in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
        not: (c: string) => { filters.push((r) => r[c] !== null && r[c] !== undefined); return q; },
        order: () => q,
        range: async () => run(),
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
        upsert: async (row: Record<string, any>, opts: Record<string, any> = {}) => { h.upserts.push({ table, row, opts }); return { error: null }; },
        then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(run()).then(done, failed),
      };
      return q;
    };
    return {
      from,
      rpc: async (fn: string, args: { p: Array<Record<string, any>> }) => {
        if (fn !== 'note_record_differences') throw new Error(`unexpected rpc ${fn}`);
        h.notes.push(args.p);
        return h.noteError ? { data: null, error: { message: h.noteError } } : { data: { opened: args.p.filter((s) => s.differs).length, closed: 0 }, error: null };
      },
    };
  },
}));

import { GET as syncCustomers } from '../app/api/netsuite/customers/route';
import { POST as syncContacts } from '../app/api/netsuite/contacts/sync/route';

const customersRequest = () => new NextRequest('https://go.bmgfleet.com/api/netsuite/customers');
const contactsRequest = () => new NextRequest('https://go.bmgfleet.com/api/netsuite/contacts/sync', { method: 'POST' });

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
const CONTACT = {
  contact_id: 77, entity_name: 'Pat Doe', firstname: 'Pat', lastname: 'Doe', email: 'pat@new.example', phone: '555-0177', title: 'Buyer', customer_id: 2001,
};
const ADDRESS_COLUMNS = ['address', 'address2', 'city', 'state', 'zip'];

const written = (table: string, netsuiteId: string) => h.upserts.find((u) => u.table === table && u.row.netsuite_id === netsuiteId)?.row;
const synced = (table: string) => h.upserts.filter((u) => u.table === table);

beforeEach(() => {
  h.tables = {
    books_switches: [{ piece: 'fleetsuite_records', is_on: true }],
    prospects: [{ ...ACME_CRM }],
    // Acme's address, changed in NetSuite and listed by the two-hourly sync.
    record_differences: [{ id: 'd-1', kind: 'customer', netsuite_id: '2001', field: 'address', status: 'open' }],
  };
  h.failing = new Set();
  h.upserts = [];
  h.updates = [];
  h.notes = [];
  h.noteError = null;
  h.netsuite = {
    customers: structuredClone(NETSUITE_CUSTOMERS),
    addresses: structuredClone(ADDRESSES),
    contacts: [],
    contactRoles: [{ contactName: '77 Pat Doe', role: { refName: 'Buyer' }, email: 'pat@new.example' }],
  };
  vi.stubEnv('NETSUITE_ACCOUNT_ID', '1234567-sb1');
  for (const name of ['NETSUITE_CONSUMER_KEY', 'NETSUITE_CONSUMER_SECRET', 'NETSUITE_TOKEN_ID', 'NETSUITE_TOKEN_SECRET']) vi.stubEnv(name, 'made-up');
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("Sync customers once FleetSuite's record wins", () => {
  it("keeps a known customer's name, email and address, NetSuite's filling its blank phone, and notes the rest", async () => {
    const res = await syncCustomers(customersRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ status: 'synced', total: 2, synced: 2, prospectsSynced: 2, changedInNetsuite: 2, contactsSynced: 1 });
    expect(json).not.toHaveProperty('changedInNetsuiteError');
    expect(written('prospects', '2001')).toMatchObject({ company_name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: '636-555-0100' });
    expect(written('customers', '2001')).toMatchObject({
      company_name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: '636-555-0100', entity_id: 'C-2001', netsuite_parent_id: null,
    });
    // The address is FleetSuite's in both: this sync has NetSuite's only as one line.
    expect(Object.keys(written('customers', '2001')!)).not.toContain('address');
    for (const column of ADDRESS_COLUMNS) expect(Object.keys(written('prospects', '2001')!)).not.toContain(column);
    // The address listed stays listed: nothing here closes it.
    expect(h.notes).toEqual([[
      { kind: 'customer', netsuite_id: '2001', name: 'Acme Fleet Services', field: 'name', fleetsuite: 'Acme Fleet Services', netsuite: 'Acme Fleet', differs: true },
      { kind: 'customer', netsuite_id: '2001', name: 'Acme Fleet Services', field: 'email', fleetsuite: 'billing@acmefleet.example', netsuite: 'ap@acmefleet.example', differs: true },
    ]]);
  });

  it("brings in a customer FleetSuite hasn't got as NetSuite has it, its address with it", async () => {
    await syncCustomers(customersRequest());
    expect(written('customers', '2002')).toMatchObject({
      company_name: 'Harbor Fleet', email: 'hi@harbor.example', phone: null, address: '9 Dock Rd, Bay 2, Springfield, MO, 65802',
    });
    expect(written('prospects', '2002')).toMatchObject({ company_name: 'Harbor Fleet', email: 'hi@harbor.example' });
  });

  it('leaves a contact FleetSuite has as it is, and still brings in a new one', async () => {
    await syncCustomers(customersRequest());
    expect(synced('prospect_contacts')).toEqual([{
      table: 'prospect_contacts',
      row: { prospect_id: 'p-acme', name: 'Pat Doe', title: 'Buyer', email: 'pat@new.example', phone: null },
      opts: { onConflict: 'prospect_id,name', ignoreDuplicates: true },
    }]);
  });

  it("still syncs, FleetSuite's kept, when what NetSuite has instead can't be noted, and says so", async () => {
    h.noteError = 'deadlock';
    const res = await syncCustomers(customersRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ synced: 2, changedInNetsuiteError: "Couldn't note what NetSuite has instead: deadlock" });
    expect(json).not.toHaveProperty('changedInNetsuite');
    expect(written('customers', '2001')).toMatchObject({ company_name: 'Acme Fleet Services' });
  });

  it("writes nothing over FleetSuite's customers when it can't read them", async () => {
    h.failing.add('prospects');
    const res = await syncCustomers(customersRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Couldn't read FleetSuite's customers: prospects said no");
    expect(h.upserts).toEqual([]);
  });

  it("writes nothing when it can't tell whether FleetSuite's record wins, rather than take it for off", async () => {
    h.failing.add('books_switches');
    const res = await syncCustomers(customersRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Couldn't tell whether FleetSuite's record wins: books_switches said no");
    expect(h.upserts).toEqual([]);
  });
});

describe("Sync customers while FleetSuite's record wins is off", () => {
  beforeEach(() => { h.tables.books_switches[0].is_on = false; });

  it("copies NetSuite's over FleetSuite's record, as it always has, and notes nothing", async () => {
    const json = await (await syncCustomers(customersRequest())).json();
    expect(json).not.toHaveProperty('changedInNetsuite');
    expect(written('prospects', '2001')).toMatchObject({ company_name: 'Acme Fleet', email: 'ap@acmefleet.example', phone: '636-555-0100' });
    expect(written('customers', '2001')).toMatchObject({ company_name: 'Acme Fleet', address: '200 Oak Ave, St. Charles, MO, 63301' });
    expect(h.notes).toEqual([]);
    expect(synced('prospect_contacts').map((u) => u.opts)).toEqual([{ onConflict: 'prospect_id,name' }]);
  });
});

describe("Sync contacts once FleetSuite's record wins", () => {
  beforeEach(() => { h.netsuite.contacts = [CONTACT]; });

  it("leaves a contact FleetSuite has as it is, giving it only NetSuite's link where it has none", async () => {
    const res = await syncContacts(contactsRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ contactsSynced: 1, contactsTotal: 1, contactErrors: 0, totalCustomers: 1 });
    expect(synced('prospect_contacts')).toEqual([{
      table: 'prospect_contacts',
      row: { prospect_id: 'p-acme', name: 'Pat Doe', title: 'Buyer', email: 'pat@new.example', phone: '555-0177', netsuite_contact_id: '77' },
      opts: { onConflict: 'prospect_id,name', ignoreDuplicates: true },
    }]);
    expect(h.updates).toEqual([{
      table: 'prospect_contacts', values: { netsuite_contact_id: '77' }, where: ['prospect_id = p-acme', 'name = Pat Doe', 'netsuite_contact_id is null'],
    }]);
  });

  it("gives no link for a contact NetSuite sent without its id", async () => {
    h.netsuite.contacts = [{ ...CONTACT, contact_id: null }];
    await syncContacts(contactsRequest());
    expect(synced('prospect_contacts')).toHaveLength(1);
    expect(h.updates).toEqual([]);
  });

  it("writes no contact when it can't tell whether FleetSuite's record wins", async () => {
    h.failing.add('books_switches');
    const res = await syncContacts(contactsRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Couldn't tell whether FleetSuite's record wins: books_switches said no");
    expect(h.upserts).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("copies NetSuite's contacts over FleetSuite's while it's off, as it always has", async () => {
    h.tables.books_switches[0].is_on = false;
    await syncContacts(contactsRequest());
    expect(synced('prospect_contacts').map((u) => u.opts)).toEqual([{ onConflict: 'prospect_id,name' }]);
    expect(h.updates).toEqual([]);
  });
});
