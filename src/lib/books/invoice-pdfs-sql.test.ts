// Migration 498 keeps FleetSuite's own PDF of each version of its copy of an
// invoice and what became of it in NetSuite: held back, on its way, attached,
// refused or not sure. This runs 498 in an in-memory Postgres (PGlite) as the
// app's server login, over made-up copies of invoices, and holds what the
// table keeps and the functions return.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SWITCH_PIECES } from './switches';

const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const GONE = 'a0000000-0000-4000-8000-0000000000ff';
const PIECES = [
  'credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes', 'bill_fixes',
  'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite', 'fleetsuite_records', 'customer_payments',
  'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals', 'own_numbers',
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
    -- What migration 498 points at, as the earlier migrations leave it.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY, full_name TEXT);
    CREATE TABLE public.books_switches (
      piece TEXT PRIMARY KEY CHECK (piece IN (${PIECES.map((p) => `'${p}'`).join(', ')})),
      is_on BOOLEAN NOT NULL DEFAULT false,
      changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
      changed_at TIMESTAMPTZ
    );
    CREATE TABLE public.gl_own_invoices (
      netsuite_id TEXT PRIMARY KEY, netsuite_number TEXT, version INTEGER NOT NULL DEFAULT 1,
      made_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pg.query("INSERT INTO profiles (id, full_name) VALUES ($1, 'Craig George')", [CRAIG]);
  await pg.query("INSERT INTO books_switches (piece) VALUES ('credit_memos'), ('own_numbers')");
  const sql = readFileSync(path.resolve(__dirname, '../../../migrations/498-books-invoice-pdfs.sql'), 'utf8');
  await pg.exec(sql);
  await pg.exec(sql); // must be safe to re-run
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

/** An invoice FleetSuite made, `ago` before now (a Postgres interval). */
const invoice = (pg: PGlite, id: string, ago = '1 hour', version = 1, number: string | null = `INV${id}`) =>
  pg.query(`INSERT INTO gl_own_invoices (netsuite_id, netsuite_number, version, made_at) VALUES ($1, $2, $3, now() - $4::interval)`,
    [id, number, version, ago]);
const due = (pg: PGlite, since = '30 days', limit = 50) =>
  one<Array<{ netsuite_id: string; version: number }>>(pg, 'SELECT own_invoice_pdfs_due(now() - $1::interval, $2) AS r', [since, limit]);
const dueIds = async (pg: PGlite, since?: string, limit?: number) => (await due(pg, since, limit)).map((d) => `${d.netsuite_id}v${d.version}`);
const hold = (pg: PGlite, id: string, version: number, why: string | null) =>
  one<boolean>(pg, 'SELECT own_invoice_pdf_hold($1, $2, $3) AS r', [id, version, why]);
interface Claim { claimed: boolean; why?: string; replace_file_id?: string | null; tries?: number }
const claim = (pg: PGlite, id: string, version: number, by: string | null = null, again = false, name = `Invoice_INV${id}_${id}.pdf`) =>
  one<Claim>(pg, 'SELECT own_invoice_pdf_claim($1, $2, $3, $4, $5) AS r', [id, version, name, by, again]);
const settle = (pg: PGlite, id: string, version: number, state: string | null, fileId: string | null, replaced: boolean | null, error: string | null) =>
  one<boolean>(pg, 'SELECT own_invoice_pdf_settle($1, $2, $3, $4, $5, $6) AS r', [id, version, state, fileId, replaced, error]);

interface PdfRow {
  invoice_id: string; version: number; state: string; held_for: string | null; file_name: string | null;
  file_id: string | null; replaced_file_id: string | null; replaced: boolean | null; tries: number; error: string | null;
  asked_by: string | null; checked_at: string; started_at: string | null; answered_at: string | null; told_at: string | null;
}
const row = async (pg: PGlite, id: string, version = 1) =>
  (await pg.query<PdfRow>('SELECT * FROM own_invoice_pdfs WHERE invoice_id = $1 AND version = $2', [id, version])).rows[0];
/** Moves a row's times back, as if they were `ago` before now. */
const age = (pg: PGlite, id: string, version: number, column: 'checked_at' | 'started_at' | 'answered_at', ago: string) =>
  pg.query(`UPDATE own_invoice_pdfs SET ${column} = now() - $3::interval WHERE invoice_id = $1 AND version = $2`, [id, version, ago]);

describe('migration 498: the switch', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it('adds Invoice PDFs, off, and keeps every earlier piece', async () => {
    expect((await db.query('SELECT piece, is_on FROM books_switches WHERE piece = $1', ['invoice_pdfs'])).rows)
      .toEqual([{ piece: 'invoice_pdfs', is_on: false }]);
    // Every piece the app names is one the column takes, and nothing else is.
    expect(SWITCH_PIECES).toEqual([...PIECES, 'invoice_pdfs']);
    for (const piece of SWITCH_PIECES) {
      await db.query('INSERT INTO books_switches (piece) VALUES ($1) ON CONFLICT (piece) DO NOTHING', [piece]);
    }
    expect((await db.query('SELECT count(*)::int AS n FROM books_switches')).rows[0]).toEqual({ n: 18 });
    await expect(db.query("INSERT INTO books_switches (piece) VALUES ('invoice_pdf')")).rejects.toThrow('books_switches_piece_check');
  });
});

describe('migration 498: which copies are due', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await invoice(db, '101', '3 days');
    await invoice(db, '102', '2 days');
    await invoice(db, '103', '40 days');
    await invoice(db, '104', '1 hour', 2);
  });
  afterAll(async () => { await db.close(); });

  it('lists the copies made since a time, the longest waiting first, at their current version', async () => {
    expect(await dueIds(db)).toEqual(['101v1', '102v1', '104v2']);
    expect(await dueIds(db, '50 days')).toEqual(['103v1', '101v1', '102v1', '104v2']);
    expect(await dueIds(db, '30 days', 2)).toEqual(['101v1', '102v1']);
    // One made the moment Invoice PDFs went on is one of them.
    const fromMade = await one<Array<{ netsuite_id: string }>>(db,
      "SELECT own_invoice_pdfs_due((SELECT made_at FROM gl_own_invoices WHERE netsuite_id = '102'), 50) AS r");
    expect(fromMade.map((d) => d.netsuite_id)).toEqual(['102', '104']);
    await expect(db.query('SELECT own_invoice_pdfs_due(NULL, 10)')).rejects.toThrow('say since when');
    await expect(db.query('SELECT own_invoice_pdfs_due(now(), 0)')).rejects.toThrow('p_limit must be 1 to 200');
    await expect(db.query('SELECT own_invoice_pdfs_due(now(), 201)')).rejects.toThrow('p_limit must be 1 to 200');
  });

  it('leaves out one on its way, until it has been on its way 15 minutes', async () => {
    expect((await claim(db, '101', 1)).claimed).toBe(true);
    expect(await dueIds(db)).toEqual(['102v1', '104v2']);
    await age(db, '101', 1, 'started_at', '16 minutes');
    await age(db, '101', 1, 'checked_at', '16 minutes');
    // The ones never looked at come first, though it was made before them.
    expect(await dueIds(db)).toEqual(['102v1', '104v2', '101v1']);
  });

  it('never lists one NetSuite has, but lists the next version once the invoice is fixed', async () => {
    expect((await claim(db, '102', 1)).claimed).toBe(true);
    expect(await settle(db, '102', 1, 'attached', '9001', null, null)).toBe(true);
    await age(db, '102', 1, 'checked_at', '3 days');
    expect(await dueIds(db)).not.toContain('102v1');
    await db.query("UPDATE gl_own_invoices SET version = 2 WHERE netsuite_id = '102'");
    expect(await dueIds(db)).toContain('102v2');
  });

  it('tries a refused one again after 20 hours, a not sure one after an hour, and stops at three tries', async () => {
    const fresh = await freshDb();
    await invoice(fresh, '201', '1 day');
    await invoice(fresh, '202', '1 day');
    await claim(fresh, '201', 1);
    await settle(fresh, '201', 1, 'refused', null, null, 'Invalid invoice reference');
    await claim(fresh, '202', 1);
    await settle(fresh, '202', 1, 'unsure', null, null, "NetSuite didn't answer in time.");
    expect(await dueIds(fresh)).toEqual([]);
    await age(fresh, '202', 1, 'answered_at', '61 minutes');
    expect(await dueIds(fresh)).toEqual(['202v1']);
    await age(fresh, '201', 1, 'answered_at', '19 hours');
    expect(await dueIds(fresh)).toEqual(['202v1']);
    await age(fresh, '201', 1, 'answered_at', '21 hours');
    expect(await dueIds(fresh)).toEqual(['201v1', '202v1']);
    await fresh.query("UPDATE own_invoice_pdfs SET tries = 3 WHERE invoice_id = '202'");
    expect(await dueIds(fresh)).toEqual(['201v1']);
    await fresh.close();
  });

  it('looks again at a held one a day on while the invoice is under 60 days old, and never at a voided one', async () => {
    const fresh = await freshDb();
    await invoice(fresh, '301', '2 days');
    await invoice(fresh, '302', '2 days');
    await invoice(fresh, '303', '61 days');
    expect(await hold(fresh, '301', 1, 'differs')).toBe(true);
    expect(await hold(fresh, '302', 1, 'voided')).toBe(true);
    expect(await hold(fresh, '303', 1, 'incomplete')).toBe(true);
    expect(await dueIds(fresh, '90 days')).toEqual([]);
    for (const id of ['301', '302', '303']) await age(fresh, id, 1, 'checked_at', '19 hours');
    expect(await dueIds(fresh, '90 days')).toEqual([]);
    for (const id of ['301', '302', '303']) await age(fresh, id, 1, 'checked_at', '21 hours');
    expect(await dueIds(fresh, '90 days')).toEqual(['301v1']);
    await fresh.close();
  });

  it("looks again at one waiting for NetSuite's invoice at every run in its first three days, then a day on", async () => {
    const fresh = await freshDb();
    await invoice(fresh, '311', '2 hours');
    await invoice(fresh, '312', '4 days');
    await invoice(fresh, '313', '61 days');
    for (const id of ['311', '312', '313']) expect(await hold(fresh, id, 1, 'waiting')).toBe(true);
    expect(await row(fresh, '311')).toMatchObject({ state: 'held', held_for: 'waiting' });
    for (const id of ['311', '312', '313']) await age(fresh, id, 1, 'checked_at', '89 minutes');
    expect(await dueIds(fresh, '90 days')).toEqual([]);
    for (const id of ['311', '312', '313']) await age(fresh, id, 1, 'checked_at', '91 minutes');
    expect(await dueIds(fresh, '90 days')).toEqual(['311v1']);
    // Looked at the same time, the lower id first.
    for (const id of ['311', '312', '313']) await age(fresh, id, 1, 'checked_at', '21 hours');
    expect(await dueIds(fresh, '90 days')).toEqual(['311v1', '312v1']);
    await age(fresh, '312', 1, 'checked_at', '22 hours');
    expect(await dueIds(fresh, '90 days')).toEqual(['312v1', '311v1']);
    // A new one is looked at first, whatever has waited longer.
    await invoice(fresh, '314', '5 minutes');
    expect(await dueIds(fresh, '90 days')).toEqual(['314v1', '312v1', '311v1']);
    expect(await dueIds(fresh, '90 days', 1)).toEqual(['314v1']);
    await fresh.close();
  });
});

describe('migration 498: holding back, sending, answering', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await invoice(db, '401');
    await invoice(db, '402');
    await invoice(db, '403');
    await invoice(db, '404', '1 hour', 1, null);
  });
  afterAll(async () => { await db.close(); });

  it('holds back only the current version, for a reason it knows', async () => {
    await expect(hold(db, '401', 1, 'late')).rejects.toThrow("late isn't a reason to hold one back");
    await expect(hold(db, '401', 1, null)).rejects.toThrow("nothing isn't a reason to hold one back");
    expect(await hold(db, '401', 2, 'differs')).toBe(false);
    expect(await hold(db, '999', 1, 'differs')).toBe(false);
    expect(await hold(db, '401', 1, 'differs')).toBe(true);
    expect(await row(db, '401')).toMatchObject({ state: 'held', held_for: 'differs', tries: 0, file_name: null, error: null });
    // Held again, for what it is now.
    await age(db, '401', 1, 'checked_at', '1 day');
    expect(await hold(db, '401', 1, 'incomplete')).toBe(true);
    const held = await row(db, '401');
    expect(held.held_for).toBe('incomplete');
    expect(Date.now() - new Date(held.checked_at).getTime()).toBeLessThan(60_000);
  });

  it("puts one on its way once, with the file's name, who sent it and the try", async () => {
    await expect(claim(db, '402', 1, null, false, 'Invoice 402.pdf')).rejects.toThrow("isn't a file name NetSuite takes");
    await expect(claim(db, '402', 1, null, false, 'Invoice_402.txt')).rejects.toThrow("isn't a file name NetSuite takes");
    expect(await claim(db, '999', 1)).toEqual({ claimed: false, why: 'missing' });
    expect(await claim(db, '402', 2)).toEqual({ claimed: false, why: 'changed' });
    expect(await claim(db, '402', 1, CRAIG)).toEqual({ claimed: true, replace_file_id: null, tries: 1 });
    expect(await row(db, '402')).toMatchObject({
      state: 'sending', file_name: 'Invoice_INV402_402.pdf', tries: 1, asked_by: CRAIG, held_for: null, answered_at: null,
    });
    expect(await claim(db, '402', 1)).toEqual({ claimed: false, why: 'sending' });
    // Someone with no profile left sends it as nobody.
    expect((await claim(db, '404', 1, GONE)).claimed).toBe(true);
    expect((await row(db, '404')).asked_by).toBeNull();
  });

  it('keeps what NetSuite answered, once, and only for one on its way', async () => {
    await expect(settle(db, '402', 1, 'took', '1', null, null)).rejects.toThrow("took isn't an answer");
    await expect(settle(db, '402', 1, 'attached', null, null, null)).rejects.toThrow("needs NetSuite's id for the file");
    await expect(settle(db, '402', 1, 'attached', 'f1', null, null)).rejects.toThrow("needs NetSuite's id for the file");
    await expect(settle(db, '402', 1, 'refused', null, null, '  ')).rejects.toThrow('say what went wrong');
    expect(await settle(db, '403', 1, 'attached', '1', null, null)).toBe(false);
    expect(await settle(db, '402', 1, 'attached', '9100', true, 'ignored')).toBe(true);
    expect(await row(db, '402')).toMatchObject({ state: 'attached', file_id: '9100', replaced: null, error: null });
    expect((await row(db, '402')).answered_at).not.toBeNull();
    expect(await settle(db, '402', 1, 'refused', null, null, 'late')).toBe(false);
    expect(await claim(db, '402', 1, CRAIG, true)).toEqual({ claimed: false, why: 'attached' });
    expect(await hold(db, '402', 1, 'voided')).toBe(false);
    expect((await row(db, '402')).state).toBe('attached');
  });

  it('keeps NetSuite\'s reason, cut to 600 characters, and holds back a refused one', async () => {
    expect((await claim(db, '403', 1)).claimed).toBe(true);
    expect(await settle(db, '403', 1, 'refused', '77', true, `  ${'x'.repeat(700)}  `)).toBe(true);
    const refused = await row(db, '403');
    expect(refused).toMatchObject({ state: 'refused', file_id: null, replaced: null });
    expect(refused.error).toHaveLength(600);
    expect(await hold(db, '403', 1, 'differs')).toBe(true);
    expect(await row(db, '403')).toMatchObject({ state: 'held', held_for: 'differs', error: null, answered_at: null, tries: 1 });
  });

  it('sends a held one, counting each try, and after three tries only when a super admin sends it again', async () => {
    expect(await claim(db, '403', 1)).toEqual({ claimed: true, replace_file_id: null, tries: 2 });
    expect(await settle(db, '403', 1, 'unsure', null, null, "NetSuite didn't answer in time.")).toBe(true);
    expect((await claim(db, '403', 1)).tries).toBe(3);
    expect(await settle(db, '403', 1, 'unsure', null, null, "NetSuite didn't answer in time.")).toBe(true);
    expect(await claim(db, '403', 1)).toEqual({ claimed: false, why: 'tries' });
    expect(await claim(db, '403', 1, CRAIG, true)).toEqual({ claimed: true, replace_file_id: null, tries: 4 });
    expect((await row(db, '403')).asked_by).toBe(CRAIG);
  });

  it('takes the run back from one that never heard back after 15 minutes', async () => {
    expect(await claim(db, '403', 1)).toEqual({ claimed: false, why: 'sending' });
    await age(db, '403', 1, 'started_at', '14 minutes');
    expect(await claim(db, '403', 1, CRAIG, true)).toEqual({ claimed: false, why: 'sending' });
    await age(db, '403', 1, 'started_at', '16 minutes');
    expect(await claim(db, '403', 1, CRAIG, true)).toMatchObject({ claimed: true, tries: 5 });
    await age(db, '403', 1, 'started_at', '16 minutes');
    expect(await hold(db, '403', 1, 'voided')).toBe(true);
  });

  it("names the earlier version's file NetSuite has, to take off the invoice, and whether it came off", async () => {
    await db.query("UPDATE gl_own_invoices SET version = 2 WHERE netsuite_id = '402'");
    expect(await claim(db, '402', 1)).toEqual({ claimed: false, why: 'changed' });
    expect(await claim(db, '402', 2, null, false, 'Invoice_INV402_402_v2.pdf')).toEqual({ claimed: true, replace_file_id: '9100', tries: 1 });
    expect(await settle(db, '402', 2, 'attached', '9200', false, null)).toBe(true);
    expect(await row(db, '402', 2)).toMatchObject({ state: 'attached', file_id: '9200', replaced_file_id: '9100', replaced: false });
    // The first version's row stays as it was.
    expect(await row(db, '402', 1)).toMatchObject({ state: 'attached', file_id: '9100' });

    await db.query("UPDATE gl_own_invoices SET version = 3 WHERE netsuite_id = '402'");
    expect((await claim(db, '402', 3, null, false, 'Invoice_INV402_402_v3.pdf')).replace_file_id).toBe('9200');
    expect(await settle(db, '402', 3, 'refused', '1', true, 'No permission')).toBe(true);
    expect(await row(db, '402', 3)).toMatchObject({ state: 'refused', replaced_file_id: '9200', replaced: null });

    // Past a version NetSuite never took, the file to take off is still the newest one on the invoice.
    await db.query("UPDATE gl_own_invoices SET version = 4 WHERE netsuite_id = '402'");
    expect((await claim(db, '402', 4, null, false, 'Invoice_INV402_402_v4.pdf')).replace_file_id).toBe('9200');
  });

  it("keeps the table's rules", async () => {
    await expect(db.query("INSERT INTO own_invoice_pdfs (invoice_id, version, state) VALUES ('401', 2, 'held')"))
      .rejects.toThrow('check constraint');
    await expect(db.query("INSERT INTO own_invoice_pdfs (invoice_id, version, state, held_for) VALUES ('401', 2, 'attached', 'differs')"))
      .rejects.toThrow('check constraint');
    await expect(db.query("INSERT INTO own_invoice_pdfs (invoice_id, version, state, held_for) VALUES ('999', 1, 'held', 'differs')"))
      .rejects.toThrow('foreign key');
  });
});

describe('migration 498: the invoice page and the daily check', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    for (const id of ['501', '502', '503', '504', '505', '506']) await invoice(db, id);
  });
  afterAll(async () => { await db.close(); });

  it("gives the copy's version and each version's PDF, the newest first", async () => {
    expect(await one(db, "SELECT own_invoice_pdf_state('999') AS r")).toBeNull();
    expect(await one(db, "SELECT own_invoice_pdf_state('501') AS r")).toMatchObject({ version: 1, pdfs: [] });
    await claim(db, '501', 1, CRAIG);
    await settle(db, '501', 1, 'attached', '7001', null, null);
    await db.query("UPDATE gl_own_invoices SET version = 2 WHERE netsuite_id = '501'");
    await hold(db, '501', 2, 'differs');
    const state = await one<{ version: number; made_at: string; pdfs: Array<Record<string, unknown>> }>(db, "SELECT own_invoice_pdf_state('501') AS r");
    expect(state.version).toBe(2);
    expect(state.made_at).toBeTruthy();
    expect(state.pdfs.map((p) => [p.version, p.state])).toEqual([[2, 'held'], [1, 'attached']]);
    expect(state.pdfs[1]).toMatchObject({
      file_name: 'Invoice_INV501_501.pdf', file_id: '7001', asked_by_name: 'Craig George', tries: 1, error: null,
      replaced_file_id: null, replaced: null,
    });
    expect(state.pdfs[0]).toMatchObject({ held_for: 'differs', asked_by_name: null });
  });

  it("tells about what NetSuite refused, and what it's still unsure about after three tries, from the run alone, once", async () => {
    await claim(db, '502', 1);
    await settle(db, '502', 1, 'refused', null, null, 'You do not have permission to attach files');
    await claim(db, '503', 1);
    await settle(db, '503', 1, 'unsure', null, null, "NetSuite didn't answer in time.");
    // Sent from the page: whoever sent it saw what NetSuite said.
    await claim(db, '504', 1, CRAIG);
    await settle(db, '504', 1, 'refused', null, null, 'No');
    // Three tries and still on its way after 15 minutes: never heard back.
    await claim(db, '505', 1);
    await db.query("UPDATE own_invoice_pdfs SET tries = 3 WHERE invoice_id = '505'");
    const toTell = () => one<Array<Record<string, unknown>>>(db, 'SELECT own_invoice_pdfs_to_tell(50) AS r');
    expect(await toTell()).toEqual([
      { invoice_id: '502', version: 1, number: 'INV502', state: 'refused', error: 'You do not have permission to attach files', tries: 1 },
    ]);
    await age(db, '505', 1, 'started_at', '16 minutes');
    await db.query("UPDATE own_invoice_pdfs SET tries = 3 WHERE invoice_id = '503'");
    expect((await toTell()).map((t) => [t.invoice_id, t.state, t.error])).toEqual([
      ['505', 'unsure', 'FleetSuite never heard back from NetSuite.'],
      ['502', 'refused', 'You do not have permission to attach files'],
      ['503', 'unsure', "NetSuite didn't answer in time."],
    ]);
    expect(await one(db, 'SELECT own_invoice_pdfs_to_tell(1) AS r')).toHaveLength(1);
    // Not an earlier version's.
    await db.query("UPDATE gl_own_invoices SET version = 2 WHERE netsuite_id = '503'");
    expect((await toTell()).map((t) => t.invoice_id)).toEqual(['505', '502']);
    // Its fixed version, refused, is told about on its own: marking the earlier one leaves it.
    await claim(db, '503', 2, null, false, 'Invoice_INV503_503_v2.pdf');
    await settle(db, '503', 2, 'refused', null, null, 'No permission');
    await db.query(`SELECT own_invoice_pdfs_mark_told('[{"invoice_id": "503", "version": 1}]'::jsonb)`);
    expect((await toTell()).map((t) => `${t.invoice_id}v${t.version}`)).toEqual(['505v1', '502v1', '503v2']);

    await db.query(`SELECT own_invoice_pdfs_mark_told('[{"invoice_id": "502", "version": 1}, {"invoice_id": "505", "version": 1}, {"invoice_id": "503", "version": 2}]'::jsonb)`);
    expect(await toTell()).toEqual([]);
    const told = await row(db, '502');
    expect(told.told_at).not.toBeNull();
    // Told once: marking again keeps the first time, and a later try doesn't tell again.
    await db.query(`SELECT own_invoice_pdfs_mark_told('[{"invoice_id": "502", "version": 1}]'::jsonb)`);
    expect((await row(db, '502')).told_at).toEqual(told.told_at);
    await age(db, '502', 1, 'answered_at', '21 hours');
    expect((await claim(db, '502', 1)).claimed).toBe(true);
    await settle(db, '502', 1, 'refused', null, null, 'Still no');
    expect(await toTell()).toEqual([]);
    await expect(db.query('SELECT own_invoice_pdfs_mark_told(NULL)')).resolves.toBeTruthy();
  });
});

describe('migration 498: who can reach it', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); await invoice(db, '601'); });
  afterAll(async () => { await db.close(); });

  it('keeps the table and every function to the server', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      await expect(db.query('SELECT * FROM own_invoice_pdfs')).rejects.toThrow('permission denied for table own_invoice_pdfs');
      await expect(db.query('SELECT own_invoice_pdfs_due(now(), 10)')).rejects.toThrow('permission denied for function own_invoice_pdfs_due');
      await expect(db.query("SELECT own_invoice_pdf_hold('601', 1, 'differs')")).rejects.toThrow('permission denied for function own_invoice_pdf_hold');
      await expect(db.query("SELECT own_invoice_pdf_claim('601', 1, 'a.pdf', NULL, false)")).rejects.toThrow('permission denied for function own_invoice_pdf_claim');
      await expect(db.query("SELECT own_invoice_pdf_settle('601', 1, 'attached', '1', NULL, NULL)")).rejects.toThrow('permission denied for function own_invoice_pdf_settle');
      await expect(db.query("SELECT own_invoice_pdf_state('601')")).rejects.toThrow('permission denied for function own_invoice_pdf_state');
      await expect(db.query('SELECT own_invoice_pdfs_to_tell(10)')).rejects.toThrow('permission denied for function own_invoice_pdfs_to_tell');
      await expect(db.query("SELECT own_invoice_pdfs_mark_told('[]')")).rejects.toThrow('permission denied for function own_invoice_pdfs_mark_told');
    }
    await db.exec('RESET ROLE; SET ROLE service_role');
    expect((await claim(db, '601', 1)).claimed).toBe(true);
  });
});
