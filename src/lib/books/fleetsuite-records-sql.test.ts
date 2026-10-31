// Migration 480 switches FleetSuite's record winning off until it's turned on, an eleventh books switch, and keeps what
// NetSuite has instead of FleetSuite's record of a customer or vendor: one row for each field, open until it's dealt
// with or a sync finds the two the same again. This runs it after the migrations it builds on in an in-memory Postgres
// (PGlite) as the app's server login, calling note_record_differences as the syncs do (src/lib/fleetsuite-records.ts).
// Made-up data.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const CRAIG = 'a0000000-0000-4000-8000-000000000001';
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
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}');
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
    '480-fleetsuite-record-wins.sql',
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

type Seen = { kind: string; netsuite_id: string; name?: string | null; field: string; fleetsuite: unknown; netsuite: unknown; differs: unknown };
const seen = (over: Partial<Seen> = {}): Seen => ({
  kind: 'customer', netsuite_id: '2001', name: 'Acme Fleet Services', field: 'email',
  fleetsuite: 'billing@acmefleet.example', netsuite: 'ap@acmefleet.example', differs: true, ...over,
});

describe('migration 480', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  const note = async (...list: Seen[]) =>
    (await pg.query<{ r: { opened: number; closed: number } }>('SELECT note_record_differences($1::jsonb) AS r', [JSON.stringify(list)])).rows[0].r;
  const rows = async () => (await pg.query<Record<string, any>>(`
    SELECT kind, netsuite_id, name, field, fleetsuite_value, netsuite_value, status, sent_to_netsuite, closed_by,
           closed_at IS NOT NULL AS closed, told_at
    FROM record_differences ORDER BY first_seen_at, netsuite_id, kind, field`)).rows;

  beforeEach(async () => { await pg.exec('DELETE FROM record_differences WHERE true'); });

  it("starts FleetSuite's record wins switched off, next to the other ten", async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'bill_fixes', is_on: false, changed_by: null },
      { piece: 'card_charges', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'customer_vendor_details', is_on: false, changed_by: null },
      { piece: 'estimates_in_fleetsuite', is_on: false, changed_by: null },
      { piece: 'fleetsuite_records', is_on: false, changed_by: null },
      { piece: 'inventory_transfers', is_on: false, changed_by: null },
      { piece: 'invoice_fixes', is_on: false, changed_by: null },
      { piece: 'item_accounts', is_on: false, changed_by: null },
      { piece: 'journal_entries', is_on: false, changed_by: null },
      { piece: 'vendor_credits', is_on: false, changed_by: null },
    ]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('records')`)).rejects.toThrow(/check/i);
    const checks = await checksOn(pg, 'books_switches', 'piece');
    expect(checks).toHaveLength(1);
    expect(checks[0].def).toContain("'fleetsuite_records'");
    expect(checks[0].def).toContain("'estimates_in_fleetsuite'");
  });

  it('keeps a switch that was turned on when the migration runs again, and what was listed', async () => {
    await pg.query(`UPDATE books_switches SET is_on = true, changed_by = $1, changed_at = now() WHERE piece = 'fleetsuite_records'`, [CRAIG]);
    await note(seen());
    await pg.exec('RESET ROLE');
    await pg.exec(migration('480-fleetsuite-record-wins.sql'));
    await pg.exec('SET ROLE service_role');
    expect((await pg.query(`SELECT piece, is_on, changed_by FROM books_switches WHERE is_on`)).rows).toEqual([
      { piece: 'fleetsuite_records', is_on: true, changed_by: CRAIG },
    ]);
    expect(await rows()).toHaveLength(1);
    await pg.query(`UPDATE books_switches SET is_on = false, changed_by = NULL, changed_at = NULL WHERE piece = 'fleetsuite_records'`);
  });

  it('opens a row for a field that differs, keeping a side that has none as none', async () => {
    expect(await note(
      seen(),
      seen({ field: 'phone', fleetsuite: '636-555-0100', netsuite: null, name: '  ' }),
      seen({ kind: 'customer', netsuite_id: '2002', field: 'address', name: null,
        fleetsuite: { addr1: '100 Main St', addr2: '', city: "O'Fallon", state: 'MO', zip: '63366' }, netsuite: { addr1: '200 Oak Ave', addr2: '', city: '', state: '', zip: '' } }),
    )).toEqual({ opened: 3, closed: 0 });
    expect(await rows()).toEqual([
      { kind: 'customer', netsuite_id: '2001', name: 'Acme Fleet Services', field: 'email', fleetsuite_value: 'billing@acmefleet.example',
        netsuite_value: 'ap@acmefleet.example', status: 'open', sent_to_netsuite: null, closed_by: null, closed: false, told_at: null },
      { kind: 'customer', netsuite_id: '2001', name: null, field: 'phone', fleetsuite_value: '636-555-0100',
        netsuite_value: null, status: 'open', sent_to_netsuite: null, closed_by: null, closed: false, told_at: null },
      { kind: 'customer', netsuite_id: '2002', name: null, field: 'address',
        fleetsuite_value: { addr1: '100 Main St', addr2: '', city: "O'Fallon", state: 'MO', zip: '63366' },
        netsuite_value: { addr1: '200 Oak Ave', addr2: '', city: '', state: '', zip: '' },
        status: 'open', sent_to_netsuite: null, closed_by: null, closed: false, told_at: null },
    ]);
    // A field the same in both has nothing to close, and lists nothing.
    expect(await note(seen({ field: 'name', fleetsuite: 'Acme', netsuite: 'Acme', differs: false }))).toEqual({ opened: 0, closed: 0 });
    expect(await rows()).toHaveLength(3);
  });

  it("keeps a side that has none as SQL's none, not JSON's null", async () => {
    await note(seen({ field: 'phone', fleetsuite: null, netsuite: '636-555-0100' }), seen({ field: 'email', netsuite: null }));
    expect((await pg.query(`
      SELECT field, fleetsuite_value IS NULL AS fleetsuite_none, netsuite_value IS NULL AS netsuite_none
      FROM record_differences ORDER BY field`)).rows).toEqual([
      { field: 'email', fleetsuite_none: false, netsuite_none: true },
      { field: 'phone', fleetsuite_none: true, netsuite_none: false },
    ]);
  });

  it('updates the open row with what it sees next, without opening another', async () => {
    await note(seen());
    await pg.exec(`UPDATE record_differences SET last_seen_at = now() - interval '1 day', told_at = now() WHERE true`);
    expect(await note(seen({ fleetsuite: 'billing2@acmefleet.example', netsuite: 'ap2@acmefleet.example', name: 'Acme Fleet' }))).toEqual({ opened: 0, closed: 0 });
    const [r] = (await pg.query<Record<string, any>>(`SELECT name, fleetsuite_value, netsuite_value, last_seen_at > now() - interval '1 minute' AS fresh,
      told_at IS NOT NULL AS told FROM record_differences`)).rows;
    expect(r).toEqual({ name: 'Acme Fleet', fleetsuite_value: 'billing2@acmefleet.example', netsuite_value: 'ap2@acmefleet.example', fresh: true, told: true });
    // A name it doesn't know leaves the one it has.
    await note(seen({ name: null }));
    expect((await rows())[0].name).toBe('Acme Fleet');
    expect(await rows()).toHaveLength(1);
  });

  it('closes the open row as the same once the two agree again, and lists it anew if they part again', async () => {
    await note(seen(), seen({ netsuite_id: '2002' }));
    expect(await note(seen({ netsuite: 'billing@acmefleet.example', differs: false }))).toEqual({ opened: 0, closed: 1 });
    expect((await rows()).map((r) => [r.netsuite_id, r.status, r.closed, r.closed_by])).toEqual([['2001', 'same', true, null], ['2002', 'open', false, null]]);
    expect(await note(seen())).toEqual({ opened: 1, closed: 0 });
    expect((await rows()).map((r) => [r.netsuite_id, r.status])).toEqual([['2001', 'same'], ['2002', 'open'], ['2001', 'open']]);
  });

  it('keeps apart fields, records and kinds', async () => {
    expect(await note(seen(), seen({ field: 'phone' }), seen({ netsuite_id: '2002' }), seen({ kind: 'vendor' }))).toEqual({ opened: 4, closed: 0 });
    expect(await note(seen({ kind: 'vendor', differs: false }))).toEqual({ opened: 0, closed: 1 });
    expect((await rows()).filter((r) => r.status === 'open')).toHaveLength(3);
  });

  it("doesn't list again one FleetSuite's was kept for without sending it, until NetSuite has something else", async () => {
    await note(seen());
    await pg.query(`UPDATE record_differences SET status = 'kept', sent_to_netsuite = false, closed_at = now(), closed_by = $1 WHERE true`, [CRAIG]);
    expect(await note(seen())).toEqual({ opened: 0, closed: 0 });
    expect(await rows()).toHaveLength(1);
    expect(await note(seen({ netsuite: 'accounts@acmefleet.example' }))).toEqual({ opened: 1, closed: 0 });
    expect((await rows()).map((r) => r.status)).toEqual(['kept', 'open']);
  });

  it('lists again one that was kept and sent, or taken, when NetSuite still differs', async () => {
    await note(seen(), seen({ field: 'phone' }));
    await pg.query(`UPDATE record_differences SET status = 'kept', sent_to_netsuite = true, closed_at = now(), closed_by = $1 WHERE field = 'email'`, [CRAIG]);
    await pg.query(`UPDATE record_differences SET status = 'taken', closed_at = now(), closed_by = $1 WHERE field = 'phone'`, [CRAIG]);
    expect(await note(seen(), seen({ field: 'phone' }))).toEqual({ opened: 2, closed: 0 });
  });

  it('takes the latest one closed as the last word', async () => {
    await note(seen());
    await pg.query(`UPDATE record_differences SET status = 'kept', sent_to_netsuite = false, closed_at = now() - interval '2 days', closed_by = $1 WHERE true`, [CRAIG]);
    await note(seen({ netsuite: 'other@acmefleet.example' }));
    await pg.query(`UPDATE record_differences SET status = 'taken', closed_at = now() - interval '1 day', closed_by = $1 WHERE status = 'open'`, [CRAIG]);
    // NetSuite is back at what the kept one had, but what was done since was taking NetSuite's.
    expect(await note(seen())).toEqual({ opened: 1, closed: 0 });
  });

  it('turns away what the syncs never send', async () => {
    await expect(pg.query(`SELECT note_record_differences('{}'::jsonb)`)).rejects.toThrow(/a list of what was seen, not object/);
    await expect(pg.query(`SELECT note_record_differences(NULL)`)).rejects.toThrow(/not \(nothing\)/);
    await expect(note(seen({ differs: 'yes' }))).rejects.toThrow(/whether customer email differs wasn't said/);
    await expect(note({ ...seen(), differs: undefined })).rejects.toThrow(/wasn't said/);
    await expect(note(seen({ netsuite_id: 'ACME' }))).rejects.toThrow(/check/i);
    await expect(note(seen({ field: 'Email' }))).rejects.toThrow(/check/i);
    await expect(note(seen({ kind: 'contact' }))).rejects.toThrow(/check/i);
    await expect(note(seen({ netsuite: 'x'.repeat(4001) }))).rejects.toThrow(/check/i);
    expect(await rows()).toEqual([]);
    expect(await note()).toEqual({ opened: 0, closed: 0 });
  });

  it('cuts a long name to fit', async () => {
    await note(seen({ name: `  ${'A'.repeat(320)} ` }));
    expect((await rows())[0].name).toBe('A'.repeat(300));
  });

  it('holds one open for a field of a record, and a row says how it was closed', async () => {
    await note(seen());
    const insert = (cols: string, vals: string) => pg.query(`INSERT INTO record_differences (kind, netsuite_id, field${cols}) VALUES ('customer', '2001', 'email'${vals})`);
    await expect(insert('', '')).rejects.toThrow(/record_differences_one_open/);
    await expect(insert(', status', ", 'kept'")).rejects.toThrow(/check/i);
    await expect(insert(', status, closed_at', ", 'kept', now()")).rejects.toThrow(/check/i);
    await expect(insert(', status, closed_at, sent_to_netsuite', ", 'taken', now(), true")).rejects.toThrow(/check/i);
    await expect(insert(', status, closed_at, closed_by', `, 'same', now(), '${CRAIG}'`)).rejects.toThrow(/check/i);
    await expect(pg.query(`UPDATE record_differences SET closed_at = now() WHERE true`)).rejects.toThrow(/check/i);
    await insert(', status, closed_at, sent_to_netsuite, closed_by', `, 'kept', now(), true, '${CRAIG}'`);
    await insert(', status, closed_at', ", 'same', now()");
    expect((await rows()).map((r) => r.status)).toEqual(['open', 'kept', 'same']);
  });

  it("is the server's alone", async () => {
    await note(seen());
    await pg.exec('RESET ROLE');
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`SET ROLE ${role}`);
      await expect(pg.query('SELECT * FROM record_differences')).rejects.toThrow(/permission denied/i);
      await expect(pg.query(`SELECT note_record_differences('[]'::jsonb)`)).rejects.toThrow(/permission denied/i);
      await pg.exec('RESET ROLE');
    }
    await pg.exec('SET ROLE service_role');
    expect(await rows()).toHaveLength(1);
  });
});
