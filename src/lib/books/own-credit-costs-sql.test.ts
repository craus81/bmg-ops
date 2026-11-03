// Migration 519 has the posting job post the stock a credit memo FleetSuite
// made puts back on the shelf from Books' own copy of the credit memo
// (migration 466) in place of NetSuite's cost lines, when what the copy put
// back matches NetSuite's credit memo and its entry comes out the same, as an
// invoice's cost does (migration 517). This runs migration 314 (with
// stand-ins for the app tables it and 407, 416, 435, 454 and 466–471 point
// at) and the books' migrations those depend on, 445, 466–471, 517, 518 and
// 519 in an in-memory Postgres (PGlite) as the app's server login, holds what
// gl_own_credit_cost_pairs and gl_own_credit_cost_accounts return for copies
// worked out by src/lib/credit-memo.ts and src/lib/books/own-credit-memos.ts,
// then runs the posting job against made-up NetSuite credit memos and Books'
// own copies of them, and reads what the Own credit memos page shows of them.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';

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
// The Own credit memos page's read, as whoever opens the books, on the scratch database.
vi.mock('@/lib/api-auth', () => ({ requireBooks: vi.fn(async () => ({ user: { id: 'a0000000-0000-4000-8000-0000000000aa' } })) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));

import { NO_EARLIER, parseInvoiceRecord, STOCK_LOCATION_ID, workOutCreditMemo, type InvoiceView } from '@/lib/credit-memo';
import { ownCreditMemoPayload } from './own-credit-memos';
import { postInvoices } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { BOOKS_GL_SYNC } from './netsuite-gl';
import { BOOKS_STOCK_SYNC } from './netsuite-stock';
import { readOwnBooks } from './own-invoice-posting';
import { CREDIT_COST_BOOKS } from './own-stock-posting';
import { checkOwnCreditCosts, type CreditCostPairsData } from './own-credit-cost-check';
import { readOwnStockView } from './own-posting-view';
import { GET as GET_CREDIT_MEMO } from '../../app/api/admin/books/own-credit-memos/route';

const OFALLON = '1';
const WENTZVILLE = '2';
const LADDER = '9001';
const BINS = '9002';
/** A kit of one ladder rack and two bins. */
const RACK_KIT = '9003';
/** An install, which NetSuite doesn't keep in stock. */
const INSTALL = '9004';
/** A floor mat NetSuite hasn't shipped, sold or credited since its starting count. */
const MAT = '9005';
/** The credit item: money credited for a part that stays with the customer, or an amount of its own. */
const CREDIT = '9006';
/** A shelf the copy of NetSuite's items doesn't have yet. */
const SHELF = '9007';
/**
 * Made-up chart: '190' the items' inventory, '580' cost of goods sold, '585' the cost of goods sold account NetSuite
 * books ladder racks' cost to, '400' sales, '410' install income, '420' customer credits, '110' receivables.
 */
const INVENTORY = '190';
const COGS = '580';
const RACK_COGS = '585';
const SALES = '400';
const INSTALLS = '410';
const CREDITS = '420';
const RECEIVABLE = '110';
const ACCOUNTS: Array<[string, string, string, string]> = [
  [INVENTORY, '19000', 'Inventory Asset', 'other_current_asset'],
  [COGS, '58000', 'Cost of Goods Sold', 'cost_of_goods_sold'],
  [RACK_COGS, '58500', 'Cost of Goods Sold - Racks', 'cost_of_goods_sold'],
  [SALES, '40000', 'Sales', 'income'],
  [INSTALLS, '41000', 'Install Income', 'income'],
  [CREDITS, '42000', 'Customer Credits', 'income'],
  [RECEIVABLE, '11000', 'Accounts Receivable', 'accounts_receivable'],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const ACME = 'c0000000-0000-4000-8000-000000000001';
const PRESS = 'b0000000-0000-4000-8000-000000000001';
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
    '471-invoices-fixed-in-fleetsuite.sql', '517-books-own-invoice-costs.sql', '518-books-own-credit-memo-posting.sql',
    '519-books-own-credit-memo-stock.sql',
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
    ['item', MAT, 'MAT-5', { display_name: 'Floor mat', item_type: 'InvtPart', asset_account: INVENTORY, income_account: SALES }],
    ['item', CREDIT, 'CREDIT', { item_type: 'OthCharge', income_account: CREDITS }],
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

// Ten ladder racks were in O'Fallon on December 31, 2024 at $140 each, twenty bins at $20 and five floor mats at $30.
// In 2025 NetSuite ships two racks, their cost to the racks' cost account, then bills three racks and an install, and
// two rack kits. Then FleetSuite credits a rack back to the shelf (with the install and an amount of goodwill), a kit,
// a mat sold in 2024, and a rack NetSuite puts back at Wentzville though FleetSuite booked it to O'Fallon.
const IF5002 = stockDoc('5002', 'ItemShip', 'IF5002', '2025-01-20', [['1', LADDER, OFALLON, '-2', true], ['2', LADDER, OFALLON, '-2', false]]);
const INV7001 = stockDoc('7001', 'CustInvc', 'INV7001', '2025-02-10', [
  ['1', LADDER, OFALLON, '-3', true], ['3', LADDER, OFALLON, '-3', false], ['4', LADDER, OFALLON, '-3', false],
]);
const INV7002 = stockDoc('7002', 'CustInvc', 'INV7002', '2025-02-12', [
  ['1', RACK_KIT, OFALLON, '-2', false],
  ['2', LADDER, OFALLON, '-2', true], ['3', BINS, OFALLON, '-4', true],
  ['4', LADDER, OFALLON, '-2', false], ['5', LADDER, OFALLON, '-2', false],
  ['6', BINS, OFALLON, '-4', false], ['7', BINS, OFALLON, '-4', false],
]);
/** The rack's line puts it back on the shelf; its cost of goods and asset lines name it without moving it. */
const CM8001 = stockDoc('8001', 'CustCred', 'CM8001', '2025-02-20', [
  ['1', LADDER, OFALLON, '1', true], ['4', LADDER, OFALLON, '1', false], ['5', LADDER, OFALLON, '1', false],
]);
/** The kit's line names the kit without moving it; NetSuite puts its parts back. */
const CM8002 = stockDoc('8002', 'CustCred', 'CM8002', '2025-02-21', [
  ['1', RACK_KIT, OFALLON, '1', false],
  ['2', LADDER, OFALLON, '1', true], ['3', BINS, OFALLON, '2', true],
  ['4', LADDER, OFALLON, '1', false], ['5', LADDER, OFALLON, '1', false],
  ['6', BINS, OFALLON, '2', false], ['7', BINS, OFALLON, '2', false],
]);
const CM8003 = stockDoc('8003', 'CustCred', 'CM8003', '2025-02-24', [
  ['1', MAT, OFALLON, '1', true], ['2', MAT, OFALLON, '1', false], ['3', MAT, OFALLON, '1', false],
]);
const CM8004 = stockDoc('8004', 'CustCred', 'CM8004', '2025-02-26', [
  ['1', LADDER, WENTZVILLE, '1', true], ['2', LADDER, WENTZVILLE, '1', false], ['3', LADDER, WENTZVILLE, '1', false],
]);

async function copyNetSuite(pg: PGlite) {
  expect(await call(pg, 'gl_netsuite_stock_store_opening', {
    rows: [
      { company: 'BMG', item_id: LADDER, location_id: OFALLON, quantity: '10', value: '1400.00' },
      { company: 'BMG', item_id: BINS, location_id: OFALLON, quantity: '20', value: '400.00' },
      { company: 'BMG', item_id: MAT, location_id: OFALLON, quantity: '5', value: '150.00' },
    ],
  })).toEqual({ rows: 3 });
  expect(await call(pg, 'gl_netsuite_stock_apply', { documents: [IF5002, INV7001, INV7002, CM8001, CM8002, CM8003, CM8004] }))
    .toMatchObject({ added: 7 });
  await gl(pg, '5002', 'ItemShip', 'IF5002', '2025-01-20', [['1', INVENTORY, -28000], ['2', RACK_COGS, 28000]]);
  // Three racks at $140 and an install, the racks' $420 cost to their cost account.
  await gl(pg, '7001', 'CustInvc', 'INV7001', '2025-02-10', [
    ['0', RECEIVABLE, 90000], ['1', SALES, -75000], ['2', INSTALLS, -15000], ['3', RACK_COGS, 42000], ['4', INVENTORY, -42000],
  ]);
  // Two kits: two racks at $140 to their cost account, four bins at $20 to cost of goods sold.
  await gl(pg, '7002', 'CustInvc', 'INV7002', '2025-02-12', [
    ['0', RECEIVABLE, 80000], ['1', SALES, -80000],
    ['4', RACK_COGS, 28000], ['5', INVENTORY, -28000], ['6', COGS, 8000], ['7', INVENTORY, -8000],
  ]);
  // A rack back at $140, the three racks left worth $420: out of the racks' cost account, onto the shelf.
  await gl(pg, '8001', 'CustCred', 'CM8001', '2025-02-20', [
    ['0', RECEIVABLE, -42500], ['1', SALES, 25000], ['2', INSTALLS, 15000], ['3', CREDITS, 2500],
    ['4', RACK_COGS, -14000], ['5', INVENTORY, 14000],
  ]);
  // A kit back: a rack at $140 and two bins at $20.
  await gl(pg, '8002', 'CustCred', 'CM8002', '2025-02-21', [
    ['0', RECEIVABLE, -40000], ['1', SALES, 40000],
    ['4', RACK_COGS, -14000], ['5', INVENTORY, 14000], ['6', COGS, -4000], ['7', INVENTORY, 4000],
  ]);
  // A mat back at $30, out of cost of goods sold.
  await gl(pg, '8003', 'CustCred', 'CM8003', '2025-02-24', [
    ['0', RECEIVABLE, -6000], ['1', SALES, 6000], ['2', COGS, -3000], ['3', INVENTORY, 3000],
  ]);
  await gl(pg, '8004', 'CustCred', 'CM8004', '2025-02-26', [
    ['0', RECEIVABLE, -25000], ['1', SALES, 25000], ['2', RACK_COGS, -14000], ['3', INVENTORY, 14000],
  ]);
}

// ── Books' own copies of them, worked out as the credit memo screen works them out ──

/** NetSuite's invoice as the credit memo screen reads it: [line, item, number, type, quantity, price each]. */
const invoice = (id: string, date: string, location: string, lines: Array<[number, string, string, string, number, number]>): InvoiceView => {
  const subtotal = lines.reduce((s, l) => s + l[4] * l[5], 0);
  return parseInvoiceRecord({
    id, tranId: `INV${id}`, tranDate: date, entity: { id: '7700', refName: 'Acme Fleet' },
    location: { id: location, refName: location === OFALLON ? "O'Fallon" : 'Wentzville' },
    subtotal, taxTotal: 0, total: subtotal,
    item: {
      items: lines.map(([line, item, number, itemType, quantity, rate]) => ({
        line, item: { id: item, refName: number }, itemType, quantity, rate, amount: quantity * rate, isTaxable: false,
      })),
    },
  });
};
const RACKS_INVOICE = invoice('7001', '2025-02-10', OFALLON, [[1, LADDER, 'LDR-24', 'InvtPart', 3, 250], [2, INSTALL, 'INSTALL', 'Service', 1, 150]]);
const KITS_INVOICE = invoice('7002', '2025-02-12', OFALLON, [[1, RACK_KIT, 'KIT-RACK', 'Kit', 2, 400]]);
/** Billed in 2024, before the copies start. */
const MATS_INVOICE = invoice('6001', '2024-11-05', OFALLON, [[1, MAT, 'MAT-5', 'InvtPart', 2, 60]]);
const WENTZVILLE_INVOICE = invoice('6002', '2024-12-02', WENTZVILLE, [[1, LADDER, 'LDR-24', 'InvtPart', 2, 250]]);

/** Books' own copy of a credit memo FleetSuite made against `inv` on `creditDate`, as gl_own_credit_memo_save takes it. */
const creditCopy = (
  netsuiteId: string,
  creditDate: string,
  inv: InvoiceView,
  drafts: Parameters<typeof workOutCreditMemo>[1],
  added: Parameters<typeof workOutCreditMemo>[2] = [],
) => {
  const worked = workOutCreditMemo(inv, drafts, added, { earlier: NO_EARLIER, creditItem: { id: CREDIT, itemNumber: 'CREDIT' }, reason: 'Returned' });
  expect(worked.problems).toEqual([]);
  return ownCreditMemoPayload(
    { netsuiteId, netsuiteNumber: `CM${netsuiteId}`, invoice: inv, worked, reason: 'Returned', madeFromId: PRESS, madeBy: null },
    { customerId: ACME, creditDate },
  );
};

const COPIES = [
  // A rack back on the shelf, the install, and $25 of goodwill on the credit item.
  creditCopy('8001', '2025-02-20', RACKS_INVOICE, [{ line: 1, quantity: 1, price: 250 }, { line: 2, quantity: 1, price: 150 }],
    [{ description: 'Goodwill', amount: 25, taxable: false }]),
  creditCopy('8002', '2025-02-21', KITS_INVOICE, [{ line: 1, quantity: 1, price: 400 }]),
  creditCopy('8003', '2025-02-24', MATS_INVOICE, [{ line: 1, quantity: 1, price: 60 }]),
  creditCopy('8004', '2025-02-26', WENTZVILLE_INVOICE, [{ line: 1, quantity: 1, price: 250 }]),
  // The install, and a rack the customer keeps, credited on the credit item: nothing back on the shelf.
  creditCopy('8005', '2025-02-27', RACKS_INVOICE, [{ line: 2, quantity: 1, price: 150 }, { line: 1, quantity: 1, price: 250, backToStock: false }]),
  // Another rack back, which NetSuite's copies don't have yet.
  creditCopy('8006', '2025-03-03', RACKS_INVOICE, [{ line: 1, quantity: 1, price: 250 }]),
];

async function saveOwnCopies(pg: PGlite) {
  for (const p of COPIES) {
    expect(await call(pg, 'gl_own_credit_memo_save', p), p.netsuite_id).toMatchObject({ saved: true });
  }
}

interface Pairs {
  credit_memos: Array<{
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

describe("migration 519's functions", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await copyNetSuite(pg);
    await saveOwnCopies(pg);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  const pairs = (from: string | null, to: string | null, id: string | null = null, location: string | null = STOCK_LOCATION_ID) =>
    one<Pairs>(pg, 'SELECT gl_own_credit_cost_pairs($1::date, $2::date, $3, $4) AS r', [from, to, id, location]);

  it("gl_own_credit_cost_pairs gives Books' own credit memos, newest first, each with what it puts back next to NetSuite's", async () => {
    expect(STOCK_LOCATION_ID).toBe(OFALLON);
    const res = await pairs('2025-02-01', '2025-02-28');
    expect(res.credit_memos.map((c) => c.own.netsuite_id)).toEqual(['8005', '8004', '8003', '8002', '8001']);
    const [c8005, c8004, c8003, c8002, c8001] = res.credit_memos;

    // The line that puts a rack back on the shelf, where the credit memo screen books it: not the install, nor the
    // goodwill on the credit item.
    expect(c8001.own).toMatchObject({
      netsuite_id: '8001', number: 'CM8001', invoice_id: '7001', invoice_number: 'INV7001', customer_netsuite_id: '7700',
      date: '2025-02-20', location_id: OFALLON,
      lines: [{ line_no: 1, item_id: LADDER, item_number: 'LDR-24', description: null, item_type: 'InvtPart', quantity: '1.0000' }],
    });
    expect(typeof c8001.own.made_at).toBe('string');
    expect(c8001.netsuite).toEqual({
      number: 'CM8001', type: 'CustCred', date: '2025-02-20', gone: false,
      lines: [
        { line_id: '1', item_id: LADDER, location_id: OFALLON, quantity: '1', moves_stock: true, value: null },
        { line_id: '4', item_id: LADDER, location_id: OFALLON, quantity: '1', moves_stock: false, value: null },
        { line_id: '5', item_id: LADDER, location_id: OFALLON, quantity: '1', moves_stock: false, value: '140.00' },
      ],
    });
    // Its cost lines alone, not the credit.
    expect(c8001.netsuite_gl).toEqual({
      posting_month: FEB,
      entry: [{ account_id: INVENTORY, debit: '140.00', credit: '0.00' }, { account_id: RACK_COGS, debit: '0.00', credit: '140.00' }],
    });
    // Three racks were left at O'Fallon after the shipment and the two invoices, worth $420.
    expect(c8001.before).toEqual([{ item_id: LADDER, location_id: OFALLON, quantity: '3', value: '420.00' }]);
    expect(c8001.customer_name).toBe('Acme Fleet');

    // A kit, with what it holds at O'Fallon, and what NetSuite put back for it.
    expect(c8002.own.lines).toEqual([{ line_no: 1, item_id: RACK_KIT, item_number: 'KIT-RACK', description: null, item_type: 'Kit', quantity: '1.0000' }]);
    expect(c8002.before).toEqual([
      { item_id: LADDER, location_id: OFALLON, quantity: '4', value: '560.00' },
      { item_id: BINS, location_id: OFALLON, quantity: '16', value: '320.00' },
      { item_id: RACK_KIT, location_id: OFALLON, quantity: '0', value: '0' },
    ]);
    expect(c8002.netsuite_gl!.entry).toEqual([
      { account_id: INVENTORY, debit: '180.00', credit: '0.00' },
      { account_id: COGS, debit: '0.00', credit: '40.00' },
      { account_id: RACK_COGS, debit: '0.00', credit: '140.00' },
    ]);

    // A mat NetSuite hasn't moved since its starting count.
    expect(c8003.before).toEqual([{ item_id: MAT, location_id: OFALLON, quantity: '5', value: '150.00' }]);

    // FleetSuite booked the rack back to O'Fallon, NetSuite put it back at Wentzville: each side's place is counted.
    expect(c8004.own).toMatchObject({ location_id: OFALLON, invoice_id: '6002' });
    expect(c8004.before).toEqual([
      { item_id: LADDER, location_id: OFALLON, quantity: '5', value: '700.00' },
      { item_id: LADDER, location_id: WENTZVILLE, quantity: '0', value: '0' },
    ]);

    // Nothing back on the shelf, and NetSuite's credit memo moved no stock, so the copy of its stock moves hasn't it.
    expect(c8005.own.lines).toEqual([]);
    expect(c8005).toMatchObject({ netsuite: null, netsuite_gl: null, before: [] });

    // The items either side names, a kit with its parts.
    expect(res.items).toEqual({
      [LADDER]: { number: 'LDR-24', type: 'InvtPart', display_name: 'Ladder rack 24 in', parts: null },
      [BINS]: { number: 'BIN-10', type: 'InvtPart', display_name: null, parts: null },
      [RACK_KIT]: { number: 'KIT-RACK', type: 'Kit', display_name: 'Rack and bins', parts: [{ item: LADDER, quantity: 1 }, { item: BINS, quantity: 2 }] },
      [MAT]: { number: 'MAT-5', type: 'InvtPart', display_name: 'Floor mat', parts: null },
    });
    expect(res.locations).toEqual({ [OFALLON]: "O'Fallon", [WENTZVILLE]: 'Wentzville' });
    expect(Object.keys(res.accounts).sort()).toEqual([RECEIVABLE, INVENTORY, SALES, INSTALLS, CREDITS, COGS, RACK_COGS].sort());
  });

  it('gives one credit memo by its id, and the first and last days of the dates asked for', async () => {
    expect((await pairs(null, null, '8002')).credit_memos.map((c) => c.own.netsuite_id)).toEqual(['8002']);
    expect((await pairs(null, null, '9999')).credit_memos).toEqual([]);
    expect((await pairs('2025-01-01', '2025-01-31')).credit_memos).toEqual([]);
    expect((await pairs('2025-02-21', '2025-02-24')).credit_memos.map((c) => c.own.netsuite_id)).toEqual(['8003', '8002']);
    expect((await pairs('2025-03-01', '2025-03-31')).credit_memos.map((c) => c.own.netsuite_id)).toEqual(['8006']);
    // Not yet in NetSuite's copies.
    expect((await pairs(null, null, '8006')).credit_memos[0]).toMatchObject({ netsuite: null, netsuite_gl: null });
  });

  it("counts nothing where the parts come back when it isn't told where that is", async () => {
    const [c8001] = (await pairs(null, null, '8001', null)).credit_memos;
    expect(c8001.own.location_id).toBeNull();
    // NetSuite's place alone.
    expect(c8001.before).toEqual([{ item_id: LADDER, location_id: OFALLON, quantity: '3', value: '420.00' }]);
    const [c8002] = (await pairs(null, null, '8002', null)).credit_memos;
    expect(c8002.before.map((b) => b.item_id)).toEqual([LADDER, BINS]);
  });

  it("leaves out a line that puts back none of an item, doesn't say how many, isn't an item NetSuite may keep in stock, or stays with the customer", async () => {
    const base = creditCopy('8007', '2025-03-04', RACKS_INVOICE, [{ line: 1, quantity: 1, price: 250 }]);
    const line = base.lines[0];
    const odd = {
      ...base,
      subtotal: '60.00', tax: '0.00', total: '60.00',
      lines: [
        { ...line, line_no: 1, quantity: 0, amount: '10.00' },
        { ...line, line_no: 2, quantity: null, amount: '10.00' },
        { ...line, line_no: 3, item_netsuite_id: INSTALL, item_number: 'INSTALL', amount: '10.00' },
        { ...line, line_no: 4, item_netsuite_id: '-7', item_number: 'ODD', amount: '10.00' },
        { ...line, line_no: 5, item_netsuite_id: SHELF, item_number: 'SHELF-3', amount: '10.00' },
        // Credited without going back on the shelf: the invoice billed it as a part NetSuite doesn't keep in stock.
        { ...line, line_no: 6, item_netsuite_id: SHELF, item_number: 'SHELF-3', amount: '10.00', back_to_stock: false },
      ],
    };
    expect(await call(pg, 'gl_own_credit_memo_save', odd)).toMatchObject({ saved: true });
    try {
      // An item the copy of NetSuite's items doesn't have may be kept in stock.
      expect((await pairs(null, null, '8007')).credit_memos[0].own.lines).toEqual([
        { line_no: 5, item_id: SHELF, item_number: 'SHELF-3', description: null, item_type: null, quantity: '1.0000' },
      ]);
    } finally {
      await pg.query("DELETE FROM gl_own_credit_memos WHERE netsuite_id = '8007'");
    }
  });

  it("gives an item NetSuite doesn't keep in stock no value just before, as Stock by item doesn't", async () => {
    // NetSuite's starting count has two shelves at O'Fallon, worth $60, and the copy of its items doesn't have them.
    const shelves = invoice('6003', '2024-12-09', OFALLON, [[1, SHELF, 'SHELF-3', 'InvtPart', 2, 45]]);
    expect(await call(pg, 'gl_own_credit_memo_save', creditCopy('8008', '2025-03-04', shelves, [{ line: 1, quantity: 1, price: 45 }])))
      .toMatchObject({ saved: true });
    await pg.query(
      `INSERT INTO gl_netsuite_stock_opening (company_id, item_id, location_id, quantity, value)
       SELECT id, $1, $2, 2, 60 FROM gl_companies WHERE code = 'BMG'`,
      [SHELF, OFALLON],
    );
    try {
      expect((await pairs(null, null, '8008')).credit_memos[0].before)
        .toEqual([{ item_id: SHELF, location_id: OFALLON, quantity: '2', value: '0' }]);
    } finally {
      await pg.query('DELETE FROM gl_netsuite_stock_opening WHERE item_id = $1', [SHELF]);
      await pg.query("DELETE FROM gl_own_credit_memos WHERE netsuite_id = '8008'");
    }
  });

  it("takes apart kits inside kits where the copy puts them back, before NetSuite's copies have the credit memo", async () => {
    const insert = (id: string, name: string, details: unknown) => pg.query(
      'INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ($1, $2, $3, true, $4::jsonb)',
      ['item', id, name, JSON.stringify(details)],
    );
    await insert('9101', 'KIT-OUTER', { item_type: 'Kit', parts: [{ item: RACK_KIT, quantity: 2 }, { item: '9102', quantity: 1 }] });
    await insert('9102', 'KIT-ODD', { item_type: 'Kit', parts: 'not a list' });
    try {
      const outer = invoice('7003', '2025-02-14', OFALLON, [[1, '9101', 'KIT-OUTER', 'Kit', 1, 900]]);
      expect(await call(pg, 'gl_own_credit_memo_save', creditCopy('8009', '2025-03-05', outer, [{ line: 1, quantity: 1, price: 900 }])))
        .toMatchObject({ saved: true });
      const res = await pairs(null, null, '8009');
      expect(Object.keys(res.items).sort()).toEqual([LADDER, BINS, RACK_KIT, '9101', '9102'].sort());
      expect(res.items['9102'].parts).toBe('not a list');
      // Every part, a kit's inside a kit's too, counted at O'Fallon: five racks there worth $700, eighteen bins worth $360.
      expect(res.credit_memos[0]).toMatchObject({ netsuite: null, netsuite_gl: null });
      expect(res.credit_memos[0].before).toEqual([
        { item_id: LADDER, location_id: OFALLON, quantity: '5', value: '700.00' },
        { item_id: BINS, location_id: OFALLON, quantity: '18', value: '360.00' },
        { item_id: RACK_KIT, location_id: OFALLON, quantity: '0', value: '0' },
        { item_id: '9101', location_id: OFALLON, quantity: '0', value: '0' },
        { item_id: '9102', location_id: OFALLON, quantity: '0', value: '0' },
      ]);
    } finally {
      await pg.query("DELETE FROM gl_own_credit_memos WHERE netsuite_id = '8009'");
      await pg.query("DELETE FROM gl_netsuite_lists WHERE kind = 'item' AND netsuite_id IN ('9101', '9102')");
    }
  });

  it("names an item NetSuite's credit memo puts back that the copy doesn't, and counts it where NetSuite puts it", async () => {
    // NetSuite's credit memo was changed to put back a mat, not the rack FleetSuite credited.
    expect(await call(pg, 'gl_netsuite_stock_apply', {
      documents: [stockDoc('8006', 'CustCred', 'CM8006', '2025-03-03', [['1', MAT, OFALLON, '1', true]])],
    })).toMatchObject({ added: 1 });
    try {
      const res = await pairs(null, null, '8006');
      expect(Object.keys(res.items).sort()).toEqual([LADDER, MAT].sort());
      expect(res.credit_memos[0].before).toEqual([
        { item_id: LADDER, location_id: OFALLON, quantity: '5', value: '700.00' },
        { item_id: MAT, location_id: OFALLON, quantity: '6', value: '180.00' },
      ]);
    } finally {
      await pg.query("DELETE FROM gl_netsuite_stock_lines WHERE document_id = '8006'");
      await pg.query("DELETE FROM gl_netsuite_stock_documents WHERE netsuite_id = '8006'");
    }
  });

  it("names the customer as FleetSuite's own record does, or else as the copy of NetSuite's customers does", async () => {
    await pg.query("UPDATE gl_netsuite_lists SET name = 'Acme Fleet Services LLC' WHERE kind = 'customer' AND netsuite_id = '7700'");
    try {
      expect((await pairs(null, null, '8001')).credit_memos[0].customer_name).toBe('Acme Fleet');
      await pg.query('UPDATE customers SET company_name = $1 WHERE id = $2', ['  ', ACME]);
      expect((await pairs(null, null, '8001')).credit_memos[0].customer_name).toBe('Acme Fleet Services LLC');
    } finally {
      await pg.query('UPDATE customers SET company_name = $1 WHERE id = $2', ['Acme Fleet', ACME]);
      await pg.query("UPDATE gl_netsuite_lists SET name = 'Acme Fleet' WHERE kind = 'customer' AND netsuite_id = '7700'");
    }
  });

  it("gives NetSuite's lines of the credit memo's own company alone", async () => {
    const doc = stockDoc('8003', 'CustCred', 'CM8003', '2025-02-24', [['1', MAT, OFALLON, '1', true], ['2', MAT, OFALLON, '1', true]]);
    doc.lines[1].company = '1084';
    expect(await call(pg, 'gl_netsuite_stock_apply', { documents: [doc] })).toMatchObject({ changed: 1 });
    try {
      expect((await pairs(null, null, '8003')).credit_memos[0].netsuite).toEqual({
        number: 'CM8003', type: 'CustCred', date: '2025-02-24', gone: false,
        lines: [{ line_id: '1', item_id: MAT, location_id: OFALLON, quantity: '1', moves_stock: true, value: null }],
      });
    } finally {
      expect(await call(pg, 'gl_netsuite_stock_apply', { documents: [CM8003] })).toMatchObject({ changed: 1 });
    }
  });

  const accounts = (company: string, items: Record<string, string[]>) =>
    one<Record<string, unknown>>(pg, 'SELECT gl_own_credit_cost_accounts($1, $2::jsonb) AS r', [company, JSON.stringify(items)]);

  it("gl_own_credit_cost_accounts learns each item's cost account from NetSuite's last fulfillment, invoice or credit memo of it before", async () => {
    expect(await accounts('BMG', { 8001: [LADDER], 8002: [LADDER, BINS], 8003: [MAT] })).toEqual({
      items: { [LADDER]: INVENTORY, [BINS]: INVENTORY, [MAT]: INVENTORY },
      credits: {
        // The rack's cost comes out of where NetSuite's invoice of the kits before it put theirs.
        8001: { [LADDER]: { cost: RACK_COGS, from: { netsuite_id: '7002', number: 'INV7002', date: '2025-02-12', type: 'CustInvc' }, netsuite: RACK_COGS } },
        8002: {
          // Then out of where NetSuite's credit memo of a rack took it back out of.
          [LADDER]: { cost: RACK_COGS, from: { netsuite_id: '8001', number: 'CM8001', date: '2025-02-20', type: 'CustCred' }, netsuite: RACK_COGS },
          [BINS]: { cost: COGS, from: { netsuite_id: '7002', number: 'INV7002', date: '2025-02-12', type: 'CustInvc' }, netsuite: COGS },
        },
        // NetSuite hadn't shipped, sold or credited mats before.
        8003: { [MAT]: { cost: null, from: null, netsuite: COGS } },
      },
      usual_cost: RACK_COGS,
    });
    // A credit memo dated before NetSuite's invoices learns from its fulfillment; one NetSuite's copies don't have yet
    // has no account of its own.
    await pg.query("UPDATE gl_own_credit_memos SET credit_date = '2025-02-01' WHERE netsuite_id = '8006'");
    try {
      expect(await accounts('BMG', { 8006: [LADDER] })).toEqual({
        items: { [LADDER]: INVENTORY },
        credits: { 8006: { [LADDER]: { cost: RACK_COGS, from: { netsuite_id: '5002', number: 'IF5002', date: '2025-01-20', type: 'ItemShip' }, netsuite: null } } },
        usual_cost: RACK_COGS,
      });
    } finally {
      await pg.query("UPDATE gl_own_credit_memos SET credit_date = '2025-03-03' WHERE netsuite_id = '8006'");
    }
    // Nothing asked about, or not a list: nothing named, no usual account.
    expect(await accounts('BMG', {})).toEqual({ items: {}, credits: {}, usual_cost: null });
    expect(await one(pg, 'SELECT gl_own_credit_cost_accounts($1, $2::jsonb) AS r', ['BMG', '[]'])).toEqual({ items: {}, credits: {}, usual_cost: null });
    expect(await accounts('BMG', { 8001: ['x', LADDER] })).toMatchObject({ items: { [LADDER]: INVENTORY } });
    // A credit memo FleetSuite has no copy of, or another company's, isn't asked about.
    expect(await accounts('BMG', { 9999: [LADDER] })).toEqual({ items: {}, credits: {}, usual_cost: null });
    expect(await accounts('1084', { 8001: [LADDER] })).toEqual({ items: {}, credits: {}, usual_cost: null });
  });

  it("names no asset account for an item the copy of NetSuite's items gives one that isn't NetSuite's id of an account", async () => {
    const setAsset = (value: string) => pg.query(
      `UPDATE gl_netsuite_lists SET details = details || jsonb_build_object('asset_account', $2::text) WHERE kind = 'item' AND netsuite_id = $1`,
      [MAT, value],
    );
    await setAsset('Inventory Asset');
    try {
      expect(await accounts('BMG', { 8003: [MAT] })).toMatchObject({ items: { [MAT]: null } });
    } finally {
      await setAsset(INVENTORY);
    }
    expect(await accounts('BMG', { 8003: [MAT] })).toMatchObject({ items: { [MAT]: INVENTORY } });
  });

  it('learns nothing from a credit memo NetSuite deleted, and counts nothing it put back', async () => {
    expect(await accounts('BMG', { 8004: [LADDER] })).toMatchObject({
      credits: { 8004: { [LADDER]: { cost: RACK_COGS, from: { netsuite_id: '8002', number: 'CM8002', date: '2025-02-21', type: 'CustCred' } } } },
    });
    expect(await call(pg, 'gl_netsuite_stock_finish', { netsuite_ids: ['5002', '7001', '7002', '8001', '8003', '8004'] })).toMatchObject({ gone: 1 });
    try {
      expect(await accounts('BMG', { 8004: [LADDER] })).toMatchObject({
        credits: { 8004: { [LADDER]: { cost: RACK_COGS, from: { netsuite_id: '8001', number: 'CM8001', date: '2025-02-20', type: 'CustCred' } } } },
      });
      // The rack and bins the deleted credit memo put back aren't counted before the next one, nor their $180.
      expect((await pairs(null, null, '8004')).credit_memos[0].before)
        .toContainEqual({ item_id: LADDER, location_id: OFALLON, quantity: '4', value: '560.00' });
      expect((await pairs(null, null, '8002')).credit_memos[0].netsuite).toMatchObject({ gone: true });
    } finally {
      expect(await call(pg, 'gl_netsuite_stock_apply', { documents: [CM8002] })).toMatchObject({ changed: 1 });
    }
    expect((await pairs(null, null, '8002')).credit_memos[0].netsuite).toMatchObject({ gone: false });
  });

  it("gl_stock_documents gives a credit memo's cost lines alone, as gl_stock_month does", async () => {
    const res = await one<{ documents: Array<{ netsuite_id: string; type: string; lines: Array<{ line_id: string; account: string; debit: string; credit: string }> }> }>(
      pg, 'SELECT gl_stock_documents($1, $2::text[]) AS r', ['BMG', textArray(['8002'])],
    );
    expect(res.documents.map((d) => [d.netsuite_id, d.type])).toEqual([['8002', 'CustCred']]);
    expect(res.documents[0].lines.map((l) => [l.line_id, l.account, l.debit, l.credit])).toEqual([
      ['4', RACK_COGS, '0.00', '140.00'], ['5', INVENTORY, '140.00', '0.00'], ['6', COGS, '0.00', '40.00'], ['7', INVENTORY, '40.00', '0.00'],
    ]);
  });

  it("is the service role's alone, and neither new read writes anything", async () => {
    await pg.exec('RESET ROLE');
    for (const fn of ['public.gl_own_credit_cost_pairs(date, date, text, text)', 'public.gl_own_credit_cost_accounts(text, jsonb)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>(pg, `SELECT has_function_privilege($1::name, '${fn}', 'EXECUTE') AS r`, [role]), `${fn} ${role}`)
          .toBe(role === 'service_role');
      }
    }
    for (const name of ['gl_own_credit_cost_pairs', 'gl_own_credit_cost_accounts']) {
      const body = await one<string>(pg, 'SELECT prosrc AS r FROM pg_proc WHERE proname = $1', [name]);
      expect(body, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    }
    await pg.exec('SET ROLE service_role');
  });
});

// ── The posting job ────────────────────────────────────────────────────────

describe('the posting job, with the stock Books\' own credit memos put back', () => {
  let pg: PGlite;
  const clock = Date.parse('2025-03-20T12:00:00Z');
  const store = new Map<string, any>();
  /** Reads made to fail: a function by its name, and sync_state by its key. */
  const failing = new Set<string>();

  // sync_state in memory; gl_accounts, gl_companies, gl_periods and every function the real ones, called the way
  // supabase-js calls them.
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

  // A credit memo's lines aren't asked of NetSuite here, so the credit doesn't post: its cost lines do, from the copies alone.
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
  /** The entry that stands for a document, by its key's start ('invoice_cost:8001'). */
  const standing = async (key: string) => (await journal()).filter((e) => e.key?.startsWith(`${key}:`)).at(-1)!;
  /** What one credit memo put back, checked as the Own credit memos page checks it. */
  const checked = async (id: string) => checkOwnCreditCosts(
    await one<CreditCostPairsData>(pg, 'SELECT gl_own_credit_cost_pairs(NULL, NULL, $1, $2) AS r', [id, STOCK_LOCATION_ID]),
    { stock: null, ledger: null },
  ).creditMemos[0];
  /** One credit memo's page on Own credit memos. */
  const page = async (id: string) => {
    const res = await GET_CREDIT_MEMO(new NextRequest(`https://go.bmgfleet.com/api/admin/books/own-credit-memos?id=${id}`));
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    await copyNetSuite(pg);
    h.service = service();
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it("posts NetSuite's cost lines while Books has no copies of the credit memos", async () => {
    const r = await run();
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ posted: 7, replaced: 0, reversed: 0, failedCount: 0 });
    expect((await journal()).map((e) => [e.key, e.rule, e.date])).toEqual([
      ['item_fulfillment:5002:1', 'stock@1', '2025-01-20'],
      ['invoice_cost:7001:1', 'stock@1', '2025-02-10'],
      ['invoice_cost:7002:1', 'stock@1', '2025-02-12'],
      ['invoice_cost:8001:1', 'stock@1', '2025-02-20'],
      ['invoice_cost:8002:1', 'stock@1', '2025-02-21'],
      ['invoice_cost:8003:1', 'stock@1', '2025-02-24'],
      ['invoice_cost:8004:1', 'stock@1', '2025-02-26'],
    ]);
  });

  it("replaces NetSuite's cost lines with the copy's where what it put back matches and its entry is the same, and nothing in the books moves", async () => {
    await saveOwnCopies(pg);
    const before = await balances();
    const r = await run();
    expect(r.error).toBeUndefined();
    // The mat matches, but the copy takes its cost out of another account, so NetSuite's stands; NetSuite put the last
    // rack back at Wentzville.
    expect(r).toMatchObject({ posted: 0, replaced: 2, reversed: 0, unchanged: 5, failedCount: 0 });
    expect((await journal()).slice(7).map((e) => [e.no, e.key, e.reverses, e.memo, e.rule])).toEqual([
      [8, null, 4, "CM8001 now posts from FleetSuite's own copy", 'reversal'],
      [9, 'invoice_cost:8001:2', null, 'CM8001', 'own_credit_memo_cost@1'],
      [10, null, 5, "CM8002 now posts from FleetSuite's own copy", 'reversal'],
      [11, 'invoice_cost:8002:2', null, 'CM8002', 'own_credit_memo_cost@1'],
    ]);
    expect(await balances()).toEqual(before);
    // The rack back onto its asset account, out of the cost account NetSuite's invoice of it before used.
    expect(await linesOf(9)).toEqual([
      { account: INVENTORY, debit: '140.00', credit: '0.00', memo: 'Acme Fleet · LDR-24', source_line_ref: `own:${LADDER}:asset` },
      { account: RACK_COGS, debit: '0.00', credit: '140.00', memo: 'Acme Fleet · LDR-24', source_line_ref: `own:${LADDER}:cost` },
    ]);
    // The kit's parts, each out of its own cost account.
    expect(await linesOf(11)).toEqual([
      { account: INVENTORY, debit: '140.00', credit: '0.00', memo: 'Acme Fleet · LDR-24', source_line_ref: `own:${LADDER}:asset` },
      { account: RACK_COGS, debit: '0.00', credit: '140.00', memo: 'Acme Fleet · LDR-24', source_line_ref: `own:${LADDER}:cost` },
      { account: INVENTORY, debit: '40.00', credit: '0.00', memo: 'Acme Fleet · BIN-10', source_line_ref: `own:${BINS}:asset` },
      { account: COGS, debit: '0.00', credit: '40.00', memo: 'Acme Fleet · BIN-10', source_line_ref: `own:${BINS}:cost` },
    ]);
  });

  it('changes nothing the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 7, failedCount: 0 });
    expect(await journal()).toEqual(before);
  });

  it("says which copy made each cost entry, and on the credit memo's page the copy's entry next to NetSuite's", async () => {
    const books = await readOwnBooks(service(), CREDIT_COST_BOOKS, ['8001', '8002', '8003', '8004'].map((netsuiteId) => ({ company: 'BMG', netsuiteId })));
    expect(Object.fromEntries(books)).toEqual({
      8001: { entryNo: 9, date: '2025-02-20', from: 'fleetsuite' },
      8002: { entryNo: 11, date: '2025-02-21', from: 'fleetsuite' },
      8003: { entryNo: 6, date: '2025-02-24', from: 'netsuite' },
      8004: { entryNo: 7, date: '2025-02-26', from: 'netsuite' },
    });

    expect(await readOwnStockView(service(), { kind: 'credit_cost', check: await checked('8001') })).toEqual({
      books: { entryNo: 9, date: '2025-02-20', from: 'fleetsuite' },
      month: FEB,
      posts: true,
      why: null,
      entry: [
        { account: '19000 Inventory Asset', fleetsuite: 14000, netsuite: 14000, same: true },
        { account: '58500 Cost of Goods Sold - Racks', fleetsuite: -14000, netsuite: -14000, same: true },
      ],
      differs: null,
      learned: [],
      costs: "Each item's cost goes back onto its asset account and comes out of the cost account NetSuite's last fulfillment, "
        + 'invoice or credit memo of it used: 58500 Cost of Goods Sold - Racks for it.',
    });
    const differs = "FleetSuite hadn't seen MAT-5 shipped, sold or credited before, so it took its $30.00 back out of "
      + '58500 Cost of Goods Sold - Racks, where most fulfillments put theirs, and NetSuite took it out of 58000 Cost of Goods Sold';
    expect(await readOwnStockView(service(), { kind: 'credit_cost', check: await checked('8003') })).toEqual({
      books: { entryNo: 6, date: '2025-02-24', from: 'netsuite' },
      month: FEB,
      posts: false,
      why: `FleetSuite's own copy matches NetSuite's credit memo, but its entry doesn't match NetSuite's, so the books post NetSuite's: ${differs}.`,
      entry: [
        { account: '19000 Inventory Asset', fleetsuite: 3000, netsuite: 3000, same: true },
        { account: '58500 Cost of Goods Sold - Racks', fleetsuite: -3000, netsuite: null, same: false },
        { account: '58000 Cost of Goods Sold', fleetsuite: null, netsuite: -3000, same: false },
      ],
      differs,
      learned: ["From now on FleetSuite's own credit memos take MAT-5's cost out of 58000, as NetSuite did here."],
      costs: "FleetSuite hadn't seen MAT-5 shipped, sold or credited before, so its cost comes out of 58500 Cost of Goods Sold - Racks, "
        + 'where most fulfillments put theirs.',
    });
    // NetSuite put the rack back at Wentzville, so the copy differs and has no entry to put next to NetSuite's.
    const elsewhere = await checked('8004');
    expect(elsewhere.status).toBe('differs');
    expect(await readOwnStockView(service(), { kind: 'credit_cost', check: elsewhere })).toMatchObject({
      books: { entryNo: 7, date: '2025-02-26', from: 'netsuite' }, month: FEB, posts: false, entry: null,
    });
  });

  it('shows on a credit memo\'s page what it put back, and nothing for one that put nothing back', async () => {
    const rack = await page('8001');
    expect(rack.status).toBe(200);
    expect(rack.body.creditMemo.costError).toBeUndefined();
    expect(rack.body.creditMemo.cost.check).toMatchObject({
      netsuiteId: '8001', number: 'CM8001', invoice: 'INV7001', status: 'matches', locationId: OFALLON, fleetsuiteCost: 14000, netsuiteCost: 14000,
    });
    expect(rack.body.creditMemo.cost.posting).toMatchObject({ books: { entryNo: 9, from: 'fleetsuite' }, posts: true });
    // The install and a rack the customer keeps: nothing back, and NetSuite's credit memo moved no stock either.
    const kept = await page('8005');
    expect(kept.status).toBe(200);
    expect(kept.body.creditMemo).toMatchObject({ netsuiteId: '8005', cost: null });
    // A read of what it put back that fails leaves the rest of the page.
    for (const read of ['gl_own_credit_cost_pairs', 'gl_own_credit_cost_accounts', BOOKS_STOCK_SYNC, BOOKS_GL_SYNC]) {
      failing.add(read);
      try {
        const failed = await page('8001');
        expect(failed.status, read).toBe(200);
        expect(failed.body.creditMemo, read).toMatchObject({ netsuiteId: '8001', number: 'CM8001', costError: `${read} failed` });
        expect(failed.body.creditMemo.cost, read).toBeUndefined();
      } finally {
        failing.delete(read);
      }
    }
  });

  it("stops the run, saying what it was reading, when the copies or their months can't be read", async () => {
    const before = await journal();
    for (const [read, error] of [
      ['gl_own_credit_memo_months', "Reading the months of Books' own credit memos: gl_own_credit_memo_months failed"],
      ['gl_own_credit_cost_pairs', "Reading Books' own copies of BMG's fulfillments, receipts, adjustments, invoices and credit memos for Feb 2025: gl_own_credit_cost_pairs failed"],
      ['gl_own_credit_cost_accounts', "Reading Books' own copies of BMG's fulfillments, receipts, adjustments, invoices and credit memos for Feb 2025: gl_own_credit_cost_accounts failed"],
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
    // NetSuite values the kit's bins at $18 each.
    await gl(pg, '8002', 'CustCred', 'CM8002', '2025-02-21', [
      ['0', RECEIVABLE, -40000], ['1', SALES, 40000],
      ['4', RACK_COGS, -14000], ['5', INVENTORY, 14000], ['6', COGS, -3600], ['7', INVENTORY, 3600],
    ]);
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, reversed: 0, unchanged: 6, failedCount: 0 });
    expect((await journal()).slice(11).map((e) => [e.no, e.key, e.reverses, e.memo, e.rule])).toEqual([
      [12, null, 11, "CM8002 now posts from NetSuite's credit memo", 'reversal'],
      [13, 'invoice_cost:8002:3', null, 'CM8002', 'stock@1'],
    ]);
    expect((await standing('invoice_cost:8002')).rule).toBe('stock@1');
    expect((await standing('invoice_cost:8001')).rule).toBe('own_credit_memo_cost@1');
    const page8002 = (await page('8002')).body.creditMemo.cost;
    expect(page8002.check).toMatchObject({ status: 'differs', fleetsuiteCost: 18000, netsuiteCost: 17600 });
    expect(page8002.posting).toMatchObject({ books: { entryNo: 13, from: 'netsuite' }, posts: false });
  });

  it("says on a credit memo's page what's still to come of NetSuite's side, from how far the copies of NetSuite had come", async () => {
    // A rack back that the copies of NetSuite haven't reached.
    const cost = async (id: string) => (await page(id)).body.creditMemo.cost.check;
    const was = new Map([BOOKS_STOCK_SYNC, BOOKS_GL_SYNC].map((k) => [k, store.get(k)]));
    const copied = (key: string, hours: number) =>
      store.set(key, { ...store.get(key), last_synced_at: new Date(Date.now() + hours * 3_600_000).toISOString() });
    try {
      copied(BOOKS_STOCK_SYNC, -1);
      copied(BOOKS_GL_SYNC, -1);
      expect(await cost('8006')).toMatchObject({
        status: 'waiting', summary: "Waiting for NetSuite's credit memo: the copy of NetSuite's stock moves runs every two hours.",
      });
      // The copy of NetSuite's stock moves ran since without it: NetSuite's put nothing back.
      copied(BOOKS_STOCK_SYNC, 1);
      const none = await cost('8006');
      expect(none.status).toBe('differs');
      expect(none.fields.find((f: { field: string }) => f.field === 'items')).toMatchObject({ same: false });
    } finally {
      for (const [key, row] of was) {
        if (row === undefined) store.delete(key);
        else store.set(key, row);
      }
    }
  });
});
