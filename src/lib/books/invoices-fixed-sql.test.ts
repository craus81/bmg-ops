// Migration 471 switches fixing invoices off until January 1, 2027, keeps one
// row per press of Fix invoice (sending, then fixed, refused or unsure; one
// fix of an invoice at a time; a send that never finished let go after five
// minutes), and gives Books' own copy of an invoice its next version when
// FleetSuite fixes it, keeping the one before. This runs it after the
// migrations it builds on in an in-memory Postgres (PGlite) as the app's
// server login, with copies src/lib/books/own-invoices.ts works out the way
// /api/invoices/fix does. Made-up data.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));

import { fixedOwnInvoicePayload, savePayload, workOutOwnInvoice, type OwnInvoiceFacts, type SavedOwnInvoice } from './own-invoices';

const FIXER = 'a0000000-0000-4000-8000-000000000001';
const FIX = (n: number) => `f0000000-0000-4000-8000-00000000000${n}`;
const ACME = 'c0000000-0000-4000-8000-00000000000a';

const FACTS: OwnInvoiceFacts = {
  items: new Map([
    ['55', { number: 'SHELF-1', type: 'InvtPart', taxableOverride: null }],
    ['56', { number: 'LABOR', type: 'Service', taxableOverride: null }],
    ['58', { number: 'DISCOUNT', type: 'Discount', taxableOverride: null }],
    ['501', { number: 'BRK-100', type: 'InvtPart', taxableOverride: null }],
  ]),
  customer: { id: ACME, taxExempt: false },
  customerListed: true,
  terms: { id: '2', name: 'Net 30', days: 30 },
  rate: 0.08488,
  locations: new Map([['1', "O'Fallon"]]),
};

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
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
    INSERT INTO public.profiles (id) VALUES ('${FIXER}');
    INSERT INTO public.customers (id, company_name, netsuite_id, tax_exempt) VALUES ('${ACME}', 'Acme Fleet', '9001', false);
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '407-books-own-invoices.sql',
    '445-typed-invoices.sql', '466-credit-memos-in-fleetsuite.sql', '467-vendor-credits-in-fleetsuite.sql',
    '468-card-charges-in-fleetsuite.sql', '469-journal-entries-typed-in-fleetsuite.sql',
    '470-inventory-transfers-made-in-fleetsuite.sql', '471-invoices-fixed-in-fleetsuite.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

/** A press of Fix invoice as /api/invoices/fix claims it. */
const press = (id: string, over: Record<string, unknown> = {}) => ({
  id, invoice_netsuite_id: '7001', invoice_number: 'INV9001', customer_netsuite_id: '9001', customer_name: 'Acme Fleet',
  reason: ' Billed two, fitted three ', changes: ['SHELF-1 quantity 2 → 3'], patch: { item: { items: [{ line: 1, quantity: 3 }] } },
  replace_lines: false, total_before_cents: 38079, total_expected_cents: 51695, by: FIXER, ...over,
});

const fix = async (pg: PGlite, id: string) => (await pg.query<Record<string, any>>(`
  SELECT id, invoice_netsuite_id, invoice_number, customer_netsuite_id, customer_name, reason, changes, replace_lines,
         total_before_cents, total_expected_cents, status, error, total_after_cents, own_copy, own_copy_version, created_by, finished_at
  FROM invoice_fixes WHERE id = $1`, [id])).rows[0];

describe('migration 471', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it('starts fixing invoices switched off, next to the other five', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'card_charges', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'inventory_transfers', is_on: false, changed_by: null },
      { piece: 'invoice_fixes', is_on: false, changed_by: null },
      { piece: 'journal_entries', is_on: false, changed_by: null },
      { piece: 'vendor_credits', is_on: false, changed_by: null },
    ]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    for (const [table, like] of [['books_switches', '%piece%'], ['gl_own_invoices', '%lines_from%']]) {
      const checks = (await pg.query<{ def: string }>(`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE $2`, [`public.${table}`, like])).rows;
      expect(checks).toHaveLength(1);
    }
  });

  it('takes one press at a time for an invoice, and says what became of a press', async () => {
    expect(await call(pg, 'invoice_fix_claim', press(FIX(1)))).toEqual({ claimed: true });
    expect(await fix(pg, FIX(1))).toMatchObject({
      invoice_netsuite_id: '7001', invoice_number: 'INV9001', customer_netsuite_id: '9001', customer_name: 'Acme Fleet',
      reason: 'Billed two, fitted three', changes: ['SHELF-1 quantity 2 → 3'], replace_lines: false,
      total_before_cents: 38079, total_expected_cents: 51695, status: 'sending', error: null, created_by: FIXER, finished_at: null,
    });
    // The same press again, while it's being sent; and another press on the same invoice.
    expect(await call(pg, 'invoice_fix_claim', press(FIX(1)))).toEqual({ claimed: false, state: 'sending' });
    expect(await call(pg, 'invoice_fix_claim', press(FIX(2)))).toEqual({ claimed: false, state: 'busy' });
    // A fix of another invoice goes ahead.
    expect(await call(pg, 'invoice_fix_claim', press(FIX(3), { invoice_netsuite_id: '7003', replace_lines: true }))).toEqual({ claimed: true });
    expect((await fix(pg, FIX(3))).replace_lines).toBe(true);

    expect(await call(pg, 'invoice_fix_finish', { id: FIX(1), status: 'fixed', total_after_cents: 51694, own_copy: 'fixed', own_copy_version: 2 }))
      .toEqual({ finished: true });
    expect(await fix(pg, FIX(1))).toMatchObject({ status: 'fixed', total_after_cents: 51694, own_copy: 'fixed', own_copy_version: 2 });
    expect((await fix(pg, FIX(1))).finished_at).not.toBeNull();
    // Finished once; pressed again, it was fixed.
    expect(await call(pg, 'invoice_fix_finish', { id: FIX(1), status: 'refused' })).toEqual({ finished: false });
    expect(await call(pg, 'invoice_fix_claim', press(FIX(1)))).toEqual({ claimed: false, state: 'fixed' });
    expect((await fix(pg, FIX(1))).status).toBe('fixed');

    // The invoice is free again; a press NetSuite refused can be pressed again, as it's planned then.
    expect(await call(pg, 'invoice_fix_claim', press(FIX(2)))).toEqual({ claimed: true });
    expect(await call(pg, 'invoice_fix_finish', { id: FIX(2), status: 'refused', error: '  NetSuite error (400): The period is closed. ' }))
      .toEqual({ finished: true });
    expect(await fix(pg, FIX(2))).toMatchObject({ status: 'refused', error: 'NetSuite error (400): The period is closed.' });
    // Pressed long after, it's sent now: another press of the invoice waits for it.
    await pg.query(`UPDATE invoice_fixes SET sent_at = now() - interval '10 minutes' WHERE id = $1`, [FIX(2)]);
    const fourth = { reason: 'Billed two, fitted four', changes: ['SHELF-1 quantity 2 → 4'], replace_lines: true };
    expect(await call(pg, 'invoice_fix_claim', press(FIX(2), fourth))).toEqual({ claimed: true });
    expect(await fix(pg, FIX(2))).toMatchObject({
      status: 'sending', error: null, reason: 'Billed two, fitted four', changes: ['SHELF-1 quantity 2 → 4'], replace_lines: true, finished_at: null,
    });
    expect(await call(pg, 'invoice_fix_claim', press('f0000000-0000-4000-8000-0000000000aa'))).toEqual({ claimed: false, state: 'busy' });
    // NetSuite's words are kept to 2,000 characters.
    const long = `NetSuite took too long to answer. ${'x'.repeat(2500)}`;
    expect(await call(pg, 'invoice_fix_finish', { id: FIX(2), status: 'unsure', error: long })).toEqual({ finished: true });
    expect(await fix(pg, FIX(2))).toMatchObject({ status: 'unsure', error: long.slice(0, 2000) });
  });

  it('lets go of a send that never finished after five minutes, as unsure', async () => {
    expect(await call(pg, 'invoice_fix_claim', press(FIX(4), { invoice_netsuite_id: '7004' }))).toEqual({ claimed: true });
    expect(await call(pg, 'invoice_fix_claim', press(FIX(5), { invoice_netsuite_id: '7004' }))).toEqual({ claimed: false, state: 'busy' });
    await pg.query(`UPDATE invoice_fixes SET sent_at = now() - interval '4 minutes' WHERE id = $1`, [FIX(4)]);
    expect(await call(pg, 'invoice_fix_claim', press(FIX(5), { invoice_netsuite_id: '7004' }))).toEqual({ claimed: false, state: 'busy' });
    // Another invoice's send that old is let go only when that invoice is claimed.
    await pg.query(`UPDATE invoice_fixes SET sent_at = now() - interval '6 minutes' WHERE id IN ($1, $2)`, [FIX(4), FIX(3)]);
    expect(await call(pg, 'invoice_fix_claim', press(FIX(5), { invoice_netsuite_id: '7004' }))).toEqual({ claimed: true });
    expect(await fix(pg, FIX(4))).toMatchObject({
      status: 'unsure',
      error: "FleetSuite stopped before NetSuite answered, so it can't tell whether the fix went in. Check the invoice in NetSuite.",
    });
    // Its own send that late can't finish it now.
    expect(await call(pg, 'invoice_fix_finish', { id: FIX(4), status: 'fixed' })).toEqual({ finished: false });
    // Nor does letting go reach another invoice's send.
    expect((await fix(pg, FIX(3))).status).toBe('sending');
  });

  it('refuses a press that names the wrong invoice, says nothing, or finishes oddly', async () => {
    await expect(call(pg, 'invoice_fix_claim', press(FIX(1), { invoice_netsuite_id: '7002' }))).rejects.toThrow(/is a fix of another invoice/);
    await expect(call(pg, 'invoice_fix_claim', press(FIX(6), { invoice_netsuite_id: 'INV7006' }))).rejects.toThrow(/needs NetSuite's id/);
    await expect(call(pg, 'invoice_fix_claim', press(FIX(6), { invoice_netsuite_id: '7006', reason: '  ' }))).rejects.toThrow(/check/i);
    await expect(call(pg, 'invoice_fix_claim', press(FIX(6), { invoice_netsuite_id: '7006', changes: [] }))).rejects.toThrow(/check/i);
    await expect(call(pg, 'invoice_fix_claim', press(FIX(6), { invoice_netsuite_id: '7006', patch: [] }))).rejects.toThrow(/check/i);
    await expect(call(pg, 'invoice_fix_claim', press(FIX(6), { invoice_netsuite_id: '7006', reason: 'r'.repeat(301) }))).rejects.toThrow(/check/i);
    expect(await call(pg, 'invoice_fix_claim', press(FIX(6), { invoice_netsuite_id: '7006' }))).toEqual({ claimed: true });
    await expect(call(pg, 'invoice_fix_finish', { id: FIX(6), status: 'sending' })).rejects.toThrow(/finishes fixed, refused or unsure/);
    await expect(call(pg, 'invoice_fix_finish', { id: FIX(6), status: 'fixed', own_copy: 'fixed' })).rejects.toThrow(/check/i);
    await expect(call(pg, 'invoice_fix_finish', { id: FIX(6), status: 'fixed', own_copy: 'none', own_copy_version: 2 })).rejects.toThrow(/check/i);
    await expect(call(pg, 'invoice_fix_finish', { id: FIX(6), status: 'refused', own_copy: 'none' })).rejects.toThrow(/check/i);
    expect((await fix(pg, FIX(6))).status).toBe('sending');
    expect(await call(pg, 'invoice_fix_finish', { id: FIX(6), status: 'fixed', own_copy: 'none' })).toEqual({ finished: true });
  });

  it("makes the next version of Books' own copy from the fix, keeping each one before", async () => {
    const own = workOutOwnInvoice({
      netsuiteId: '7001', netsuiteNumber: 'INV9001', madeFrom: 'po', madeFromId: 'po-1', salesOrderId: null,
      customerNetsuiteId: '9001', locationId: '1', locationFrom: 'sent', poNumber: 'PO-77', memo: null, vin: null,
      invoiceDate: '2026-12-01', linesFrom: 'sent', madeBy: null,
      lines: [{ itemId: '55', quantity: 2, rate: 125.5 }, { itemId: '56', quantity: 3, rate: 95 }],
    }, FACTS);
    expect((await call(pg, 'gl_own_invoice_save', savePayload(own))).saved).toBe(true);
    // Another invoice's copy, which a fix of this one leaves as it is.
    const other = workOutOwnInvoice({
      netsuiteId: '7002', netsuiteNumber: 'INV9002', madeFrom: 'po', madeFromId: 'po-2', salesOrderId: null,
      customerNetsuiteId: '9001', locationId: '1', locationFrom: 'sent', poNumber: 'PO-77', memo: null, vin: null,
      invoiceDate: '2026-12-01', linesFrom: 'sent', madeBy: null,
      lines: [{ itemId: '55', quantity: 2, rate: 125.5 }, { itemId: '56', quantity: 3, rate: 95 }],
    }, FACTS);
    expect((await call(pg, 'gl_own_invoice_save', savePayload(other))).saved).toBe(true);
    const saved = async () => (await pg.query<SavedOwnInvoice>(`
      SELECT netsuite_id, version, customer_netsuite_id, tax_basis, tax_rate, terms_days, unknowns FROM gl_own_invoices WHERE netsuite_id = '7001'`)).rows[0];
    expect(await saved()).toMatchObject({ version: 1, tax_basis: 'rate', terms_days: 30 });

    // Three shelves, the labor off, a bracket kit and a discount added, dated a week later, as ownCopyLines gives them.
    const fixed = {
      date: '2026-12-08', poNumber: 'PO-78', memo: 'Second visit', vin: '1FTFW1E50NFA00001',
      lines: [
        { itemId: '55', itemNumber: 'SHELF-1', description: 'Shelf unit', quantity: 3, rate: 125.5, cents: 37650, orderLine: 1 },
        { itemId: '501', itemNumber: 'BRK-100', description: 'Bracket kit', quantity: 2, rate: 10, cents: 2000, orderLine: null },
        { itemId: '58', itemNumber: 'DISCOUNT', description: null, quantity: null, rate: null, cents: -500, orderLine: null },
      ],
    };
    const payload = fixedOwnInvoicePayload(await saved(), fixed, FACTS.items, { fixId: FIX(1), by: FIXER });
    expect(await call(pg, 'gl_own_invoice_fix', payload)).toEqual({ saved: true, version: 2, lines: 3 });

    const copy = (await pg.query<Record<string, any>>(`
      SELECT version, lines_from, invoice_date::text AS invoice_date, due_date::text AS due_date, po_number, memo, vin,
             subtotal::text AS subtotal, tax::text AS tax, total::text AS total, fixed_by, fixed_at IS NOT NULL AS fixed, made_from
      FROM gl_own_invoices WHERE netsuite_id = '7001'`)).rows[0];
    // 376.50 + 20.00 - 5.00; tax 31.96 + 1.70 - 0.42.
    expect(copy).toEqual({
      version: 2, lines_from: 'fixed', invoice_date: '2026-12-08', due_date: '2027-01-07', po_number: 'PO-78', memo: 'Second visit',
      vin: '1FTFW1E50NFA00001', subtotal: '391.50', tax: '33.24', total: '424.74', fixed_by: FIXER, fixed: true, made_from: 'po',
    });
    expect((await pg.query(`
      SELECT line_no, item_netsuite_id, quantity::text AS quantity, amount::text AS amount, taxable, tax::text AS tax, sales_order_line_id
      FROM gl_own_invoice_lines WHERE invoice_id = '7001' ORDER BY line_no`)).rows).toEqual([
      { line_no: 1, item_netsuite_id: '55', quantity: '3.0000', amount: '376.50', taxable: true, tax: '31.96', sales_order_line_id: '1' },
      { line_no: 2, item_netsuite_id: '501', quantity: '2.0000', amount: '20.00', taxable: true, tax: '1.70', sales_order_line_id: null },
      { line_no: 3, item_netsuite_id: '58', quantity: null, amount: '-5.00', taxable: true, tax: '-0.42', sales_order_line_id: null },
    ]);
    expect((await pg.query(`
      SELECT o.version, o.invoice_date::text AS invoice_date, o.lines_from, (SELECT count(*)::int FROM gl_own_invoice_lines l WHERE l.invoice_id = o.netsuite_id) AS lines
      FROM gl_own_invoices o WHERE o.netsuite_id = '7002'`)).rows).toEqual([{ version: 1, invoice_date: '2026-12-01', lines_from: 'sent', lines: 2 }]);
    const before = (await pg.query<{ version: number; copy: Record<string, any>; replaced_by: string; fix_id: string }>(`
      SELECT version, copy, replaced_by, fix_id FROM gl_own_invoice_versions WHERE netsuite_id = '7001' ORDER BY version`)).rows;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ version: 1, replaced_by: FIXER, fix_id: FIX(1) });
    // 251.00 of shelves taxed 21.30, and 285.00 of labor.
    expect(before[0].copy).toMatchObject({ version: 1, lines_from: 'sent', invoice_date: '2026-12-01', po_number: 'PO-77', tax: 21.3, total: 557.3 });
    expect(before[0].copy.lines.map((l: Record<string, unknown>) => [l.line_no, l.item_netsuite_id, l.amount])).toEqual([[1, '55', 251], [2, '56', 285]]);

    // A fix worked out from the version before is refused, and nothing changes.
    expect(await call(pg, 'gl_own_invoice_fix', payload)).toEqual({ saved: false, reason: 'changed', version: 2 });
    expect((await saved()).version).toBe(2);
    // The next fix makes the version after.
    const next = fixedOwnInvoicePayload(await saved(), { ...fixed, lines: fixed.lines.slice(0, 1) }, FACTS.items, { fixId: FIX(2), by: null });
    expect(await call(pg, 'gl_own_invoice_fix', next)).toEqual({ saved: true, version: 3, lines: 1 });
    expect((await pg.query('SELECT version FROM gl_own_invoice_versions WHERE netsuite_id = $1 ORDER BY version', ['7001'])).rows)
      .toEqual([{ version: 1 }, { version: 2 }]);
    // Saving a copy again never changes one.
    expect((await call(pg, 'gl_own_invoice_save', savePayload(own))).saved).toBe(false);
    expect((await saved()).version).toBe(3);
  });

  it("refuses a copy that doesn't add up, and says when there's no copy to fix", async () => {
    const payload = {
      netsuite_id: '7001', version: 3, invoice_date: '2026-12-08', subtotal: '10.00', tax: '0.00', total: '10.00',
      lines: [{ line_no: 1, item_netsuite_id: '55', amount: '9.99', taxable: false, tax: '0.00' }],
    };
    await expect(call(pg, 'gl_own_invoice_fix', payload)).rejects.toThrow(/don't add up/);
    // Its subtotal alone wrong, or its tax.
    await expect(call(pg, 'gl_own_invoice_fix', { ...payload, total: '9.99' })).rejects.toThrow(/don't add up/);
    await expect(call(pg, 'gl_own_invoice_fix', { ...payload, lines: [{ ...payload.lines[0], amount: '10.00' }], tax: '0.01' }))
      .rejects.toThrow(/don't add up/);
    await expect(call(pg, 'gl_own_invoice_fix', { ...payload, lines: [{ ...payload.lines[0], amount: '10.00' }], total: '10.01' }))
      .rejects.toThrow(/don't add up/);
    await expect(call(pg, 'gl_own_invoice_fix', { ...payload, lines: {} })).rejects.toThrow(/must be a list/);
    await expect(call(pg, 'gl_own_invoice_fix', { ...payload, netsuite_id: 'INV9001' })).rejects.toThrow(/needs NetSuite's id/);
    expect(await call(pg, 'gl_own_invoice_fix', { ...payload, netsuite_id: '7999' })).toEqual({ saved: false, reason: 'none' });
    // A fix of a copy that changed nothing in the meantime, its lines adding up, goes, with what FleetSuite doesn't know.
    expect(await call(pg, 'gl_own_invoice_fix', { ...payload, lines: [{ ...payload.lines[0], amount: '10.00' }], unknowns: ['customer'] }))
      .toEqual({ saved: true, version: 4, lines: 1 });
    expect((await pg.query(`SELECT unknowns FROM gl_own_invoices WHERE netsuite_id = '7001'`)).rows).toEqual([{ unknowns: ['customer'] }]);
  });

  it('refuses a fix that says it is somewhere it is not', async () => {
    const insert = (over: Record<string, unknown>) => {
      const r: Record<string, unknown> = {
        id: FIX(8), invoice_netsuite_id: '7008', reason: 'Wrong PO', changes: JSON.stringify(['PO number PO-1 → PO-2']), patch: JSON.stringify({ otherRefNum: 'PO-2' }),
        ...over,
      };
      const cols = Object.keys(r);
      return pg.query(`INSERT INTO invoice_fixes (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
    };
    const done = { status: 'fixed', finished_at: '2026-12-02T15:00:00Z' };
    for (const over of [
      { status: 'fixed' }, { finished_at: '2026-12-02T15:00:00Z' }, { status: 'gone', finished_at: '2026-12-02T15:00:00Z' },
      { ...done, own_copy: 'fixed' }, { ...done, own_copy: 'none', own_copy_version: 2 }, { ...done, own_copy: 'fixed', own_copy_version: 1 },
      { status: 'refused', finished_at: '2026-12-02T15:00:00Z', own_copy: 'none' }, { ...done, own_copy: 'some' },
      { error: 'e'.repeat(2001) }, { invoice_netsuite_id: 'INV7008' }, { customer_netsuite_id: 'Acme' },
    ]) {
      await expect(insert(over)).rejects.toThrow(/check/i);
    }
    await expect(insert({ created_by: 'a0000000-0000-4000-8000-000000000009' })).rejects.toThrow(/foreign key/);
    await insert({});
    // One send of an invoice at a time, whoever writes it.
    await expect(insert({ id: FIX(9) })).rejects.toThrow(/duplicate key/);
    await insert({ id: FIX(9), ...done, own_copy: 'fixed', own_copy_version: 2, error: 'e'.repeat(2000) });
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        for (const table of ['invoice_fixes', 'gl_own_invoice_versions']) {
          await expect(pg.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
        }
        for (const fn of ['invoice_fix_claim', 'invoice_fix_finish', 'gl_own_invoice_fix']) {
          await expect(call(pg, fn, { id: FIX(7) })).rejects.toThrow(/permission denied for function/);
        }
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('invoice_fixes', 'gl_own_invoice_versions') ORDER BY relname`);
    expect(rls.rows).toEqual([
      { relname: 'gl_own_invoice_versions', relrowsecurity: true },
      { relname: 'invoice_fixes', relrowsecurity: true },
    ]);
    await pg.exec('SET ROLE service_role');
  });
});
