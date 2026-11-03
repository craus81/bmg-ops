// Migration 518 puts each of Books' own credit memos (migration 466) next to
// NetSuite's credit memo as the ledger mirror copies it, with the location
// NetSuite booked it to, and has each of NetSuite's lines on a credit memo or
// on an own invoice (migration 407) say whether it books the cost of stock
// that came back or went out. This runs migrations 314 and 359–363 with 407,
// 466 and 518 in an in-memory Postgres (PGlite) as the app's server login,
// saves copies worked out by src/lib/credit-memo.ts,
// src/lib/books/own-credit-memos.ts and own-invoices.ts, copies made-up
// NetSuite credit memos and invoices and their postings, holds what
// gl_own_credit_memo_pairs, gl_own_credit_memo_months and
// gl_own_invoice_pairs return, then checks the pairs end to end.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));

import { NO_EARLIER, parseInvoiceRecord, workOutCreditMemo } from '@/lib/credit-memo';
import { ownCreditMemoPayload } from './own-credit-memos';
import { checkOwnCreditMemos, type OwnCreditPairsData } from './own-credit-memo-check';
import { savePayload, workOutOwnInvoice, type OwnInvoiceFacts } from './own-invoices';
import { checkOwnInvoices, costLinesText, type OwnPairsData } from './own-invoice-check';

const ACME = 'c0000000-0000-4000-8000-00000000000a';
const PRESS = 'b0000000-0000-4000-8000-000000000001';

/**
 * Made-up chart: '120' receivables, '130' the shelf's inventory, '400' sales, '410' discounts given, '220' sales tax,
 * '500' cost of goods sold, and '510' customer credits, a cost of goods sold account the credit item's income goes to.
 */
const ACCOUNTS: Array<[string, string, string]> = [
  ['120', 'Accounts Receivable', 'accounts_receivable'],
  ['130', 'Inventory Asset', 'other_current_asset'],
  ['400', 'Sales', 'income'],
  ['410', 'Discounts Given', 'income'],
  ['220', 'Sales Tax Payable', 'other_current_liability'],
  ['500', 'Cost of Goods Sold', 'cost_of_goods_sold'],
  ['510', 'Customer Credits', 'cost_of_goods_sold'],
];

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
    -- What migrations 314, 407 and 466 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '407-books-own-invoices.sql',
    '466-credit-memos-in-fleetsuite.sql', '518-books-own-credit-memo-posting.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.query(`INSERT INTO customers (id, company_name, netsuite_id, tax_exempt) VALUES ($1, 'Acme Fleet', '9001', false)`, [ACME]);
  for (const [ns, name, type] of ACCOUNTS) {
    await pg.query('INSERT INTO gl_accounts (name, account_type, netsuite_account_id) VALUES ($1, $2, $3)', [name, type, ns]);
  }
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('location', '1', 'O''Fallon', true, '{}'), ('location', '2', 'Wentzville', true, '{}'),
      ('term', '4', 'Net 30', true, '{"days_until_net_due": 30}'),
      ('tax_code', '77', 'MO St Charles', true, '{"rate": "8.488%"}'),
      ('item', '55', 'SHELF-1', true, '{"item_type": "InvtPart", "income_account": "400", "asset_account": "130"}'),
      ('item', '56', 'LABOR', true, '{"item_type": "Service", "income_account": "400"}'),
      ('item', '58', 'DISCOUNT', true, '{"item_type": "Discount", "income_account": "410"}'),
      ('item', '900', 'CREDIT', true, '{"item_type": "OthCharge", "income_account": "510"}'),
      ('customer', '9001', 'Acme Fleet Services', true, '{"terms_id": "4", "taxable": "T"}');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const creditPairs = (pg: PGlite, from: string | null, to: string | null, id: string | null = null) =>
  one<OwnCreditPairsData>(pg, 'SELECT gl_own_credit_memo_pairs($1::date, $2::date, $3) AS r', [from, to, id]);
const ids = (data: OwnCreditPairsData) => data.credit_memos.map((c) => c.own.netsuite_id);

// ── Books' own credit memos, worked out as FleetSuite works them out ───────

/** INV9001: two shelves, three hours of labor, a discount on the parts and a light, the parts taxed at 8.488%. */
const INVOICE = parseInvoiceRecord({
  id: '7001', tranId: 'INV9001', tranDate: '2026-10-20', entity: { id: '9001', refName: 'Acme Fleet Services' },
  location: { id: '1', refName: "O'Fallon" }, subtotal: 610, taxTotal: 27.58, total: 637.58, taxRate: 8.488,
  item: { items: [
    { line: 1, item: { id: '55', refName: 'SHELF-1' }, itemType: 'InvtPart', quantity: 2, rate: 125.5, amount: 251, description: 'Shelf unit', isTaxable: true },
    { line: 2, item: { id: '56', refName: 'LABOR' }, itemType: 'Service', quantity: 3, rate: 95, amount: 285, isTaxable: false },
    { line: 4, item: { id: '58', refName: 'DISCOUNT' }, itemType: 'Discount', rate: -26, amount: -26, isTaxable: true },
    { line: 5, item: { id: '57', refName: 'LIGHT-2' }, itemType: 'InvtPart', quantity: 1, rate: 100, amount: 100, isTaxable: true },
  ] },
});

/** Books' own copy of a credit memo FleetSuite made against INV9001 on `creditDate`, as gl_own_credit_memo_save takes it. */
const creditCopy = (
  netsuiteId: string,
  creditDate: string,
  drafts: Parameters<typeof workOutCreditMemo>[1],
  added: Parameters<typeof workOutCreditMemo>[2] = [],
) => {
  const worked = workOutCreditMemo(INVOICE, drafts, added, { earlier: NO_EARLIER, creditItem: { id: '900', itemNumber: 'CREDIT' }, reason: 'Returned' });
  expect(worked.problems).toEqual([]);
  return ownCreditMemoPayload(
    { netsuiteId, netsuiteNumber: `CM${netsuiteId}`, invoice: INVOICE, worked, reason: 'Returned', madeFromId: PRESS, madeBy: null },
    { customerId: ACME, creditDate },
  );
};

const saveCredit = async (pg: PGlite, p: unknown) =>
  one<{ saved: boolean; lines: number }>(pg, 'SELECT gl_own_credit_memo_save($1::jsonb) AS r', [JSON.stringify(p)]);

// ── NetSuite's documents, as the ledger mirror and the copy of its general ledger have them ──

type MirrorLine = [lineId: string, kind: 'item' | 'tax', item: string, amount: string, netamount: string | null, quantity: string | null];

/** NetSuite's credit memo or invoice as the ledger mirror copies it, its amounts unsigned and its net amounts NetSuite's own. */
async function mirror(pg: PGlite, external: string, fields: Record<string, unknown>, lines: MirrorLine[]) {
  const [type, id] = external.split('/');
  const row = {
    source: 'netsuite', external_id: external, external_ref: id, doc_type: type === 'CustCred' ? 'credit_memo' : 'invoice',
    customer_netsuite_id: '9001', party_name: 'Acme Fleet Services', lines_synced_at: '2026-10-31T18:00:00Z', ...fields,
  };
  const cols = Object.keys(row);
  const doc = await pg.query<{ id: string }>(
    `INSERT INTO ledger_invoices (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
  for (const [lineId, kind, item, amount, netamount, quantity] of lines) {
    await pg.query(
      `INSERT INTO ledger_invoice_lines (document_id, line_external_id, line_no, line_kind, item_external_id, amount, quantity, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [doc.rows[0].id, lineId, Number(lineId), kind, item, amount, quantity, JSON.stringify(netamount === null ? {} : { netamount })],
    );
  }
}

/** What NetSuite posted for it in the copy of its general ledger: [line, account, cents debit positive], the receivable line '0' booked to `location`. */
async function post(pg: PGlite, id: string, type: string, date: string, lines: Array<[string, string, number]>, location: string | null) {
  const month = `${date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, `${type}${id}`, date, month],
  );
  for (const [line, account, cents] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, location_id)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8 FROM gl_companies WHERE code = 'BMG'`,
      [id, line, account, month, date, (Math.max(cents, 0) / 100).toFixed(2), (Math.max(-cents, 0) / 100).toFixed(2), line === '0' ? location : null],
    );
  }
}

describe("migration 518: Books' own credit memos next to NetSuite's", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    // CM8001 gives back a shelf, $40 of the light on the credit item, half the discount and $25 of goodwill; CM8002 an
    // hour of labor; CM10001 the light; CM8003, in September, a shelf.
    for (const [id, date, drafts, added] of [
      ['8001', '2026-10-31', [{ line: 1, quantity: 1, price: 125.5 }, { line: 5, quantity: 1, price: 40, backToStock: false }, { line: 4, amount: 13 }],
        [{ description: 'Goodwill', amount: 25, taxable: false }]],
      ['8002', '2026-10-15', [{ line: 2, quantity: 1, price: 95 }], []],
      ['10001', '2026-10-31', [{ line: 5, quantity: 1, price: 100 }], []],
      ['8003', '2026-09-30', [{ line: 1, quantity: 1, price: 125.5 }], []],
    ] as const) {
      expect(await saveCredit(pg, creditCopy(id, date, [...drafts], [...added])), id).toMatchObject({ saved: true });
    }
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('counts the copies by the month they were made, newest first', async () => {
    expect(await one(pg, 'SELECT gl_own_credit_memo_months() AS r')).toEqual([
      { month: '2026-10-01', credit_memos: 3 },
      { month: '2026-09-01', credit_memos: 1 },
    ]);
  });

  it("pairs each copy with nothing until NetSuite's credit memo is copied", async () => {
    const data = await creditPairs(pg, '2026-10-01', '2026-10-31');
    // Newest first; on the same day, NetSuite's later id first.
    expect(ids(data)).toEqual(['10001', '8001', '8002']);
    const row = data.credit_memos[1];
    expect(row.netsuite).toBeNull();
    expect(row.netsuite_gl).toBeNull();
    expect(row.customer_name).toBe('Acme Fleet');
    expect(row.own).toMatchObject({
      netsuite_id: '8001', number: 'CM8001', invoice_id: '7001', invoice_number: 'INV9001', made_from_id: PRESS,
      customer_netsuite_id: '9001', customer_id: ACME, date: '2026-10-31', location_id: '1', reason: 'Returned',
      tax_rule: 'credit_tax@1', tax_rate: '0.084880', tax_rate_from: 'invoice', subtotal: '177.50', tax: '12.95', total: '190.45',
    });
    expect(typeof row.own.made_at).toBe('string');
    expect(row.own.lines.map((l) => [l.line_no, l.invoice_line, l.item_id, l.quantity, l.rate, l.amount, l.taxable, l.tax, l.back_to_stock, l.on_credit_item])).toEqual([
      [1, 1, '55', '1.0000', '125.5000', '125.50', true, '10.65', true, false],
      [2, 5, '900', '1.0000', '40.0000', '40.00', true, '3.40', false, true],
      [3, 4, '58', null, null, '-13.00', true, '-1.10', false, false],
      [4, null, '900', '1.0000', '25.0000', '25.00', false, '0.00', false, true],
    ]);
    // An hour of labor gives back no tax, at no rate.
    expect(data.credit_memos[2].own).toMatchObject({ tax_rate: '0.000000', tax_rate_from: 'untaxed', subtotal: '95.00', tax: '0.00', total: '95.00' });
    // The items either copy names that the copy of NetSuite's lists has: not the light, which it doesn't.
    expect(data.items).toEqual({
      55: { number: 'SHELF-1', type: 'InvtPart' }, 56: { number: 'LABOR', type: 'Service' },
      58: { number: 'DISCOUNT', type: 'Discount' }, 900: { number: 'CREDIT', type: 'OthCharge' },
    });
    expect(data.tax_codes).toEqual({});
    expect(data.locations).toEqual({ 1: "O'Fallon", 2: 'Wentzville' });
    expect(checkOwnCreditMemos(data).counts).toEqual({ differs: 0, waiting: 3, matches: 0, voided: 0 });
  });

  it("pairs a copy with NetSuite's credit memo, its lines and its posting, says which lines book the cost of the stock that came back, and the check finds it matches", async () => {
    await mirror(pg, 'CustCred/8001', {
      doc_number: 'CM8001', doc_date: '2026-10-31', total: '190.45', memo: 'Returned', status_label: 'Fully Applied',
    }, [
      ['1', 'item', '55', '125.50', '125.50', '1'],
      ['2', 'item', '900', '40.00', '40.00', '1'],
      ['3', 'item', '58', '13.00', '-13.00', null],
      ['4', 'item', '900', '25.00', '25.00', '1'],
      ['5', 'tax', '77', '12.95', '12.95', null],
      // The shelf back on the shelf at its $60 cost: out of cost of goods sold, into its inventory.
      ['6', 'item', '55', '60.00', '-60.00', '1'],
      ['7', 'item', '55', '60.00', '60.00', '1'],
    ]);
    await post(pg, '8001', 'CustCred', '2026-10-31', [
      ['0', '120', -19045], ['1', '400', 12550], ['2', '510', 4000], ['3', '410', -1300], ['4', '510', 2500], ['5', '220', 1295],
      ['6', '500', -6000], ['7', '130', 6000],
    ], '1');

    const data = await creditPairs(pg, null, null, '8001');
    expect(ids(data)).toEqual(['8001']);
    const [row] = data.credit_memos;
    expect(row.netsuite).toMatchObject({
      number: 'CM8001', date: '2026-10-31', total: '190.45', customer_netsuite_id: '9001', customer_name: 'Acme Fleet Services',
      memo: 'Returned', status: 'Fully Applied', voided: false, deleted: false, lines_copied: true,
    });
    expect(typeof row.netsuite!.copied_at).toBe('string');
    // The credit item's lines are on a cost of goods sold account, but it's the credit item's own income account: they're
    // what was credited. The shelf's lines on cost of goods sold and its inventory account are its cost.
    expect(row.netsuite!.lines.map((l) => [l.line_id, l.kind, l.item_id, l.amount, l.netamount, l.quantity, l.cost])).toEqual([
      ['1', 'item', '55', '125.50', '125.50', '1.00', false],
      ['2', 'item', '900', '40.00', '40.00', '1.00', false],
      ['3', 'item', '58', '13.00', '-13.00', null, false],
      ['4', 'item', '900', '25.00', '25.00', '1.00', false],
      ['5', 'tax', '77', '12.95', '12.95', null, false],
      ['6', 'item', '55', '60.00', '-60.00', '1.00', true],
      ['7', 'item', '55', '60.00', '60.00', '1.00', true],
    ]);
    expect(row.netsuite_gl).toEqual({ location_id: '1' });
    expect(data.tax_codes).toEqual({ 77: { name: 'MO St Charles', rate: '8.488%' } });
    expect(Object.keys(data.items).sort()).toEqual(['55', '58', '900']);

    const { creditMemos, counts } = checkOwnCreditMemos(data);
    expect(counts).toEqual({ differs: 0, waiting: 0, matches: 1, voided: 0 });
    const [check] = creditMemos;
    expect(check).toMatchObject({
      netsuiteId: '8001', number: 'CM8001', invoiceNumber: 'INV9001', customer: 'Acme Fleet', status: 'matches',
      summary: "Matches NetSuite's credit memo.", differing: 0, fleetsuiteTotal: 19045, netsuiteTotal: 19045, backToStock: 1,
    });
    expect(check.lines.map((l) => [l.item, l.netsuite?.lineId, l.same])).toEqual([
      ['SHELF-1', '1', true], ['CREDIT', '2', true], ['DISCOUNT', '3', true], ['CREDIT', '4', true],
    ]);
    expect(check.workedOut).toContain(costLinesText(2, "NetSuite's credit memo", 'that came back'));

    // Were the cost lines taken for what was credited, the shelf would seem credited three times.
    const uncosted: OwnCreditPairsData = {
      ...data,
      credit_memos: data.credit_memos.map((c) => ({ ...c, netsuite: { ...c.netsuite!, lines: c.netsuite!.lines.map((l) => ({ ...l, cost: false })) } })),
    };
    expect(checkOwnCreditMemos(uncosted).creditMemos[0]).toMatchObject({ status: 'differs', differing: 1 });
  });

  it('reads only the days asked, or the one credit memo whatever the days', async () => {
    expect(ids(await creditPairs(pg, '2026-09-01', '2026-09-30'))).toEqual(['8003']);
    expect(ids(await creditPairs(pg, '2026-09-01', '2026-10-31'))).toEqual(['10001', '8001', '8002', '8003']);
    expect(ids(await creditPairs(pg, '2026-10-16', '2026-10-31'))).toEqual(['10001', '8001']);
    expect(ids(await creditPairs(pg, '2026-09-01', '2026-09-30', '8002'))).toEqual(['8002']);
    expect(await creditPairs(pg, null, null, '9999')).toEqual({ credit_memos: [], items: {}, tax_codes: {}, locations: { 1: "O'Fallon", 2: 'Wentzville' } });
  });

  it("waits for NetSuite's lines and its posting, says where NetSuite booked it, and when NetSuite voided or deleted it", async () => {
    const status = async () => {
      const data = await creditPairs(pg, null, null, '8002');
      return { row: data.credit_memos[0], check: checkOwnCreditMemos(data).creditMemos[0] };
    };
    await mirror(pg, 'CustCred/8002', { doc_number: 'CM8002', doc_date: '2026-10-15', total: '95.00', lines_synced_at: null }, []);
    const before = await status();
    expect(before.row.netsuite).toMatchObject({ lines_copied: false, deleted: false, voided: false, lines: [] });
    expect(before.check).toMatchObject({ status: 'waiting', summary: "Waiting for NetSuite's lines: the credit memo is copied, its lines aren't yet." });

    await pg.query(`UPDATE ledger_invoices SET lines_synced_at = now() WHERE external_id = 'CustCred/8002'`);
    await pg.query(
      `INSERT INTO ledger_invoice_lines (document_id, line_external_id, line_no, line_kind, item_external_id, amount, quantity, raw)
       SELECT id, '1', 1, 'item', '56', 95, 1, '{"netamount": "95.00"}' FROM ledger_invoices WHERE external_id = 'CustCred/8002'`,
    );
    expect((await status()).check).toMatchObject({ status: 'waiting', summary: "Waiting for the copy of NetSuite's general ledger to reach the credit memo." });

    await post(pg, '8002', 'CustCred', '2026-10-15', [['0', '120', -9500], ['1', '400', 9500]], '2');
    const posted = await status();
    expect(posted.row.netsuite_gl).toEqual({ location_id: '2' });
    expect(posted.check).toMatchObject({
      status: 'differs', differing: 1,
      summary: "Location: FleetSuite's copy has the invoice's location, O'Fallon, and NetSuite's credit memo books to Wentzville.",
    });

    await pg.query(`UPDATE ledger_invoices SET deleted_at = now() WHERE external_id = 'CustCred/8002'`);
    expect((await status()).check).toMatchObject({ status: 'voided', summary: "NetSuite's credit memo is gone from NetSuite." });
    await pg.query(`UPDATE ledger_invoices SET deleted_at = NULL, voided = true WHERE external_id = 'CustCred/8002'`);
    expect((await status()).check).toMatchObject({ status: 'voided', summary: "NetSuite's credit memo was voided." });
  });

  it("pairs a copy with NetSuite's credit memo alone, not its invoice of the same number", async () => {
    await mirror(pg, 'CustInvc/10001', { doc_number: 'INV10001', doc_date: '2026-10-31', total: '108.49' }, [['1', 'item', '57', '100.00', '-100.00', '1']]);
    expect((await creditPairs(pg, null, null, '10001')).credit_memos[0].netsuite).toBeNull();
  });

  it("names the customer as FleetSuite's own record does, else the ledger mirror's, else the copy of NetSuite's customers", async () => {
    const name = async () => (await creditPairs(pg, null, null, '8001')).credit_memos[0].customer_name;
    await pg.query(
      `INSERT INTO ledger_customers (source, external_id, external_ref, display_name, cleaned_name)
       VALUES ('netsuite', 'customer/9001', '9001', 'Acme Fleet (mirror)', 'acme fleet')`,
    );
    try {
      expect(await name()).toBe('Acme Fleet');
      await pg.query(`UPDATE customers SET company_name = '  ' WHERE id = $1`, [ACME]);
      expect(await name()).toBe('Acme Fleet (mirror)');
      await pg.query(`DELETE FROM ledger_customers WHERE external_id = 'customer/9001'`);
      expect(await name()).toBe('Acme Fleet Services');
    } finally {
      await pg.query(`UPDATE customers SET company_name = 'Acme Fleet' WHERE id = $1`, [ACME]);
      await pg.query(`DELETE FROM ledger_customers WHERE external_id = 'customer/9001'`);
    }
  });
});

describe('migration 518: an own invoice that took its stock itself', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  const FACTS: OwnInvoiceFacts = {
    items: new Map([
      ['55', { number: 'SHELF-1', type: 'InvtPart', taxableOverride: null }],
      ['56', { number: 'LABOR', type: 'Service', taxableOverride: null }],
    ]),
    customer: { id: ACME, taxExempt: false, name: null, certExpires: null },
    customerListed: true,
    terms: { id: '4', name: 'Net 30', days: 30 },
    rate: 0.08488,
    rates: [],
    locations: new Map([['1', "O'Fallon"], ['2', 'Wentzville']]),
  };

  it("says which of NetSuite's lines book the shelves' cost, and the check finds the copy matches NetSuite's invoice", async () => {
    const p = savePayload(workOutOwnInvoice({
      netsuiteId: '5001', netsuiteNumber: 'INV2401', madeFrom: 'po', madeFromId: 'po-1', salesOrderId: null, customerNetsuiteId: '9001',
      locationId: '1', locationFrom: 'sent', poNumber: 'PO-77', memo: null, vin: null, invoiceDate: '2026-10-20',
      lines: [{ itemId: '55', itemNumber: 'SHELF-1', quantity: 2, rate: 125.5 }, { itemId: '56', itemNumber: 'LABOR', quantity: 3, rate: 95 }],
      linesFrom: 'sent', madeBy: null,
    }, FACTS));
    // 2 × 125.50 taxed at 8.488% is 21.30; labor is a service item and isn't taxed.
    expect(p).toMatchObject({ subtotal: '536.00', tax: '21.30', total: '557.30' });
    expect(await one(pg, 'SELECT gl_own_invoice_save($1::jsonb) AS r', [JSON.stringify(p)])).toEqual({ saved: true, lines: 2 });

    // Here labor's income goes to a cost of goods sold account, as the credit item's does: a line on its own item's income
    // account is what was billed, whatever kind of account that is.
    await pg.query(`UPDATE gl_netsuite_lists SET details = details || '{"income_account": "510"}' WHERE kind = 'item' AND netsuite_id = '56'`);
    // NetSuite took the two shelves itself, at $70 each: into cost of goods sold, out of their inventory.
    await mirror(pg, 'CustInvc/5001', { doc_number: 'INV2401', doc_date: '2026-10-20', due_date: '2026-11-19', total: '557.30' }, [
      ['1', 'item', '55', '251.00', '-251.00', '2'],
      ['2', 'item', '56', '285.00', '-285.00', '3'],
      ['3', 'tax', '77', '21.30', '-21.30', null],
      ['4', 'item', '55', '140.00', '140.00', '2'],
      ['5', 'item', '55', '140.00', '-140.00', '2'],
    ]);
    await post(pg, '5001', 'CustInvc', '2026-10-20', [
      ['0', '120', 55730], ['1', '400', -25100], ['2', '510', -28500], ['3', '220', -2130], ['4', '500', 14000], ['5', '130', -14000],
    ], '1');

    const data = await one<OwnPairsData>(pg, 'SELECT gl_own_invoice_pairs(NULL, NULL, $1) AS r', ['5001']);
    expect(data.invoices[0].netsuite!.lines.map((l) => [l.line_id, l.cost])).toEqual([
      ['1', false], ['2', false], ['3', false], ['4', true], ['5', true],
    ]);
    const [check] = checkOwnInvoices(data).invoices;
    expect(check).toMatchObject({ status: 'matches', differing: 0 });
    expect(check.workedOut).toContain(costLinesText(2, "NetSuite's invoice", 'it took'));
  });
});

describe('migration 518: who may read it', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it("is the server's alone, and none of its reads writes anything", async () => {
    await pg.exec('RESET ROLE');
    for (const fn of [
      'public.gl_own_credit_memo_pairs(date, date, text)', 'public.gl_own_credit_memo_months()', 'public.gl_own_invoice_pairs(date, date, text)',
    ]) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>(pg, `SELECT has_function_privilege($1::name, '${fn}', 'EXECUTE') AS r`, [role]), `${fn} ${role}`)
          .toBe(role === 'service_role');
      }
    }
    for (const name of ['gl_own_credit_memo_pairs', 'gl_own_credit_memo_months', 'gl_own_invoice_pairs']) {
      const body = await one<string>(pg, 'SELECT prosrc AS r FROM pg_proc WHERE proname = $1', [name]);
      expect(body, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    }
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`SET ROLE ${role}`);
      await expect(pg.query('SELECT gl_own_credit_memo_months()')).rejects.toThrow(/permission denied for function gl_own_credit_memo_months/);
      await expect(pg.query(`SELECT gl_own_credit_memo_pairs(NULL, NULL, '8001')`)).rejects.toThrow(/permission denied for function gl_own_credit_memo_pairs/);
      await pg.exec('RESET ROLE');
    }
    await pg.exec('SET ROLE service_role');
  });
});
