// Migration 478 switches changing an item's accounts off until January 1, 2027, and keeps a press of Save on Item
// Accounts as migration 473 keeps one on Customer Terms or Vendor Details: one row per press, one change of an item
// at a time. This runs it after the migrations it builds on in an in-memory Postgres (PGlite) as the app's server
// login, with presses as /api/item-accounts claims them. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const CHANGER = 'a0000000-0000-4000-8000-000000000001';
const PRESS = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`;

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
    '473-customer-vendor-details-in-fleetsuite.sql', '478-item-accounts-in-fleetsuite.sql',
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

/** A press of Save on Item Accounts as /api/item-accounts claims it. */
const press = (id: string, over: Record<string, unknown> = {}) => ({
  id, record_type: 'item', netsuite_id: '501', name: ' 51-2002 ', reason: ' Swapped at set-up ',
  changes: ['Cost of goods sold account 19000 Inventory Asset → 58000 Parts COGS'], patch: { cogsAccount: { id: '105' } }, by: CHANGER,
  ...over,
});

const change = async (pg: PGlite, id: string) => (await pg.query<Record<string, any>>(`
  SELECT id, record_type, netsuite_id, name, reason, changes, patch, status, error, created_by, finished_at
  FROM detail_changes WHERE id = $1`, [id])).rows[0];

const checksOn = async (pg: PGlite, table: string, column: string) => (await pg.query<{ def: string }>(`
  SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE $2`, [`public.${table}`, `%${column}%`])).rows;

describe('migration 478', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('starts item accounts switched off, next to the other eight', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'bill_fixes', is_on: false, changed_by: null },
      { piece: 'card_charges', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'customer_vendor_details', is_on: false, changed_by: null },
      { piece: 'inventory_transfers', is_on: false, changed_by: null },
      { piece: 'invoice_fixes', is_on: false, changed_by: null },
      { piece: 'item_accounts', is_on: false, changed_by: null },
      { piece: 'journal_entries', is_on: false, changed_by: null },
      { piece: 'vendor_credits', is_on: false, changed_by: null },
    ]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    expect(await checksOn(pg, 'books_switches', 'piece')).toHaveLength(1);
    // Turned on, it stays on when the migration runs again.
    await pg.query(`UPDATE books_switches SET is_on = true, changed_by = $1 WHERE piece = 'item_accounts'`, [CHANGER]);
    await pg.exec('RESET ROLE');
    await pg.exec(readFileSync(path.resolve(__dirname, '../../../migrations', '478-item-accounts-in-fleetsuite.sql'), 'utf8'));
    await pg.exec('SET ROLE service_role');
    expect((await pg.query(`SELECT is_on, changed_by FROM books_switches WHERE piece = 'item_accounts'`)).rows).toEqual([{ is_on: true, changed_by: CHANGER }]);
    await pg.query(`UPDATE books_switches SET is_on = false, changed_by = NULL WHERE piece = 'item_accounts'`);
  });

  it('takes one press at a time for an item, as for a customer or a vendor', async () => {
    expect(await call(pg, 'detail_change_claim', press(PRESS(1)))).toEqual({ claimed: true });
    expect(await change(pg, PRESS(1))).toMatchObject({
      record_type: 'item', netsuite_id: '501', name: '51-2002', reason: 'Swapped at set-up',
      changes: ['Cost of goods sold account 19000 Inventory Asset → 58000 Parts COGS'], patch: { cogsAccount: { id: '105' } },
      status: 'sending', error: null, created_by: CHANGER, finished_at: null,
    });
    expect(await call(pg, 'detail_change_claim', press(PRESS(1)))).toEqual({ claimed: false, state: 'sending' });
    expect(await call(pg, 'detail_change_claim', press(PRESS(2)))).toEqual({ claimed: false, state: 'busy' });
    // The customer and the vendor NetSuite gives the same id are other records, and go ahead.
    expect(await call(pg, 'detail_change_claim', press(PRESS(3), { record_type: 'customer', patch: { terms: { id: '2' } } }))).toEqual({ claimed: true });
    expect(await call(pg, 'detail_change_claim', press(PRESS(4), { record_type: 'vendor', patch: { email: '' } }))).toEqual({ claimed: true });

    expect(await call(pg, 'detail_change_finish', { id: PRESS(1), status: 'changed' })).toEqual({ finished: true });
    expect(await call(pg, 'detail_change_claim', press(PRESS(1)))).toEqual({ claimed: false, state: 'changed' });
    // The item is free again; a press NetSuite refused can be pressed again.
    expect(await call(pg, 'detail_change_claim', press(PRESS(2)))).toEqual({ claimed: true });
    expect(await call(pg, 'detail_change_finish', { id: PRESS(2), status: 'refused', error: 'NetSuite error (400): Invalid value for cogsAccount.' }))
      .toEqual({ finished: true });
    expect(await call(pg, 'detail_change_claim', press(PRESS(2), { patch: { assetAccount: { id: '106' } } }))).toEqual({ claimed: true });
    expect(await change(pg, PRESS(2))).toMatchObject({ status: 'sending', error: null, patch: { assetAccount: { id: '106' } } });

    // A send that never finished lets go after five minutes, as unsure.
    await pg.query(`UPDATE detail_changes SET sent_at = now() - interval '6 minutes' WHERE id = $1`, [PRESS(2)]);
    expect(await call(pg, 'detail_change_claim', press(PRESS(5)))).toEqual({ claimed: true });
    expect((await change(pg, PRESS(2))).status).toBe('unsure');
    for (const id of [PRESS(3), PRESS(4), PRESS(5)]) expect(await call(pg, 'detail_change_finish', { id, status: 'changed' })).toEqual({ finished: true });
  });

  it('refuses a press of another kind of record, or without NetSuite\'s id for the item', async () => {
    await expect(call(pg, 'detail_change_claim', press(PRESS(6), { record_type: 'part' }))).rejects.toThrow(/of a customer, a vendor or an item, not part/);
    await expect(call(pg, 'detail_change_claim', press(PRESS(6), { record_type: null }))).rejects.toThrow(/not \(nothing\)/);
    await expect(call(pg, 'detail_change_claim', press(PRESS(6), { netsuite_id: '51-2002' }))).rejects.toThrow(/needs NetSuite's id for the item/);
    await expect(call(pg, 'detail_change_claim', press(PRESS(1), { record_type: 'customer' }))).rejects.toThrow(/is a change of another record/);
    expect(await change(pg, PRESS(6))).toBeUndefined();
  });

  it('holds changes of items, and of no other kind of record, whoever writes them', async () => {
    const insert = (over: Record<string, unknown>) => pg.query(
      `INSERT INTO detail_changes (id, record_type, netsuite_id, reason, changes, patch) VALUES ($1, $2, $3, 'Swapped', '["x"]'::jsonb, '{}'::jsonb)`,
      [over.id ?? PRESS(7), over.record_type ?? 'item', over.netsuite_id ?? '502'],
    );
    await expect(insert({ record_type: 'part' })).rejects.toThrow(/check/i);
    await expect(insert({ record_type: 'Item' })).rejects.toThrow(/check/i);
    await insert({});
    expect((await change(pg, PRESS(7))).status).toBe('sending');
    await expect(insert({ id: PRESS(8) })).rejects.toThrow(/duplicate key/);
    expect(await checksOn(pg, 'detail_changes', 'record_type')).toEqual([{ def: expect.stringMatching(/customer.*vendor.*item/) }]);
  });

  it('lets only the server login claim a change', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        await expect(call(pg, 'detail_change_claim', press(PRESS(9)))).rejects.toThrow(/permission denied for function/);
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    expect(await change(pg, PRESS(9))).toBeUndefined();
  });
});
