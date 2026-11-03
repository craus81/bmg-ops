import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));

import { suiteqlQueryAll } from '@/lib/netsuite';
import {
  fulfillmentPayload,
  KIT_DEPTH,
  keptType,
  kitPartsOf,
  kitStockParts,
  mapOrderLines,
  orderKitParts,
  orderLinesQuery,
  ORDER_READ_TIMEOUT_MS,
  readKitParts,
  readOnce,
  readOrderLines,
  readSalesOrderStock,
  saveOwnFulfillment,
  takeKitsApart,
  withKitParts,
  withOrderLocations,
  workOutOwnFulfillment,
  type FulfilledLine,
  type KitPartLine,
  type ListedItem,
  type OrderLine,
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

  it("takes each line from where it says, or the copy's; a copy from NetSuite's order is where all its lines are, if one place", () => {
    const line = (salesOrderLineId: string, locationId: string | null) => ({
      itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart' as const, quantity: 1, salesOrderLineId, locationId,
    });
    // Told where to take every line from, each line is taken from there.
    const sent = workOutOwnFulfillment(input({ locationId: '1', locationFrom: 'sent', lines: [line('1', null), line('2', null)] }));
    expect(sent).toMatchObject({ locationId: '1', locationFrom: 'sent', unknowns: [] });
    expect(sent.lines.map((l) => l.locationId)).toEqual(['1', '1']);
    // From NetSuite's order: where every line is, when that's one place.
    const order = (lines: ReturnType<typeof line>[] | null) => workOutOwnFulfillment(input({ locationId: null, locationFrom: 'order', lines }));
    expect(order([line('1', '2'), line('2', '2')])).toMatchObject({ locationId: '2', locationFrom: 'order', unknowns: [] });
    // Two places: none for the copy, each line its own, nothing unknown.
    const two = order([line('1', '1'), line('2', '2')]);
    expect(two).toMatchObject({ locationId: null, locationFrom: 'order', unknowns: [] });
    expect(two.lines.map((l) => l.locationId)).toEqual(['1', '2']);
    // A line the order doesn't place leaves where it took stock from unknown, but says where from.
    expect(order([line('1', '1'), line('2', null)])).toMatchObject({ locationId: null, locationFrom: 'order', unknowns: ['location'] });
    expect(order([line('1', null)])).toMatchObject({ locationId: null, locationFrom: 'order', unknowns: ['location'] });
    // Where nothing was taken from doesn't matter.
    expect(order([])).toMatchObject({ locationId: null, locationFrom: 'order', unknowns: [] });
    expect(order(null)).toMatchObject({ locationId: null, locationFrom: 'order', unknowns: ['lines'] });
  });

  it('writes the copy as the database takes it', () => {
    expect(fulfillmentPayload(workOutOwnFulfillment(input({ madeBy: 'u-1' })))).toEqual({
      netsuite_id: '7001', netsuite_number: 'IF7001', company: 'BMG', made_from: 'vehicle', made_from_id: 'checkin-1',
      sales_order_id: '700', customer_netsuite_id: '9001', fulfil_date: '2026-10-19', location_netsuite_id: '1',
      location_from: 'customer_rule', unknowns: [], made_by: 'u-1',
      lines: [{
        line_no: 1, item_netsuite_id: '55', item_number: 'SHELF-1', description: 'Shelf', item_type: 'InvtPart', quantity: 2,
        sales_order_line_id: '1', kit_netsuite_id: null, location_netsuite_id: '1',
      }],
    });
    // A kit's part says which kit it was taken for, and each line where it was taken from.
    const part = fulfillmentPayload(workOutOwnFulfillment(input({
      locationId: null,
      locationFrom: 'order',
      lines: [
        { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 4, salesOrderLineId: '3', kitId: '70', locationId: '2' },
        { itemId: '56', itemNumber: 'RACK-1', description: null, itemType: 'InvtPart', quantity: 1, salesOrderLineId: '4' },
      ],
    })));
    expect(part).toMatchObject({ location_netsuite_id: null, location_from: 'order', unknowns: ['location'] });
    expect(part.lines).toEqual([{
      line_no: 1, item_netsuite_id: '55', item_number: 'SHELF-1', description: null, item_type: 'InvtPart', quantity: 4,
      sales_order_line_id: '3', kit_netsuite_id: '70', location_netsuite_id: '2',
    }, {
      line_no: 2, item_netsuite_id: '56', item_number: 'RACK-1', description: null, item_type: 'InvtPart', quantity: 1,
      sales_order_line_id: '4', kit_netsuite_id: null, location_netsuite_id: null,
    }]);
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
    // Every item the order names, billed or not and whatever its type, for telling whether it names a kit's part.
    expect(so.items).toEqual([
      { lineId: '1', itemId: '55' }, { lineId: '2', itemId: '56' }, { lineId: '3', itemId: '59' }, { lineId: '4', itemId: '57' },
      { lineId: '5', itemId: '60' }, { lineId: '7', itemId: '55' }, { lineId: '8', itemId: '55' }, { lineId: '10', itemId: '61' },
    ]);
  });

  it("has no lines for an order FleetSuite hasn't copied yet, and doesn't look up items for an order without any", async () => {
    const { service, queries } = fakeService(database({ netsuite_sales_order_lines: [] }));
    expect(await readSalesOrderStock(service, '701')).toEqual({ customerNetsuiteId: null, customerName: null, lines: null, items: [] });
    expect(await readSalesOrderStock(service, '700')).toEqual({ customerNetsuiteId: '9001', customerName: 'Sample Fleet Co', lines: [], items: [] });
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
  // NetSuite's order lists no kit's parts unless a test says so.
  beforeEach(() => { vi.mocked(suiteqlQueryAll).mockResolvedValue([]); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("copies a finished vehicle's fulfillment from FleetSuite's copy of the order, each line from where NetSuite's order has it", async () => {
    // NetSuite's order has the shelf at O'Fallon and the kit at Wentzville: one read of it serves the kit and where each line is.
    vi.mocked(suiteqlQueryAll).mockClear().mockResolvedValue([
      { line_id: '1', item_id: '55', quantity: '-2', kit_line_id: null, location_id: '1' },
      { line_id: '2', item_id: '56', quantity: '-3', kit_line_id: null, location_id: '1' },
      { line_id: '3', item_id: '57', quantity: '-1', kit_line_id: null, location_id: 2 },
    ]);
    const { service, rpc, queries } = fakeService(database());
    const r = await saveOwnFulfillment(service, {
      netsuiteId: '7001', netsuiteNumber: 'IF7001', madeFrom: 'vehicle', madeFromId: 'checkin-1', madeBy: 'u-1', salesOrderId: '700',
    }, AT);
    expect(r).toEqual({ saved: true });
    expect(rpc).toHaveBeenCalledWith('gl_own_fulfillment_save', expect.anything());
    expect(payloadOf(rpc)).toMatchObject({
      netsuite_id: '7001', netsuite_number: 'IF7001', made_from: 'vehicle', made_from_id: 'checkin-1', made_by: 'u-1',
      // Two places, so none for the copy: each line says.
      sales_order_id: '700', customer_netsuite_id: '9001', location_netsuite_id: null, location_from: 'order',
      // 10:30 PM Central on the 19th.
      fulfil_date: '2026-10-19', unknowns: [],
    });
    expect(payloadOf(rpc).lines.map((l: Row) => [l.line_no, l.item_number, l.item_type, l.quantity, l.location_netsuite_id])).toEqual([
      [1, 'SHELF-1', 'InvtPart', 2, '1'],
      [2, 'RACK-KIT', 'Kit', 1, '2'],
    ]);
    expect(suiteqlQueryAll).toHaveBeenCalledTimes(1);
    expect(suiteqlQueryAll).toHaveBeenCalledWith(orderLinesQuery('700'), 1000, { retries: 1 });
    // Where FleetSuite books the invoice doesn't come into it.
    expect(queries.some((q) => q.table === 'gl_netsuite_lists' && q.filters.some(([, , v]) => v === 'location'))).toBe(false);
  });

  it("takes a kit apart before saving: as NetSuite's order lists its parts, else as the lists copy has them unless the order names one", async () => {
    // Two rack kits, which NetSuite's order lists four shelves under; FleetSuite's copy of the order has that line too.
    const db = database({
      netsuite_sales_order_lines: [soLine('1', '55', 2, 0), soLine('3', '57', 2, 0), soLine('4', '55', 4, 0)],
    });
    (db.gl_netsuite_lists as Row[])[2].details = { item_type: 'Kit', parts: [{ item: '55', quantity: 1 }] };
    vi.mocked(suiteqlQueryAll).mockClear().mockResolvedValue([
      { line_id: '1', item_id: '55', quantity: '-2', kit_line_id: null, location_id: '1' },
      { line_id: '3', item_id: '57', quantity: '-2', kit_line_id: null, location_id: '2' },
      { line_id: '4', item_id: '55', quantity: '-4', kit_line_id: '3', location_id: '1' },
    ]);
    const fromOrder = fakeService(db);
    await saveOwnFulfillment(fromOrder.service, { netsuiteId: '7007', madeFrom: 'vehicle', salesOrderId: '700' }, AT);
    expect(suiteqlQueryAll).toHaveBeenCalledTimes(1);
    expect(suiteqlQueryAll).toHaveBeenCalledWith(orderLinesQuery('700'), 1000, { retries: 1 });
    // A kit's parts are taken from where the order has the kit.
    expect(payloadOf(fromOrder.rpc).lines.map((l: Row) => [l.line_no, l.item_number, l.quantity, l.sales_order_line_id, l.kit_netsuite_id, l.location_netsuite_id])).toEqual([
      [1, 'SHELF-1', 2, '1', null, '1'],
      [2, 'SHELF-1', 4, '3', '57', '2'],
    ]);

    // With no parts listed on NetSuite's order, the lists copy's would do, but the order names a shelf on a line of its own.
    vi.mocked(suiteqlQueryAll).mockResolvedValue([]);
    const fromList = fakeService({ ...db, netsuite_sales_order_lines: [soLine('1', '55', 2, 0), soLine('3', '57', 2, 0)] });
    await saveOwnFulfillment(fromList.service, { netsuiteId: '7008', madeFrom: 'vehicle', salesOrderId: '700' }, AT);
    expect(payloadOf(fromList.rpc).lines.map((l: Row) => [l.item_number, l.item_type, l.quantity, l.kit_netsuite_id])).toEqual([
      ['SHELF-1', 'InvtPart', 2, null],
      ['RACK-KIT', 'Kit', 2, null],
    ]);
  });

  it('takes every line from where FleetSuite told NetSuite to ship it from, reading NetSuite\'s order only for a kit', async () => {
    vi.mocked(suiteqlQueryAll).mockClear();
    const { service, rpc, queries } = fakeService(database({ netsuite_sales_order_lines: [soLine('1', '55', 2, 0), soLine('2', '56', 3, 0)] }));
    await saveOwnFulfillment(service, { netsuiteId: '7002', madeFrom: 'sales_order', madeFromId: 'po-1', salesOrderId: '700', locationId: 2 }, AT);
    expect(payloadOf(rpc)).toMatchObject({ made_from: 'sales_order', location_netsuite_id: '2', location_from: 'sent', unknowns: [] });
    expect(payloadOf(rpc).lines.map((l: Row) => l.location_netsuite_id)).toEqual(['2']);
    expect(suiteqlQueryAll).not.toHaveBeenCalled();
    expect(queries.some((q) => q.table === 'gl_netsuite_lists' && q.filters.some(([, , v]) => v === 'location'))).toBe(false);

    // A kit's parts, as the order lists them, from there too, though the order has the kit somewhere else.
    vi.mocked(suiteqlQueryAll).mockResolvedValue([
      { line_id: '1', item_id: '55', quantity: '-2', kit_line_id: null, location_id: '1' },
      { line_id: '3', item_id: '57', quantity: '-1', kit_line_id: null, location_id: '1' },
      { line_id: '4', item_id: '55', quantity: '-3', kit_line_id: '3', location_id: '1' },
    ]);
    const kit = fakeService(database({ netsuite_sales_order_lines: [soLine('1', '55', 2, 0), soLine('3', '57', 1, 0), soLine('4', '55', 3, 0)] }));
    await saveOwnFulfillment(kit.service, { netsuiteId: '7012', madeFrom: 'sales_order', salesOrderId: '700', locationId: '2' }, AT);
    expect(payloadOf(kit.rpc)).toMatchObject({ location_netsuite_id: '2', location_from: 'sent', unknowns: [] });
    expect(payloadOf(kit.rpc).lines.map((l: Row) => [l.item_number, l.quantity, l.kit_netsuite_id, l.location_netsuite_id])).toEqual([
      ['SHELF-1', 2, null, '2'],
      ['SHELF-1', 3, '57', '2'],
    ]);
    expect(suiteqlQueryAll).toHaveBeenCalledTimes(1);
  });

  it("takes a Masterack order's stock from where NetSuite's order has it, not where its invoice would book", async () => {
    const db = database();
    (db.netsuite_sales_orders as Row[])[0].customer_name = 'Masterack LLC';
    vi.mocked(suiteqlQueryAll).mockResolvedValue([
      { line_id: '1', item_id: '55', quantity: '-2', kit_line_id: null, location_id: '1' },
      { line_id: '3', item_id: '57', quantity: '-1', kit_line_id: null, location_id: '1' },
    ]);
    const masterack = fakeService(db);
    await saveOwnFulfillment(masterack.service, { netsuiteId: '7003', madeFrom: 'vehicle', salesOrderId: '700' }, AT);
    expect(payloadOf(masterack.rpc)).toMatchObject({ location_netsuite_id: '1', location_from: 'order', unknowns: [] });
  });

  it("says it didn't know where it took stock from when NetSuite's order can't be read or doesn't say, nor the lines of an order it hasn't copied", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shelfOnly = () => fakeService(database({ netsuite_sales_order_lines: [soLine('1', '55', 2, 0)] }));
    const saved = async (rows: Record<string, unknown>[] | Error, id: string) => {
      if (rows instanceof Error) vi.mocked(suiteqlQueryAll).mockRejectedValue(rows);
      else vi.mocked(suiteqlQueryAll).mockResolvedValue(rows);
      const { service, rpc } = shelfOnly();
      expect(await saveOwnFulfillment(service, { netsuiteId: id, madeFrom: 'vehicle', salesOrderId: '700' }, AT)).toEqual({ saved: true });
      expect(payloadOf(rpc)).toMatchObject({ location_netsuite_id: null, location_from: 'order', unknowns: ['location'] });
      expect(payloadOf(rpc).lines.map((l: Row) => l.location_netsuite_id)).toEqual([null]);
    };
    await saved(new Error('NetSuite SuiteQL error (503): Service unavailable'), '7003');
    expect(error).toHaveBeenCalledWith(
      "[books] where NetSuite's sales order 700 has its lines couldn't be read, so where the copy took them from isn't known: NetSuite SuiteQL error (503): Service unavailable",
    );
    await saved([{ line_id: 'x', item_id: '55', quantity: '-2' }], '7004');
    expect(error).toHaveBeenCalledWith("[books] NetSuite's sales order 700 couldn't be read whole, so where the copy took its lines from isn't known");
    // A line the order doesn't place, or doesn't have.
    await saved([{ line_id: '1', item_id: '55', quantity: '-2', kit_line_id: null, location_id: null }], '7005');
    await saved([{ line_id: '9', item_id: '55', quantity: '-2', kit_line_id: null, location_id: '1' }], '7006');

    vi.mocked(suiteqlQueryAll).mockClear();
    const uncopied = fakeService(database());
    await saveOwnFulfillment(uncopied.service, { netsuiteId: '7008', madeFrom: 'vehicle', salesOrderId: '701' }, AT);
    expect(payloadOf(uncopied.rpc)).toMatchObject({ customer_netsuite_id: null, lines: [], location_from: 'order', unknowns: ['lines'] });
    // Nothing to place, so NetSuite's order isn't read.
    expect(suiteqlQueryAll).not.toHaveBeenCalled();
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

// ── Taking a kit apart ─────────────────────────────────────────────────────

const listed = (number: string, type: string | null, parts: { item: string; quantity: number }[] | null = null, displayName: string | null = null): ListedItem => ({
  number, type, displayName, parts,
});
const kitLine = (itemId: string, quantity: number, salesOrderLineId: string | null = '3'): FulfilledLine => ({
  itemId, itemNumber: null, description: null, itemType: 'Kit', quantity, salesOrderLineId,
});
const part = (itemId: string, quantity: number, itemType: KitPartLine['itemType'] = 'InvtPart', itemNumber: string | null = null): KitPartLine => ({
  itemId, itemNumber, description: null, itemType, quantity,
});

describe("a kit's parts as the lists copy keeps them", () => {
  it('reads them whole, or not at all', () => {
    expect(kitPartsOf({ item_type: 'Kit', parts: [{ item: '55', quantity: 2 }, { item: 61, quantity: '0.5' }] }))
      .toEqual([{ item: '55', quantity: 2 }, { item: '61', quantity: 0.5 }]);
    for (const details of [null, undefined, {}, { parts: [] }, { parts: 'all of them' }]) expect(kitPartsOf(details as any)).toBeNull();
    // One part it can't read leaves the kit's parts not known: a kit taken apart short would be wrong.
    for (const bad of [{ item: 'SHELF-1', quantity: 1 }, { item: '55', quantity: 0 }, { item: '55', quantity: -1 }, { item: '55' }, null]) {
      expect(kitPartsOf({ parts: [{ item: '61', quantity: 1 }, bad] })).toBeNull();
    }
  });

  it('takes a kit apart into what moves stock, a kit inside it taken apart too, an item held twice one part', () => {
    const items = new Map<string, ListedItem | null>([
      ['70', listed('SHELF-KIT', 'Kit', [{ item: '55', quantity: 2 }, { item: '56', quantity: 1 }, { item: '60', quantity: 1 }])],
      ['72', listed('BOX-KIT', 'Kit', [{ item: '70', quantity: 3 }, { item: '55', quantity: 1 }, { item: '61', quantity: 0.5 }])],
      ['55', listed('SHELF-1', 'InvtPart', null, 'Shelf')],
      ['56', listed('LABOR', 'Service')],
      ['61', listed('RACK-ASM', 'Assembly')],
      ['60', null],
    ]);
    // The service moves no stock; the item the lists copy doesn't have may, so it's kept, its type unknown.
    expect(kitStockParts('70', items)).toEqual([part('55', 2, 'InvtPart', 'SHELF-1'), part('60', 1, null)].map((p, i) => (i === 0 ? { ...p, description: 'Shelf' } : p)));
    expect(kitStockParts('72', items)).toEqual([
      { itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf', itemType: 'InvtPart', quantity: 7 },
      part('60', 3, null),
      part('61', 0.5, 'Assembly', 'RACK-ASM'),
    ]);
    // A kit of services only takes nothing from stock.
    expect(kitStockParts('73', new Map([['73', listed('LABOR-KIT', 'Kit', [{ item: '56', quantity: 2 }])], ['56', listed('LABOR', 'Service')]]))).toEqual([]);
  });

  it("doesn't take apart what it can't take apart whole", () => {
    const items = new Map<string, ListedItem | null>([
      ['70', listed('SHELF-KIT', 'Kit', [{ item: '55', quantity: 2 }, { item: '74', quantity: 1 }])],
      ['74', listed('INNER-KIT', 'Kit')],
      ['75', listed('LOOP-KIT', 'Kit', [{ item: '76', quantity: 1 }])],
      ['76', listed('LOOP-KIT-2', 'Kit', [{ item: '75', quantity: 1 }])],
      ['77', listed('UNREAD-KIT', 'Kit', [{ item: '78', quantity: 1 }])],
      ['55', listed('SHELF-1', 'InvtPart')],
      ['61', listed('RACK-ASM', 'Assembly', [{ item: '55', quantity: 4 }])],
    ]);
    expect(kitStockParts('70', items)).toBeNull(); // a kit inside it whose parts aren't known
    expect(kitStockParts('74', items)).toBeNull(); // no parts
    expect(kitStockParts('75', items)).toBeNull(); // a kit inside itself
    expect(kitStockParts('77', items)).toBeNull(); // a part that wasn't read
    expect(kitStockParts('61', items)).toBeNull(); // an assembly is taken whole
    expect(kitStockParts('99', items)).toBeNull(); // not read at all
    expect(kitStockParts('55', new Map([['55', null]]))).toBeNull();
  });

  it(`takes kits inside kits apart ${KIT_DEPTH} deep, no deeper`, () => {
    const chain = (depth: number) => {
      const items = new Map<string, ListedItem | null>([['55', listed('SHELF-1', 'InvtPart')]]);
      for (let i = 0; i < depth; i++) items.set(String(80 + i), listed(`KIT-${i}`, 'Kit', [{ item: i === depth - 1 ? '55' : String(81 + i), quantity: 2 }]));
      return items;
    };
    expect(kitStockParts('80', chain(KIT_DEPTH))).toEqual([part('55', 2 ** KIT_DEPTH, 'InvtPart', 'SHELF-1')]);
    expect(kitStockParts('80', chain(KIT_DEPTH + 1))).toBeNull();
  });
});

describe("a kit's lines taken apart", () => {
  it("makes each part the kit's quantity times what one kit holds, on the kit's line, saying which kit", () => {
    const lines: FulfilledLine[] = [
      { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 1, salesOrderLineId: '1' },
      kitLine('70', 1.5),
      kitLine('57', 1, '4'),
      kitLine('73', 2, '5'),
      kitLine('58', 1, '6'),
    ];
    const parts = new Map<string, KitPartLine[] | null | undefined>([
      ['70', [part('55', 2, 'InvtPart', 'SHELF-1'), part('60', 0.33335, null)]],
      ['57', null],
      ['73', []],
    ]);
    expect(withKitParts(lines, (k) => parts.get(k.itemId))).toEqual([
      lines[0],
      { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 3, salesOrderLineId: '3', kitId: '70' },
      // To the four places the copy keeps.
      { itemId: '60', itemNumber: null, description: null, itemType: null, quantity: 0.5, salesOrderLineId: '3', kitId: '70' },
      // A kit whose parts aren't known stays as it is; one of services only takes nothing.
      lines[2],
      lines[4],
    ]);
    // A line that isn't a kit is never asked about.
    const asked = vi.fn(() => [part('61', 1)]);
    expect(withKitParts([lines[0]], asked)).toEqual([lines[0]]);
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("the parts NetSuite's sales order lists for a kit", () => {
  it('asks NetSuite for every item line of the order, and refuses anything but an id', () => {
    const q = orderLinesQuery('700');
    expect(q).toMatch(/SELECT tl\.id AS line_id, tl\.item AS item_id, tl\.quantity, tl\.kitmemberof AS kit_line_id, tl\.location AS location_id\s+FROM transactionline tl/);
    expect(q).toMatch(/WHERE tl\.transaction = 700\s+AND tl\.mainline = 'F'\s+AND tl\.taxline = 'F'\s+AND tl\.item IS NOT NULL\s+ORDER BY tl\.id\s*$/);
    expect(() => orderLinesQuery('700 OR 1=1')).toThrow('Not a NetSuite sales order id');
  });

  it("reads NetSuite's lines whole or not at all", () => {
    expect(mapOrderLines([
      { line_id: 3, item_id: '70', quantity: '-2', kit_line_id: null, location_id: '2' },
      { line_id: '4', item_id: 55, quantity: -4, kit_line_id: 3, location_id: 1 },
      { line_id: '9', item_id: '90', quantity: null, kit_line_id: '' },
      // A location it can't read is one it doesn't know, which doesn't spoil the rest.
      { line_id: '10', item_id: '90', quantity: '-1', location_id: "O'Fallon" },
    ])).toEqual([
      // NetSuite keeps a sale's quantities below nothing.
      { lineId: '3', itemId: '70', quantity: 2, kitLineId: null, locationId: '2' },
      { lineId: '4', itemId: '55', quantity: 4, kitLineId: '3', locationId: '1' },
      // A subtotal's line is for nothing.
      { lineId: '9', itemId: '90', quantity: 0, kitLineId: null, locationId: null },
      { lineId: '10', itemId: '90', quantity: 1, kitLineId: null, locationId: null },
    ]);
    for (const bad of [{ line_id: 'x', item_id: '55', quantity: 1 }, { line_id: '4', item_id: null, quantity: 1 }, { line_id: '4', item_id: '55', quantity: 'some' },
      { line_id: '4', item_id: '55', quantity: 1, kit_line_id: 'kit' }]) {
      expect(mapOrderLines([{ line_id: '3', item_id: '70', quantity: 1 }, bad])).toBeNull();
    }
  });

  it('reads them with a SuiteQL query, writing nothing', async () => {
    vi.mocked(suiteqlQueryAll).mockResolvedValueOnce([{ line_id: '4', item_id: '55', quantity: '-4', kit_line_id: '3', location_id: '1' }]);
    expect(await readOrderLines('700')).toEqual([{ lineId: '4', itemId: '55', quantity: 4, kitLineId: '3', locationId: '1' }]);
    expect(suiteqlQueryAll).toHaveBeenLastCalledWith(orderLinesQuery('700'), 1000, { retries: 1 });
  });

  it('gives up on NetSuite after a while, leaving no timer behind: the billing screen is waiting', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(suiteqlQueryAll).mockReturnValueOnce(new Promise(() => {}));
      const read = readOrderLines('700');
      const failed = read.catch((err: Error) => err.message);
      let done = false;
      void failed.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(ORDER_READ_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await failed).toBe("NetSuite didn't answer within 6 seconds");
      expect(ORDER_READ_TIMEOUT_MS).toBe(6000);
      vi.mocked(suiteqlQueryAll).mockResolvedValueOnce([]);
      expect(await readOrderLines('700')).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  const ol = (lineId: string, itemId: string, quantity: number, kitLineId: string | null = null): OrderLine => ({ lineId, itemId, quantity, kitLineId, locationId: null });
  const types = new Map<string, ListedItem | null>([
    ['70', listed('SHELF-KIT', 'Kit')],
    ['74', listed('INNER-KIT', 'Kit')],
    ['55', listed('SHELF-1', 'InvtPart', null, 'Shelf')],
    ['56', listed('LABOR', 'Service')],
    ['61', listed('RACK-ASM', 'Assembly')],
    ['60', null],
  ]);

  it("takes each kit line's parts from the lines under it, a kit inside it too, each its quantity over the kit's", () => {
    const order = [
      ol('1', '55', 1),
      ol('3', '70', 2),
      ol('4', '55', 4, '3'),
      ol('5', '56', 2, '3'),
      ol('6', '60', 1, '3'),
      ol('7', '74', 2, '3'),
      ol('8', '61', 6, '7'),
      ol('9', '55', 2, '7'),
    ];
    const kits = orderKitParts(order, types)!;
    expect(kits.get('3')).toEqual({
      parts: [
        // An item held twice is one part; a service moves no stock; one the lists copy doesn't have may.
        { itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf', itemType: 'InvtPart', quantity: 3 },
        part('60', 0.5, null),
        part('61', 3, 'Assembly', 'RACK-ASM'),
      ],
      lines: ['4', '5', '6', '7', '8', '9'],
    });
    expect(kits.has('1')).toBe(false);
  });

  it("leaves a kit whole when its parts can't be used whole, and trusts nothing that doesn't hang together", () => {
    // A kit inside it with no lines under it; a kit of nothing.
    expect(orderKitParts([ol('3', '70', 1), ol('4', '74', 1, '3')], types)!.get('3')).toEqual({ parts: null, lines: ['4'] });
    expect(orderKitParts([ol('3', '70', 0), ol('4', '55', 1, '3')], types)!.get('3')).toEqual({ parts: null, lines: [] });
    // A part of a line the order doesn't have, of a line that isn't a kit, or of itself.
    expect(orderKitParts([ol('3', '70', 1), ol('4', '55', 1, '2')], types)).toBeNull();
    expect(orderKitParts([ol('1', '55', 1), ol('4', '55', 1, '1')], types)).toBeNull();
    expect(orderKitParts([ol('3', '70', 1, '3')], types)).toBeNull();
    expect(orderKitParts([ol('3', '70', 1), ol('4', '55', 1, '3')], new Map([['55', types.get('55')!]]))).toBeNull();
    // An order with no kit's parts lists none.
    expect(orderKitParts([ol('1', '55', 1), ol('3', '70', 1)], types)).toEqual(new Map());
  });

  it(`takes kits inside kits apart ${KIT_DEPTH} deep, no deeper`, () => {
    const chain = (depth: number) => {
      const order = [ol('100', '80', 1)];
      const items = new Map<string, ListedItem | null>([['55', listed('SHELF-1', 'InvtPart')]]);
      for (let i = 0; i < depth; i++) {
        items.set(String(80 + i), listed(`KIT-${i}`, 'Kit'));
        if (i > 0) order.push(ol(String(100 + i), String(80 + i), 2 ** i, String(100 + i - 1)));
      }
      order.push(ol('199', '55', 2 ** depth, String(100 + depth - 1)));
      return orderKitParts(order, items)!.get('100')!.parts;
    };
    expect(chain(KIT_DEPTH)).toEqual([part('55', 2 ** KIT_DEPTH, 'InvtPart', 'SHELF-1')]);
    expect(chain(KIT_DEPTH + 1)).toBeNull();
  });
});

describe('reading the lists copy for kits', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads the kits, then what they hold, a level at a time', async () => {
    const { service, queries } = fakeService({
      gl_netsuite_lists: [
        { kind: 'item', netsuite_id: '72', name: 'BOX-KIT', details: { item_type: 'Kit', parts: [{ item: '70', quantity: 1 }, { item: '71', quantity: 2 }] } },
        { kind: 'item', netsuite_id: '70', name: 'SHELF-KIT', details: { item_type: 'Kit', display_name: ' Shelf kit ', parts: [{ item: '55', quantity: 2 }] } },
        { kind: 'item', netsuite_id: '71', name: 'LADDER', details: { item_type: 'InvtPart', display_name: 'Ladder' } },
        { kind: 'item', netsuite_id: '55', name: 'SHELF-1', details: { item_type: 'InvtPart' } },
        { kind: 'item', netsuite_id: '57', name: 'RACK-KIT', details: { item_type: 'Kit' } },
      ],
    });
    const parts = await readKitParts(service, ['72', '57', '58', '72']);
    expect(parts).toEqual(new Map<string, KitPartLine[] | null>([
      ['72', [part('55', 2, 'InvtPart', 'SHELF-1'), { itemId: '71', itemNumber: 'LADDER', description: 'Ladder', itemType: 'InvtPart', quantity: 2 }]],
      ['57', null],
      ['58', null],
    ]));
    expect(queries.map((q) => q.filters)).toEqual([
      [['eq', 'kind', 'item'], ['in', 'netsuite_id', ['72', '57', '58']]],
      [['eq', 'kind', 'item'], ['in', 'netsuite_id', ['70', '71']]],
      [['eq', 'kind', 'item'], ['in', 'netsuite_id', ['55']]],
    ]);
  });

  it(`keeps a part the copy doesn't have, its type not known, and reads kits inside kits ${KIT_DEPTH} deep`, async () => {
    // 80 holds 81, which holds 82, and so on to 84, which holds a shelf: five kits deep. 85 holds 80: six.
    const chain = ['80', '81', '82', '83', '84'].map((id, i, all) => ({
      kind: 'item', netsuite_id: id, name: `KIT-${id}`, details: { item_type: 'Kit', parts: [{ item: all[i + 1] ?? '55', quantity: 1 }] },
    }));
    const { service, queries } = fakeService({
      gl_netsuite_lists: [
        ...chain,
        { kind: 'item', netsuite_id: '85', name: 'KIT-85', details: { item_type: 'Kit', parts: [{ item: '80', quantity: 1 }] } },
        { kind: 'item', netsuite_id: '73', name: 'NEW-KIT', details: { item_type: 'Kit', parts: [{ item: '55', quantity: 1 }, { item: '99', quantity: 3 }] } },
        { kind: 'item', netsuite_id: '55', name: 'SHELF-1', details: { item_type: 'InvtPart' } },
      ],
    });
    expect(await readKitParts(service, ['73'])).toEqual(new Map([['73', [
      part('55', 1, 'InvtPart', 'SHELF-1'),
      { itemId: '99', itemNumber: null, description: null, itemType: null, quantity: 3 },
    ]]]));
    // The part it doesn't have isn't asked for again.
    expect(queries.map((q) => q.filters[1][2])).toEqual([['73'], ['55', '99']]);
    expect(await readKitParts(service, ['80'])).toEqual(new Map([['80', [part('55', 1, 'InvtPart', 'SHELF-1')]]]));
    expect(await readKitParts(service, ['85'])).toEqual(new Map([['85', null]]));
  });

  it("keeps every kit whole when the copy can't be read, and says so", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service } = fakeService({ gl_netsuite_lists: { error: 'statement timeout' } });
    expect(await readKitParts(service, ['70', '57'])).toEqual(new Map([['70', null], ['57', null]]));
    expect(error).toHaveBeenCalledWith("[books] the parts of 70, 57 couldn't be read, so the kits are kept whole: statement timeout");
  });
});

describe('taking the kits on a fulfillment apart', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const LISTS = [
    { kind: 'item', netsuite_id: '70', name: 'SHELF-KIT', details: { item_type: 'Kit', parts: [{ item: '55', quantity: 2 }, { item: '71', quantity: 1 }] } },
    { kind: 'item', netsuite_id: '55', name: 'SHELF-1', details: { item_type: 'InvtPart' } },
    { kind: 'item', netsuite_id: '71', name: 'LADDER', details: { item_type: 'InvtPart' } },
    { kind: 'item', netsuite_id: '56', name: 'LABOR', details: { item_type: 'Service' } },
  ];
  const shelf = (quantity: number, salesOrderLineId: string): FulfilledLine => ({
    itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity, salesOrderLineId,
  });
  const ol = (lineId: string, itemId: string, quantity: number, kitLineId: string | null = null): OrderLine => ({ lineId, itemId, quantity, kitLineId, locationId: null });

  it("takes a kit's parts as NetSuite's order lists them, its part lines on the copy going", async () => {
    const { service, queries } = fakeService({ gl_netsuite_lists: LISTS });
    // NetSuite's order has the kit's parts as it was when the order was entered: here one ladder fewer than the kit holds now.
    const readOrder = vi.fn(async () => [ol('1', '55', 1), ol('3', '70', 2), ol('4', '55', 4, '3'), ol('5', '56', 2, '3')]);
    const lines = [shelf(1, '1'), kitLine('70', 2), shelf(4, '4')];
    expect(await takeKitsApart(service, '700', lines, [], readOrder)).toEqual([
      shelf(1, '1'),
      { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 4, salesOrderLineId: '3', kitId: '70' },
    ]);
    expect(readOrder).toHaveBeenCalledWith('700');
    // Only the order's parts and kits are looked up: not the kit's parts as the lists copy has them.
    expect(queries.map((q) => q.filters)).toEqual([[['eq', 'kind', 'item'], ['in', 'netsuite_id', ['55', '70', '56']]]]);
  });

  it("takes another kit apart as the lists copy has it, though one of its parts is a part of a kit the order lists", async () => {
    const { service } = fakeService({
      gl_netsuite_lists: [...LISTS, { kind: 'item', netsuite_id: '57', name: 'RACK-KIT', details: { item_type: 'Kit', parts: [{ item: '55', quantity: 1 }] } }],
    });
    const readOrder = vi.fn(async () => [ol('3', '70', 1), ol('4', '55', 2, '3'), ol('6', '57', 1)]);
    const named = [{ lineId: '3', itemId: '70' }, { lineId: '4', itemId: '55' }, { lineId: '6', itemId: '57' }];
    expect(await takeKitsApart(service, '700', [kitLine('70', 1), shelf(2, '4'), kitLine('57', 1, '6')], named, readOrder)).toEqual([
      { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 2, salesOrderLineId: '3', kitId: '70' },
      { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 1, salesOrderLineId: '6', kitId: '57' },
    ]);
  });

  it('takes a kit the order lists no parts for apart as the lists copy has it, unless the order also names one of them', async () => {
    const { service } = fakeService({ gl_netsuite_lists: LISTS });
    const readOrder = vi.fn(async () => [ol('3', '70', 1)]);
    expect(await takeKitsApart(service, '700', [kitLine('70', 1)], [{ lineId: '3', itemId: '70' }], readOrder)).toEqual([
      { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 2, salesOrderLineId: '3', kitId: '70' },
      { itemId: '71', itemNumber: 'LADDER', description: null, itemType: 'InvtPart', quantity: 1, salesOrderLineId: '3', kitId: '70' },
    ]);
    // A ladder on a line of its own may be the kit's, as the order lists it: the kit stays whole.
    const named = [{ lineId: '3', itemId: '70' }, { lineId: '9', itemId: '71' }];
    expect(await takeKitsApart(service, '700', [kitLine('70', 1)], named, readOrder)).toEqual([kitLine('70', 1)]);
  });

  it("falls back on the lists copy when NetSuite's order can't be read or doesn't hang together, and says so", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service } = fakeService({ gl_netsuite_lists: LISTS });
    const taken = [
      { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 2, salesOrderLineId: '3', kitId: '70' },
      { itemId: '71', itemNumber: 'LADDER', description: null, itemType: 'InvtPart', quantity: 1, salesOrderLineId: '3', kitId: '70' },
    ];
    const failing = vi.fn(async () => { throw new Error('NetSuite SuiteQL error (400): Unknown identifier kitmemberof'); });
    expect(await takeKitsApart(service, '700', [kitLine('70', 1)], [], failing)).toEqual(taken);
    expect(error).toHaveBeenCalledWith("[books] the kit parts NetSuite's sales order 700 lists couldn't be read: NetSuite SuiteQL error (400): Unknown identifier kitmemberof");
    expect(await takeKitsApart(service, '700', [kitLine('70', 1)], [], vi.fn(async () => null))).toEqual(taken);
    const tangled = vi.fn(async () => [ol('3', '70', 1), ol('4', '55', 2, '8')]);
    expect(await takeKitsApart(service, '700', [kitLine('70', 1)], [], tangled)).toEqual(taken);
    expect(error).toHaveBeenCalledWith("[books] the kit parts NetSuite's sales order 700 lists don't hang together, so the copy of NetSuite's items is used");
  });

  it("keeps a kit whole, and its lines, when the parts the order lists can't be used whole", async () => {
    const { service } = fakeService({ gl_netsuite_lists: [...LISTS, { kind: 'item', netsuite_id: '74', name: 'INNER-KIT', details: { item_type: 'Kit' } }] });
    const readOrder = vi.fn(async () => [ol('3', '70', 1), ol('4', '55', 2, '3'), ol('5', '74', 1, '3')]);
    const lines = [kitLine('70', 1), shelf(2, '4')];
    expect(await takeKitsApart(service, '700', lines, [], readOrder)).toEqual(lines);
    // Not taken apart as the lists copy has it either, though another line of the same kit is: its part lines would count twice.
    const another = vi.fn(async () => [ol('3', '70', 1), ol('4', '55', 2, '3'), ol('5', '74', 1, '3'), ol('6', '70', 1)]);
    expect(await takeKitsApart(service, '700', [...lines, kitLine('70', 1, '6')], [], another)).toEqual([
      ...lines,
      { itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 2, salesOrderLineId: '6', kitId: '70' },
      { itemId: '71', itemNumber: 'LADDER', description: null, itemType: 'InvtPart', quantity: 1, salesOrderLineId: '6', kitId: '70' },
    ]);
  });

  it('reads nothing for a fulfillment without a kit', async () => {
    const { service, queries } = fakeService({ gl_netsuite_lists: LISTS });
    const readOrder = vi.fn(async () => []);
    expect(await takeKitsApart(service, '700', [shelf(1, '1')], [], readOrder)).toEqual([shelf(1, '1')]);
    expect(readOrder).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
});

describe('where each line was taken from', () => {
  const at = (lineId: string, locationId: string | null): OrderLine => ({ lineId, itemId: '55', quantity: 1, kitLineId: null, locationId });
  const line = (salesOrderLineId: string | null, kitId: string | null = null): FulfilledLine => ({
    itemId: '55', itemNumber: 'SHELF-1', description: null, itemType: 'InvtPart', quantity: 1, salesOrderLineId, kitId,
  });

  it("takes each line from where NetSuite's order has it, a kit's part from the kit's line, and knows nothing it isn't told", () => {
    const order = [at('1', '1'), at('3', '2'), at('4', null)];
    expect(withOrderLocations([line('1'), line('3', '70'), line('4'), line('9'), line(null)], order).map((l) => [l.salesOrderLineId, l.locationId])).toEqual([
      ['1', '1'],
      // The kit's part, on the kit's line.
      ['3', '2'],
      // The order doesn't say, doesn't have the line, or the line isn't on it.
      ['4', null],
      ['9', null],
      [null, null],
    ]);
    // An order that couldn't be read says nothing, whatever the line said before.
    expect(withOrderLocations([{ ...line('1'), locationId: '2' }], null)).toEqual([{ ...line('1'), locationId: null }]);
  });

  it("reads NetSuite's order once, however often it's asked for, an order at a time", async () => {
    const read = vi.fn(async (id: string) => [at(id, '1')]);
    const once = readOnce(read);
    const [a, b] = await Promise.all([once('700'), once('700')]);
    expect(a).toBe(b);
    expect(await once('701')).toEqual([at('701', '1')]);
    expect(read.mock.calls).toEqual([['700'], ['701']]);
    // A failed read fails each time it's asked for, without reading again.
    const failing = vi.fn(async () => { throw new Error('timed out'); });
    const failingOnce = readOnce(failing);
    await expect(failingOnce('700')).rejects.toThrow('timed out');
    await expect(failingOnce('700')).rejects.toThrow('timed out');
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

describe('the ways FleetSuite invoices a sales order', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  /** The saveOwnFulfillment call in a file, up to the end of its arguments. */
  const saveCall = (file: string) => {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    const at = text.indexOf('await saveOwnFulfillment(');
    expect(at).toBeGreaterThan(-1);
    return text.slice(at, text.indexOf('});', at));
  };

  it('say where every line was taken from only when FleetSuite told NetSuite: fulfilling a whole order, the copy reads it', () => {
    // fulfillSalesOrder: NetSuite takes each line from where its sales order has it, so the copy reads that.
    expect(saveCall('src/app/api/netsuite/create-invoice/route.ts')).not.toMatch(/locationId/);
    expect(saveCall('src/app/api/vehicle-tracking/invoice/route.ts')).not.toMatch(/locationId/);
    // Fulfill & Invoice ships every line from O'Fallon.
    expect(saveCall('src/lib/so-fulfill-invoice-run.ts')).toMatch(/locationId: OFALLON,/);
  });
});
