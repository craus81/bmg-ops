// Books → Invoices vs NetSuite, Stock and cost (src/app/api/admin/books/invoices, kind=stock): what the books hold for
// each of a month's stock documents, and which copy the next run posts each from. Books' own copies are read as the
// posting run reads them (readOwnStockCopies, src/lib/books/own-stock-posting.ts), with the first month Books made a
// credit memo in only for a month of BMG's that has a credit memo's stock (migration 519), so what the page shows is
// what the run posts. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  since: { fulfillments: '2026-05-01', receipts: '2026-06-01', adjustments: null, invoices: '2026-04-01' },
  documents: {} as Record<string, unknown[]>,
  creditSince: (async () => null) as () => Promise<string | null>,
}));

vi.mock('@/lib/api-auth', () => ({
  requireBooks: vi.fn(async () => ({ user: { id: 'a0000000-0000-4000-8000-000000000001' } })),
}));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: () => {
        if (table === 'gl_companies') {
          return { order: async () => ({ data: [{ id: 'c1', code: 'BMG', name: 'BMG Fleet' }, { id: 'c2', code: '1084', name: '1084 Holdings' }], error: null }) };
        }
        if (table === 'gl_accounts') return { order: () => ({ range: async () => ({ data: [], error: null }) }) };
        // How far each copy of NetSuite had come, and the last run: nothing yet.
        return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
      },
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'gl_stock_month') return { data: { documents: h.documents[args.p_company as string] ?? [] }, error: null };
      if (fn === 'gl_stock_postings') return { data: { documents: [] }, error: null };
      return { data: null, error: { message: `no ${fn} here` } };
    },
  }),
}));
vi.mock('./own-stock-posting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./own-stock-posting')>()),
  readOwnStockSince: vi.fn(async () => h.since),
  readOwnStockCopies: vi.fn(async () => ({
    fulfillments: new Map(), receipts: new Map(), adjustments: new Map(), invoiceCosts: new Map(), creditCosts: new Map(),
    accounts: { items: {}, fulfillments: {}, invoices: {}, credits: {}, usual_cost: null, received: [] },
  })),
}));
vi.mock('./own-credit-memo-posting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./own-credit-memo-posting')>()),
  readOwnCreditSince: vi.fn(async () => h.creditSince()),
}));

import { GET } from '../../app/api/admin/books/invoices/route';
import { readOwnStockCopies } from './own-stock-posting';
import { readOwnCreditSince } from './own-credit-memo-posting';

const BASE = 'https://go.bmgfleet.com/api/admin/books/invoices';
const read = async (company: string) => {
  const res = await GET(new NextRequest(`${BASE}?${new URLSearchParams({ kind: 'stock', company, month: '2026-10' })}`));
  return { status: res.status, body: await res.json() };
};

/** A stock document of October's, as gl_stock_month gives it: its cost lines on the company's books. */
const doc = (netsuiteId: string, type: string, number: string, company = 'BMG') => ({
  netsuite_id: netsuiteId, type, number, date: '2026-10-14', posting_month: '2026-10-01', companies: [company],
  lines: [
    { line_id: '1', account: '130', debit: '40.00', credit: '0.00', memo: null, entity_id: null, name: null, customer_id: null },
    { line_id: '2', account: '500', debit: '0.00', credit: '40.00', memo: null, entity_id: null, name: null, customer_id: null },
  ],
});
const copiesRead = () => vi.mocked(readOwnStockCopies).mock.calls;

describe("Invoices vs NetSuite's Stock and cost, with Books' own copies", () => {
  beforeEach(() => {
    vi.mocked(readOwnStockCopies).mockClear();
    vi.mocked(readOwnCreditSince).mockClear();
    h.creditSince = async () => '2026-09-01';
    h.documents = {};
  });

  it("reads the first month Books made a credit memo in for a month of BMG's with a credit memo's stock, as the run does", async () => {
    h.documents.BMG = [doc('8101', 'ItemShip', 'IF0101'), doc('8102', 'CustCred', 'CM0102')];
    expect((await read('BMG')).status).toBe(200);
    expect(readOwnCreditSince).toHaveBeenCalledTimes(1);
    expect(copiesRead()).toHaveLength(1);
    const [, company, documents, since, through] = copiesRead()[0];
    expect(company).toBe('BMG');
    expect(documents).toEqual(h.documents.BMG);
    expect(since).toEqual({ ...h.since, creditMemos: '2026-09-01' });
    expect(through).toEqual({ stock: null, ledger: null });
  });

  it("reads none for a month of BMG's with no credit memo's stock, or for 1084's", async () => {
    h.documents.BMG = [doc('8101', 'ItemShip', 'IF0101'), doc('8103', 'CustInvc', 'INV0103')];
    expect((await read('BMG')).status).toBe(200);
    h.documents['1084'] = [doc('8104', 'CustCred', 'CM0104', '1084')];
    expect((await read('1084')).status).toBe(200);
    expect(readOwnCreditSince).not.toHaveBeenCalled();
    expect(copiesRead().map((c) => [c[1], c[3]])).toEqual([['BMG', h.since], ['1084', h.since]]);
    for (const c of copiesRead()) expect((c[3] as { creditMemos?: string | null }).creditMemos).toBeUndefined();
  });

  it("says why when the months of Books' own credit memos can't be read, and reads no copies", async () => {
    h.documents.BMG = [doc('8102', 'CustCred', 'CM0102')];
    h.creditSince = async () => { throw new Error('permission denied for function gl_own_credit_memo_months'); };
    expect(await read('BMG')).toEqual({ status: 500, body: { error: 'permission denied for function gl_own_credit_memo_months' } });
    expect(copiesRead()).toHaveLength(0);
  });
});
