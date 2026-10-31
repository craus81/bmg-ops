// Migration 456 has the posting job post Books' own copies of fulfillments,
// receipts and bills (migrations 416, 435 and 436) in place of NetSuite's
// documents when they match them and make the same entry, and the Own pages
// say which copy made each entry. This runs migration 314 (with stand-ins for
// the app tables it and 407, 416, 435 and 454 point at) and migrations 359–364,
// 367, 370, 374, 376, 377, 380, 382–387, 389–395, 397, 399, 401–405, 407,
// 409, 416, 435, 436, 454, 456 and 457 in an in-memory Postgres (PGlite) as
// the app's server login, holds what gl_stock_documents and gl_own_stock_accounts
// return, then runs the posting job against made-up NetSuite documents and
// Books' own copies of them, and reads what the Own pages show of them.
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
import { BOOKS_GL_SYNC } from './netsuite-gl';
import { BOOKS_STOCK_SYNC } from './netsuite-stock';
import { BOOKS_BILLS_SYNC } from './netsuite-bills';
import { fulfillmentPayload, workOutOwnFulfillment, type OwnFulfillmentInput } from './own-fulfillments';
import { receiptPayload, workOutOwnReceipt } from './own-receipts';
import { billPayload, workOutOwnBill, type MadeBill } from './own-bills';
import { checkOwnFulfillments, type FulfilPairsData } from './own-fulfillment-check';
import { checkOwnReceipts, type OwnReceiptCheck, type ReceiptPairsData } from './own-receipt-check';
import { readOwnBooks } from './own-invoice-posting';
import { FULFILLMENT_BOOKS, RECEIPT_BOOKS, type OwnStockAccountsData } from './own-stock-posting';
import { BILL_BOOKS, readOwnBillCopies } from './own-bill-posting';
import { readOwnBillView, readOwnStockView } from './own-posting-view';
import type { StockDocument } from './stock-check';

const OFALLON = '1';
const WENTZVILLE = '2';
const LADDER = '9001';
const BINS = '9002';
/**
 * Made-up chart: '190' the items' inventory, '580' cost of goods sold, '585'
 * the cost of goods sold account NetSuite's fulfillments of ladder racks use,
 * '210' stock received but not billed, '200' payables, '611' subcontractors.
 */
const INVENTORY = '190';
const COGS = '580';
const RACK_COGS = '585';
const RECEIVED = '210';
const PAYABLE = '200';
const SUBCONTRACTORS = '611';
const ACCOUNTS: Array<[string, string, string, string]> = [
  [INVENTORY, '19000', 'Inventory Asset', 'other_current_asset'],
  [COGS, '58000', 'Cost of Goods Sold', 'cost_of_goods_sold'],
  [RACK_COGS, '58500', 'Cost of Goods Sold - Racks', 'cost_of_goods_sold'],
  [RECEIVED, '21000', 'Received Not Billed', 'other_current_liability'],
  [PAYABLE, '20000', 'Accounts Payable', 'accounts_payable'],
  [SUBCONTRACTORS, '61100', 'Subcontractors', 'expense'],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const ROW_1 = '0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f60';
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';

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
  // NetSuite's items, places and vendors, as the lists copy has them.
  for (const [kind, id, name, details] of [
    ['item', LADDER, 'LDR-24', { display_name: 'Ladder rack 24 in', item_type: 'InvtPart', asset_account: INVENTORY }],
    ['item', BINS, 'BIN-10', { item_type: 'InvtPart', asset_account: INVENTORY }],
    ['location', OFALLON, "O'Fallon", { subsidiary_id: '2' }],
    ['location', WENTZVILLE, 'Wentzville', { subsidiary_id: '2' }],
    ['vendor', '412', 'Northside Install Co.', { payables_account: PAYABLE }],
    ['vendor', '77', 'Acme Truck Racks', { payables_account: PAYABLE }],
  ] as const) {
    await pg.query(
      'INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ($1, $2, $3, true, $4::jsonb)',
      [kind, id, name, JSON.stringify(details)],
    );
  }
  await pg.exec(`
    INSERT INTO netsuite_sales_orders (netsuite_id, tranid, customer_netsuite_id, customer_name) VALUES ('6001', 'SO6001', '9001', 'Acme Fleet');
    INSERT INTO po_receipts (id, ns_status) VALUES ('${ROW_1}', 'posted');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

/** A Postgres text[] literal, as PostgREST sends a list. */
const textArray = (items: string[]) => `{${items.map((s) => `"${s.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;
const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

// ── NetSuite's documents, as the copies of its stock moves, bills and GL have them ──

/** A stock line as the copy hands it over: [line, item, location, quantity, moves stock]. */
type StockLine = [line: string, item: string, location: string, quantity: string, moves: boolean];
const stockDoc = (id: string, type: string, number: string, date: string, lines: StockLine[]) => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date,
  lines: lines.map(([line_id, item_id, location_id, quantity, moves_stock]) => ({ line_id, company: 'BMG', item_id, location_id, quantity, moves_stock })),
});

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

// Ten ladder racks were in Wentzville on December 31, 2024 at $140 each, and five bins at $20. In 2025: someone ships two
// racks in NetSuite, its cost to the racks' cost account; FleetSuite ships three racks, and one bin, whose cost NetSuite
// puts in cost of goods sold; FleetSuite receives four bins into O'Fallon at $25; and it bills a subcontractor's install.
const IF5002 = stockDoc('5002', 'ItemShip', 'IF5002', '2025-01-20', [['1', LADDER, WENTZVILLE, '-2', true], ['2', LADDER, WENTZVILLE, '-2', false]]);
const IF7001 = stockDoc('7001', 'ItemShip', 'IF7001', '2025-02-10', [['1', LADDER, WENTZVILLE, '-3', true], ['2', LADDER, WENTZVILLE, '-3', false]]);
const IF7002 = stockDoc('7002', 'ItemShip', 'IF7002', '2025-02-12', [['1', BINS, WENTZVILLE, '-1', true], ['2', BINS, WENTZVILLE, '-1', false]]);
const IR7101 = stockDoc('7101', 'ItemRcpt', 'IR7101', '2025-03-03', [['1', BINS, OFALLON, '4', true]]);
const BILL_LINES = [{ line_id: '1', item: null, account: SUBCONTRACTORS, amount: '-1250.00', own_amount: '-1250.00', quantity: null, memo: 'Install', tax: false }];
const VB8801 = {
  netsuite_id: '8801', tran_type: 'VendBill', tranid: 'VI-1042', trandate: '2025-03-05', vendor_netsuite_id: '412',
  vendor_name: 'Northside Install Co.', total: '1250.00', status: 'A', status_label: 'Open', voided: false, memo: null,
  lines: BILL_LINES, links: [],
};

async function copyNetSuite(pg: PGlite) {
  expect(await call(pg, 'gl_netsuite_stock_store_opening', {
    rows: [
      { company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '10', value: '1400.00' },
      { company: 'BMG', item_id: BINS, location_id: WENTZVILLE, quantity: '5', value: '100.00' },
    ],
  })).toEqual({ rows: 2 });
  expect(await call(pg, 'gl_netsuite_stock_apply', { documents: [IF5002, IF7001, IF7002, IR7101] })).toMatchObject({ added: 4 });
  await gl(pg, '5002', 'ItemShip', 'IF5002', '2025-01-20', [['1', INVENTORY, -28000], ['2', RACK_COGS, 28000]]);
  await gl(pg, '7001', 'ItemShip', 'IF7001', '2025-02-10', [['1', INVENTORY, -42000], ['2', RACK_COGS, 42000]]);
  await gl(pg, '7002', 'ItemShip', 'IF7002', '2025-02-12', [['1', INVENTORY, -2000], ['2', COGS, 2000]]);
  await gl(pg, '7101', 'ItemRcpt', 'IR7101', '2025-03-03', [['0', RECEIVED, -10000], ['1', INVENTORY, 10000]]);
  await call(pg, 'gl_netsuite_bills_apply', { rows: [VB8801] });
  await gl(pg, '8801', 'VendBill', 'VI-1042', '2025-03-05', [['0', PAYABLE, -125000], ['1', SUBCONTRACTORS, 125000]]);
}

// ── Books' own copies of them ──────────────────────────────────────────────

const fulfillment = (over: Partial<OwnFulfillmentInput>): Record<string, unknown> => fulfillmentPayload(workOutOwnFulfillment({
  netsuiteId: '7001', netsuiteNumber: 'IF7001', madeFrom: 'vehicle', madeFromId: 'checkin-1', salesOrderId: '6001',
  customerNetsuiteId: '9001', locationId: WENTZVILLE, locationFrom: 'customer_rule', fulfilDate: '2025-02-10',
  lines: [{ itemId: LADDER, itemNumber: 'LDR-24', description: 'Ladder rack', itemType: 'InvtPart', quantity: 3, salesOrderLineId: '2' }],
  madeBy: null, ...over,
}));

async function saveOwnCopies(pg: PGlite) {
  expect(await call(pg, 'gl_own_fulfillment_save', fulfillment({}))).toEqual({ saved: true, lines: 1 });
  expect(await call(pg, 'gl_own_fulfillment_save', fulfillment({
    netsuiteId: '7002', netsuiteNumber: 'IF7002', fulfilDate: '2025-02-12',
    lines: [{ itemId: BINS, itemNumber: 'BIN-10', description: null, itemType: 'InvtPart', quantity: 1, salesOrderLineId: '3' }],
  }))).toEqual({ saved: true, lines: 1 });
  expect(await call(pg, 'gl_own_receipt_save', receiptPayload(workOutOwnReceipt({
    rows: [{ id: ROW_1, lineId: '2', itemId: BINS, itemNumber: 'BIN-10', description: null, quantity: 4, rate: '25' }],
    netsuiteId: '7101', netsuiteNumber: 'IR7101', netsuiteError: null,
    po: { netsuiteId: 5001, number: 'PO5001', vendorId: '77', vendorName: 'Acme Truck Racks' }, receiveDate: '2025-03-03',
  })!))).toEqual({ saved: true, lines: 1 });
  expect(await call(pg, 'gl_own_bill_save', billPayload(workOutOwnBill({
    netsuiteId: '8801', netsuiteNumber: 'VI-1042', madeFrom: 'vendor_invoice', madeFromId: 'inv-1', vendorId: 412,
    vendorName: 'Northside Install Co.', referenceNo: 'VI-1042', subsidiaryId: null, locationId: OFALLON,
    expense: { accountId: SUBCONTRACTORS, amount: 1250, memo: 'Install' },
  } as MadeBill & { netsuiteId: string }, null, new Date('2025-03-05T15:00:00Z'))))).toEqual({ saved: true, lines: 1 });
}

// ── The functions ──────────────────────────────────────────────────────────

describe("migration 456's functions", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await copyNetSuite(pg);
    await saveOwnCopies(pg);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  const accounts = (company: string, fulfillments: string[], receipts: string[]) => one<OwnStockAccountsData>(
    pg, 'SELECT gl_own_stock_accounts($1, $2::text[], $3::text[]) AS r', [company, textArray(fulfillments), textArray(receipts)],
  );

  it("gl_own_stock_accounts learns each item's cost account from NetSuite's last fulfillment of it, else the one most use", async () => {
    expect(await accounts('BMG', ['7001', '7002'], ['7101'])).toEqual({
      items: { [LADDER]: INVENTORY, [BINS]: INVENTORY },
      fulfillments: {
        // The racks' cost goes where NetSuite's fulfillment before it put theirs.
        7001: { [LADDER]: { cost: RACK_COGS, from: { netsuite_id: '5002', number: 'IF5002', date: '2025-01-20' }, netsuite: RACK_COGS } },
        // NetSuite hadn't shipped bins before: where most fulfillments put theirs, and NetSuite put them elsewhere.
        7002: { [BINS]: { cost: null, from: null, netsuite: COGS } },
      },
      usual_cost: RACK_COGS,
      received: [{ account: RECEIVED, documents: 1 }],
    });
    // A fulfillment asked about alone has the same; its own later lines and NetSuite's later ones don't count.
    expect((await accounts('BMG', ['7002'], [])).fulfillments).toEqual({ 7002: { [BINS]: { cost: null, from: null, netsuite: COGS } } });
    // Nothing asked about, nothing named: no usual account, no received ones.
    expect(await accounts('BMG', [], [])).toEqual({ items: {}, fulfillments: {}, usual_cost: null, received: [] });
    // FleetSuite's fulfillments are BMG's.
    expect((await accounts('1084', ['7001'], [])).fulfillments).toEqual({});
  });

  it("gl_stock_documents gives the stock documents named, with the company's lines, as gl_stock_month does", async () => {
    const res = await one<{ documents: StockDocument[] }>(
      pg, 'SELECT gl_stock_documents($1, $2::text[]) AS r', ['BMG', textArray(['7101', '7001', '8801', '9999'])],
    );
    // By date; not the bill, nor one the copy doesn't have.
    expect(res.documents.map((d) => [d.netsuite_id, d.type, d.number, d.date, d.posting_month, d.companies])).toEqual([
      ['7001', 'ItemShip', 'IF7001', '2025-02-10', FEB, ['BMG']],
      ['7101', 'ItemRcpt', 'IR7101', '2025-03-03', MAR, ['BMG']],
    ]);
    expect(res.documents[0].lines.map((l) => [l.line_id, l.account, l.debit, l.credit])).toEqual([
      ['1', INVENTORY, '0.00', '420.00'], ['2', RACK_COGS, '420.00', '0.00'],
    ]);
    expect(await one(pg, 'SELECT gl_stock_documents($1, $2::text[]) AS r', ['1084', textArray(['7001'])])).toEqual({ documents: [] });
    expect(await one(pg, 'SELECT gl_stock_documents($1, NULL) AS r', ['BMG'])).toEqual({ documents: [] });
  });

  it("is the service role's alone, and neither new read writes anything", async () => {
    await pg.exec('RESET ROLE');
    for (const fn of [
      'public.gl_stock_postings(text, text[], boolean)', 'public.gl_bill_postings(text, text[], boolean)',
      'public.gl_stock_documents(text, text[])', 'public.gl_own_stock_accounts(text, text[], text[])',
    ]) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>(pg, `SELECT has_function_privilege($1::name, '${fn}', 'EXECUTE') AS r`, [role]), `${fn} ${role}`)
          .toBe(role === 'service_role');
      }
    }
    for (const name of ['gl_stock_postings', 'gl_bill_postings', 'gl_stock_documents', 'gl_own_stock_accounts']) {
      const body = await one<string>(pg, 'SELECT prosrc AS r FROM pg_proc WHERE proname = $1', [name]);
      expect(body, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    }
    await pg.exec('SET ROLE service_role');
  });
});

describe('what they read of NetSuite, on a copy of its own', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    // Ladder racks went out four times in NetSuite before FleetSuite's IF7001: their cost to 58000 early in January,
    // to 58500 on the 20th, to 58000 on the 28th in a fulfillment NetSuite has since deleted, and on February 1 in a
    // transfer's fulfillment that only moved them from one inventory line to another.
    expect(await call(pg, 'gl_netsuite_stock_store_opening', {
      rows: [{ company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '10', value: '1400.00' }],
    })).toEqual({ rows: 1 });
    const ladder = (id: string, date: string) => stockDoc(id, 'ItemShip', `IF${id}`, date, [['1', LADDER, WENTZVILLE, '-1', true], ['2', LADDER, WENTZVILLE, '-1', false]]);
    const shipped = [ladder('5001', '2025-01-06'), ladder('5002', '2025-01-20'), ladder('5003', '2025-01-28'), ladder('5004', '2025-02-01'), IF7001];
    expect(await call(pg, 'gl_netsuite_stock_apply', { documents: [...shipped, IR7101] })).toMatchObject({ added: 6 });
    await gl(pg, '5001', 'ItemShip', 'IF5001', '2025-01-06', [['1', INVENTORY, -14000], ['2', COGS, 14000]]);
    await gl(pg, '5002', 'ItemShip', 'IF5002', '2025-01-20', [['1', INVENTORY, -14000], ['2', RACK_COGS, 14000]]);
    await gl(pg, '5003', 'ItemShip', 'IF5003', '2025-01-28', [['1', INVENTORY, -14000], ['2', COGS, 14000]]);
    await gl(pg, '5004', 'ItemShip', 'IF5004', '2025-02-01', [['1', INVENTORY, -14000], ['2', INVENTORY, 14000]]);
    await gl(pg, '7001', 'ItemShip', 'IF7001', '2025-02-10', [['1', INVENTORY, -42000], ['2', RACK_COGS, 42000]]);
    expect(await call(pg, 'gl_netsuite_stock_finish', { netsuite_ids: ['5001', '5002', '5004', '7001', '7101'] })).toMatchObject({ gone: 1 });
    // BMG's receipt IR7101, and one of 1084's holding what it received against the same account.
    await gl(pg, '7101', 'ItemRcpt', 'IR7101', '2025-03-03', [['0', RECEIVED, -10000], ['1', INVENTORY, 10000]]);
    await gl(pg, '7102', 'ItemRcpt', 'IR7102', '2025-03-04', [['0', RECEIVED, -5000], ['1', INVENTORY, 5000]], '1084');
    // And a receipt the GL copy books to both companies.
    await gl(pg, '7103', 'ItemRcpt', 'IR7103', '2025-03-05', [['0', RECEIVED, -3000], ['1', INVENTORY, 3000]]);
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT '7103', '2', id, $1, '2025-03-01', '2025-03-05', '30.00', '0' FROM gl_companies WHERE code = '1084'`,
      [INVENTORY],
    );
    expect(await call(pg, 'gl_own_fulfillment_save', fulfillment({}))).toEqual({ saved: true, lines: 1 });
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it("learns an item's cost account from NetSuite's latest fulfillment of it before, not one it deleted nor a line to stock", async () => {
    expect(await one<OwnStockAccountsData>(
      pg, 'SELECT gl_own_stock_accounts($1, $2::text[], $3::text[]) AS r', ['BMG', textArray(['7001']), textArray(['7101'])],
    )).toMatchObject({
      fulfillments: { 7001: { [LADDER]: { cost: RACK_COGS, from: { netsuite_id: '5002', number: 'IF5002', date: '2025-01-20' }, netsuite: RACK_COGS } } },
      // BMG's receipts alone, 1084's left out.
      received: [{ account: RECEIVED, documents: 2 }],
    });
  });

  it("gives a document's lines for the company asked about alone, naming every company it has lines for", async () => {
    const res = await one<{ documents: StockDocument[] }>(pg, 'SELECT gl_stock_documents($1, $2::text[]) AS r', ['BMG', textArray(['7103'])]);
    expect(res.documents.map((d) => [d.netsuite_id, d.companies, d.lines.map((l) => [l.line_id, l.account, l.debit, l.credit])])).toEqual([
      ['7103', ['1084', 'BMG'], [['0', RECEIVED, '0.00', '30.00'], ['1', INVENTORY, '30.00', '0.00']]],
    ]);
  });
});

// ── The job, and the Own pages ─────────────────────────────────────────────

describe("the posting job, with Books' own fulfillments, receipts and bills", () => {
  let pg: PGlite;
  const clock = Date.parse('2025-03-20T12:00:00Z');
  const store = new Map<string, any>();
  /** Reads made to fail: a function by its name, and sync_state by its key. */
  const failing = new Set<string>();

  // sync_state in memory; gl_accounts, gl_companies, the GL copy's documents and every function the real ones, called
  // the way supabase-js calls them.
  const service = () => ({
    from: (table: string) => {
      if (table === 'sync_state') {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => (failing.has(key)
                ? { data: null, error: { message: `${key} failed` } }
                : { data: store.has(key) ? { last_result: store.get(key).last_result } : null, error: null }),
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
      if (table === 'gl_netsuite_transactions') {
        return {
          select: (cols: string) => ({
            eq: (col: string, value: string) => ({
              maybeSingle: async () => ({
                data: (await pg.query(`SELECT ${cols}::text FROM gl_netsuite_transactions WHERE ${col} = $1`, [value])).rows[0] ?? null,
                error: null,
              }),
            }),
          }),
        };
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

  // A stock document's or bill's entry comes from the copies, so there's nothing to ask NetSuite.
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
    `SELECT a.netsuite_account_id AS account, l.debit::text AS debit, l.credit::text AS credit, l.memo, l.vendor_ref, l.source_line_ref
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
     WHERE e.entry_no = $1 ORDER BY l.line_no`,
    [no],
  )).rows;
  /** What the books hold in each account, debit positive. */
  const balances = async () => (await pg.query<{ account: string; cents: string }>(
    `SELECT a.netsuite_account_id AS account, sum(l.debit - l.credit)::text AS cents
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id GROUP BY 1 ORDER BY 1`,
  )).rows;
  /** The entry that stands for a document, by its key's start ('item_fulfillment:7001'). */
  const standing = async (key: string) => (await journal()).filter((e) => e.key?.startsWith(`${key}:`)).at(-1)!;

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    await copyNetSuite(pg);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it("posts NetSuite's documents while Books has no copies of them", async () => {
    const r = await run();
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 5, replaced: 0, reversed: 0, failedCount: 0 });
    expect((await journal()).map((e) => [e.key, e.rule, e.date])).toEqual([
      ['item_fulfillment:5002:1', 'stock@1', '2025-01-20'],
      ['item_fulfillment:7001:1', 'stock@1', '2025-02-10'],
      ['item_fulfillment:7002:1', 'stock@1', '2025-02-12'],
      // A month's bills post before its stock documents.
      ['vendor_bill:8801:1', 'bill@1', '2025-03-05'],
      ['item_receipt:7101:1', 'stock@1', '2025-03-03'],
    ]);
  });

  it("replaces NetSuite's entry with the copy's where the copy matches and its entry is the same, and nothing in the books moves", async () => {
    await saveOwnCopies(pg);
    const before = await balances();
    const r = await run();
    expect(r.error).toBeUndefined();
    // The fulfillment of bins matches, but its entry puts the cost elsewhere, so NetSuite's stands.
    expect(r).toMatchObject({ posted: 0, replaced: 3, reversed: 0, unchanged: 2, failedCount: 0 });
    const after = await journal();
    expect(after.slice(5).map((e) => [e.no, e.key, e.reverses, e.memo, e.rule])).toEqual([
      [6, null, 2, "IF7001 now posts from FleetSuite's own copy", 'reversal'],
      [7, 'item_fulfillment:7001:2', null, 'IF7001', 'own_fulfillment@1'],
      [8, null, 4, "VI-1042 now posts from FleetSuite's own copy", 'reversal'],
      [9, 'vendor_bill:8801:2', null, 'VI-1042, Northside Install Co.', 'own_bill@1'],
      [10, null, 5, "IR7101 now posts from FleetSuite's own copy", 'reversal'],
      [11, 'item_receipt:7101:2', null, 'IR7101', 'own_receipt@1'],
    ]);
    expect(await balances()).toEqual(before);

    // Each item's cost off its asset account, onto the cost account NetSuite's last fulfillment of it used.
    expect(await linesOf(7)).toEqual([
      { account: RACK_COGS, debit: '420.00', credit: '0.00', memo: 'Acme Fleet · LDR-24', vendor_ref: null, source_line_ref: 'own:9001:cost' },
      { account: INVENTORY, debit: '0.00', credit: '420.00', memo: 'Acme Fleet · LDR-24', vendor_ref: null, source_line_ref: 'own:9001:asset' },
    ]);
    // Each stock item onto its asset account at the PO's price, off the account received stock is held against.
    expect(await linesOf(11)).toEqual([
      { account: INVENTORY, debit: '100.00', credit: '0.00', memo: 'Acme Truck Racks · BIN-10', vendor_ref: null, source_line_ref: 'own:9002:asset' },
      { account: RECEIVED, debit: '0.00', credit: '100.00', memo: 'Acme Truck Racks', vendor_ref: null, source_line_ref: 'own:received' },
    ]);
    // The bill rule on the copy's own lines: payables for its vendor, the expense line to its account.
    expect((await linesOf(9)).map((l: any) => [l.account, l.debit, l.credit, l.vendor_ref, l.source_line_ref])).toEqual([
      [PAYABLE, '0.00', '1250.00', '412', 'payables'],
      [SUBCONTRACTORS, '1250.00', '0.00', null, 'own:1'],
    ]);
  });

  it('changes nothing the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 5, failedCount: 0 });
    expect(await journal()).toEqual(before);
  });

  it("says which copy made each entry, and on each one's page the copy's entry next to NetSuite's", async () => {
    const books = await readOwnBooks(service(), FULFILLMENT_BOOKS, [{ company: 'BMG', netsuiteId: '7001' }, { company: 'BMG', netsuiteId: '7002' }]);
    expect(Object.fromEntries(books)).toEqual({
      7001: { entryNo: 7, date: '2025-02-10', from: 'fleetsuite' },
      7002: { entryNo: 3, date: '2025-02-12', from: 'netsuite' },
    });
    expect(Object.fromEntries(await readOwnBooks(service(), RECEIPT_BOOKS, [{ company: 'BMG', netsuiteId: '7101' }])))
      .toEqual({ 7101: { entryNo: 11, date: '2025-03-03', from: 'fleetsuite' } });
    expect(Object.fromEntries(await readOwnBooks(service(), BILL_BOOKS, [{ company: 'BMG', netsuiteId: '8801' }])))
      .toEqual({ 8801: { entryNo: 9, date: '2025-03-05', from: 'fleetsuite' } });

    const through = { stock: null, ledger: null };
    const checked = async (id: string) => checkOwnFulfillments(
      await one<FulfilPairsData>(pg, 'SELECT gl_own_fulfillment_pairs(NULL, NULL, $1) AS r', [id]), through,
    ).fulfillments[0];

    expect(await readOwnStockView(service(), { kind: 'fulfillment', check: await checked('7001') })).toEqual({
      books: { entryNo: 7, date: '2025-02-10', from: 'fleetsuite' },
      month: FEB,
      posts: true,
      why: null,
      entry: [
        { account: '58500 Cost of Goods Sold - Racks', fleetsuite: 42000, netsuite: 42000, same: true },
        { account: '19000 Inventory Asset', fleetsuite: -42000, netsuite: -42000, same: true },
      ],
      differs: null,
      learned: [],
      costs: "Each item's cost comes out of its asset account and goes to the cost account NetSuite's last fulfillment of it used: "
        + '58500 Cost of Goods Sold - Racks for it.',
    });
    const differs = 'FleetSuite hadn\'t seen BIN-10 shipped before, so it put its $20.00 in 58500 Cost of Goods Sold - Racks, '
      + 'where most fulfillments put theirs, and NetSuite put it in 58000 Cost of Goods Sold';
    expect(await readOwnStockView(service(), { kind: 'fulfillment', check: await checked('7002') })).toEqual({
      books: { entryNo: 3, date: '2025-02-12', from: 'netsuite' },
      month: FEB,
      posts: false,
      why: `FleetSuite's own copy matches NetSuite's fulfillment, but its entry doesn't match NetSuite's, so the books post NetSuite's: ${differs}.`,
      entry: [
        { account: '58500 Cost of Goods Sold - Racks', fleetsuite: 2000, netsuite: null, same: false },
        { account: '58000 Cost of Goods Sold', fleetsuite: null, netsuite: 2000, same: false },
        { account: '19000 Inventory Asset', fleetsuite: -2000, netsuite: -2000, same: true },
      ],
      differs,
      learned: ["From now on FleetSuite puts BIN-10's cost in 58000, as NetSuite did here."],
      costs: "FleetSuite hadn't seen BIN-10 shipped before, so its cost goes to 58500 Cost of Goods Sold - Racks, where most fulfillments put theirs.",
    });

    const [receipt] = checkOwnReceipts(await one<ReceiptPairsData>(pg, 'SELECT gl_own_receipt_pairs(NULL, NULL, $1::uuid) AS r', [ROW_1]), through).receipts;
    expect(await readOwnStockView(service(), { kind: 'receipt', check: receipt as OwnReceiptCheck & { netsuiteId: string } })).toMatchObject({
      books: { entryNo: 11, date: '2025-03-03', from: 'fleetsuite' },
      month: MAR,
      posts: true,
      entry: [
        { account: '19000 Inventory Asset', fleetsuite: 10000, netsuite: 10000, same: true },
        { account: '21000 Received Not Billed', fleetsuite: -10000, netsuite: -10000, same: true },
      ],
    });

    const copy = (await readOwnBillCopies(service(), '2025-03-01', '2025-03-31', { bills: null, ledger: null })).get('8801')!;
    expect(copy.check.status).toBe('matches');
    expect(await readOwnBillView(service(), copy)).toEqual({
      books: { entryNo: 9, date: '2025-03-05', from: 'fleetsuite' },
      month: MAR,
      posts: true,
      why: null,
      entry: [
        { account: '61100 Subcontractors', fleetsuite: 125000, netsuite: 125000, same: true },
        { account: '20000 Accounts Payable', fleetsuite: -125000, netsuite: -125000, same: true },
      ],
      differs: null,
      learned: [],
      costs: null,
    });
    // Were the copy's install in 58000, its check aside, the page would show each side where it puts it.
    const elsewhere = { ...copy, own: { ...copy.own, lines: copy.own.lines.map((l) => ({ ...l, account_id: COGS })) } };
    expect((await readOwnBillView(service(), elsewhere)).entry).toEqual([
      { account: '58000 Cost of Goods Sold', fleetsuite: 125000, netsuite: null, same: false },
      { account: '61100 Subcontractors', fleetsuite: null, netsuite: 125000, same: false },
      { account: '20000 Accounts Payable', fleetsuite: -125000, netsuite: -125000, same: true },
    ]);
  });

  it("goes back to NetSuite's when the copy stops matching", async () => {
    // NetSuite costs FleetSuite's fulfillment of racks again, at $410.
    await gl(pg, '7001', 'ItemShip', 'IF7001', '2025-02-10', [['1', INVENTORY, -41000], ['2', RACK_COGS, 41000]]);
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, reversed: 0, unchanged: 4, failedCount: 0 });
    const after = await journal();
    expect(after.slice(11).map((e) => [e.no, e.key, e.reverses, e.memo, e.rule])).toEqual([
      [12, null, 7, "IF7001 now posts from NetSuite's fulfillment", 'reversal'],
      [13, 'item_fulfillment:7001:3', null, 'IF7001', 'stock@1'],
    ]);
    expect((await linesOf(13)).map((l: any) => [l.account, l.debit, l.credit, l.source_line_ref])).toEqual([
      [INVENTORY, '0.00', '410.00', '1'], [RACK_COGS, '410.00', '0.00', '2'],
    ]);
    expect((await standing('item_fulfillment:7001')).rule).toBe('stock@1');
  });

  it("stops the run, saying what it was reading, when the copies, their months or how far NetSuite's copies had come can't be read", async () => {
    const before = await journal();
    for (const [read, error] of [
      ['gl_own_fulfillment_months', "Reading the months of Books' own fulfillments, receipts and adjustments: gl_own_fulfillment_months failed"],
      ['gl_own_receipt_months', "Reading the months of Books' own fulfillments, receipts and adjustments: gl_own_receipt_months failed"],
      ['gl_own_bill_months', "Reading the months of Books' own bills: gl_own_bill_months failed"],
      [BOOKS_STOCK_SYNC, `Reading how far the copies of NetSuite had come: ${BOOKS_STOCK_SYNC} failed`],
      [BOOKS_BILLS_SYNC, `Reading how far the copies of NetSuite had come: ${BOOKS_BILLS_SYNC} failed`],
      [BOOKS_GL_SYNC, `Reading how far the copies of NetSuite had come: ${BOOKS_GL_SYNC} failed`],
      ['gl_own_fulfillment_pairs', "Reading Books' own copies of BMG's fulfillments, receipts and adjustments for Feb 2025: gl_own_fulfillment_pairs failed"],
      ['gl_own_stock_accounts', "Reading Books' own copies of BMG's fulfillments, receipts and adjustments for Feb 2025: gl_own_stock_accounts failed"],
      ['gl_own_receipt_pairs', "Reading Books' own copies of BMG's fulfillments, receipts and adjustments for Mar 2025: gl_own_receipt_pairs failed"],
      ['gl_own_bill_pairs', "Reading Books' own copies of BMG's bills for Mar 2025: gl_own_bill_pairs failed"],
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
