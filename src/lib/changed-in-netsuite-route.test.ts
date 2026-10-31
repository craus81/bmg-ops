// Books → Changed in NetSuite (src/app/api/admin/books/changed-in-netsuite, src/lib/fleetsuite-records.ts): super
// admins only; what the page is told, with who dealt with each and the link to NetSuite; and a press of Keep
// FleetSuite's or Take NetSuite's, refused while FleetSuite's record wins is off, passed through when the lib says no,
// and audited when it's done. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  superAdmin: true,
  tables: {} as Record<string, Array<Record<string, any>>>,
  failing: new Set<string>(),
  audits: [] as Array<Record<string, any>>,
  updateCustomer: vi.fn(),
  patchEntityRecord: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  requireSuperAdmin: vi.fn(async () => (h.superAdmin
    ? { user: { id: 'a0000000-0000-4000-8000-000000000001' } }
    : { error: new Response('Forbidden', { status: 403 }) })),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async (_s: unknown, entry: Record<string, any>) => { h.audits.push(entry); }) }));
vi.mock('@/lib/netsuite', () => ({ updateCustomer: h.updateCustomer, patchEntityRecord: h.patchEntityRecord }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => {
    // Equality, emptiness and list filters, ordering and a limit, and updates through the same filters.
    const from = (table: string) => {
      const filters: Array<(r: Record<string, any>) => boolean> = [];
      const sorts: Array<[string, boolean]> = [];
      let limit = Infinity;
      let values: Record<string, any> | null = null;
      const run = () => {
        if (h.failing.has(table)) return { data: null, error: { message: `${table} said no` } };
        const rows = (h.tables[table] ??= []).filter((r) => filters.every((f) => f(r)));
        if (values) { for (const r of rows) Object.assign(r, values); return { data: rows.map((r) => ({ id: r.id })), error: null }; }
        const sorted = [...rows].sort((a, b) => {
          for (const [c, up] of sorts) if (a[c] !== b[c]) return ((a[c] ?? '') < (b[c] ?? '') ? -1 : 1) * (up ? 1 : -1);
          return 0;
        });
        return { data: sorted.slice(0, limit).map((r) => structuredClone(r)), error: null };
      };
      const q: any = {
        select: () => q,
        update: (v: Record<string, any>) => { values = v; return q; },
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q; },
        in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
        order: (c: string, o: { ascending?: boolean } = {}) => { sorts.push([c, o.ascending !== false]); return q; },
        limit: (n: number) => { limit = n; return q; },
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
        then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(run()).then(done, failed),
      };
      return q;
    };
    return { from };
  },
}));

import { GET, POST } from '../app/api/admin/books/changed-in-netsuite/route';

const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const OPEN = 'd0000000-0000-4000-8000-000000000001';
const DONE = 'd0000000-0000-4000-8000-000000000002';

const row = (over: Record<string, any> = {}) => ({
  id: OPEN, kind: 'customer', netsuite_id: '2001', name: 'Acme Fleet Services', field: 'email',
  fleetsuite_value: 'billing@acmefleet.example', netsuite_value: 'ap@acmefleet.example', status: 'open',
  first_seen_at: '2027-01-06T16:00:00.000Z', last_seen_at: '2027-01-06T18:00:00.000Z',
  sent_to_netsuite: null, closed_at: null, closed_by: null, ...over,
});

const post = (body: unknown) => new NextRequest('http://localhost/api/admin/books/changed-in-netsuite', {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});
const get = () => new NextRequest('http://localhost/api/admin/books/changed-in-netsuite');

beforeEach(() => {
  h.superAdmin = true;
  h.failing = new Set();
  h.audits = [];
  h.updateCustomer.mockReset();
  h.patchEntityRecord.mockReset();
  h.tables = {
    books_switches: [{ piece: 'fleetsuite_records', is_on: true }],
    record_differences: [
      row(),
      row({ id: DONE, kind: 'vendor', netsuite_id: '3001', name: 'Fellers', field: 'phone', status: 'kept', sent_to_netsuite: true,
        closed_at: '2027-01-05T15:00:00.000Z', closed_by: CRAIG, fleetsuite_value: '314-555-0199', netsuite_value: null }),
    ],
    profiles: [{ id: CRAIG, full_name: 'Craig' }],
    prospects: [{ netsuite_id: '2001', company_name: 'Acme Fleet Services', email: 'billing@acmefleet.example', phone: null, address: null, address2: null, city: null, state: null, zip: null }],
    customers: [{ netsuite_id: '2001', email: 'billing@acmefleet.example' }],
  };
  vi.stubEnv('NETSUITE_ACCOUNT_ID', '1234567-sb1');
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('GET', () => {
  it('tells the page whether it’s on, what’s open and what was done, by name and with the link to NetSuite', async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.on).toBe(true);
    expect(json.more).toBe(false);
    expect(json.open).toEqual([expect.objectContaining({
      id: OPEN, kindName: 'Customer', name: 'Acme Fleet Services', fieldName: 'Email', fleetsuite: 'billing@acmefleet.example',
      netsuite: 'ap@acmefleet.example', status: 'open', link: 'https://1234567_SB1.app.netsuite.com/app/common/entity/custjob.nl?id=2001',
    })]);
    expect(json.closed).toEqual([expect.objectContaining({
      id: DONE, kindName: 'Vendor', fieldName: 'Phone', netsuite: '(none)', status: 'kept', sent: true, closedBy: 'Craig',
      link: 'https://1234567_SB1.app.netsuite.com/app/common/entity/vendor.nl?id=3001',
    })]);
  });

  it('says when there are more open than it shows', async () => {
    h.tables.record_differences = Array.from({ length: 201 }, (_, i) => row({ id: `d0000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    const json = await (await GET(get())).json();
    expect(json.open).toHaveLength(200);
    expect(json.more).toBe(true);
  });

  it('says so while it’s off, and still shows the list', async () => {
    h.tables.books_switches[0].is_on = false;
    const json = await (await GET(get())).json();
    expect(json.on).toBe(false);
    expect(json.open).toHaveLength(1);
  });

  it('is for super admins only', async () => {
    h.superAdmin = false;
    expect((await GET(get())).status).toBe(403);
    expect((await POST(post({ id: OPEN, act: 'take' }))).status).toBe(403);
    expect(h.tables.record_differences[0].status).toBe('open');
  });

  it("says why when the list can't be read", async () => {
    h.failing.add('record_differences');
    const res = await GET(get());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Couldn't read what NetSuite has instead: record_differences said no");
  });
});

describe('POST', () => {
  it("takes NetSuite's and audits who did it, with what each side had", async () => {
    const res = await POST(post({ id: OPEN, act: 'take' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: OPEN, status: 'taken' });
    expect(h.tables.prospects[0].email).toBe('ap@acmefleet.example');
    expect(h.audits).toEqual([{
      actorId: CRAIG, table: 'record_differences', recordId: OPEN, action: 'take_netsuite_record',
      detail: { kind: 'customer', netsuite_id: '2001', name: 'Acme Fleet Services', field: 'email', outcome: 'taken',
        fleetsuite: 'billing@acmefleet.example', netsuite: 'ap@acmefleet.example' },
    }]);
  });

  it("keeps FleetSuite's by sending it to NetSuite, audited as kept", async () => {
    h.updateCustomer.mockResolvedValue({ success: true });
    expect(await (await POST(post({ id: OPEN, act: 'keep' }))).json()).toEqual({ id: OPEN, status: 'kept' });
    expect(h.updateCustomer).toHaveBeenCalledWith('2001', { email: 'billing@acmefleet.example' });
    expect(h.audits[0]).toMatchObject({ action: 'keep_fleetsuite_record', detail: { outcome: 'kept' } });
  });

  it('refuses while FleetSuite’s record wins is off, changing nothing', async () => {
    h.tables.books_switches[0].is_on = false;
    const res = await POST(post({ id: OPEN, act: 'keep' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("FleetSuite's record wins is switched off, so NetSuite's changes come into FleetSuite as they do now. Nothing was changed.");
    expect(h.tables.record_differences[0].status).toBe('open');
    expect(h.updateCustomer).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
  });

  it('passes on why the lib said no, without auditing', async () => {
    h.updateCustomer.mockResolvedValue({ success: false, error: 'Invalid email address' });
    const res = await POST(post({ id: OPEN, act: 'keep' }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("NetSuite didn't take it: Invalid email address. Nothing changed.");
    const done = await POST(post({ id: DONE, act: 'take' }));
    expect(done.status).toBe(409);
    expect(h.audits).toEqual([]);
  });

  it('turns away a body that isn’t one of the list and a press', async () => {
    expect((await POST(post({ id: 'not-an-id', act: 'keep' }))).status).toBe(400);
    expect((await POST(post({ id: OPEN, act: 'both' }))).status).toBe(400);
    expect((await POST(post({ id: OPEN }))).status).toBe(400);
    expect(h.tables.record_differences[0].status).toBe('open');
  });

  it("says why when the difference can't be read", async () => {
    h.failing.add('record_differences');
    const res = await POST(post({ id: OPEN, act: 'take' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Couldn't read the difference: record_differences said no");
  });
});
