// Migration 517 has the posting job post an invoice's cost from FleetSuite's
// own copy of the invoice (migration 407) in place of NetSuite's cost lines,
// when what the copy took matches NetSuite's invoice and its entry comes out
// the same, as a fulfillment's does (migration 456). This runs migration 314
// (with stand-ins for the app tables it and 407, 416, 435, 454 and 466–471
// point at) and the books' migrations those depend on, 445, 466–471 and 517
// in an in-memory Postgres (PGlite) as the app's server login, holds what
// gl_own_invoice_cost_pairs, gl_own_invoice_cost_accounts and
// gl_stock_documents return, then runs the posting job against made-up
// NetSuite invoices and Books' own copies of them, and reads what the Own
// invoices page shows of them.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';
import type { StockDocument } from './stock-check';

const h = vi.hoisted(() => ({ service: null as unknown }));
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
// The Own invoices page's read, as whoever opens the books, on the scratch database. Its PDF line is another test's.
vi.mock('@/lib/api-auth', () => ({ requireBooks: vi.fn(async () => ({ user: { id: 'a0000000-0000-4000-8000-0000000000aa' } })) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('./invoice-pdfs', () => ({ readInvoicePdfView: vi.fn(async () => null) }));

import { postInvoices } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { BOOKS_GL_SYNC } from './netsuite-gl';
import { BOOKS_STOCK_SYNC } from './netsuite-stock';
import { readOwnBooks } from './own-invoice-posting';
import { INVOICE_COST_BOOKS } from './own-stock-posting';
import { checkOwnInvoiceCosts, type InvoiceCostPairsData } from './own-invoice-cost-check';
import { readOwnStockView } from './own-posting-view';
import { GET as GET_INVOICE } from '../../app/api/admin/books/own-invoices/route';

const OFALLON = '1';
const WENTZVILLE = '2';
const LADDER = '9001';
const BINS = '9002';
/** A kit of one ladder rack and two bins. */
const RACK_KIT = '9003';
/** An install, which NetSuite doesn't keep in stock. */
const INSTALL = '9004';
/** A shelf the copy of NetSuite's items doesn't have yet. */
const SHELF = '9005';
/**
 * Made-up chart: '190' the items' inventory, '580' cost of goods sold, '585' the cost of goods sold account NetSuite
 * books ladder racks' cost to, '400' sales, '410' install income, '110' receivables.
 */
const INVENTORY = '190';
const COGS = '580';
const RACK_COGS = '585';
const SALES = '400';
const INSTALLS = '410';
const RECEIVABLE = '110';
const ACCOUNTS: Array<[string, string, string, string]> = [
  [INVENTORY, '19000', 'Inventory Asset', 'other_current_asset'],
  [COGS, '58000', 'Cost of Goods Sold', 'cost_of_goods_sold'],
  [RACK_COGS, '58500', 'Cost of Goods Sold - Racks', 'cost_of_goods_sold'],
  [SALES, '40000', 'Sales', 'income'],
  [INSTALLS, '41000', 'Install Income', 'income'],
  [RECEIVABLE, '11000', 'Accounts Receivable', 'accounts_receivable'],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const ACME = 'c0000000-0000-4000-8000-000000000001';
const FEB = '2025-02-01';

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
    -- What the migrations point at in the app's own schema.
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
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
    INSERT INTO public.customers (id, company_name, netsuite_id, tax_exempt) VALUES ('${ACME}', 'Acme Fleet', '7700', false);
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
    '416-books-own-fulfillments.sql', '435-books-own-bills.sql', '436-books-snap-a-bill.sql', '445-typed-invoices.sql',
    '454-inventory-adjustments.sql', '456-books-own-postings.sql', '457-books-own-adjustments.sql',
    '466-credit-memos-in-fleetsuite.sql', '467-vendor-credits-in-fleetsuite.sql', '468-card-charges-in-fleetsuite.sql',
    '469-journal-entries-typed-in-fleetsuite.sql', '470-inventory-transfers-made-in-fleetsuite.sql',
    '471-invoices-fixed-in-fleetsuite.sql', '517-books-own-invoice-costs.sql',
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
    ['item', LADDER, 'LDR-24', { display_name: 'Ladder rack 24 in', item_type: 'InvtPart', asset_account: INVENTORY, income_account: SALES }],
    ['item', BINS, 'BIN-10', { item_type: 'InvtPart', asset_account: INVENTORY, income_account: SALES }],
    ['item', RACK_KIT, 'KIT-RACK', {
      display_name: 'Rack and bins', item_type: 'Kit', income_account: SALES,
      parts: [{ item: LADDER, quantity: 1 }, { item: BINS, quantity: 2 }],
    }],
    ['item', INSTALL, 'INSTALL', { item_type: 'Service', income_account: INSTALLS }],
    ['location', OFALLON, "O'Fallon", { subsidiary_id: '2' }],
    ['location', WENTZVILLE, 'Wentzville', { subsidiary_id: '2' }],
    ['customer', '7700', 'Acme Fleet', {}],
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
const stockDoc = (id: string, type: string, number: string, date: string, lines: StockLine[]) => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date,
  lines: lines.map(([line_id, item_id, location_id, quantity, moves_stock]) => ({ line_id, company: 'BMG', item_id, location_id, quantity, moves_stock })),
});

/** What NetSuite posted for a document, in the GL copy, its lines replaced whole: [line, account, cents debit positive]. */
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

// Ten ladder racks were in O'Fallon on December 31, 2024 at $140 each, and twenty bins at $20. In 2025: NetSuite ships
// two racks, their cost to the racks' cost account; FleetSuite bills three racks and an install off the Scan Log, two
// rack kits for a graphics job, and one rack and a shelf it typed in, which NetSuite takes from O'Fallon though the copy
// says Wentzville; and a PO's open quantities NetSuite's copies don't have yet.
const IF5002 = stockDoc('5002', 'ItemShip', 'IF5002', '2025-01-20', [['1', LADDER, OFALLON, '-2', true], ['2', LADDER, OFALLON, '-2', false]]);
/** The invoice's item lines move stock; its cost of goods and asset lines name the item without moving it. */
const INV7001 = stockDoc('7001', 'CustInvc', 'INV7001', '2025-02-10', [
  ['1', LADDER, OFALLON, '-3', true], ['3', LADDER, OFALLON, '-3', false], ['4', LADDER, OFALLON, '-3', false],
]);
/** A ladder rack credited on an invoice: a line naming it that debits sales, which isn't where its cost goes. */
const INV7090 = stockDoc('7090', 'CustInvc', 'INV7090', '2025-02-11', [['1', LADDER, OFALLON, '0', false]]);
/** The kit's line names the kit without moving it; NetSuite takes its parts. */
const INV7002 = stockDoc('7002', 'CustInvc', 'INV7002', '2025-02-12', [
  ['1', RACK_KIT, OFALLON, '-2', false],
  ['2', LADDER, OFALLON, '-2', true], ['3', BINS, OFALLON, '-4', true],
  ['4', LADDER, OFALLON, '-2', false], ['5', LADDER, OFALLON, '-2', false],
  ['6', BINS, OFALLON, '-4', false], ['7', BINS, OFALLON, '-4', false],
]);
const INV7003 = stockDoc('7003', 'CustInvc', 'INV7003', '2025-02-14', [['1', LADDER, OFALLON, '-1', true], ['2', LADDER, OFALLON, '-1', false], ['3', LADDER, OFALLON, '-1', false]]);

async function copyNetSuite(pg: PGlite) {
  expect(await call(pg, 'gl_netsuite_stock_store_opening', {
    rows: [
      { company: 'BMG', item_id: LADDER, location_id: OFALLON, quantity: '10', value: '1400.00' },
      { company: 'BMG', item_id: BINS, location_id: OFALLON, quantity: '20', value: '400.00' },
    ],
  })).toEqual({ rows: 2 });
  expect(await call(pg, 'gl_netsuite_stock_apply', { documents: [IF5002, INV7001, INV7090, INV7002, INV7003] })).toMatchObject({ added: 5 });
  await gl(pg, '5002', 'ItemShip', 'IF5002', '2025-01-20', [['1', INVENTORY, -28000], ['2', RACK_COGS, 28000]]);
  // Three racks at $140 and an install, the racks' $420 cost to their cost account.
  await gl(pg, '7001', 'CustInvc', 'INV7001', '2025-02-10', [
    ['0', RECEIVABLE, 90000], ['1', SALES, -75000], ['2', INSTALLS, -15000], ['3', RACK_COGS, 42000], ['4', INVENTORY, -42000],
  ]);
  await gl(pg, '7090', 'CustInvc', 'INV7090', '2025-02-11', [['0', RECEIVABLE, 10000], ['1', SALES, 5000], ['2', SALES, -15000]]);
  // Two kits: two racks at $140 to their cost account, four bins at $20 to cost of goods sold.
  await gl(pg, '7002', 'CustInvc', 'INV7002', '2025-02-12', [
    ['0', RECEIVABLE, 80000], ['1', SALES, -80000],
    ['4', RACK_COGS, 28000], ['5', INVENTORY, -28000], ['6', COGS, 8000], ['7', INVENTORY, -8000],
  ]);
  await gl(pg, '7003', 'CustInvc', 'INV7003', '2025-02-14', [
    ['0', RECEIVABLE, 30000], ['1', SALES, -30000], ['2', RACK_COGS, 14000], ['3', INVENTORY, -14000],
  ]);
}

// ── Books' own copies of them ──────────────────────────────────────────────

/** FleetSuite's own copy of an invoice, as gl_own_invoice_save takes it: lines [item, number, quantity, amount]. */
const ownInvoice = (id: string, over: Record<string, unknown>, lines: Array<[string | null, string | null, number | null, number]>) => {
  const subtotal = lines.reduce((s, l) => s + l[3], 0);
  return {
    netsuite_id: id, netsuite_number: `INV${id}`, made_from: 'scans', made_from_id: null, customer_netsuite_id: '7700',
    customer_id: ACME, invoice_date: '2025-02-10', location_netsuite_id: OFALLON, location_from: 'sent', tax_rule: 'tax@1',
    tax_basis: 'rate', tax_rate: '0', subtotal: subtotal.toFixed(2), tax: '0', total: subtotal.toFixed(2), lines_from: 'sent',
    unknowns: [],
    lines: lines.map(([item, number, quantity, amount], i) => ({
      line_no: i + 1, item_netsuite_id: item, item_number: number, description: null, quantity,
      rate: quantity ? (amount / quantity).toFixed(2) : null, amount: amount.toFixed(2), taxable: false, tax: '0',
    })),
    ...over,
  };
};

async function saveOwnCopies(pg: PGlite) {
  for (const p of [
    ownInvoice('7001', {}, [[LADDER, 'LDR-24', 3, 750], [INSTALL, 'INSTALL', 1, 150], [null, null, null, 0]]),
    ownInvoice('7002', { made_from: 'graphics', invoice_date: '2025-02-12' }, [[RACK_KIT, 'KIT-RACK', 2, 800]]),
    ownInvoice('7003', { made_from: 'typed', invoice_date: '2025-02-14', location_netsuite_id: WENTZVILLE, location_from: 'rule' },
      [[LADDER, 'LDR-24', 1, 250], [SHELF, 'SHELF-3', 1, 50]]),
    ownInvoice('7004', { made_from: 'po', invoice_date: '2025-02-15' }, [[BINS, 'BIN-10', 5, 125]]),
    // Off a sales order: its fulfillment took the stock.
    ownInvoice('7005', { made_from: 'vehicle', invoice_date: '2025-02-15', sales_order_id: '6001', lines_from: 'sales_order_copy' },
      [[LADDER, 'LDR-24', 1, 250]]),
  ]) {
    expect(await call(pg, 'gl_own_invoice_save', p), p.netsuite_id).toMatchObject({ saved: true });
  }
}

interface Pairs {
  invoices: Array<{
    own: { netsuite_id: string; lines: Array<Record<string, unknown>>; [k: string]: unknown };
    netsuite: { lines: Array<Record<string, unknown>>; [k: string]: unknown } | null;
    netsuite_gl: { posting_month: string; entry: Array<{ account_id: string; debit: string; credit: string }> } | null;
    before: Array<{ item_id: string; location_id: string | null; quantity: string; value: string }>;
    customer_name: string | null;
  }>;
  items: Record<string, { number: string; type: string | null; display_name: string | null; parts: unknown }>;
  locations: Record<string, string>;
  accounts: Record<string, { number: string | null; name: string }>;
}

// ── The functions ──────────────────────────────────────────────────────────

describe("migration 517's functions", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await copyNetSuite(pg);
    await saveOwnCopies(pg);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  const pairs = (from: string | null, to: string | null, id: string | null = null) =>
    one<Pairs>(pg, 'SELECT gl_own_invoice_cost_pairs($1::date, $2::date, $3) AS r', [from, to, id]);

  it('gl_own_invoice_cost_pairs gives the invoices FleetSuite made without a sales order, newest first, next to NetSuite\'s', async () => {
    const res = await pairs('2025-02-01', '2025-02-28');
    // Not the invoice off a sales order.
    expect(res.invoices.map((i) => i.own.netsuite_id)).toEqual(['7004', '7003', '7002', '7001']);
    const [i7004, i7003, i7002, i7001] = res.invoices;

    // The lines that bill something NetSuite may keep in stock: not the install, nor a line naming no item.
    expect(i7001.own).toMatchObject({
      netsuite_id: '7001', number: 'INV7001', made_from: 'scans', made_from_id: null, customer_netsuite_id: '7700',
      date: '2025-02-10', location_id: OFALLON, location_from: 'sent', unknowns: [], fixed_at: null,
      lines: [{ line_no: 1, item_id: LADDER, item_number: 'LDR-24', description: null, item_type: 'InvtPart', quantity: '3.0000' }],
    });
    expect(typeof i7001.own.made_at).toBe('string');
    expect(i7001.netsuite).toEqual({
      number: 'INV7001', type: 'CustInvc', date: '2025-02-10', gone: false,
      lines: [
        { line_id: '1', item_id: LADDER, location_id: OFALLON, quantity: '-3', moves_stock: true, value: null },
        { line_id: '3', item_id: LADDER, location_id: OFALLON, quantity: '-3', moves_stock: false, value: null },
        { line_id: '4', item_id: LADDER, location_id: OFALLON, quantity: '-3', moves_stock: false, value: '-420.00' },
      ],
    });
    // Its cost lines alone, not the sale.
    expect(i7001.netsuite_gl).toEqual({
      posting_month: FEB,
      entry: [{ account_id: INVENTORY, debit: '0.00', credit: '420.00' }, { account_id: RACK_COGS, debit: '420.00', credit: '0.00' }],
    });
    // Eight racks were left at O'Fallon after NetSuite's fulfillment, worth $1,120.
    expect(i7001.before).toEqual([{ item_id: LADDER, location_id: OFALLON, quantity: '8', value: '1120.00' }]);
    expect(i7001.customer_name).toBe('Acme Fleet');

    // A kit, with what it holds at the invoice's location, and what NetSuite took for it.
    expect(i7002.own.lines).toEqual([{ line_no: 1, item_id: RACK_KIT, item_number: 'KIT-RACK', description: null, item_type: 'Kit', quantity: '2.0000' }]);
    expect(i7002.before).toEqual([
      { item_id: LADDER, location_id: OFALLON, quantity: '5', value: '700.00' },
      { item_id: BINS, location_id: OFALLON, quantity: '20', value: '400.00' },
      { item_id: RACK_KIT, location_id: OFALLON, quantity: '0', value: '0' },
    ]);
    expect(i7002.netsuite_gl!.entry).toEqual([
      { account_id: INVENTORY, debit: '0.00', credit: '360.00' },
      { account_id: COGS, debit: '80.00', credit: '0.00' },
      { account_id: RACK_COGS, debit: '280.00', credit: '0.00' },
    ]);

    // An item the lists copy doesn't have may be kept in stock; each side's location is counted.
    expect(i7003.own.lines.map((l) => [l.item_id, l.item_type])).toEqual([[LADDER, 'InvtPart'], [SHELF, null]]);
    expect(i7003.before).toEqual([
      { item_id: LADDER, location_id: OFALLON, quantity: '3', value: '420.00' },
      { item_id: LADDER, location_id: WENTZVILLE, quantity: '0', value: '0' },
      { item_id: SHELF, location_id: WENTZVILLE, quantity: '0', value: '0' },
    ]);

    // Not in NetSuite's copies yet.
    expect(i7004).toMatchObject({ netsuite: null, netsuite_gl: null });
    expect(i7004.before).toEqual([{ item_id: BINS, location_id: OFALLON, quantity: '16', value: '320.00' }]);

    // The items either side names, a kit with its parts.
    expect(res.items).toEqual({
      [LADDER]: { number: 'LDR-24', type: 'InvtPart', display_name: 'Ladder rack 24 in', parts: null },
      [BINS]: { number: 'BIN-10', type: 'InvtPart', display_name: null, parts: null },
      [RACK_KIT]: { number: 'KIT-RACK', type: 'Kit', display_name: 'Rack and bins', parts: [{ item: LADDER, quantity: 1 }, { item: BINS, quantity: 2 }] },
    });
    expect(res.locations).toEqual({ [OFALLON]: "O'Fallon", [WENTZVILLE]: 'Wentzville' });
    expect(Object.keys(res.accounts).sort()).toEqual([RECEIVABLE, INVENTORY, SALES, INSTALLS, COGS, RACK_COGS].sort());
  });

  it('gives one invoice by its id, none off a sales order, and the first and last days of the dates asked for', async () => {
    expect((await pairs(null, null, '7002')).invoices.map((i) => i.own.netsuite_id)).toEqual(['7002']);
    expect((await pairs(null, null, '7005')).invoices).toEqual([]);
    expect((await pairs('2025-03-01', '2025-03-31')).invoices).toEqual([]);
    expect((await pairs('2025-02-10', '2025-02-15')).invoices.map((i) => i.own.netsuite_id)).toEqual(['7004', '7003', '7002', '7001']);
    expect((await pairs('2025-02-11', '2025-02-14')).invoices.map((i) => i.own.netsuite_id)).toEqual(['7003', '7002']);
  });

  it("leaves out a line that bills none of an item, or doesn't say how many", async () => {
    expect(await call(pg, 'gl_own_invoice_save', ownInvoice('7008', { invoice_date: '2025-03-04' }, [
      [LADDER, 'LDR-24', 0, 0], [BINS, 'BIN-10', null, 10], [BINS, 'BIN-10', 1, 25],
    ]))).toMatchObject({ saved: true });
    try {
      expect((await pairs(null, null, '7008')).invoices[0].own.lines).toEqual([
        { line_no: 3, item_id: BINS, item_number: 'BIN-10', description: null, item_type: 'InvtPart', quantity: '1.0000' },
      ]);
    } finally {
      await pg.query("DELETE FROM gl_own_invoices WHERE netsuite_id = '7008'");
    }
  });

  it("names the customer as FleetSuite's own record does, or else as the copy of NetSuite's customers does", async () => {
    await pg.query("UPDATE gl_netsuite_lists SET name = 'Acme Fleet Services LLC' WHERE kind = 'customer' AND netsuite_id = '7700'");
    try {
      expect((await pairs(null, null, '7001')).invoices[0].customer_name).toBe('Acme Fleet');
      await pg.query('UPDATE customers SET company_name = $1 WHERE id = $2', ['  ', ACME]);
      expect((await pairs(null, null, '7001')).invoices[0].customer_name).toBe('Acme Fleet Services LLC');
    } finally {
      await pg.query('UPDATE customers SET company_name = $1 WHERE id = $2', ['Acme Fleet', ACME]);
      await pg.query("UPDATE gl_netsuite_lists SET name = 'Acme Fleet' WHERE kind = 'customer' AND netsuite_id = '7700'");
    }
  });

  it("gives an item NetSuite doesn't keep in stock no value just before, as Stock by item doesn't", async () => {
    // NetSuite's starting count has two shelves at Wentzville, worth $60, and the copy of its items doesn't have them.
    await pg.query(
      `INSERT INTO gl_netsuite_stock_opening (company_id, item_id, location_id, quantity, value)
       SELECT id, $1, $2, 2, 60 FROM gl_companies WHERE code = 'BMG'`,
      [SHELF, WENTZVILLE],
    );
    try {
      expect((await pairs(null, null, '7003')).invoices[0].before)
        .toContainEqual({ item_id: SHELF, location_id: WENTZVILLE, quantity: '2', value: '0' });
    } finally {
      await pg.query('DELETE FROM gl_netsuite_stock_opening WHERE item_id = $1', [SHELF]);
    }
  });

  it("gives NetSuite's lines of the invoice's own company alone", async () => {
    const doc = stockDoc('7004', 'CustInvc', 'INV7004', '2025-02-15', [['1', BINS, OFALLON, '-5', true], ['2', BINS, OFALLON, '-5', true]]);
    doc.lines[1].company = '1084';
    expect(await call(pg, 'gl_netsuite_stock_apply', { documents: [doc] })).toMatchObject({ added: 1 });
    try {
      expect((await pairs(null, null, '7004')).invoices[0].netsuite).toEqual({
        number: 'INV7004', type: 'CustInvc', date: '2025-02-15', gone: false,
        lines: [{ line_id: '1', item_id: BINS, location_id: OFALLON, quantity: '-5', moves_stock: true, value: null }],
      });
    } finally {
      await pg.query("DELETE FROM gl_netsuite_stock_lines WHERE document_id = '7004'");
      await pg.query("DELETE FROM gl_netsuite_stock_documents WHERE netsuite_id = '7004'");
    }
  });

  it('takes apart kits inside kits, and leaves the parts of one it can\'t read', async () => {
    const insert = (id: string, name: string, details: unknown) => pg.query(
      'INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ($1, $2, $3, true, $4::jsonb)',
      ['item', id, name, JSON.stringify(details)],
    );
    await insert('9101', 'KIT-OUTER', { item_type: 'Kit', parts: [{ item: RACK_KIT, quantity: 2 }, { item: '9102', quantity: 1 }] });
    await insert('9102', 'KIT-ODD', { item_type: 'Kit', parts: 'not a list' });
    try {
      expect(await call(pg, 'gl_own_invoice_save', ownInvoice('7006', { invoice_date: '2025-03-02' }, [['9101', 'KIT-OUTER', 1, 100]])))
        .toMatchObject({ saved: true });
      const res = await pairs(null, null, '7006');
      expect(Object.keys(res.items).sort()).toEqual([LADDER, BINS, RACK_KIT, '9101', '9102'].sort());
      expect(res.items['9102'].parts).toBe('not a list');
      expect(res.invoices[0].before.map((b) => b.item_id).sort()).toEqual([LADDER, BINS, RACK_KIT, '9101', '9102'].sort());
    } finally {
      await pg.query("DELETE FROM gl_own_invoices WHERE netsuite_id = '7006'");
      await pg.query("DELETE FROM gl_netsuite_lists WHERE kind = 'item' AND netsuite_id IN ('9101', '9102')");
    }
  });

  const accounts = (company: string, items: Record<string, string[]>) =>
    one<Record<string, unknown>>(pg, 'SELECT gl_own_invoice_cost_accounts($1, $2::jsonb) AS r', [company, JSON.stringify(items)]);

  it("gl_own_invoice_cost_accounts learns each item's cost account from NetSuite's last fulfillment or invoice of it before", async () => {
    expect(await accounts('BMG', { 7001: [LADDER], 7002: [LADDER, BINS] })).toEqual({
      items: { [LADDER]: INVENTORY, [BINS]: INVENTORY },
      invoices: {
        // The racks' cost goes where NetSuite's fulfillment before it put theirs.
        7001: { [LADDER]: { cost: RACK_COGS, from: { netsuite_id: '5002', number: 'IF5002', date: '2025-01-20', type: 'ItemShip' }, netsuite: RACK_COGS } },
        7002: {
          // Then where NetSuite's invoice of them put it: not the credit that debits sales on the 11th.
          [LADDER]: { cost: RACK_COGS, from: { netsuite_id: '7001', number: 'INV7001', date: '2025-02-10', type: 'CustInvc' }, netsuite: RACK_COGS },
          // NetSuite hadn't shipped or sold bins before.
          [BINS]: { cost: null, from: null, netsuite: COGS },
        },
      },
      usual_cost: RACK_COGS,
    });
    // An invoice asked about alone has the same; one NetSuite's copies don't have yet has no account of its own.
    expect(await accounts('BMG', { 7004: [BINS] })).toEqual({
      items: { [BINS]: INVENTORY },
      invoices: { 7004: { [BINS]: { cost: COGS, from: { netsuite_id: '7002', number: 'INV7002', date: '2025-02-12', type: 'CustInvc' }, netsuite: null } } },
      usual_cost: RACK_COGS,
    });
    // Nothing asked about, or not a list: nothing named, no usual account.
    expect(await accounts('BMG', {})).toEqual({ items: {}, invoices: {}, usual_cost: null });
    expect(await one(pg, 'SELECT gl_own_invoice_cost_accounts($1, $2::jsonb) AS r', ['BMG', '[]'])).toEqual({ items: {}, invoices: {}, usual_cost: null });
    expect(await accounts('BMG', { 7001: ['x', LADDER] })).toMatchObject({ items: { [LADDER]: INVENTORY } });
    // An invoice FleetSuite has no copy of, or another company's, isn't asked about.
    expect(await accounts('BMG', { 9999: [LADDER] })).toEqual({ items: {}, invoices: {}, usual_cost: null });
    expect(await accounts('1084', { 7001: [LADDER] })).toEqual({ items: {}, invoices: {}, usual_cost: null });
  });

  it('learns nothing from a document NetSuite deleted, and counts nothing it took', async () => {
    expect(await call(pg, 'gl_netsuite_stock_finish', { netsuite_ids: ['5002', '7002', '7003', '7090'] })).toMatchObject({ gone: 1 });
    try {
      expect(await accounts('BMG', { 7002: [LADDER] })).toMatchObject({
        invoices: { 7002: { [LADDER]: { cost: RACK_COGS, from: { netsuite_id: '5002', number: 'IF5002', date: '2025-01-20', type: 'ItemShip' } } } },
      });
      // The racks the deleted invoice took aren't counted out before the kits' invoice, nor their $420.
      expect((await pairs(null, null, '7002')).invoices[0].before)
        .toContainEqual({ item_id: LADDER, location_id: OFALLON, quantity: '8', value: '1120.00' });
      // And a deleted invoice is gone from its pair.
      expect((await pairs(null, null, '7001')).invoices[0].netsuite).toMatchObject({ gone: true });
    } finally {
      expect(await call(pg, 'gl_netsuite_stock_apply', { documents: [INV7001] })).toMatchObject({});
    }
    expect((await pairs(null, null, '7001')).invoices[0].netsuite).toMatchObject({ gone: false });
  });

  it("gl_stock_documents also gives an invoice's cost lines alone, as gl_stock_month does", async () => {
    const res = await one<{ documents: StockDocument[] }>(
      pg, 'SELECT gl_stock_documents($1, $2::text[]) AS r', ['BMG', textArray(['7002', '5002', '7090', '9999'])],
    );
    // By date; not the invoice that books no cost, nor one the copy doesn't have.
    expect(res.documents.map((d) => [d.netsuite_id, d.type, d.number, d.date, d.posting_month, d.companies])).toEqual([
      ['5002', 'ItemShip', 'IF5002', '2025-01-20', '2025-01-01', ['BMG']],
      ['7002', 'CustInvc', 'INV7002', '2025-02-12', FEB, ['BMG']],
    ]);
    expect(res.documents[1].lines.map((l) => [l.line_id, l.account, l.debit, l.credit])).toEqual([
      ['4', RACK_COGS, '280.00', '0.00'], ['5', INVENTORY, '0.00', '280.00'], ['6', COGS, '80.00', '0.00'], ['7', INVENTORY, '0.00', '80.00'],
    ]);
    // What gl_stock_month gives of it, line for line.
    const month = await one<{ documents: StockDocument[] }>(pg, 'SELECT gl_stock_month($1, $2::date) AS r', ['BMG', FEB]);
    expect(month.documents.find((d) => d.netsuite_id === '7002')).toEqual(res.documents[1]);
    expect(await one(pg, 'SELECT gl_stock_documents($1, $2::text[]) AS r', ['1084', textArray(['7002'])])).toEqual({ documents: [] });
    expect(await one(pg, 'SELECT gl_stock_documents($1, NULL) AS r', ['BMG'])).toEqual({ documents: [] });
  });

  it("is the service role's alone, and neither new read writes anything", async () => {
    await pg.exec('RESET ROLE');
    for (const fn of [
      'public.gl_own_invoice_cost_pairs(date, date, text)', 'public.gl_own_invoice_cost_accounts(text, jsonb)',
      'public.gl_stock_documents(text, text[])',
    ]) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>(pg, `SELECT has_function_privilege($1::name, '${fn}', 'EXECUTE') AS r`, [role]), `${fn} ${role}`)
          .toBe(role === 'service_role');
      }
    }
    for (const name of ['gl_own_invoice_cost_pairs', 'gl_own_invoice_cost_accounts', 'gl_stock_documents']) {
      const body = await one<string>(pg, 'SELECT prosrc AS r FROM pg_proc WHERE proname = $1', [name]);
      expect(body, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    }
    await pg.exec('SET ROLE service_role');
  });
});

// ── The posting job ────────────────────────────────────────────────────────

describe("the posting job, with Books' own invoices' cost", () => {
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
                : {
                  data: store.has(key) ? { last_result: store.get(key).last_result, last_synced_at: store.get(key).last_synced_at ?? null } : null,
                  error: null,
                }),
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

  // An invoice's lines aren't asked of NetSuite here, so its sale doesn't post: its cost does, from the copies alone.
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
  /** The entry that stands for a document, by its key's start ('invoice_cost:7001'). */
  const standing = async (key: string) => (await journal()).filter((e) => e.key?.startsWith(`${key}:`)).at(-1)!;
  /** One invoice's cost, checked as the Own invoices page checks it. */
  const checked = async (id: string) => checkOwnInvoiceCosts(
    await one<InvoiceCostPairsData>(pg, 'SELECT gl_own_invoice_cost_pairs(NULL, NULL, $1) AS r', [id]), { stock: null, ledger: null },
  ).invoices[0];

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    await copyNetSuite(pg);
    h.service = service();
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it("posts NetSuite's cost lines while Books has no copies of the invoices", async () => {
    const r = await run();
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ posted: 4, replaced: 0, reversed: 0, failedCount: 0 });
    // Not the invoice that booked no cost.
    expect((await journal()).map((e) => [e.key, e.rule, e.date])).toEqual([
      ['item_fulfillment:5002:1', 'stock@1', '2025-01-20'],
      ['invoice_cost:7001:1', 'stock@1', '2025-02-10'],
      ['invoice_cost:7002:1', 'stock@1', '2025-02-12'],
      ['invoice_cost:7003:1', 'stock@1', '2025-02-14'],
    ]);
  });

  it("replaces NetSuite's cost lines with the copy's where what it took matches and its entry is the same, and nothing in the books moves", async () => {
    await saveOwnCopies(pg);
    const before = await balances();
    const r = await run();
    expect(r.error).toBeUndefined();
    // The kits match, but the copy puts the bins' cost elsewhere, so NetSuite's stands; the typed invoice took its rack
    // from O'Fallon, not Wentzville.
    expect(r).toMatchObject({ posted: 0, replaced: 1, reversed: 0, unchanged: 3, failedCount: 0 });
    expect((await journal()).slice(4).map((e) => [e.no, e.key, e.reverses, e.memo, e.rule])).toEqual([
      [5, null, 2, "INV7001 now posts from FleetSuite's own copy", 'reversal'],
      [6, 'invoice_cost:7001:2', null, 'INV7001', 'own_invoice_cost@1'],
    ]);
    expect(await balances()).toEqual(before);
    // The racks' cost off their asset account, onto the cost account NetSuite's fulfillment of them before used.
    expect(await linesOf(6)).toEqual([
      { account: RACK_COGS, debit: '420.00', credit: '0.00', memo: 'Acme Fleet · LDR-24', source_line_ref: `own:${LADDER}:cost` },
      { account: INVENTORY, debit: '0.00', credit: '420.00', memo: 'Acme Fleet · LDR-24', source_line_ref: `own:${LADDER}:asset` },
    ]);
  });

  it('changes nothing the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 4, failedCount: 0 });
    expect(await journal()).toEqual(before);
  });

  it("says which copy made each cost entry, and on the invoice's page the copy's entry next to NetSuite's", async () => {
    const books = await readOwnBooks(service(), INVOICE_COST_BOOKS, ['7001', '7002', '7003'].map((netsuiteId) => ({ company: 'BMG', netsuiteId })));
    expect(Object.fromEntries(books)).toEqual({
      7001: { entryNo: 6, date: '2025-02-10', from: 'fleetsuite' },
      7002: { entryNo: 3, date: '2025-02-12', from: 'netsuite' },
      7003: { entryNo: 4, date: '2025-02-14', from: 'netsuite' },
    });

    expect(await readOwnStockView(service(), { kind: 'invoice_cost', check: await checked('7001') })).toEqual({
      books: { entryNo: 6, date: '2025-02-10', from: 'fleetsuite' },
      month: FEB,
      posts: true,
      why: null,
      entry: [
        { account: '58500 Cost of Goods Sold - Racks', fleetsuite: 42000, netsuite: 42000, same: true },
        { account: '19000 Inventory Asset', fleetsuite: -42000, netsuite: -42000, same: true },
      ],
      differs: null,
      learned: [],
      costs: "Each item's cost comes out of its asset account and goes to the cost account NetSuite's last fulfillment or invoice "
        + 'of it used: 58500 Cost of Goods Sold - Racks for it.',
    });
    const differs = "FleetSuite hadn't seen BIN-10 shipped or sold before, so it put its $80.00 in 58500 Cost of Goods Sold - Racks, "
      + 'where most fulfillments put theirs, and NetSuite put it in 58000 Cost of Goods Sold';
    expect(await readOwnStockView(service(), { kind: 'invoice_cost', check: await checked('7002') })).toEqual({
      books: { entryNo: 3, date: '2025-02-12', from: 'netsuite' },
      month: FEB,
      posts: false,
      why: `FleetSuite's own copy matches NetSuite's invoice, but its entry doesn't match NetSuite's, so the books post NetSuite's: ${differs}.`,
      entry: [
        { account: '58500 Cost of Goods Sold - Racks', fleetsuite: 36000, netsuite: 28000, same: false },
        { account: '58000 Cost of Goods Sold', fleetsuite: null, netsuite: 8000, same: false },
        { account: '19000 Inventory Asset', fleetsuite: -36000, netsuite: -36000, same: true },
      ],
      differs,
      learned: ["From now on FleetSuite's own invoices put BIN-10's cost in 58000, as NetSuite did here."],
      costs: "Each item's cost comes out of its asset account and goes to the cost account NetSuite's last fulfillment or invoice "
        + "of it used: 58500 Cost of Goods Sold - Racks for LDR-24. FleetSuite hadn't seen BIN-10 shipped or sold before, so its cost "
        + 'goes to 58500 Cost of Goods Sold - Racks, where most fulfillments put theirs.',
    });
    // Took its rack from where FleetSuite didn't say, so the copy differs and has no entry to put next to NetSuite's.
    const typed = await checked('7003');
    expect(typed.status).not.toBe('matches');
    expect(await readOwnStockView(service(), { kind: 'invoice_cost', check: typed })).toMatchObject({
      books: { entryNo: 4, date: '2025-02-14', from: 'netsuite' }, month: FEB, posts: false,
    });
  });

  it("shows each invoice's cost on its page on Own invoices, and none for one off a sales order", async () => {
    const read = async (id: string) => {
      const res = await GET_INVOICE(new NextRequest(`https://go.bmgfleet.com/api/admin/books/own-invoices?id=${id}`));
      return { status: res.status, body: await res.json() };
    };
    const rack = await read('7001');
    expect(rack.status).toBe(200);
    expect(rack.body.invoice.costError).toBeUndefined();
    expect(rack.body.invoice.cost.check).toMatchObject({ netsuiteId: '7001', number: 'INV7001', status: 'matches', madeFrom: 'scans' });
    expect(rack.body.invoice.cost.posting).toMatchObject({ books: { entryNo: 6, from: 'fleetsuite' }, posts: true });
    const vehicle = await read('7005');
    expect(vehicle.status).toBe(200);
    expect(vehicle.body.invoice.cost).toBeNull();
    // A read of the cost that fails leaves the rest of the page.
    failing.add('gl_own_invoice_cost_pairs');
    try {
      const failed = await read('7001');
      expect(failed.status).toBe(200);
      expect(failed.body.invoice).toMatchObject({ netsuiteId: '7001', costError: 'gl_own_invoice_cost_pairs failed' });
      expect(failed.body.invoice.cost).toBeUndefined();
    } finally {
      failing.delete('gl_own_invoice_cost_pairs');
    }
  });

  it("stops the run, saying what it was reading, when the copies or their months can't be read", async () => {
    const before = await journal();
    for (const [read, error] of [
      // The months of FleetSuite's own invoices are read for their sales first.
      ['gl_own_invoice_months', "Reading the months of FleetSuite's own invoices: gl_own_invoice_months failed"],
      ['gl_own_invoice_cost_pairs', "Reading Books' own copies of BMG's fulfillments, receipts, adjustments and invoices for Feb 2025: gl_own_invoice_cost_pairs failed"],
      ['gl_own_invoice_cost_accounts', "Reading Books' own copies of BMG's fulfillments, receipts, adjustments and invoices for Feb 2025: gl_own_invoice_cost_accounts failed"],
      [BOOKS_STOCK_SYNC, `Reading how far the copies of NetSuite had come: ${BOOKS_STOCK_SYNC} failed`],
      [BOOKS_GL_SYNC, `Reading how far the copies of NetSuite had come: ${BOOKS_GL_SYNC} failed`],
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

  it("goes back to NetSuite's when the copy stops matching", async () => {
    // NetSuite costs the Scan Log's invoice of racks again, at $410.
    await gl(pg, '7001', 'CustInvc', 'INV7001', '2025-02-10', [
      ['0', RECEIVABLE, 90000], ['1', SALES, -75000], ['2', INSTALLS, -15000], ['3', RACK_COGS, 41000], ['4', INVENTORY, -41000],
    ]);
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, reversed: 0, unchanged: 3, failedCount: 0 });
    expect((await journal()).slice(6).map((e) => [e.no, e.key, e.reverses, e.memo, e.rule])).toEqual([
      [7, null, 6, "INV7001 now posts from NetSuite's invoice", 'reversal'],
      [8, 'invoice_cost:7001:3', null, 'INV7001', 'stock@1'],
    ]);
    expect((await standing('invoice_cost:7001')).rule).toBe('stock@1');
  });

  it("says on an invoice's page what's still to come of NetSuite's side, from how far the copies of NetSuite had come", async () => {
    // Two more of the Scan Log's invoices of bins: the copy of NetSuite's stock moves has the second, the copy of its
    // general ledger neither.
    for (const p of [
      ownInvoice('7006', { invoice_date: '2025-03-03' }, [[BINS, 'BIN-10', 2, 50]]),
      ownInvoice('7007', { invoice_date: '2025-03-03' }, [[BINS, 'BIN-10', 1, 25]]),
    ]) expect(await call(pg, 'gl_own_invoice_save', p), p.netsuite_id).toMatchObject({ saved: true });
    expect(await call(pg, 'gl_netsuite_stock_apply', {
      documents: [stockDoc('7007', 'CustInvc', 'INV7007', '2025-03-03', [['1', BINS, OFALLON, '-1', true]])],
    })).toMatchObject({ added: 1 });
    const read = async (id: string) =>
      (await (await GET_INVOICE(new NextRequest(`https://go.bmgfleet.com/api/admin/books/own-invoices?id=${id}`))).json()).invoice;
    const cost = async (id: string) => (await read(id)).cost.check;
    const field = (check: { fields: Array<{ field: string }> }, name: string) => check.fields.find((f) => f.field === name);
    // The copies are made when they're saved: the copies of NetSuite ran an hour before, or an hour after.
    const was = new Map([BOOKS_STOCK_SYNC, BOOKS_GL_SYNC].map((k) => [k, store.get(k)]));
    const copied = (key: string, hours: number) =>
      store.set(key, { ...store.get(key), last_synced_at: new Date(Date.now() + hours * 3_600_000).toISOString() });
    try {
      copied(BOOKS_STOCK_SYNC, -1);
      copied(BOOKS_GL_SYNC, -1);
      expect(await cost('7006')).toMatchObject({
        status: 'waiting', summary: "Waiting for NetSuite's invoice: the copy of NetSuite's stock moves runs every two hours.",
      });
      expect(await cost('7007')).toMatchObject({
        status: 'waiting', summary: "Waiting for the copy of NetSuite's general ledger to reach the invoice.",
      });

      // The copy of NetSuite's stock moves ran since without the first: NetSuite's took nothing.
      copied(BOOKS_STOCK_SYNC, 1);
      const none = await cost('7006');
      expect(none.status).toBe('differs');
      expect(field(none, 'items')).toMatchObject({
        same: false,
        why: "NetSuite's invoice took nothing from stock, or is gone from NetSuite: the copy of NetSuite's stock moves, made since, doesn't have it.",
      });
      expect((await cost('7007')).status).toBe('waiting');

      // The copy of NetSuite's general ledger ran since without the second: NetSuite's booked no cost.
      copied(BOOKS_GL_SYNC, 1);
      const unbooked = await cost('7007');
      expect(unbooked.status).toBe('differs');
      expect(field(unbooked, 'cost')).toMatchObject({
        fleetsuite: '$20.00', netsuite: '$0.00', same: false,
        why: "NetSuite's invoice booked no cost: the copy of its general ledger, made since, has no entry for it.",
      });

      // A copy whose progress can't be read leaves the rest of the page, saying so.
      for (const key of [BOOKS_STOCK_SYNC, BOOKS_GL_SYNC]) {
        failing.add(key);
        try {
          const page = await read('7006');
          expect(page, key).toMatchObject({ netsuiteId: '7006', costError: `${key} failed` });
          expect(page.cost, key).toBeUndefined();
        } finally {
          failing.delete(key);
        }
      }
    } finally {
      for (const [key, row] of was) {
        if (row === undefined) store.delete(key);
        else store.set(key, row);
      }
    }
  });
});
