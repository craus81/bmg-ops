// Migration 473 switches changing customer and vendor details off until January 1, 2027, and keeps one row per press
// of Save on Customer Terms or Vendor Details (sending, then changed, refused or unsure; one change of a record at a
// time; a send that never finished let go after five minutes), never with a vendor's tax ID whole. This runs it after
// the migrations it builds on in an in-memory Postgres (PGlite) as the app's server login, with presses as
// /api/customer-terms and /api/vendor-details claim them. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const CHANGER = 'a0000000-0000-4000-8000-000000000001';
const PRESS = (n: number) => `d0000000-0000-4000-8000-00000000000${n}`;

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
    CREATE TABLE public.vendor_invoices (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.payouts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.po_receipts (id UUID PRIMARY KEY, ns_status TEXT NOT NULL);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
    INSERT INTO public.profiles (id) VALUES ('${CHANGER}');
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '384-books-vendor-bills.sql',
    '401-books-stock-by-item.sql', '402-books-stock-values.sql', '403-books-stock-item-setup.sql',
    '404-books-stock-ledger-parts.sql', '405-books-stock-account-items.sql', '407-books-own-invoices.sql',
    '435-books-own-bills.sql', '436-books-snap-a-bill.sql', '445-typed-invoices.sql', '466-credit-memos-in-fleetsuite.sql',
    '467-vendor-credits-in-fleetsuite.sql', '468-card-charges-in-fleetsuite.sql', '469-journal-entries-typed-in-fleetsuite.sql',
    '470-inventory-transfers-made-in-fleetsuite.sql', '471-invoices-fixed-in-fleetsuite.sql', '472-bills-fixed-in-fleetsuite.sql',
    '473-customer-vendor-details-in-fleetsuite.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T = any>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);

/** A press of Save on Customer Terms as /api/customer-terms claims it. */
const press = (id: string, over: Record<string, unknown> = {}) => ({
  id, record_type: 'customer', netsuite_id: '4410', name: ' Harbor Fleet Services ', reason: ' Credit application approved ',
  changes: ['Terms Due on receipt → Net 30'], patch: { terms: { id: '2' } }, by: CHANGER, ...over,
});

const change = async (pg: PGlite, id: string) => (await pg.query<Record<string, any>>(`
  SELECT id, record_type, netsuite_id, name, reason, changes, patch, status, error, created_by, finished_at
  FROM detail_changes WHERE id = $1`, [id])).rows[0];

describe('migration 473', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('starts customer and vendor details switched off, next to the other seven', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'bill_fixes', is_on: false, changed_by: null },
      { piece: 'card_charges', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'customer_vendor_details', is_on: false, changed_by: null },
      { piece: 'inventory_transfers', is_on: false, changed_by: null },
      { piece: 'invoice_fixes', is_on: false, changed_by: null },
      { piece: 'journal_entries', is_on: false, changed_by: null },
      { piece: 'vendor_credits', is_on: false, changed_by: null },
    ]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    const checks = (await pg.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%piece%'`)).rows;
    expect(checks).toHaveLength(1);
  });

  it('takes one press at a time for a record, and says what became of a press', async () => {
    expect(await call(pg, 'detail_change_claim', press(PRESS(1)))).toEqual({ claimed: true });
    expect(await change(pg, PRESS(1))).toMatchObject({
      record_type: 'customer', netsuite_id: '4410', name: 'Harbor Fleet Services', reason: 'Credit application approved',
      changes: ['Terms Due on receipt → Net 30'], patch: { terms: { id: '2' } }, status: 'sending', error: null, created_by: CHANGER, finished_at: null,
    });
    // The same press again, while it's being sent; and another press on the same customer.
    expect(await call(pg, 'detail_change_claim', press(PRESS(1)))).toEqual({ claimed: false, state: 'sending' });
    expect(await call(pg, 'detail_change_claim', press(PRESS(2)))).toEqual({ claimed: false, state: 'busy' });
    // The vendor NetSuite gives the same id is another record, and goes ahead.
    expect(await call(pg, 'detail_change_claim', press(PRESS(3), { record_type: 'vendor', name: '', patch: { email: '' } }))).toEqual({ claimed: true });
    expect(await change(pg, PRESS(3))).toMatchObject({ record_type: 'vendor', netsuite_id: '4410', name: null, patch: { email: '' } });

    expect(await call(pg, 'detail_change_finish', { id: PRESS(1), status: 'changed' })).toEqual({ finished: true });
    expect(await change(pg, PRESS(1))).toMatchObject({ status: 'changed', error: null });
    expect((await change(pg, PRESS(1))).finished_at).not.toBeNull();
    // Finished once; pressed again, it was changed.
    expect(await call(pg, 'detail_change_finish', { id: PRESS(1), status: 'refused' })).toEqual({ finished: false });
    expect(await call(pg, 'detail_change_claim', press(PRESS(1)))).toEqual({ claimed: false, state: 'changed' });
    expect((await change(pg, PRESS(1))).status).toBe('changed');

    // The customer is free again; a press NetSuite refused can be pressed again, as it's worked out then.
    expect(await call(pg, 'detail_change_claim', press(PRESS(2)))).toEqual({ claimed: true });
    expect(await call(pg, 'detail_change_finish', { id: PRESS(2), status: 'refused', error: '  NetSuite error (400): Invalid value for terms. ' }))
      .toEqual({ finished: true });
    expect(await change(pg, PRESS(2))).toMatchObject({ status: 'refused', error: 'NetSuite error (400): Invalid value for terms.' });
    const again = { reason: 'Approved at Net 45', changes: ['Terms Due on receipt → Net 45'], patch: { terms: { id: '3' } }, by: null };
    expect(await call(pg, 'detail_change_claim', press(PRESS(2), again))).toEqual({ claimed: true });
    expect(await change(pg, PRESS(2))).toMatchObject({
      status: 'sending', error: null, reason: 'Approved at Net 45', changes: ['Terms Due on receipt → Net 45'], patch: { terms: { id: '3' } },
      created_by: CHANGER, finished_at: null,
    });
    expect(await call(pg, 'detail_change_claim', press('d0000000-0000-4000-8000-0000000000aa'))).toEqual({ claimed: false, state: 'busy' });
    // NetSuite's words are kept to 2,000 characters.
    const long = `NetSuite took too long to answer. ${'x'.repeat(2500)}`;
    expect(await call(pg, 'detail_change_finish', { id: PRESS(2), status: 'unsure', error: long })).toEqual({ finished: true });
    expect(await change(pg, PRESS(2))).toMatchObject({ status: 'unsure', error: long.slice(0, 2000) });
    expect(await call(pg, 'detail_change_finish', { id: PRESS(3), status: 'changed', error: ' ' })).toEqual({ finished: true });
    expect((await change(pg, PRESS(3))).error).toBeNull();
  });

  it('lets go of a send that never finished after five minutes, as unsure', async () => {
    const vendor = (id: string, ns: string) => press(id, { record_type: 'vendor', netsuite_id: ns, patch: { phone: '555-010-0200' } });
    expect(await call(pg, 'detail_change_claim', vendor(PRESS(4), '2207'))).toEqual({ claimed: true });
    expect(await call(pg, 'detail_change_claim', vendor(PRESS(6), '2208'))).toEqual({ claimed: true });
    expect(await call(pg, 'detail_change_claim', vendor(PRESS(5), '2207'))).toEqual({ claimed: false, state: 'busy' });
    await pg.query(`UPDATE detail_changes SET sent_at = now() - interval '4 minutes' WHERE id = $1`, [PRESS(4)]);
    expect(await call(pg, 'detail_change_claim', vendor(PRESS(5), '2207'))).toEqual({ claimed: false, state: 'busy' });
    // Another record's send that old is let go only when that record is claimed.
    await pg.query(`UPDATE detail_changes SET sent_at = now() - interval '6 minutes' WHERE id IN ($1, $2)`, [PRESS(4), PRESS(6)]);
    expect(await call(pg, 'detail_change_claim', vendor(PRESS(5), '2207'))).toEqual({ claimed: true });
    expect(await change(pg, PRESS(4))).toMatchObject({
      status: 'unsure',
      error: "FleetSuite stopped before NetSuite answered, so it can't tell whether the change went in. Check it in NetSuite.",
    });
    // Its own send that late can't finish it now.
    expect(await call(pg, 'detail_change_finish', { id: PRESS(4), status: 'changed' })).toEqual({ finished: false });
    // Nor does letting go reach another record's send.
    expect((await change(pg, PRESS(6))).status).toBe('sending');
    expect(await call(pg, 'detail_change_finish', { id: PRESS(6), status: 'changed' })).toEqual({ finished: true });
    expect(await call(pg, 'detail_change_finish', { id: PRESS(5), status: 'changed' })).toEqual({ finished: true });
  });

  it('refuses a press that names another record, says nothing, or finishes oddly', async () => {
    await expect(call(pg, 'detail_change_claim', press(PRESS(1), { netsuite_id: '4411' }))).rejects.toThrow(/is a change of another record/);
    await expect(call(pg, 'detail_change_claim', press(PRESS(1), { record_type: 'vendor' }))).rejects.toThrow(/is a change of another record/);
    await expect(call(pg, 'detail_change_claim', press(PRESS(7), { record_type: 'item' }))).rejects.toThrow(/of a customer or a vendor, not item/);
    await expect(call(pg, 'detail_change_claim', press(PRESS(7), { record_type: null }))).rejects.toThrow(/not \(nothing\)/);
    await expect(call(pg, 'detail_change_claim', press(PRESS(7), { netsuite_id: 'C-4410' }))).rejects.toThrow(/needs NetSuite's id for the customer/);
    await expect(call(pg, 'detail_change_claim', press(PRESS(7), { netsuite_id: null }))).rejects.toThrow(/needs NetSuite's id/);
    for (const over of [{ reason: '  ' }, { reason: 'r'.repeat(301) }, { changes: [] }, { changes: {} }, { patch: [] }, { patch: 'terms' }]) {
      await expect(call(pg, 'detail_change_claim', press(PRESS(7), { netsuite_id: '4412', ...over }))).rejects.toThrow(/check/i);
    }
    await expect(call(pg, 'detail_change_claim', press(PRESS(7), { netsuite_id: '4412', by: 'a0000000-0000-4000-8000-000000000009' })))
      .rejects.toThrow(/foreign key/);
    expect(await call(pg, 'detail_change_claim', press(PRESS(7), { netsuite_id: '4412' }))).toEqual({ claimed: true });
    await expect(call(pg, 'detail_change_finish', { id: PRESS(7), status: 'sending' })).rejects.toThrow(/finishes changed, refused or unsure/);
    await expect(call(pg, 'detail_change_finish', { id: PRESS(7) })).rejects.toThrow(/not \(nothing\)/);
    expect((await change(pg, PRESS(7))).status).toBe('sending');
    expect(await call(pg, 'detail_change_finish', { id: PRESS(7), status: 'changed' })).toEqual({ finished: true });
  });

  it("never keeps a vendor's tax ID whole", async () => {
    const vendor = (id: string, taxIdNum: unknown) => press(id, { record_type: 'vendor', netsuite_id: '2209', patch: { is1099Eligible: true, taxIdNum } });
    for (const whole of ['12-3456789', '123456789', '12345', 'ending 1-2-3-4-5']) {
      await expect(call(pg, 'detail_change_claim', vendor(PRESS(8), whole))).rejects.toThrow(/detail_changes_no_tax_id/);
    }
    expect(await change(pg, PRESS(8))).toBeUndefined();
    expect(await call(pg, 'detail_change_claim', vendor(PRESS(8), '(ending 6789)'))).toEqual({ claimed: true });
    expect((await change(pg, PRESS(8))).patch).toEqual({ is1099Eligible: true, taxIdNum: '(ending 6789)' });
    await expect(pg.query(`UPDATE detail_changes SET patch = '{"taxIdNum": "12-3456789"}' WHERE id = $1`, [PRESS(8)])).rejects.toThrow(/detail_changes_no_tax_id/);
    // Pressed again after NetSuite refused it, it's still kept short.
    expect(await call(pg, 'detail_change_finish', { id: PRESS(8), status: 'refused', error: 'NetSuite error (400): Invalid taxIdNum.' })).toEqual({ finished: true });
    await expect(call(pg, 'detail_change_claim', vendor(PRESS(8), '98-7654321'))).rejects.toThrow(/detail_changes_no_tax_id/);
    expect(await change(pg, PRESS(8))).toMatchObject({ status: 'refused', patch: { is1099Eligible: true, taxIdNum: '(ending 6789)' } });
  });

  it('holds only rows that make sense, whoever writes them', async () => {
    const insert = (over: Record<string, unknown>) => {
      const row = {
        id: PRESS(9), record_type: 'customer', netsuite_id: '4413', reason: 'Raised', changes: ['Credit limit $5,000.00 → $6,000.00'],
        patch: { creditLimit: 6000 }, status: 'sending', finished_at: null, error: null, created_by: null, ...over,
      };
      const cols = Object.keys(row);
      return pg.query(
        `INSERT INTO detail_changes (${cols.join(', ')}) VALUES (${cols.map((c, i) => (c === 'changes' || c === 'patch' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})`,
        Object.values(row).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)),
      );
    };
    const done = { status: 'changed', finished_at: '2026-12-02T15:00:01Z' };
    for (const over of [
      { record_type: 'item' }, { netsuite_id: 'C-4413' }, { netsuite_id: '' }, { status: 'sent' }, { finished_at: '2026-12-02T15:00:01Z' },
      { status: 'changed' }, { ...done, status: 'sent' }, { ...done, error: 'e'.repeat(2001) },
    ]) {
      await expect(insert(over)).rejects.toThrow(/check/i);
    }
    await expect(insert({ created_by: 'a0000000-0000-4000-8000-000000000009' })).rejects.toThrow(/foreign key/);
    await insert({});
    // One send of a record at a time, whoever writes it.
    await expect(insert({ id: 'd0000000-0000-4000-8000-0000000000bb' })).rejects.toThrow(/duplicate key/);
    await insert({ id: 'd0000000-0000-4000-8000-0000000000bb', ...done, error: 'e'.repeat(2000) });
    await insert({ id: 'd0000000-0000-4000-8000-0000000000cc', record_type: 'vendor' });
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        await expect(pg.query('SELECT * FROM detail_changes')).rejects.toThrow(/permission denied/);
        for (const fn of ['detail_change_claim', 'detail_change_finish']) {
          await expect(call(pg, fn, press(PRESS(1)))).rejects.toThrow(/permission denied for function/);
        }
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE relname = 'detail_changes'`);
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    await pg.exec('SET ROLE service_role');
  });
});
