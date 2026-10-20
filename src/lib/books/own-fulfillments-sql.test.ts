// migration 418 keeps FleetSuite's own copy of each fulfillment it makes and
// puts it next to NetSuite's, with what FleetSuite counted of each item just
// before. This runs migrations 314, 359–363, 401–405 and 407 with 416 in an
// in-memory Postgres (PGlite) as the app's server login, saves copies worked
// out by src/lib/books/own-fulfillments.ts, copies made-up NetSuite stock
// documents and their GL lines the way stock by item has them, and holds
// what gl_own_fulfillment_save, gl_own_fulfillment_pairs and
// gl_own_fulfillment_months do and return, then checks the pairs end to end.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));

import { fulfillmentPayload, workOutOwnFulfillment, type OwnFulfillmentInput } from './own-fulfillments';
import { checkOwnFulfillments, type FulfilPairsData } from './own-fulfillment-check';

const OFALLON = '1';
const WENTZVILLE = '2';
const LADDER = '9001';
const BINS = '9002';
const RACK_KIT = '9200';
/** The items' inventory account, and the accounts the other sides of their documents post to. */
const INVENTORY = '190';
const COGS = '580';
const RECEIVED = '210';

async function freshDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    -- What migrations 314, 407 and 416 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE TABLE public.netsuite_sales_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), netsuite_id TEXT NOT NULL UNIQUE, tranid TEXT,
      customer_netsuite_id TEXT, customer_name TEXT
    );
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '401-books-stock-by-item.sql',
    '402-books-stock-values.sql', '403-books-stock-item-setup.sql', '404-books-stock-ledger-parts.sql',
    '405-books-stock-account-items.sql', '407-books-own-invoices.sql', '416-books-own-fulfillments.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('item', '${LADDER}', 'LDR-24', true, '{"display_name": "Ladder rack 24 in", "item_type": "InvtPart", "asset_account": "${INVENTORY}"}'),
      ('item', '${BINS}', 'BIN-10', true, '{"item_type": "InvtPart", "asset_account": "${INVENTORY}"}'),
      ('item', '${RACK_KIT}', 'RACK-KIT', true, '{"item_type": "Kit"}'),
      ('location', '${OFALLON}', 'O''Fallon', true, '{"subsidiary_id": "2"}'),
      ('location', '${WENTZVILLE}', 'Wentzville', true, '{"subsidiary_id": "2"}');
    INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id) VALUES
      ('19000', 'Inventory Asset', 'other_current_asset', '${INVENTORY}'),
      ('58000', 'Cost of Goods Sold', 'cost_of_goods_sold', '${COGS}');
    INSERT INTO netsuite_sales_orders (netsuite_id, tranid, customer_netsuite_id, customer_name)
      VALUES ('6001', 'SO6001', '9001', 'Acme Fleet');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
const save = (pg: PGlite, p: Record<string, unknown>) => call<{ saved: boolean; lines: number }>(pg, 'gl_own_fulfillment_save', p);
const pairs = (pg: PGlite, from: string | null, to: string | null, id: string | null = null) =>
  one<FulfilPairsData>(pg, 'SELECT gl_own_fulfillment_pairs($1::date, $2::date, $3) AS r', [from, to, id]);
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

/** A stock line as the copy hands it over: [line, item, location, quantity, moves stock]. */
type StockLine = [line: string, item: string, location: string | null, quantity: string, moves: boolean];
const doc = (id: string, type: string, number: string, date: string, lines: StockLine[]) => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date,
  lines: lines.map(([line_id, item_id, location_id, quantity, moves_stock]) => ({ line_id, company: 'BMG', item_id, location_id, quantity, moves_stock })),
});

/** What NetSuite posted for a document, in the GL copy: [line, account, cents debit positive]. */
async function gl(pg: PGlite, id: string, type: string, date: string, lines: Array<[string, string, number]>) {
  const month = `${date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $1, $3, $4, 'x', 's')`,
    [id, type, date, month],
  );
  for (const [line, account, cents] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = 'BMG'`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0'],
    );
  }
}

const input = (over: Partial<OwnFulfillmentInput> = {}): OwnFulfillmentInput => ({
  netsuiteId: '7001',
  netsuiteNumber: 'IF7001',
  madeFrom: 'vehicle',
  madeFromId: 'checkin-1',
  salesOrderId: '6001',
  customerNetsuiteId: '9001',
  locationId: WENTZVILLE,
  locationFrom: 'customer_rule',
  fulfilDate: '2026-10-19',
  lines: [{ itemId: LADDER, itemNumber: 'LDR-24', description: 'Ladder rack', itemType: 'InvtPart', quantity: 3, salesOrderLineId: '2' }],
  madeBy: null,
  ...over,
});
const payload = (over: Partial<OwnFulfillmentInput> = {}) => fulfillmentPayload(workOutOwnFulfillment(input(over)));

// Two ladder racks were in Wentzville on December 31, 2024 at $140 each. In
// 2026: a receipt of ten at $150, someone's fulfillment of two in NetSuite
// (its cost line names the item but doesn't move it), and a receipt of four
// at $160 dated October 1 that NetSuite was given after FleetSuite's
// fulfillment (a higher id): it still comes before it. A receipt of five at
// $200 the same day as FleetSuite's fulfillment, after it, doesn't.
const RECEIPT = doc('5001', 'ItemRcpt', 'IR5001', '2026-01-05', [['1', LADDER, WENTZVILLE, '10', true]]);
const OTHER_FULFILLMENT = doc('5002', 'ItemShip', 'IF5002', '2026-02-10', [
  ['1', LADDER, WENTZVILLE, '-2', true], ['2', LADDER, WENTZVILLE, '-2', false],
]);
const OWN_TWIN = doc('7001', 'ItemShip', 'IF7001', '2026-10-19', [
  ['1', LADDER, WENTZVILLE, '-3', true], ['2', LADDER, WENTZVILLE, '-3', false],
]);
const LATER_SAME_DAY = doc('7002', 'ItemRcpt', 'IR7002', '2026-10-19', [['1', LADDER, WENTZVILLE, '5', true]]);
const BACKDATED = doc('7003', 'ItemRcpt', 'IR7003', '2026-10-01', [['1', LADDER, WENTZVILLE, '4', true]]);

describe("migration 418: FleetSuite's own fulfillments", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await gl(pg, '5001', 'ItemRcpt', '2026-01-05', [['0', RECEIVED, -150000], ['1', INVENTORY, 150000]]);
    // 2 at (280 + 1500) / 12 = 148.33 each.
    await gl(pg, '5002', 'ItemShip', '2026-02-10', [['1', INVENTORY, -29667], ['2', COGS, 29667]]);
    await gl(pg, '7002', 'ItemRcpt', '2026-10-19', [['0', RECEIVED, -100000], ['1', INVENTORY, 100000]]);
    await gl(pg, '7003', 'ItemRcpt', '2026-10-01', [['0', RECEIVED, -64000], ['1', INVENTORY, 64000]]);
    expect(await call(pg, 'gl_netsuite_stock_apply', { documents: [RECEIPT, OTHER_FULFILLMENT, LATER_SAME_DAY, BACKDATED] }))
      .toMatchObject({ received: 4, added: 4 });
    expect(await call(pg, 'gl_netsuite_stock_store_opening', {
      rows: [{ company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '2', value: '280.00' }],
    })).toEqual({ rows: 1 });
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('saves a copy of what FleetSuite took from stock, once', async () => {
    expect(await save(pg, payload())).toEqual({ saved: true, lines: 1 });
    const head = (await pg.query<Record<string, unknown>>(`SELECT * FROM gl_own_fulfillments WHERE netsuite_id = '7001'`)).rows[0];
    expect(head).toMatchObject({
      netsuite_number: 'IF7001', made_from: 'vehicle', made_from_id: 'checkin-1', sales_order_id: '6001',
      customer_netsuite_id: '9001', location_netsuite_id: WENTZVILLE, location_from: 'customer_rule', unknowns: [],
    });
    const lines = (await pg.query<Record<string, unknown>>(
      `SELECT line_no, item_netsuite_id, item_type, quantity::text AS quantity, sales_order_line_id FROM gl_own_fulfillment_lines WHERE fulfillment_id = '7001'`,
    )).rows;
    expect(lines).toEqual([{ line_no: 1, item_netsuite_id: LADDER, item_type: 'InvtPart', quantity: '3.0000', sales_order_line_id: '2' }]);

    // Saving the same fulfillment again changes nothing.
    expect(await save(pg, payload({ netsuiteNumber: 'IF9999', lines: [] }))).toEqual({ saved: false, lines: 0 });
    expect(await one(pg, `SELECT netsuite_number AS r FROM gl_own_fulfillments WHERE netsuite_id = '7001'`)).toBe('IF7001');
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_fulfillment_lines WHERE fulfillment_id = '7001'`)).toBe(1);
  });

  it("refuses a copy that isn't whole", async () => {
    const p = payload({ netsuiteId: '7010' });
    const lines = p.lines as Array<Record<string, unknown>>;
    await expect(save(pg, { ...p, netsuite_id: 'IF7010' })).rejects.toThrow(/NetSuite's id/);
    await expect(save(pg, { ...p, company: 'XYZ' })).rejects.toThrow(/doesn't exist/);
    await expect(save(pg, { ...p, lines: 'none' })).rejects.toThrow(/must be a list/);
    await expect(save(pg, { ...p, made_from: 'scans' })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, sales_order_id: 'SO6001' })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, unknowns: ['guesses'] })).rejects.toThrow(/check/i);
    // A location says where it came from, and nothing says where no location came from.
    await expect(save(pg, { ...p, location_from: null })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, location_netsuite_id: null })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, lines: [{ ...lines[0], quantity: 0 }] })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, lines: [{ ...lines[0], item_type: 'Service' }] })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, lines: [{ ...lines[0], item_netsuite_id: null }] })).rejects.toThrow(/null/i);
    // Nothing of a refused copy is kept.
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_fulfillments WHERE netsuite_id = '7010'`)).toBe(0);
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_fulfillment_lines WHERE fulfillment_id = '7010'`)).toBe(0);
  });

  it("waits for NetSuite's fulfillment, then counts what came before it: by date, then NetSuite's id", async () => {
    let data = await pairs(pg, '2026-10-01', '2026-10-31');
    expect(data.fulfillments).toHaveLength(1);
    const [waiting] = data.fulfillments;
    expect(waiting.netsuite).toBeNull();
    expect(waiting.netsuite_gl).toBeNull();
    expect(waiting.sales_order).toEqual({ number: 'SO6001', customer_name: 'Acme Fleet' });
    expect(waiting.invoice).toBeNull();
    // 2 + 10 - 2 + 4, worth 280 + 1500 - 296.67 + 640: not the receipt later the same day.
    expect(waiting.before).toEqual([{ item_id: LADDER, location_id: WENTZVILLE, quantity: '14', value: '2123.33' }]);
    const copies = { stock: null, ledger: null };
    expect(checkOwnFulfillments(data, copies).fulfillments[0]).toMatchObject({ status: 'waiting', fleetsuiteCost: 45500, netsuiteCost: null });

    // NetSuite's copy of it: 3 at 2123.33 / 14 = 151.6664 each, 455.00.
    await call(pg, 'gl_netsuite_stock_apply', { documents: [OWN_TWIN] });
    data = await pairs(pg, null, null, '7001');
    expect(data.fulfillments[0].netsuite).toEqual({
      number: 'IF7001', type: 'ItemShip', date: '2026-10-19', gone: false,
      lines: [
        { line_id: '1', item_id: LADDER, location_id: WENTZVILLE, quantity: '-3', moves_stock: true, value: null },
        { line_id: '2', item_id: LADDER, location_id: WENTZVILLE, quantity: '-3', moves_stock: false, value: null },
      ],
    });
    // Its own lines don't count in what came before it.
    expect(data.fulfillments[0].before).toEqual([{ item_id: LADDER, location_id: WENTZVILLE, quantity: '14', value: '2123.33' }]);
    expect(checkOwnFulfillments(data, copies).fulfillments[0]).toMatchObject({ status: 'waiting' });

    await gl(pg, '7001', 'ItemShip', '2026-10-19', [['1', INVENTORY, -45500], ['2', COGS, 45500]]);
    data = await pairs(pg, null, null, '7001');
    expect(data.fulfillments[0].netsuite!.lines.map((l) => l.value)).toEqual(['-455.00', null]);
    expect(data.fulfillments[0].netsuite_gl).toEqual({
      posting_month: '2026-10-01',
      entry: [{ account_id: INVENTORY, debit: '0.00', credit: '455.00' }, { account_id: COGS, debit: '455.00', credit: '0.00' }],
    });
    expect(data.items[LADDER]).toEqual({ number: 'LDR-24', type: 'InvtPart', display_name: 'Ladder rack 24 in' });
    expect(data.locations).toEqual({ [OFALLON]: "O'Fallon", [WENTZVILLE]: 'Wentzville' });
    expect(data.accounts).toEqual({ [INVENTORY]: { number: '19000', name: 'Inventory Asset' }, [COGS]: { number: '58000', name: 'Cost of Goods Sold' } });

    const [check] = checkOwnFulfillments(data, copies).fulfillments;
    expect(check).toMatchObject({ status: 'matches', fleetsuiteCost: 45500, netsuiteCost: 45500, salesOrder: 'SO6001', customer: 'Acme Fleet' });
    expect(check.items).toEqual([expect.objectContaining({
      item: 'LDR-24', same: true,
      fleetsuite: expect.objectContaining({ quantity: 3, location: 'Wentzville', count: 14, valueCents: 212333, cents: 45500 }),
      netsuite: { quantity: 3, locations: ['Wentzville'], cents: 45500, each: 45500 / 3 },
    })]);
    expect(check.entry).toEqual([
      { account: '19000 Inventory Asset', debit: 0, credit: 45500 },
      { account: '58000 Cost of Goods Sold', debit: 45500, credit: 0 },
    ]);
  });

  it("links FleetSuite's own invoice off the order made since", async () => {
    await call(pg, 'gl_own_invoice_save', {
      netsuite_id: '8001', netsuite_number: 'INV8001', made_from: 'vehicle', sales_order_id: '6001', invoice_date: '2026-10-19',
      tax_rule: 'tax@1', tax_basis: 'rate', tax_rate: '0', subtotal: '0.00', tax: '0.00', total: '0.00', lines_from: 'sales_order_copy',
      lines: [],
    });
    expect((await pairs(pg, null, null, '7001')).fulfillments[0].invoice).toEqual({ netsuite_id: '8001', number: 'INV8001' });
  });

  it('says what FleetSuite counted at the location NetSuite took stock from, too', async () => {
    // A copy at O'Fallon, where there's no stock, of a fulfillment NetSuite took from Wentzville.
    expect(await save(pg, payload({ netsuiteId: '7004', netsuiteNumber: 'IF7004', locationId: OFALLON, locationFrom: 'po_rule', madeFrom: 'sales_order' })))
      .toEqual({ saved: true, lines: 1 });
    await call(pg, 'gl_netsuite_stock_apply', { documents: [doc('7004', 'ItemShip', 'IF7004', '2026-10-19', [['1', LADDER, WENTZVILLE, '-3', true]])] });
    await gl(pg, '7004', 'ItemShip', '2026-10-19', [['1', INVENTORY, -45500], ['2', COGS, 45500]]);
    const data = await pairs(pg, null, null, '7004');
    // Before it: the receipt later the same day (id 7002) and FleetSuite's first fulfillment (7001) both come first.
    expect(data.fulfillments[0].before).toEqual([
      { item_id: LADDER, location_id: OFALLON, quantity: '0', value: '0' },
      { item_id: LADDER, location_id: WENTZVILLE, quantity: '16', value: '2668.33' },
    ]);
    const [check] = checkOwnFulfillments(data, { stock: null, ledger: null }).fulfillments;
    expect(check.status).toBe('differs');
    expect(check.fields.find((f) => f.field === 'location')).toMatchObject({ fleetsuite: "O'Fallon", netsuite: 'Wentzville', same: false });
    expect(check.fleetsuiteCost).toBeNull();
  });

  it('marks one NetSuite deleted as gone, and counts by month', async () => {
    expect(await save(pg, payload({ netsuiteId: '7005', netsuiteNumber: 'IF7005', fulfilDate: '2026-09-30' }))).toEqual({ saved: true, lines: 1 });
    await call(pg, 'gl_netsuite_stock_apply', { documents: [doc('7005', 'ItemShip', 'IF7005', '2026-09-30', [['1', LADDER, WENTZVILLE, '-3', true]])] });
    await pg.exec(`RESET ROLE; UPDATE gl_netsuite_stock_documents SET gone_at = now() WHERE netsuite_id = '7005'; SET ROLE service_role`);
    const data = await pairs(pg, '2026-09-01', '2026-09-30');
    expect(data.fulfillments.map((f) => f.own.netsuite_id)).toEqual(['7005']);
    expect(checkOwnFulfillments(data, { stock: null, ledger: null }).fulfillments[0].status).toBe('voided');
    // A gone document doesn't count in what came before a later one.
    expect((await pairs(pg, null, null, '7001')).fulfillments[0].before[0].quantity).toBe('14');

    expect(await one(pg, 'SELECT gl_own_fulfillment_months() AS r')).toEqual([
      { month: '2026-10-01', fulfillments: 2 },
      { month: '2026-09-01', fulfillments: 1 },
    ]);
    // Newest first within a month.
    expect((await pairs(pg, '2026-10-01', '2026-10-31')).fulfillments.map((f) => f.own.netsuite_id)).toEqual(['7004', '7001']);
  });

  it('values only what NetSuite keeps in stock, and keeps a kit FleetSuite can\'t see into', async () => {
    expect(await save(pg, payload({
      netsuiteId: '7006', netsuiteNumber: 'IF7006',
      lines: [{ itemId: RACK_KIT, itemNumber: 'RACK-KIT', description: null, itemType: 'Kit', quantity: 1, salesOrderLineId: '1' }],
    }))).toEqual({ saved: true, lines: 1 });
    await call(pg, 'gl_netsuite_stock_apply', { documents: [doc('7006', 'ItemShip', 'IF7006', '2026-10-19', [['1', BINS, WENTZVILLE, '-4', true]])] });
    const data = await pairs(pg, null, null, '7006');
    expect(data.fulfillments[0].before).toEqual([
      { item_id: BINS, location_id: WENTZVILLE, quantity: '0', value: '0' },
      { item_id: RACK_KIT, location_id: WENTZVILLE, quantity: '0', value: '0' },
    ]);
    const [check] = checkOwnFulfillments(data, { stock: null, ledger: new Date(Date.now() + 3_600_000).toISOString() }).fulfillments;
    // The bins may be the kit's parts: not compared, so the copy is incomplete rather than different.
    expect(check.status).toBe('incomplete');
    expect(check.items.find((i) => i.item === 'BIN-10')).toMatchObject({ same: null, fleetsuite: null });
  });

  it("is the service role's alone", async () => {
    await pg.exec('RESET ROLE');
    for (const fn of [
      'public.gl_own_fulfillment_save(jsonb)', 'public.gl_own_fulfillment_pairs(date, date, text)', 'public.gl_own_fulfillment_months()',
    ]) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>(pg, `SELECT has_function_privilege($1::name, '${fn}', 'EXECUTE') AS r`, [role]), `${fn} ${role}`)
          .toBe(role === 'service_role');
      }
    }
    for (const table of ['gl_own_fulfillments', 'gl_own_fulfillment_lines']) {
      for (const role of ['anon', 'authenticated']) {
        expect(await one<boolean>(pg, `SELECT has_table_privilege($1::name, '${table}', 'SELECT') AS r`, [role]), `${table} ${role}`).toBe(false);
      }
      expect(await one<boolean>(pg, `SELECT relrowsecurity AS r FROM pg_class WHERE relname = $1`, [table])).toBe(true);
    }
    await pg.exec('SET ROLE service_role');
  });
});
