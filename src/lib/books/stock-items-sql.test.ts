// Migration 401 keeps FleetSuite's own count of each item at each location,
// 402 values only what NetSuite keeps in stock, and 403 names the stocked
// items whose asset account isn't an asset account. This runs migrations
// 359–363 with 401 to 403 in an in-memory Postgres (PGlite) as the app's
// server login, copies a made-up handful of NetSuite stock documents the way
// netsuite-stock.ts hands them over, with their GL lines in the copy of
// NetSuite's general ledger, and holds what gl_stock_items,
// gl_stock_item_moves and gl_stock_item_setup return, as stock-items.ts puts
// them side by side.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { compareStock, itemMoves, stockSetup, type StockItemMovesData, type StockItemsData, type StockSetupData } from './stock-items';

const WENTZVILLE = '11';
const KANSAS_CITY = '12';
const LADDER = '9001';
const BINS = '9002';
const VINYL = '9003';
/** Items NetSuite doesn't keep in stock, or whose asset account isn't an asset in the chart. */
const KIT = '9200';
const TOOLS = '9300';
/** The items' inventory account, and the accounts the other sides of their documents post to. */
const INVENTORY = '190';
const COGS = '580';
const EQUIPMENT = '195';
const RECEIVED = '210';
const ADJUSTMENT = '520';

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
  `);
  for (const file of [
    '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '401-books-stock-by-item.sql',
    '402-books-stock-values.sql', '403-books-stock-item-setup.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084';
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('item', '${LADDER}', 'LDR-24', true, '{"display_name": "Ladder rack 24 in", "item_type": "InvtPart", "asset_account": "${INVENTORY}"}'),
      ('item', '${BINS}', 'BIN-10', true, '{"item_type": "InvtPart", "asset_account": "${INVENTORY}"}'),
      ('item', '${VINYL}', 'VINYL-3M', true, '{"item_type": "InvtPart", "asset_account": "${INVENTORY}"}'),
      ('item', '9100', 'LABOR', true, '{"item_type": "Service"}'),
      -- As some items in NetSuite do: a non-inventory part that names an
      -- equipment account as its asset account, and an inventory part that
      -- names the cost of goods account there.
      ('item', '${KIT}', 'HW-KIT', true, '{"item_type": "NonInvtPart", "asset_account": "${EQUIPMENT}"}'),
      ('item', '${TOOLS}', 'TOOL-KIT', true, '{"item_type": "InvtPart", "asset_account": "${COGS}"}'),
      ('location', '${WENTZVILLE}', 'Wentzville', true, '{"subsidiary_id": "2"}'),
      ('location', '${KANSAS_CITY}', 'Kansas City', true, '{"subsidiary_id": "2"}');
    INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id) VALUES
      ('1200', 'Inventory', 'other_current_asset', '${INVENTORY}'),
      ('1500', 'Equipment', 'fixed_asset', '${EQUIPMENT}'),
      ('5000', 'Cost of goods sold', 'cost_of_goods_sold', '${COGS}');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

/** A stock line as the copy hands it over: [line, item, location, quantity, moves stock]. */
type StockLine = [line: string, item: string, location: string | null, quantity: string, moves: boolean];
const doc = (id: string, type: string, number: string, date: string, lines: StockLine[], company = 'BMG') => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date,
  lines: lines.map(([line_id, item_id, location_id, quantity, moves_stock]) => ({ line_id, company, item_id, location_id, quantity, moves_stock })),
});

/** What NetSuite posted for a document, in the GL copy: [line, account, cents debit positive]. */
async function gl(pg: PGlite, id: string, type: string, date: string, lines: Array<[string, string, number]>, company = 'BMG') {
  const month = `${date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $1, $3, $4, 'x', 's')`,
    [id, type, date, month],
  );
  for (const [line, account, cents] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', company],
    );
  }
}

const items = (pg: PGlite) => one<StockItemsData>(pg, 'SELECT gl_stock_items() AS r');
const setup = (pg: PGlite) => one<StockSetupData>(pg, 'SELECT gl_stock_item_setup() AS r');
const moves = (pg: PGlite, item: string, limit = 100) =>
  one<StockItemMovesData>(pg, 'SELECT gl_stock_item_moves($1, $2) AS r', [item, limit]);

// Ten ladder racks were in Wentzville on December 31, 2024 at $150 each,
// and two in Kansas City. In 2025: a receipt of six more into Wentzville at
// $160, a fulfillment of three (its cost of goods line names the item but
// doesn't move it), a transfer of two to Kansas City, and an invoice that
// took one out of Kansas City itself. Bins: a receipt of 40 at $2.50 and an
// adjustment of -4. Vinyl moves by the foot.
const RECEIPT = doc('5001', 'ItemRcpt', 'IR5001', '2025-03-04', [['1', LADDER, WENTZVILLE, '6', true]]);
const FULFILLMENT = doc('5002', 'ItemShip', 'IF5002', '2025-03-20', [
  ['1', LADDER, WENTZVILLE, '-3', true], ['2', LADDER, WENTZVILLE, '-3', false],
]);
const TRANSFER = doc('5003', 'InvTrnfr', 'IT5003', '2025-04-02', [
  ['1', LADDER, WENTZVILLE, '-2', true], ['2', LADDER, KANSAS_CITY, '2', true],
]);
const INVOICE = doc('5004', 'CustInvc', 'INV5004', '2025-05-15', [
  ['1', LADDER, KANSAS_CITY, '-1', true], ['3', LADDER, KANSAS_CITY, '-1', false], ['4', LADDER, KANSAS_CITY, '-1', false],
  ['2', '9100', KANSAS_CITY, '-2', false],
]);
const BIN_RECEIPT = doc('5005', 'ItemRcpt', 'IR5005', '2025-06-01', [['1', BINS, WENTZVILLE, '40', true]]);
const BIN_COUNT = doc('5006', 'InvAdjst', 'IA5006', '2026-01-10', [['1', BINS, WENTZVILLE, '-4', true]]);
const VINYL_RECEIPT = doc('5007', 'ItemRcpt', 'IR5007', '2026-02-01', [['1', VINYL, WENTZVILLE, '150.5', true]]);

describe("migration 401's stock by item", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // NetSuite's GL for them: what posted to the inventory account is each move's cost.
    await gl(db, '5001', 'ItemRcpt', '2025-03-04', [['0', RECEIVED, -96000], ['1', INVENTORY, 96000]]);
    await gl(db, '5002', 'ItemShip', '2025-03-20', [['1', INVENTORY, -46500], ['2', COGS, 46500]]);
    await gl(db, '5003', 'InvTrnfr', '2025-04-02', [['1', INVENTORY, -31000], ['2', INVENTORY, 31000]]);
    // The invoice's sale line posts to sales; its cost lines to COGS and inventory.
    await gl(db, '5004', 'CustInvc', '2025-05-15', [['1', '400', -30000], ['3', COGS, 15500], ['4', INVENTORY, -15500]]);
    await gl(db, '5005', 'ItemRcpt', '2025-06-01', [['0', RECEIVED, -10000], ['1', INVENTORY, 10000]]);
    await gl(db, '5006', 'InvAdjst', '2026-01-10', [['0', ADJUSTMENT, 1000], ['1', INVENTORY, -1000]]);
    await gl(db, '5007', 'ItemRcpt', '2026-02-01', [['0', RECEIVED, -30100], ['1', INVENTORY, 30100]]);
    // A journal entry to the inventory account names no item.
    await gl(db, '5900', 'Journal', '2026-06-30', [['1', INVENTORY, 2500], ['2', ADJUSTMENT, -2500]]);
    // The starting entry of NetSuite's GL holds the racks' $1,800.
    await db.exec(`INSERT INTO gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
                   SELECT id, '${INVENTORY}', 1800.00, 0, 2 FROM gl_companies WHERE code = 'BMG'`);

    const applied = await call<Record<string, number>>(db, 'gl_netsuite_stock_apply', {
      documents: [RECEIPT, FULFILLMENT, TRANSFER, INVOICE, BIN_RECEIPT, BIN_COUNT, VINYL_RECEIPT],
    });
    expect(applied).toEqual({ received: 7, added: 7, changed: 0, unchanged: 0, lines: 12 });
    expect(await call(db, 'gl_netsuite_stock_store_opening', {
      rows: [
        { company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '10', value: '1500.00' },
        { company: 'BMG', item_id: LADDER, location_id: KANSAS_CITY, quantity: '2', value: '300.00' },
      ],
    })).toEqual({ rows: 2 });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  it('counts each item at each location from where it started and every move since, valued at what NetSuite posted', async () => {
    const data = await items(db);
    // Not the equipment account a non-inventory part names, nor the cost of
    // goods account an inventory part names: the fulfillment's and invoice's
    // cost lines below post there on the racks' lines and aren't stock.
    expect(data.accounts).toEqual([INVENTORY]);
    expect(data.netsuite_read_at).toBeNull();
    const row = (item: string, location: string) => data.rows.find((r) => r.item_id === item && r.location_id === location);
    // Wentzville: 10 + 6 - 3 - 2 = 11, worth 1500 + 960 - 465 - 310.
    expect(row(LADDER, WENTZVILLE)).toEqual({
      company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, opening_quantity: '10', opening_value: '1500.00',
      quantity: '11', value: '1685.00', documents: 3, last_date: '2025-04-02',
    });
    // Kansas City: 2 + 2 - 1 = 3; the invoice's cost line on the inventory account takes its value out.
    expect(row(LADDER, KANSAS_CITY)).toMatchObject({ quantity: '3', value: '455.00', documents: 2, last_date: '2025-05-15' });
    expect(row(BINS, WENTZVILLE)).toMatchObject({ opening_quantity: '0', quantity: '36', value: '90.00' });
    expect(row(VINYL, WENTZVILLE)).toMatchObject({ quantity: '150.5', value: '301.00' });
    // The labor line names an item but moves nothing and posts nothing to inventory.
    expect(data.rows.some((r) => r.item_id === '9100')).toBe(false);
    // NetSuite's GL holds every item's value and the journal entry's $25 that names none.
    expect(data.ledger).toEqual([{ company: '1084', balance: '0' }, { company: 'BMG', balance: '2556.00' }]);
  });

  it("compares nothing before NetSuite's counts are read", async () => {
    const cmp = compareStock(await items(db));
    expect(cmp.by).toBeNull();
    expect(cmp.lines.every((l) => !l.countDiffers && !l.valueDiffers)).toBe(true);
    expect(cmp.lines.map((l) => [l.item, l.location, l.fleetsuite.quantity, l.fleetsuite.value])).toEqual([
      ['BIN-10', 'Wentzville', 36, 9000],
      ['LDR-24', 'Kansas City', 3, 45500],
      ['LDR-24', 'Wentzville', 11, 168500],
      ['VINYL-3M', 'Wentzville', 150.5, 30100],
    ]);
    expect(cmp.lines.find((l) => l.item === 'LDR-24')!.description).toBe('Ladder rack 24 in');
    expect(cmp.value).toEqual({ fleetsuite: 253100, netsuite: null });
    expect(cmp.ledger).toEqual([{ company: 'BMG', balance: 255600, items: 253100 }]);
  });

  it("puts each item next to NetSuite's own count at each location, the ones that differ first", async () => {
    expect(await call(db, 'gl_netsuite_stock_store_counts', {
      rows: [
        { item_id: LADDER, location_id: WENTZVILLE, quantity: '11', value: '1685.00' },
        // NetSuite has a rack fewer in Kansas City: a move FleetSuite hasn't copied.
        { item_id: LADDER, location_id: KANSAS_CITY, quantity: '2', value: '300.00' },
        { item_id: BINS, location_id: WENTZVILLE, quantity: '36', value: '90.00' },
        { item_id: VINYL, location_id: WENTZVILLE, quantity: '150.5', value: '301.00' },
      ],
    })).toEqual({ rows: 4 });
    const cmp = compareStock(await items(db));
    expect(cmp.by).toBe('location');
    expect(cmp.readAt).not.toBeNull();
    expect(cmp.lines[0]).toMatchObject({
      key: `${LADDER}|${KANSAS_CITY}`, item: 'LDR-24', location: 'Kansas City', companies: ['BMG'],
      start: { quantity: 2, value: 30000 }, fleetsuite: { quantity: 3, value: 45500 }, netsuite: { quantity: 2, value: 30000 },
      countDiffers: true, valueDiffers: true,
    });
    expect(cmp.lines.slice(1).every((l) => !l.countDiffers && !l.valueDiffers)).toBe(true);
    expect(cmp.value).toEqual({ fleetsuite: 253100, netsuite: 237600 });
  });

  it("compares each item company-wide when that's all NetSuite gives", async () => {
    await call(db, 'gl_netsuite_stock_store_counts', {
      rows: [
        { item_id: LADDER, quantity: '14' },
        { item_id: BINS, quantity: '36' },
        { item_id: VINYL, quantity: '150.5' },
        // An item NetSuite has that FleetSuite never saw move.
        { item_id: '9004', quantity: '5' },
      ],
    });
    const cmp = compareStock(await items(db));
    expect(cmp.by).toBe('item');
    expect(cmp.lines.map((l) => [l.key, l.location, l.fleetsuite.quantity, l.netsuite.quantity, l.countDiffers])).toEqual([
      ['9004', null, 0, 5, true],
      ['9002', null, 36, 36, false],
      ['9001', null, 14, 14, false],
      ['9003', null, 150.5, 150.5, false],
    ]);
    expect(cmp.lines[0].item).toBe('Item 9004');
    expect(cmp.value.netsuite).toBeNull();
  });

  it("lists one item's moves, oldest first, each with what it left at its location", async () => {
    await call(db, 'gl_netsuite_stock_store_counts', {
      rows: [
        { item_id: LADDER, location_id: WENTZVILLE, quantity: '11', value: '1685.00' },
        { item_id: LADDER, location_id: KANSAS_CITY, quantity: '2', value: '300.00' },
      ],
    });
    const data = await moves(db, LADDER);
    expect(data.item).toMatchObject({ netsuite_id: LADDER, name: 'LDR-24' });
    expect(data.count).toBe(5);
    const page = itemMoves(data);
    expect(page.by).toBe('location');
    expect(page.more).toBe(0);
    expect(page.moves.map((m) => [m.number, m.typeName, m.location, m.quantity, m.value, m.after.quantity, m.after.value, m.check])).toEqual([
      ['IR5001', 'Item Receipt', 'Wentzville', 6, 96000, 16, 246000, { kind: 'stock', month: '2025-03-01' }],
      ['IF5002', 'Item Fulfillment', 'Wentzville', -3, -46500, 13, 199500, { kind: 'stock', month: '2025-03-01' }],
      ['IT5003', 'Inventory Transfer', 'Wentzville', -2, -31000, 11, 168500, { kind: 'stock', month: '2025-04-01' }],
      ['IT5003', 'Inventory Transfer', 'Kansas City', 2, 31000, 4, 61000, { kind: 'stock', month: '2025-04-01' }],
      ['INV5004', 'Invoice', 'Kansas City', -1, -15500, 3, 45500, { kind: 'stock', month: '2025-05-01' }],
    ]);
    expect(page.places).toEqual([
      { locationId: KANSAS_CITY, location: 'Kansas City', start: { quantity: 2, value: 30000 }, fleetsuite: { quantity: 3, value: 45500 }, netsuite: { quantity: 2, value: 30000 } },
      { locationId: WENTZVILLE, location: 'Wentzville', start: { quantity: 10, value: 150000 }, fleetsuite: { quantity: 11, value: 168500 }, netsuite: { quantity: 11, value: 168500 } },
    ]);
    expect(page.netsuite).toEqual({ quantity: 13, value: 198500 });
  });

  it('sends the newest moves when there are more, each still with the whole count after it', async () => {
    const page = itemMoves(await moves(db, LADDER, 2));
    expect(page.more).toBe(3);
    expect(page.moves.map((m) => [m.number, m.location, m.after.quantity])).toEqual([['IT5003', 'Kansas City', 4], ['INV5004', 'Kansas City', 3]]);
    // Each place still counts every move.
    expect(page.places.map((p) => [p.location, p.fleetsuite.quantity])).toEqual([['Kansas City', 3], ['Wentzville', 11]]);
  });

  it('leaves an unchanged document alone and replaces the lines of one that changed', async () => {
    const again = await call<Record<string, number>>(db, 'gl_netsuite_stock_apply', { documents: [RECEIPT, BIN_COUNT] });
    expect(again).toEqual({ received: 2, added: 0, changed: 0, unchanged: 2, lines: 0 });
    // The count was redone in NetSuite: -5 bins, not -4.
    const recount = doc('5006', 'InvAdjst', 'IA5006', '2026-01-10', [['1', BINS, WENTZVILLE, '-5', true]]);
    expect(await call(db, 'gl_netsuite_stock_apply', { documents: [recount] })).toEqual({ received: 1, added: 0, changed: 1, unchanged: 0, lines: 1 });
    const data = await items(db);
    expect(data.rows.find((r) => r.item_id === BINS)).toMatchObject({ quantity: '35' });
  });

  it("drops what NetSuite no longer lists, brings back what it lists again, and won't act on a list cut short", async () => {
    const all = ['5001', '5002', '5003', '5004', '5005', '5006', '5007'];
    expect(await call(db, 'gl_netsuite_stock_finish', { netsuite_ids: [] })).toEqual({ listed: 0, here: 7, gone: 0, cut_short: true });
    expect(await call(db, 'gl_netsuite_stock_finish', { netsuite_ids: ['5001', '5002', '5003'] }))
      .toEqual({ listed: 3, here: 7, gone: 0, cut_short: true });
    // The vinyl receipt was deleted in NetSuite.
    expect(await call(db, 'gl_netsuite_stock_finish', { netsuite_ids: all.filter((id) => id !== '5007') }))
      .toEqual({ listed: 6, here: 7, gone: 1, cut_short: false });
    let data = await items(db);
    expect(data.rows.find((r) => r.item_id === VINYL)).toBeUndefined();
    expect((await moves(db, VINYL)).moves).toEqual([]);

    // NetSuite has it again, unchanged: it's back.
    expect(await call(db, 'gl_netsuite_stock_apply', { documents: [VINYL_RECEIPT] })).toEqual({ received: 1, added: 0, changed: 1, unchanged: 0, lines: 1 });
    data = await items(db);
    expect(data.rows.find((r) => r.item_id === VINYL)).toMatchObject({ quantity: '150.5' });
  });

  it("refuses a page it can't copy whole", async () => {
    await expect(call(db, 'gl_netsuite_stock_apply', { documents: [RECEIPT, RECEIPT] })).rejects.toThrow(/in the page twice/);
    await expect(call(db, 'gl_netsuite_stock_apply', { documents: [{ ...RECEIPT, lines: [] }] })).rejects.toThrow(/has no lines/);
    await expect(call(db, 'gl_netsuite_stock_apply', { documents: [doc('5010', 'ItemRcpt', 'IR5010', '2025-07-01', [['1', LADDER, WENTZVILLE, '1e3', true]])] }))
      .rejects.toThrow(/quantity FleetSuite can't read/);
    await expect(call(db, 'gl_netsuite_stock_apply', { documents: [doc('5010', 'ItemRcpt', 'IR5010', '2025-07-01', [['1', LADDER, WENTZVILLE, '1', true]], 'ACME')] }))
      .rejects.toThrow(/unknown company ACME/);
    await expect(call(db, 'gl_netsuite_stock_store_opening', {
      rows: [{ company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '1', value: '1.00' },
        { company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '2', value: '2.00' }],
    })).rejects.toThrow(/twice/);
    await expect(call(db, 'gl_netsuite_stock_store_counts', { rows: [{ item_id: 'x', quantity: '1' }] })).rejects.toThrow(/can't read/);
    await expect(one(db, 'SELECT gl_stock_item_moves($1, 10) AS r', ['abc'])).rejects.toThrow(/NetSuite id/);
    // Nothing of the refused pages landed.
    expect((await moves(db, LADDER)).count).toBe(5);
  });

  it("values only what NetSuite keeps in stock, though the ledger still holds the rest", async () => {
    // Ten more bins at $2.50, with three hardware kits on the receipt that
    // NetSuite posted to the inventory account on their own line.
    await call(db, 'gl_netsuite_stock_apply', {
      documents: [doc('5011', 'ItemRcpt', 'IR5011', '2026-03-01', [['1', BINS, WENTZVILLE, '10', true], ['2', KIT, WENTZVILLE, '3', false]])],
    });
    await gl(db, '5011', 'ItemRcpt', '2026-03-01', [['0', RECEIVED, -2800], ['1', INVENTORY, 2500], ['2', INVENTORY, 300]]);
    // Before 2025 the kits put $40 on the inventory account too.
    await call(db, 'gl_netsuite_stock_store_opening', {
      rows: [
        { company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '10', value: '1500.00' },
        { company: 'BMG', item_id: LADDER, location_id: KANSAS_CITY, quantity: '2', value: '300.00' },
        { company: 'BMG', item_id: KIT, location_id: WENTZVILLE, quantity: '0', value: '40.00' },
      ],
    });
    const data = await items(db);
    expect(data.rows.find((r) => r.item_id === BINS)).toMatchObject({ quantity: '45', value: '115.00', documents: 3, last_date: '2026-03-01' });
    expect(data.rows.some((r) => r.item_id === KIT)).toBe(false);
    expect(data.ledger).toEqual([{ company: '1084', balance: '0' }, { company: 'BMG', balance: '2584.00' }]);
    // What's left between the ledger and the items: the journal entry's $25 and the kits' $3.
    expect(compareStock(data).ledger).toEqual([{ company: 'BMG', balance: 258400, items: 255600 }]);

    const kit = await moves(db, KIT);
    expect(kit.count).toBe(0);
    expect(kit.opening).toEqual([{ company: 'BMG', location_id: WENTZVILLE, quantity: '0', value: '0' }]);
  });

  it('is open to the service role only', async () => {
    const functions = [
      'gl_netsuite_stock_apply(jsonb)', 'gl_netsuite_stock_finish(jsonb)', 'gl_netsuite_stock_store_opening(jsonb)',
      'gl_netsuite_stock_store_counts(jsonb)', 'gl_stock_inventory_accounts()', 'gl_stock_items()', 'gl_stock_item_moves(text, integer)',
      'gl_stock_item_setup()',
    ];
    const tables = ['gl_netsuite_stock_documents', 'gl_netsuite_stock_lines', 'gl_netsuite_stock_opening', 'gl_netsuite_stock_counts'];
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const f of functions) {
        expect(await one<boolean>(db, `SELECT has_function_privilege($1::name, $2::text, 'EXECUTE') AS r`, [role, f]), `${role} ${f}`)
          .toBe(role === 'service_role');
      }
      for (const t of tables) {
        expect(await one<boolean>(db, `SELECT has_table_privilege($1::name, $2::text, 'SELECT') AS r`, [role, t]), `${role} ${t}`)
          .toBe(role === 'service_role');
      }
    }
    const rls = await db.query<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE relname = ANY($1)`, [tables]);
    expect(rls.rows).toHaveLength(tables.length);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
    expect(await one(db, 'SELECT gl_stock_inventory_accounts() AS r')).toEqual([INVENTORY]);
  });
});

describe("migration 403's stocked items whose asset account isn't an asset account", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.exec(`
      RESET ROLE;
      INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details, gone_at) VALUES
        -- An assembly whose asset account is an expense account; an inactive
        -- part and one gone from NetSuite set up the same way, which nothing
        -- can be received or shipped on now.
        ('item', '9400', 'ASSY-1', true, '{"display_name": "Rack assembly", "item_type": "Assembly", "asset_account": "640"}', NULL),
        ('item', '9401', 'OLD-1', false, '{"item_type": "InvtPart", "asset_account": "${COGS}"}', NULL),
        ('item', '9402', 'GONE-1', true, '{"item_type": "InvtPart", "asset_account": "${COGS}"}', now()),
        -- An inventory part on the equipment account: an asset, so it's fine.
        ('item', '9403', 'LIFT-1', true, '{"item_type": "InvtPart", "asset_account": "${EQUIPMENT}"}', NULL);
      INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id) VALUES ('6400', 'Shop supplies', 'expense', '640');
      SET ROLE service_role;
    `);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  it('lists each active stocked item whose asset account is something else, and the asset account most stocked items use', async () => {
    const data = await setup(db);
    expect(data).toEqual({
      items: [
        { netsuite_id: '9400', name: 'ASSY-1', display_name: 'Rack assembly', account: { netsuite_id: '640', number: '6400', name: 'Shop supplies', type: 'expense' } },
        { netsuite_id: TOOLS, name: 'TOOL-KIT', display_name: null, account: { netsuite_id: COGS, number: '5000', name: 'Cost of goods sold', type: 'cost_of_goods_sold' } },
      ],
      // The ladders, bins and vinyl, over the one lift on the equipment account.
      usual: { netsuite_id: INVENTORY, number: '1200', name: 'Inventory' },
    });
    expect(stockSetup(data).items.map((i) => `${i.item}: ${i.account}, ${i.accountKind}`)).toEqual([
      'ASSY-1: 6400 Shop supplies, an expense account',
      'TOOL-KIT: 5000 Cost of goods sold, a cost of goods sold account',
    ]);
  });

  it("drops an item once NetSuite's lists have it right", async () => {
    await db.exec(`RESET ROLE; UPDATE gl_netsuite_lists SET details = details || '{"asset_account": "${INVENTORY}"}' WHERE kind = 'item' AND netsuite_id = '9400'; SET ROLE service_role;`);
    expect((await setup(db)).items.map((i) => i.name)).toEqual(['TOOL-KIT']);
  });

  it('shows what a swapped item leaves: value on the inventory account with none on hand, from shipments posted the wrong way round', async () => {
    // Two tool kits received into Wentzville: NetSuite put their cost on the
    // kit's asset account, the cost of goods account, so none on inventory.
    await call(db, 'gl_netsuite_stock_apply', {
      documents: [
        doc('5020', 'ItemRcpt', 'IR5020', '2025-08-01', [['1', TOOLS, WENTZVILLE, '2', true]]),
        // Both shipped: the asset line takes the cost off the cost of goods
        // account, and the cost of goods line, its COGS account being the
        // inventory account, puts it on inventory.
        doc('5021', 'ItemShip', 'IF5021', '2025-09-01', [['1', TOOLS, WENTZVILLE, '-2', true], ['2', TOOLS, WENTZVILLE, '-2', false]]),
      ],
    });
    await gl(db, '5020', 'ItemRcpt', '2025-08-01', [['0', RECEIVED, -9060], ['1', COGS, 9060]]);
    await gl(db, '5021', 'ItemShip', '2025-09-01', [['1', COGS, -9060], ['2', INVENTORY, 9060]]);
    // NetSuite has none, so it gives no count of the kits.
    await call(db, 'gl_netsuite_stock_store_counts', { rows: [{ item_id: LADDER, location_id: WENTZVILLE, quantity: '1', value: '10.00' }] });

    const line = compareStock(await items(db)).lines.find((l) => l.itemId === TOOLS)!;
    expect(line).toMatchObject({
      fleetsuite: { quantity: 0, value: 9060 }, netsuite: { quantity: 0, value: 0 },
      countDiffers: false, valueDiffers: true, leftover: true,
    });
    const page = itemMoves(await moves(db, TOOLS));
    expect(page.moves.map((m) => [m.number, m.quantity, m.value, m.backwards])).toEqual([
      ['IR5020', 2, 0, false],
      ['IF5021', -2, 9060, true],
    ]);
    expect(page.leftover).toEqual([{ locationId: WENTZVILLE, location: 'Wentzville', value: 9060 }]);
  });
});
