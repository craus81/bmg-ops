// Estimates in FleetSuite only (src/lib/estimates-in-fleetsuite.ts, migration 479): what the estimate's buttons are
// told, a push or a sync refused once it's on before anything is read or sent, pushing as now while it's off,
// deleting a pushed estimate still deleting its NetSuite copy, and the wrap quote's old NetSuite quote refused.
// Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// The wrap quote route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const USER = 'p0000000-0000-4000-8000-000000000001';
  const state = {
    features: new Set<string>(['estimates']),
    staff: true,
    tables: {} as Record<string, Record<string, any>[]>,
    /** Every table read or written, in order. */
    touched: [] as string[],
    updates: [] as Array<[string, Record<string, any>]>,
    switchesFail: false,
  };
  // An in-memory stand-in for the tables the routes read.
  function query(table: string) {
    state.touched.push(table);
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    let patch: Record<string, any> | null = null;
    const rows = () => (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      update: (p: Record<string, any>) => { patch = p; return builder; },
      maybeSingle: async () => (table === 'books_switches' && state.switchesFail
        ? { data: null, error: { message: 'books_switches is out of reach' } }
        : { data: rows()[0] ?? null, error: null }),
      single: async () => (rows()[0] ? { data: rows()[0], error: null } : { data: null, error: { message: 'no rows' } }),
      then: (resolve: (v: unknown) => void) => {
        if (patch) {
          for (const r of rows()) state.updates.push([table, { id: r.id, ...patch }]);
          return resolve({ error: null });
        }
        return resolve({ data: rows(), error: null });
      },
    };
    return builder;
  }
  return {
    USER,
    state,
    service: { from: (table: string) => query(table) },
    netsuiteFetch: vi.fn(),
    createEstimate: vi.fn(),
  };
});

vi.mock('@/lib/api-auth', () => ({
  requireFeature: vi.fn(async (_req: unknown, feature: string) => (h.state.features.has(feature)
    ? { user: { id: h.USER }, profile: { roles: ['sales'] } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  requireStaff: vi.fn(async () => (h.state.staff
    ? { user: { id: h.USER }, profile: { roles: ['sales'] } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/netsuite-sends', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/netsuite-sends')>()),
  netsuiteFetch: h.netsuiteFetch,
}));
vi.mock('@/lib/netsuite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/netsuite')>()),
  createEstimate: h.createEstimate,
}));

const { state } = h;

import * as push from '../app/api/estimates/push/route';
import * as wrapQuote from '../app/api/wrap-quote/netsuite/route';
import { ESTIMATES_STAY_LINE, PUSHED_BEFORE_LINE, estimatesPromptNote } from './estimates-in-fleetsuite';

const DRAFT = 'e0000000-0000-4000-8000-000000000001';
const PUSHED = 'e0000000-0000-4000-8000-000000000002';
const QUOTE = 'a0000000-0000-4000-8000-000000000001';

const req = (url: string, method: string, body?: unknown) => new NextRequest(`https://fleetsuite.test${url}`, {
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
});
const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'estimates_in_fleetsuite', is_on: on }, { piece: 'item_accounts', is_on: !on }]; };

beforeEach(() => {
  state.features = new Set(['estimates']);
  state.staff = true;
  state.switchesFail = false;
  state.touched = [];
  state.updates = [];
  state.tables = {
    estimates: [
      { id: DRAFT, estimate_number: 'EST-2701-004', status: 'draft', netsuite_estimate_id: null },
      { id: PUSHED, estimate_number: 'EST-2612-031', status: 'pushed', netsuite_estimate_id: '7001', netsuite_estimate_number: 'EST1882' },
    ],
    wrap_quotes: [{ id: QUOTE, quote_number: 'WQ-0412', netsuite_estimate_id: null }],
  };
  h.netsuiteFetch.mockReset();
  h.createEstimate.mockReset();
  for (const [k, v] of Object.entries({
    NETSUITE_ACCOUNT_ID: '1234567_SB1', NETSUITE_CONSUMER_KEY: 'ck', NETSUITE_CONSUMER_SECRET: 'cs', NETSUITE_TOKEN_ID: 'ti', NETSUITE_TOKEN_SECRET: 'ts',
  })) vi.stubEnv(k, v);
});
afterEach(() => { vi.unstubAllEnvs(); });

const REFUSAL = "Estimates stay in FleetSuite now, so nothing was sent to NetSuite. NetSuite gets the job's sales order when it's made.";

describe("the estimate's buttons", () => {
  it('are told whether estimates stay in FleetSuite, off unless the switch says on', async () => {
    const stay = async () => {
      const res = await push.GET(req('/api/estimates/push', 'GET'));
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await stay()).toEqual({ estimatesStayInFleetsuite: false });
    switchOn(true);
    expect(await stay()).toEqual({ estimatesStayInFleetsuite: true });
    switchOn(false);
    expect(await stay()).toEqual({ estimatesStayInFleetsuite: false });
    switchOn(true);
    state.switchesFail = true;
    expect(await stay()).toEqual({ estimatesStayInFleetsuite: false });
  });

  it('need the estimates feature to ask', async () => {
    state.features = new Set();
    expect((await push.GET(req('/api/estimates/push', 'GET'))).status).toBe(403);
    expect(state.touched).toEqual([]);
  });
});

describe('a push once estimates stay in FleetSuite', () => {
  it("is refused, a first push and a pushed estimate's sync alike, before anything is read or sent", async () => {
    switchOn(true);
    for (const estimateId of [DRAFT, PUSHED]) {
      const res = await push.POST(req('/api/estimates/push', 'POST', { estimateId }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: REFUSAL, estimatesStayInFleetsuite: true });
    }
    expect(state.touched).toEqual(['books_switches', 'books_switches']);
    expect(h.netsuiteFetch).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("goes on as now while it's off, or when the switch can't be read", async () => {
    state.tables.estimates = [];
    switchOn(false);
    const off = await push.POST(req('/api/estimates/push', 'POST', { estimateId: DRAFT }));
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: 'Estimate not found' });
    expect(state.touched).toEqual(['books_switches', 'estimates']);

    switchOn(true);
    state.switchesFail = true;
    state.touched = [];
    expect((await push.POST(req('/api/estimates/push', 'POST', { estimateId: DRAFT }))).status).toBe(404);
    expect(state.touched).toEqual(['books_switches', 'estimates']);
  });

  it('is turned away first without the estimates feature or with a bad body', async () => {
    switchOn(true);
    state.features = new Set();
    expect((await push.POST(req('/api/estimates/push', 'POST', { estimateId: DRAFT }))).status).toBe(403);
    state.features = new Set(['estimates']);
    expect((await push.POST(req('/api/estimates/push', 'POST', { estimateId: 'EST-2701-004' }))).status).toBe(400);
    expect(state.touched).toEqual([]);
  });
});

describe('deleting a pushed estimate once estimates stay in FleetSuite', () => {
  it('still deletes its NetSuite copy first, and never asks the switch', async () => {
    switchOn(true);
    h.netsuiteFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await push.DELETE(req('/api/estimates/push', 'DELETE', { estimateId: PUSHED }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(h.netsuiteFetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.netsuiteFetch.mock.calls[0];
    expect(url).toBe('https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/estimate/7001');
    expect(init.method).toBe('DELETE');
    expect(state.updates).toEqual([['estimates', {
      id: PUSHED, netsuite_estimate_id: null, netsuite_estimate_number: null, status: 'draft', pushed_at: null, pushed_by: null, updated_at: expect.any(String),
    }]]);

    const never = await push.DELETE(req('/api/estimates/push', 'DELETE', { estimateId: DRAFT }));
    expect(never.status).toBe(400);
    expect(await never.json()).toEqual({ error: 'Estimate has not been pushed to NetSuite' });
    expect(state.touched).not.toContain('books_switches');
  });
});

describe("the wrap quote's old NetSuite quote", () => {
  it('is refused once estimates stay in FleetSuite, before the quote is read', async () => {
    switchOn(true);
    const res = await wrapQuote.POST(req('/api/wrap-quote/netsuite', 'POST', { quoteId: QUOTE }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Estimates stay in FleetSuite now, so no NetSuite quote was made. Open the quote's estimate instead.",
      estimatesStayInFleetsuite: true,
    });
    expect(state.touched).toEqual(['books_switches']);
    expect(h.createEstimate).not.toHaveBeenCalled();
  });

  it("is made as now while it's off", async () => {
    state.tables.wrap_quotes = [];
    switchOn(false);
    const res = await wrapQuote.POST(req('/api/wrap-quote/netsuite', 'POST', { quoteId: QUOTE }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Quote not found' });
    expect(state.touched).toEqual(['books_switches', 'wrap_quotes']);
  });

  it('needs staff to ask', async () => {
    switchOn(true);
    state.staff = false;
    expect((await wrapQuote.POST(req('/api/wrap-quote/netsuite', 'POST', { quoteId: QUOTE }))).status).toBe(403);
    expect(state.touched).toEqual([]);
  });
});

describe('the words staff see', () => {
  it("on an estimate, and on one pushed before, once it's on", () => {
    expect(ESTIMATES_STAY_LINE).toBe("Estimates stay in FleetSuite. NetSuite gets the sales order when it's made.");
    expect(PUSHED_BEFORE_LINE).toBe("NetSuite's copy closes with the sales order");
  });

  it("tell FleetSuite AI not to send anyone to push an estimate once it's on, and nothing while it's off", async () => {
    switchOn(true);
    expect(await estimatesPromptNote(h.service as any)).toBe(
      "\n\nIMPORTANT: Estimates stay in FleetSuite now. Never tell anyone to push an estimate to NetSuite; NetSuite gets the job's sales order when the estimate is converted to one.",
    );
    switchOn(false);
    expect(await estimatesPromptNote(h.service as any)).toBe('');
    switchOn(true);
    state.switchesFail = true;
    expect(await estimatesPromptNote(h.service as any)).toBe('');
  });
});
