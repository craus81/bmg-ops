// Migration 466 switches credit memos off until January 1, 2027, names the
// NetSuite item a credit with no part coming back goes on, keeps one row per
// press of Make credit memo, and Books' own copy of each credit memo
// FleetSuite makes. This runs migration 359 with 466 in an in-memory
// Postgres (PGlite) as the app's server login, saves copies worked out by
// src/lib/credit-memo.ts and src/lib/books/own-credit-memos.ts, and holds
// what gl_own_credit_memo_save keeps and refuses. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { NO_EARLIER, parseInvoiceRecord, workOutCreditMemo } from '@/lib/credit-memo';
import { ownCreditMemoPayload } from './own-credit-memos';

const ACME = 'c0000000-0000-4000-8000-00000000000a';
const PRESS = 'b0000000-0000-4000-8000-000000000001';

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
    -- What migration 466 points at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
  `);
  for (const file of ['359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.query(`INSERT INTO customers (id, netsuite_id) VALUES ($1, '9001')`, [ACME]);
  await pg.exec('SET ROLE service_role');
  return pg;
}

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

const payload = (netsuiteId: string, drafts: Parameters<typeof workOutCreditMemo>[1], added: Parameters<typeof workOutCreditMemo>[2] = []) => {
  const worked = workOutCreditMemo(INVOICE, drafts, added, { earlier: NO_EARLIER, creditItem: { id: '900', itemNumber: 'CREDIT' }, reason: 'Returned' });
  expect(worked.problems).toEqual([]);
  return ownCreditMemoPayload(
    { netsuiteId, netsuiteNumber: `CM${netsuiteId}`, invoice: INVOICE, worked, reason: 'Returned', madeFromId: PRESS, madeBy: null },
    { customerId: ACME, creditDate: '2026-10-31' },
  );
};

const save = async (pg: PGlite, p: unknown) =>
  (await pg.query<{ r: { saved: boolean; lines: number } }>('SELECT gl_own_credit_memo_save($1::jsonb) AS r', [JSON.stringify(p)])).rows[0].r;

describe('migration 466', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it('starts credit memos switched off, with no credit item named', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches')).rows).toEqual([{ piece: 'credit_memos', is_on: false, changed_by: null }]);
    expect((await pg.query('SELECT netsuite_credit_item_id, netsuite_credit_item_number FROM quote_settings WHERE id = 1')).rows)
      .toEqual([{ netsuite_credit_item_id: null, netsuite_credit_item_number: null }]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
  });

  it('keeps one row per press of Make credit memo, refusing one with no reason', async () => {
    await pg.query(
      `INSERT INTO invoice_credit_memos (id, invoice_netsuite_id, reason, claimed_at) VALUES ($1, '7001', 'Returned', now())`, [PRESS],
    );
    await expect(pg.query(`INSERT INTO invoice_credit_memos (id, invoice_netsuite_id, reason) VALUES ($1, '7001', 'Again')`, [PRESS]))
      .rejects.toThrow(/duplicate key/);
    await expect(pg.query(
      `INSERT INTO invoice_credit_memos (id, invoice_netsuite_id, reason) VALUES ('b0000000-0000-4000-8000-000000000002', '7001', '  ')`,
    )).rejects.toThrow(/check/i);
  });

  it('saves the copy whole: its lines, tax, whether parts came back and what went on the credit item', async () => {
    const p = payload('8001', [
      { line: 1, quantity: 1, price: 125.5 },
      { line: 5, quantity: 1, price: 40, backToStock: false },
      { line: 4, amount: 13 },
    ], [{ description: 'Goodwill', amount: 25, taxable: false }]);
    expect(await save(pg, p)).toEqual({ saved: true, lines: 4 });
    expect((await pg.query(`
      SELECT c.netsuite_number, co.code AS company, c.invoice_netsuite_id, c.customer_id, c.credit_date::text AS credit_date,
             c.tax_rule, c.tax_rate::text AS tax_rate, c.tax_rate_from, c.subtotal::text AS subtotal, c.tax::text AS tax, c.total::text AS total
      FROM gl_own_credit_memos c JOIN gl_companies co ON co.id = c.company_id`)).rows).toEqual([{
      netsuite_number: 'CM8001', company: 'BMG', invoice_netsuite_id: '7001', customer_id: ACME, credit_date: '2026-10-31',
      tax_rule: 'credit_tax@1', tax_rate: '0.084880', tax_rate_from: 'invoice', subtotal: '177.50', tax: '12.95', total: '190.45',
    }]);
    expect((await pg.query(`
      SELECT line_no, invoice_line, item_netsuite_id, amount::text AS amount, tax::text AS tax, back_to_stock, on_credit_item
      FROM gl_own_credit_memo_lines ORDER BY line_no`)).rows).toEqual([
      { line_no: 1, invoice_line: 1, item_netsuite_id: '55', amount: '125.50', tax: '10.65', back_to_stock: true, on_credit_item: false },
      { line_no: 2, invoice_line: 5, item_netsuite_id: '900', amount: '40.00', tax: '3.40', back_to_stock: false, on_credit_item: true },
      { line_no: 3, invoice_line: 4, item_netsuite_id: '58', amount: '-13.00', tax: '-1.10', back_to_stock: false, on_credit_item: false },
      { line_no: 4, invoice_line: null, item_netsuite_id: '900', amount: '25.00', tax: '0.00', back_to_stock: false, on_credit_item: true },
    ]);
  });

  it('leaves a copy already saved as it is', async () => {
    const p = payload('8001', [{ line: 2, quantity: 1, price: 95 }]);
    expect(await save(pg, p)).toEqual({ saved: false, lines: 0 });
    expect((await pg.query(`SELECT total::text AS total FROM gl_own_credit_memos WHERE netsuite_id = '8001'`)).rows).toEqual([{ total: '190.45' }]);
  });

  it("refuses a copy that doesn't add up, has no lines or credits nothing", async () => {
    const p = payload('8002', [{ line: 2, quantity: 1, price: 95 }]);
    await expect(save(pg, { ...p, subtotal: '96.00', total: '96.00' })).rejects.toThrow(/don't add up/);
    await expect(save(pg, { ...p, lines: [] })).rejects.toThrow(/needs its lines/);
    await expect(save(pg, { ...p, netsuite_id: 'CM8002' })).rejects.toThrow(/needs NetSuite's id/);
    await expect(save(pg, { ...p, company: 'NOPE' })).rejects.toThrow(/doesn't exist/);
    const nothing = { ...p, subtotal: '0.00', tax: '0.00', total: '0.00', lines: [{ ...p.lines[0], amount: '0.00', tax: '0.00' }] };
    await expect(save(pg, nothing)).rejects.toThrow(/check/i);
    const both = { ...p, lines: [{ ...p.lines[0], back_to_stock: true, on_credit_item: true }] };
    await expect(save(pg, both)).rejects.toThrow(/check/i);
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_credit_memos WHERE netsuite_id = '8002'`)).rows).toEqual([{ n: 0 }]);
  });

  it('lets only the server login near it', async () => {
    await pg.exec('RESET ROLE; SET ROLE authenticated');
    try {
      await expect(pg.query('SELECT * FROM books_switches')).rejects.toThrow(/permission denied/);
      await expect(pg.query('SELECT * FROM invoice_credit_memos')).rejects.toThrow(/permission denied/);
      await expect(pg.query('SELECT * FROM gl_own_credit_memos')).rejects.toThrow(/permission denied/);
      await expect(save(pg, payload('8003', [{ line: 2, quantity: 1, price: 95 }]))).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec('RESET ROLE; SET ROLE service_role');
    }
  });
});
