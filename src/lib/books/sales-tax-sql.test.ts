// Migration 496 keeps each location's sales tax rate from the day it starts,
// each month's Missouri return as it was filed, and one read of what a
// month's worksheet is worked out from. This runs migrations 314, 359–363 and
// 407 with 496 in an in-memory Postgres (PGlite) as the app's server login,
// copies a made-up month of NetSuite invoices, a credit memo, a cash sale and
// payments to the state with their GL lines and the ledger mirror's lines,
// and holds what the tables keep and gl_sales_tax_month returns, then the
// worksheet sales-tax-worksheet.ts works out from it, end to end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { holdReturn, readRates, readReturn, salesTaxWorksheet, type SalesTaxRateRow, type SalesTaxReturnRow } from './sales-tax-worksheet';

const AR = '120';
const BANK = '100';
const INVENTORY = '190';
const PARTS_SALES = '400';
const INSTALLS = '410';
const TAX_DISCOUNT = '490';
const COGS = '580';
const MO_TAX = '250';
const GA_TAX = '251';
const TAX_ACCOUNTS = [MO_TAX, GA_TAX];
const ACME = 'c0000000-0000-4000-8000-00000000000a';
const BLUEBIRD = 'c0000000-0000-4000-8000-00000000000b';
const BLUEBIRD_TOO = 'c0000000-0000-4000-8000-00000000000c';
const MAR = '2025-03-01';
const APR = '2025-04-01';

async function freshDb(settingsRate: string | null = '8.488'): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    -- What migrations 314, 407 and 496 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (
      id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN,
      tax_exempt_cert_number TEXT, tax_exempt_expires_at DATE
    );
    CREATE TABLE public.customer_files (id SERIAL PRIMARY KEY, customer_id UUID NOT NULL REFERENCES customers(id), category TEXT NOT NULL);
    CREATE TABLE public.netsuite_parts (
      netsuite_id TEXT NOT NULL UNIQUE, item_number TEXT NOT NULL, item_type TEXT, taxable_override BOOLEAN
    );
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY, sales_tax_rate_pct NUMERIC);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  if (settingsRate !== null) await pg.query('INSERT INTO quote_settings (id, sales_tax_rate_pct) VALUES (1, $1)', [settingsRate]);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '407-books-own-invoices.sql',
    '496-books-sales-tax.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

/**
 * A document in the copy of NetSuite's general ledger, posted to `month`: lines are [line, account, cents debit
 * positive, location, customer or vendor, memo].
 */
async function gl(
  pg: PGlite, id: string, type: string, number: string, date: string, month: string,
  lines: Array<[string, string, number, (string | null)?, (string | null)?, (string | null)?]>, company = 'BMG',
) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, number, date, month],
  );
  for (const [line, account, cents, location, entity, memo] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines
         (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, location_id, entity_id, memo)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8, $9, $10 FROM gl_companies WHERE code = $11`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0',
        location ?? null, entity ?? null, memo ?? null, company],
    );
  }
}

/** The ledger mirror's copy of an invoice or credit memo: lines are [line, line no, kind, item, number, netamount]. */
async function mirror(
  pg: PGlite, type: 'CustInvc' | 'CustCred', id: string, linesCopied: boolean,
  lines: Array<[string, number | null, string, string | null, string | null, string]>,
) {
  const doc = await pg.query<{ id: string }>(
    `INSERT INTO ledger_invoices (source, external_id, external_ref, doc_type, doc_date, lines_synced_at)
     VALUES ('netsuite', $1, $2, $3, '2025-03-01', $4) RETURNING id`,
    [`${type}/${id}`, id, type === 'CustCred' ? 'credit_memo' : 'invoice', linesCopied ? '2025-04-01T12:00:00Z' : null],
  );
  for (const [line, lineNo, kind, item, number, netamount] of lines) {
    await pg.query(
      `INSERT INTO ledger_invoice_lines (document_id, line_external_id, line_no, line_kind, item_external_id, item_number, amount, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [doc.rows[0].id, line, lineNo, kind, item, number, Math.abs(Number(netamount)), JSON.stringify({ netamount })],
    );
  }
}

/** One of FleetSuite's own entries: cents on the account, debit positive, the other side on `against`. */
let keys = 0;
async function post(pg: PGlite, date: string, account: string, cents: number, against: string) {
  keys += 1;
  const id = (ns: string) => one<string>(pg, 'SELECT id::text AS r FROM gl_accounts WHERE netsuite_account_id = $1', [ns]);
  const side = (n: number) => (n > 0 ? { debit: money(n) } : { credit: money(n) });
  await one(pg, 'SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
    company: 'BMG', entry_date: date, source_type: 'netsuite_test', source_id: String(keys), posting_rule: 'test@1',
    idempotency_key: `test:${keys}`,
    lines: [{ account_id: await id(account), ...side(cents) }, { account_id: await id(against), ...side(-cents) }],
  })]);
}

interface Other { id: string; type: string; number: string; date: string; memo: string | null; name: string | null; amount: string }
interface Others { list: Other[]; count: number; total: string }
interface MonthData {
  documents: Array<{
    id: string; type: string; number: string; date: string; copied: boolean;
    gl: Array<{ line_id: string; account: string; account_type: string | null; debit: string; credit: string; location_id: string | null; entity_id: string | null }>;
    lines: Array<{ line_id: string; line_no: number | null; kind: string; item_id: string | null; item_number: string | null; netamount: string | null }>;
  }>;
  items: Record<string, { number: string; type: string | null }>;
  parts: Record<string, { number: string; type: string | null; taxable_override: boolean | null }>;
  tax_codes: Record<string, { name: string; rate: string | null }>;
  locations: Record<string, string>;
  customers: Record<string, {
    name: string | null; rows: number; exempt: number; cert_number: string | null; cert_expires: string | null;
    cert_files: number; netsuite_taxable: string | null;
  }>;
  account: {
    opening: string; before: string; moves: Array<{ type: string; documents: number; amount: string }>;
    others: Others; next: Others; books: string;
  };
}

const month = (pg: PGlite, m: string, accounts: string[] | null = TAX_ACCOUNTS, limit = 100, company: string | null = 'BMG') =>
  one<MonthData>(pg, 'SELECT gl_sales_tax_month($1, $2::date, $3::text[], $4) AS r', [company, m, accounts, limit]);

describe("migration 496's rates and returns", () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); }, 60_000);
  afterAll(async () => { await db?.close(); });

  it("starts O'Fallon, Wentzville and Kansas City at Settings' rate from January 1, 2025, once", async () => {
    const rows = await db.query('SELECT location_id, starts_on::text, rate_pct::text, note, entered_by FROM sales_tax_rates ORDER BY location_id');
    expect(rows.rows).toEqual(['1', '2', '3'].map((location_id) => ({
      location_id, starts_on: '2025-01-01', rate_pct: '8.488', note: 'From Settings → Sales Tax, the rate quotes use', entered_by: null,
    })));
    // A rate a super admin removes doesn't come back when the migration runs again.
    await db.exec("DELETE FROM sales_tax_rates WHERE location_id = '3'");
    await db.exec('RESET ROLE');
    await db.exec(readFileSync(path.resolve(__dirname, '../../../migrations/496-books-sales-tax.sql'), 'utf8'));
    await db.exec('SET ROLE service_role');
    expect((await db.query("SELECT count(*)::int AS n FROM sales_tax_rates")).rows).toEqual([{ n: 2 }]);
  });

  it("starts at FleetSuite's own fallback when Settings has no rate", async () => {
    const pg = await freshDb(null);
    expect((await pg.query('SELECT DISTINCT rate_pct::text AS r FROM sales_tax_rates')).rows).toEqual([{ r: '7.950' }]);
    await pg.close();
  });

  it('keeps a rate per location per starting day, and refuses one it can\'t use', async () => {
    await db.query("INSERT INTO sales_tax_rates (location_id, starts_on, rate_pct, note) VALUES ('1', '2025-04-01', 8.738, 'Quarter''s new rate')");
    await expect(db.query("INSERT INTO sales_tax_rates (location_id, starts_on, rate_pct) VALUES ('1', '2025-04-01', 9)")).rejects.toThrow(/duplicate key/);
    for (const [location, starts, rate, note] of [
      ['ofallon', '2025-04-01', '8', null], ['2', '2024-12-31', '8', null], ['2', '2025-04-01', '100', null],
      ['2', '2025-04-01', '-1', null], ['2', '2025-04-01', '8', '  '], ['2', '2025-04-01', '8', 'x'.repeat(201)],
    ]) {
      await expect(db.query('INSERT INTO sales_tax_rates (location_id, starts_on, rate_pct, note) VALUES ($1, $2, $3, $4)', [location, starts, rate, note]))
        .rejects.toThrow(/violates check constraint/);
    }
  });

  it("keeps a month's return as filed, after the month, and refuses one it can't hold", async () => {
    const save = (over: Record<string, unknown> = {}) => {
      const row = {
        company: 'BMG', month: MAR, filed_on: '2025-04-18', gross_cents: 81100, adjustments_cents: -28500,
        taxable_cents: 52600, tax_cents: 1069, allowance_cents: 21, paid_cents: 1048, note: null, ...over,
      };
      const cols = Object.keys(row);
      return db.query(`INSERT INTO sales_tax_returns (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
    };
    await save();
    expect((await db.query("SELECT taxable_cents::int AS t, allowance_cents::int AS a FROM sales_tax_returns WHERE month = '2025-03-01'")).rows)
      .toEqual([{ t: 52600, a: 21 }]);
    await expect(save()).rejects.toThrow(/duplicate key/);
    const may = { month: '2025-05-01', filed_on: '2025-06-01' };
    for (const [bad, check] of [
      [{ month: '2025-04-15', filed_on: '2025-06-01' }, 'month'], [{ month: '2024-12-01', filed_on: '2025-01-20' }, 'month'],
      [{ ...may, filed_on: '2025-05-31' }, 'filed_after'], [{ ...may, allowance_cents: -1 }, 'allowance_cents'],
      [{ ...may, tax_cents: 10_000_000_001 }, 'tax_cents'], [{ ...may, note: ' ' }, 'note'],
    ] as const) {
      await expect(save(bad)).rejects.toThrow(new RegExp(`violates check constraint "sales_tax_returns_${check}`));
    }
    await expect(save({ ...may, company: 'NOPE' })).rejects.toThrow(/foreign key/);
    // Filed on the first day after the month is fine; 1084 keeps its own.
    await save({ month: '2025-05-01', filed_on: '2025-06-01' });
    await save({ company: '1084' });
  });

  it("is the server login's alone", async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      for (const t of ['sales_tax_rates', 'sales_tax_returns']) await expect(db.query(`SELECT * FROM ${t}`)).rejects.toThrow(/permission denied/);
      await expect(db.query("SELECT gl_sales_tax_month('BMG', '2025-03-01', ARRAY['250'], 10)")).rejects.toThrow(/permission denied/);
    }
    await db.exec('RESET ROLE; SET ROLE service_role');
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('sales_tax_rates', 'sales_tax_returns') ORDER BY relname",
    );
    expect(rls.rows).toEqual([{ relname: 'sales_tax_rates', relrowsecurity: true }, { relname: 'sales_tax_returns', relrowsecurity: true }]);
    expect(await one<boolean>(db, "SELECT has_function_privilege('service_role', 'public.gl_sales_tax_month(text, date, text[], integer)', 'EXECUTE') AS r")).toBe(true);
  });
});

describe("migration 496's read of a month's sales tax", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.exec('RESET ROLE');
    await db.exec(`
      INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id, is_control) VALUES
        ('1000', 'Checking', 'bank', '${BANK}', false),
        ('1100', 'Accounts receivable', 'accounts_receivable', '${AR}', true),
        ('1200', 'Inventory', 'other_current_asset', '${INVENTORY}', true),
        ('2200', 'Sales tax payable', 'other_current_liability', '${MO_TAX}', false),
        ('2210', 'Georgia sales tax payable', 'other_current_liability', '${GA_TAX}', false),
        ('4000', 'Parts sales', 'income', '${PARTS_SALES}', false),
        ('4100', 'Installation', 'income', '${INSTALLS}', false),
        ('4900', 'Sales tax discount', 'other_income', '${TAX_DISCOUNT}', false),
        ('5000', 'Cost of goods sold', 'cost_of_goods_sold', '${COGS}', false);
      INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
        ('location', '1', 'O''Fallon', true, '{}'), ('location', '2', 'Wentzville', true, '{}'),
        ('location', '3', 'Kansas City', true, '{}'), ('location', '5', 'Social Circle', true, '{}'),
        ('item', '55', 'SHELF-1', true, '{"item_type": "InvtPart"}'),
        ('item', '56', 'LABOR', true, '{"item_type": "Service"}'),
        ('item', '57', '06S646', true, '{"item_type": "NonInvtPart"}'),
        ('tax_code', '77', 'MO St Charles', true, '{"rate": "8.488%"}'),
        ('tax_code', '78', 'MO Jackson', true, '{"rate": "8.85%"}'),
        ('customer', '9001', 'Acme Fleet Services', true, '{"taxable": "T"}'),
        ('customer', '9002', 'Bluebird Schools', true, '{"taxable": "F"}'),
        ('customer', '9003', 'Cardinal Plumbing', true, '{"taxable": "T"}'),
        ('vendor', '8001', 'Missouri Department of Revenue', true, '{}');
      INSERT INTO netsuite_parts (netsuite_id, item_number, item_type, taxable_override) VALUES
        ('55', 'SHELF-1', 'InvtPart', NULL), ('56', 'LABOR', 'Service', false), ('57', '06S646', 'NonInvtPart', true);
      INSERT INTO customers (id, company_name, netsuite_id, tax_exempt, tax_exempt_cert_number, tax_exempt_expires_at) VALUES
        ('${ACME}', 'Acme Fleet', '9001', false, NULL, NULL),
        ('${BLUEBIRD}', '  ', '9002', true, ' EX-4471 ', '2025-06-30'),
        ('${BLUEBIRD_TOO}', NULL, '9002', false, '  ', NULL);
      INSERT INTO customer_files (customer_id, category) VALUES
        ('${BLUEBIRD}', 'tax_exempt_cert'), ('${BLUEBIRD}', 'general'), ('${BLUEBIRD_TOO}', 'tax_exempt_cert');
      INSERT INTO ledger_customers (source, external_id, external_ref, display_name, cleaned_name) VALUES
        ('netsuite', 'customer/9002', '9002', 'Bluebird School District', 'bluebird school district');
      INSERT INTO gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
      SELECT id, '${MO_TAX}', 0, 1000.00, 3 FROM gl_companies WHERE code = 'BMG';
      INSERT INTO gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
      SELECT id, '${MO_TAX}', 0, 50.00, 1 FROM gl_companies WHERE code = '1084';
    `);
    await db.exec('SET ROLE service_role');

    // January: December's tax paid. February: an invoice taxed $30.
    await gl(db, '7099', 'TaxPymt', 'TP7099', '2025-01-20', '2025-01-01', [['0', BANK, -100000, null, '8001'], ['1', MO_TAX, 100000, null, '8001']]);
    await gl(db, '7006', 'CustInvc', 'INV7006', '2025-02-14', '2025-02-01', [
      ['0', AR, 38344, '1', '9001'], ['1', PARTS_SALES, -35344, '1'], ['2', MO_TAX, -3000, '1'],
    ]);
    // March: a shelf and an install at O'Fallon, a shelf back on a credit memo, a school's order at Wentzville whose
    // lines the mirror hasn't copied, and an install at Social Circle on a cash sale NetSuite taxed for Georgia.
    await gl(db, '7001', 'CustInvc', 'INV7001', '2025-03-05', MAR, [
      ['0', AR, 55730, '1', '9001'], ['1', PARTS_SALES, -25100, '1'], ['2', INSTALLS, -28500, '1'], ['3', MO_TAX, -2130, '1'],
      ['4', COGS, 12000, '1'], ['5', INVENTORY, -12000, '1'],
    ]);
    await mirror(db, 'CustInvc', '7001', true, [
      ['2', 2, 'item', '56', 'LABOR', '-285.00'], ['1', 1, 'item', '55', 'SHELF-1', '-251.00'], ['3', 3, 'tax', '77', null, '-21.30'],
      ['4', null, 'item', '55', 'SHELF-1', '120.00'],
    ]);
    await gl(db, '7002', 'CustCred', 'CM7002', '2025-03-12', MAR, [
      ['0', AR, -13561, '1', '9001'], ['1', PARTS_SALES, 12500, '1'], ['2', MO_TAX, 1061, '1'],
    ]);
    await mirror(db, 'CustCred', '7002', true, [['1', 1, 'item', '55', 'SHELF-1', '125.00'], ['2', 2, 'tax', '77', null, '10.61']]);
    await gl(db, '7003', 'CustInvc', 'INV7003', '2025-03-20', MAR, [['0', AR, 40000, '2', '9002'], ['1', PARTS_SALES, -40000, '2']]);
    await mirror(db, 'CustInvc', '7003', false, [['1', 1, 'item', '55', 'SHELF-1', '-400.00']]);
    await gl(db, '7007', 'CashSale', 'CS7007', '2025-03-25', MAR, [
      ['0', BANK, 21200, '5', '9003'], ['1', INSTALLS, -20000, '5'], ['2', GA_TAX, -1200, '5'],
    ]);
    // March's other moves on the tax accounts: February's tax paid less the 2% allowance, and a round-off.
    await gl(db, '7100', 'TaxPymt', 'TP7100', '2025-03-18', MAR, [
      ['0', BANK, -2940, null, '8001'], ['1', MO_TAX, 3000, null, '8001', 'February 2025'], ['2', TAX_DISCOUNT, -60],
    ]);
    await gl(db, '7101', 'Journal', 'JE7101', '2025-03-31', MAR, [
      ['1', MO_TAX, 30, null, null, '  '], ['2', MO_TAX, 20, null, null, 'Round off February'], ['3', TAX_DISCOUNT, -50, null, null, 'Round off February'],
    ]);
    // 1084's own sale in March isn't BMG's.
    await gl(db, '7004', 'CustInvc', 'INV7004', '2025-03-08', MAR, [['0', AR, 5100, null, '9001'], ['1', PARTS_SALES, -5000], ['2', MO_TAX, -100]], '1084');
    // April: an invoice at Kansas City, March's tax paid, and a journal entry off the tax accounts.
    await gl(db, '7005', 'CustInvc', 'INV7005', '2025-04-02', APR, [['0', AR, 12299, '3', '9003'], ['1', PARTS_SALES, -11300, '3'], ['2', MO_TAX, -999, '3']]);
    await gl(db, '7102', 'TaxPymt', 'TP7102', '2025-04-15', APR, [
      ['0', BANK, -1048, null, '8001'], ['1', MO_TAX, 1069, null, '8001', 'March 2025'], ['2', TAX_DISCOUNT, -21],
    ]);
    await gl(db, '7103', 'Journal', 'JE7103', '2025-04-20', APR, [['1', COGS, 500], ['2', INVENTORY, -500]]);

    // FleetSuite's books on the tax account: February's and March's tax, and their payments.
    await post(db, '2025-02-14', MO_TAX, -3000, AR);
    await post(db, '2025-03-05', MO_TAX, -2130, AR);
    await post(db, '2025-03-12', MO_TAX, 1061, AR);
    await post(db, '2025-03-18', MO_TAX, 3000, BANK);
    await post(db, '2025-04-15', MO_TAX, 1069, BANK);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  it("gives each of the company's sales and returns posted in the month, with its GL lines and the mirror's", async () => {
    const data = await month(db, MAR);
    expect(data.documents.map((d) => [d.id, d.type, d.number, d.date, d.copied])).toEqual([
      ['7001', 'CustInvc', 'INV7001', '2025-03-05', true],
      ['7002', 'CustCred', 'CM7002', '2025-03-12', true],
      ['7003', 'CustInvc', 'INV7003', '2025-03-20', false],
      ['7007', 'CashSale', 'CS7007', '2025-03-25', false],
    ]);
    const [invoice, credit, school, cash] = data.documents;
    expect(invoice.gl).toEqual([
      { line_id: '0', account: AR, account_type: 'accounts_receivable', debit: '557.30', credit: '0.00', location_id: '1', entity_id: '9001' },
      { line_id: '1', account: PARTS_SALES, account_type: 'income', debit: '0.00', credit: '251.00', location_id: '1', entity_id: null },
      { line_id: '2', account: INSTALLS, account_type: 'income', debit: '0.00', credit: '285.00', location_id: '1', entity_id: null },
      { line_id: '3', account: MO_TAX, account_type: 'other_current_liability', debit: '0.00', credit: '21.30', location_id: '1', entity_id: null },
      { line_id: '4', account: COGS, account_type: 'cost_of_goods_sold', debit: '120.00', credit: '0.00', location_id: '1', entity_id: null },
      { line_id: '5', account: INVENTORY, account_type: 'other_current_asset', debit: '0.00', credit: '120.00', location_id: '1', entity_id: null },
    ]);
    // In line order, a line with no number last.
    expect(invoice.lines).toEqual([
      { line_id: '1', line_no: 1, kind: 'item', item_id: '55', item_number: 'SHELF-1', netamount: '-251.00' },
      { line_id: '2', line_no: 2, kind: 'item', item_id: '56', item_number: 'LABOR', netamount: '-285.00' },
      { line_id: '3', line_no: 3, kind: 'tax', item_id: '77', item_number: null, netamount: '-21.30' },
      { line_id: '4', line_no: null, kind: 'item', item_id: '55', item_number: 'SHELF-1', netamount: '120.00' },
    ]);
    expect(credit.lines.map((l) => [l.line_id, l.kind, l.netamount])).toEqual([['1', 'item', '125.00'], ['2', 'tax', '10.61']]);
    // Lines the mirror hasn't finished copying aren't given; a cash sale it doesn't copy has none.
    expect(school.lines).toEqual([]);
    expect(school.gl.map((l) => [l.line_id, l.account, l.location_id])).toEqual([['0', AR, '2'], ['1', PARTS_SALES, '2']]);
    expect(cash.lines).toEqual([]);
    expect(cash.gl.map((l) => [l.account, l.debit, l.credit])).toEqual([[BANK, '212.00', '0.00'], [INSTALLS, '0.00', '200.00'], [GA_TAX, '0.00', '12.00']]);
  });

  it("names the items, tax codes, locations and customers on them", async () => {
    const data = await month(db, MAR);
    // The items the copied lines name, tax lines' codes apart; 06S646 is on no document.
    expect(data.items).toEqual({ 55: { number: 'SHELF-1', type: 'InvtPart' }, 56: { number: 'LABOR', type: 'Service' } });
    expect(data.parts).toEqual({
      55: { number: 'SHELF-1', type: 'InvtPart', taxable_override: null },
      56: { number: 'LABOR', type: 'Service', taxable_override: false },
    });
    expect(data.tax_codes).toEqual({ 77: { name: 'MO St Charles', rate: '8.488%' } });
    expect(data.locations).toEqual({ 1: "O'Fallon", 2: 'Wentzville', 3: 'Kansas City', 5: 'Social Circle' });
    expect(data.customers).toEqual({
      9001: { name: 'Acme Fleet', rows: 1, exempt: 0, cert_number: null, cert_expires: null, cert_files: 0, netsuite_taxable: 'T' },
      // No FleetSuite name, so the mirror's; one of its two FleetSuite customers is exempt, with a certificate.
      9002: {
        name: 'Bluebird School District', rows: 2, exempt: 1, cert_number: 'EX-4471', cert_expires: '2025-06-30', cert_files: 2,
        netsuite_taxable: 'F',
      },
      // Not in FleetSuite at all: NetSuite's list's name.
      9003: { name: 'Cardinal Plumbing', rows: 0, exempt: 0, cert_number: null, cert_expires: null, cert_files: 0, netsuite_taxable: 'T' },
    });
  });

  it("rolls the tax accounts through the month, with the month's other moves and the month after's", async () => {
    const data = await month(db, MAR);
    expect(data.account).toEqual({
      opening: '1000.00',
      // December's tax paid in January, and February's invoice.
      before: '-970.00',
      moves: [
        { type: 'CashSale', documents: 1, amount: '12.00' },
        { type: 'CustCred', documents: 1, amount: '-10.61' },
        { type: 'CustInvc', documents: 1, amount: '21.30' },
        { type: 'Journal', documents: 1, amount: '-0.50' },
        { type: 'TaxPymt', documents: 1, amount: '-30.00' },
      ],
      others: {
        list: [
          { id: '7100', type: 'TaxPymt', number: 'TP7100', date: '2025-03-18', memo: 'February 2025', name: 'Missouri Department of Revenue', amount: '-30.00' },
          { id: '7101', type: 'Journal', number: 'JE7101', date: '2025-03-31', memo: 'Round off February', name: null, amount: '-0.50' },
        ],
        count: 2,
        total: '-30.50',
      },
      // March's return paid in April; April's own invoice and the journal entry off the accounts aren't in it.
      next: {
        list: [{ id: '7102', type: 'TaxPymt', number: 'TP7102', date: '2025-04-15', memo: 'March 2025', name: 'Missouri Department of Revenue', amount: '-10.69' }],
        count: 1,
        total: '-10.69',
      },
      // FleetSuite's books through March 31: February's and March's tax less February's payment.
      books: '10.69',
    });
  });

  it('gives the first of the other moves, with how many there are and what they come to', async () => {
    const { account } = await month(db, MAR, TAX_ACCOUNTS, 1);
    expect(account.others).toEqual({ list: [expect.objectContaining({ id: '7100' })], count: 2, total: '-30.50' });
  });

  it('reads only the accounts it is given, and only the company asked for', async () => {
    const mo = await month(db, MAR, [MO_TAX]);
    expect(mo.account.moves.map((m) => m.type)).toEqual(['CustCred', 'CustInvc', 'Journal', 'TaxPymt']);
    const none = await month(db, MAR, []);
    expect(none.account).toMatchObject({ opening: '0', before: '0', moves: [], others: { list: [], count: 0, total: '0' }, books: '0' });
    // The cash sale is still a document: what it's taxed is the worksheet's to say.
    expect(none.documents).toHaveLength(4);

    const other = await month(db, MAR, TAX_ACCOUNTS, 100, '1084');
    expect(other.documents.map((d) => d.id)).toEqual(['7004']);
    expect(other.account).toMatchObject({ opening: '50.00', before: '0', moves: [{ type: 'CustInvc', documents: 1, amount: '1.00' }], books: '0' });
  });

  it('gives nothing for a month with nothing in it', async () => {
    const data = await month(db, '2025-06-01');
    expect(data).toMatchObject({ documents: [], items: {}, parts: {}, tax_codes: {}, customers: {} });
    expect(data.account).toMatchObject({ opening: '1000.00', before: '-978.51', moves: [], next: { list: [], count: 0, total: '0' } });
  });

  it("works out the month's return from it, and holds the return as filed against it", async () => {
    const rates = readRates((await db.query<SalesTaxRateRow>('SELECT location_id, starts_on::text, rate_pct::text, note FROM sales_tax_rates')).rows);
    const w = salesTaxWorksheet(MAR, await month(db, MAR), { rates, taxAccounts: TAX_ACCOUNTS });
    // Bluebird is exempt on only one of its two FleetSuite customers, so its order at Wentzville is taxed, all of it
    // while its lines aren't copied.
    expect(w.lines.map((l) => [l.location, l.gross, l.adjustments, l.taxable, l.tax, l.charged, l.unsorted])).toEqual([
      ["O'Fallon", 41100, -28500, 12600, 1069, 1069, 0], ['Wentzville', 40000, 0, 40000, 3395, 0, 40000], ['Kansas City', 0, 0, 0, 0, 0, 0],
    ]);
    expect(w.figures).toEqual({ gross: 81100, adjustments: -28500, taxable: 52600, tax: 4464, allowance: 89, pay: 4375, charged: 1069 });
    expect(w.apart).toEqual([{ state: 'GA', locationId: '5', location: 'Social Circle', documents: 1, gross: 20000, charged: 1200 }]);
    expect(w.documents.map((d) => d.note)).toEqual([
      null, null, "Its lines aren't in FleetSuite's copy of NetSuite yet, so all $400.00 is counted as taxed; NetSuite charged $0.00.",
      "FleetSuite doesn't tax work at Social Circle, Georgia, and NetSuite charged $12.00.",
    ]);
    expect(w.warnings).toEqual([
      "$400.00 on 1 document is counted as taxed because FleetSuite doesn't have the lines' items yet.",
      'Only 1 of the 2 FleetSuite customers for Bluebird School District are tax exempt, so their sales are counted as taxed.',
    ]);
    expect(w.accounts).toMatchObject({ start: 3000, charged: 2269, end: 2219, books: 1069, next: { count: 1, total: -1069 } });

    await db.query(
      `INSERT INTO sales_tax_returns (company, month, filed_on, gross_cents, adjustments_cents, taxable_cents, tax_cents, allowance_cents, paid_cents)
       VALUES ('BMG', $1, '2025-04-18', 81100, -28500, 52600, 4464, 89, 4375)`,
      [MAR],
    );
    const filed = (await db.query<SalesTaxReturnRow>(
      `SELECT company, month::text AS month, filed_on::text AS filed_on, gross_cents, adjustments_cents, taxable_cents, tax_cents, allowance_cents,
              paid_cents, note
       FROM sales_tax_returns WHERE company = 'BMG' AND month = $1`,
      [MAR],
    )).rows[0];
    const held = holdReturn(readReturn(filed), w.figures, w.accounts);
    expect(held.fields.filter((f) => f.differs)).toEqual([]);
    expect(held.notes).toEqual(["NetSuite's sales tax account came down $10.69 in April 2025, and the return's tax is $44.64."]);
  });

  it("refuses a month, accounts, limit or company it can't read", async () => {
    await expect(month(db, '2025-03-15')).rejects.toThrow(/first day of a month/);
    await expect(month(db, '2024-12-01')).rejects.toThrow(/from January 2025/);
    await expect(month(db, MAR, TAX_ACCOUNTS, 0)).rejects.toThrow(/limit must be from 1 to 1000/);
    await expect(month(db, MAR, TAX_ACCOUNTS, 1001)).rejects.toThrow(/limit must be from 1 to 1000/);
    await expect(month(db, MAR, null)).rejects.toThrow(/NetSuite account ids/);
    await expect(month(db, MAR, ['250', 'Sales tax'])).rejects.toThrow(/NetSuite account ids/);
    await expect(one(db, "SELECT gl_sales_tax_month('BMG', '2025-03-01', ARRAY[NULL]::text[], 10) AS r")).rejects.toThrow(/NetSuite account ids/);
    await expect(month(db, MAR, TAX_ACCOUNTS, 100, 'NOPE')).rejects.toThrow(/no company NOPE/);
    await expect(month(db, MAR, TAX_ACCOUNTS, 100, null)).rejects.toThrow(/no company \(none\)/);
  });
});
