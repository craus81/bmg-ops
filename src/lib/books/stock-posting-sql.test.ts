// Migration 395 reads one company's NetSuite stock documents for a month
// from the copy of NetSuite's GL (an invoice's or credit memo's cost lines
// only), and what the journal holds for them, which migration 397 reads with
// one read of the copy's cost lines; the posting job posts them with the
// stock rule. This runs migration 314 (with stand-ins for the app tables it
// points at) and migrations 359–364, 367, 370, 374, 376, 377, 380, 382–387,
// 389–395, 397 and 399 in an in-memory Postgres (PGlite) as the app's server
// login and holds the functions' rules, then runs the posting job against
// them with stock documents only.
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
  recordHeartbeat: vi.fn(async (service: any, syncType: string, lastResult: unknown, opts?: { touchLastSyncedAt?: boolean }) => {
    await service.from('sync_state').upsert({ sync_type: syncType, last_result: lastResult, synced: opts?.touchLastSyncedAt !== false });
    return { ok: true };
  }),
}));

import { BOOKS_INVOICE_POSTING, postInvoices, type StockPosting } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { NETSUITE_TYPE } from './differences';
import { STOCK_SOURCE_TYPE } from './stock-rule';
import type { StockMonthData } from './stock-check';

/**
 * Made-up chart: '120' receivables, '130' BMG's inventory, '131' its
 * assemblies, '135' inventory only 1084 may use, '205' stock received but not
 * billed, '220' sales tax, '400' sales, '500' cost of goods sold, '510'
 * another cost of goods sold account one item sells to, '520' inventory
 * adjustments, '521' an adjustments account no longer used.
 */
const ACCOUNTS: Array<[string, string, string, string, 'BMG' | '1084' | null, boolean]> = [
  ['120', '1200', 'Receivables', 'accounts_receivable', 'BMG', true],
  ['130', '1300', 'Inventory', 'other_current_asset', 'BMG', true],
  ['131', '1310', 'Assemblies', 'other_current_asset', 'BMG', true],
  ['135', '1350', 'Inventory 1084', 'other_current_asset', '1084', true],
  ['205', '2050', 'Received Not Billed', 'other_current_liability', 'BMG', true],
  ['220', '2200', 'Sales Tax', 'other_current_liability', null, true],
  ['400', '4000', 'Sales', 'income', null, true],
  ['500', '5000', 'Cost of Goods Sold', 'cost_of_goods_sold', null, true],
  ['510', '5100', 'Odd Sales', 'cost_of_goods_sold', null, true],
  ['520', '5200', 'Inventory Adjustments', 'cost_of_goods_sold', 'BMG', true],
  ['521', '5210', 'Old Adjustments', 'cost_of_goods_sold', 'BMG', false],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';
// Every kind the stock rule posts, an invoice's and a credit memo's cost lines among them, as Differences asks for them.
const STOCK_KINDS = Object.fromEntries([...new Set(Object.values(STOCK_SOURCE_TYPE))].map((t) => [t, NETSUITE_TYPE[t]]));

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
    -- What migration 314 points at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY);
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
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'`);
  for (const [ns, number, name, type, company, active] of ACCOUNTS) {
    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active)
       VALUES ($1, $2, $3, $4, $5, (SELECT id FROM gl_companies WHERE code = $6), $7)`,
      [accountId(ns), number, name, type, ns, company, active],
    );
  }
  // A vendor, as the lists copy has it; item 501 sells to Sales and keeps its stock in Inventory, item 502 sells to a cost of
  // goods sold account; and an item with NetSuite id 59.
  await pg.query(`INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES ('vendor', '50', 'Sample Supply Co', true)`);
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('item', '501', 'WIDGET', true, '{"income_account": "400", "asset_account": "130"}'),
      ('item', '502', 'ODDITY', true, '{"income_account": "510"}'),
      ('item', '59', 'SOME-ITEM', true, '{}');
  `);
  // The ledger mirror's customers: NetSuite's 310 matched to a FleetSuite customer by its NetSuite id, 311 by its name alone.
  await pg.exec(`
    INSERT INTO public.customers (id) VALUES ('${CUSTOMER}');
    INSERT INTO ledger_customers (source, external_id, external_ref, display_name, cleaned_name, customer_id, match_status) VALUES
      ('netsuite', 'customer/310', '310', 'A Customer', 'A Customer', '${CUSTOMER}', 'exact'),
      ('netsuite', 'customer/311', '311', 'Another Customer', 'Another Customer', '${CUSTOMER}', 'cleaned');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

/** A Postgres text[] literal, as PostgREST sends a list. */
const textArray = (items: string[]) => `{${items.map((s) => `"${s.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

// ── NetSuite's stock documents, as the copy of its GL has them ─────────────

type Company = 'BMG' | '1084';
/** A line in the copy of NetSuite's GL: [line id, company, account, cents debit positive, memo, NetSuite id of its name]. */
type NsLine = [string, Company, string, number, (string | null)?, (string | null)?];

interface NsDocument {
  ref: string;
  /** NetSuite's transaction type: a stock document's, an invoice's or credit memo's, or another to show it isn't read. */
  type: string;
  number: string | null;
  date: string;
  /** The month NetSuite booked it into; its own unless said. */
  booked?: string;
  lines: NsLine[];
  /** NetSuite no longer has it. */
  gone?: boolean;
}

const money = (c: number) => (c / 100).toFixed(2);

/** Copies a document as the copy of NetSuite's GL (migration 361) would, its lines replaced whole. */
async function copy(pg: PGlite, d: NsDocument) {
  await pg.query('DELETE FROM gl_netsuite_lines WHERE transaction_id = $1', [d.ref]);
  await pg.query('DELETE FROM gl_netsuite_transactions WHERE netsuite_id = $1', [d.ref]);
  if (d.gone) return;
  const month = d.booked ?? `${d.date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [d.ref, d.type, d.number, d.date, month],
  );
  for (const [line, company, account, c, memo, entity] of d.lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, memo, entity_id)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8, $9 FROM gl_companies WHERE code = $10`,
      [d.ref, line, account, month, d.date, money(Math.max(c, 0)), money(Math.max(-c, 0)), memo ?? null, entity ?? null, company],
    );
  }
}

// ── The functions ──────────────────────────────────────────────────────────

describe('migration 395\'s functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // A part shipped to a customer, its lines out of order in the copy.
    await copy(db, {
      ref: '8101', type: 'ItemShip', number: 'IF0301', date: '2025-03-05',
      lines: [['10', 'BMG', '130', -4000, 'WIDGET', '310'], ['2', 'BMG', '500', 4000, 'WIDGET', '310']],
    });
    // Parts received from a vendor, and a name the vendors copy doesn't have, though an item has the same NetSuite id.
    await copy(db, {
      ref: '8102', type: 'ItemRcpt', number: 'IR0302', date: '2025-03-06',
      lines: [['1', 'BMG', '130', 10000, 'PO311'], ['2', 'BMG', '205', -9000, null, '50'], ['3', 'BMG', '205', -1000, null, '59']],
    });
    await copy(db, { ref: '8103', type: 'InvAdjst', number: 'ADJ0303', date: '2025-03-07', lines: [['1', 'BMG', '520', 1500, 'Count'], ['2', 'BMG', '130', -1500, 'Count']] });
    // Stock moved between bays, with lines for both companies.
    await copy(db, {
      ref: '8104', type: 'InvTrnfr', number: 'TO0304', date: '2025-03-08',
      lines: [['1', 'BMG', '130', 2000], ['2', 'BMG', '130', -2000], ['3', '1084', '135', 500], ['4', '1084', '135', -500]],
    });
    await copy(db, { ref: '8105', type: 'Build', number: 'AB0305', date: '2025-03-09', lines: [['1', 'BMG', '131', 6000], ['2', 'BMG', '130', -6000]] });
    await copy(db, { ref: '8106', type: 'Unbuild', number: 'AU0306', date: '2025-03-09', lines: [['1', 'BMG', '130', 6000], ['2', 'BMG', '131', -6000]] });
    // An invoice that wasn't fulfilled first, which books the cost of the part it sold, and a credit memo bringing one back from
    // a customer the ledger mirror matched by its name alone.
    await copy(db, {
      ref: '8107', type: 'CustInvc', number: 'INV0307', date: '2025-03-10',
      lines: [
        ['0', 'BMG', '120', 10700, null, '310'], ['1', 'BMG', '400', -10000, 'WIDGET', '310'], ['2', 'BMG', '220', -700],
        ['3', 'BMG', '500', 4000, null, '310'], ['4', 'BMG', '130', -4000, null, '310'],
      ],
    });
    await copy(db, {
      ref: '8108', type: 'CustCred', number: 'CM0308', date: '2025-03-11',
      lines: [
        ['0', 'BMG', '120', -5000, null, '311'], ['1', 'BMG', '400', 5000], ['2', 'BMG', '130', 2000, null, '311'],
        ['3', 'BMG', '500', -2000, null, '311'],
      ],
    });
    // An invoice that books no cost, and one that sells item 502 to a cost of goods sold account, which is a sale.
    await copy(db, { ref: '8109', type: 'CustInvc', number: 'INV0309', date: '2025-03-12', lines: [['0', 'BMG', '120', 3000], ['1', 'BMG', '400', -3000]] });
    await copy(db, { ref: '8110', type: 'CustInvc', number: 'INV0310', date: '2025-03-13', lines: [['0', 'BMG', '120', 3000], ['1', 'BMG', '510', -3000]] });
    const mirrored = await db.query<{ id: string }>(
      `INSERT INTO ledger_invoices (source, external_id, external_ref, doc_type, doc_number, doc_date, total, voided, party_name)
       VALUES ('netsuite', 'CustInvc/8110', '8110', 'invoice', 'INV0310', '2025-03-13', 30, false, 'A Customer') RETURNING id`,
    );
    await db.query(
      `INSERT INTO ledger_invoice_lines (document_id, line_external_id, line_kind, item_external_id) VALUES ($1, '1', 'item', '502')`,
      [mirrored.rows[0].id],
    );
    // 1084's alone; dated in February and booked into March, with no number; April's; and a journal entry and a bank deposit,
    // which aren't stock documents.
    await copy(db, { ref: '8111', type: 'ItemShip', number: 'IF0311', date: '2025-03-05', lines: [['1', '1084', '500', 800], ['2', '1084', '135', -800]] });
    await copy(db, { ref: '8112', type: 'ItemShip', number: null, date: '2025-02-28', booked: MAR, lines: [['1', 'BMG', '500', 1000], ['2', 'BMG', '130', -1000]] });
    await copy(db, { ref: '8113', type: 'ItemRcpt', number: 'IR0401', date: '2025-04-02', lines: [['1', 'BMG', '130', 1000], ['2', 'BMG', '205', -1000]] });
    await copy(db, { ref: '9001', type: 'Journal', number: 'JE1201', date: '2025-03-05', lines: [['1', 'BMG', '520', 2000], ['2', 'BMG', '130', -2000]] });
    await copy(db, { ref: '9002', type: 'Deposit', number: 'DEP0412', date: '2025-03-06', lines: [['1', 'BMG', '130', 2000], ['2', 'BMG', '205', -2000]] });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const month = (company: string, m: string) => one<StockMonthData>('SELECT gl_stock_month($1, $2::date) AS r', [company, m]);

  it('gl_stock_month gives the company\'s stock documents NetSuite booked into the month, an invoice\'s or credit memo\'s cost lines only', async () => {
    const mar = await month('BMG', MAR);
    // By date, then number; not 1084's, April's, the invoices that book no cost, the journal entry or the bank deposit.
    expect(mar.documents.map((d) => [d.netsuite_id, d.type, d.number, d.date, d.posting_month, d.companies])).toEqual([
      ['8112', 'ItemShip', null, '2025-02-28', MAR, ['BMG']],
      ['8101', 'ItemShip', 'IF0301', '2025-03-05', MAR, ['BMG']],
      ['8102', 'ItemRcpt', 'IR0302', '2025-03-06', MAR, ['BMG']],
      ['8103', 'InvAdjst', 'ADJ0303', '2025-03-07', MAR, ['BMG']],
      ['8104', 'InvTrnfr', 'TO0304', '2025-03-08', MAR, ['1084', 'BMG']],
      ['8105', 'Build', 'AB0305', '2025-03-09', MAR, ['BMG']],
      ['8106', 'Unbuild', 'AU0306', '2025-03-09', MAR, ['BMG']],
      ['8107', 'CustInvc', 'INV0307', '2025-03-10', MAR, ['BMG']],
      ['8108', 'CustCred', 'CM0308', '2025-03-11', MAR, ['BMG']],
    ]);
    const byId = new Map(mar.documents.map((d) => [d.netsuite_id, d]));
    // In NetSuite's order, 2 before 10, with a customer's name from the ledger mirror and its FleetSuite customer.
    expect(byId.get('8101')!.lines).toEqual([
      { line_id: '2', account: '500', debit: '40.00', credit: '0.00', memo: 'WIDGET', entity_id: '310', name: 'A Customer', customer_id: CUSTOMER },
      { line_id: '10', account: '130', debit: '0.00', credit: '40.00', memo: 'WIDGET', entity_id: '310', name: 'A Customer', customer_id: CUSTOMER },
    ]);
    // A vendor's name from the vendors copy, never an item's.
    expect(byId.get('8102')!.lines.map((l) => [l.entity_id, l.name, l.customer_id])).toEqual([[null, null, null], ['50', 'Sample Supply Co', null], ['59', null, null]]);
    // Only this company's lines of one with lines for both.
    expect(byId.get('8104')!.lines.map((l) => [l.line_id, l.account])).toEqual([['1', '130'], ['2', '130']]);
    // An invoice's and a credit memo's cost lines, not the sale.
    expect(byId.get('8107')!.lines.map((l) => [l.line_id, l.account, l.debit, l.credit, l.name])).toEqual([
      ['3', '500', '40.00', '0.00', 'A Customer'], ['4', '130', '0.00', '40.00', 'A Customer'],
    ]);
    // A customer matched by its name alone is named, but isn't taken for the FleetSuite customer.
    expect(byId.get('8108')!.lines.map((l) => [l.line_id, l.account, l.debit, l.credit, l.name, l.customer_id])).toEqual([
      ['2', '130', '20.00', '0.00', 'Another Customer', null], ['3', '500', '0.00', '20.00', 'Another Customer', null],
    ]);

    const other = await month('1084', MAR);
    expect(other.documents.map((d) => [d.netsuite_id, d.type, d.companies, d.lines.map((l) => l.line_id)])).toEqual([
      ['8111', 'ItemShip', ['1084'], ['1', '2']], ['8104', 'InvTrnfr', ['1084', 'BMG'], ['3', '4']],
    ]);
    // Any day of the month reads the month; a month with none reads none.
    expect((await month('BMG', '2025-04-15')).documents.map((d) => d.netsuite_id)).toEqual(['8113']);
    expect(await month('BMG', FEB)).toEqual({ documents: [] });
  });

  /** A fulfillment's entry, a part's cost out of inventory; `fields` change it. */
  const entry = (company: string, key: string, sourceId: string, amount: string, fields: Record<string, unknown> = {}) => ({
    company,
    entry_date: '2025-03-05',
    source_type: 'item_fulfillment',
    source_id: sourceId,
    posting_rule: 'stock@1',
    idempotency_key: key,
    memo: `Fulfillment ${sourceId}`,
    lines: [
      { account_id: accountId('500'), debit: amount, source_line_ref: '2' },
      { account_id: accountId(company === 'BMG' ? '130' : '135'), credit: amount, source_line_ref: '10' },
    ],
    ...fields,
  });
  const post = (p: unknown) => one<{ id: string; entry_no: number }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
  const postings = async (company: string, ids: string[] | null, lines: boolean) =>
    (await one<{ documents: StockPosting[] }>('SELECT gl_stock_postings($1, $2::text[], $3) AS r', [company, ids && textArray(ids), lines])).documents;

  it('gl_stock_postings says what the journal holds for each and what the copy of NetSuite\'s GL says of it now', async () => {
    const first = await post(entry('BMG', 'item_fulfillment:8101:1', '8101', '40.00', { memo: 'IF0301' }));
    const second = (await one<{ entry: { id: string; entry_no: number } }>(
      'SELECT gl_repost_entry($1::uuid, $2, $3::jsonb) AS r',
      [first.id, 'IF0301 changed in NetSuite', JSON.stringify(entry('BMG', 'item_fulfillment:8101:2', '8101', '42.00', { memo: 'IF0301' }))],
    )).entry;
    await post(entry('BMG', 'item_receipt:8102:1', '8102', '100.00', {
      source_type: 'item_receipt', entry_date: '2025-03-06', memo: 'IR0302',
      lines: [
        { account_id: accountId('130'), debit: '100.00', source_line_ref: '1', memo: 'PO311' },
        { account_id: accountId('205'), credit: '100.00', source_line_ref: '2', memo: 'Sample Supply Co' },
      ],
    }));
    await post(entry('BMG', 'inventory_adjustment:8103:1', '8103', '15.00', { source_type: 'inventory_adjustment', memo: 'ADJ0303' }));
    // An invoice's and a credit memo's cost, which the copy still has; an invoice that books no cost, one that sells to a cost of
    // goods account, and one NetSuite no longer has, which have none.
    await post(entry('BMG', 'invoice_cost:8107:1', '8107', '40.00', { source_type: 'invoice_cost', memo: 'INV0307' }));
    await post(entry('BMG', 'invoice_cost:8108:1', '8108', '20.00', { source_type: 'invoice_cost', memo: 'CM0308' }));
    await post(entry('BMG', 'invoice_cost:8109:1', '8109', '5.00', { source_type: 'invoice_cost', memo: 'INV0309' }));
    await post(entry('BMG', 'invoice_cost:8110:1', '8110', '5.00', { source_type: 'invoice_cost', memo: 'INV0310' }));
    await post(entry('BMG', 'invoice_cost:8198:1', '8198', '5.00', { source_type: 'invoice_cost', memo: 'INV0398' }));
    // NetSuite moved it to 1084 or deleted it, or the NetSuite id is another kind's: the copy has none of it for BMG.
    await post(entry('BMG', 'item_fulfillment:8111:1', '8111', '8.00', { memo: 'IF0311' }));
    await post(entry('BMG', 'item_fulfillment:8199:1', '8199', '12.00', { memo: 'IF0399' }));
    await post(entry('BMG', 'item_receipt:8101:1', '8101', '1.00', { source_type: 'item_receipt', memo: 'IF0301' }));
    await post(entry('BMG', 'assembly_build:9001:1', '9001', '20.00', { source_type: 'assembly_build', memo: 'JE1201' }));
    // 1084's.
    const other = await post(entry('1084', 'item_fulfillment:8111:1-1084', '8111', '8.00', { memo: 'IF0311' }));
    // A journal entry's entry under a fulfillment's NetSuite id is another document's, and one filed as a fulfillment with no
    // NetSuite id is no document's.
    await post(entry('BMG', 'journal_entry:8101:1', '8101', '1.00', { source_type: 'journal_entry', posting_rule: 'journal_entry@1' }));
    await post(entry('BMG', 'item_fulfillment:none:1', '', '2.00'));
    // Two entries standing for one transfer, which the posting job reverses down to one: the newer is the one that stands.
    const older = await post(entry('BMG', 'inventory_transfer:8120:1', '8120', '8.00', { source_type: 'inventory_transfer', entry_date: '2025-04-10', memo: 'TO0340' }));
    const newer = await post(entry('BMG', 'inventory_transfer:8120:2', '8120', '8.00', { source_type: 'inventory_transfer', entry_date: '2025-04-11', memo: 'TO0340-A' }));

    const held = await postings('BMG', null, false);
    // Once the copy no longer has one, the newest entry's memo gives its number.
    expect(held.map((p) => [p.source_type, p.source_id, p.entries, p.document])).toEqual([
      ['item_fulfillment', '8101', 2, { number: 'IF0301', deleted: false }],
      ['item_receipt', '8101', 1, { number: 'IF0301', deleted: true }],
      ['item_receipt', '8102', 1, { number: 'IR0302', deleted: false }],
      ['inventory_adjustment', '8103', 1, { number: 'ADJ0303', deleted: false }],
      ['invoice_cost', '8107', 1, { number: 'INV0307', deleted: false }],
      ['invoice_cost', '8108', 1, { number: 'CM0308', deleted: false }],
      ['invoice_cost', '8109', 1, { number: 'INV0309', deleted: true }],
      ['invoice_cost', '8110', 1, { number: 'INV0310', deleted: true }],
      ['item_fulfillment', '8111', 1, { number: 'IF0311', deleted: true }],
      ['inventory_transfer', '8120', 2, { number: 'TO0340-A', deleted: true }],
      ['invoice_cost', '8198', 1, { number: 'INV0398', deleted: true }],
      ['item_fulfillment', '8199', 1, { number: 'IF0399', deleted: true }],
      ['assembly_build', '9001', 1, { number: 'JE1201', deleted: true }],
    ]);
    expect(held[9]).toMatchObject({
      unreversed: [newer.id, older.id],
      current: { id: newer.id, entry_no: newer.entry_no, entry_date: '2025-04-11', lines: null },
    });
    expect(held[0]).toEqual({
      source_type: 'item_fulfillment',
      source_id: '8101',
      entries: 2,
      unreversed: [second.id],
      history: [
        { entry_no: first.entry_no, entry_date: '2025-03-05', reversed_by: first.entry_no + 1 },
        { entry_no: second.entry_no, entry_date: '2025-03-05', reversed_by: null },
      ],
      current: { id: second.id, entry_no: second.entry_no, entry_date: '2025-03-05', lines: null },
      document: { number: 'IF0301', deleted: false },
    });

    // Only the ones asked about, with the lines of the entry that stands.
    const asked = await postings('BMG', ['8102', '8107', '9999'], true);
    expect(asked.map((p) => [p.source_type, p.source_id, p.current?.lines])).toEqual([
      ['item_receipt', '8102', [
        { account: '130', debit: '100.00', credit: '0.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
        { account: '205', debit: '0.00', credit: '100.00', division: null, source_line_ref: '2', customer_id: null, vendor_ref: null },
      ]],
      ['invoice_cost', '8107', [
        { account: '500', debit: '40.00', credit: '0.00', division: null, source_line_ref: '2', customer_id: null, vendor_ref: null },
        { account: '130', debit: '0.00', credit: '40.00', division: null, source_line_ref: '10', customer_id: null, vendor_ref: null },
      ]],
    ]);
    expect((await postings('1084', null, false)).map((p) => [p.source_id, p.current?.id, p.document])).toEqual([
      ['8111', other.id, { number: 'IF0311', deleted: false }],
    ]);
  });

  it('gl_stock_postings reads the copy\'s cost lines once however many invoices and months there are, and only for a cost entry', async () => {
    // Cost entries for invoices booked into two more months. Migration 395 looked for each one month by month, and the first
    // read of every posting run ran past the statement timeout.
    for (const [ref, number, date] of [['8130', 'INV0130', '2025-01-20'], ['8131', 'INV0231', '2025-02-20']]) {
      await copy(db, {
        ref, type: 'CustInvc', number, date,
        lines: [['0', 'BMG', '120', 1000, null, '310'], ['1', 'BMG', '400', -1000], ['2', 'BMG', '500', 300], ['3', 'BMG', '130', -300]],
      });
      await post(entry('BMG', `invoice_cost:${ref}:1`, ref, '3.00', { source_type: 'invoice_cost', entry_date: date, memo: number }));
    }
    await db.exec(`RESET ROLE; SET track_functions = 'all'; SET ROLE service_role`);
    // Postgres counts a function's calls until it next reports them, so a read's are the count's growth inside one transaction.
    const calls = () => one<number>(
      `SELECT coalesce(sum(calls), 0)::int AS r FROM pg_stat_xact_user_functions WHERE funcname = 'gl_netsuite_cost_lines'`,
    );
    /** What one read says of the documents, and how many times it read the copy's cost lines. */
    const read = async (company: string, ids: string[] | null) => {
      await db.exec('BEGIN');
      try {
        const before = await calls();
        const held = await postings(company, ids, false);
        return { held: held.map((p) => [p.source_type, p.source_id, p.document?.deleted]), reads: (await calls()) - before };
      } finally {
        await db.exec('ROLLBACK');
      }
    };

    const all = await read('BMG', null);
    expect(all.reads).toBe(1);
    // Each invoice's or credit memo's cost entry still has its cost lines in the copy, or doesn't, as before.
    expect(all.held.filter(([type]) => type === 'invoice_cost')).toEqual([
      ['invoice_cost', '8107', false], ['invoice_cost', '8108', false], ['invoice_cost', '8109', true], ['invoice_cost', '8110', true],
      ['invoice_cost', '8130', false], ['invoice_cost', '8131', false], ['invoice_cost', '8198', true],
    ]);
    expect(await read('BMG', ['8107', '8131', '8198'])).toEqual({
      held: [['invoice_cost', '8107', false], ['invoice_cost', '8131', false], ['invoice_cost', '8198', true]],
      reads: 1,
    });
    // None when no cost entry is asked about, or the company has none.
    expect(await read('BMG', ['8102'])).toEqual({ held: [['item_receipt', '8102', false]], reads: 0 });
    expect(await read('1084', null)).toEqual({ held: [['item_fulfillment', '8111', false]], reads: 0 });
  });

  it('is the service role\'s alone, and neither read writes anything', async () => {
    for (const fn of ['gl_stock_month(text, date)', 'gl_stock_postings(text, text[], boolean)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>('SELECT has_function_privilege($1::name, $2, \'EXECUTE\') AS r', [role, fn]), `${role} ${fn}`)
          .toBe(role === 'service_role');
      }
    }
    for (const name of ['gl_stock_month', 'gl_stock_postings']) {
      const body = await one<string>('SELECT prosrc AS r FROM pg_proc WHERE proname = $1', [name]);
      expect(body, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    }
  });
});

// ── The job ────────────────────────────────────────────────────────────────

// Made-up stock documents, from December 2024 to March 2025.
const DOCS = (): NsDocument[] => [
  // A part shipped to a customer: its cost out of inventory.
  {
    ref: '8101', type: 'ItemShip', number: 'IF0101', date: '2025-01-15',
    lines: [['1', 'BMG', '500', 4000, 'WIDGET', '310'], ['2', 'BMG', '130', -4000, 'WIDGET', '310']],
  },
  // Parts received from a vendor against a purchase order.
  { ref: '8102', type: 'ItemRcpt', number: 'IR0102', date: '2025-02-03', lines: [['1', 'BMG', '130', 10000, 'PO311'], ['2', 'BMG', '205', -10000, null, '50']] },
  // Stock counted short.
  { ref: '8103', type: 'InvAdjst', number: 'ADJ0103', date: '2025-02-20', lines: [['1', 'BMG', '520', 1500, 'Count'], ['2', 'BMG', '130', -1500, 'Count']] },
  // An invoice that wasn't fulfilled first: its cost lines post here, the sale with the invoice rule.
  {
    ref: '8104', type: 'CustInvc', number: 'INV0104', date: '2025-03-03',
    lines: [
      ['0', 'BMG', '120', 10700, null, '310'], ['1', 'BMG', '400', -10000, 'WIDGET', '310'], ['2', 'BMG', '220', -700],
      ['3', 'BMG', '500', 2500, null, '310'], ['4', 'BMG', '130', -2500, null, '310'],
    ],
  },
  // A part returned on a credit memo, its cost back into inventory.
  {
    ref: '8105', type: 'CustCred', number: 'CM0105', date: '2025-03-04',
    lines: [['0', 'BMG', '120', -5000, null, '310'], ['1', 'BMG', '400', 5000, 'WIDGET', '310'], ['2', 'BMG', '130', 1000], ['3', 'BMG', '500', -1000]],
  },
  // 1084's, which a run for BMG leaves alone.
  { ref: '8106', type: 'ItemShip', number: 'IF0106', date: '2025-03-05', lines: [['1', '1084', '500', 800], ['2', '1084', '135', -800]] },
  // Stock moved between BMG's bays, with lines for 1084 too: BMG's lines are BMG's entry.
  {
    ref: '8107', type: 'InvTrnfr', number: 'TO0107', date: '2025-03-06',
    lines: [['1', 'BMG', '130', 3000, 'To bay 2'], ['2', 'BMG', '130', -3000, 'From bay 1'], ['3', '1084', '135', 500], ['4', '1084', '135', -500]],
  },
  // An assembly built partly from 1084's stock: BMG's lines don't balance on their own.
  { ref: '8108', type: 'Build', number: 'AB0108', date: '2025-03-20', lines: [['1', 'BMG', '131', 3000], ['2', 'BMG', '130', -1000], ['3', '1084', '135', -2000]] },
  // Dated before the books start, booked by NetSuite into January 2025.
  { ref: '8109', type: 'ItemShip', number: 'IF0090', date: '2024-12-31', booked: JAN, lines: [['1', 'BMG', '500', 4000], ['2', 'BMG', '130', -4000]] },
  // $0.
  { ref: '8110', type: 'InvAdjst', number: 'ADJ0109', date: '2025-03-09', lines: [['1', 'BMG', '520', 0], ['2', 'BMG', '130', 0]] },
];

describe('the posting job, for stock documents', () => {
  let pg: PGlite;
  let clock = 0;
  /** How long a function takes, for running out of time. */
  const takes = new Map<string, number>();
  /** When a function fails, by what it was asked. */
  const failing = new Map<string, (args: Record<string, unknown>) => boolean>();
  const store = new Map<string, any>();
  const docs = new Map<string, NsDocument>();

  // sync_state in memory; gl_accounts, gl_companies and every function the
  // real ones, called the way supabase-js calls them.
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
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      clock += takes.get(fn) ?? 0;
      if (failing.get(fn)?.(args)) return { data: null, error: { message: `${fn} failed` } };
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

  // A stock document's entry is its lines in NetSuite's GL copy, so there's nothing to ask NetSuite.
  const query = async () => { throw new Error('NetSuite was asked about lines'); };
  // A run for BMG's books alone (deps.companies): 1084's documents here are another company's, which it leaves alone.
  const run = (budgetMs = 240_000) => postInvoices(service(), { deadline: clock + budgetMs, deps: { query, now: () => clock, companies: ['BMG'] } });

  /** The journal, entry by entry: a document's entry by its key, a reversal by the entry it reverses. */
  const journal = async () => (await pg.query<{ no: number; date: string; key: string | null; reverses: number | null; memo: string | null }>(
    `SELECT e.entry_no::int AS no, to_char(e.entry_date, 'YYYY-MM-DD') AS date,
            CASE WHEN e.reverses_entry_id IS NULL THEN e.idempotency_key END AS key, r.entry_no::int AS reverses, e.memo
     FROM gl_entries e LEFT JOIN gl_entries r ON r.id = e.reverses_entry_id
     ORDER BY e.entry_no`,
  )).rows;
  const linesOf = async (no: number) => (await pg.query(
    `SELECT a.netsuite_account_id AS account, l.debit::text AS debit, l.credit::text AS credit, l.memo, l.customer_id::text AS customer,
            l.vendor_ref, l.source_line_ref
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
     WHERE e.entry_no = $1 ORDER BY l.line_no`,
    [no],
  )).rows;
  const ruleOf = async (no: number) => (await pg.query<{ rule: string; type: string; source: string }>(
    'SELECT posting_rule AS rule, source_type AS type, source_id AS source FROM gl_entries WHERE entry_no = $1', [no],
  )).rows[0];
  const differing = async (month: string) => pg.query<{ r: { counts: Record<string, number>; documents: any[] } }>(
    'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', month, JSON.stringify(STOCK_KINDS), 10],
  ).then((res) => res.rows[0].r);

  /** NetSuite changes a document, and the GL copy catches up. */
  const edit = async (ref: string, change: (d: NsDocument) => void) => {
    const d = docs.get(ref)!;
    change(d);
    await copy(pg, d);
  };
  const add = async (d: NsDocument) => {
    docs.set(d.ref, d);
    await copy(pg, d);
  };

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    clock = Date.parse('2025-03-15T12:00:00Z');
    for (const d of DOCS()) await add(d);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('posts each BMG stock document once, in the month NetSuite booked it into, with its lines as NetSuite has them', async () => {
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 7, replaced: 0, reversed: 0, unchanged: 0, left: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect(r.notes).toEqual([
      "FleetSuite can't post 1 stock document, as its lines for the company don't balance on their own, so whatever FleetSuite "
        + 'holds for it stayed as it is: AB0108. The Stock and cost switch on Invoices vs NetSuite shows its lines.',
    ]);

    // Not IF0106 (1084's), AB0108 (doesn't balance for BMG) or ADJ0109 ($0).
    expect(await journal()).toEqual([
      { no: 1, date: JAN, key: 'item_fulfillment:8109:1', reverses: null, memo: 'IF0090' },
      { no: 2, date: '2025-01-15', key: 'item_fulfillment:8101:1', reverses: null, memo: 'IF0101' },
      { no: 3, date: '2025-02-03', key: 'item_receipt:8102:1', reverses: null, memo: 'IR0102' },
      { no: 4, date: '2025-02-20', key: 'inventory_adjustment:8103:1', reverses: null, memo: 'ADJ0103' },
      { no: 5, date: '2025-03-03', key: 'invoice_cost:8104:1', reverses: null, memo: 'INV0104' },
      { no: 6, date: '2025-03-04', key: 'invoice_cost:8105:1', reverses: null, memo: 'CM0105' },
      { no: 7, date: '2025-03-06', key: 'inventory_transfer:8107:1', reverses: null, memo: 'TO0107' },
    ]);
    expect(await ruleOf(2)).toEqual({ rule: 'stock@1', type: 'item_fulfillment', source: '8101' });
    expect(await ruleOf(3)).toEqual({ rule: 'stock@1', type: 'item_receipt', source: '8102' });
    expect(await ruleOf(5)).toEqual({ rule: 'stock@1', type: 'invoice_cost', source: '8104' });
    expect(await ruleOf(6)).toEqual({ rule: 'stock@1', type: 'invoice_cost', source: '8105' });
    // Each line with its memo and name; neither cost of goods nor inventory is receivables, so no customer goes on them.
    expect(await linesOf(2)).toEqual([
      { account: '500', debit: '40.00', credit: '0.00', memo: 'A Customer · WIDGET', customer: null, vendor_ref: null, source_line_ref: '1' },
      { account: '130', debit: '0.00', credit: '40.00', memo: 'A Customer · WIDGET', customer: null, vendor_ref: null, source_line_ref: '2' },
    ]);
    // Nor is stock received but not billed payables, so no vendor goes on it.
    expect(await linesOf(3)).toEqual([
      { account: '130', debit: '100.00', credit: '0.00', memo: 'PO311', customer: null, vendor_ref: null, source_line_ref: '1' },
      { account: '205', debit: '0.00', credit: '100.00', memo: 'Sample Supply Co', customer: null, vendor_ref: null, source_line_ref: '2' },
    ]);
    // Only an invoice's and a credit memo's cost lines.
    expect((await linesOf(5)).map((l: any) => [l.account, l.debit, l.credit, l.source_line_ref])).toEqual([
      ['500', '25.00', '0.00', '3'], ['130', '0.00', '25.00', '4'],
    ]);
    expect((await linesOf(6)).map((l: any) => [l.account, l.debit, l.credit, l.source_line_ref])).toEqual([
      ['130', '10.00', '0.00', '2'], ['500', '0.00', '10.00', '3'],
    ]);
    // Only BMG's lines of the one with lines for both companies.
    expect((await linesOf(7)).map((l: any) => [l.account, l.debit, l.credit, l.memo])).toEqual([
      ['130', '30.00', '0.00', 'To bay 2'], ['130', '0.00', '30.00', 'From bay 1'],
    ]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);

    // Differences: what's posted comes to NetSuite's, an invoice's and a credit memo's cost included; AB0108 is the one that
    // differs.
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(FEB)).counts).toEqual({});
    const mar = await differing(MAR);
    expect(mar.counts).toEqual({ assembly_build: 1 });
    expect(mar.documents[0]).toMatchObject({
      kind: 'assembly_build', netsuite_id: '8108', fleetsuite: { entries: 0, standing: null }, copy: null,
      netsuite: { type: 'Build', number: 'AB0108', date: '2025-03-20', month: MAR },
    });
  });

  it('changes nothing on the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 7, left: 1 });
    expect(await journal()).toEqual(before);
  });

  it('replaces an entry when NetSuite changes an amount, an account or the date, and an invoice\'s only when its cost does', async () => {
    // A new number, memo or name only describes, and an invoice's sale is the invoice rule's.
    await edit('8101', (d) => {
      d.number = 'IF0101-A';
      d.lines = [['1', 'BMG', '500', 4000, 'WIDGET (shipped)', '310'], ['2', 'BMG', '130', -4000, 'WIDGET (shipped)', '310']];
    });
    await edit('8104', (d) => { d.lines = [['0', 'BMG', '120', 11200, null, '310'], ['1', 'BMG', '400', -10500], ...d.lines.slice(2)]; });
    await pg.query(`UPDATE gl_netsuite_lists SET name = 'Sample Supply Company' WHERE kind = 'vendor' AND netsuite_id = '50'`);
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, unchanged: 7 });

    // NetSuite costed the part again.
    await edit('8101', (d) => { d.lines = [['1', 'BMG', '500', 4200, 'WIDGET (shipped)', '310'], ['2', 'BMG', '130', -4200, 'WIDGET (shipped)', '310']]; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, unchanged: 6 });
    expect((await journal()).slice(-2)).toEqual([
      { no: 8, date: '2025-01-15', key: null, reverses: 2, memo: 'IF0101-A changed in NetSuite' },
      { no: 9, date: '2025-01-15', key: 'item_fulfillment:8101:2', reverses: null, memo: 'IF0101-A' },
    ]);
    expect((await linesOf(9)).map((l: any) => [l.account, l.debit, l.credit, l.memo])).toEqual([
      ['500', '42.00', '0.00', 'A Customer · WIDGET (shipped)'], ['130', '0.00', '42.00', 'A Customer · WIDGET (shipped)'],
    ]);

    // Received a day later, the invoice's cost changed, the credit memo's moved to another cost of goods sold account, and
    // NetSuite moved IF0090 into February.
    await edit('8102', (d) => { d.date = '2025-02-04'; });
    await edit('8104', (d) => { d.lines = [...d.lines.slice(0, 3), ['3', 'BMG', '500', 3000, null, '310'], ['4', 'BMG', '130', -3000, null, '310']]; });
    await edit('8105', (d) => { d.lines = [...d.lines.slice(0, 2), ['2', 'BMG', '130', 1000], ['3', 'BMG', '510', -1000]]; });
    await edit('8109', (d) => { d.booked = FEB; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 4, unchanged: 3, left: 1 });
    expect((await journal()).slice(-8)).toEqual([
      { no: 10, date: JAN, key: null, reverses: 1, memo: 'IF0090 changed in NetSuite' },
      { no: 11, date: FEB, key: 'item_fulfillment:8109:2', reverses: null, memo: 'IF0090' },
      { no: 12, date: '2025-02-03', key: null, reverses: 3, memo: 'IR0102 changed in NetSuite' },
      { no: 13, date: '2025-02-04', key: 'item_receipt:8102:2', reverses: null, memo: 'IR0102' },
      { no: 14, date: '2025-03-03', key: null, reverses: 5, memo: 'INV0104 changed in NetSuite' },
      { no: 15, date: '2025-03-03', key: 'invoice_cost:8104:2', reverses: null, memo: 'INV0104' },
      { no: 16, date: '2025-03-04', key: null, reverses: 6, memo: 'CM0105 changed in NetSuite' },
      { no: 17, date: '2025-03-04', key: 'invoice_cost:8105:2', reverses: null, memo: 'CM0105' },
    ]);
    expect((await linesOf(15)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([['500', '30.00', '0.00'], ['130', '0.00', '30.00']]);
    expect((await linesOf(17)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([['130', '10.00', '0.00'], ['510', '0.00', '10.00']]);
    // January no longer holds IF0090, as NetSuite's January doesn't.
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(FEB)).counts).toEqual({});
    expect((await differing(MAR)).counts).toEqual({ assembly_build: 1 });
  });

  it('reverses the entry of one NetSuite deletes, moves to the other company, or that comes to nothing now, and an invoice\'s cost once it books none', async () => {
    await edit('8101', (d) => { d.gone = true; });
    await edit('8107', (d) => { d.lines = [['3', '1084', '135', 500], ['4', '1084', '135', -500]]; });
    await edit('8103', (d) => { d.lines = [['1', 'BMG', '520', 0], ['2', 'BMG', '130', 0]]; });
    // The invoice stands, its sale with it; NetSuite books no cost on it now.
    await edit('8104', (d) => { d.lines = d.lines.slice(0, 3); });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 4, unchanged: 3, left: 1 });
    // The number of one NetSuite no longer has comes from its entry's memo.
    expect((await journal()).slice(-4).map((e) => [e.reverses, e.memo])).toEqual([
      [9, 'IF0101-A deleted in NetSuite'],
      [15, 'INV0104 no longer books a cost in NetSuite'],
      [7, 'TO0107 deleted in NetSuite'],
      [4, 'ADJ0103 comes to nothing in NetSuite'],
    ]);

    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 3 });
    expect(await journal()).toEqual(before);
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(MAR)).counts).toEqual({ assembly_build: 1 });
  });

  it('posts one once its lines balance, to an account NetSuite has made inactive too, and names one the journal refuses, without amounts', async () => {
    await edit('8108', (d) => {
      d.lines = [['1', 'BMG', '131', 3000], ['2', 'BMG', '130', -3000], ['3', '1084', '135', -2000], ['4', '1084', '135', 2000]];
    });
    // Counted to an adjustments account NetSuite has made inactive since, and shipped from stock only 1084 may use.
    await add({ ref: '8111', type: 'InvAdjst', number: 'ADJ0111', date: '2025-03-10', lines: [['1', 'BMG', '521', 900], ['2', 'BMG', '130', -900]] });
    await add({ ref: '8112', type: 'ItemShip', number: 'IF0112', date: '2025-03-11', lines: [['1', 'BMG', '500', 800], ['2', 'BMG', '135', -800]] });

    const r = await run();
    expect(r).toMatchObject({
      posted: 2, left: 0, failedCount: 1, failed: [{ number: 'IF0112', reason: 'Account 1350 (Inventory 1084) belongs to another company' }],
    });
    expect(r.notes).toBeUndefined();
    const posted = (await journal()).slice(-2);
    expect(posted.map((e) => [e.date, e.key])).toEqual([['2025-03-10', 'inventory_adjustment:8111:1'], ['2025-03-20', 'assembly_build:8108:1']]);
    expect((await linesOf(posted[0].no)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([['521', '9.00', '0.00'], ['130', '0.00', '9.00']]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);
    expect((await differing(MAR)).counts).toEqual({ item_fulfillment: 1 });
  });

  it('posts nothing to an account the chart of accounts doesn\'t have yet, and says so, then posts it once the chart has it', async () => {
    await edit('8112', (d) => { d.lines = [['1', 'BMG', '500', 800], ['2', 'BMG', '130', -800]]; });
    await add({ ref: '8113', type: 'ItemRcpt', number: 'IR0113', date: '2025-02-14', lines: [['1', 'BMG', '130', 700], ['2', 'BMG', '299', -700]] });
    const r = await run();
    expect(r).toMatchObject({
      posted: 1, failedCount: 1, failed: [{ number: 'IR0113', reason: "It posts to NetSuite account 299, which the chart of accounts doesn't have" }],
    });
    expect(r.notes).toEqual([
      "NetSuite account 299 isn't in the chart of accounts yet, so invoices, credit memos, payments, deposits, bills, bill payments, checks, "
        + "card charges, journal entries, bank deposits, transfers, customer refunds and stock documents posting there weren't posted. Sync now on the chart of "
        + 'accounts page copies them.',
    ]);
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['item_fulfillment:8112:1']);

    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active)
       VALUES ($1, '2990', 'Clearing', 'other_current_liability', '299', (SELECT id FROM gl_companies WHERE code = 'BMG'), true)`,
      [accountId('299')],
    );
    const again = await run();
    expect(again).toMatchObject({ posted: 1, failedCount: 0 });
    expect(again.notes).toBeUndefined();
    expect((await journal()).slice(-1).map((e) => [e.date, e.key])).toEqual([['2025-02-14', 'item_receipt:8113:1']]);
  });

  it('never starts a stock document write with under five seconds left, and does that month again next run', async () => {
    await add({ ref: '8114', type: 'ItemShip', number: 'IF0114', date: '2025-01-20', lines: [['1', 'BMG', '500', 4000], ['2', 'BMG', '130', -4000]] });
    const before = await journal();

    takes.set('gl_stock_month', 26_000);
    expect(await run(30_000)).toMatchObject({ months: [], posted: 0, partial: true });
    expect(store.get(BOOKS_INVOICE_POSTING).last_result.resume).toEqual({ company: 'BMG', month: JAN });
    expect(await journal()).toEqual(before);

    takes.clear();
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 1, failedCount: 0 });
    expect(r.partial).toBeUndefined();
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['item_fulfillment:8114:1']);
  });

  it('stops, saying why, and writes nothing when it can\'t read the stock documents or what the journal holds for them', async () => {
    // NetSuite changes IF0114, so a run that could read everything would replace its entry.
    await edit('8114', (d) => { d.lines = [['1', 'BMG', '500', 4100], ['2', 'BMG', '130', -4100]]; });
    const before = await journal();
    // Each error says what it was reading.
    const reads: Array<[string, (args: Record<string, unknown>) => boolean, string]> = [
      ['gl_stock_month', () => true, "BMG's stock and cost for Jan 2025"],
      // Step 1's read of every entry, then a month's read of its documents' entries.
      ['gl_stock_postings', (args) => args.p_source_ids === null, "the journal's entries for BMG's stock and cost"],
      ['gl_stock_postings', (args) => args.p_source_ids !== null, "the journal's entries for BMG's stock and cost in Jan 2025"],
    ];
    // And every other kind's: step 1's read of every entry, and a month's read of the copy.
    const kinds: Array<[string, string]> = [
      ['invoice', 'invoices and credit memos'], ['payment', 'payments'], ['deposit', 'deposits'], ['bill', 'bills'],
      ['bill_payment', 'bill payments'], ['spending', 'checks and cards'], ['journal', 'journal entries'],
      ['bank', 'bank deposits, transfers and refunds'],
    ];
    for (const [kind, words] of kinds) {
      reads.push(
        [`gl_${kind}_postings`, (args) => args.p_source_ids === null, `the journal's entries for BMG's ${words}`],
        [`gl_${kind}_month`, () => true, `BMG's ${words} for Jan 2025`],
      );
    }
    for (const [fn, when, what] of reads) {
      failing.set(fn, when);
      const r = await run();
      failing.clear();
      expect(r.error, fn).toBe(`Reading ${what}: ${fn} failed`);
      expect(await journal(), fn).toEqual(before);
    }

    // It can read them again: the next run carries on.
    const r = await run();
    expect(r).toMatchObject({ posted: 0, replaced: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['item_fulfillment:8114:2']);
  });

  it('names every one whose lines don\'t balance in one note, and keeps what stands for them', async () => {
    // AB0108's entry stands; ADJ0115 is new.
    await edit('8108', (d) => { d.lines = [['1', 'BMG', '131', 3000], ['2', 'BMG', '130', -1000], ['3', '1084', '135', -2000]]; });
    await add({ ref: '8115', type: 'InvAdjst', number: 'ADJ0115', date: '2025-03-25', lines: [['1', 'BMG', '520', 500]] });
    const before = await journal();

    const r = await run();
    expect(r).toMatchObject({ posted: 0, replaced: 0, reversed: 0, left: 2, failedCount: 0 });
    expect(r.notes).toEqual([
      "FleetSuite can't post 2 stock documents, as their lines for the company don't balance on their own, so whatever FleetSuite "
        + 'holds for them stayed as it is: AB0108, ADJ0115. The Stock and cost switch on Invoices vs NetSuite shows their lines.',
    ]);
    expect(await journal()).toEqual(before);
    expect((await differing(MAR)).counts).toEqual({ assembly_build: 1, inventory_adjustment: 1 });
  });
});
