// Migration 497 keeps FleetSuite's own numbers: each kind's letters and next
// number, every number FleetSuite took and what became of it, and the sales
// orders and POs made in NetSuite instead of FleetSuite. This runs 497 in an
// in-memory Postgres (PGlite) as the app's server login, over made-up copies
// of NetSuite's sales orders, POs, invoices and credit memos and the NetSuite
// feed's sends, and holds what the tables keep and the functions return.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SWITCH_PIECES } from './switches';

const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const GONE = 'a0000000-0000-4000-8000-0000000000ff';
const SEND = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PIECES = [
  'credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes', 'bill_fixes',
  'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite', 'fleetsuite_records', 'customer_payments',
  'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals',
];

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
    -- What migration 497 points at, as the earlier migrations leave it.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.books_switches (
      piece TEXT PRIMARY KEY CHECK (piece IN (${PIECES.map((p) => `'${p}'`).join(', ')})),
      is_on BOOLEAN NOT NULL DEFAULT false,
      changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
      changed_at TIMESTAMPTZ
    );
    CREATE TABLE public.netsuite_sales_orders (
      netsuite_id TEXT NOT NULL UNIQUE, tranid TEXT, customer_name TEXT, trandate DATE, created_by_name TEXT
    );
    CREATE TABLE public.netsuite_vendor_pos (
      netsuite_id TEXT NOT NULL UNIQUE, tranid TEXT, vendor_name TEXT, trandate DATE, created_by_name TEXT
    );
    CREATE TABLE public.ledger_invoices (id SERIAL PRIMARY KEY, doc_type TEXT NOT NULL, doc_number TEXT);
    CREATE TABLE public.gl_own_invoices (netsuite_id TEXT PRIMARY KEY, netsuite_number TEXT);
    CREATE TABLE public.gl_own_credit_memos (netsuite_id TEXT PRIMARY KEY, netsuite_number TEXT);
    CREATE TABLE public.netsuite_sends (
      id UUID PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL, made_type TEXT, made_id TEXT
    );
    CREATE TABLE public.drop_ship_orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), purchase_order_id TEXT);
  `);
  await pg.query('INSERT INTO profiles (id) VALUES ($1)', [CRAIG]);
  await pg.query("INSERT INTO books_switches (piece) VALUES ('credit_memos'), ('adjustment_approvals')");
  const sql = readFileSync(path.resolve(__dirname, '../../../migrations/497-books-own-numbers.sql'), 'utf8');
  await pg.exec(sql);
  await pg.exec(sql); // must be safe to re-run
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

interface Reserved { reserved_id: string; reserved_number: string }
const reserve = async (pg: PGlite, type: string, by: string | null = CRAIG) =>
  (await pg.query<Reserved>('SELECT * FROM own_number_reserve($1, $2)', [type, by])).rows[0];
const settle = (pg: PGlite, id: string, status: string | null, netsuiteId: string | null, number: string | null, note: string | null) =>
  one<boolean>(pg, 'SELECT own_number_settle($1, $2, $3, $4, $5) AS r', [id, status, netsuiteId, number, note]);

interface NumberRow {
  doc_type: string; number: string; reserved_by: string | null; status: string; settled_at: string | null;
  netsuite_id: string | null; netsuite_number: string | null; note: string | null; kept_own: boolean;
}
const row = async (pg: PGlite, id: string) => (await pg.query<NumberRow>('SELECT * FROM own_numbers WHERE id = $1', [id])).rows[0];

describe('migration 497: the switch', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it("adds FleetSuite's own numbers, off, and keeps every earlier piece", async () => {
    expect((await db.query('SELECT piece, is_on FROM books_switches WHERE piece = $1', ['own_numbers'])).rows)
      .toEqual([{ piece: 'own_numbers', is_on: false }]);
    // Every piece the app names is one the column takes, and nothing else is.
    expect(SWITCH_PIECES).toEqual([...PIECES, 'own_numbers']);
    for (const piece of SWITCH_PIECES) {
      await db.query('INSERT INTO books_switches (piece) VALUES ($1) ON CONFLICT (piece) DO NOTHING', [piece]);
    }
    expect((await db.query('SELECT count(*)::int AS n FROM books_switches')).rows[0]).toEqual({ n: 17 });
    await expect(db.query("INSERT INTO books_switches (piece) VALUES ('own_names')")).rejects.toThrow('books_switches_piece_check');
  });
});

describe('migration 497: taking numbers', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it('starts each kind at 10001 with the letters NetSuite uses', async () => {
    expect((await db.query('SELECT doc_type, prefix, next_seq FROM own_number_series ORDER BY doc_type')).rows).toEqual([
      { doc_type: 'credit_memo', prefix: 'CM', next_seq: 10001 },
      { doc_type: 'invoice', prefix: 'INV', next_seq: 10001 },
      { doc_type: 'purchase_order', prefix: 'PO', next_seq: 10001 },
      { doc_type: 'sales_order', prefix: 'SO', next_seq: 10001 },
    ]);
  });

  it('gives the next number, one after another, and keeps it as on its way', async () => {
    const first = await reserve(db, 'sales_order');
    const second = await reserve(db, 'sales_order', null);
    expect([first.reserved_number, second.reserved_number]).toEqual(['SO10001', 'SO10002']);
    expect(await row(db, first.reserved_id)).toMatchObject({
      doc_type: 'sales_order', number: 'SO10001', reserved_by: CRAIG, status: 'reserved', settled_at: null,
      netsuite_id: null, netsuite_number: null, note: null, kept_own: false,
    });
    expect((await row(db, second.reserved_id)).reserved_by).toBeNull();
    // Someone with no profile left takes a number as nobody.
    const gone = await reserve(db, 'invoice', GONE);
    expect(gone.reserved_number).toBe('INV10001');
    expect((await row(db, gone.reserved_id)).reserved_by).toBeNull();
  });

  it("passes over a number on one of NetSuite's documents of the kind, whatever its case", async () => {
    await db.query("INSERT INTO netsuite_sales_orders (netsuite_id, tranid) VALUES ('501', 'so10003')");
    expect((await reserve(db, 'sales_order')).reserved_number).toBe('SO10004');

    // A PO with the customer after a dash has the number too; another kind's doesn't.
    await db.query("INSERT INTO netsuite_vendor_pos (netsuite_id, tranid) VALUES ('601', 'PO10001-ACME'), ('602', 'PO100020')");
    await db.query("INSERT INTO netsuite_sales_orders (netsuite_id, tranid) VALUES ('502', 'PO10002')");
    expect((await reserve(db, 'purchase_order')).reserved_number).toBe('PO10002');
    await db.query("INSERT INTO netsuite_vendor_pos (netsuite_id, tranid) VALUES ('603', 'PO10003')");
    expect((await reserve(db, 'purchase_order')).reserved_number).toBe('PO10004');

    // Invoices: the ledger's copy back to 2015 and FleetSuite's own copies; a credit memo's number isn't an invoice's.
    await db.query(`INSERT INTO ledger_invoices (doc_type, doc_number) VALUES ('invoice', 'Inv10002'), ('credit_memo', 'INV10003'),
      ('invoice', 'CM10001')`);
    await db.query("INSERT INTO gl_own_invoices (netsuite_id, netsuite_number) VALUES ('701', 'INV10003'), ('702', 'inv10004')");
    expect((await reserve(db, 'invoice')).reserved_number).toBe('INV10005');

    await db.query("INSERT INTO ledger_invoices (doc_type, doc_number) VALUES ('credit_memo', 'cm10001')");
    await db.query("INSERT INTO gl_own_credit_memos (netsuite_id, netsuite_number) VALUES ('801', 'CM10002')");
    expect((await reserve(db, 'credit_memo')).reserved_number).toBe('CM10003');
    expect((await db.query('SELECT doc_type, next_seq FROM own_number_series ORDER BY doc_type')).rows).toEqual([
      { doc_type: 'credit_memo', next_seq: 10004 },
      { doc_type: 'invoice', next_seq: 10006 },
      { doc_type: 'purchase_order', next_seq: 10005 },
      { doc_type: 'sales_order', next_seq: 10005 },
    ]);
  });

  it('never gives a number twice, even when the series goes back', async () => {
    expect(await one(db, 'SELECT own_number_series_set($1, $2, $3, $4) AS r', ['sales_order', ' so ', 10001, CRAIG])).toBe(true);
    expect((await db.query("SELECT prefix, next_seq, changed_by FROM own_number_series WHERE doc_type = 'sales_order'")).rows)
      .toEqual([{ prefix: 'SO', next_seq: 10001, changed_by: CRAIG }]);
    // SO10001, SO10002 and SO10004 are FleetSuite's, SO10003 NetSuite's.
    expect((await reserve(db, 'sales_order')).reserved_number).toBe('SO10005');
    await expect(db.query("INSERT INTO own_numbers (doc_type, number) VALUES ('sales_order', 'SO10005')")).rejects.toThrow('own_numbers_unique');
    // The same number as another kind is fine.
    expect((await db.query("INSERT INTO own_numbers (doc_type, number) VALUES ('invoice', 'SO10005') RETURNING number")).rows)
      .toEqual([{ number: 'SO10005' }]);
  });

  it('changes the letters, but only to one to six letters and a number from 1', async () => {
    expect(await one(db, 'SELECT own_number_series_set($1, $2, $3, $4) AS r', ['credit_memo', 'crm', 500, CRAIG])).toBe(true);
    expect((await reserve(db, 'credit_memo')).reserved_number).toBe('CRM500');
    await expect(db.query('SELECT own_number_series_set($1, $2, $3, $4)', ['credit_memo', 'CM1', 10, CRAIG])).rejects.toThrow('own_number_series_prefix_check');
    await expect(db.query('SELECT own_number_series_set($1, $2, $3, $4)', ['credit_memo', 'CREDITS', 10, CRAIG])).rejects.toThrow('own_number_series_prefix_check');
    await expect(db.query('SELECT own_number_series_set($1, $2, $3, $4)', ['credit_memo', 'CM', 0, CRAIG])).rejects.toThrow('own_number_series_next_seq_check');
    expect(await one(db, 'SELECT own_number_series_set($1, $2, $3, $4) AS r', ['bill', 'BL', 10, CRAIG])).toBe(false);
  });

  it("refuses a kind it doesn't number", async () => {
    await expect(reserve(db, 'bill')).rejects.toThrow('no numbers for bill');
    await expect(db.query("INSERT INTO own_numbers (doc_type, number) VALUES ('bill', 'BL1')")).rejects.toThrow('own_numbers_doc_type_check');
    await expect(db.query("INSERT INTO own_numbers (doc_type, number) VALUES ('invoice', 'INV-1')")).rejects.toThrow('own_numbers_number_check');
  });
});

describe('migration 497: what became of a number', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it('keeps what NetSuite made, once', async () => {
    const { reserved_id: id } = await reserve(db, 'invoice');
    expect(await settle(db, id, 'made', ' 9001 ', 'INV10001', null)).toBe(true);
    expect(await row(db, id)).toMatchObject({ status: 'made', netsuite_id: '9001', netsuite_number: 'INV10001', note: null, kept_own: false });
    expect((await row(db, id)).settled_at).not.toBeNull();
    // Said once: a second answer changes nothing.
    expect(await settle(db, id, 'refused', null, null, 'Too late')).toBe(false);
    expect((await row(db, id)).status).toBe('made');
  });

  it("knows when NetSuite kept a number of its own, but not a PO's customer ending or another case", async () => {
    const kept = await reserve(db, 'invoice');
    await settle(db, kept.reserved_id, 'made', '9002', 'INV2702', null);
    expect((await row(db, kept.reserved_id)).kept_own).toBe(true);

    const lower = await reserve(db, 'invoice');
    await settle(db, lower.reserved_id, 'made', '9003', 'inv10003', null);
    expect((await row(db, lower.reserved_id)).kept_own).toBe(false);

    const po = await reserve(db, 'purchase_order');
    await settle(db, po.reserved_id, 'made', '9004', 'PO10001-ACME', null);
    expect((await row(db, po.reserved_id)).kept_own).toBe(false);
    const longer = await reserve(db, 'purchase_order');
    await settle(db, longer.reserved_id, 'made', '9005', 'PO100021', null);
    expect((await row(db, longer.reserved_id)).kept_own).toBe(true);

    // Made, with no number read back: nothing to say it kept its own.
    const unread = await reserve(db, 'sales_order');
    await settle(db, unread.reserved_id, 'made', '9006', '  ', null);
    expect(await row(db, unread.reserved_id)).toMatchObject({ netsuite_number: null, kept_own: false });
  });

  it('keeps why NetSuite refused one or left FleetSuite unsure, with nothing NetSuite made', async () => {
    const refused = await reserve(db, 'sales_order');
    expect(await settle(db, refused.reserved_id, 'refused', '9007', 'SO10002', 'Invalid customer reference key 12.')).toBe(true);
    expect(await row(db, refused.reserved_id)).toMatchObject({
      status: 'refused', netsuite_id: null, netsuite_number: null, note: 'Invalid customer reference key 12.', kept_own: false,
    });
    const unsure = await reserve(db, 'sales_order');
    await settle(db, unsure.reserved_id, 'unsure', null, null, `${'x'.repeat(700)}`);
    expect(await row(db, unsure.reserved_id)).toMatchObject({ status: 'unsure', note: 'x'.repeat(600) });
    // A NetSuite ID that isn't one is left out rather than failing.
    const odd = await reserve(db, 'sales_order');
    await settle(db, odd.reserved_id, 'made', 'abc', 'SO10005', null);
    expect(await row(db, odd.reserved_id)).toMatchObject({ status: 'made', netsuite_id: null, netsuite_number: 'SO10005' });
  });

  it("refuses an end that isn't one, and holds the table to its rules", async () => {
    const { reserved_id: id } = await reserve(db, 'credit_memo');
    await expect(settle(db, id, 'reserved', null, null, null)).rejects.toThrow('not what can become of a number: reserved');
    await expect(settle(db, id, null, null, null, null)).rejects.toThrow('not what can become of a number');
    expect((await row(db, id)).status).toBe('reserved');
    await expect(db.query("UPDATE own_numbers SET netsuite_id = '1' WHERE id = $1", [id])).rejects.toThrow('own_numbers_only_made');
    await expect(db.query("UPDATE own_numbers SET status = 'refused' WHERE id = $1", [id])).rejects.toThrow('own_numbers_settled');
    expect(await settle(db, 'a0000000-0000-4000-8000-00000000abcd', 'made', '1', 'X1', null)).toBe(false);
  });
});

describe('migration 497: sales orders and POs made in NetSuite instead of FleetSuite', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.query(`INSERT INTO netsuite_sales_orders (netsuite_id, tranid, customer_name, trandate, created_by_name) VALUES
      ('1001', 'SO4410', 'Acme Plumbing', '2027-04-02', 'Pat Example'),
      ('1002', 'SO10001', 'Acme Plumbing', '2027-04-03', 'FleetSuite'),
      ('1003', 'SO4411', 'Bluebird Fleet', '2027-04-03', 'FleetSuite'),
      ('1004', 'SO4409', 'Bluebird Fleet', '2027-03-31', 'Pat Example'),
      ('1005', 'SO4412', 'Bluebird Fleet', '2027-04-04', 'Sam Sample'),
      ('1006', 'SO4413', 'Bluebird Fleet', NULL, 'Sam Sample')`);
    await db.query(`INSERT INTO netsuite_vendor_pos (netsuite_id, tranid, vendor_name, trandate, created_by_name) VALUES
      ('2001', 'PO2301', 'Ranger Design', '2027-04-02', 'Pat Example'),
      ('2002', 'PO10001-ACME', 'Ranger Design', '2027-04-03', 'FleetSuite'),
      ('2003', 'PO2302', 'Masterack', '2027-04-05', 'FleetSuite'),
      ('2004', 'PO2303', 'Masterack', '2027-04-06', 'FleetSuite')`);
    // NetSuite made PO2303 by itself when FleetSuite marked a sales order's lines Drop Ship.
    await db.query("INSERT INTO drop_ship_orders (purchase_order_id) VALUES ('2004')");
    // FleetSuite made SO10001 and PO10001 with its own numbers; the feed has the SO it made before, the drop ship PO the
    // item script made, and an invoice with an SO's ID that isn't the SO.
    const so = await reserve(db, 'sales_order');
    await settle(db, so.reserved_id, 'made', '1002', 'SO10001', null);
    const po = await reserve(db, 'purchase_order');
    await settle(db, po.reserved_id, 'made', '2002', 'PO10001', null);
    await db.query(`INSERT INTO netsuite_sends (id, started_at, made_type, made_id) VALUES
      ($1, '2027-03-01T15:00:00Z', 'salesOrder', '1003'),
      ($2, '2027-03-02T15:00:00Z', 'purchaseOrder', '2003'),
      ($3, '2027-03-03T15:00:00Z', 'invoice', '1005')`, [SEND(1), SEND(2), SEND(3)]);
  });
  afterAll(async () => { await db.close(); });

  interface Outside { netsuite_id: string; doc_type: string; tranid: string; trandate: string; party: string; created_by_name: string; told_at: string | null }
  const outside = async (since: string, limit: number | null = 200) =>
    (await db.query<Outside>('SELECT * FROM own_numbers_made_outside($1, $2)', [since, limit])).rows
      .map((r) => ({ ...r, trandate: new Date(r.trandate).toISOString().slice(0, 10) }));

  it("lists what FleetSuite didn't make from the day, newest first", async () => {
    expect((await outside('2027-04-01')).map((r) => [r.doc_type, r.tranid, r.trandate, r.party, r.created_by_name, r.told_at])).toEqual([
      ['sales_order', 'SO4412', '2027-04-04', 'Bluebird Fleet', 'Sam Sample', null],
      ['purchase_order', 'PO2301', '2027-04-02', 'Ranger Design', 'Pat Example', null],
      ['sales_order', 'SO4410', '2027-04-02', 'Acme Plumbing', 'Pat Example', null],
    ]);
    expect((await outside('2027-04-01', 1)).map((r) => r.tranid)).toEqual(['SO4412']);
  });

  it('starts no earlier than the first send the feed kept', async () => {
    // The first send was March 1 in Chicago, so March 31's sales order is in and nothing before March 1 could be.
    expect((await outside('2027-01-01')).map((r) => r.tranid)).toEqual(['SO4412', 'PO2301', 'SO4410', 'SO4409']);
    await db.query("INSERT INTO netsuite_sends (id, started_at) VALUES ($1, '2027-04-03T03:00:00Z')", [SEND(4)]);
    await db.query('DELETE FROM netsuite_sends WHERE id = ANY($1)', [[SEND(1), SEND(2), SEND(3)]]);
    // April 2 in Chicago, 10pm: the feed starts then, and what it doesn't hold FleetSuite can't say it made.
    expect((await outside('2027-01-01')).map((r) => r.tranid)).toEqual(['PO2302', 'SO4412', 'SO4411', 'PO2301', 'SO4410']);
  });

  it('says when the daily check told about each', async () => {
    await db.query("INSERT INTO own_number_outside_told (netsuite_id, told_at) VALUES ('1001', '2027-04-03T09:58:00Z')");
    const told = (await outside('2027-04-01')).find((r) => r.netsuite_id === '1001');
    expect(new Date(told!.told_at!).toISOString()).toBe('2027-04-03T09:58:00.000Z');
  });
});

describe('migration 497: what the daily check tells about', () => {
  let db: PGlite;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    db = await freshDb();
    await db.query("INSERT INTO netsuite_sends (id, started_at, made_type, made_id) VALUES ($1, '2027-03-01T15:00:00Z', 'salesOrder', '1009')", [SEND(1)]);
    await db.query(`INSERT INTO netsuite_sales_orders (netsuite_id, tranid, customer_name, trandate, created_by_name) VALUES
      ('1001', 'SO4410', 'Acme Plumbing', '2027-04-03', 'Pat Example'),
      ('1002', 'SO4411', 'Bluebird Fleet', '2027-04-02', 'Sam Sample'),
      ('1009', 'SO4408', 'Bluebird Fleet', '2027-04-02', 'FleetSuite')`);
    await db.query(`INSERT INTO netsuite_vendor_pos (netsuite_id, tranid, vendor_name, trandate, created_by_name) VALUES
      ('2001', 'PO2301', 'Ranger Design', '2027-04-02', 'Pat Example')`);
    // NetSuite kept its own number for INV10001 and PO10001, and FleetSuite's for INV10002.
    const made: Array<[string, string, string, string]> = [
      ['invoice', 'INV10001', '3001', 'INV2702'],
      ['invoice', 'INV10002', '3002', 'INV10002'],
      ['purchase_order', 'PO10001', '2002', 'PO2299'],
    ];
    for (const [i, [type, number, netsuiteId, kept]] of made.entries()) {
      const r = await reserve(db, type);
      expect(r.reserved_number).toBe(number);
      await settle(db, r.reserved_id, 'made', netsuiteId, kept, null);
      await db.query('UPDATE own_numbers SET reserved_at = $2 WHERE id = $1', [r.reserved_id, `2027-04-0${i + 2}T15:00:00Z`]);
      ids[number] = r.reserved_id;
    }
    // A number on its way, and one NetSuite refused: neither is told about.
    await reserve(db, 'invoice');
    const refused = await reserve(db, 'invoice');
    await settle(db, refused.reserved_id, 'refused', null, null, 'Invalid customer.');
  });
  afterAll(async () => { await db.close(); });

  interface ToTell {
    kept: Array<{ id: string; doc_type: string; number: string; netsuite_id: string; netsuite_number: string; reserved_at: string }>;
    outside: Array<{ netsuite_id: string; doc_type: string; tranid: string; trandate: string; party: string; created_by_name: string }>;
  }
  const toTell = (since: string, limit: number | null = 200) => one<ToTell>(db, 'SELECT own_numbers_to_tell($1, $2) AS r', [since, limit]);
  const markTold = (numberIds: string[] | null, outsideIds: string[] | null) =>
    db.query('SELECT own_numbers_mark_told($1::uuid[], $2::text[])', [numberIds, outsideIds]);

  it("tells about the numbers NetSuite didn't keep and what was made in NetSuite, oldest first", async () => {
    const told = await toTell('2027-04-01');
    expect(told.kept.map((k) => [k.doc_type, k.number, k.netsuite_id, k.netsuite_number])).toEqual([
      ['invoice', 'INV10001', '3001', 'INV2702'],
      ['purchase_order', 'PO10001', '2002', 'PO2299'],
    ]);
    expect(told.kept[0].id).toBe(ids.INV10001);
    expect(told.outside.map((o) => [o.doc_type, o.tranid, o.trandate, o.party, o.created_by_name])).toEqual([
      ['sales_order', 'SO4411', '2027-04-02', 'Bluebird Fleet', 'Sam Sample'],
      ['purchase_order', 'PO2301', '2027-04-02', 'Ranger Design', 'Pat Example'],
      ['sales_order', 'SO4410', '2027-04-03', 'Acme Plumbing', 'Pat Example'],
    ]);
    // From a later day, only what's dated from it; at most the limit of each.
    expect((await toTell('2027-04-03')).outside.map((o) => o.tranid)).toEqual(['SO4410']);
    const few = await toTell('2027-04-01', 1);
    expect([few.kept.map((k) => k.number), few.outside.map((o) => o.tranid)]).toEqual([['INV10001'], ['SO4411']]);
  });

  it('tells about each once', async () => {
    await markTold([ids.INV10001], ['1002', '1002']);
    let told = await toTell('2027-04-01');
    expect([told.kept.map((k) => k.number), told.outside.map((o) => o.tranid)]).toEqual([['PO10001'], ['PO2301', 'SO4410']]);
    await markTold([ids.INV10001, ids.PO10001], ['1002', '2001', '1001']);
    told = await toTell('2027-04-01');
    expect(told).toEqual({ kept: [], outside: [] });
    expect((await db.query('SELECT netsuite_id FROM own_number_outside_told ORDER BY netsuite_id')).rows).toEqual([
      { netsuite_id: '1001' }, { netsuite_id: '1002' }, { netsuite_id: '2001' },
    ]);
    // Marking keeps when it was first told.
    const first = (await row(db, ids.INV10001)) as NumberRow & { told_at: string };
    await markTold([ids.INV10001], null);
    expect(((await row(db, ids.INV10001)) as NumberRow & { told_at: string }).told_at).toEqual(first.told_at);
    await expect(markTold(null, null)).resolves.toBeTruthy();
    expect((await row(db, ids.INV10002) as NumberRow & { told_at: string | null }).told_at).toBeNull();
  });
});

describe('migration 497: who can reach it', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it('keeps every table and function to the server', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      for (const t of ['own_number_series', 'own_numbers', 'own_number_outside_told']) {
        await expect(db.query(`SELECT * FROM ${t}`)).rejects.toThrow(`permission denied for table ${t}`);
      }
      await expect(db.query("SELECT * FROM own_number_reserve('invoice', NULL)")).rejects.toThrow('permission denied for function own_number_reserve');
      await expect(db.query("SELECT own_number_taken('invoice', 'INV1')")).rejects.toThrow('permission denied for function own_number_taken');
      await expect(db.query("SELECT own_number_settle(gen_random_uuid(), 'made', NULL, NULL, NULL)")).rejects.toThrow('permission denied for function own_number_settle');
      await expect(db.query("SELECT own_number_series_set('invoice', 'INV', 1, NULL)")).rejects.toThrow('permission denied for function own_number_series_set');
      await expect(db.query("SELECT * FROM own_numbers_made_outside('2027-01-01', 10)")).rejects.toThrow('permission denied for function own_numbers_made_outside');
      await expect(db.query("SELECT own_numbers_to_tell('2027-01-01', 10)")).rejects.toThrow('permission denied for function own_numbers_to_tell');
      await expect(db.query("SELECT own_numbers_mark_told('{}', '{}')")).rejects.toThrow('permission denied for function own_numbers_mark_told');
    }
    await db.exec('RESET ROLE; SET ROLE service_role');
    expect((await reserve(db, 'invoice')).reserved_number).toBe('INV10001');
  });
});
