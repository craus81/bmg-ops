// Migration 470 switches inventory transfers made in FleetSuite off until
// January 1, 2027, keeps each transfer's lines as typed, and moves it from a
// draft to being made in NetSuite to made, and back to a draft when NetSuite
// doesn't make it. This runs migration 359 with 466 to 470 in an in-memory
// Postgres (PGlite) as the app's server login, and saves lines
// src/lib/inventory-transfers.ts keeps the way /api/inventory-transfers does.
// Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { keptLines, linesToKeep, type KeptLine, type TransferItem, type TransferLine } from '@/lib/inventory-transfers';

const TRANSFER = (n: number) => `f0000000-0000-4000-8000-00000000000${n}`;
const SENDER = 'a0000000-0000-4000-8000-000000000001';

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
    -- What migrations 466 to 470 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    INSERT INTO public.profiles (id) VALUES ('${SENDER}');
  `);
  for (const file of ['359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '467-vendor-credits-in-fleetsuite.sql',
    '468-card-charges-in-fleetsuite.sql', '469-journal-entries-typed-in-fleetsuite.sql', '470-inventory-transfers-made-in-fleetsuite.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

const ITEMS = new Map<string, TransferItem>([
  ['501', { id: '501', number: 'BRK-100', name: 'Bracket kit', type: 'InvtPart', active: true }],
  ['502', { id: '502', number: 'WIRE-14', name: '14 ga wire, feet', type: 'InvtPart', active: true }],
]);
/** Brackets and wire for the service van. */
const LINES: TransferLine[] = [{ itemId: '501', quantity: 4 }, { itemId: '502', quantity: 12.5 }];
const draft = (id: string, over: Record<string, unknown> = {}) => ({
  id, company: 'BMG', tran_date: '2027-01-15', from_location_id: '1', to_location_id: '7', memo: ' Stock for the van ',
  lines: linesToKeep(LINES, ITEMS), by: SENDER, ...over,
});

type Row = { status: string; updated_at: string; sent_at: string | null; lines: KeptLine[] } & Record<string, unknown>;
const row = async (pg: PGlite, id: string) =>
  (await pg.query<Row>(`SELECT *, tran_date::text AS tran_date, updated_at::text AS updated_at, sent_at::text AS sent_at
    FROM inventory_transfers WHERE id = $1`, [id])).rows[0];
/** The draft as the page last read it, moved. */
const claim = async (pg: PGlite, id: string, by: string | null = SENDER) =>
  call(pg, 'inventory_transfer_claim', { id, by, updated_at: (await row(pg, id)).updated_at });

describe('migration 470', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it('starts inventory transfers switched off, next to the other four', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'card_charges', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'inventory_transfers', is_on: false, changed_by: null },
      { piece: 'journal_entries', is_on: false, changed_by: null },
      { piece: 'vendor_credits', is_on: false, changed_by: null },
    ]);
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    const checks = (await pg.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%piece%'`)).rows;
    expect(checks).toHaveLength(1);
  });

  it('saves a draft as typed, its memos trimmed, and changes it while it is one', async () => {
    const saved = await call(pg, 'inventory_transfer_save', draft(TRANSFER(1)));
    expect(saved).toMatchObject({ saved: true, status: 'draft' });
    const r = await row(pg, TRANSFER(1));
    expect(r).toMatchObject({
      company: 'BMG', tran_date: '2027-01-15', from_location_id: '1', to_location_id: '7', memo: 'Stock for the van',
      status: 'draft', created_by: SENDER, updated_by: SENDER, sent_at: null, netsuite_transfer_id: null,
    });
    expect(r.lines).toEqual([
      { item_netsuite_id: '501', item_number: 'BRK-100', quantity: 4 },
      { item_netsuite_id: '502', item_number: 'WIRE-14', quantity: 12.5 },
    ]);
    expect(keptLines(r.lines)).toEqual(LINES);
    // The draft as saved is the one Move names: the page sends this back.
    expect((await pg.query<{ same: boolean }>('SELECT updated_at = $1::timestamptz AS same FROM inventory_transfers WHERE id = $2',
      [saved.updated_at, TRANSFER(1)])).rows[0].same).toBe(true);

    // Half typed is fine for a draft: no locations, no memo, no item yet, a quantity of 0.
    await call(pg, 'inventory_transfer_save', draft(TRANSFER(1), {
      from_location_id: '', to_location_id: '', memo: '  ', lines: [{ item_netsuite_id: null, item_number: '  ', quantity: 0 }],
    }));
    expect(await row(pg, TRANSFER(1))).toMatchObject({
      from_location_id: null, to_location_id: null, memo: null, lines: [{ item_netsuite_id: null, item_number: null, quantity: 0 }],
    });
    // Saved again as it was, for another company on another day.
    expect(await call(pg, 'inventory_transfer_save', draft(TRANSFER(1), { company: ' 1084 ', tran_date: '2027-01-20' }))).toMatchObject({ saved: true });
    expect(await row(pg, TRANSFER(1))).toMatchObject({ company: '1084', tran_date: '2027-01-20', from_location_id: '1', memo: 'Stock for the van' });
  });

  it("refuses lines that aren't a list of items and quantities of 0 or more, to four places", async () => {
    await expect(call(pg, 'inventory_transfer_save', draft(TRANSFER(9), { lines: {} }))).rejects.toThrow(/must be a list/);
    await expect(call(pg, 'inventory_transfer_save', draft(TRANSFER(9), {
      lines: Array.from({ length: 101 }, () => ({ item_netsuite_id: '501', item_number: null, quantity: 1 })),
    }))).rejects.toThrow(/100 lines at most/);
    const good = { item_netsuite_id: '501', item_number: 'BRK-100', quantity: 1 };
    for (const bad of [
      'BRK-100', { ...good, item_netsuite_id: 'BRK-100' }, { ...good, item_netsuite_id: 501 }, { ...good, item_number: 5 },
      { ...good, item_number: 'n'.repeat(201) }, { ...good, quantity: '1' }, { ...good, quantity: -1 }, { ...good, quantity: 1000001 },
      { ...good, quantity: 0.00001 }, { item_netsuite_id: '501', item_number: null },
    ]) {
      await expect(call(pg, 'inventory_transfer_save', draft(TRANSFER(9), { lines: [good, bad] }))).rejects.toThrow(/each line is an item/);
    }
    expect((await call(pg, 'inventory_transfer_save', draft(TRANSFER(9), { lines: [{ ...good, quantity: 1000000 }] }))).saved).toBe(true);
    expect((await call(pg, 'inventory_transfer_save', draft(TRANSFER(8), { lines: [{ ...good, quantity: 0.0001 }] }))).saved).toBe(true);
    await expect(call(pg, 'inventory_transfer_save', draft(TRANSFER(7), { company: ' ' }))).rejects.toThrow(/check/i);
    await expect(call(pg, 'inventory_transfer_save', draft(TRANSFER(7), { memo: 'm'.repeat(301) }))).rejects.toThrow(/check/i);
    await expect(call(pg, 'inventory_transfer_save', draft(TRANSFER(7), { from_location_id: "O'Fallon" }))).rejects.toThrow(/check/i);
    await expect(call(pg, 'inventory_transfer_save', draft(TRANSFER(7), { to_location_id: '7a' }))).rejects.toThrow(/check/i);
    await expect(call(pg, 'inventory_transfer_save', draft(TRANSFER(7), { tran_date: null }))).rejects.toThrow(/null value/);
  });

  it('takes one press of Move of a whole draft, as the sender saw it, and lets go of one NetSuite refused', async () => {
    await call(pg, 'inventory_transfer_save', draft(TRANSFER(2)));
    // Saved again, it's another draft than the one first seen.
    const first = (await row(pg, TRANSFER(2))).updated_at;
    await call(pg, 'inventory_transfer_save', draft(TRANSFER(2)));
    expect(await call(pg, 'inventory_transfer_claim', { id: TRANSFER(2), by: SENDER, updated_at: first })).toEqual({ state: 'changed' });
    await expect(claim(pg, TRANSFER(2), null)).rejects.toThrow(/needs who sent it/);
    expect(await call(pg, 'inventory_transfer_claim', { id: TRANSFER(2), by: SENDER, updated_at: '2027-01-15T00:00:00Z' })).toEqual({ state: 'changed' });
    expect(await call(pg, 'inventory_transfer_claim', { id: TRANSFER(6), by: SENDER, updated_at: '2027-01-15T00:00:00Z' })).toEqual({ state: 'gone' });

    // A draft that isn't whole isn't taken.
    for (const over of [
      { memo: ' ' }, { from_location_id: '' }, { to_location_id: '' }, { to_location_id: '1' }, { lines: [] },
      { lines: [{ item_netsuite_id: null, item_number: null, quantity: 1 }] }, { lines: [{ item_netsuite_id: '501', item_number: null, quantity: 0 }] },
    ]) {
      await call(pg, 'inventory_transfer_save', draft(TRANSFER(2), over));
      await expect(claim(pg, TRANSFER(2))).rejects.toThrow(/needs a memo, two different locations and one line or more/);
    }
    await call(pg, 'inventory_transfer_save', draft(TRANSFER(2)));

    const claimed = await claim(pg, TRANSFER(2));
    expect(claimed.state).toBe('claimed');
    expect(claimed.transfer).toMatchObject({ id: TRANSFER(2), status: 'sending', sent_by: SENDER, memo: 'Stock for the van' });
    expect(keptLines(claimed.transfer.lines)).toEqual(LINES);
    const held = await row(pg, TRANSFER(2));
    expect(held.sent_at).not.toBeNull();
    // Pressed again while it's being made: it's held, and it can't be changed.
    expect(await claim(pg, TRANSFER(2))).toMatchObject({ state: 'moving', transfer: { id: TRANSFER(2), status: 'sending' } });
    expect(await call(pg, 'inventory_transfer_save', draft(TRANSFER(2), { memo: 'Changed' }))).toMatchObject({ saved: false, status: 'sending' });

    // NetSuite refused it: a draft again as the sender saw it, so Move can be pressed again, with why.
    expect(await call(pg, 'inventory_transfer_let_go', { id: TRANSFER(2), error: '  ' })).toEqual({ let_go: true });
    expect(await row(pg, TRANSFER(2))).toMatchObject({ status: 'draft', sent_by: null, sent_at: null, error: 'Not made', updated_at: held.updated_at });
    expect(await call(pg, 'inventory_transfer_let_go', { id: TRANSFER(2), error: 'again' })).toEqual({ let_go: false });
    // Pressed again, why it wasn't made last time is gone.
    await claim(pg, TRANSFER(2));
    expect((await row(pg, TRANSFER(2))).error).toBeNull();
    await call(pg, 'inventory_transfer_let_go', { id: TRANSFER(2), error: `NetSuite error (400): ${'x'.repeat(2100)}` });
    expect(((await row(pg, TRANSFER(2))).error as string).length).toBe(2000);
  });

  it("keeps the transfer NetSuite made, once, and says so when it's pressed again", async () => {
    await call(pg, 'inventory_transfer_save', draft(TRANSFER(3)));
    await claim(pg, TRANSFER(3));
    // Held while NetSuite couldn't say whether it made it.
    await pg.query(`UPDATE inventory_transfers SET error = 'NetSuite error (503): Busy' WHERE id = $1`, [TRANSFER(3)]);
    await expect(call(pg, 'inventory_transfer_made', { id: TRANSFER(3), netsuite_transfer_id: 'IT-13' })).rejects.toThrow(/needs NetSuite's id/);
    await expect(call(pg, 'inventory_transfer_made', { id: TRANSFER(3) })).rejects.toThrow(/needs NetSuite's id/);
    expect(await call(pg, 'inventory_transfer_made', { id: TRANSFER(3), netsuite_transfer_id: '9002', netsuite_number: ' IT-13 ' })).toEqual({ made: true });
    expect(await row(pg, TRANSFER(3))).toMatchObject({ status: 'made', netsuite_transfer_id: '9002', netsuite_number: 'IT-13', error: null });
    expect(await call(pg, 'inventory_transfer_made', { id: TRANSFER(3), netsuite_transfer_id: '9003' })).toEqual({ made: false });
    expect(await call(pg, 'inventory_transfer_let_go', { id: TRANSFER(3), error: 'late' })).toEqual({ let_go: false });
    expect(await claim(pg, TRANSFER(3))).toEqual({ state: 'made', netsuite_transfer_id: '9002', netsuite_number: 'IT-13' });
    expect(await call(pg, 'inventory_transfer_save', draft(TRANSFER(3)))).toMatchObject({ saved: false, status: 'made' });
    // A blank number is none.
    await call(pg, 'inventory_transfer_save', draft(TRANSFER(4)));
    await claim(pg, TRANSFER(4));
    await call(pg, 'inventory_transfer_made', { id: TRANSFER(4), netsuite_transfer_id: '9004', netsuite_number: '  ' });
    expect((await row(pg, TRANSFER(4))).netsuite_number).toBeNull();
  });

  it('refuses a transfer that says it is somewhere it is not', async () => {
    const insert = (over: Record<string, unknown>) => {
      const r: Record<string, unknown> = { id: TRANSFER(5), company: 'BMG', tran_date: '2027-01-15', ...over };
      const cols = Object.keys(r);
      return pg.query(`INSERT INTO inventory_transfers (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
    };
    for (const over of [
      { status: 'sending' }, { status: 'made', sent_at: '2027-01-16T00:00:00Z' }, { netsuite_transfer_id: '9010' },
      { status: 'gone', sent_at: '2027-01-16T00:00:00Z' },
      { netsuite_transfer_id: 'IT-10', status: 'made', sent_at: '2027-01-16T00:00:00Z' },
      { lines: {} }, { error: 'e'.repeat(2001) }, { memo: 'm'.repeat(301) },
    ]) {
      await expect(insert(over)).rejects.toThrow(/check/i);
    }
    await expect(insert({ created_by: 'a0000000-0000-4000-8000-000000000009' })).rejects.toThrow(/foreign key/);
    await insert({ status: 'made', sent_at: '2027-01-16T00:00:00Z', netsuite_transfer_id: '9010' });
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        await expect(pg.query('SELECT * FROM inventory_transfers')).rejects.toThrow(/permission denied/);
        for (const fn of ['inventory_transfer_save', 'inventory_transfer_claim', 'inventory_transfer_let_go', 'inventory_transfer_made']) {
          await expect(call(pg, fn, { id: TRANSFER(2) })).rejects.toThrow(/permission denied for function/);
        }
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE relname = 'inventory_transfers'`);
    expect(rls.rows[0].relrowsecurity).toBe(true);
    await pg.exec('SET ROLE service_role');
  });
});
