// FleetSuite's record wins (src/lib/fleetsuite-records.ts, migration 480): the same value written two ways, what a sync
// writes once it's on (FleetSuite's kept, NetSuite's filling a blank, what NetSuite has instead), noting it, the list,
// and keeping FleetSuite's or taking NetSuite's: claimed first, sent once, opened again when it doesn't go through.
// Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ updateCustomer: vi.fn(), patchEntityRecord: vi.fn() }));
vi.mock('@/lib/netsuite', () => ({ updateCustomer: h.updateCustomer, patchEntityRecord: h.patchEntityRecord }));

import {
  actOn, actRefusal, addressLine, changeOf, customerToWrite, isBlank, keepFleetsuite, noteDifferences, NO_ADDRESS,
  prospectAddress, prospectFacts, readCustomerRecords, readDifferences, readVendorRecords, recordsWin, recordsWinForSync, sameValue,
  shownValue,
  FIELDS, LIST_LIMIT, type DifferenceRow, type Seen,
} from './fleetsuite-records';

type Row = Record<string, any>;

/**
 * Just enough of supabase-js, really applying the filters a query builds: a dropped `.eq('status', 'open')` makes a
 * test fail rather than pass. `failing` names a table, or 'table:update', that answers with an error, and
 * `state.failRead` picks out a read that does; `before` runs ahead of an update, to change what it finds.
 */
function fake(tables: Record<string, Row[]> = {}) {
  const failing = new Set<string>();
  const reads: Array<{ table: string; filters: string[] }> = [];
  const updates: Array<{ table: string; values: Row; filters: string[] }> = [];
  const rpcs: Array<{ fn: string; args: Row }> = [];
  const state = {
    before: null as null | ((table: string) => void),
    /** A read that answers with an error, by its table and filters. */
    failRead: null as null | ((table: string, filters: string[]) => boolean),
    rpc: (_fn: string, _args: Row): { data: unknown; error: { message: string } | null } => ({ data: { opened: 0, closed: 0 }, error: null }),
  };
  function from(table: string) {
    const filters: Array<[string, (r: Row) => boolean]> = [];
    const sorts: Array<[string, boolean]> = [];
    let limit = Infinity;
    let range: [number, number] | null = null;
    let values: Row | null = null;
    const rows = () => (tables[table] ??= []);
    const run = () => {
      const names = filters.map(([n]) => n);
      if (failing.has(table) || (values && failing.has(`${table}:update`))) return { data: null, error: { message: `${table} said no` } };
      if (values) {
        state.before?.(table);
        const hit = rows().filter((r) => filters.every(([, f]) => f(r)));
        for (const r of hit) Object.assign(r, values);
        updates.push({ table, values, filters: names });
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      if (state.failRead?.(table, names)) return { data: null, error: { message: `${table} said no` } };
      reads.push({ table, filters: names });
      let list = rows().filter((r) => filters.every(([, f]) => f(r))).sort((a, b) => {
        for (const [c, up] of sorts) if (a[c] !== b[c]) return ((a[c] ?? '') < (b[c] ?? '') ? -1 : 1) * (up ? 1 : -1);
        return 0;
      });
      if (range) list = list.slice(range[0], range[1] + 1);
      return { data: list.slice(0, limit).map((r) => structuredClone(r)), error: null };
    };
    const q: any = {
      select: () => q,
      update: (v: Row) => { values = v; return q; },
      eq: (c: string, v: unknown) => { filters.push([`${c}=${v}`, (r) => r[c] === v]); return q; },
      neq: (c: string, v: unknown) => { filters.push([`${c}!=${v}`, (r) => r[c] !== v]); return q; },
      is: (c: string, v: unknown) => { filters.push([`${c} is ${v}`, (r) => (r[c] ?? null) === v]); return q; },
      in: (c: string, v: unknown[]) => { filters.push([`${c} in ${v.length}`, (r) => v.includes(r[c])]); return q; },
      order: (c: string, o: { ascending?: boolean } = {}) => { sorts.push([c, o.ascending !== false]); return q; },
      limit: (n: number) => { limit = n; return q; },
      range: (a: number, b: number) => { range = [a, b]; return q; },
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(run()).then(done, failed),
    };
    return q;
  }
  const service = {
    from,
    rpc: async (fn: string, args: Row) => { rpcs.push({ fn, args }); return state.rpc(fn, args); },
  };
  return { service: service as any, tables, failing, reads, updates, rpcs, state };
}

const ACME = '2001';
const FELLERS = '3001';
const BY = 'a0000000-0000-4000-8000-000000000001';
const address = (addr1: string, city = "O'Fallon", state = 'MO', zip = '63366', addr2 = '') => ({ addr1, addr2, city, state, zip });

/** A difference on the list, open unless said otherwise. */
const difference = (over: Partial<DifferenceRow> = {}): DifferenceRow => ({
  id: 'd0000000-0000-4000-8000-000000000001',
  kind: 'customer',
  netsuite_id: ACME,
  name: 'Acme Fleet Services',
  field: 'email',
  fleetsuite_value: 'billing@acmefleet.example',
  netsuite_value: 'ap@acmefleet.example',
  status: 'open',
  first_seen_at: '2027-01-06T16:00:00.000Z',
  last_seen_at: '2027-01-06T18:00:00.000Z',
  sent_to_netsuite: null,
  closed_at: null,
  closed_by: null,
  ...over,
});

const prospect = (over: Row = {}) => ({
  netsuite_id: ACME, company_name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: '636-555-0100',
  address: '100 Main St', address2: null, city: "O'Fallon", state: 'MO', zip: '63366', ...over,
});

beforeEach(() => {
  h.updateCustomer.mockReset();
  h.patchEntityRecord.mockReset();
});

describe('the same value, written two ways', () => {
  it('counts a value as blank when it has nothing but spaces, an address when every line is blank', () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank('   ')).toBe(true);
    expect(isBlank(NO_ADDRESS)).toBe(true);
    expect(isBlank({ ...NO_ADDRESS, city: '  ' })).toBe(true);
    expect(isBlank('x')).toBe(false);
    expect(isBlank({ ...NO_ADDRESS, zip: '63366' })).toBe(false);
  });

  it("spaces never count, and a name's case does", () => {
    expect(sameValue('name', '  Acme   Fleet Services ', 'Acme Fleet Services')).toBe(true);
    expect(sameValue('name', 'Acme Fleet Services', 'ACME FLEET SERVICES')).toBe(false);
    expect(sameValue('name', 'Acme', 'Acme Fleet')).toBe(false);
  });

  it('takes an email in any case', () => {
    expect(sameValue('email', 'AP@AcmeFleet.example', ' ap@acmefleet.example')).toBe(true);
    expect(sameValue('email', 'ap@acmefleet.example', 'billing@acmefleet.example')).toBe(false);
  });

  it('takes a phone by its digits, with or without the leading 1', () => {
    expect(sameValue('phone', '(636) 555-0100', '636.555.0100')).toBe(true);
    expect(sameValue('phone', '1-636-555-0100', '6365550100')).toBe(true);
    expect(sameValue('phone', '+1 636 555 0100', '636-555-0100')).toBe(true);
    expect(sameValue('phone', '636-555-0100', '636-555-0101')).toBe(false);
    // Only a country's 1 in front of ten digits goes.
    expect(sameValue('phone', '16365550100', '1636555010')).toBe(false);
    expect(sameValue('phone', '2636555010', '636555010')).toBe(false);
    // A phone with no digits is taken as written, in any case.
    expect(sameValue('phone', 'Ask for Pat', 'ask  for pat')).toBe(true);
    expect(sameValue('phone', 'Ask for Pat', 'Ask for Sam')).toBe(false);
  });

  it("takes an address's lines in any case, each on its own", () => {
    expect(sameValue('address', address('100 MAIN ST', "o'fallon", 'mo'), address(' 100 Main  St'))).toBe(true);
    expect(sameValue('address', address('100 Main St'), address('100 Main St', "O'Fallon", 'MO', '63368'))).toBe(false);
    // The same words on other lines aren't the same address.
    expect(sameValue('address', address('100 Main St', '', '', ''), { ...NO_ADDRESS, addr1: '100 Main St' })).toBe(true);
    expect(sameValue('address', { ...NO_ADDRESS, addr1: 'Suite 4' }, { ...NO_ADDRESS, addr2: 'Suite 4' })).toBe(false);
  });

  it('takes two blanks as the same, and a blank and a value as not', () => {
    expect(sameValue('email', null, '  ')).toBe(true);
    expect(sameValue('address', NO_ADDRESS, null)).toBe(true);
    expect(sameValue('email', null, 'ap@acmefleet.example')).toBe(false);
    expect(sameValue('address', NO_ADDRESS, address('100 Main St'))).toBe(false);
  });

  it('shows a value with its spaces tidied, an address on one line, and none as (none)', () => {
    expect(shownValue('  Acme   Fleet ')).toBe('Acme Fleet');
    expect(shownValue(address('100  Main St', "O'Fallon", 'MO', '63366', 'Suite 4'))).toBe("100 Main St, Suite 4, O'Fallon, MO, 63366");
    expect(shownValue(address('100 Main St', '', ''))).toBe('100 Main St, 63366');
    expect(shownValue(null)).toBe('(none)');
    expect(shownValue(' ')).toBe('(none)');
    expect(shownValue(NO_ADDRESS)).toBe('(none)');
  });
});

describe('what a sync writes once FleetSuite’s record wins', () => {
  it("keeps FleetSuite's, fills a blank with NetSuite's, and says where NetSuite has something else", () => {
    const { values, seen } = keepFleetsuite('vendor', FELLERS, 'Fellers', FIELDS.vendor,
      { name: 'Fellers', email: ' ', phone: '(314) 555-0199' },
      { name: 'Fellers Inc', email: 'ap@fellers.example', phone: '314-555-0199' });
    expect(values).toEqual({ name: 'Fellers', email: 'ap@fellers.example', phone: '(314) 555-0199' });
    expect(seen).toEqual([
      { kind: 'vendor', netsuite_id: FELLERS, name: 'Fellers', field: 'name', fleetsuite: 'Fellers', netsuite: 'Fellers Inc', differs: true },
      { kind: 'vendor', netsuite_id: FELLERS, name: 'Fellers', field: 'email', fleetsuite: null, netsuite: 'ap@fellers.example', differs: false },
      { kind: 'vendor', netsuite_id: FELLERS, name: 'Fellers', field: 'phone', fleetsuite: '(314) 555-0199', netsuite: '314-555-0199', differs: false },
    ]);
  });

  it("lists a field NetSuite has emptied, keeping FleetSuite's", () => {
    const { values, seen } = keepFleetsuite('vendor', FELLERS, null, ['email'], { email: 'ap@fellers.example' }, { email: '' });
    expect(values).toEqual({ email: 'ap@fellers.example' });
    expect(seen).toEqual([{ kind: 'vendor', netsuite_id: FELLERS, name: null, field: 'email', fleetsuite: 'ap@fellers.example', netsuite: null, differs: true }]);
  });

  it("writes NetSuite's for a customer FleetSuite hasn't got, and notes nothing", () => {
    const netsuite = { name: 'New Co', email: 'hi@newco.example', phone: null, address: address('1 First St') };
    expect(customerToWrite('2002', netsuite, undefined, true)).toEqual({ facts: netsuite, seen: [] });
  });

  it("keeps a known customer's name, email, phone and address", () => {
    const { facts, seen } = customerToWrite(ACME,
      { name: 'Acme Fleet', email: 'ap@acmefleet.example', phone: '636-555-0100', address: address('200 Oak Ave') },
      prospectFacts(prospect()), true);
    expect(facts).toEqual({ name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: '636-555-0100', address: address('100 Main St') });
    expect(seen.map((s) => [s.field, s.differs, s.name])).toEqual([
      ['name', true, 'Acme Fleet Services'], ['email', true, 'Acme Fleet Services'], ['phone', false, 'Acme Fleet Services'], ['address', true, 'Acme Fleet Services'],
    ]);
  });

  it("leaves the address alone when the sync didn't read it", () => {
    const netsuite = { name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: '636-555-0100', address: null };
    const { facts, seen } = customerToWrite(ACME, netsuite, prospectFacts(prospect()), false);
    expect(facts).toEqual({ name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: '636-555-0100', address: null });
    expect(seen.map((s) => s.field)).toEqual(['name', 'email', 'phone']);
    expect(seen.some((s) => s.differs)).toBe(false);
  });

  it('names a customer with no name in FleetSuite by nothing, for the list to name by its NetSuite ID', () => {
    const { seen } = customerToWrite(ACME, { name: 'Acme', email: null, phone: null, address: null }, prospectFacts(prospect({ company_name: null })), false);
    expect(seen[0]).toMatchObject({ field: 'name', name: null, fleetsuite: null, netsuite: 'Acme', differs: false });
  });

  it("writes an address on the customer list's one line, and in the CRM record's columns", () => {
    expect(addressLine(address('100 Main St', "O'Fallon", 'MO', '63366', 'Suite 4'))).toBe("100 Main St, Suite 4, O'Fallon, MO, 63366");
    expect(addressLine(address('100 Main St', '', '', ''))).toBe('100 Main St');
    expect(addressLine(NO_ADDRESS)).toBeNull();
    expect(addressLine(null)).toBeNull();
    expect(addressLine(' ')).toBeNull();
    expect(addressLine('100 Main St')).toBe('100 Main St');
    expect(prospectAddress(address('100 Main St', "O'Fallon", 'MO', '63366', 'Suite 4')))
      .toEqual({ address: '100 Main St', address2: 'Suite 4', city: "O'Fallon", state: 'MO', zip: '63366' });
    expect(prospectAddress(address('100 Main St', '', '', ''))).toEqual({ address: '100 Main St', address2: null, city: null, state: null, zip: null });
    expect(prospectAddress(null)).toEqual({ address: null, address2: null, city: null, state: null, zip: null });
    expect(prospectAddress('100 Main St')).toEqual({ address: null, address2: null, city: null, state: null, zip: null });
  });

  it("reads a CRM record's address as NetSuite's lines, with none as blank lines", () => {
    expect(prospectFacts(prospect({ address: null, city: null, state: null, zip: null }))).toEqual({
      name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: '636-555-0100', address: NO_ADDRESS,
    });
  });
});

describe("reading FleetSuite's records", () => {
  it('reads the customers by NetSuite ID, 200 at a time, each once, leaving out an ID that isn’t one', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => String(5000 + i));
    const f = fake({ prospects: [prospect({ netsuite_id: '5000' }), prospect({ netsuite_id: '5449', company_name: 'Zed Trucks' }), prospect({ netsuite_id: null })] });
    const read = await readCustomerRecords(f.service, [...ids, '5000', 'abc', '']);
    expect(f.reads.map((r) => r.filters)).toEqual([['netsuite_id in 200'], ['netsuite_id in 200'], ['netsuite_id in 50']]);
    expect([...read.keys()]).toEqual(['5000', '5449']);
    expect(read.get('5449')?.name).toBe('Zed Trucks');
    expect(await readCustomerRecords(f.service, [])).toEqual(new Map());
  });

  it("throws when the customers can't be read, so a sync doesn't write over them", async () => {
    const f = fake();
    f.failing.add('prospects');
    await expect(readCustomerRecords(f.service, [ACME])).rejects.toThrow("Couldn't read FleetSuite's customers: prospects said no");
  });

  it("reads the vendors, and throws when they can't be read", async () => {
    const f = fake({ netsuite_vendors: [{ netsuite_id: FELLERS, company_name: 'Fellers', email: null, phone: '314-555-0199', terms: 'Net 30' }] });
    expect(await readVendorRecords(f.service)).toEqual(new Map([[FELLERS, { name: 'Fellers', email: null, phone: '314-555-0199' }]]));
    f.failing.add('netsuite_vendors');
    await expect(readVendorRecords(f.service)).rejects.toThrow("Couldn't read FleetSuite's vendors: netsuite_vendors said no");
  });

  it('is on only when the switch says so', async () => {
    const f = fake({ books_switches: [{ piece: 'fleetsuite_records', is_on: false }] });
    expect(await recordsWin(f.service)).toBe(false);
    f.tables.books_switches[0].is_on = true;
    expect(await recordsWin(f.service)).toBe(true);
    f.failing.add('books_switches');
    expect(await recordsWin(f.service)).toBe(false);
  });

  it("tells a sync it can't tell, rather than let it write NetSuite's over FleetSuite's", async () => {
    const f = fake({ books_switches: [{ piece: 'fleetsuite_records', is_on: true }, { piece: 'credit_memos', is_on: false }] });
    expect(await recordsWinForSync(f.service)).toBe(true);
    f.tables.books_switches[0].is_on = false;
    expect(await recordsWinForSync(f.service)).toBe(false);
    f.tables.books_switches.shift();
    expect(await recordsWinForSync(f.service)).toBe(false);
    f.failing.add('books_switches');
    await expect(recordsWinForSync(f.service)).rejects.toThrow("Couldn't tell whether FleetSuite's record wins: books_switches said no");
  });
});

describe('noting what NetSuite has instead', () => {
  const seen = (netsuiteId: string, field: Seen['field'], differs: boolean, kind: Seen['kind'] = 'customer'): Seen => ({
    kind, netsuite_id: netsuiteId, name: 'Made Up', field, fleetsuite: 'a', netsuite: differs ? 'b' : 'a', differs,
  });

  it("sends what differs, and what's the same again where a difference is open, of the one kind", async () => {
    const f = fake({ record_differences: [
      { id: 'o1', kind: 'customer', netsuite_id: '2002', field: 'phone', status: 'open' },
      { id: 'o2', kind: 'vendor', netsuite_id: '2003', field: 'email', status: 'open' },
      { id: 'o3', kind: 'customer', netsuite_id: '2003', field: 'email', status: 'kept' },
    ] });
    f.state.rpc = () => ({ data: { opened: 1, closed: 1 }, error: null });
    const list = [
      seen('2001', 'email', true), seen('2002', 'phone', false), seen('2002', 'email', false),
      seen('2003', 'email', false), seen('2003', 'phone', true, 'vendor'),
    ];
    expect(await noteDifferences(f.service, 'customer', list)).toEqual({ opened: 1, closed: 1 });
    expect(f.rpcs).toEqual([{ fn: 'note_record_differences', args: { p: [list[0], list[1]] } }]);
    expect(f.reads[0].filters).toEqual(['kind=customer', 'status=open']);
  });

  it('notes nothing, and reads nothing, when nothing was seen of the kind or nothing needs it', async () => {
    const f = fake();
    expect(await noteDifferences(f.service, 'vendor', [seen('2001', 'email', true)])).toEqual({ opened: 0, closed: 0 });
    expect(f.reads).toEqual([]);
    expect(await noteDifferences(f.service, 'customer', [seen('2001', 'email', false)])).toEqual({ opened: 0, closed: 0 });
    expect(f.rpcs).toEqual([]);
  });

  it('sends 500 at a time and adds up what each opened and closed', async () => {
    const f = fake();
    let n = 0;
    f.state.rpc = () => ({ data: { opened: ++n, closed: n === 3 ? 4 : 0 }, error: null });
    const list = Array.from({ length: 1001 }, (_, i) => seen(String(7000 + i), 'name', true));
    expect(await noteDifferences(f.service, 'customer', list)).toEqual({ opened: 6, closed: 4 });
    expect(f.rpcs.map((r) => r.args.p.length)).toEqual([500, 500, 1]);
  });

  it("counts an answer it can't read as nothing", async () => {
    const f = fake();
    f.state.rpc = () => ({ data: null, error: null });
    expect(await noteDifferences(f.service, 'customer', [seen('2001', 'email', true)])).toEqual({ opened: 0, closed: 0 });
  });

  it("throws when it can't note them or read what's open, so the sync reads them again", async () => {
    const f = fake();
    f.state.rpc = () => ({ data: null, error: { message: 'deadlock' } });
    await expect(noteDifferences(f.service, 'customer', [seen('2001', 'email', true)])).rejects.toThrow("Couldn't note what NetSuite has instead: deadlock");
    f.failing.add('record_differences');
    await expect(noteDifferences(f.service, 'customer', [seen('2001', 'email', true)])).rejects.toThrow("Couldn't read what NetSuite has instead: record_differences said no");
  });
});

describe('the list', () => {
  it("shows the open ones newest first, at most LIST_LIMIT, and the last 25 done", async () => {
    const open = Array.from({ length: LIST_LIMIT + 1 }, (_, i) => difference({
      id: `d${String(i).padStart(4, '0')}`, last_seen_at: `2027-01-06T${String(10 + (i % 10)).padStart(2, '0')}:00:00.000Z`,
    }));
    const done = Array.from({ length: 30 }, (_, i) => difference({
      id: `c${String(i).padStart(4, '0')}`, status: 'same', closed_at: `2027-01-${String(1 + i).padStart(2, '0')}T12:00:00.000Z`,
    }));
    const f = fake({ record_differences: [...open, ...done] });
    const list = await readDifferences(f.service);
    expect(list.open).toHaveLength(LIST_LIMIT);
    expect(list.more).toBe(true);
    expect(list.open[0].last_seen_at).toBe('2027-01-06T19:00:00.000Z');
    expect(list.open[0].id).toBe('d0199');
    expect(list.open.every((r) => r.status === 'open')).toBe(true);
    expect(list.closed.map((r) => r.id)).toEqual(Array.from({ length: 25 }, (_, i) => `c${String(29 - i).padStart(4, '0')}`));
  });

  it("says there are no more when they all fit, and throws when they can't be read", async () => {
    const f = fake({ record_differences: [difference()] });
    expect(await readDifferences(f.service)).toMatchObject({ more: false, closed: [] });
    f.failing.add('record_differences');
    await expect(readDifferences(f.service)).rejects.toThrow("Couldn't read what NetSuite has instead: record_differences said no");
    const g = fake({ record_differences: [difference()] });
    g.state.failRead = (table, filters) => table === 'record_differences' && filters.includes('status!=open');
    await expect(readDifferences(g.service)).rejects.toThrow("Couldn't read what NetSuite has instead: record_differences said no");
  });

  it('shows a difference by its names, with who dealt with it and the link to NetSuite', () => {
    const link = vi.fn((kind: string, id: string) => `https://netsuite.example/${kind}/${id}`);
    const kept = difference({ status: 'kept', sent_to_netsuite: true, closed_at: '2027-01-07T15:00:00.000Z', closed_by: BY, field: 'address',
      fleetsuite_value: address('100 Main St'), netsuite_value: null, name: null });
    expect(changeOf(kept, new Map([[BY, 'Craig']]), link)).toEqual({
      id: kept.id, kind: 'customer', kindName: 'Customer', netsuiteId: ACME, name: `NetSuite ID ${ACME}`, field: 'address', fieldName: 'Billing address',
      fleetsuite: "100 Main St, O'Fallon, MO, 63366", netsuite: '(none)', status: 'kept', firstSeenAt: kept.first_seen_at, lastSeenAt: kept.last_seen_at,
      closedAt: '2027-01-07T15:00:00.000Z', closedBy: 'Craig', sent: true, link: `https://netsuite.example/customer/${ACME}`,
    });
    expect(link).toHaveBeenCalledWith('customer', ACME);
    expect(changeOf(difference({ kind: 'vendor', closed_by: BY }), new Map(), () => null)).toMatchObject({ kindName: 'Vendor', closedBy: null, link: null });
  });
});

describe('keeping FleetSuite’s or taking NetSuite’s', () => {
  const NOW = new Date('2027-01-07T15:00:00.000Z');
  const setup = (row: DifferenceRow = difference(), extra: Record<string, Row[]> = {}) => fake({
    record_differences: [{ ...row }],
    prospects: [prospect()],
    customers: [{ netsuite_id: ACME, company_name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: '636-555-0100', address: "100 Main St, O'Fallon, MO, 63366" }],
    netsuite_vendors: [{ netsuite_id: FELLERS, company_name: 'Fellers', email: 'ap@fellers.example', phone: '314-555-0199' }],
    ...extra,
  });
  const after = (f: ReturnType<typeof fake>) => f.tables.record_differences[0];

  it('says why one can’t be acted on', () => {
    expect(actRefusal(null)).toEqual({ ok: false, status: 404, error: "That difference isn't on the list." });
    expect(actRefusal(difference())).toBeNull();
    expect(actRefusal(difference({ kind: 'item' as any }))).toEqual({ ok: false, status: 409, error: "FleetSuite can't keep or take that one." });
    expect(actRefusal(difference({ kind: 'vendor', field: 'address' }))).toEqual({ ok: false, status: 409, error: "FleetSuite can't keep or take that one." });
    expect(actRefusal(difference({ status: 'kept' }))).toEqual({ ok: false, status: 409, error: "That one is done: FleetSuite's was kept. Reload to see the list as it is." });
    expect(actRefusal(difference({ status: 'taken' }))).toEqual({ ok: false, status: 409, error: "That one is done: NetSuite's was taken. Reload to see the list as it is." });
    expect(actRefusal(difference({ status: 'same' }))).toEqual({ ok: false, status: 409, error: 'That one is done: the two are the same now. Reload to see the list as it is.' });
  });

  it("takes NetSuite's email into the CRM record and the customer list, sending nothing", async () => {
    const f = setup();
    expect(await actOn(f.service, { id: difference().id, act: 'take', by: BY, now: NOW })).toMatchObject({ ok: true, status: 'taken' });
    expect(after(f)).toMatchObject({ status: 'taken', closed_at: NOW.toISOString(), closed_by: BY, sent_to_netsuite: null });
    expect(f.tables.prospects[0].email).toBe('ap@acmefleet.example');
    expect(f.tables.customers[0].email).toBe('ap@acmefleet.example');
    expect(f.updates.map((u) => [u.table, u.filters])).toEqual([
      ['record_differences', [`id=${difference().id}`, 'status=open']],
      ['prospects', [`netsuite_id=${ACME}`]],
      ['customers', [`netsuite_id=${ACME}`]],
    ]);
    expect(h.updateCustomer).not.toHaveBeenCalled();
    expect(h.patchEntityRecord).not.toHaveBeenCalled();
  });

  it("takes NetSuite's name into the company name, and an address into each one's columns", async () => {
    const f = setup(difference({ field: 'name', fleetsuite_value: 'Acme Fleet Services', netsuite_value: ' Acme Fleet ' }));
    await actOn(f.service, { id: difference().id, act: 'take', by: BY });
    expect(f.tables.prospects[0].company_name).toBe('Acme Fleet');
    expect(f.tables.customers[0].company_name).toBe('Acme Fleet');

    const g = setup(difference({ field: 'address', fleetsuite_value: address('100 Main St'), netsuite_value: address('200 Oak Ave', 'St. Charles', 'MO', '63301', 'Dock 2') }));
    await actOn(g.service, { id: difference().id, act: 'take', by: BY });
    expect(g.tables.prospects[0]).toMatchObject({ address: '200 Oak Ave', address2: 'Dock 2', city: 'St. Charles', state: 'MO', zip: '63301' });
    expect(g.tables.customers[0].address).toBe('200 Oak Ave, Dock 2, St. Charles, MO, 63301');
  });

  it("takes it into the CRM record even when the customer list can't be kept in step, as the Edit panel does", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = setup();
    f.failing.add('customers:update');
    expect(await actOn(f.service, { id: difference().id, act: 'take', by: BY })).toMatchObject({ ok: true, status: 'taken' });
    expect(after(f).status).toBe('taken');
    expect(f.tables.prospects[0].email).toBe('ap@acmefleet.example');
    expect(errors).toHaveBeenCalledWith(`[fleetsuite records] the customer list's ${ACME} wasn't changed: customers said no`);
    errors.mockRestore();
  });

  it("takes a vendor's phone into the vendor list, and NetSuite's none as none", async () => {
    const f = setup(difference({ kind: 'vendor', netsuite_id: FELLERS, name: 'Fellers', field: 'phone', fleetsuite_value: '314-555-0199', netsuite_value: null }));
    expect(await actOn(f.service, { id: difference().id, act: 'take', by: BY })).toMatchObject({ ok: true, status: 'taken' });
    expect(f.tables.netsuite_vendors[0].phone).toBeNull();
    expect(f.updates.map((u) => u.table)).toEqual(['record_differences', 'netsuite_vendors']);
  });

  it("takes a vendor's name into the vendor list's company name", async () => {
    const f = setup(difference({ kind: 'vendor', netsuite_id: FELLERS, name: 'Fellers', field: 'name', fleetsuite_value: 'Fellers', netsuite_value: ' Fellers Inc ' }));
    expect(await actOn(f.service, { id: difference().id, act: 'take', by: BY })).toMatchObject({ ok: true, status: 'taken' });
    expect(f.tables.netsuite_vendors[0]).toEqual({ netsuite_id: FELLERS, company_name: 'Fellers Inc', email: 'ap@fellers.example', phone: '314-555-0199' });
  });

  it("opens it again when FleetSuite's record can't be changed", async () => {
    const f = setup();
    f.failing.add('prospects:update');
    expect(await actOn(f.service, { id: difference().id, act: 'take', by: BY, now: NOW })).toEqual({
      ok: false, status: 500, error: "Couldn't change FleetSuite's customer: prospects said no. Nothing changed.",
    });
    expect(after(f)).toMatchObject({ status: 'open', closed_at: null, closed_by: null, sent_to_netsuite: null });
    expect(f.tables.customers[0].email).toBe('billing@acmefleet.example');
    const g = setup(difference({ kind: 'vendor', netsuite_id: FELLERS, field: 'email' }));
    g.failing.add('netsuite_vendors:update');
    expect(await actOn(g.service, { id: difference().id, act: 'take', by: BY })).toMatchObject({ status: 500, error: "Couldn't change FleetSuite's vendor: netsuite_vendors said no. Nothing changed." });
    expect(after(g).status).toBe('open');
  });

  it("keeps FleetSuite's email by sending it to NetSuite as the Customer Record's Edit panel does", async () => {
    h.updateCustomer.mockResolvedValue({ success: true });
    const f = setup();
    expect(await actOn(f.service, { id: difference().id, act: 'keep', by: BY, now: NOW })).toMatchObject({ ok: true, status: 'kept' });
    expect(h.updateCustomer).toHaveBeenCalledTimes(1);
    expect(h.updateCustomer).toHaveBeenCalledWith(ACME, { email: 'billing@acmefleet.example' });
    expect(after(f)).toMatchObject({ status: 'kept', closed_at: NOW.toISOString(), closed_by: BY, sent_to_netsuite: true });
    expect(f.tables.prospects[0].email).toBe('billing@acmefleet.example');
  });

  it("sends what FleetSuite has now, not what the sync saw", async () => {
    h.updateCustomer.mockResolvedValue({ success: true });
    const f = setup(difference({ field: 'phone', fleetsuite_value: '636-555-0100', netsuite_value: '636-555-0111' }), { prospects: [prospect({ phone: ' 636-555-0122 ' })] });
    await actOn(f.service, { id: difference().id, act: 'keep', by: BY });
    expect(h.updateCustomer).toHaveBeenCalledWith(ACME, { phone: '636-555-0122' });
  });

  it("sends a name as the company name, and an address's every line", async () => {
    h.updateCustomer.mockResolvedValue({ success: true });
    const f = setup(difference({ field: 'name', fleetsuite_value: 'Acme Fleet Services', netsuite_value: 'Acme' }));
    await actOn(f.service, { id: difference().id, act: 'keep', by: BY });
    expect(h.updateCustomer).toHaveBeenLastCalledWith(ACME, { companyName: 'Acme Fleet Services' });
    const g = setup(difference({ field: 'address', fleetsuite_value: address('100 Main St'), netsuite_value: address('200 Oak Ave') }));
    await actOn(g.service, { id: difference().id, act: 'keep', by: BY });
    expect(h.updateCustomer).toHaveBeenLastCalledWith(ACME, { address: '100 Main St', address2: '', city: "O'Fallon", state: 'MO', zip: '63366' });
  });

  it("sends a vendor's name, email or phone by changing its vendor record", async () => {
    h.patchEntityRecord.mockResolvedValue({ success: true });
    for (const [field, body] of [['name', { companyName: 'Fellers' }], ['email', { email: 'ap@fellers.example' }], ['phone', { phone: '314-555-0199' }]] as const) {
      const f = setup(difference({ kind: 'vendor', netsuite_id: FELLERS, name: 'Fellers', field, fleetsuite_value: 'x', netsuite_value: 'y' }));
      expect(await actOn(f.service, { id: difference().id, act: 'keep', by: BY })).toMatchObject({ ok: true, status: 'kept' });
      expect(h.patchEntityRecord).toHaveBeenLastCalledWith('vendor', FELLERS, body);
    }
    expect(h.updateCustomer).not.toHaveBeenCalled();
  });

  it("closes one as the same, sending nothing, when FleetSuite's has become NetSuite's", async () => {
    const f = setup(difference({ netsuite_value: 'BILLING@acmefleet.example ' }));
    expect(await actOn(f.service, { id: difference().id, act: 'keep', by: BY, now: NOW })).toMatchObject({ ok: true, status: 'same' });
    expect(after(f)).toMatchObject({ status: 'same', closed_at: NOW.toISOString(), closed_by: null, sent_to_netsuite: null });
    expect(h.updateCustomer).not.toHaveBeenCalled();
  });

  it('won’t keep a value FleetSuite no longer has', async () => {
    const f = setup(difference(), { prospects: [prospect({ email: '  ' })] });
    expect(await actOn(f.service, { id: difference().id, act: 'keep', by: BY })).toEqual({
      ok: false, status: 409, error: "FleetSuite has no email for the customer Acme Fleet Services now, so there's nothing to send. Take NetSuite's instead.",
    });
    expect(after(f).status).toBe('open');
    const g = setup(difference({ field: 'address', fleetsuite_value: address('100 Main St'), netsuite_value: address('200 Oak Ave') }),
      { prospects: [prospect({ address: null, city: null, state: null, zip: null })] });
    expect(await actOn(g.service, { id: difference().id, act: 'keep', by: BY })).toMatchObject({ status: 409, error: expect.stringContaining('no billing address for the customer') });
    expect(h.updateCustomer).not.toHaveBeenCalled();
  });

  it("opens it again when NetSuite refuses, saying nothing changed", async () => {
    h.updateCustomer.mockResolvedValue({ success: false, error: 'Invalid email address. ' });
    const f = setup();
    expect(await actOn(f.service, { id: difference().id, act: 'keep', by: BY })).toEqual({
      ok: false, status: 502, error: "NetSuite didn't take it: Invalid email address. Nothing changed.",
    });
    expect(after(f)).toMatchObject({ status: 'open', closed_at: null, closed_by: null, sent_to_netsuite: null });
  });

  it('opens it again only from what this press closed it as', async () => {
    h.updateCustomer.mockResolvedValue({ success: false, error: 'Invalid email address' });
    const f = setup();
    let updates = 0;
    // Between the claim and NetSuite's answer, the row is closed some other way.
    f.state.before = (table) => { if (table === 'record_differences' && ++updates === 2) after(f).status = 'same'; };
    expect(await actOn(f.service, { id: difference().id, act: 'keep', by: BY })).toMatchObject({ ok: false, status: 502 });
    expect(after(f).status).toBe('same');
  });

  it("opens it again when FleetSuite can't tell whether NetSuite took it, for the next read to settle", async () => {
    h.patchEntityRecord.mockResolvedValue({ success: false, unsure: true, error: 'NetSuite took too long to answer.' });
    const f = setup(difference({ kind: 'vendor', netsuite_id: FELLERS, name: 'Fellers', field: 'email', netsuite_value: 'old@fellers.example' }));
    expect(await actOn(f.service, { id: difference().id, act: 'keep', by: BY })).toEqual({
      ok: false, status: 502,
      error: "NetSuite took too long to answer, so FleetSuite can't tell whether NetSuite took it. The next read of NetSuite shows it: if NetSuite has FleetSuite's then, this goes by itself.",
    });
    expect(after(f).status).toBe('open');
    h.patchEntityRecord.mockResolvedValue({ success: false });
    expect(await actOn(f.service, { id: difference().id, act: 'keep', by: BY })).toMatchObject({ error: "NetSuite didn't take it: NetSuite didn't answer. Nothing changed." });
  });

  it('does nothing for a second press, or one someone else got to first', async () => {
    h.updateCustomer.mockResolvedValue({ success: true });
    const f = setup();
    await actOn(f.service, { id: difference().id, act: 'keep', by: BY });
    expect(await actOn(f.service, { id: difference().id, act: 'keep', by: BY })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('That one is done') });
    expect(h.updateCustomer).toHaveBeenCalledTimes(1);

    for (const act of ['keep', 'take'] as const) {
      const g = setup();
      g.state.before = (table) => { if (table === 'record_differences') g.tables.record_differences[0].status = 'taken'; };
      expect(await actOn(g.service, { id: difference().id, act, by: BY })).toEqual({
        ok: false, status: 409, error: 'Someone dealt with that one just now. Reload to see the list as it is.',
      });
      expect(g.tables.prospects[0].email).toBe('billing@acmefleet.example');
    }
    const s = setup(difference({ netsuite_value: 'billing@acmefleet.example' }));
    s.state.before = (table) => { if (table === 'record_differences') s.tables.record_differences[0].status = 'same'; };
    expect(await actOn(s.service, { id: difference().id, act: 'keep', by: BY })).toMatchObject({ status: 409, error: expect.stringContaining('just now') });
    expect(h.updateCustomer).toHaveBeenCalledTimes(1);
  });

  it("refuses one that isn't on the list, or whose record FleetSuite no longer has", async () => {
    const f = setup();
    expect(await actOn(f.service, { id: 'd0000000-0000-4000-8000-000000000009', act: 'take', by: BY })).toMatchObject({ status: 404 });
    const g = setup(difference({ kind: 'vendor', netsuite_id: '3999', name: 'Gone Supply' }));
    expect(await actOn(g.service, { id: difference().id, act: 'take', by: BY })).toEqual({
      ok: false, status: 409, error: "FleetSuite doesn't have the vendor Gone Supply any more, so there's nothing to keep or take.",
    });
    expect(after(g).status).toBe('open');
    const n = setup(difference({ netsuite_id: '2999', name: null }));
    expect(await actOn(n.service, { id: difference().id, act: 'keep', by: BY })).toMatchObject({ error: "FleetSuite doesn't have the customer 2999 any more, so there's nothing to keep or take." });
  });

  it('throws when the list, the record or the claim can’t be read or written', async () => {
    const f = setup();
    f.failing.add('record_differences');
    await expect(actOn(f.service, { id: difference().id, act: 'take', by: BY })).rejects.toThrow("Couldn't read the difference: record_differences said no");
    const g = setup();
    g.failing.add('prospects');
    await expect(actOn(g.service, { id: difference().id, act: 'take', by: BY })).rejects.toThrow("Couldn't read FleetSuite's customer: prospects said no");
    const v = setup(difference({ kind: 'vendor', netsuite_id: FELLERS }));
    v.failing.add('netsuite_vendors');
    await expect(actOn(v.service, { id: difference().id, act: 'take', by: BY })).rejects.toThrow("Couldn't read FleetSuite's vendor: netsuite_vendors said no");
    const c = setup();
    c.failing.add('record_differences:update');
    await expect(actOn(c.service, { id: difference().id, act: 'take', by: BY })).rejects.toThrow("Couldn't take the difference: record_differences said no");
  });
});
