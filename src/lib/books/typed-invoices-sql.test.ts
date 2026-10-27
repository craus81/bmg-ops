// Migration 445: typed_invoices (one row per New invoice form, so a second
// press never makes a second invoice) and gl_own_invoices taking made_from
// 'typed'. Runs it after the Books migrations it builds on, in PGlite.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));

import { savePayload, workOutOwnInvoice, type OwnInvoiceFacts } from './own-invoices';
import { booksLines, workOutNewInvoice } from '@/lib/new-invoice';

const FACTS: OwnInvoiceFacts = {
  items: new Map([
    ['55', { number: 'SHELF-1', type: 'InvtPart', taxableOverride: null }],
    ['58', { number: 'DISCOUNT', type: 'Discount', taxableOverride: null }],
  ]),
  customer: { id: 'c0000000-0000-4000-8000-00000000000a', taxExempt: false },
  customerListed: true,
  terms: null,
  rate: 0.0795,
  locations: new Map([['1', "O'Fallon"]]),
};

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '407-books-own-invoices.sql',
    '445-typed-invoices.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.query(`INSERT INTO customers (id, company_name, netsuite_id, tax_exempt) VALUES ('c0000000-0000-4000-8000-00000000000a', 'Acme Fleet', '9001', false)`);
});
afterAll(async () => { await pg?.close(); });

describe('migration 445', () => {
  it('lets Books keep a copy of a typed invoice', async () => {
    const typed = workOutNewInvoice([
      { itemId: '55', itemNumber: 'SHELF-1', itemType: 'InvtPart', taxableOverride: null, description: 'Shelf', quantity: 2, price: 100 },
      { itemId: '58', itemNumber: 'DISCOUNT', itemType: 'Discount', taxableOverride: null, description: '', quantity: 0, price: 20 },
    ], { taxRate: 0.0795, taxExempt: false, hasCustomer: true });
    const own = workOutOwnInvoice({
      netsuiteId: '7001', netsuiteNumber: 'INV2500', madeFrom: 'typed', madeFromId: 'b1f0c5d2-1111-4222-8333-444455556666',
      salesOrderId: null, customerNetsuiteId: '9001', locationId: '1', locationFrom: 'sent', poNumber: null, memo: null, vin: null,
      invoiceDate: '2026-10-27', lines: booksLines(typed.lines), linesFrom: 'sent', madeBy: null,
    }, FACTS);
    // Books and the New invoice page agree on what the invoice comes to.
    expect(own.totalCents).toBe(typed.totalCents);
    const r = await pg.query<{ r: { saved: boolean } }>('SELECT gl_own_invoice_save($1::jsonb) AS r', [JSON.stringify(savePayload(own))]);
    expect(r.rows[0].r.saved).toBe(true);
    await expect(pg.query(`INSERT INTO gl_own_invoices (netsuite_id, company_id, made_from, invoice_date)
      SELECT '7002', company_id, 'nonsense', '2026-10-27' FROM gl_own_invoices LIMIT 1`)).rejects.toThrow();
  });

  it('keeps one row per form id', async () => {
    const id = 'c2f0c5d2-1111-4222-8333-444455556666';
    await pg.query(`INSERT INTO typed_invoices (id, customer_netsuite_id) VALUES ($1, '9001')`, [id]);
    await expect(pg.query(`INSERT INTO typed_invoices (id, customer_netsuite_id) VALUES ($1, '9001')`, [id])).rejects.toThrow(/duplicate key/);
    await expect(pg.query(`INSERT INTO typed_invoices (id, customer_netsuite_id) VALUES (gen_random_uuid(), 'Acme')`)).rejects.toThrow();
  });
});
