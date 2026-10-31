// Migration 457 has Books put each Inventory Adjust (migration 454) next to
// NetSuite's inventory adjustment, valued at FleetSuite's own average of the
// item at the location just before, and the posting job post it in place of
// NetSuite's adjustment when it matches and makes the same entry. This runs
// migration 314 (with stand-ins for the app tables it and 407, 416, 435 and
// 454 point at) and migrations 359–364, 367, 370, 374, 376, 377, 380,
// 382–387, 389–395, 397, 399, 401–405, 407, 409, 416, 435, 436, 454, 456 and
// 457 in an in-memory Postgres (PGlite) as the app's server login, holds what
// gl_own_adjustment_pairs and gl_own_adjustment_months return, then runs the
// posting job against made-up NetSuite adjustments and Inventory Adjusts, and
// reads what Own adjustments shows of them.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({
  isSuiteqlError: (err: unknown) => err instanceof Error && typeof (err as any).status === 'number',
  suiteqlQuery: vi.fn(),
  suiteqlQueryAll: vi.fn(),
}));
vi.mock('@/lib/system-health', () => ({
  recordHeartbeat: vi.fn(async (service: any, syncType: string, lastResult: unknown) => {
    await service.from('sync_state').upsert({ sync_type: syncType, last_result: lastResult });
    return { ok: true };
  }),
}));

import { postInvoices } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { checkOwnAdjustments, INVENTORY_ADJUST_ACCOUNT, type AdjustPairsData, type OwnAdjustmentCheck } from './own-adjustment-check';
import { readOwnBooks } from './own-invoice-posting';
import { ADJUSTMENT_BOOKS } from './own-stock-posting';
import { readOwnStockView } from './own-posting-view';
import { ownBooksText } from './own-posting-text';

const OFALLON = '1';
const WENTZVILLE = '2';
const LADDER = '9001';
const BINS = '9002';
const HOOK = '9004';
const STRAP = '9003';
/**
 * Made-up chart: '190' the items' inventory, '520' the account Inventory
 * Adjust posts to, '210' stock received but not billed, '580' cost of goods
 * sold.
 */
const INVENTORY = '190';
const ADJUSTMENT = '520';
const RECEIVED = '210';
const COGS = '580';
const ACCOUNTS: Array<[string, string, string, string]> = [
  [INVENTORY, '19000', 'Inventory Asset', 'other_current_asset'],
  [ADJUSTMENT, '52000', 'Inventory Adjustment', 'cost_of_goods_sold'],
  [RECEIVED, '21000', 'Received Not Billed', 'other_current_liability'],
  [COGS, '58000', 'Cost of Goods Sold', 'cost_of_goods_sold'],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';

/** FleetSuite's ids for the Inventory Adjusts. */
const DAMAGED = '3c1e6a2b-7d4f-4e8a-9b0c-1d2e3f4a5b6c';
const COUNTED = '4d2f7b3c-8e5a-4f9b-8c1d-2e3f4a5b6c7d';
const UNSAID = '5e3a8c4d-9f6b-4a0c-9d2e-3f4a5b6c7d8e';
const NOWHERE = '6f4b9d5e-0a7c-4b1d-8e3f-4a5b6c7d8e9f';
const STRAPPED = '8b6d1f70-2c9e-4d3f-8a5b-6c7d8e9f0a1b';

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
    -- What migrations 314, 407, 416, 435 and 454 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.netsuite_parts (id UUID PRIMARY KEY);
    CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE TABLE public.netsuite_sales_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), netsuite_id TEXT NOT NULL UNIQUE, tranid TEXT,
      customer_netsuite_id TEXT, customer_name TEXT
    );
    CREATE TABLE public.vendor_invoices (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.payouts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.po_receipts (id UUID PRIMARY KEY, ns_status TEXT NOT NULL);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '364-books-invoice-check.sql',
    '367-books-invoice-posting.sql', '370-books-credit-memos.sql', '374-books-payment-check.sql', '376-books-payment-posting.sql',
    '377-books-differences.sql', '380-books-netsuite-month.sql', '382-books-customer-deposits.sql', '383-books-deposit-posting.sql',
    '384-books-vendor-bills.sql', '385-books-bill-item-accounts.sql', '386-books-bill-posting.sql', '387-books-retired-accounts.sql',
    '389-books-bill-payments.sql', '390-books-bill-payment-posting.sql', '391-books-checks-and-cards.sql', '392-books-spending-posting.sql',
    '393-books-journal-entries.sql', '394-books-bank-deposits.sql', '395-books-stock-cost.sql',
    '397-books-stock-postings-once.sql', '399-books-customer-refunds.sql',
    '401-books-stock-by-item.sql', '402-books-stock-values.sql', '403-books-stock-item-setup.sql',
    '404-books-stock-ledger-parts.sql', '405-books-stock-account-items.sql',
    '407-books-own-invoices.sql', '409-books-own-invoice-posting.sql',
    '416-books-own-fulfillments.sql', '435-books-own-bills.sql', '436-books-snap-a-bill.sql', '454-inventory-adjustments.sql',
    '456-books-own-postings.sql', '457-books-own-adjustments.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  for (const [ns, number, name, type] of ACCOUNTS) {
    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active) VALUES ($1, $2, $3, $4, $5, NULL, true)`,
      [accountId(ns), number, name, type, ns],
    );
  }
  // NetSuite's items and places, as the lists copy has them.
  for (const [kind, id, name, details] of [
    ['item', LADDER, 'LDR-24', { display_name: 'Ladder rack 24 in', item_type: 'InvtPart', asset_account: INVENTORY }],
    ['item', BINS, 'BIN-10', { item_type: 'InvtPart', asset_account: INVENTORY }],
    ['item', HOOK, 'HK-1', { item_type: 'InvtPart', asset_account: INVENTORY }],
    ['item', STRAP, 'STRAP-2', { item_type: 'NonInvtPart' }],
    ['location', OFALLON, "O'Fallon", { subsidiary_id: '2' }],
    ['location', WENTZVILLE, 'Wentzville', { subsidiary_id: '2' }],
  ] as const) {
    await pg.query(
      'INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ($1, $2, $3, true, $4::jsonb)',
      [kind, id, name, JSON.stringify(details)],
    );
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

/** A Postgres text[] literal, as PostgREST sends a list. */
const textArray = (items: string[]) => `{${items.map((s) => `"${s.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;
const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

// ── NetSuite's documents, as the copies of its stock moves and GL have them ──

/** A stock line as the copy hands it over: [line, item, location, quantity, moves stock]. */
type StockLine = [line: string, item: string, location: string, quantity: string, moves: boolean];
const stockDoc = (id: string, type: string, number: string, date: string, lines: StockLine[], company = 'BMG') => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date,
  lines: lines.map(([line_id, item_id, location_id, quantity, moves_stock]) => ({ line_id, company, item_id, location_id, quantity, moves_stock })),
});
/** NetSuite's adjustment of one item: the line that changes its count, and the one on its other side. */
const adjustDoc = (id: string, number: string, date: string, item: string, quantity: string) =>
  stockDoc(id, 'InvAdjst', number, date, [['1', item, OFALLON, quantity, true], ['2', item, OFALLON, quantity, false]]);

/**
 * What NetSuite posted for a document, in the GL copy, its lines replaced whole: [line, account, cents debit positive],
 * each of them `company`'s.
 */
async function gl(pg: PGlite, id: string, type: string, number: string, date: string, lines: Array<[string, string, number]>, company = 'BMG') {
  await pg.query('DELETE FROM gl_netsuite_lines WHERE transaction_id = $1', [id]);
  await pg.query('DELETE FROM gl_netsuite_transactions WHERE netsuite_id = $1', [id]);
  const month = `${date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, number, date, month],
  );
  for (const [line, account, cents] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', company],
    );
  }
}

// ── Inventory Adjusts ──────────────────────────────────────────────────────

interface Adjust {
  id: string;
  item: string;
  itemNumber: string;
  location: string | null;
  mode: 'delta' | 'count';
  entered: string;
  change: string;
  onHand: string | null;
  reason: string;
  note: string | null;
  netsuiteId: string | null;
  netsuiteNumber: string | null;
  at: string;
}

/** An Inventory Adjust as Inventory Adjust saves it once NetSuite took it, through the app's server login. */
async function adjusted(pg: PGlite, a: Adjust) {
  await pg.query(
    `INSERT INTO inventory_adjustments (id, netsuite_item_id, item_number, location_id, mode, entered_qty, change, on_hand_before, reason,
       note, netsuite_adjustment_id, netsuite_adjustment_number, created_by_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Pat Example', $13)`,
    [a.id, a.item, a.itemNumber, a.location, a.mode, a.entered, a.change, a.onHand, a.reason, a.note, a.netsuiteId, a.netsuiteNumber, a.at],
  );
}

/** Pat took two cracked bins off at O'Fallon at 9:30 PM Central on February 14, 2025 (03:30 UTC the 15th). */
const damaged = (onHand: string): Adjust => ({
  id: DAMAGED, item: BINS, itemNumber: 'BIN-10', location: OFALLON, mode: 'delta', entered: '2', change: '-2', onHand,
  reason: 'Damaged', note: 'Cracked lids', netsuiteId: '7201', netsuiteNumber: 'ADJ0143', at: '2025-02-15T03:30:00Z',
});
/** And on February 20 counted five ladder racks on the shelf where NetSuite had four. */
const counted: Adjust = {
  id: COUNTED, item: LADDER, itemNumber: 'LDR-24', location: OFALLON, mode: 'count', entered: '5', change: '1', onHand: '4',
  reason: 'Found in back', note: null, netsuiteId: '7202', netsuiteNumber: 'ADJ0144', at: '2025-02-20T15:00:00Z',
};

const pairs = (pg: PGlite, from: string | null, to: string | null, id: string | null = null, account = INVENTORY_ADJUST_ACCOUNT) =>
  one<AdjustPairsData>(pg, 'SELECT gl_own_adjustment_pairs($1::date, $2::date, $3::uuid, $4) AS r', [from, to, id, account]);

// ── The functions ──────────────────────────────────────────────────────────

describe("migration 457's functions", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    // On December 31, 2024 O'Fallon had ten bins at $15 and four ladder racks at $140, Wentzville five bins, and 1084
    // three bins at O'Fallon of its own, and two straps NetSuite doesn't keep in stock were on its books. In 2025
    // NetSuite received four bins into O'Fallon at $25 (and two for 1084), shipped one from Wentzville, two from
    // O'Fallon in a fulfillment it has since deleted, and on February 14 one before its adjustment of Pat's two and one
    // after; on February 20 its adjustment of the ladder racks Pat counted added a hook too, and on March 10 it made one
    // it has since deleted.
    expect(await call(pg, 'gl_netsuite_stock_store_opening', {
      rows: [
        { company: 'BMG', item_id: BINS, location_id: OFALLON, quantity: '10', value: '150.00' },
        { company: 'BMG', item_id: BINS, location_id: WENTZVILLE, quantity: '5', value: '100.00' },
        { company: 'BMG', item_id: LADDER, location_id: OFALLON, quantity: '4', value: '560.00' },
        { company: '1084', item_id: BINS, location_id: OFALLON, quantity: '3', value: '60.00' },
        { company: 'BMG', item_id: STRAP, location_id: OFALLON, quantity: '2', value: '10.00' },
      ],
    })).toEqual({ rows: 5 });
    const shipped = (id: string, date: string, location: string, quantity: string) =>
      stockDoc(id, 'ItemShip', `IF${id}`, date, [['1', BINS, location, quantity, true], ['2', BINS, location, quantity, false]]);
    expect(await call(pg, 'gl_netsuite_stock_apply', {
      documents: [
        stockDoc('7101', 'ItemRcpt', 'IR7101', '2025-01-15', [['1', BINS, OFALLON, '4', true]]),
        stockDoc('7120', 'ItemRcpt', 'IR7120', '2025-01-25', [['1', BINS, OFALLON, '2', true]], '1084'),
        shipped('7102', '2025-01-20', WENTZVILLE, '-1'),
        shipped('7050', '2025-02-01', OFALLON, '-2'),
        shipped('7150', '2025-02-14', OFALLON, '-1'),
        adjustDoc('7201', 'ADJ0143', '2025-02-14', BINS, '-2'),
        shipped('7300', '2025-02-14', OFALLON, '-1'),
        stockDoc('7202', 'InvAdjst', 'ADJ0144', '2025-02-20', [
          ['1', LADDER, OFALLON, '1', true], ['2', LADDER, OFALLON, '1', false], ['3', HOOK, OFALLON, '1', true], ['4', HOOK, OFALLON, '1', false],
        ]),
        adjustDoc('7203', 'ADJ0146', '2025-03-10', BINS, '3'),
      ],
    })).toMatchObject({ added: 9 });
    expect(await call(pg, 'gl_netsuite_stock_finish', {
      netsuite_ids: ['7101', '7120', '7102', '7150', '7201', '7300', '7202'],
    })).toMatchObject({ gone: 2 });
    await gl(pg, '7101', 'ItemRcpt', 'IR7101', '2025-01-15', [['0', RECEIVED, -10000], ['1', INVENTORY, 10000]]);
    await gl(pg, '7120', 'ItemRcpt', 'IR7120', '2025-01-25', [['0', RECEIVED, -5000], ['1', INVENTORY, 5000]], '1084');
    await gl(pg, '7102', 'ItemShip', 'IF7102', '2025-01-20', [['1', INVENTORY, -2000], ['2', COGS, 2000]]);
    // The deleted fulfillment is still in the copy of the ledger.
    await gl(pg, '7050', 'ItemShip', 'IF7050', '2025-02-01', [['1', INVENTORY, -3571], ['2', COGS, 3571]]);
    await gl(pg, '7150', 'ItemShip', 'IF7150', '2025-02-14', [['1', INVENTORY, -1786], ['2', COGS, 1786]]);
    await gl(pg, '7201', 'InvAdjst', 'ADJ0143', '2025-02-14', [['1', INVENTORY, -3571], ['2', ADJUSTMENT, 3571]]);
    await gl(pg, '7300', 'ItemShip', 'IF7300', '2025-02-14', [['1', INVENTORY, -1786], ['2', COGS, 1786]]);
    await gl(pg, '7202', 'InvAdjst', 'ADJ0144', '2025-02-20', [
      ['1', INVENTORY, 14000], ['2', ADJUSTMENT, -14000], ['3', INVENTORY, 500], ['4', ADJUSTMENT, -500],
    ]);
    // And a line of 1084's on it, which isn't BMG's entry.
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT '7202', '5', id, $1, $2, '2025-02-20', '7.00', '0' FROM gl_companies WHERE code = '1084'`,
      [INVENTORY, FEB],
    );

    await adjusted(pg, damaged('13'));
    await adjusted(pg, counted);
    // One whose NetSuite id Inventory Adjust saved as something else, at 11:30 PM Central on February 28 (05:30 UTC
    // March 1), and one that saved no location, at 12:30 AM Central on March 10, daylight saving time (05:30 UTC).
    await adjusted(pg, {
      id: UNSAID, item: BINS, itemNumber: 'BIN-10', location: OFALLON, mode: 'delta', entered: '1', change: '-1', onHand: '10',
      reason: 'Used in shop', note: null, netsuiteId: 'ADJ0145', netsuiteNumber: null, at: '2025-03-01T05:30:00Z',
    });
    await adjusted(pg, {
      id: NOWHERE, item: BINS, itemNumber: 'BIN-10', location: null, mode: 'delta', entered: '3', change: '3', onHand: null,
      reason: 'Returned', note: null, netsuiteId: '7203', netsuiteNumber: 'ADJ0146', at: '2025-03-10T05:30:00Z',
    });
    // And one of the straps, on January 31.
    await adjusted(pg, {
      id: STRAPPED, item: STRAP, itemNumber: 'STRAP-2', location: OFALLON, mode: 'delta', entered: '1', change: '-1', onHand: '2',
      reason: 'Damaged', note: null, netsuiteId: null, netsuiteNumber: null, at: '2025-01-31T15:00:00Z',
    });
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('gl_own_adjustment_pairs puts an Inventory Adjust made on the days asked about, in Central time, next to NetSuite\'s adjustment', async () => {
    expect(await pairs(pg, '2025-02-14', '2025-02-14')).toEqual({
      adjustments: [{
        own: {
          id: DAMAGED, item_id: BINS, item_number: 'BIN-10', location_id: OFALLON, mode: 'delta', entered_qty: '2.00', change: '-2.00',
          on_hand_before: '13.00', reason: 'Damaged', note: 'Cracked lids', netsuite_id: '7201', number: 'ADJ0143', made_by: 'Pat Example',
          date: '2025-02-14', made_at: '2025-02-15T03:30:00+00:00',
        },
        netsuite: {
          number: 'ADJ0143', type: 'InvAdjst', date: '2025-02-14', gone: false,
          lines: [
            { line_id: '1', company: 'BMG', item_id: BINS, location_id: OFALLON, quantity: '-2', moves_stock: true, value: '-35.71' },
            // Its other side posted nothing to stock.
            { line_id: '2', company: 'BMG', item_id: BINS, location_id: OFALLON, quantity: '-2', moves_stock: false, value: null },
          ],
        },
        netsuite_gl: {
          posting_month: FEB,
          entry: [
            { account_id: INVENTORY, debit: '0.00', credit: '35.71', inventory: true },
            { account_id: ADJUSTMENT, debit: '35.71', credit: '0.00', inventory: false },
          ],
        },
        // Ten at the start, four received and one shipped earlier that day: not the two NetSuite deleted, nor
        // Wentzville's, nor 1084's, nor the one shipped after it, nor the adjustment itself.
        before: { quantity: '13', value: '232.14' },
      }],
      items: { [BINS]: { number: 'BIN-10', type: 'InvtPart', display_name: null, asset_account: INVENTORY } },
      locations: { [OFALLON]: "O'Fallon", [WENTZVILLE]: 'Wentzville' },
      accounts: { [INVENTORY]: { number: '19000', name: 'Inventory Asset' }, [ADJUSTMENT]: { number: '52000', name: 'Inventory Adjustment' } },
      account: { id: ADJUSTMENT, number: '52000', name: 'Inventory Adjustment' },
    });
  });

  it("gives every one made in the days asked about, newest first, each with what FleetSuite counted just before it", async () => {
    const feb = await pairs(pg, '2025-02-01', '2025-02-28');
    // Made at 05:30 UTC on March 1, so on February 28 in Central time; the one with no location was made in March.
    expect(feb.adjustments.map((a) => [a.own.id, a.own.date, a.own.netsuite_id, a.own.number])).toEqual([
      [UNSAID, '2025-02-28', null, null],
      [COUNTED, '2025-02-20', '7202', 'ADJ0144'],
      [DAMAGED, '2025-02-14', '7201', 'ADJ0143'],
    ]);
    const [unsaid, count] = feb.adjustments;
    // NetSuite's id for it isn't a number, so there's nothing of NetSuite's to put it next to; what FleetSuite counted
    // before it is everything dated before its day, Pat's two among them.
    expect(unsaid).toMatchObject({ netsuite: null, netsuite_gl: null, before: { quantity: '10', value: '178.57' } });
    expect(count.own).toMatchObject({ mode: 'count', entered_qty: '5.00', change: '1.00', on_hand_before: '4.00', reason: 'Found in back', note: null });
    expect(count.before).toEqual({ quantity: '4', value: '560.00' });
    expect(count.netsuite!.lines.map((l) => [l.line_id, l.item_id, l.quantity, l.moves_stock, l.value])).toEqual([
      ['1', LADDER, '1', true, '140.00'], ['2', LADDER, '1', false, null], ['3', HOOK, '1', true, '5.00'], ['4', HOOK, '1', false, null],
    ]);
    expect(count.netsuite_gl!.entry).toEqual([
      { account_id: INVENTORY, debit: '145.00', credit: '0.00', inventory: true },
      { account_id: ADJUSTMENT, debit: '0.00', credit: '145.00', inventory: false },
    ]);
    // The items on either side, the hook NetSuite's adjustment added among them.
    expect(feb.items).toEqual({
      [LADDER]: { number: 'LDR-24', type: 'InvtPart', display_name: 'Ladder rack 24 in', asset_account: INVENTORY },
      [BINS]: { number: 'BIN-10', type: 'InvtPart', display_name: null, asset_account: INVENTORY },
      [HOOK]: { number: 'HK-1', type: 'InvtPart', display_name: null, asset_account: INVENTORY },
    });

    // March has the one with no location, made at 12:30 AM on March 10 in daylight saving time: nothing counted before
    // it, and NetSuite has deleted its adjustment.
    const mar = await pairs(pg, MAR, '2025-03-31');
    expect(mar.adjustments.map((a) => [a.own.id, a.own.date, a.own.location_id, a.netsuite_gl, a.before])).toEqual([
      [NOWHERE, '2025-03-10', null, null, null],
    ]);
    expect(mar.adjustments[0].netsuite).toEqual({
      number: 'ADJ0146', type: 'InvAdjst', date: '2025-03-10', gone: true,
      lines: [
        { line_id: '1', company: 'BMG', item_id: BINS, location_id: OFALLON, quantity: '3', moves_stock: true, value: null },
        { line_id: '2', company: 'BMG', item_id: BINS, location_id: OFALLON, quantity: '3', moves_stock: false, value: null },
      ],
    });
    expect(mar.accounts).toEqual({});
    expect(await pairs(pg, '2025-04-01', '2025-04-30')).toMatchObject({ adjustments: [], items: {}, accounts: {} });
  });

  it("values an item NetSuite doesn't keep in stock at nothing, as Stock by item does", async () => {
    const jan = await pairs(pg, JAN, '2025-01-31');
    expect(jan.adjustments.map((a) => [a.own.id, a.own.date, a.before])).toEqual([[STRAPPED, '2025-01-31', { quantity: '2', value: '0' }]]);
    expect(jan.items).toEqual({ [STRAP]: { number: 'STRAP-2', type: 'NonInvtPart', display_name: null, asset_account: null } });
  });

  it('gives only the one asked about by its id, whatever the days', async () => {
    for (const [from, to] of [[null, null], [MAR, '2025-03-31']]) {
      const res = await pairs(pg, from, to, COUNTED);
      expect(res.adjustments.map((a) => a.own.id), `${from}`).toEqual([COUNTED]);
    }
    expect((await pairs(pg, null, null, '7d5c0e6f-1b8d-4c2e-9f4a-5b6c7d8e9f0a')).adjustments).toEqual([]);
  });

  it("names the chart's active account numbered as asked, and none when the chart has none", async () => {
    expect((await pairs(pg, null, null, DAMAGED, '59999')).account).toBeNull();
    // A retired account numbered 52000, which NetSuite's id would put first.
    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active) VALUES ($1, '52000', 'Old adjustments', 'expense', '519', NULL, false)`,
      [accountId('519')],
    );
    expect((await pairs(pg, null, null, DAMAGED)).account).toEqual({ id: ADJUSTMENT, number: '52000', name: 'Inventory Adjustment' });
  });

  it('checks each one against NetSuite\'s from what the function gives', async () => {
    const { adjustments } = checkOwnAdjustments(await pairs(pg, '2025-02-01', '2025-03-31'), { stock: null, ledger: null });
    expect(adjustments.map((a) => [a.number, a.status, a.fleetsuiteValue, a.netsuiteValue, a.summary])).toEqual([
      ['ADJ0146', 'voided', null, null, "NetSuite's adjustment is gone from NetSuite."],
      ['Inventory Adjust', 'incomplete', -1786, null, "NetSuite didn't say which adjustment it made, so there's none to put this next to."],
      ['ADJ0144', 'differs', 14000, 14500, "Change: NetSuite's adjustment also made it 1 more HK-1, which Inventory Adjust didn't."],
      // Two at $17.857 each, the average of 13 bins worth $232.14.
      ['ADJ0143', 'matches', -3571, -3571, "Matches NetSuite's adjustment."],
    ]);
  });

  it('gl_own_adjustment_months counts them by the month they were made in Central time, newest first', async () => {
    expect(await one(pg, 'SELECT gl_own_adjustment_months() AS r')).toEqual([
      { month: MAR, adjustments: 1 },
      { month: FEB, adjustments: 3 },
      { month: JAN, adjustments: 1 },
    ]);
  });

  it("is the service role's alone, and neither read writes anything", async () => {
    await pg.exec('RESET ROLE');
    for (const fn of ['public.gl_own_adjustment_pairs(date, date, uuid, text)', 'public.gl_own_adjustment_months()']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>(pg, `SELECT has_function_privilege($1::name, '${fn}', 'EXECUTE') AS r`, [role]), `${fn} ${role}`)
          .toBe(role === 'service_role');
      }
    }
    for (const name of ['gl_own_adjustment_pairs', 'gl_own_adjustment_months']) {
      const body = await one<string>(pg, 'SELECT prosrc AS r FROM pg_proc WHERE proname = $1', [name]);
      expect(body, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    }
    await pg.exec('SET ROLE service_role');
  });
});

// ── The job, and Own adjustments ───────────────────────────────────────────

describe('the posting job, with Inventory Adjusts', () => {
  let pg: PGlite;
  const clock = Date.parse('2025-02-27T12:00:00Z');
  const store = new Map<string, any>();
  /** Reads made to fail: a function by its name. */
  const failing = new Set<string>();

  // sync_state in memory; gl_accounts, gl_companies, the GL copy's documents and every function the real ones, called
  // the way supabase-js calls them.
  const service = () => ({
    from: (table: string) => {
      if (table === 'sync_state') {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => ({ data: store.has(key) ? { last_result: store.get(key).last_result } : null, error: null }),
            }),
          }),
          upsert: async (row: Record<string, unknown>) => {
            store.set(row.sync_type as string, JSON.parse(JSON.stringify({ ...store.get(row.sync_type as string), ...row })));
            return { error: null };
          },
        };
      }
      if (table === 'gl_accounts') {
        return {
          select: (cols: string) => ({
            order: (col: string) => ({
              range: async (from: number, to: number) => ({
                data: (await pg.query(`SELECT ${cols} FROM gl_accounts ORDER BY ${col} LIMIT ${to - from + 1} OFFSET ${from}`)).rows,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'gl_companies') {
        return { select: async (cols: string) => ({ data: (await pg.query(`SELECT ${cols} FROM gl_companies ORDER BY code`)).rows, error: null }) };
      }
      if (table === 'gl_periods') {
        // The months closed in FleetSuite's books, read as src/lib/books/months.ts reads them.
        return { select: () => ({ eq: (col: string, value: string) => ({ order: () => ({ range: async (from: number, to: number) => ({
          data: (await pg.query(`SELECT id, company_id, to_char(period_start, 'YYYY-MM-DD') AS period_start FROM gl_periods
            WHERE ${col} = $1 ORDER BY id LIMIT ${to - from + 1} OFFSET ${from}`, [value])).rows,
          error: null,
        }) }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (failing.has(fn)) return { data: null, error: { message: `${fn} failed` } };
      const names = Object.keys(args);
      const value = (v: unknown) => (Array.isArray(v) ? textArray(v.map(String)) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
      try {
        const r = await pg.query<{ r: unknown }>(
          `SELECT ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`,
          names.map((n) => value(args[n])),
        );
        return { data: r.rows[0].r, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
  }) as any;

  // A stock document's entry comes from the copies, so there's nothing to ask NetSuite.
  const query = async () => { throw new Error('NetSuite was asked about lines'); };
  const run = () => postInvoices(service(), { deadline: clock + 240_000, deps: { query, now: () => clock, companies: ['BMG'] } });

  /** The journal, entry by entry: a document's entry by its key, a reversal by the entry it reverses. */
  const journal = async () => (await pg.query<{ no: number; date: string; key: string | null; reverses: number | null; memo: string | null; rule: string }>(
    `SELECT e.entry_no::int AS no, to_char(e.entry_date, 'YYYY-MM-DD') AS date,
            CASE WHEN e.reverses_entry_id IS NULL THEN e.idempotency_key END AS key, r.entry_no::int AS reverses, e.memo,
            e.posting_rule AS rule
     FROM gl_entries e LEFT JOIN gl_entries r ON r.id = e.reverses_entry_id
     ORDER BY e.entry_no`,
  )).rows;
  const linesOf = async (no: number) => (await pg.query(
    `SELECT a.netsuite_account_id AS account, l.debit::text AS debit, l.credit::text AS credit, l.memo, l.source_line_ref
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
     WHERE e.entry_no = $1 ORDER BY l.line_no`,
    [no],
  )).rows;
  /** What the books hold in each account, debit positive. */
  const balances = async () => (await pg.query<{ account: string; cents: string }>(
    `SELECT a.netsuite_account_id AS account, sum(l.debit - l.credit)::text AS cents
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id GROUP BY 1 ORDER BY 1`,
  )).rows;
  const checked = async (id: string) => checkOwnAdjustments(await pairs(pg, null, null, id), { stock: null, ledger: null })
    .adjustments[0] as OwnAdjustmentCheck & { netsuiteId: string };

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    // Ten bins and four ladder racks at O'Fallon on December 31, 2024; four bins received at $25 in January. In
    // February NetSuite's adjustments: Pat's two cracked bins at the bins' average, the rack Pat counted at $150 (its own
    // average having drifted from FleetSuite's $140), and one bin someone took off in NetSuite by hand.
    expect(await call(pg, 'gl_netsuite_stock_store_opening', {
      rows: [
        { company: 'BMG', item_id: BINS, location_id: OFALLON, quantity: '10', value: '150.00' },
        { company: 'BMG', item_id: LADDER, location_id: OFALLON, quantity: '4', value: '560.00' },
      ],
    })).toEqual({ rows: 2 });
    expect(await call(pg, 'gl_netsuite_stock_apply', {
      documents: [
        stockDoc('7101', 'ItemRcpt', 'IR7101', '2025-01-15', [['1', BINS, OFALLON, '4', true]]),
        adjustDoc('7201', 'ADJ0143', '2025-02-14', BINS, '-2'),
        adjustDoc('7202', 'ADJ0144', '2025-02-20', LADDER, '1'),
        adjustDoc('7210', 'ADJ0150', '2025-02-25', BINS, '-1'),
      ],
    })).toMatchObject({ added: 4 });
    await gl(pg, '7101', 'ItemRcpt', 'IR7101', '2025-01-15', [['0', RECEIVED, -10000], ['1', INVENTORY, 10000]]);
    await gl(pg, '7201', 'InvAdjst', 'ADJ0143', '2025-02-14', [['1', INVENTORY, -3571], ['2', ADJUSTMENT, 3571]]);
    await gl(pg, '7202', 'InvAdjst', 'ADJ0144', '2025-02-20', [['1', INVENTORY, 15000], ['2', ADJUSTMENT, -15000]]);
    await gl(pg, '7210', 'InvAdjst', 'ADJ0150', '2025-02-25', [['1', INVENTORY, -1786], ['2', ADJUSTMENT, 1786]]);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it("posts NetSuite's adjustments while FleetSuite made none of them", async () => {
    const r = await run();
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ months: [JAN, FEB], posted: 4, replaced: 0, reversed: 0, failedCount: 0 });
    expect((await journal()).map((e) => [e.key, e.rule, e.date])).toEqual([
      ['item_receipt:7101:1', 'stock@1', '2025-01-15'],
      ['inventory_adjustment:7201:1', 'stock@1', '2025-02-14'],
      ['inventory_adjustment:7202:1', 'stock@1', '2025-02-20'],
      ['inventory_adjustment:7210:1', 'stock@1', '2025-02-25'],
    ]);
  });

  it("replaces NetSuite's entry with the Inventory Adjust's where it matches and its entry is the same, and nothing in the books moves", async () => {
    await adjusted(pg, damaged('14'));
    await adjusted(pg, counted);
    const before = await balances();
    const r = await run();
    expect(r.error).toBeUndefined();
    // The rack's value differs, and nobody used Inventory Adjust for the bin taken off by hand, so NetSuite's stand.
    expect(r).toMatchObject({ posted: 0, replaced: 1, reversed: 0, unchanged: 3, failedCount: 0 });
    expect((await journal()).slice(4).map((e) => [e.no, e.key, e.reverses, e.memo, e.rule])).toEqual([
      [5, null, 2, "ADJ0143 now posts from FleetSuite's own copy", 'reversal'],
      [6, 'inventory_adjustment:7201:2', null, 'ADJ0143', 'own_adjustment@1'],
    ]);
    expect(await balances()).toEqual(before);
    // Two bins at the average of the 14 there just before, worth $250: off the bins' asset account, onto 52000.
    expect(await linesOf(6)).toEqual([
      { account: INVENTORY, debit: '0.00', credit: '35.71', memo: 'Damaged · BIN-10', source_line_ref: 'own:9002:asset' },
      { account: ADJUSTMENT, debit: '35.71', credit: '0.00', memo: 'Damaged · BIN-10', source_line_ref: 'own:adjustment' },
    ]);
  });

  it('changes nothing the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 4, failedCount: 0 });
    expect(await journal()).toEqual(before);
  });

  it("says which copy made each entry, and on each one's page the Inventory Adjust's entry next to NetSuite's", async () => {
    const ids = ['7201', '7202', '7210'];
    expect(Object.fromEntries(await readOwnBooks(service(), ADJUSTMENT_BOOKS, ids.map((netsuiteId) => ({ company: 'BMG', netsuiteId }))))).toEqual({
      7201: { entryNo: 6, date: '2025-02-14', from: 'fleetsuite' },
      7202: { entryNo: 3, date: '2025-02-20', from: 'netsuite' },
      7210: { entryNo: 4, date: '2025-02-25', from: 'netsuite' },
    });

    const mine = await readOwnStockView(service(), { kind: 'adjustment', check: await checked(DAMAGED) });
    expect(mine).toEqual({
      books: { entryNo: 6, date: '2025-02-14', from: 'fleetsuite' },
      month: FEB,
      posts: true,
      why: null,
      entry: [
        { account: '52000 Inventory Adjustment', fleetsuite: 3571, netsuite: 3571, same: true },
        { account: '19000 Inventory Asset', fleetsuite: -3571, netsuite: -3571, same: true },
      ],
      differs: null,
      learned: [],
      costs: null,
    });
    expect(ownBooksText(mine, 'matches', 'adjustment')).toBe("In FleetSuite's books as entry 6, made from this copy.");

    const rack = await checked(COUNTED);
    expect([rack.status, rack.summary]).toEqual(['differs', "Value: NetSuite's value is $10.00 more."]);
    const theirs = await readOwnStockView(service(), { kind: 'adjustment', check: rack });
    expect(theirs).toEqual({
      books: { entryNo: 3, date: '2025-02-20', from: 'netsuite' },
      month: FEB,
      posts: false,
      why: "FleetSuite's own copy differs from NetSuite's adjustment, so the books post NetSuite's.",
      entry: null,
      differs: null,
      learned: [],
      costs: null,
    });
    expect(ownBooksText(theirs, rack.status, 'adjustment')).toBe("In FleetSuite's books as entry 3, made from NetSuite's adjustment, since this copy differs from it.");
  });

  it("goes back to NetSuite's when the Inventory Adjust stops matching", async () => {
    // NetSuite values Pat's two bins again, at $36.
    await gl(pg, '7201', 'InvAdjst', 'ADJ0143', '2025-02-14', [['1', INVENTORY, -3600], ['2', ADJUSTMENT, 3600]]);
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, reversed: 0, unchanged: 3, failedCount: 0 });
    expect((await journal()).slice(6).map((e) => [e.no, e.key, e.reverses, e.memo, e.rule])).toEqual([
      [7, null, 6, "ADJ0143 now posts from NetSuite's adjustment", 'reversal'],
      [8, 'inventory_adjustment:7201:3', null, 'ADJ0143', 'stock@1'],
    ]);
    expect((await linesOf(8)).map((l: any) => [l.account, l.debit, l.credit, l.source_line_ref])).toEqual([
      [INVENTORY, '0.00', '36.00', '1'], [ADJUSTMENT, '36.00', '0.00', '2'],
    ]);
    expect((await checked(DAMAGED)).summary).toBe("Value: NetSuite's value is $0.29 more.");
  });

  it("stops the run, saying what it was reading, when the Inventory Adjusts or their months can't be read", async () => {
    const before = await journal();
    for (const [read, error] of [
      ['gl_own_adjustment_months', "Reading the months of Books' own fulfillments, receipts and adjustments: gl_own_adjustment_months failed"],
      ['gl_own_adjustment_pairs', "Reading Books' own copies of BMG's fulfillments, receipts and adjustments for Feb 2025: gl_own_adjustment_pairs failed"],
    ]) {
      failing.add(read);
      try {
        expect((await run()).error, read).toBe(error);
      } finally {
        failing.delete(read);
      }
    }
    expect(await journal()).toEqual(before);
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, failedCount: 0 });
  });
});
