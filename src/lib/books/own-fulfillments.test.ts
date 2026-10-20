import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));

import {
  fulfillmentPayload,
  keptType,
  readSalesOrderStock,
  saveOwnFulfillment,
  workOutOwnFulfillment,
  type OwnFulfillmentInput,
} from './own-fulfillments';

const input = (over: Partial<OwnFulfillmentInput> = {}): OwnFulfillmentInput => ({
  netsuiteId: '7001',
  netsuiteNumber: 'IF7001',
  madeFrom: 'vehicle',
  madeFromId: 'checkin-1',
  salesOrderId: '700',
  customerNetsuiteId: '9001',
  locationId: '1',
  locationFrom: 'customer_rule',
  fulfilDate: '2026-10-19',
  lines: [{ itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf', itemType: 'InvtPart', quantity: 2, salesOrderLineId: '1' }],
  madeBy: null,
  ...over,
});

describe("working out FleetSuite's own fulfillment", () => {
  it('numbers the lines it took from stock in order, leaving out a line of nothing', () => {
    const own = workOutOwnFulfillment(input({
      lines: [
        { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 0, salesOrderLineId: '1' },
        { itemId: '56', itemNumber: 'RACK-1', description: null, itemType: 'Assembly', quantity: 1.5, salesOrderLineId: '2' },
        { itemId: '57', itemNumber: 'KIT-1', description: null, itemType: 'Kit', quantity: 1, salesOrderLineId: '3' },
        { itemId: '58', itemNumber: null, description: null, itemType: 'InvtPart', quantity: Number.NaN, salesOrderLineId: '4' },
      ],
    }));
    expect(own.lines.map((l) => [l.lineNo, l.itemId, l.quantity])).toEqual([[1, '56', 1.5], [2, '57', 1]]);
    expect(own.unknowns).toEqual([]);
  });

  it("says what it didn't know rather than guess: the lines, and where it took stock from", () => {
    expect(workOutOwnFulfillment(input({ lines: null }))).toMatchObject({ lines: [], unknowns: ['lines'] });
    // No location says no rule put it anywhere.
    expect(workOutOwnFulfillment(input({ locationId: null, locationFrom: 'customer_rule' })))
      .toMatchObject({ locationId: null, locationFrom: null, unknowns: ['location'] });
    expect(workOutOwnFulfillment(input({ lines: null, locationId: null })).unknowns).toEqual(['lines', 'location']);
  });

  it('writes the copy as the database takes it', () => {
    expect(fulfillmentPayload(workOutOwnFulfillment(input({ madeBy: 'u-1' })))).toEqual({
      netsuite_id: '7001', netsuite_number: 'IF7001', company: 'BMG', made_from: 'vehicle', made_from_id: 'checkin-1',
      sales_order_id: '700', customer_netsuite_id: '9001', fulfil_date: '2026-10-19', location_netsuite_id: '1',
      location_from: 'customer_rule', unknowns: [], made_by: 'u-1',
      lines: [{ line_no: 1, item_netsuite_id: '55', item_number: 'SHELF-1', description: 'Shelf', item_type: 'InvtPart', quantity: 2, sales_order_line_id: '1' }],
    });
  });

  it('keeps the items that can move stock: kept in stock, a kit, or one the lists copy has no type for', () => {
    expect(['InvtPart', 'Assembly', 'Kit'].map(keptType)).toEqual(['InvtPart', 'Assembly', 'Kit']);
    expect(keptType(null)).toBeNull();
    expect(keptType('')).toBeNull();
    for (const type of ['Service', 'NonInvtPart', 'Discount', 'Markup', 'OthCharge', 'Subtotal', 'Description']) expect(keptType(type)).toBeUndefined();
  });
});

// ── Reading what FleetSuite knows, against a fake database ────────────────

type Row = Record<string, unknown>;
type Filter = ['eq' | 'in', string, unknown];
interface Query { table: string; filters: Filter[]; single: boolean }

/** Answers supabase-js reads from rows per table (or an error for the table), and records each read. */
function fakeService(tables: Record<string, Row[] | { error: string }>, rpcAnswer: { data?: unknown; error?: { message: string } } = { data: { saved: true, lines: 1 } }) {
  const queries: Query[] = [];
  const answer = (q: Query) => {
    const t = tables[q.table];
    if (t === undefined) throw new Error(`unexpected table ${q.table}`);
    if (!Array.isArray(t)) return { data: null, error: { message: t.error } };
    const rows = t.filter((row) => q.filters.every(([op, col, v]) => (
      op === 'eq' ? String(row[col]) === String(v) : (v as unknown[]).map(String).includes(String(row[col]))
    )));
    return q.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
  };
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: rpcAnswer.data ?? null, error: rpcAnswer.error ?? null }));
  const service = {
    from(table: string) {
      const q: Query = { table, filters: [], single: false };
      queries.push(q);
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => { q.filters.push(['eq', c, v]); return b; },
        in: (c: string, v: unknown[]) => { q.filters.push(['in', c, v]); return b; },
        maybeSingle: async () => { q.single = true; return answer(q); },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => answer(q)).then(res, rej),
      };
      return b;
    },
    rpc,
  };
  return { service: service as unknown as SupabaseClient, queries, rpc };
}

const SO_ID = 'a0000000-0000-4000-8000-000000000700';
const soLine = (line: string, item: string | null, quantity: number | string, billed: number | string, itemNumber: string | null = null) => ({
  so_id: SO_ID, line_id: line, item_netsuite_id: item, item_number: itemNumber, description: null, quantity, quantity_billed: billed,
});

const database = (over: Record<string, Row[] | { error: string }> = {}) => ({
  gl_netsuite_lists: [
    { kind: 'item', netsuite_id: '55', name: 'SHELF-1', details: { item_type: 'InvtPart' } },
    { kind: 'item', netsuite_id: '56', name: 'LABOR', details: { item_type: 'Service' } },
    { kind: 'item', netsuite_id: '57', name: 'RACK-KIT', details: { item_type: 'Kit' } },
    { kind: 'item', netsuite_id: '59', name: 'DECAL-1', details: { item_type: 'NonInvtPart' } },
    { kind: 'item', netsuite_id: '61', name: 'RACK-ASM', details: { item_type: 'Assembly' } },
    { kind: 'location', netsuite_id: '1', name: "O'Fallon" },
    { kind: 'location', netsuite_id: '2', name: 'Wentzville' },
  ],
  netsuite_sales_orders: [{ id: SO_ID, netsuite_id: '700', customer_netsuite_id: '9001', customer_name: 'Sample Fleet Co' }],
  netsuite_sales_order_lines: [
    soLine('2', '56', 3, 0),
    soLine('1', '55', 2, 0),
    soLine('3', '57', 1, 0),
  ],
  ...over,
});

describe('reading what a sales order still had to bill, of the items that can move stock', () => {
  it("takes each open line of an item that can move stock, in the order's order, for the order's customer", async () => {
    const { service } = fakeService(database({
      netsuite_sales_order_lines: [
        soLine('10', '61', '1', '0'),
        soLine('2', '56', 3, 0),
        soLine('1', '55', 5, 2, 'SHELF-1 (old)'),
        soLine('3', '59', 4, 0),
        soLine('4', '57', 1, 0),
        soLine('5', '60', 2, 0),
        soLine('6', null, 1, 0),
        soLine('7', '55', 1, 1),
        soLine('8', '55', '0.33335', '0'),
      ],
    }));
    const so = await readSalesOrderStock(service, '700');
    expect(so).toMatchObject({ customerNetsuiteId: '9001', customerName: 'Sample Fleet Co' });
    expect(so.lines).toEqual([
      // What the order still had to bill, under the number the order gave the line.
      { itemId: '55', itemNumber: 'SHELF-1 (old)', description: null, itemType: 'InvtPart', quantity: 3, salesOrderLineId: '1' },
      { itemId: '57', itemNumber: 'RACK-KIT', description: null, itemType: 'Kit', quantity: 1, salesOrderLineId: '4' },
      // An item the lists copy doesn't have yet may move stock, so it's kept, its type unknown.
      { itemId: '60', itemNumber: null, description: null, itemType: null, quantity: 2, salesOrderLineId: '5' },
      { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 0.3334, salesOrderLineId: '8' },
      { itemId: '61', itemNumber: 'RACK-ASM', description: null, itemType: 'Assembly', quantity: 1, salesOrderLineId: '10' },
    ]);
  });

  it("has no lines for an order FleetSuite hasn't copied yet, and doesn't look up items for an order without any", async () => {
    const { service, queries } = fakeService(database({ netsuite_sales_order_lines: [] }));
    expect(await readSalesOrderStock(service, '701')).toEqual({ customerNetsuiteId: null, customerName: null, lines: null });
    expect(await readSalesOrderStock(service, '700')).toEqual({ customerNetsuiteId: '9001', customerName: 'Sample Fleet Co', lines: [] });
    expect(queries.filter((q) => q.table === 'gl_netsuite_lists')).toEqual([]);
  });

  it('fails whole when a read fails', async () => {
    for (const table of ['netsuite_sales_orders', 'netsuite_sales_order_lines', 'gl_netsuite_lists']) {
      const { service } = fakeService(database({ [table]: { error: `${table} timed out` } }));
      await expect(readSalesOrderStock(service, '700')).rejects.toThrow(`${table} timed out`);
    }
  });
});

describe('saving the copy', () => {
  const AT = new Date('2026-10-20T03:30:00Z');
  const payloadOf = (rpc: ReturnType<typeof fakeService>['rpc']) => (rpc.mock.calls[0][1] as { p: Record<string, any> }).p;
  afterEach(() => { vi.restoreAllMocks(); });

  it("copies a finished vehicle's fulfillment from FleetSuite's copy of the order, where the invoice location rule books it", async () => {
    const { service, rpc } = fakeService(database());
    const r = await saveOwnFulfillment(service, {
      netsuiteId: '7001', netsuiteNumber: 'IF7001', madeFrom: 'vehicle', madeFromId: 'checkin-1', madeBy: 'u-1', salesOrderId: '700',
    }, AT);
    expect(r).toEqual({ saved: true });
    expect(rpc).toHaveBeenCalledWith('gl_own_fulfillment_save', expect.anything());
    expect(payloadOf(rpc)).toMatchObject({
      netsuite_id: '7001', netsuite_number: 'IF7001', made_from: 'vehicle', made_from_id: 'checkin-1', made_by: 'u-1',
      sales_order_id: '700', customer_netsuite_id: '9001', location_netsuite_id: '1', location_from: 'customer_rule',
      // 10:30 PM Central on the 19th.
      fulfil_date: '2026-10-19', unknowns: [],
    });
    expect(payloadOf(rpc).lines.map((l: Row) => [l.line_no, l.item_number, l.item_type, l.quantity])).toEqual([[1, 'SHELF-1', 'InvtPart', 2], [2, 'RACK-KIT', 'Kit', 1]]);
  });

  it("takes stock from where the PO location rule books a sales order's installed quantities, without reading the locations", async () => {
    const { service, rpc, queries } = fakeService(database());
    await saveOwnFulfillment(service, { netsuiteId: '7002', madeFrom: 'sales_order', madeFromId: 'po-1', salesOrderId: '700', locationId: 2 }, AT);
    expect(payloadOf(rpc)).toMatchObject({ made_from: 'sales_order', location_netsuite_id: '2', location_from: 'po_rule', unknowns: [] });
    expect(queries.some((q) => q.table === 'gl_netsuite_lists' && q.filters.some(([, , v]) => v === 'location'))).toBe(false);
  });

  it("says it didn't know where a Masterack order took stock from when the rule isn't sure, nor the lines of an order it hasn't copied", async () => {
    const db = database();
    (db.netsuite_sales_orders as Row[])[0].customer_name = 'Masterack LLC';
    const masterack = fakeService(db);
    await saveOwnFulfillment(masterack.service, { netsuiteId: '7003', madeFrom: 'vehicle', salesOrderId: '700' }, AT);
    expect(payloadOf(masterack.rpc)).toMatchObject({ location_netsuite_id: null, location_from: null, unknowns: ['location'] });

    const uncopied = fakeService(database());
    await saveOwnFulfillment(uncopied.service, { netsuiteId: '7004', madeFrom: 'vehicle', salesOrderId: '701' }, AT);
    expect(payloadOf(uncopied.rpc)).toMatchObject({ customer_netsuite_id: null, lines: [], unknowns: ['lines', 'location'] });
  });

  it('never throws: a fulfillment with no id or order, a failed read or a refused save is only logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service, rpc, queries } = fakeService(database());
    expect(await saveOwnFulfillment(service, { netsuiteId: undefined, madeFrom: 'vehicle', salesOrderId: '700' }))
      .toEqual({ saved: false, reason: "NetSuite didn't say which fulfillment it made" });
    expect(await saveOwnFulfillment(service, { netsuiteId: 'IF7001', madeFrom: 'vehicle', salesOrderId: '700' })).toMatchObject({ saved: false });
    expect(await saveOwnFulfillment(service, { netsuiteId: '7001', madeFrom: 'vehicle', salesOrderId: 'SO700' }))
      .toEqual({ saved: false, reason: 'No sales order was named' });
    expect(queries).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();

    const failing = fakeService(database({ netsuite_sales_order_lines: { error: 'statement timeout' } }));
    expect(await saveOwnFulfillment(failing.service, { netsuiteId: '7005', madeFrom: 'vehicle', salesOrderId: '700' }, AT))
      .toEqual({ saved: false, reason: 'statement timeout' });
    expect(failing.rpc).not.toHaveBeenCalled();

    const refused = fakeService(database(), { error: { message: 'new row violates check constraint' } });
    expect(await saveOwnFulfillment(refused.service, { netsuiteId: '7006', madeFrom: 'vehicle', salesOrderId: '700' }, AT))
      .toEqual({ saved: false, reason: 'new row violates check constraint' });
    expect(error).toHaveBeenCalledWith('[books] own copy of NetSuite fulfillment 7006 not saved: new row violates check constraint');
  });

  it('says so when the fulfillment was already saved', async () => {
    const { service } = fakeService(database(), { data: { saved: false, lines: 0 } });
    expect(await saveOwnFulfillment(service, { netsuiteId: '7001', madeFrom: 'vehicle', salesOrderId: '700' }, AT)).toEqual({ saved: false, reason: 'already saved' });
  });
});
