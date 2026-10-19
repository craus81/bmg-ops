// Migration 407 keeps FleetSuite's own copy of each invoice it makes and puts
// it next to NetSuite's. This runs migrations 314 and 359–363 with 407 in an
// in-memory Postgres (PGlite) as the app's server login, saves copies worked
// out by src/lib/books/own-invoices.ts, copies a made-up NetSuite invoice
// and its posting, and holds what gl_own_invoice_save, gl_own_invoice_pairs
// and gl_own_invoice_months do and return, then checks the pairs end to end.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));

import { savePayload, workOutOwnInvoice, type OwnInvoiceFacts, type OwnInvoiceInput } from './own-invoices';
import { checkOwnInvoices, type OwnPairsData } from './own-invoice-check';

const ACME = 'c0000000-0000-4000-8000-00000000000a';

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
    -- What migrations 314 and 407 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '407-books-own-invoices.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.query(`INSERT INTO customers (id, company_name, netsuite_id, tax_exempt) VALUES ($1, 'Acme Fleet', '9001', false)`, [ACME]);
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('location', '1', 'O''Fallon', true, '{}'), ('location', '2', 'Wentzville', true, '{}'),
      ('term', '4', 'Net 30', true, '{"days_until_net_due": 30}'),
      ('tax_code', '77', 'MO St Charles', true, '{"rate": "8.488%"}'),
      ('item', '55', 'SHELF-1', true, '{"item_type": "InvtPart"}'),
      ('item', '56', 'LABOR', true, '{"item_type": "Service"}'),
      ('customer', '9001', 'Acme Fleet Services', true, '{"terms_id": "4", "taxable": "T"}');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const save = (pg: PGlite, p: Record<string, unknown>) => one<{ saved: boolean; lines: number }>(pg, 'SELECT gl_own_invoice_save($1::jsonb) AS r', [JSON.stringify(p)]);
const pairs = (pg: PGlite, from: string | null, to: string | null, id: string | null = null) =>
  one<OwnPairsData>(pg, 'SELECT gl_own_invoice_pairs($1::date, $2::date, $3) AS r', [from, to, id]);

const FACTS: OwnInvoiceFacts = {
  items: new Map([
    ['55', { number: 'SHELF-1', type: 'InvtPart', taxableOverride: null }],
    ['56', { number: 'LABOR', type: 'Service', taxableOverride: null }],
    ['58', { number: 'DISCOUNT', type: 'Discount', taxableOverride: null }],
  ]),
  customer: { id: ACME, taxExempt: false },
  customerListed: true,
  terms: { id: '4', name: 'Net 30', days: 30 },
  rate: 0.08488,
  locations: new Map([['1', "O'Fallon"], ['2', 'Wentzville']]),
};

const input = (over: Partial<OwnInvoiceInput> = {}): OwnInvoiceInput => ({
  netsuiteId: '5001',
  netsuiteNumber: 'INV2401',
  madeFrom: 'po',
  madeFromId: 'po-1',
  salesOrderId: null,
  customerNetsuiteId: '9001',
  locationId: '1',
  locationFrom: 'sent',
  poNumber: 'PO-77',
  memo: 'Invoice from BMG FleetSuite',
  vin: null,
  invoiceDate: '2026-10-20',
  lines: [
    { itemId: '55', itemNumber: 'SHELF-1', quantity: 2, rate: 125.5 },
    { itemId: '56', itemNumber: 'LABOR', quantity: 3, rate: 95 },
  ],
  linesFrom: 'sent',
  madeBy: null,
  ...over,
});

const payload = (over: Partial<OwnInvoiceInput> = {}) => savePayload(workOutOwnInvoice(input(over), FACTS));

/** NetSuite's invoice as the ledger mirror copies it: lines are [line id, kind, item, amount, netamount, quantity]. */
async function copyInvoice(pg: PGlite, id: string, fields: Record<string, unknown>, lines: Array<[string, string, string | null, string, string | null, string | null]>) {
  const row = {
    source: 'netsuite', external_id: `CustInvc/${id}`, external_ref: id, doc_type: 'invoice', doc_number: 'INV2401',
    doc_date: '2026-10-20', due_date: '2026-11-19', total: '545.31', customer_netsuite_id: '9001', party_name: 'Acme Fleet Services',
    lines_synced_at: '2026-10-20T16:00:00Z', ...fields,
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

/** Its receivable line in the copy of NetSuite's general ledger, booked to a location. */
async function postInvoice(pg: PGlite, id: string, location: string | null) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, 'CustInvc', 'INV2401', '2026-10-20', '2026-10-01', 'x', 's')`,
    [id],
  );
  await pg.query(
    `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, location_id)
     SELECT $1, '0', id, '120', '2026-10-01', '2026-10-20', '545.31', '0', $2 FROM gl_companies WHERE code = 'BMG'`,
    [id, location],
  );
}

describe('migration 407: FleetSuite\'s own invoices', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it('saves a copy worked out by FleetSuite\'s rules, whole', async () => {
    const p = payload();
    // 2 × 125.50 taxed at 8.488% is 21.30; labor is a service item and isn't taxed.
    expect(p).toMatchObject({ subtotal: '536.00', tax: '21.30', total: '557.30' });
    expect(await save(pg, p)).toEqual({ saved: true, lines: 2 });

    const head = (await pg.query<Record<string, unknown>>(`SELECT * FROM gl_own_invoices WHERE netsuite_id = '5001'`)).rows[0];
    expect(head).toMatchObject({
      netsuite_number: 'INV2401', made_from: 'po', customer_netsuite_id: '9001', customer_id: ACME, location_netsuite_id: '1',
      location_from: 'sent', terms_netsuite_id: '4', terms_name: 'Net 30', terms_days: 30, tax_rule: 'tax@1', tax_basis: 'rate',
      lines_from: 'sent', unknowns: [],
    });
    expect(String(head.due_date instanceof Date ? head.due_date.toISOString().slice(0, 10) : head.due_date)).toBe('2026-11-19');
    const lines = (await pg.query<{ line_no: number; amount: string; taxable: boolean; tax: string }>(
      `SELECT line_no, amount::text, taxable, tax::text FROM gl_own_invoice_lines WHERE invoice_id = '5001' ORDER BY line_no`,
    )).rows;
    expect(lines).toEqual([
      { line_no: 1, amount: '251.00', taxable: true, tax: '21.30' },
      { line_no: 2, amount: '285.00', taxable: false, tax: '0.00' },
    ]);
  });

  it('keeps the first copy of an invoice: saving it again changes nothing', async () => {
    expect(await save(pg, payload({ netsuiteNumber: 'INV9999', lines: [{ itemId: '55', quantity: 1, rate: 1 }] }))).toEqual({ saved: false, lines: 0 });
    expect(await one(pg, `SELECT netsuite_number AS r FROM gl_own_invoices WHERE netsuite_id = '5001'`)).toBe('INV2401');
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_invoice_lines WHERE invoice_id = '5001'`)).toBe(2);
  });

  it('refuses a copy whose lines don\'t add up, or that isn\'t whole', async () => {
    const p = payload({ netsuiteId: '5002' });
    await expect(save(pg, { ...p, subtotal: '536.01', total: '557.31' })).rejects.toThrow(/don't add up/);
    await expect(save(pg, { ...p, tax: '21.31', total: '557.31' })).rejects.toThrow(/don't add up/);
    await expect(save(pg, { ...p, total: '557.31' })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, netsuite_id: 'INV5002' })).rejects.toThrow(/NetSuite's id/);
    await expect(save(pg, { ...p, company: 'XYZ' })).rejects.toThrow(/doesn't exist/);
    await expect(save(pg, { ...p, lines: 'none' })).rejects.toThrow(/must be a list/);
    await expect(save(pg, { ...p, due_date: '2026-10-19' })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, unknowns: ['guesses'] })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, made_from: 'email' })).rejects.toThrow(/check/i);
    // Untaxed by basis means no tax at all.
    await expect(save(pg, { ...p, tax_basis: 'georgia' })).rejects.toThrow(/check/i);
    // A line NetSuite priced has no amount of FleetSuite's, and an untaxed line no tax.
    const lines = p.lines as Array<Record<string, unknown>>;
    await expect(save(pg, { ...p, lines: [{ ...lines[0], taxable: false }, lines[1]] })).rejects.toThrow(/check/i);
    await expect(save(pg, { ...p, lines: [lines[0], { ...lines[1], priced: false }] })).rejects.toThrow(/check/i);
    // Nothing of a refused copy is kept.
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_invoices WHERE netsuite_id = '5002'`)).toBe(0);
    expect(await one(pg, `SELECT count(*)::int AS r FROM gl_own_invoice_lines WHERE invoice_id = '5002'`)).toBe(0);
  });

  it('saves what FleetSuite couldn\'t work out, and a sales order billed whole with its discount', async () => {
    const p = payload({
      netsuiteId: '5003', netsuiteNumber: null, madeFrom: 'vehicle', salesOrderId: '700', locationId: null, locationFrom: null,
      invoiceDate: '2026-09-30', linesFrom: 'sales_order_copy',
      lines: [
        { itemId: '55', quantity: 1, rate: 100, cents: 10000, salesOrderLineId: '3' },
        { itemId: '58', quantity: null, rate: null, cents: -1000, salesOrderLineId: '4' },
        { itemId: '56', quantity: 1, rate: null },
      ],
    });
    // The discount's tax follows the shelf's: 8.49 off 100.00, less 0.85 off the 10.00 discount.
    expect(p).toMatchObject({ unknowns: ['location', 'prices'], subtotal: '90.00', tax: '7.64', total: '97.64', lines_from: 'sales_order_copy' });
    expect(await save(pg, p)).toEqual({ saved: true, lines: 3 });
    const lines = (await pg.query<{ amount: string; priced: boolean; sales_order_line_id: string | null }>(
      `SELECT amount::text, priced, sales_order_line_id FROM gl_own_invoice_lines WHERE invoice_id = '5003' ORDER BY line_no`,
    )).rows;
    expect(lines).toEqual([
      { amount: '100.00', priced: true, sales_order_line_id: '3' },
      { amount: '-10.00', priced: true, sales_order_line_id: '4' },
      { amount: '0.00', priced: false, sales_order_line_id: null },
    ]);
  });

  it('counts copies by the month they were made, newest first', async () => {
    expect(await one(pg, 'SELECT gl_own_invoice_months() AS r')).toEqual([
      { month: '2026-10-01', invoices: 1 },
      { month: '2026-09-01', invoices: 1 },
    ]);
  });

  it('pairs each copy with nothing until NetSuite\'s invoice is copied', async () => {
    const data = await pairs(pg, '2026-10-01', '2026-10-31');
    expect(data.invoices).toHaveLength(1);
    const [row] = data.invoices;
    expect(row.netsuite).toBeNull();
    expect(row.netsuite_gl).toBeNull();
    expect(row.customer_name).toBe('Acme Fleet');
    expect(row.customer_list).toEqual({ terms_id: '4', taxable: 'T' });
    expect(row.own).toMatchObject({
      netsuite_id: '5001', number: 'INV2401', date: '2026-10-20', due_date: '2026-11-19', terms_days: 30, tax_rate: '0.084880',
      subtotal: '536.00', tax: '21.30', total: '557.30', unknowns: [],
    });
    expect(row.own.lines.map((l) => [l.line_no, l.item_id, l.amount, l.taxable])).toEqual([[1, '55', '251.00', true], [2, '56', '285.00', false]]);
    expect(data.locations).toEqual({ 1: "O'Fallon", 2: 'Wentzville' });
    expect(data.terms).toEqual({ 4: { name: 'Net 30', days: 30 } });
    expect(data.items).toEqual({ 55: { number: 'SHELF-1', type: 'InvtPart' }, 56: { number: 'LABOR', type: 'Service' } });
    expect(checkOwnInvoices(data).invoices[0].status).toBe('waiting');
  });

  it('pairs a copy with NetSuite\'s invoice, its lines and its posting, and the check reads them', async () => {
    // NetSuite taxed the labor too: 21.30 on the shelf and 24.19 on the labor, line by line at 8.488%.
    await copyInvoice(pg, '5001', { total: '581.49' }, [
      ['1', 'item', '55', '251.00', '-251.00', '2'],
      ['2', 'item', '56', '285.00', '-285.00', '3'],
      ['3', 'item', '-2', '536.00', null, null],
      ['4', 'tax', '77', '45.49', '-45.49', null],
    ]);
    await postInvoice(pg, '5001', '2');

    const data = await pairs(pg, null, null, '5001');
    expect(data.invoices).toHaveLength(1);
    const [row] = data.invoices;
    expect(row.netsuite).toMatchObject({
      number: 'INV2401', date: '2026-10-20', due_date: '2026-11-19', total: '581.49', customer_netsuite_id: '9001',
      customer_name: 'Acme Fleet Services', voided: false, deleted: false, lines_copied: true,
    });
    expect(row.netsuite!.lines.map((l) => [l.line_id, l.kind, l.item_id, l.amount, l.netamount])).toEqual([
      ['1', 'item', '55', '251.00', '-251.00'],
      ['2', 'item', '56', '285.00', '-285.00'],
      ['3', 'item', '-2', '536.00', null],
      ['4', 'tax', '77', '45.49', '-45.49'],
    ]);
    expect(row.netsuite_gl).toEqual({ location_id: '2' });
    expect(data.tax_codes).toEqual({ 77: { name: 'MO St Charles', rate: '8.488%' } });

    const [check] = checkOwnInvoices(data).invoices;
    expect(check.status).toBe('differs');
    const field = (f: string) => check.fields.find((x) => x.field === f)!;
    expect(field('lines').same).toBe(true);
    expect(field('subtotal').same).toBe(true);
    expect(field('due_date').same).toBe(true);
    expect(field('tax')).toMatchObject({ same: false, fleetsuite: '$21.30', netsuite: '$45.49' });
    expect(field('tax').why).toBe("NetSuite also taxed LABOR ($285.00), which FleetSuite doesn't tax.");
    expect(field('location')).toMatchObject({ same: false, fleetsuite: "O'Fallon", netsuite: 'Wentzville' });
    expect(field('total')).toMatchObject({ same: false, why: "NetSuite's is $24.19 more." });
  });

  it('reads only the days asked, or the one invoice', async () => {
    expect((await pairs(pg, '2026-09-01', '2026-09-30')).invoices.map((i) => i.own.netsuite_id)).toEqual(['5003']);
    expect((await pairs(pg, '2026-09-01', '2026-10-31')).invoices.map((i) => i.own.netsuite_id)).toEqual(['5001', '5003']);
    expect((await pairs(pg, '2026-09-01', '2026-10-31', '5003')).invoices.map((i) => i.own.netsuite_id)).toEqual(['5003']);
    expect((await pairs(pg, null, null, '6000')).invoices).toEqual([]);
  });

  it('says when NetSuite\'s lines aren\'t copied yet, and when NetSuite deleted or voided its invoice', async () => {
    await save(pg, payload({ netsuiteId: '5004', invoiceDate: '2026-10-21' }));
    await copyInvoice(pg, '5004', { doc_date: '2026-10-21', lines_synced_at: null }, []);
    await postInvoice(pg, '5004', '1');
    const status = async () => {
      const data = await pairs(pg, null, null, '5004');
      return { netsuite: data.invoices[0].netsuite, check: checkOwnInvoices(data).invoices[0] };
    };
    const before = await status();
    expect(before.netsuite).toMatchObject({ lines_copied: false, deleted: false, voided: false, lines: [] });
    expect(before.check.status).toBe('waiting');

    await pg.query(`UPDATE ledger_invoices SET deleted_at = now() WHERE external_id = 'CustInvc/5004'`);
    expect((await status()).check).toMatchObject({ status: 'voided', summary: "NetSuite's invoice is gone from NetSuite." });
    await pg.query(`UPDATE ledger_invoices SET deleted_at = NULL, voided = true WHERE external_id = 'CustInvc/5004'`);
    expect((await status()).check).toMatchObject({ status: 'voided', summary: "NetSuite's invoice was voided." });
  });

  it('takes NetSuite\'s customers into the lists', async () => {
    await pg.exec('RESET ROLE');
    await pg.exec('SET ROLE service_role');
    const applied = await one(pg, 'SELECT gl_netsuite_lists_apply($1::jsonb) AS r', [JSON.stringify({
      kind: 'customer',
      rows: [
        { netsuite_id: '9001', name: 'Acme Fleet Services', details: { terms_id: '4', taxable: 'T' } },
        { netsuite_id: '9002', name: 'Bravo Transit', details: { taxable: 'F' } },
      ],
    })]);
    expect(applied).toEqual({ received: 2, added: 1, changed: 0 });
    expect(await one(pg, 'SELECT gl_netsuite_lists_finish($1::jsonb) AS r', [JSON.stringify({ kind: 'customer', netsuite_ids: ['9001', '9002'] })]))
      .toEqual({ listed: 2, here: 2, gone: 0, cut_short: false });
    await expect(one(pg, 'SELECT gl_netsuite_lists_apply($1::jsonb) AS r', [JSON.stringify({ kind: 'employee', rows: [] })])).rejects.toThrow(/unknown NetSuite list/);
  });

  it('is the server\'s alone: the app\'s logins can\'t read or write it', async () => {
    await pg.exec('RESET ROLE');
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`SET ROLE ${role}`);
      // Each refused for itself: a function the tables' refusal would also stop is still closed on its own.
      await expect(pg.query(`SELECT * FROM gl_own_invoices`)).rejects.toThrow(/permission denied for table gl_own_invoices/);
      await expect(pg.query(`SELECT * FROM gl_own_invoice_lines`)).rejects.toThrow(/permission denied for table gl_own_invoice_lines/);
      await expect(pg.query(`SELECT gl_own_invoice_months()`)).rejects.toThrow(/permission denied for function gl_own_invoice_months/);
      await expect(pg.query(`SELECT gl_own_invoice_pairs(NULL, NULL, '5001')`)).rejects.toThrow(/permission denied for function gl_own_invoice_pairs/);
      await expect(pg.query(`SELECT gl_own_invoice_save('{}'::jsonb)`)).rejects.toThrow(/permission denied for function gl_own_invoice_save/);
      await pg.exec('RESET ROLE');
    }
    await pg.exec('SET ROLE service_role');
  });
});
