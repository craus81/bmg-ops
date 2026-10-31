// Migration 479 switches estimates staying in FleetSuite off until it's turned on: a tenth books switch, next to the
// nine before it. This runs it after the migrations it builds on in an in-memory Postgres (PGlite) as the app's
// server login, the way /api/estimates/push reads it. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const CHANGER = 'a0000000-0000-4000-8000-000000000001';
const migration = (file: string) => readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');

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
    '473-customer-vendor-details-in-fleetsuite.sql', '478-item-accounts-in-fleetsuite.sql', '479-estimates-in-fleetsuite.sql',
  ]) {
    await pg.exec(migration(file));
    await pg.exec(migration(file)); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const checksOn = async (pg: PGlite, table: string, column: string) => (await pg.query<{ def: string }>(`
  SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE $2`, [`public.${table}`, `%${column}%`])).rows;

describe('migration 479', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('starts estimates in FleetSuite only switched off, next to the other nine', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'bill_fixes', is_on: false, changed_by: null },
      { piece: 'card_charges', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'customer_vendor_details', is_on: false, changed_by: null },
      { piece: 'estimates_in_fleetsuite', is_on: false, changed_by: null },
      { piece: 'inventory_transfers', is_on: false, changed_by: null },
      { piece: 'invoice_fixes', is_on: false, changed_by: null },
      { piece: 'item_accounts', is_on: false, changed_by: null },
      { piece: 'journal_entries', is_on: false, changed_by: null },
      { piece: 'vendor_credits', is_on: false, changed_by: null },
    ]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('estimates')`)).rejects.toThrow(/check/i);
    const checks = await checksOn(pg, 'books_switches', 'piece');
    expect(checks).toHaveLength(1);
    expect(checks[0].def).toContain("'estimates_in_fleetsuite'");
    expect(checks[0].def).toContain("'item_accounts'");
  });

  it('keeps a switch that was turned on when the migration runs again', async () => {
    await pg.query(`UPDATE books_switches SET is_on = true, changed_by = $1, changed_at = now() WHERE piece = 'estimates_in_fleetsuite'`, [CHANGER]);
    await pg.query(`UPDATE books_switches SET is_on = true WHERE piece = 'credit_memos'`);
    await pg.exec('RESET ROLE');
    await pg.exec(migration('479-estimates-in-fleetsuite.sql'));
    await pg.exec('SET ROLE service_role');
    expect((await pg.query(`SELECT piece, is_on, changed_by FROM books_switches WHERE is_on ORDER BY piece`)).rows).toEqual([
      { piece: 'credit_memos', is_on: true, changed_by: null },
      { piece: 'estimates_in_fleetsuite', is_on: true, changed_by: CHANGER },
    ]);
    // What switchIsOn asks.
    expect((await pg.query(`SELECT is_on FROM books_switches WHERE piece = 'estimates_in_fleetsuite'`)).rows).toEqual([{ is_on: true }]);
    await pg.query(`UPDATE books_switches SET is_on = false, changed_by = NULL, changed_at = NULL WHERE piece IN ('estimates_in_fleetsuite', 'credit_memos')`);
  });

  it("is the server's alone to read", async () => {
    await pg.exec('RESET ROLE');
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`SET ROLE ${role}`);
      await expect(pg.query(`SELECT is_on FROM books_switches WHERE piece = 'estimates_in_fleetsuite'`)).rejects.toThrow(/permission denied/i);
      await pg.exec('RESET ROLE');
    }
    await pg.exec('SET ROLE service_role');
  });
});
