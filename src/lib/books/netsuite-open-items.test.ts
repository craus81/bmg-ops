import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/netsuite', () => ({
  isSuiteqlError: (err: unknown) => err instanceof Error && typeof (err as any).status === 'number',
  suiteqlQuery: vi.fn(),
  suiteqlQueryAll: vi.fn(),
}));
const heartbeats: Array<{ syncType: string; result: any; opts: any }> = [];
vi.mock('@/lib/system-health', () => ({
  recordHeartbeat: vi.fn(async (_svc: unknown, syncType: string, result: unknown, opts: unknown) => {
    heartbeats.push({ syncType, result, opts });
    return { ok: true };
  }),
}));

import { BOOKS_OPEN_ITEMS_SYNC, OPEN_ITEMS_QUERY, copyNetSuiteOpenItems, mapOpenItems } from './netsuite-open-items';

// SuiteQL's shapes: ids as numbers or strings, dates as NetSuite's M/D/YYYY, open amounts signed as it pleases.
const ROWS = [
  { id: 1001, type: 'CustInvc', tranid: 'INV1001', trandate: '9/3/2026', duedate: '10/3/2026', unpaid: '200', line_entity_id: 9001, txn_entity_id: 9001, subsidiary_id: 2 },
  { id: '1010', type: 'CustCred', tranid: 'CM1010', trandate: '2026-10-10', duedate: null, unpaid: '-50', line_entity_id: null, txn_entity_id: '9001', subsidiary_id: '2' },
  { id: 4002, type: 'VendBill', tranid: 'BILL4002', trandate: '9/6/2026', duedate: '10/6/2026', unpaid: 150.5, line_entity_id: '7002', txn_entity_id: '7002', subsidiary_id: 2 },
  { id: 4005, type: 'VendCred', tranid: 'VC4005', trandate: '10/5/2026', duedate: '', unpaid: '-20', line_entity_id: 7001, txn_entity_id: 7001, subsidiary_id: 2 },
  { id: 4006, type: 'VendBill', tranid: ' ', trandate: '10/20/2026', duedate: '10/30/2026', unpaid: '30', line_entity_id: '', txn_entity_id: null, subsidiary_id: null },
];

describe('the copy\'s query', () => {
  it('reads every open invoice, credit memo, bill and bill credit with what is open on it, by its main line, in id order', () => {
    expect(OPEN_ITEMS_QUERY).toMatch(
      /SELECT t\.id, t\.type, t\.tranid, t\.trandate, t\.duedate, t\.foreignamountunpaid AS unpaid,\s+tl\.entity AS line_entity_id, t\.entity AS txn_entity_id, tl\.subsidiary AS subsidiary_id\s+FROM transaction t\s+JOIN transactionline tl ON tl\.transaction = t\.id AND tl\.mainline = 'T'\s+WHERE t\.type IN \('CustInvc', 'CustCred', 'VendBill', 'VendCred'\)\s+AND t\.status = 'A'\s+ORDER BY t\.id/,
    );
  });
});

describe('mapOpenItems', () => {
  it('copies each open document, its open amount signed by its type as on the receivable or payable account', () => {
    const { items, unreadable, noSubsidiary } = mapOpenItems(ROWS);
    expect(items).toEqual([
      { netsuite_id: '1001', tran_type: 'CustInvc', tranid: 'INV1001', trandate: '2026-09-03', due_date: '2026-10-03', entity_id: '9001', subsidiary_id: '2', amount_open: '200.00' },
      // The main line names nobody, so the document's own name stands.
      { netsuite_id: '1010', tran_type: 'CustCred', tranid: 'CM1010', trandate: '2026-10-10', due_date: null, entity_id: '9001', subsidiary_id: '2', amount_open: '-50.00' },
      { netsuite_id: '4002', tran_type: 'VendBill', tranid: 'BILL4002', trandate: '2026-09-06', due_date: '2026-10-06', entity_id: '7002', subsidiary_id: '2', amount_open: '-150.50' },
      { netsuite_id: '4005', tran_type: 'VendCred', tranid: 'VC4005', trandate: '2026-10-05', due_date: null, entity_id: '7001', subsidiary_id: '2', amount_open: '20.00' },
      { netsuite_id: '4006', tran_type: 'VendBill', tranid: null, trandate: '2026-10-20', due_date: '2026-10-30', entity_id: '', subsidiary_id: null, amount_open: '-30.00' },
    ]);
    expect(unreadable).toEqual([]);
    expect(noSubsidiary).toBe(1);
  });

  it('signs an amount NetSuite gives either way round the same', () => {
    const signs = (type: string) => ['5', '-5'].map((unpaid) => mapOpenItems([{ id: 1, type, trandate: '2026-10-01', unpaid }]).items[0].amount_open);
    expect(signs('CustInvc')).toEqual(['5.00', '5.00']);
    expect(signs('CustCred')).toEqual(['-5.00', '-5.00']);
    expect(signs('VendBill')).toEqual(['-5.00', '-5.00']);
    expect(signs('VendCred')).toEqual(['5.00', '5.00']);
  });

  it('leaves out what has nothing open and a document sent twice; names what it can\'t read', () => {
    const { items, unreadable, noSubsidiary } = mapOpenItems([
      ROWS[0],
      { ...ROWS[0], line_entity_id: 9009 },
      { id: 1002, type: 'CustInvc', tranid: 'INV1002', trandate: '9/4/2026', unpaid: '0.004', subsidiary_id: 2 },
      { id: 1003, type: 'CustInvc', tranid: 'INV1003', trandate: '9/4/2026', unpaid: 0, subsidiary_id: 2 },
      { id: 1004, type: 'CustInvc', tranid: 'INV1004', trandate: '9/4/2026', unpaid: 'lots', subsidiary_id: 2 },
      { id: 1005, type: 'CustInvc', tranid: 'INV1005', trandate: '9/4/2026', unpaid: null, subsidiary_id: 2 },
      { id: 1006, type: 'CustInvc', tranid: 'INV1006', trandate: null, unpaid: '5', subsidiary_id: 2 },
      { id: 1007, type: 'Journal', tranid: 'JE1007', trandate: '9/4/2026', unpaid: '5', subsidiary_id: 2 },
      { id: 'x', type: 'CustInvc', trandate: '9/4/2026', unpaid: '5', subsidiary_id: 2 },
      { type: 'CustInvc', trandate: '9/4/2026', unpaid: '5', subsidiary_id: 2 },
      { id: 1008, type: 'CustInvc', tranid: 'INV1008', trandate: '9/4/2026', unpaid: '5', line_entity_id: 'Acme', subsidiary_id: 'two' },
      // The main line's name over the document's own.
      { id: 1009, type: 'CustInvc', tranid: 'INV1009', trandate: '9/4/2026', unpaid: '5', line_entity_id: 9006, txn_entity_id: 9001, subsidiary_id: 2 },
    ]);
    expect(items.map((i) => [i.netsuite_id, i.entity_id, i.subsidiary_id])).toEqual([['1001', '9001', '2'], ['1008', '', null], ['1009', '9006', '2']]);
    expect(unreadable).toEqual(['INV1004', 'INV1005', 'INV1006', 'JE1007', 'NetSuite x', 'NetSuite document']);
    expect(noSubsidiary).toBe(1);
  });
});

describe('copyNetSuiteOpenItems', () => {
  beforeEach(() => { heartbeats.length = 0; });

  const fakeService = (opts: { held?: number; countError?: string; rpcError?: string } = {}) => {
    const rpc = vi.fn(async (_fn: string, args: { p: { items: unknown[] } }) => (opts.rpcError
      ? { data: null, error: { message: opts.rpcError } }
      : { data: args.p.items.length, error: null }));
    const select = vi.fn(async () => (opts.countError
      ? { count: null, error: { message: opts.countError } }
      : { count: opts.held ?? 0, error: null }));
    const from = vi.fn((table: string) => {
      expect(table).toBe('gl_netsuite_open_items');
      return { select };
    });
    return { service: { from, rpc } as any, rpc, select };
  };
  const reads = (rows: unknown[]) => vi.fn(async (q: string) => {
    expect(q).toBe(OPEN_ITEMS_QUERY);
    return rows as Record<string, unknown>[];
  });

  it('replaces the copy with what NetSuite has open, and records the run', async () => {
    const { service, rpc, select } = fakeService();
    const r = await copyNetSuiteOpenItems(service, { deps: { query: reads(ROWS) } });
    expect(r).toMatchObject({ read: 5, copied: 5 });
    expect(r.error).toBeUndefined();
    expect(r.kept).toBeUndefined();
    expect(r.notes).toEqual(["NetSuite named no subsidiary on an open document, so it's in neither company's agings."]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('gl_netsuite_store_open_items');
    expect(rpc.mock.calls[0][1].p.items).toEqual(mapOpenItems(ROWS).items);
    expect(select).not.toHaveBeenCalled();
    expect(heartbeats).toEqual([{
      syncType: BOOKS_OPEN_ITEMS_SYNC,
      result: { read: 5, copied: 5, notes: r.notes },
      opts: { startedAt: expect.any(Number), records: 5 },
    }]);
  });

  it('names what it left out, at most ten', async () => {
    const { service } = fakeService();
    const bad = Array.from({ length: 12 }, (_, i) => ({ id: 2000 + i, type: 'CustInvc', tranid: `INV${2000 + i}`, trandate: null, unpaid: '5', subsidiary_id: 2 }));
    const one = await copyNetSuiteOpenItems(service, { deps: { query: reads([ROWS[0], bad[0]]) } });
    expect(one.notes).toEqual(["NetSuite sent a document with no date or an open amount FleetSuite can't read, so it isn't copied: INV2000."]);
    const many = await copyNetSuiteOpenItems(service, { deps: { query: reads([ROWS[0], ...bad, ROWS[4], { ...ROWS[4], id: 4007 }]) } });
    expect(many.notes).toEqual([
      "NetSuite sent 12 documents with no date or an open amount FleetSuite can't read, so they aren't copied: "
        + 'INV2000, INV2001, INV2002, INV2003, INV2004, INV2005, INV2006, INV2007, INV2008, INV2009, ….',
      "NetSuite named no subsidiary on 2 open documents, so they're in neither company's agings.",
    ]);
  });

  it('keeps the last copy when NetSuite finds nothing open while the copy holds documents', async () => {
    const { service, rpc } = fakeService({ held: 7 });
    const r = await copyNetSuiteOpenItems(service, { deps: { query: reads([{ ...ROWS[0], unpaid: '0' }]) } });
    expect(r).toMatchObject({ read: 1, copied: 7, kept: true });
    expect(r.notes).toEqual([expect.stringMatching(/^NetSuite gave no open invoice or bill at all, so the copy keeps the last one/)]);
    expect(rpc).not.toHaveBeenCalled();
    expect(heartbeats[0].opts).toMatchObject({ records: 1, touchLastSyncedAt: false });
    expect(heartbeats[0].result).toMatchObject({ kept: true });
  });

  it('empties an empty copy when NetSuite finds nothing open', async () => {
    const { service, rpc } = fakeService({ held: 0 });
    const r = await copyNetSuiteOpenItems(service, { deps: { query: reads([]) } });
    expect(r).toMatchObject({ read: 0, copied: 0 });
    expect(r.kept).toBeUndefined();
    expect(rpc.mock.calls[0][1].p.items).toEqual([]);
    expect(heartbeats[0].opts).not.toHaveProperty('touchLastSyncedAt');
  });

  it("says plainly when NetSuite won't give what's open, and keeps the copy", async () => {
    const { service, rpc } = fakeService();
    const refused = Object.assign(new Error('NetSuite SuiteQL error (400): {"title":"Invalid search query","o:errorDetails":[{"detail":"Unknown field foreignamountunpaid","o:errorCode":"INVALID_PARAMETER"}]}'), { status: 400 });
    const r = await copyNetSuiteOpenItems(service, { deps: { query: vi.fn(async () => { throw refused; }) } });
    expect(r.error).toBe("reading NetSuite's open invoices and bills: NetSuite wouldn't give its open invoices and bills with what's still open on each "
      + '(NetSuite SuiteQL error (400): INVALID_PARAMETER — Unknown field foreignamountunpaid)');
    expect(rpc).not.toHaveBeenCalled();
    expect(heartbeats[0].opts).toMatchObject({ records: 0, touchLastSyncedAt: false });
    expect(heartbeats[0].result.error).toBe(r.error);

    const busy = Object.assign(new Error('NetSuite SuiteQL error (503): Service Unavailable'), { status: 503 });
    const r2 = await copyNetSuiteOpenItems(service, { deps: { query: vi.fn(async () => { throw busy; }) } });
    expect(r2.error).toBe("reading NetSuite's open invoices and bills: NetSuite SuiteQL error (503): Service Unavailable");
  });

  it("records a copy the database wouldn't take, or a count it couldn't read, as the run's error", async () => {
    const refused = fakeService({ rpcError: 'gl: items must be a list' });
    const r = await copyNetSuiteOpenItems(refused.service, { deps: { query: reads(ROWS) } });
    expect(r).toMatchObject({ read: 5, copied: 0, error: 'writing the copy: gl: items must be a list' });
    const uncounted = fakeService({ countError: 'permission denied' });
    const r2 = await copyNetSuiteOpenItems(uncounted.service, { deps: { query: reads([]) } });
    expect(r2.error).toBe('writing the copy: permission denied');
    expect(uncounted.rpc).not.toHaveBeenCalled();
    expect(heartbeats.map((h) => h.opts.touchLastSyncedAt)).toEqual([false, false]);
  });
});
