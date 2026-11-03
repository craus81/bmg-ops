// Books → Own credit memos' read (src/app/api/admin/books/own-credit-memos, migration 518): the month's credit memos
// FleetSuite made, Books' own copy of each next to NetSuite's, or one of them line by line, each with what the books
// hold for it and which copy made it, and what it put back on the shelf (migration 519). The check itself is
// src/lib/books/own-credit-memo-check.ts's, run for real here on copies NetSuite's credit memo hasn't reached yet.
// Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { OWN_COMPANY } from './own-invoices';

type Answer = { data: unknown; error: { message: string } | null };

const h = vi.hoisted(() => ({
  roles: ['admin', 'super_admin'] as string[],
  calls: [] as Array<{ fn: string; args: unknown }>,
  months: null as unknown as { data: unknown; error: { message: string } | null },
  pairs: null as unknown as (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
  postings: null as unknown as { data: unknown; error: { message: string } | null },
  costPairs: null as unknown as (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
  sync: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}));

vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever h.roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => h.roles.includes(r));
      return booksAllows(access, need) ? { user: { id: 'a0000000-0000-4000-8000-000000000001' }, access } : { error: Response.json({ error: 'Forbidden' }, { status: 403 }) };
    }),
  };
});
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      h.calls.push({ fn, args });
      if (fn === 'gl_own_credit_memo_months') return h.months;
      if (fn === 'gl_own_credit_memo_pairs') return h.pairs(args ?? {});
      if (fn === 'gl_invoice_postings') return h.postings;
      if (fn === 'gl_own_credit_cost_pairs') return h.costPairs(args ?? {});
      return { data: null, error: { message: `no ${fn} here` } };
    },
    // How far the copies the check reads from had come, by sync_state's sync_type.
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, syncType: string) => ({
          maybeSingle: async () => (table === 'sync_state' ? h.sync[syncType] ?? { data: null, error: null } : { data: null, error: { message: table } }),
        }),
      }),
    }),
  }),
}));

import { GET } from '../../app/api/admin/books/own-credit-memos/route';

const BASE = 'https://go.bmgfleet.com/api/admin/books/own-credit-memos';
const read = async (params: Record<string, string> = {}) => {
  const res = await GET(new NextRequest(`${BASE}?${new URLSearchParams(params)}`));
  return { status: res.status, body: await res.json() };
};
const called = (fn: string) => h.calls.filter((c) => c.fn === fn).map((c) => c.args);

/** Books' own copy of a credit memo against INV2401, before the ledger mirror has NetSuite's credit memo. */
const copy = (netsuiteId: string, number: string, date: string) => ({
  own: {
    netsuite_id: netsuiteId, number, invoice_id: '4401', invoice_number: 'INV2401', made_from_id: null,
    customer_netsuite_id: '701', customer_id: null, date, location_id: '1', reason: 'Returned unused',
    tax_rule: 'credit_tax@1', tax_rate: '0', tax_rate_from: 'untaxed', subtotal: '120.00', tax: '0.00', total: '120.00',
    made_at: `${date}T15:00:00Z`,
    lines: [{
      line_no: 1, invoice_line: 1, item_id: '9001', item_number: 'SHELF-1', description: 'Truck shelf', quantity: '1.0000',
      rate: '120.0000', amount: '120.00', taxable: false, tax: '0.00', back_to_stock: true, on_credit_item: false,
    }],
  },
  netsuite: null,
  netsuite_gl: null,
  customer_name: 'Gateway Plumbing',
});
const pairsOf = (...credit_memos: Array<ReturnType<typeof copy>>): Answer => ({
  data: { credit_memos, items: { 9001: { number: 'SHELF-1', type: 'InvtPart' } }, tax_codes: {}, locations: { 1: "O'Fallon" } },
  error: null,
});
const posting = (sourceType: string, sourceId: string, entryNo: number, rule: string) => ({
  source_type: sourceType, source_id: sourceId, current: { entry_no: entryNo, entry_date: '2027-02-10', posting_rule: rule },
});
const WAITING = "Waiting for NetSuite's credit memo: the ledger mirror copies NetSuite's credit memos every two hours.";
/** February's two, newest first, as the read gives them. */
const FEB = [copy('5203', 'CM5203', '2027-02-11'), copy('5202', 'CM5202', '2027-02-10')];
/** What a credit memo put back on the shelf, as gl_own_credit_cost_pairs gives it: nothing, and nor did NetSuite's. */
const nothingBack = (netsuiteId: string): Answer => ({
  data: {
    credit_memos: [{
      own: {
        netsuite_id: netsuiteId, number: `CM${netsuiteId}`, invoice_id: '4401', invoice_number: 'INV2401', customer_netsuite_id: '701',
        date: '2027-02-10', location_id: '1', made_at: '2027-02-10T15:00:00Z', lines: [],
      },
      netsuite: null,
      netsuite_gl: null,
      before: [],
      customer_name: 'Gateway Plumbing',
    }],
    items: {},
    locations: { 1: "O'Fallon" },
    accounts: {},
  },
  error: null,
});

beforeEach(() => {
  h.roles = ['admin', 'super_admin'];
  h.calls.length = 0;
  h.months = { data: [{ month: '2027-02-01', credit_memos: 2 }, { month: '2027-01-01', credit_memos: 1 }], error: null };
  h.pairs = (args) => (args.p_netsuite_id
    ? pairsOf(...FEB.filter((c) => c.own.netsuite_id === args.p_netsuite_id))
    : pairsOf(...(args.p_from === '2027-02-01' ? FEB : [])));
  h.postings = {
    data: {
      invoices: [
        posting('credit_memo', '5202', 2, 'own_credit_memo@1'),
        posting('credit_memo', '5203', 1, 'credit_memo@1'),
        // An invoice that happens to have a credit memo's NetSuite id is no credit memo's.
        posting('invoice', '5203', 4, 'own_invoice@1'),
      ],
    },
    error: null,
  };
  h.costPairs = (args) => nothingBack(String(args.p_netsuite_id));
  h.sync = {
    ledger_netsuite_mirror: { data: { updated_at: '2027-02-12T14:00:00Z', last_result: { copied: 12 } }, error: null },
    books_netsuite_gl: { data: { updated_at: '2027-02-12T13:00:00Z', last_result: { error: 'NetSuite timed out' } }, error: null },
    books_daily_check: { data: { updated_at: '2027-02-12T11:00:00Z', last_result: null }, error: null },
  };
});

describe('Books → Own credit memos: who may read it', () => {
  it('is for whoever opens the books, the CPA too, and no one else', async () => {
    h.roles = ['admin'];
    expect((await read()).status).toBe(403);
    expect(h.calls).toEqual([]);
    h.roles = ['cpa'];
    expect((await read()).status).toBe(200);
  });
});

describe('Books → Own credit memos: a month', () => {
  it("lists the newest month's credit memos without their line by line check, each with what the books hold and which copy made it", async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(called('gl_own_credit_memo_pairs')).toEqual([{ p_from: '2027-02-01', p_to: '2027-02-28', p_netsuite_id: null }]);
    expect(called('gl_invoice_postings')).toEqual([{ p_company: OWN_COMPANY, p_source_ids: ['5203', '5202'], p_lines: false }]);
    expect(body.months).toEqual([{ month: '2027-02-01', credit_memos: 2 }, { month: '2027-01-01', credit_memos: 1 }]);
    expect(body.month).toBe('2027-02-01');
    expect(body.creditMemos.map((c: Record<string, unknown>) => [c.number, c.status, c.summary, c.books])).toEqual([
      ['CM5203', 'waiting', WAITING, { entryNo: 1, date: '2027-02-10', from: 'netsuite' }],
      ['CM5202', 'waiting', WAITING, { entryNo: 2, date: '2027-02-10', from: 'fleetsuite' }],
    ]);
    expect(body.creditMemos[0]).toMatchObject({ invoiceNumber: 'INV2401', customer: 'Gateway Plumbing', fleetsuiteTotal: 12000, backToStock: 1 });
    for (const c of body.creditMemos) for (const k of ['fields', 'lines', 'workedOut']) expect(c, k).not.toHaveProperty(k);
    expect(body.counts).toEqual({ differs: 0, waiting: 2, matches: 0, voided: 0 });
  });

  it('says how the copies the check reads from last went', async () => {
    const { body } = await read();
    expect(body.lastMirror).toEqual({ at: '2027-02-12T14:00:00Z', error: null });
    expect(body.lastCopy).toEqual({ at: '2027-02-12T13:00:00Z', error: 'NetSuite timed out' });
    expect(body.lastLists).toBeNull();
    expect(body.lastCheck).toEqual({ at: '2027-02-12T11:00:00Z', error: null });
  });

  it('reads the month asked, to its last day, and the newest one for anything else', async () => {
    expect((await read({ month: '2027-01' })).body).toMatchObject({ month: '2027-01-01', creditMemos: [], counts: { waiting: 0 } });
    expect(called('gl_own_credit_memo_pairs')).toEqual([{ p_from: '2027-01-01', p_to: '2027-01-31', p_netsuite_id: null }]);
    // Nothing that month: nothing to ask the books about.
    expect(called('gl_invoice_postings')).toEqual([]);
    h.calls.length = 0;
    await read({ month: '2028-02' });
    expect(called('gl_own_credit_memo_pairs')).toEqual([{ p_from: '2028-02-01', p_to: '2028-02-29', p_netsuite_id: null }]);
    h.calls.length = 0;
    expect((await read({ month: 'February' })).body.month).toBe('2027-02-01');
    expect(called('gl_own_credit_memo_pairs')).toEqual([{ p_from: '2027-02-01', p_to: '2027-02-28', p_netsuite_id: null }]);
  });

  it('has nothing to list before FleetSuite makes a credit memo', async () => {
    h.months = { data: [], error: null };
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body).toMatchObject({ months: [], month: null, creditMemos: [], counts: null });
    expect(called('gl_own_credit_memo_pairs')).toEqual([]);
    expect(called('gl_invoice_postings')).toEqual([]);
  });

  it("says what it couldn't read, in red on the page", async () => {
    h.months = { data: null, error: { message: 'months broke' } };
    expect(await read()).toEqual({ status: 500, body: { error: 'months broke' } });
    h.months = { data: [{ month: '2027-02-01', credit_memos: 2 }], error: null };
    h.sync.books_netsuite_lists = { data: null, error: { message: 'sync state broke' } };
    expect(await read()).toEqual({ status: 500, body: { error: 'sync state broke' } });
    delete h.sync.books_netsuite_lists;
    h.pairs = () => ({ data: null, error: { message: 'pairs broke' } });
    expect(await read()).toEqual({ status: 500, body: { error: 'pairs broke' } });
    h.pairs = () => pairsOf(FEB[1]);
    h.postings = { data: null, error: { message: 'postings broke' } };
    expect(await read()).toEqual({ status: 500, body: { error: 'postings broke' } });
  });
});

describe('Books → Own credit memos: one credit memo', () => {
  it('reads it alone, line by line, with what the books hold for it', async () => {
    const { status, body } = await read({ id: '5202' });
    expect(status).toBe(200);
    expect(called('gl_own_credit_memo_pairs')).toEqual([{ p_from: null, p_to: null, p_netsuite_id: '5202' }]);
    expect(called('gl_own_credit_memo_months')).toEqual([]);
    expect(called('gl_invoice_postings')).toEqual([{ p_company: OWN_COMPANY, p_source_ids: ['5202'], p_lines: false }]);
    expect(body.creditMemo).toMatchObject({
      netsuiteId: '5202', number: 'CM5202', status: 'waiting', summary: WAITING, books: { entryNo: 2, date: '2027-02-10', from: 'fleetsuite' },
    });
    expect(body.creditMemo.fields.map((f: { field: string }) => f.field)).toEqual(['customer', 'date', 'location', 'lines', 'subtotal', 'tax', 'total']);
    expect(body.creditMemo.lines).toEqual([]);
    expect(body.creditMemo.workedOut[0]).toBe('Made against INV2401 on Feb 10, 2027.');
  });

  it("takes only the credit memo's own entries, NetSuite's credit memo's as NetSuite's", async () => {
    expect((await read({ id: '5203' })).body.creditMemo.books).toEqual({ entryNo: 1, date: '2027-02-10', from: 'netsuite' });
    h.postings = { data: { invoices: [posting('invoice', '5202', 3, 'own_invoice@1')] }, error: null };
    expect((await read({ id: '5202' })).body.creditMemo.books).toBeNull();
  });

  it("reads what it put back on the shelf where the credit memo screen puts parts, nothing when neither side put anything back, and says what it couldn't read", async () => {
    const { status, body } = await read({ id: '5202' });
    expect(status).toBe(200);
    expect(called('gl_own_credit_cost_pairs')).toEqual([{ p_from: null, p_to: null, p_netsuite_id: '5202', p_location: '1' }]);
    expect(body.creditMemo.cost).toBeNull();
    expect(body.creditMemo).not.toHaveProperty('costError');
    // A read of it that fails leaves the rest of the page, saying so.
    h.costPairs = () => ({ data: null, error: { message: 'cost broke' } });
    const failed = await read({ id: '5202' });
    expect(failed.status).toBe(200);
    expect(failed.body.creditMemo).toMatchObject({ netsuiteId: '5202', books: { entryNo: 2 }, costError: 'cost broke' });
    expect(failed.body.creditMemo).not.toHaveProperty('cost');
    h.costPairs = (args) => nothingBack(String(args.p_netsuite_id));
    for (const sync of ['books_netsuite_stock', 'books_netsuite_gl']) {
      h.sync[sync] = { data: null, error: { message: `${sync} broke` } };
      expect((await read({ id: '5202' })).body.creditMemo.costError, sync).toBe(`${sync} broke`);
      delete h.sync[sync];
    }
  });

  it("refuses what isn't a NetSuite id, says when Books has no copy, and says what it couldn't read", async () => {
    expect(await read({ id: 'CM5202' })).toEqual({ status: 400, body: { error: "That isn't a NetSuite credit memo id" } });
    expect(h.calls).toEqual([]);
    expect(await read({ id: '9999' })).toEqual({ status: 404, body: { error: 'FleetSuite has no copy of that credit memo' } });
    expect(called('gl_invoice_postings')).toEqual([]);
    h.pairs = () => ({ data: null, error: { message: 'pairs broke' } });
    expect(await read({ id: '5202' })).toEqual({ status: 500, body: { error: 'pairs broke' } });
    h.pairs = () => pairsOf(FEB[1]);
    h.postings = { data: null, error: { message: 'postings broke' } };
    expect(await read({ id: '5202' })).toEqual({ status: 500, body: { error: 'postings broke' } });
  });
});
