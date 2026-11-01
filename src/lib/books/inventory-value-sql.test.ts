// Migration 495 gives each item's count and value at a month's end and each
// inventory account then, the stocked items next to the copy of NetSuite's
// ledger, NetSuite's own totals and FleetSuite's books. This runs migrations
// 359–363 with 401 to 405 and 495 in an in-memory Postgres (PGlite) as the
// app's server login, copies a made-up handful of NetSuite stock documents
// the way netsuite-stock.ts hands them over, with their GL lines, NetSuite's
// month totals and FleetSuite's own entries, and holds what
// gl_stock_month_end returns, as inventory-value.ts reads it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { monthEndValue, type MonthEndData } from './inventory-value';

const WENTZVILLE = '11';
const COOL_SPRINGS = '21';
const LADDER = '9001';
const BINS = '9002';
const VINYL = '9003';
/** A stocked item whose asset account is the equipment account, which makes that an inventory account. */
const TOOLS = '9300';
const INVENTORY = '190';
const EQUIPMENT = '195';
const COGS = '580';
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
    '402-books-stock-values.sql', '403-books-stock-item-setup.sql', '404-books-stock-ledger-parts.sql',
    '405-books-stock-account-items.sql', '495-inventory-value-at-a-months-end.sql',
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
      ('item', '${TOOLS}', 'TOOL-KIT', true, '{"item_type": "InvtPart", "asset_account": "${EQUIPMENT}"}'),
      ('location', '${WENTZVILLE}', 'Wentzville', true, '{"subsidiary_id": "2"}'),
      ('location', '${COOL_SPRINGS}', 'Cool Springs', true, '{"subsidiary_id": "5"}'),
      ('vendor', '7001', 'Acme Racks', true, '{}');
    INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id) VALUES
      ('1200', 'Inventory', 'other_current_asset', '${INVENTORY}'),
      ('1500', 'Equipment', 'fixed_asset', '${EQUIPMENT}'),
      ('2100', 'Received not billed', 'other_current_liability', '${RECEIVED}'),
      ('5000', 'Cost of goods sold', 'cost_of_goods_sold', '${COGS}'),
      ('5200', 'Inventory adjustments', 'cost_of_goods_sold', '${ADJUSTMENT}');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const monthEnd = (pg: PGlite, month: string, limit = 100) =>
  one<MonthEndData>(pg, 'SELECT gl_stock_month_end($1::date, $2) AS r', [month, limit]);

/** A stock line as the copy hands it over: [line, item, location, quantity, moves stock]. */
type StockLine = [line: string, item: string, location: string | null, quantity: string, moves: boolean];
const doc = (id: string, type: string, number: string, date: string, lines: StockLine[], company = 'BMG') => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date,
  lines: lines.map(([line_id, item_id, location_id, quantity, moves_stock]) => ({ line_id, company, item_id, location_id, quantity, moves_stock })),
});

/**
 * What NetSuite posted for a document in the GL copy, to `month`: [line, account, cents debit positive, vendor,
 * the month that line posted to when it isn't the document's].
 */
async function gl(
  pg: PGlite, id: string, type: string, date: string, month: string, lines: Array<[string, string, number, string?, string?]>,
  memo: string | null = null,
) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, `${type.slice(0, 2).toUpperCase()}${id}`, date, month],
  );
  for (const [line, account, cents, vendor, lineMonth] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, memo, entity_id)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8, $9 FROM gl_companies WHERE code = 'BMG'`,
      [id, line, account, lineMonth ?? month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', memo, vendor ?? null],
    );
  }
}

/** NetSuite's own total on an account for a month, cents debit positive. */
const total = (pg: PGlite, account: string, month: string, cents: number) => pg.query(
  `INSERT INTO gl_netsuite_month_totals (company_id, netsuite_account_id, month, debit, credit, line_count)
   SELECT id, $1, $2, $3, $4, 1 FROM gl_companies WHERE code = 'BMG'`,
  [account, month, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0'],
);

/** One of FleetSuite's own entries: cents on the account, debit positive, the other side on `against`. */
let keys = 0;
async function post(pg: PGlite, date: string, account: string, cents: number, against: string) {
  keys += 1;
  const id = async (ns: string) => one<string>(pg, 'SELECT id::text AS r FROM gl_accounts WHERE netsuite_account_id = $1', [ns]);
  const side = (n: number) => (n > 0 ? { debit: money(n) } : { credit: money(n) });
  await one(pg, 'SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
    company: 'BMG', entry_date: date, source_type: 'netsuite_test', source_id: String(keys), posting_rule: 'test@1',
    idempotency_key: `test:${keys}`,
    lines: [{ account_id: await id(account), ...side(cents) }, { account_id: await id(against), ...side(-cents) }],
  })]);
}

describe("migration 495's inventory value at a month's end", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // In 2025: six more racks received in February; three shipped on February
    // 28, which NetSuite posted to March; bins counted in, and ten more
    // received that the copy of NetSuite's ledger doesn't have yet; vinyl
    // shipped before any was received; two racks received in April. Tools
    // go on the equipment account. A rack shipment NetSuite deleted is gone.
    const applied = await call<Record<string, number>>(db, 'gl_netsuite_stock_apply', {
      documents: [
        doc('6001', 'ItemRcpt', 'IR6001', '2025-02-10', [['1', LADDER, WENTZVILLE, '6', true]]),
        doc('6002', 'ItemShip', 'IF6002', '2025-02-28', [['1', LADDER, WENTZVILLE, '-3', true], ['2', LADDER, WENTZVILLE, '-3', false]]),
        doc('6003', 'InvAdjst', 'IA6003', '2025-03-15', [['1', BINS, WENTZVILLE, '40', true]]),
        doc('6004', 'ItemRcpt', 'IR6004', '2025-03-20', [['1', BINS, WENTZVILLE, '10', true]]),
        doc('6005', 'ItemRcpt', 'IR6005', '2025-04-05', [['1', LADDER, WENTZVILLE, '2', true]]),
        doc('6006', 'ItemRcpt', 'IR6006', '2025-02-12', [['1', TOOLS, WENTZVILLE, '1', true]]),
        doc('6007', 'ItemShip', 'IF6007', '2025-03-05', [['1', LADDER, WENTZVILLE, '-1', true]]),
        doc('6008', 'ItemShip', 'IF6008', '2025-03-10', [['1', VINYL, WENTZVILLE, '-2', true], ['2', VINYL, WENTZVILLE, '-2', false]]),
      ],
    });
    expect(applied).toMatchObject({ received: 8, added: 8 });
    await db.exec("UPDATE gl_netsuite_stock_documents SET gone_at = now() WHERE netsuite_id = '6007'");
    expect(await call(db, 'gl_netsuite_stock_store_opening', {
      rows: [
        { company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '10', value: '1500.00' },
        { company: '1084', item_id: BINS, location_id: COOL_SPRINGS, quantity: '5', value: '12.50' },
      ],
    })).toEqual({ rows: 2 });
    // NetSuite's ledger started $100 short of the racks on the inventory account; the equipment account holds BMG's own.
    await db.exec(`
      INSERT INTO gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
      SELECT id, '${INVENTORY}', 1400.00, 0, 2 FROM gl_companies WHERE code = 'BMG';
      INSERT INTO gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
      SELECT id, '${EQUIPMENT}', 5000.00, 0, 1 FROM gl_companies WHERE code = 'BMG';
      INSERT INTO gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
      SELECT id, '${INVENTORY}', 12.50, 0, 1 FROM gl_companies WHERE code = '1084';
    `);

    const FEB = '2025-02-01';
    const MAR = '2025-03-01';
    await gl(db, '6001', 'ItemRcpt', '2025-02-10', FEB, [['0', RECEIVED, -96000, '7001'], ['1', INVENTORY, 96000]]);
    await gl(db, '6002', 'ItemShip', '2025-02-28', MAR, [['1', INVENTORY, -46500], ['2', COGS, 46500]]);
    await gl(db, '6003', 'InvAdjst', '2025-03-15', MAR, [['0', ADJUSTMENT, -10000], ['1', INVENTORY, 10000]]);
    await gl(db, '6005', 'ItemRcpt', '2025-04-05', '2025-04-01', [['0', RECEIVED, -32000], ['1', INVENTORY, 32000]]);
    await gl(db, '6006', 'ItemRcpt', '2025-02-12', FEB, [['0', RECEIVED, -25000], ['1', EQUIPMENT, 25000]]);
    await gl(db, '6008', 'ItemShip', '2025-03-10', MAR, [['1', INVENTORY, -600], ['2', COGS, 600]]);
    // Journal entries name no item: one in each of January, February and March.
    await gl(db, '6902', 'Journal', '2025-01-15', '2025-01-01', [['1', INVENTORY, -500], ['2', ADJUSTMENT, 500]]);
    await gl(db, '6900', 'Journal', '2025-02-20', FEB, [['1', INVENTORY, -4000], ['2', ADJUSTMENT, 4000]], 'Shrink written off');
    await gl(db, '6901', 'Journal', '2025-03-31', MAR, [['1', INVENTORY, 1500], ['2', ADJUSTMENT, -1500]]);

    // NetSuite's own totals: March also holds $20 of the bins received the copy hasn't got yet.
    await total(db, INVENTORY, '2025-01-01', -500);
    await total(db, INVENTORY, FEB, 96000 - 4000);
    await total(db, INVENTORY, MAR, -46500 + 10000 + 1500 - 600 + 2000);
    await total(db, INVENTORY, '2025-04-01', 32000);
    await total(db, EQUIPMENT, FEB, 25000);

    // FleetSuite's books post each by its date, the February 28 shipment in February, and haven't the tools.
    await post(db, '2025-01-15', INVENTORY, -500, ADJUSTMENT);
    await post(db, '2025-02-10', INVENTORY, 96000, RECEIVED);
    await post(db, '2025-02-20', INVENTORY, -4000, ADJUSTMENT);
    await post(db, '2025-02-28', INVENTORY, -46500, COGS);
    await post(db, '2025-03-10', INVENTORY, -600, COGS);
    await post(db, '2025-03-15', INVENTORY, 10000, ADJUSTMENT);
    await post(db, '2025-03-31', INVENTORY, 1500, ADJUSTMENT);
    await post(db, '2025-04-05', INVENTORY, 32000, RECEIVED);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  it('counts and values each item at the end of the month each document posted to', async () => {
    const data = await monthEnd(db, '2025-03-01');
    expect(data.month).toBe('2025-03-01');
    // Racks: 10 + 6 - 3, the deleted shipment and April's receipt left out, worth 1500 + 960 - 465. Bins: 40
    // counted, 10 received that the GL copy doesn't have, so only the count's value. Vinyl: shipped before any
    // was received. 1084's bins as they started.
    expect(data.rows).toEqual([
      { company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '13', value: '1995.00' },
      { company: 'BMG', item_id: BINS, location_id: WENTZVILLE, quantity: '50', value: '100.00' },
      { company: '1084', item_id: BINS, location_id: COOL_SPRINGS, quantity: '5', value: '12.50' },
      { company: 'BMG', item_id: VINYL, location_id: WENTZVILLE, quantity: '-2', value: '-6.00' },
      { company: 'BMG', item_id: TOOLS, location_id: WENTZVILLE, quantity: '1', value: '250.00' },
    ]);
    expect(data.items.map((i) => i.name)).toEqual(['LDR-24', 'BIN-10', 'VINYL-3M', 'TOOL-KIT']);
    expect(data.locations.map((l) => l.name)).toEqual(['Cool Springs', 'Wentzville']);
    expect(data.netsuite_through).toEqual([{ company: 'BMG', month: '2025-04-01' }]);
  });

  it("leaves out what posted after the month, though it's dated in it", async () => {
    const data = await monthEnd(db, '2025-02-01');
    // The racks shipped on February 28 count in March, as NetSuite posted them; the bins have nothing yet.
    expect(data.rows).toEqual([
      { company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '16', value: '2460.00' },
      { company: '1084', item_id: BINS, location_id: COOL_SPRINGS, quantity: '5', value: '12.50' },
      { company: 'BMG', item_id: TOOLS, location_id: WENTZVILLE, quantity: '1', value: '250.00' },
    ]);
    const inventory = data.parts.find((p) => p.company === 'BMG' && p.account_id === INVENTORY)!;
    expect(inventory).toMatchObject({
      ledger_start: '1400.00', ledger_moves: '915.00', items_start: '1500.00', items_moves_before: '0',
      items_moves: '960.00', netsuite_moves: '915.00', books_moves: '450.00',
      moves: [{ type: 'ItemRcpt', documents: 1, total: '960.00' }],
      entries: 2, entries_total: '-45.00', month_entries: 1, month_entries_total: '-40.00',
    });
    // FleetSuite's books have the shipment in February: $465 apart from NetSuite's until March.
    const tie = monthEndValue(data).companies[0].accounts[0];
    expect(tie).toMatchObject({ ledger: 231500, netsuite: 231500, books: 185000, notCopied: 0, booksApart: -46500, apart: -61000 });
  });

  it('breaks each inventory account down, at the month\'s end, into the items and what posted without them', async () => {
    const data = await monthEnd(db, '2025-03-01', 2);
    expect(data.parts.map((p) => [p.company, p.account_id])).toEqual([['1084', INVENTORY], ['BMG', INVENTORY], ['BMG', EQUIPMENT]]);
    const inventory = data.parts[1];
    expect(inventory).toMatchObject({
      number: '1200', name: 'Inventory', type: 'other_current_asset', usual: true,
      ledger_start: '1400.00', items_start: '1500.00',
      // 960 in February, then the shipments and the count in March.
      items_moves_before: '960.00', items_moves: '589.00', ledger_moves: '559.00',
      netsuite_moves: '579.00', books_moves: '559.00',
      moves: [{ type: 'ItemShip', documents: 2, total: '-471.00' }, { type: 'InvAdjst', documents: 1, total: '100.00' }],
      entries: 3, entries_total: '-30.00', month_entries: 1, month_entries_total: '15.00',
      kinds: [{ type: 'Journal', count: 3, total: '-30.00' }],
    });
    // The month's own first, then the biggest, at most two.
    expect(inventory.rows).toEqual([
      { doc: '6901', type: 'Journal', number: 'JO6901', date: '2025-03-31', month: '2025-03-01', name: null, memo: null, amount: '15.00' },
      { doc: '6900', type: 'Journal', number: 'JO6900', date: '2025-02-20', month: '2025-02-01', name: null, memo: 'Shrink written off', amount: '-40.00' },
    ]);
    expect(data.parts[2]).toMatchObject({
      type: 'fixed_asset', usual: false, ledger_start: '5000.00', ledger_moves: '250.00', items_start: '0',
      items_moves_before: '250.00', items_moves: '250.00', netsuite_moves: '250.00', books_moves: '0', moves: [], entries: 0,
    });
    expect(data.parts[0]).toMatchObject({ ledger_start: '12.50', items_start: '12.50', ledger_moves: '0', books_moves: '0' });
  });

  it("names every cent between the items and each account on FleetSuite's books", async () => {
    const view = monthEndValue(await monthEnd(db, '2025-03-01', 2));
    expect(view.companies.map((c) => c.company)).toEqual(['BMG', '1084']);
    const bmg = view.companies[0];
    expect(bmg.lines.map((l) => [l.item, l.location, l.quantity, l.value, l.averageCost, l.belowZero])).toEqual([
      ['BIN-10', 'Wentzville', 50, 10000, 200, false],
      ['LDR-24', 'Wentzville', 13, 199500, 199500 / 13, false],
      ['TOOL-KIT', 'Wentzville', 1, 25000, 25000, false],
      ['VINYL-3M', 'Wentzville', -2, -600, null, true],
    ]);
    expect(bmg.value).toBe(233900);
    expect(bmg.netsuiteShort).toBe(false);
    const [inventory, equipment] = bmg.accounts;
    expect(inventory).toMatchObject({
      account: '1200 Inventory', usual: true, fixedAsset: false,
      items: { before: 246000, end: 208900 },
      ledger: 195900, netsuite: 197900, books: 195900,
      start: -10000, unexplained: 0, notCopied: 2000, booksApart: -2000, apart: -13000,
    });
    expect(inventory.items.moves).toEqual([
      { type: 'Item Fulfillment', documents: 2, total: -47100 },
      { type: 'Inventory Adjustment', documents: 1, total: 10000 },
    ]);
    expect(inventory.entries).toMatchObject({ count: 3, total: -3000, month: { count: 1, total: 1500 }, more: { count: 1, total: -500 } });
    expect(inventory.entries.rows.map((r) => [r.number, r.inMonth, r.amount])).toEqual([['JO6901', true, 1500], ['JO6900', false, -4000]]);
    // The parts come to what the books hold beyond the items.
    const parts = (t: typeof inventory) => t.start + t.entries.total + t.unexplained + t.notCopied + t.booksApart;
    expect(parts(inventory)).toBe(inventory.apart);
    expect(equipment).toMatchObject({ fixedAsset: true, usual: false, start: 500000, books: 500000, booksApart: -25000, apart: 475000 });
    expect(parts(equipment)).toBe(equipment.apart);
    expect(view.companies[1]).toMatchObject({ company: '1084', value: 1250, netsuiteThrough: null, netsuiteShort: true });
    expect(view.companies[1].accounts[0]).toMatchObject({ apart: 0, start: 0 });
  });

  it('holds nothing before the stock copy starts or past what NetSuite has', async () => {
    const may = monthEndValue(await monthEnd(db, '2025-05-01'));
    // April's receipt is in; NetSuite's own totals are read through April.
    expect(may.companies[0].lines.find((l) => l.item === 'LDR-24')).toMatchObject({ quantity: 15, value: 231500 });
    expect(may.companies[0]).toMatchObject({ netsuiteThrough: '2025-04-01', netsuiteShort: true });
    const january = await monthEnd(db, '2025-01-01');
    expect(january.parts.find((p) => p.company === 'BMG' && p.account_id === INVENTORY)).toMatchObject({
      ledger_moves: '-5.00', items_moves: '0', entries: 1, month_entries: 1,
    });
  });

  it('refuses a month it can\'t read and a limit out of range', async () => {
    await expect(monthEnd(db, '2025-03-15')).rejects.toThrow(/first day of a month/);
    await expect(monthEnd(db, '2024-12-01')).rejects.toThrow(/from January 2025/);
    await expect(monthEnd(db, '2025-03-01', 0)).rejects.toThrow(/limit must be from 1 to 1000/);
    await expect(monthEnd(db, '2025-03-01', 1001)).rejects.toThrow(/limit must be from 1 to 1000/);
    await expect(one(db, 'SELECT gl_stock_month_end(NULL, 10) AS r')).rejects.toThrow(/first day of a month/);
  });

  it('is the server login\'s alone', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await one<boolean>(db, `SELECT has_function_privilege('${role}', 'public.gl_stock_month_end(date, integer)', 'EXECUTE') AS r`)).toBe(false);
    }
    expect(await one<boolean>(db, "SELECT has_function_privilege('service_role', 'public.gl_stock_month_end(date, integer)', 'EXECUTE') AS r")).toBe(true);
  });
});

describe("migration 495's inventory value at a month's end, at the edges", () => {
  const SVC_KIT = '9400';
  const BRACKET = '9500';
  const HOOKS = '9600';
  const CLIPS = '9700';
  const JUN = '2025-06-01';
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.exec('RESET ROLE');
    // A kit NetSuite doesn't keep in stock; a bracket naming no asset account; hooks and clips on the inventory account.
    await db.exec(`
      INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
        ('item', '${SVC_KIT}', 'SVC-KIT', true, '{"item_type": "NonInvtPart"}'),
        ('item', '${BRACKET}', 'BRK-1', true, '{"item_type": "InvtPart"}'),
        ('item', '${HOOKS}', 'HOOK-2', true, '{"item_type": "InvtPart", "asset_account": "${INVENTORY}"}'),
        ('item', '${CLIPS}', 'CLIP-3', true, '{"item_type": "InvtPart", "asset_account": "${INVENTORY}"}'),
        ('vendor', '7002', 'Beta Bins', true, '{}');
    `);
    await db.exec('SET ROLE service_role');
    // June: the kit received on the inventory account's line, and a rack and two bins on one receipt.
    expect(await call(db, 'gl_netsuite_stock_apply', {
      documents: [
        doc('7101', 'ItemRcpt', 'IR7101', '2025-06-03', [['1', SVC_KIT, WENTZVILLE, '1', false]]),
        doc('7102', 'ItemRcpt', 'IR7102', '2025-06-10', [['1', LADDER, WENTZVILLE, '1', true], ['2', BINS, WENTZVILLE, '2', true]]),
      ],
    })).toMatchObject({ received: 2, added: 2 });
    // At the start: the kit and the bracket counted with a value, hooks with value and none on hand, clips with neither.
    expect(await call(db, 'gl_netsuite_stock_store_opening', {
      rows: [
        { company: 'BMG', item_id: SVC_KIT, location_id: WENTZVILLE, quantity: '2', value: '8.00' },
        { company: 'BMG', item_id: BRACKET, location_id: WENTZVILLE, quantity: '4', value: '20.00' },
        { company: 'BMG', item_id: HOOKS, location_id: WENTZVILLE, quantity: '0', value: '3.00' },
        { company: 'BMG', item_id: CLIPS, location_id: WENTZVILLE, quantity: '0', value: '0' },
      ],
    })).toEqual({ rows: 4 });
    await gl(db, '7101', 'ItemRcpt', '2025-06-03', JUN, [['0', RECEIVED, -500, '7001'], ['1', INVENTORY, 500]]);
    await gl(db, '7102', 'ItemRcpt', '2025-06-10', JUN, [['0', RECEIVED, -16400, '7001'], ['1', INVENTORY, 16000], ['2', INVENTORY, 400]]);
    // Journals naming no item: one that moves the account by nothing, one with a line NetSuite posted to May, and one
    // whose line on the account names a vendor other than the document's first.
    await gl(db, '7103', 'Journal', '2025-06-15', JUN, [['1', INVENTORY, 700], ['2', INVENTORY, -700]]);
    await gl(db, '7104', 'Journal', '2025-06-20', JUN, [['1', INVENTORY, 300, undefined, '2025-05-01'], ['2', INVENTORY, 200], ['3', ADJUSTMENT, -500]]);
    await gl(db, '7105', 'Journal', '2025-06-25', JUN, [['0', ADJUSTMENT, -900, '7001'], ['1', INVENTORY, 900, '7002']]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  it('values only what NetSuite keeps in stock, and shows what has a count or a value', async () => {
    const data = await monthEnd(db, JUN);
    // The kit keeps its count but has no value; the bracket and the hooks keep theirs; the clips have nothing.
    expect(data.rows).toEqual([
      { company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '1', value: '160.00' },
      { company: 'BMG', item_id: BINS, location_id: WENTZVILLE, quantity: '2', value: '4.00' },
      { company: 'BMG', item_id: SVC_KIT, location_id: WENTZVILLE, quantity: '2', value: '0' },
      { company: 'BMG', item_id: BRACKET, location_id: WENTZVILLE, quantity: '4', value: '20.00' },
      { company: 'BMG', item_id: HOOKS, location_id: WENTZVILLE, quantity: '0', value: '3.00' },
    ]);
    expect(data.items.map((i) => i.name)).toEqual(['LDR-24', 'BIN-10', 'SVC-KIT', 'BRK-1', 'HOOK-2']);
  });

  it('ties a stocked item naming no inventory account to the usual one, and a kit\'s line to the documents', async () => {
    const data = await monthEnd(db, JUN);
    expect(data.parts.map((p) => [p.company, p.account_id])).toEqual([['BMG', INVENTORY]]);
    expect(data.parts[0]).toMatchObject({
      usual: true, ledger_start: '0', ledger_moves: '183.00', items_start: '23.00', items_moves_before: '0', items_moves: '164.00',
      // One receipt, though two of its lines posted to the account.
      moves: [{ type: 'ItemRcpt', documents: 1, total: '164.00' }],
      // The journal that nets to nothing isn't one; the one partly posted to May counts in June, its latest.
      entries: 3, entries_total: '19.00', month_entries: 3, month_entries_total: '19.00',
      kinds: [{ type: 'Journal', count: 2, total: '14.00' }, { type: 'ItemRcpt', count: 1, total: '5.00' }],
    });
    expect(data.parts[0].rows.map((r) => [r.doc, r.month, r.name, r.amount])).toEqual([
      ['7105', JUN, 'Beta Bins', '9.00'],
      ['7101', JUN, 'Acme Racks', '5.00'],
      ['7104', JUN, null, '5.00'],
    ]);
    const tie = monthEndValue(data).companies[0].accounts[0];
    expect(tie).toMatchObject({ items: { before: 2300, end: 18700 }, ledger: 18300, start: -2300, unexplained: 0 });
  });
});
