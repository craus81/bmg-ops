// /api/customer-terms and /api/vendor-details (src/lib/customer-terms.ts, src/lib/vendor-details.ts): who can open
// them while customer and vendor details are switched off and once they're on, finding a customer or a vendor, what
// each screen is told, and what one press of Save does: the change worked out again from the record as NetSuite has it
// now, nothing sent when the record changed since the page read it, sent to NetSuite once however often it's pressed,
// one change of a record at a time, NetSuite's refusal and an answer that never came told apart, new terms noted in
// the copy of NetSuite's lists, and a vendor's tax ID sent to NetSuite and kept nowhere. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// The routes make their service client when they load, so what the mocks hand them is made first.
const h = vi.hoisted(() => {
  const USER = 'p0000000-0000-4000-8000-000000000001';
  const state = {
    roles: ['admin'] as string[],
    features: new Set<string>(['credit_applications', 'vendor_payments']),
    seesMoney: true,
    tables: {} as Record<string, Record<string, any>[]>,
    calls: [] as Array<[string, Record<string, any>]>,
    /** Tables and functions that answer with an error. */
    failing: new Set<string>(),
    /** NetSuite's customers and vendors, by 'customer:4410'. */
    records: {} as Record<string, Record<string, any>>,
  };
  const netsuite = {
    getEntityRecord: vi.fn(),
    patchEntityRecord: vi.fn(),
    isSuiteqlError: vi.fn(() => false),
    suiteqlQueryAll: vi.fn(),
  };

  const likeToRegex = (pattern: string) => new RegExp(`^${pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.')).join('.*')}$`, 'i');
  // An in-memory stand-in for the tables the routes read.
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
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return builder; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return builder; },
      ilike: (c: string, pattern: string) => { filters.push((r) => likeToRegex(pattern).test(String(r[c] ?? ''))); return builder; },
      order: (c: string, o: { ascending?: boolean } = {}) => { sorts.push([c, o.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }
  // What migration 473's functions, and the lists' apply, do, in memory.
  const changes = () => (state.tables.detail_changes ??= []);
  const rpcs: Record<string, (p: Record<string, any>) => unknown> = {
    detail_change_claim: (p) => {
      const mine = changes().find((r) => r.id === p.id);
      if (mine && (mine.record_type !== p.record_type || mine.netsuite_id !== p.netsuite_id)) {
        throw new Error(`detail changes: ${p.id} is a change of another record`);
      }
      if (mine && (mine.status === 'changed' || mine.status === 'sending')) return { claimed: false, state: mine.status };
      if (changes().some((r) => r.record_type === p.record_type && r.netsuite_id === p.netsuite_id && r.status === 'sending')) {
        return { claimed: false, state: 'busy' };
      }
      const row = {
        id: p.id, record_type: p.record_type, netsuite_id: p.netsuite_id, name: p.name, reason: p.reason, changes: p.changes, patch: p.patch,
        status: 'sending', error: null, created_by: p.by, created_at: '2026-12-02T15:00:00Z',
      };
      if (mine) Object.assign(mine, row); else changes().push(row);
      return { claimed: true };
    },
    detail_change_finish: (p) => {
      const mine = changes().find((r) => r.id === p.id && r.status === 'sending');
      if (mine) Object.assign(mine, { status: p.status, error: p.error ?? null });
      return { finished: !!mine };
    },
    gl_netsuite_lists_apply: (p) => {
      for (const row of p.rows) {
        const have = (state.tables.gl_netsuite_lists ?? []).find((r) => r.kind === p.kind && r.netsuite_id === row.netsuite_id);
        if (have) Object.assign(have, row);
      }
      return { changed: p.rows.length };
    },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: { p: Record<string, any> }) => {
      state.calls.push([fn, args.p]);
      if (state.failing.has(fn)) return { data: null, error: { message: `${fn} didn't answer` } };
      try {
        return { data: rpcs[fn](args.p), error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
  return { USER, state, netsuite, service, rpcs };
});

vi.mock('@/lib/api-auth', () => ({
  requireFeature: vi.fn(async (_req: unknown, feature: string) => (h.state.features.has(feature)
    ? { user: { id: h.USER }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
  profileCanSeeMoney: vi.fn(async () => h.state.seesMoney),
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));

const { USER, state, netsuite } = h;

import * as customerRoute from '../app/api/customer-terms/route';
import * as vendorRoute from '../app/api/vendor-details/route';
import { requireFeature } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';

/** Harbor Fleet Services: Due on receipt, no credit limit, $1,234.50 owed. */
const CUSTOMER = {
  id: '4410', entityId: 'C-4410 Harbor Fleet', companyName: 'Harbor Fleet Services', isInactive: false,
  terms: { id: '1', refName: 'Due on receipt' }, creditLimit: null, balance: 1234.5,
};
/** Ridge Supply Co: Net 30, no 1099, a tax ID ending 1111, two addresses, the first its billing one. */
const VENDOR = {
  id: '2207', entityId: 'V-2207 Ridge Supply', companyName: 'Ridge Supply Co', isPerson: false, isInactive: false,
  email: 'ap@ridge.example', phone: '(555) 010-0100', terms: { id: '2', refName: 'Net 30' },
  is1099Eligible: false, legalName: '', taxIdNum: '98-7651111',
  addressBook: {
    items: [
      {
        id: '11', defaultBilling: true, defaultShipping: true, label: '1 Main St',
        addressBookAddress: { addressee: 'Ridge Supply Co', addr1: '1 Main St', city: 'Springfield', state: 'MO', zip: '65801', country: { id: 'US' } },
      },
      {
        id: '12', defaultBilling: false, defaultShipping: false, label: 'Warehouse',
        addressBookAddress: { addressee: 'Ridge Supply Co', attention: 'Receiving', addr1: '9 Dock Rd', city: 'Springfield', state: 'MO', zip: '65802', country: { id: 'US' } },
      },
    ],
  },
};
const TERM_ROWS = [
  { kind: 'term', netsuite_id: '2', name: 'Net 30', active: true, gone_at: null },
  { kind: 'term', netsuite_id: '1', name: 'Due on receipt', active: true, gone_at: null },
  { kind: 'term', netsuite_id: '3', name: 'Net 45', active: true, gone_at: null },
  { kind: 'term', netsuite_id: '4', name: 'Net 10', active: false, gone_at: null },
  { kind: 'term', netsuite_id: '5', name: 'Net 60', active: true, gone_at: '2026-11-01T00:00:00Z' },
];
const TERMS_SHOWN = [{ id: '1', name: 'Due on receipt' }, { id: '2', name: 'Net 30' }, { id: '3', name: 'Net 45' }];
const listRow = (kind: string, id: string, name: string, over: Record<string, unknown> = {}) => ({
  kind, netsuite_id: id, name, parent_netsuite_id: null, active: true, gone_at: null, details: { entity_id: `${kind[0].toUpperCase()}-${id}` }, ...over,
});
const REQUEST = 'd0000000-0000-4000-8000-000000000001';
const OFF = 'Changing customer and vendor details is switched off until January 1, 2027.';

const request = (path: string, body?: Record<string, unknown>) => new NextRequest(`https://app.test${path}`, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const customers = {
  get: (query: string) => customerRoute.GET(request(`/api/customer-terms?${query}`)),
  post: (body: Record<string, unknown>) => customerRoute.POST(request('/api/customer-terms', body)),
};
const vendors = {
  get: (query: string) => vendorRoute.GET(request(`/api/vendor-details?${query}`)),
  post: (body: Record<string, unknown>) => vendorRoute.POST(request('/api/vendor-details', body)),
};
const customerSignature = async () => (await (await customers.get('customer=4410')).json()).signature as string;
const vendorSignature = async () => (await (await vendors.get('vendor=2207')).json()).signature as string;
/** Approved at Net 30 with a $25,000.00 limit. */
const APPROVED = async () => ({
  requestId: REQUEST, customerId: '4410', signature: await customerSignature(), reason: 'Credit application approved', termsId: '2', creditLimit: 25000,
});
/** A new W-9: it gets a 1099, under its legal name and tax ID. */
const W9 = async () => ({
  requestId: REQUEST, vendorId: '2207', signature: await vendorSignature(), reason: 'New W-9', is1099: true, legalName: 'Ridge Supply LLC', taxId: '12-3456789',
});

const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'customer_vendor_details', is_on: on }, { piece: 'bill_fixes', is_on: !on }]; };

beforeEach(() => {
  state.roles = ['admin'];
  state.features = new Set(['credit_applications', 'vendor_payments']);
  state.seesMoney = true;
  state.records = { 'customer:4410': structuredClone(CUSTOMER), 'vendor:2207': structuredClone(VENDOR) };
  state.tables = {
    gl_netsuite_lists: [
      ...TERM_ROWS.map((r) => ({ ...r })),
      listRow('customer', '4410', 'Harbor Fleet Services', { details: { entity_id: 'C-4410 Harbor Fleet', terms_id: '1' } }),
      listRow('vendor', '2207', 'Ridge Supply Co', { details: { entity_id: 'V-2207 Ridge Supply', terms_id: '2' } }),
    ],
    profiles: [{ id: USER, full_name: 'Sam Example' }],
  };
  switchOn(false);
  state.calls.length = 0;
  state.failing = new Set();
  vi.clearAllMocks();
  netsuite.getEntityRecord.mockImplementation(async (record: string, id: string) => {
    const rec = state.records[`${record}:${id}`];
    return rec ? { success: true, record: structuredClone(rec) } : { success: false, error: 'NetSuite error (404): The record instance does not exist.', notFound: true };
  });
  // NetSuite takes the change: the record reads back with it.
  netsuite.patchEntityRecord.mockImplementation(async (record: string, id: string, body: Record<string, any>) => {
    const rec = state.records[`${record}:${id}`];
    const { terms, ...rest } = body;
    Object.assign(rec, rest, terms ? { terms: { id: terms.id, refName: TERM_ROWS.find((t) => t.netsuite_id === terms.id)?.name } } : {});
    return { success: true };
  });
});

afterEach(() => vi.restoreAllMocks());

describe('while customer and vendor details are switched off', () => {
  it('shows Customer Terms and Vendor Details to super admins only, and never to someone who can\'t see prices', async () => {
    for (const route of [customers, vendors]) {
      expect(await (await route.get('status=1')).json()).toEqual({ on: false, canUse: false });
      state.roles = ['super_admin'];
      expect(await (await route.get('status=1')).json()).toEqual({ on: false, canUse: true });
      state.seesMoney = false;
      expect(await (await route.get('status=1')).json()).toEqual({ on: false, canUse: false });
      state.roles = ['admin'];
      state.seesMoney = true;
    }
    expect(requireFeature).toHaveBeenCalledWith(expect.anything(), 'credit_applications');
    expect(requireFeature).toHaveBeenCalledWith(expect.anything(), 'vendor_payments');
    state.features = new Set(['vendor_payments']);
    expect((await customers.get('status=1')).status).toBe(403);
    expect((await vendors.get('status=1')).status).toBe(200);
    state.features = new Set(['credit_applications']);
    expect((await vendors.get('status=1')).status).toBe(403);
  });

  it('lets a super admin see what a change would send, and nobody else', async () => {
    const refused = await customers.get('customer=4410');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: OFF, switchedOff: true });
    expect((await customers.get('find=harbor')).status).toBe(403);
    expect(await (await vendors.get('vendor=2207')).json()).toEqual({ error: OFF, switchedOff: true });
    expect(netsuite.getEntityRecord).not.toHaveBeenCalled();

    state.roles = ['super_admin'];
    const res = await customers.get('customer=4410');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      customer: {
        id: '4410', name: 'Harbor Fleet Services', entityId: 'C-4410 Harbor Fleet', inactive: false,
        termsId: '1', termsName: 'Due on receipt', creditLimitCents: null, balanceCents: 123450,
      },
      terms: TERMS_SHOWN,
      signature: expect.stringMatching(/^[0-9a-f]{32}$/),
      changes: [],
      switchedOn: false,
      offText: `${OFF} You can see what a change would send; nothing goes to NetSuite.`,
    });
    expect(netsuite.getEntityRecord).toHaveBeenCalledWith('customer', '4410');
    expect(await (await vendors.get('vendor=2207')).json()).toMatchObject({
      vendor: { id: '2207', name: 'Ridge Supply Co', taxIdEnding: '1111' }, terms: TERMS_SHOWN, switchedOn: false,
    });
    expect(netsuite.getEntityRecord).toHaveBeenCalledWith('vendor', '2207');

    state.seesMoney = false;
    for (const hidden of [await customers.get('customer=4410'), await vendors.get('vendor=2207')]) {
      expect(hidden.status).toBe(403);
      expect(await hidden.json()).toEqual({ error: 'Forbidden: this account cannot see billing' });
    }
    state.seesMoney = true;
    state.features = new Set();
    expect((await customers.get('customer=4410')).status).toBe(403);
    expect((await vendors.post({ requestId: REQUEST })).status).toBe(403);
  });

  it('sends nothing to NetSuite, even for a super admin', async () => {
    state.roles = ['super_admin'];
    const customer = await customers.post(await APPROVED());
    expect(customer.status).toBe(403);
    expect(await customer.json()).toEqual({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true });
    const vendor = await vendors.post(await W9());
    expect(vendor.status).toBe(403);
    expect(await vendor.json()).toEqual({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true });
    expect(netsuite.patchEntityRecord).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });
});

describe('once customer and vendor details are switched on', () => {
  beforeEach(() => switchOn(true));

  it('lets anyone with the permission who sees prices use them', async () => {
    expect(await (await customers.get('status=1')).json()).toEqual({ on: true, canUse: true });
    expect(await (await vendors.get('status=1')).json()).toEqual({ on: true, canUse: true });
    state.roles = ['office'];
    expect(await (await customers.get('customer=4410')).json()).toMatchObject({ switchedOn: true, offText: null });
    expect((await vendors.get('vendor=2207')).status).toBe(200);
    // Each takes its own permission: Customer Terms the credit applications', Vendor Details Payments'.
    state.features = new Set(['credit_applications']);
    expect((await customers.get('customer=4410')).status).toBe(200);
    expect((await vendors.get('vendor=2207')).status).toBe(403);
    state.features = new Set(['vendor_payments']);
    expect((await customers.get('customer=4410')).status).toBe(403);
    expect((await vendors.get('vendor=2207')).status).toBe(200);
    state.seesMoney = false;
    expect(await (await vendors.get('status=1')).json()).toEqual({ on: true, canUse: false });
    expect((await customers.post({ requestId: REQUEST })).status).toBe(403);
    expect(netsuite.patchEntityRecord).not.toHaveBeenCalled();
  });

  it("says when NetSuite has no such record, or couldn't be read", async () => {
    for (const [route, query, name] of [[customers, 'customer', 'customer'], [vendors, 'vendor', 'vendor']] as const) {
      const bad = await route.get(`${query}=44x0`);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: `Bad ${name} id` });
      expect((await route.get('')).status).toBe(400);
      const missing = await route.get(`${query}=9999`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: `NetSuite has no ${name} with id 9999.` });
    }
    netsuite.getEntityRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite took too long to answer' });
    const slow = await customers.get('customer=4410');
    expect(slow.status).toBe(502);
    expect(await slow.json()).toEqual({ error: 'NetSuite took too long to answer' });
    const form = await W9();
    netsuite.getEntityRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite took too long to answer' });
    expect((await vendors.post(form)).status).toBe(502);
    expect(netsuite.patchEntityRecord).not.toHaveBeenCalled();
  });

  it("finds customers and vendors in the copy of NetSuite's lists by name, active ones first", async () => {
    state.tables.gl_netsuite_lists.push(
      listRow('customer', '4411', 'Anchor Harbor Freight', { active: false }),
      listRow('customer', '4412', 'Bay Harbor Rentals', { details: null }),
      listRow('customer', '4413', 'Harbor Fleet Old', { gone_at: '2026-11-01T00:00:00Z' }),
      listRow('vendor', '2208', 'Harbor Fleet Services'),
      listRow('vendor', '2209', 'Anchor Harbor Supply', { active: false }),
    );
    const found = async (typed: string) => (await (await customers.get(`find=${encodeURIComponent(typed)}`)).json()).customers;
    expect(await found('harbor')).toEqual([
      { id: '4412', name: 'Bay Harbor Rentals', entityId: null, active: true },
      { id: '4410', name: 'Harbor Fleet Services', entityId: 'C-4410 Harbor Fleet', active: true },
      { id: '4411', name: 'Anchor Harbor Freight', entityId: 'C-4411', active: false },
    ]);
    const ids = async (typed: string) => ((await found(typed)) as Array<{ id: string }>).map((c) => c.id);
    expect(await ids('harbor fleet')).toEqual(['4410']);
    expect(await ids('harbor services')).toEqual(['4410']);
    expect(await ids('fleet harbor')).toEqual([]);
    expect(await ids('HARBOR, F')).toEqual(['4410', '4411']);
    expect(await ids('')).toEqual(['4412', '4410', '4411']);
    expect(await ids('%')).toEqual(['4412', '4410', '4411']);
    expect((await (await vendors.get('find=harbor')).json()).vendors).toEqual([
      { id: '2208', name: 'Harbor Fleet Services', entityId: 'V-2208', active: true },
      { id: '2209', name: 'Anchor Harbor Supply', entityId: 'V-2209', active: false },
    ]);

    for (const kind of ['customer', 'vendor']) {
      state.tables.gl_netsuite_lists.push(...Array.from({ length: 20 }, (_, i) => listRow(kind, String(3000 + i), `Acme ${String(i).padStart(2, '0')}`)));
    }
    for (const many of [(await (await customers.get('find=acme')).json()).customers, (await (await vendors.get('find=acme')).json()).vendors]) {
      expect(many).toHaveLength(15);
      expect(many[0].name).toBe('Acme 00');
    }

    state.failing = new Set(['gl_netsuite_lists']);
    const unread = await customers.get('find=harbor');
    expect(unread.status).toBe(500);
    expect(await unread.json()).toEqual({ error: "couldn't search the copy of NetSuite's customers (gl_netsuite_lists can't be read)" });
    expect(await (await vendors.get('find=acme')).json()).toEqual({ error: "couldn't search the copy of NetSuite's vendors (gl_netsuite_lists can't be read)" });
    expect(await (await vendors.get('vendor=2207')).json()).toEqual({ error: "couldn't read NetSuite's terms (gl_netsuite_lists can't be read)" });
  });

  it("changes the customer's terms and credit limit in NetSuite once, notes the terms in the copy, and lists the change", async () => {
    const form = { ...(await APPROVED()), reason: '  Credit application approved ' };
    const res = await customers.post(form);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, changes: ['Terms Due on receipt → Net 30', 'Credit limit no limit → $25,000.00'] });
    expect(netsuite.patchEntityRecord).toHaveBeenCalledWith('customer', '4410', { terms: { id: '2' }, creditLimit: 25000 });
    expect(state.calls).toEqual([
      ['detail_change_claim', {
        id: REQUEST, record_type: 'customer', netsuite_id: '4410', name: 'Harbor Fleet Services', reason: 'Credit application approved',
        changes: ['Terms Due on receipt → Net 30', 'Credit limit no limit → $25,000.00'], patch: { terms: { id: '2' }, creditLimit: 25000 }, by: USER,
      }],
      ['detail_change_finish', { id: REQUEST, status: 'changed' }],
      ['gl_netsuite_lists_apply', {
        kind: 'customer',
        rows: [{
          netsuite_id: '4410', name: 'Harbor Fleet Services', parent_netsuite_id: null, active: true,
          details: { entity_id: 'C-4410 Harbor Fleet', terms_id: '2' },
        }],
      }],
    ]);
    expect(state.tables.gl_netsuite_lists.find((r) => r.netsuite_id === '4410')?.details).toEqual({ entity_id: 'C-4410 Harbor Fleet', terms_id: '2' });
    expect(state.tables.detail_changes).toEqual([expect.objectContaining({ id: REQUEST, status: 'changed', error: null })]);
    expect(logAudit).toHaveBeenCalledWith(h.service, {
      actorId: USER, table: 'detail_changes', recordId: REQUEST, action: 'change_customer',
      detail: {
        netsuite_customer_id: '4410', customer: 'Harbor Fleet Services',
        changes: ['Terms Due on receipt → Net 30', 'Credit limit no limit → $25,000.00'], sent: { terms: { id: '2' }, creditLimit: 25000 },
      },
    });

    // The same form pressed again: NetSuite's customer changed since that page read it, so nothing goes.
    const again = await customers.post(form);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: 'Harbor Fleet Services changed in NetSuite since this page opened. Nothing was sent. Reload it and make the change again.', stale: true,
    });
    const redone = await customers.post(await APPROVED());
    expect(redone.status).toBe(400);
    expect(await redone.json()).toEqual({ error: 'Nothing has changed yet.', problems: ['Nothing has changed yet.'] });
    expect(netsuite.patchEntityRecord).toHaveBeenCalledTimes(1);

    expect((await (await customers.get('customer=4410')).json()).changes).toEqual([{
      id: REQUEST, at: '2026-12-02T15:00:00Z', by: 'Sam Example', reason: 'Credit application approved',
      changes: ['Terms Due on receipt → Net 30', 'Credit limit no limit → $25,000.00'], status: 'changed', error: null,
    }]);
  });

  it('takes a credit limit off, and notes nothing in the copy when the terms stay', async () => {
    state.records['customer:4410'].creditLimit = 25000;
    const res = await customers.post({ requestId: REQUEST, customerId: '4410', signature: await customerSignature(), reason: 'Closed account', creditLimit: null });
    expect(res.status).toBe(200);
    expect((await res.json()).changes).toEqual(['Credit limit $25,000.00 → no limit']);
    expect(netsuite.patchEntityRecord).toHaveBeenCalledWith('customer', '4410', { creditLimit: null });
    expect(state.calls.map(([fn]) => fn)).toEqual(['detail_change_claim', 'detail_change_finish']);
  });

  it("finishes the change when the copy of NetSuite's lists can't take the terms, or has no row for the record", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.failing = new Set(['gl_netsuite_lists_apply']);
    const res = await customers.post(await APPROVED());
    expect(res.status).toBe(200);
    expect(state.tables.detail_changes[0]).toMatchObject({ status: 'changed' });
    expect(error).toHaveBeenCalledWith("[customer terms] couldn't note 4410's new terms in the copy of NetSuite's customers: gl_netsuite_lists_apply didn't answer");
    expect(logAudit).toHaveBeenCalledTimes(1);

    state.failing = new Set();
    state.tables.gl_netsuite_lists = state.tables.gl_netsuite_lists.filter((r) => r.kind !== 'vendor');
    state.calls.length = 0;
    expect((await vendors.post({ requestId: 'd0000000-0000-4000-8000-000000000002', vendorId: '2207', signature: await vendorSignature(), reason: 'New terms agreed', termsId: '3' })).status).toBe(200);
    expect(state.calls.map(([fn]) => fn)).toEqual(['detail_change_claim', 'detail_change_finish']);

    // Marking it changed failing is said in the log; the change is in NetSuite either way.
    state.failing = new Set(['detail_change_finish']);
    state.records['customer:4410'].creditLimit = 5000;
    const marked = await customers.post({ requestId: 'd0000000-0000-4000-8000-000000000003', customerId: '4410', signature: await customerSignature(), reason: 'Raised', creditLimit: 6000 });
    expect(marked.status).toBe(200);
    expect(error).toHaveBeenCalledWith("[customer terms] d0000000-0000-4000-8000-000000000003 went in but wasn't marked changed: detail_change_finish didn't answer");
  });

  it("sends nothing when the record changed since the page opened, the change has a problem, or the form isn't one", async () => {
    const stale = await customers.post({ ...(await APPROVED()), signature: 'not-what-netsuite-has-now' });
    expect(stale.status).toBe(409);
    expect((await stale.json()).stale).toBe(true);
    const staleVendor = await vendors.post({ ...(await W9()), signature: 'not-what-netsuite-has-now' });
    expect(await staleVendor.json()).toEqual({
      error: 'Ridge Supply Co changed in NetSuite since this page opened. Nothing was sent. Reload it and make the change again.', stale: true,
    });
    const unsaid = await customers.post({ ...(await APPROVED()), reason: ' ' });
    expect(unsaid.status).toBe(400);
    expect(await unsaid.json()).toEqual({ error: "Say why it's being changed.", problems: ["Say why it's being changed."] });
    const twoProblems = await vendors.post({ ...(await W9()), reason: '', taxId: '12-34' });
    expect(await twoProblems.json()).toEqual({
      error: "A tax ID is nine digits, as 12-3456789 or 123-45-6789. Say why it's being changed.",
      problems: ['A tax ID is nine digits, as 12-3456789 or 123-45-6789.', "Say why it's being changed."],
    });
    expect((await customers.post({ ...(await APPROVED()), termsId: '4' })).status).toBe(400);
    for (const body of [{ requestId: 'not-a-uuid' }, { customerId: '44x0' }, { termsId: 'net30' }, { creditLimit: '25000' }]) {
      const res = await customers.post({ ...(await APPROVED()), ...body });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Invalid request');
    }
    for (const body of [{ vendorId: '' }, { taxId: '1'.repeat(41) }, { is1099: 'yes' }, { addresses: [{ lineId: 'x' }] }, { billingLineId: 'first' }]) {
      const res = await vendors.post({ ...(await W9()), ...body });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Invalid request');
    }
    expect(netsuite.patchEntityRecord).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it("says what couldn't be read, and sends nothing", async () => {
    const form = await APPROVED();
    state.failing = new Set(['detail_changes']);
    const listed = await customers.get('customer=4410');
    expect(listed.status).toBe(500);
    expect(await listed.json()).toEqual({ error: "detail_changes can't be read" });
    state.failing = new Set(['detail_change_claim']);
    const claim = await customers.post(form);
    expect(claim.status).toBe(500);
    expect(await claim.json()).toEqual({ error: "detail_change_claim didn't answer" });
    state.failing = new Set(['gl_netsuite_lists']);
    expect(await (await customers.post(form)).json()).toEqual({ error: "couldn't read NetSuite's terms (gl_netsuite_lists can't be read)" });
    state.failing = new Set();
    netsuite.getEntityRecord.mockResolvedValueOnce({ success: false, error: 'gone', notFound: true });
    const gone = await customers.post(form);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'NetSuite has no customer with id 4410.' });
    expect(netsuite.patchEntityRecord).not.toHaveBeenCalled();
  });

  it("says what an earlier press did, and doesn't send it twice", async () => {
    // NetSuite not showing the change yet, the same form pressed again is the same change.
    netsuite.patchEntityRecord.mockResolvedValue({ success: true });
    const form = await APPROVED();
    expect((await customers.post(form)).status).toBe(200);
    const same = await customers.post(form);
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ success: true, already: true, changes: ['Terms Due on receipt → Net 30', 'Credit limit no limit → $25,000.00'] });
    const vendorForm = { ...(await W9()), requestId: 'd0000000-0000-4000-8000-000000000002' };
    expect((await vendors.post(vendorForm)).status).toBe(200);
    expect(await (await vendors.post(vendorForm)).json()).toMatchObject({ success: true, already: true });
    expect(netsuite.patchEntityRecord).toHaveBeenCalledTimes(2);
    expect(logAudit).toHaveBeenCalledTimes(2);
  });

  it('sends one change of a record at a time', async () => {
    state.tables.detail_changes = [{ id: 'd0000000-0000-4000-8000-000000000009', record_type: 'customer', netsuite_id: '4410', status: 'sending' }];
    const busy = await customers.post(await APPROVED());
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'Another change of Harbor Fleet Services is being sent now. Reload it in a minute and check it before changing it again.' });
    // The vendor of the same id is another record.
    state.tables.detail_changes[0].record_type = 'vendor';
    state.tables.detail_changes[0].netsuite_id = '2207';
    expect(await (await vendors.post(await W9())).json()).toEqual({
      error: 'Another change of Ridge Supply Co is being sent now. Reload it in a minute and check it before changing it again.',
    });
    state.tables.detail_changes = [{ id: REQUEST, record_type: 'customer', netsuite_id: '4410', status: 'sending' }];
    const pressed = await customers.post(await APPROVED());
    expect(pressed.status).toBe(409);
    expect(await pressed.json()).toEqual({ error: "This change is being sent now. Don't press again: reload the customer in a minute to see it." });
    state.tables.detail_changes = [{ id: REQUEST, record_type: 'vendor', netsuite_id: '2207', status: 'sending' }];
    expect(await (await vendors.post(await W9())).json()).toEqual({ error: "This change is being sent now. Don't press again: reload the vendor in a minute to see it." });
    // A claim that doesn't say it was taken sends nothing.
    state.tables.detail_changes = [];
    vi.spyOn(h.rpcs, 'detail_change_claim').mockReturnValue(null);
    expect(await (await customers.post(await APPROVED())).json()).toEqual({
      error: 'Another change of Harbor Fleet Services is being sent now. Reload it in a minute and check it before changing it again.',
    });
    expect(await (await vendors.post(await W9())).json()).toEqual({
      error: 'Another change of Ridge Supply Co is being sent now. Reload it in a minute and check it before changing it again.',
    });
    expect(netsuite.patchEntityRecord).not.toHaveBeenCalled();
  });

  it("lets the same form try again when NetSuite refused, and says when it can't tell whether the change went in", async () => {
    netsuite.patchEntityRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): Invalid value for terms. ' });
    const refused = await customers.post(await APPROVED());
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "NetSuite didn't take the change: NetSuite error (400): Invalid value for terms. Nothing changed." });
    expect(state.tables.detail_changes[0]).toMatchObject({ status: 'refused', error: 'NetSuite error (400): Invalid value for terms. ' });
    expect(state.calls[1]).toEqual(['detail_change_finish', { id: REQUEST, status: 'refused', error: 'NetSuite error (400): Invalid value for terms. ' }]);
    expect(logAudit).not.toHaveBeenCalled();

    netsuite.patchEntityRecord.mockResolvedValueOnce({ success: false });
    expect(await (await customers.post(await APPROVED())).json()).toEqual({ error: "NetSuite didn't take the change: NetSuite didn't answer. Nothing changed." });

    netsuite.patchEntityRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite took too long to answer', unsure: true });
    const unsure = await customers.post(await APPROVED());
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({
      error: "NetSuite took too long to answer, so FleetSuite can't tell whether the change went in. Reload the customer: if the change is there, it went in; if it isn't, make it again.",
      unsure: true,
    });
    expect(state.tables.detail_changes[0]).toMatchObject({ status: 'unsure' });

    const retried = await customers.post(await APPROVED());
    expect(retried.status).toBe(200);
    expect(state.tables.detail_changes).toHaveLength(1);
    expect(state.tables.detail_changes[0]).toMatchObject({ status: 'changed', error: null });
    expect(netsuite.patchEntityRecord).toHaveBeenCalledTimes(4);

    // A press of one record's form can't stand for another's.
    const borrowed = await vendors.post(await W9());
    expect(borrowed.status).toBe(500);
    expect(await borrowed.json()).toEqual({ error: `detail changes: ${REQUEST} is a change of another record` });

    netsuite.patchEntityRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite error (500): Unexpected error.', unsure: true });
    expect(await (await vendors.post({ ...(await W9()), requestId: 'd0000000-0000-4000-8000-000000000002' })).json()).toEqual({
      error: "NetSuite error (500): Unexpected error, so FleetSuite can't tell whether the change went in. Reload the vendor: if the change is there, it went in; if it isn't, make it again.",
      unsure: true,
    });
  });

  it("sends the vendor's tax ID to NetSuite and keeps it nowhere", async () => {
    const res = await vendors.post(await W9());
    expect(res.status).toBe(200);
    const changes = ['Gets a 1099: no → yes', 'Legal name (none) → Ridge Supply LLC', 'Tax ID ending 1111 → one ending 6789'];
    expect(await res.json()).toEqual({ success: true, changes });
    expect(netsuite.patchEntityRecord).toHaveBeenCalledWith('vendor', '2207', { is1099Eligible: true, legalName: 'Ridge Supply LLC', taxIdNum: '12-3456789' });
    const kept = { is1099Eligible: true, legalName: 'Ridge Supply LLC', taxIdNum: '(ending 6789)' };
    expect(state.calls[0]).toEqual(['detail_change_claim', {
      id: REQUEST, record_type: 'vendor', netsuite_id: '2207', name: 'Ridge Supply Co', reason: 'New W-9', changes, patch: kept, by: USER,
    }]);
    expect(logAudit).toHaveBeenCalledWith(h.service, {
      actorId: USER, table: 'detail_changes', recordId: REQUEST, action: 'change_vendor',
      detail: { netsuite_vendor_id: '2207', vendor: 'Ridge Supply Co', changes, sent: kept },
    });
    // NetSuite has it whole now; the screen is told its last four digits.
    expect(state.records['vendor:2207'].taxIdNum).toBe('12-3456789');
    const shown = await vendors.get('vendor=2207');
    const text = await shown.text();
    expect(JSON.parse(text).vendor).toMatchObject({ hasTaxId: true, taxIdEnding: '6789', is1099: true, legalName: 'Ridge Supply LLC' });
    const everything = JSON.stringify([state.tables, state.calls, vi.mocked(logAudit).mock.calls, text]);
    expect(everything).not.toMatch(/3456789|98-?765/);
  });

  it("keeps NetSuite's words about a tax ID it refused without the tax ID", async () => {
    netsuite.patchEntityRecord.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): Invalid taxIdNum reference key 123456789.' });
    const refused = await vendors.post(await W9());
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "NetSuite didn't take the change: NetSuite error (400): Invalid taxIdNum reference key (the tax ID). Nothing changed." });
    expect(state.tables.detail_changes[0]).toMatchObject({ status: 'refused', error: 'NetSuite error (400): Invalid taxIdNum reference key (the tax ID).' });
    netsuite.patchEntityRecord.mockResolvedValueOnce({ success: false, error: "Couldn't reach NetSuite: socket hang up at 12-3456789", unsure: true });
    expect((await (await vendors.post(await W9())).json()).error).toBe(
      "Couldn't reach NetSuite: socket hang up at (the tax ID), so FleetSuite can't tell whether the change went in. Reload the vendor: if the change is there, it went in; if it isn't, make it again.",
    );
    expect(state.tables.detail_changes[0]).toMatchObject({ status: 'unsure', error: "Couldn't reach NetSuite: socket hang up at (the tax ID)" });
    expect(JSON.stringify(state.tables.detail_changes)).not.toMatch(/3456789/);
  });

  it("changes a vendor's addresses and terms by what NetSuite has, not what the page says", async () => {
    const res = await vendors.post({
      requestId: REQUEST, vendorId: '2207', signature: await vendorSignature(), reason: 'Moved to a new remit address', termsId: '3',
      addresses: [
        { lineId: '12', addressee: 'Ridge Supply Co', attention: 'Receiving', addr1: '11 Dock Rd', addr2: '', city: 'Springfield', state: 'MO', zip: '65802' },
        { lineId: 'new', addressee: '', attention: '', addr1: 'PO Box 100', addr2: '', city: 'Springfield', state: 'MO', zip: '65801' },
      ],
      billingLineId: 'new',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).changes).toEqual([
      'Terms Net 30 → Net 45',
      'Address Ridge Supply Co, Attn Receiving, 9 Dock Rd, Springfield, MO 65802 → Ridge Supply Co, Attn Receiving, 11 Dock Rd, Springfield, MO 65802',
      'New address: PO Box 100, Springfield, MO 65801',
      'Billing address Ridge Supply Co, 1 Main St, Springfield, MO 65801 → PO Box 100, Springfield, MO 65801',
    ]);
    expect(netsuite.patchEntityRecord).toHaveBeenCalledWith('vendor', '2207', {
      terms: { id: '3' },
      addressBook: {
        items: [
          {
            id: '12',
            addressBookAddress: {
              addressee: 'Ridge Supply Co', attention: 'Receiving', addr1: '11 Dock Rd', addr2: '', city: 'Springfield', state: 'MO', zip: '65802',
              addr3: '', addrPhone: '', country: { id: 'US' },
            },
          },
          {
            addressBookAddress: { addressee: '', attention: '', addr1: 'PO Box 100', addr2: '', city: 'Springfield', state: 'MO', zip: '65801', country: { id: 'US' } },
            defaultBilling: true,
          },
          { id: '11', defaultBilling: false },
        ],
      },
    });
    expect(state.tables.gl_netsuite_lists.find((r) => r.kind === 'vendor')?.details).toEqual({ entity_id: 'V-2207 Ridge Supply', terms_id: '3' });
    expect(logAudit).toHaveBeenCalledWith(h.service, expect.objectContaining({ action: 'change_vendor' }));
  });

  it("lists a record's own changes, newest first, twenty at most", async () => {
    const row = (end: string, type: string, id: string, at: string, over: Record<string, unknown> = {}) => ({
      id: `d0000000-0000-4000-8000-0000000000${end}`, record_type: type, netsuite_id: id, reason: 'New terms', changes: ['Terms Net 30 → Net 45'],
      status: 'changed', error: null, created_by: null, created_at: at, ...over,
    });
    state.tables.profiles.push({ id: 'p0000000-0000-4000-8000-000000000002', full_name: null });
    state.tables.detail_changes = [
      row('0a', 'vendor', '2207', '2026-12-02T15:00:00Z', { created_by: USER }), row('0b', 'customer', '2207', '2026-12-04T15:00:00Z'),
      row('0c', 'vendor', '2207', '2026-12-03T15:00:00Z', { created_by: 'p0000000-0000-4000-8000-000000000002', changes: { terms: 'Net 45' } }),
      row('0d', 'vendor', '2207', '2026-12-03T15:00:00Z', { status: 'refused', error: 'Invalid value for terms.' }),
      row('0e', 'vendor', '2208', '2026-12-05T15:00:00Z'),
    ];
    const { changes } = await (await vendors.get('vendor=2207')).json();
    expect(changes.map((c: { id: string }) => c.id.slice(-2))).toEqual(['0d', '0c', '0a']);
    expect(changes[0]).toMatchObject({ status: 'refused', error: 'Invalid value for terms.', by: null });
    expect(changes[1]).toMatchObject({ by: null, changes: [] });
    expect(changes[2]).toMatchObject({ by: 'Sam Example', changes: ['Terms Net 30 → Net 45'] });

    state.tables.detail_changes = Array.from({ length: 25 }, (_, i) => row(String(10 + i), 'customer', '4410', `2026-12-${String(i + 1).padStart(2, '0')}T15:00:00Z`));
    const many = (await (await customers.get('customer=4410')).json()).changes;
    expect(many).toHaveLength(20);
    expect(many[0].at).toBe('2026-12-25T15:00:00Z');
  });
});
