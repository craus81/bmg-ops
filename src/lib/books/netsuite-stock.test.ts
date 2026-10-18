import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: (e: any) => typeof e?.status === 'number', suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { recordHeartbeat } from '@/lib/system-health';
import {
  BOOKS_STOCK_SYNC, copyNetSuiteStock, countsQuery, mapCounts, mapOpening, mapStockDocuments, OPENING_QUANTITY_QUERY, openingValueQuery,
  quantityString, STOCK_IDS_QUERY, stockDocumentsQuery, stockLinesQuery,
} from './netsuite-stock';

const LINKS = new Map([['2', 'BMG' as const], ['5', '1084' as const]]);

describe("the copy's queries", () => {
  it('reads the documents dated from 2025 with a line that moves stock, modified since the window opened, newest first', () => {
    const q = stockDocumentsQuery('2026-10-14T13:16:00Z', '5120');
    expect(q).toContain('SELECT DISTINCT t.id, t.type, t.tranid, t.trandate');
    expect(q).toContain("WHERE tl.isinventoryaffecting = 'T'");
    expect(q).toContain("t.trandate >= TO_DATE('01/01/2025', 'MM/DD/YYYY')");
    expect(q).toContain("t.lastmodifieddate >= TO_DATE('10/14/2026', 'MM/DD/YYYY')");
    expect(q).toContain('AND t.id < 5120');
    expect(q).toContain('ORDER BY t.id DESC');
    expect(stockDocumentsQuery('2026-10-14T13:16:00Z', null)).not.toContain('t.id <');
    // A stored cursor that isn't a NetSuite id never reaches the SQL.
    expect(stockDocumentsQuery('2026-10-14T13:16:00Z', '1; DROP')).not.toContain('DROP');
  });

  it("reads a page's lines that name an item, but main and tax lines, by NetSuite id only", () => {
    const q = stockLinesQuery(['11', 'x', '12']);
    expect(q).toContain('tl.quantity, tl.isinventoryaffecting AS moves_stock');
    expect(q).toContain('WHERE tl.transaction IN (11, 12)');
    expect(q).toContain("AND tl.item IS NOT NULL\n        AND tl.mainline = 'F'\n        AND tl.taxline = 'F'");
    expect(() => stockLinesQuery(['x'])).toThrow('No NetSuite ids to read');
    expect(STOCK_IDS_QUERY).toContain("WHERE tl.isinventoryaffecting = 'T'\n        AND t.trandate >= TO_DATE('01/01/2025', 'MM/DD/YYYY')");
  });

  it('starts each count from what moved before 2025, and its value from what posted to the inventory accounts then', () => {
    expect(OPENING_QUANTITY_QUERY).toContain("WHERE tl.isinventoryaffecting = 'T'\n        AND t.trandate < TO_DATE('01/01/2025', 'MM/DD/YYYY')");
    expect(OPENING_QUANTITY_QUERY).toContain('GROUP BY tl.subsidiary, tl.item, tl.location');
    const v = openingValueQuery(['190', '191']);
    expect(v).toContain('AND tal.account IN (190, 191)');
    expect(v).toContain("t.trandate < TO_DATE('01/01/2025', 'MM/DD/YYYY')");
    expect(() => openingValueQuery([])).toThrow('No NetSuite ids to read');
  });

  it("reads NetSuite's counts at each location with their value, without it, or company-wide", () => {
    expect(countsQuery('location_value')).toContain('ail.quantityonhand AS quantity, ail.onhandvaluemli AS value\n      FROM aggregateitemlocation ail');
    expect(countsQuery('location')).not.toContain('onhandvaluemli');
    expect(countsQuery('item')).toContain('SELECT i.id AS item_id, i.totalquantityonhand AS quantity');
  });
});

describe('quantityString', () => {
  it('keeps a quantity as a plain decimal string', () => {
    expect([3, -2.5, '4.000', '-0.50', '.25', '-.5', 0.1 + 0.2, 1e-7, '', null, -0, '-0.000'].map(quantityString))
      .toEqual(['3', '-2.5', '4', '-0.5', '0.25', '-0.5', '0.3', '0.0000001', '0', '0', '0', '0']);
    expect(quantityString('lots')).toBeNull();
  });
});

describe('mapStockDocuments', () => {
  const header = (id: number, fields: Record<string, unknown> = {}) => ({ id, type: 'ItemShip', tranid: `IF${id}`, trandate: '3/20/2025', ...fields });
  const line = (txn: number, id: number, fields: Record<string, unknown> = {}) => ({
    txn_id: txn, line_id: id, item_id: 9001, location_id: 11, subsidiary_id: 2, quantity: -3, moves_stock: 'T', ...fields,
  });

  it("keeps each document's lines that name an item for BMG and 1084, in line order", () => {
    const { documents, unreadable } = mapStockDocuments(
      [header(5002), header(5003, { type: 'InvTrnfr', tranid: null })],
      [
        line(5002, 2, { quantity: '-3', moves_stock: 'F' }),
        line(5002, 1),
        line(5003, 1, { quantity: -2, subsidiary_id: 5 }),
        line(5003, 2, { quantity: 2, location_id: null, subsidiary_id: 5 }),
        // Another subsidiary's line, and a line read twice.
        line(5003, 3, { subsidiary_id: 9 }),
        line(5003, 1, { quantity: -2, subsidiary_id: 5 }),
      ],
      LINKS,
    );
    expect(unreadable).toEqual([]);
    expect(documents).toEqual([
      {
        netsuite_id: '5002', tran_type: 'ItemShip', tranid: 'IF5002', trandate: '2025-03-20', lines: [
          { line_id: '1', company: 'BMG', item_id: '9001', location_id: '11', quantity: '-3', moves_stock: true },
          { line_id: '2', company: 'BMG', item_id: '9001', location_id: '11', quantity: '-3', moves_stock: false },
        ],
      },
      {
        netsuite_id: '5003', tran_type: 'InvTrnfr', tranid: null, trandate: '2025-03-20', lines: [
          { line_id: '1', company: '1084', item_id: '9001', location_id: '11', quantity: '-2', moves_stock: true },
          { line_id: '2', company: '1084', item_id: '9001', location_id: null, quantity: '2', moves_stock: true },
        ],
      },
    ]);
  });

  it('leaves out a document with nothing of BMG or 1084, and names the ones it would only copy in part', () => {
    const { documents, unreadable } = mapStockDocuments(
      [header(5004), header(5005), header(5006, { trandate: null }), header(5007)],
      [line(5004, 1, { subsidiary_id: 9 }), line(5005, 1, { quantity: 'lots' }), line(5006, 1), line(5007, 1)],
      LINKS,
    );
    expect(documents.map((d) => d.netsuite_id)).toEqual(['5007']);
    expect(unreadable).toEqual(['IF5005', 'IF5006']);
  });
});

describe('mapOpening', () => {
  it("puts each item's count and value at each location together, for BMG and 1084 only", () => {
    const { rows, skipped } = mapOpening(
      [
        { subsidiary_id: 2, item_id: 9001, location_id: 11, quantity: 10 },
        { subsidiary_id: 2, item_id: 9002, location_id: 11, quantity: 0 },
        { subsidiary_id: 9, item_id: 9001, location_id: 11, quantity: 4 },
        { subsidiary_id: 2, item_id: null, location_id: 11, quantity: 1 },
      ],
      [
        { subsidiary_id: 2, item_id: 9001, location_id: 11, debit: '1600', credit: 100 },
        { subsidiary_id: 2, item_id: 9003, location_id: null, debit: 0, credit: '0' },
        { subsidiary_id: 2, item_id: 9004, location_id: 12, debit: 'n/a', credit: 0 },
      ],
      LINKS,
    );
    expect(rows).toEqual([{ company: 'BMG', item_id: '9001', location_id: '11', quantity: '10', value: '1500.00' }]);
    expect(skipped).toBe(3);
  });
});

describe('mapCounts', () => {
  it("keeps NetSuite's count of each item and location, with its value when it gave one", () => {
    expect(mapCounts([
      { item_id: 9001, location_id: 11, quantity: 11, value: 1685 },
      { item_id: 9001, location_id: 12, quantity: '2.5', value: null },
      { item_id: 'x', location_id: 12, quantity: 1, value: 1 },
    ], 'location_value')).toEqual([
      { item_id: '9001', location_id: '11', quantity: '11', value: '1685.00' },
      { item_id: '9001', location_id: '12', quantity: '2.5', value: '0.00' },
    ]);
    expect(mapCounts([{ item_id: 9001, location_id: 11, quantity: 11, value: 1685 }], 'location'))
      .toEqual([{ item_id: '9001', location_id: '11', quantity: '11', value: null }]);
    expect(mapCounts([{ item_id: 9001, quantity: 14 }], 'item')).toEqual([{ item_id: '9001', location_id: null, quantity: '14', value: null }]);
  });
});

// ── The run ────────────────────────────────────────────────────────────────

type Rpc = { fn: string; p: any };

function fakeService(state: { last_synced_at?: string | null; last_result?: unknown } | null = null) {
  const calls: Rpc[] = [];
  const cursors: any[] = [];
  const service = {
    from: (table: string) => {
      if (table === 'sync_state') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state, error: null }) }) }),
          upsert: async (row: any) => { cursors.push(row.last_result); return { error: null }; },
        };
      }
      if (table === 'gl_companies') {
        return {
          select: async () => ({
            data: [{ code: 'BMG', name: 'BMG Fleet Installations', netsuite_subsidiary_id: '2' }, { code: '1084', name: '1084 Cool Springs', netsuite_subsidiary_id: '5' }],
            error: null,
          }),
        };
      }
      throw new Error(`no table ${table}`);
    },
    rpc: async (fn: string, args: any) => {
      calls.push({ fn, p: args?.p });
      if (fn === 'gl_stock_inventory_accounts') return { data: ['190'], error: null };
      if (fn === 'gl_netsuite_stock_apply') {
        const docs = args.p.documents as Array<{ lines: unknown[] }>;
        return { data: { added: docs.length, changed: 0, unchanged: 0, lines: docs.reduce((n, d) => n + d.lines.length, 0) }, error: null };
      }
      if (fn === 'gl_netsuite_stock_finish') return { data: { listed: args.p.netsuite_ids.length, here: 3, gone: 1, cut_short: false }, error: null };
      return { data: { rows: args.p.rows.length }, error: null };
    },
  };
  return { service: service as any, calls, cursors };
}

const refused = (field: string) => Object.assign(
  new Error(`NetSuite SuiteQL error (400): Search error occurred: Field '${field}' for record 'transactionLine' was not found.`),
  { status: 400 },
);

/** A made-up NetSuite: three stock documents, newest first, with a line each. */
function fakeNetSuite(opts: { refuse?: (q: string) => Error | null; advance?: number; clock: { t: number } }) {
  const headers = [5003, 5002, 5001].map((id) => ({ id, type: 'ItemRcpt', tranid: `IR${id}`, trandate: '2025-03-04' }));
  const seen: string[] = [];
  const answer = (q: string): Record<string, unknown>[] => {
    seen.push(q);
    const no = opts.refuse?.(q);
    if (no) throw no;
    if (q.includes('SELECT DISTINCT t.id, t.type')) {
      opts.clock.t += opts.advance ?? 1000;
      const below = Number(q.match(/t\.id < (\d+)/)?.[1] ?? Infinity);
      return headers.filter((h) => h.id < below);
    }
    if (q.includes('AS moves_stock')) {
      const ids = q.match(/IN \(([\d, ]+)\)/)![1].split(', ').map(Number);
      return ids.map((id) => ({ txn_id: id, line_id: 1, item_id: 9001, location_id: 11, subsidiary_id: 2, quantity: 2, moves_stock: 'T' }));
    }
    if (q.includes('SELECT DISTINCT tl.transaction AS id')) return headers.map((h) => ({ id: h.id }));
    if (q.includes('SUM(tl.quantity) AS quantity')) return [{ subsidiary_id: 2, item_id: 9001, location_id: 11, quantity: 10 }];
    if (q.includes('SUM(NVL(tal.debit, 0)) AS debit')) return [{ subsidiary_id: 2, item_id: 9001, location_id: 11, debit: 1500, credit: 0 }];
    if (q.includes('FROM aggregateitemlocation')) return [{ item_id: 9001, location_id: 11, quantity: 16, value: q.includes('onhandvaluemli') ? 2460 : undefined }];
    if (q.includes('FROM item i')) return [{ item_id: 9001, quantity: 16 }];
    throw new Error(`unexpected query: ${q}`);
  };
  return {
    seen,
    deps: (pageSize: number) => ({
      pageSize,
      now: () => opts.clock.t,
      page: async (q: string, limit: number) => answer(q).slice(0, limit),
      query: async (q: string) => answer(q),
    }),
  };
}

const heartbeat = () => vi.mocked(recordHeartbeat).mock.calls.at(-1)!;

describe('copyNetSuiteStock', () => {
  beforeEach(() => { vi.mocked(recordHeartbeat).mockClear(); });

  it('copies every page, drops what NetSuite no longer has, then reads where counts start and NetSuite\'s own counts', async () => {
    const clock = { t: Date.parse('2026-10-18T21:43:00Z') };
    const ns = fakeNetSuite({ clock });
    const { service, calls } = fakeService({ last_synced_at: '2026-10-18T19:43:00Z', last_result: {} });
    const result = await copyNetSuiteStock(service, { deadline: clock.t + 240_000, deps: ns.deps(2) });

    expect(result).toMatchObject({ read: 3, added: 3, changed: 0, unchanged: 0, lines: 3, gone: 1, opening: 1, counts: 1, countsBy: 'location' });
    expect(result.error).toBeUndefined();
    expect(result.partial).toBeUndefined();
    expect(result.notes).toBeUndefined();
    expect(calls.map((c) => c.fn)).toEqual([
      'gl_netsuite_stock_apply', 'gl_netsuite_stock_apply', 'gl_netsuite_stock_finish', 'gl_stock_inventory_accounts',
      'gl_netsuite_stock_store_opening', 'gl_netsuite_stock_store_counts',
    ]);
    expect(calls[0].p.documents.map((d: any) => d.netsuite_id)).toEqual(['5003', '5002']);
    expect(calls[1].p.documents.map((d: any) => d.netsuite_id)).toEqual(['5001']);
    expect(calls[2].p).toEqual({ netsuite_ids: ['5003', '5002', '5001'] });
    expect(calls[4].p).toEqual({ rows: [{ company: 'BMG', item_id: '9001', location_id: '11', quantity: '10', value: '1500.00' }] });
    expect(calls[5].p).toEqual({ rows: [{ item_id: '9001', location_id: '11', quantity: '16', value: '2460.00' }] });
    // The window opened a day before the last drained run, and the next one starts where this one opened.
    expect(ns.seen[0]).toContain("t.lastmodifieddate >= TO_DATE('10/17/2026', 'MM/DD/YYYY')");
    const [, syncType, recorded, hb] = heartbeat();
    expect(syncType).toBe(BOOKS_STOCK_SYNC);
    expect(recorded).not.toHaveProperty('resume');
    expect(hb).toMatchObject({ lastSyncedAt: '2026-10-18T21:43:00.000Z', records: 3 });
  });

  it('stops for time with its place saved, and carries on from it', async () => {
    const clock = { t: Date.parse('2026-10-18T21:43:00Z') };
    const ns = fakeNetSuite({ clock, advance: 230_000 });
    const { service, calls, cursors } = fakeService(null);
    const result = await copyNetSuiteStock(service, { deadline: clock.t + 240_000, deps: ns.deps(2) });

    expect(result).toMatchObject({ read: 2, added: 2, partial: true });
    expect(calls.map((c) => c.fn)).toEqual(['gl_netsuite_stock_apply']);
    // The first run reaches back to every document.
    expect(ns.seen[0]).toContain("t.lastmodifieddate >= TO_DATE('12/31/1999', 'MM/DD/YYYY')");
    const [, , recorded, hb] = heartbeat();
    expect((recorded as any).resume).toMatchObject({ beforeId: '5002', since: '1999-12-31T00:00:00.000Z', processed: 2 });
    expect(cursors[0].resume.beforeId).toBe('5002');
    expect(hb).toMatchObject({ touchLastSyncedAt: false });

    // The next run picks up below 5002.
    const next = fakeNetSuite({ clock });
    const again = fakeService({ last_synced_at: null, last_result: recorded });
    const carried = await copyNetSuiteStock(again.service, { deadline: clock.t + 240_000, deps: next.deps(2) });
    expect(next.seen[0]).toContain('AND t.id < 5002');
    expect(carried).toMatchObject({ read: 1, added: 1 });
    expect(again.calls[0].p.documents.map((d: any) => d.netsuite_id)).toEqual(['5001']);
  });

  it("copies nothing when NetSuite won't say which lines move stock, and says so", async () => {
    const clock = { t: Date.parse('2026-10-18T21:43:00Z') };
    const ns = fakeNetSuite({ clock, refuse: (q) => (q.includes('isinventoryaffecting') ? refused('isinventoryaffecting') : null) });
    const { service, calls } = fakeService(null);
    const result = await copyNetSuiteStock(service, { deadline: clock.t + 240_000, deps: ns.deps(2) });
    expect(result.error).toMatch(/^stock documents from the newest: NetSuite won't say which lines move stock \(transactionline\.isinventoryaffecting\)/);
    expect(calls).toEqual([]);
    expect(heartbeat()[3]).toMatchObject({ touchLastSyncedAt: false });
  });

  it("falls back to NetSuite's counts without value, then company-wide, and keeps the last ones when it gets none", async () => {
    const run = async (refuse: (q: string) => Error | null) => {
      const clock = { t: Date.parse('2026-10-18T21:43:00Z') };
      const { service, calls } = fakeService(null);
      const result = await copyNetSuiteStock(service, { deadline: clock.t + 240_000, deps: fakeNetSuite({ clock, refuse }).deps(5) });
      return { result, stored: calls.find((c) => c.fn === 'gl_netsuite_stock_store_counts')?.p };
    };

    const noValue = await run((q) => (q.includes('onhandvaluemli') ? refused('onhandvaluemli') : null));
    expect(noValue.result).toMatchObject({ counts: 1, countsBy: 'location' });
    expect(noValue.result.notes).toEqual(["NetSuite wouldn't give each item's value at each location, so only counts are compared."]);
    expect(noValue.stored).toEqual({ rows: [{ item_id: '9001', location_id: '11', quantity: '16', value: null }] });

    const companyWide = await run((q) => (q.includes('aggregateitemlocation') ? refused('aggregateitemlocation') : null));
    expect(companyWide.result).toMatchObject({ counts: 1, countsBy: 'item' });
    expect(companyWide.stored).toEqual({ rows: [{ item_id: '9001', location_id: null, quantity: '16', value: null }] });

    const none = await run((q) => (q.includes('aggregateitemlocation') || q.includes('FROM item i') ? refused('quantityonhand') : null));
    expect(none.stored).toBeUndefined();
    expect(none.result.counts).toBeUndefined();
    expect(none.result.notes![0]).toMatch(/^NetSuite wouldn't give its own counts \(NetSuite SuiteQL error \(400\)/);
    expect(none.result.error).toBeUndefined();
  });
});
