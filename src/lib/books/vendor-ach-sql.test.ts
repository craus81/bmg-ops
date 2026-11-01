// Migration 491 keeps how each bank account's ACH file for First Bank
// starts, and each file made from a payment run: only the run's ACH payments
// made in NetSuite go in, approved or paid, for what each pays, to the
// vendor's numbers confirmed on a call-back now, no payment in two files
// that aren't set aside, and no two files the same day for the bank from BMG
// with the same letter. A file is downloaded while its vendors' numbers are
// still the ones confirmed, kept locked only while it waits to be uploaded,
// then sent, or set aside with why, its payments let go for a new file. This
// runs migrations 359, 466 and 485 to 491 in an in-memory Postgres (PGlite)
// as the app's server login, the way /api/pay-vendors/ach calls them.
// Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const RUN = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SET = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FILE = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const JESSIE = 'a0000000-0000-4000-8000-000000000002';

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
    -- What migrations 466 to 491 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${JESSIE}');
  `);
  for (const file of [
    '359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '485-payments-received-in-fleetsuite.sql',
    '486-deposits-taken-in-fleetsuite.sql', '487-bank-deposits-made-in-fleetsuite.sql', '488-vendors-paid-in-fleetsuite.sql',
    '490-vendor-bank-numbers-kept-encrypted.sql', '491-ach-file-for-first-bank.sql',
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

type Row = Record<string, any>;
const fails = async (pg: PGlite, sql: string, params: unknown[] = []) => {
  await expect(pg.query(sql, params)).rejects.toThrow();
};

const bill = (id: string, number: string, cents: number) => ({
  bill_netsuite_id: id, number, date: '2026-10-06', due_date: '2026-11-05', open_cents: cents, cents,
});
/** A run saved by Craig, asked for, and approved by Jessie: its payments' ids in order. */
async function approvedRun(pg: PGlite, id: string, account: string, payments: Row[]) {
  const saved = await call(pg, 'vendor_payment_run_save', {
    id, company: 'BMG', bank_account_netsuite_id: account, bank_account_name: `${account} Checking`, pay_date: '2026-11-06',
    memo: 'November run', by: CRAIG, payments,
  });
  expect(saved.saved).toBe(true);
  expect(await call(pg, 'vendor_payment_run_ask', { id, by: CRAIG, updated_at: saved.updated_at })).toMatchObject({ state: 'asked' });
  const askedAt = (await pg.query<{ t: string }>(`SELECT to_jsonb(asked_at) #>> '{}' AS t FROM vendor_payment_runs WHERE id = $1`, [id])).rows[0].t;
  expect(await call(pg, 'vendor_payment_run_approve', { id, approver: JESSIE, asked_at: askedAt })).toMatchObject({ state: 'claimed' });
  return (await pg.query<Row>('SELECT id FROM vendor_payment_run_payments WHERE run_id = $1 ORDER BY position', [id])).rows.map((r) => r.id as string);
}
async function make(pg: PGlite, paymentId: string, billPaymentId: string) {
  expect(await call(pg, 'vendor_payment_claim', { id: paymentId, by: JESSIE })).toMatchObject({ state: 'claimed' });
  expect(await call(pg, 'vendor_payment_made', { id: paymentId, netsuite_payment_id: billPaymentId, netsuite_number: `ACH ${billPaymentId}` }))
    .toMatchObject({ made: true });
}

/** Locked text, shaped as src/lib/vendor-bank-lock.ts makes it (made up: nothing opens it). */
const LOCKED = (n: number, body = 70) => `v1.0a1b2c3d.${'A'.repeat(15)}${n % 10}.${'B'.repeat(22)}.${'C'.repeat(body)}${n}`;
const SEAL = `0a1b2c3d.${'D'.repeat(43)}`;

/** A vendor's numbers as each is kept: entered by Craig, confirmed by Jessie on a call-back. */
const NUMBERS: Record<string, Row> = {
  '47': { vendor_name: 'Gateway Steel', routing_number: '071200004', account_last4: '1234', account_type: 'savings', name_on_account: 'Gateway Steel Inc' },
  '52': { vendor_name: 'Acme Fasteners', routing_number: '123456780', account_last4: '5678', account_type: 'checking', name_on_account: 'Acme Fasteners' },
  '60': { vendor_name: 'Delta Lighting', routing_number: '123456780', account_last4: '9012', account_type: 'checking', name_on_account: 'Delta Lighting LLC' },
};
async function confirmed(pg: PGlite, id: string, vendor: string, over: Row = {}) {
  expect(await call(pg, 'vendor_bank_enter', {
    id, vendor_netsuite_id: vendor, ...NUMBERS[vendor], source: 'ACH form emailed by the vendor', account_locked: LOCKED(Number(id.slice(-3))),
    by: CRAIG, ...over,
  })).toMatchObject({ state: 'entered' });
  expect(await call(pg, 'vendor_bank_confirm', { id, by: JESSIE, called_phone: '636-555-0142', spoke_with: 'Dana in accounts', confirm_seal: SEAL }))
    .toMatchObject({ state: 'confirmed' });
}

/** A payment as it goes in a file, to the vendor's numbers kept as `set`. */
const inFile = (paymentId: string, vendor: string, set: string, cents: number, over: Row = {}) => {
  const { vendor_name, routing_number, account_last4, account_type, name_on_account } = NUMBERS[vendor];
  return {
    payment_id: paymentId, vendor_netsuite_id: vendor, vendor_name: ` ${vendor_name} `, bank_account_id: set, routing_number, account_last4,
    account_type, name_on_account, cents, ...over,
  };
};
/** A file made from run 1 on 211 on November 4 at 9:15, its letter A, First Bank paying it November 6. */
const file = (id: string, payments: Row[], over: Row = {}) => ({
  id, company: 'BMG', bank_account_netsuite_id: '211', run_id: RUN(1), destination: '081999994', origin: '1431234567',
  created_on: '2026-11-04', created_time: '0915', modifier: 'A', effective_date: '2026-11-06',
  entry_count: payments.length, total_cents: payments.reduce((sum, p) => sum + p.cents, 0), entry_hash: '0019465600',
  file_name: 'ACH-BMG-2026-11-04-A.txt', file_locked: LOCKED(Number(id.slice(-3)), 400), by: CRAIG, payments, ...over,
});

const fileRow = async (pg: PGlite, id: string) => (await pg.query<Row>(`
  SELECT company, bank_account_netsuite_id, run_id, destination, origin, to_char(created_on, 'YYYY-MM-DD') AS created_on, created_time, modifier,
         to_char(effective_date, 'YYYY-MM-DD') AS effective_date, entry_count, total_cents::int AS total_cents, entry_hash, file_name, file_locked,
         status, made_by, downloads, downloaded_by, downloaded_at IS NOT NULL AS has_downloaded_at, sent_by, sent_at IS NOT NULL AS has_sent_at,
         set_aside_by, set_aside_at IS NOT NULL AS has_set_aside_at, set_aside_why
  FROM vendor_ach_files WHERE id = $1`, [id])).rows[0];
const paymentsOf = async (pg: PGlite, fileId: string) => (await pg.query<Row>(`
  SELECT payment_id, position, vendor_netsuite_id, vendor_name, bank_account_id, routing_number, account_last4, account_type, name_on_account,
         cents::int AS cents, live
  FROM vendor_ach_file_payments WHERE file_id = $1 ORDER BY position`, [fileId])).rows;
const filesKept = async (pg: PGlite) => (await pg.query<Row>('SELECT id FROM vendor_ach_files ORDER BY made_at, id')).rows.map((r) => r.id);

describe('migration 491', () => {
  let pg: PGlite;
  // Run 1 from 211: Ozark by check and Gateway by ACH, both made; Acme by ACH, not made yet. Run 2 from 214: Delta by ACH, made.
  let ozark: string, gateway: string, acme: string, delta: string;

  beforeAll(async () => {
    pg = await freshDb();
    [ozark, gateway, acme] = await approvedRun(pg, RUN(1), '211', [
      { vendor_netsuite_id: '31', vendor_name: 'Ozark Hose & Fitting', method: 'check', bills: [bill('7001', 'B-4410', 81240)] },
      { vendor_netsuite_id: '47', vendor_name: 'Gateway Steel', method: 'ach', bills: [bill('7003', 'GS-209', 245000)] },
      { vendor_netsuite_id: '52', vendor_name: 'Acme Fasteners', method: 'ach', bills: [bill('7004', 'AF-17', 30000)] },
    ]);
    [delta] = await approvedRun(pg, RUN(2), '214', [
      { vendor_netsuite_id: '60', vendor_name: 'Delta Lighting', method: 'ach', bills: [bill('7005', 'DL-3', 5000), bill('7006', 'DL-4', 2500)] },
    ]);
    await make(pg, ozark, '8302');
    await make(pg, gateway, '8301');
    await make(pg, delta, '8304');
    // A draft from 211 that's never approved.
    expect((await call(pg, 'vendor_payment_run_save', {
      id: RUN(3), company: 'BMG', bank_account_netsuite_id: '211', pay_date: '2026-11-06', by: CRAIG, payments: [],
    })).saved).toBe(true);

    await confirmed(pg, SET(1), '47');
    await confirmed(pg, SET(2), '52');
    await confirmed(pg, SET(3), '60');
  });
  afterAll(async () => { await pg.close(); });

  it('makes a file from runs approved or paid, from the bank account and company they pay from', async () => {
    expect((await pg.query<Row>('SELECT id, status FROM vendor_payment_runs WHERE id = ANY($1) ORDER BY id', [[RUN(1), RUN(2)]])).rows)
      .toEqual([{ id: RUN(1), status: 'approved' }, { id: RUN(2), status: 'done' }]);
    const gw = [inFile(gateway, '47', SET(1), 245000)];
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(90), gw, { run_id: RUN(3) }))).toEqual({ state: 'run' });
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(90), gw, { run_id: RUN(99) }))).toEqual({ state: 'run' });
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(90), gw, { bank_account_netsuite_id: '214' }))).toEqual({ state: 'run' });
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(90), gw, { company: '1084' }))).toEqual({ state: 'run' });
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(90), gw, { company: null }))).toEqual({ state: 'run' });
    expect(await filesKept(pg)).toEqual([]);
  });

  it("takes only the run's ACH payments made in NetSuite, for what they pay, to the vendor's numbers confirmed now", async () => {
    const save = (payments: Row[], over: Row = {}) => call(pg, 'vendor_ach_file_save', file(FILE(90), payments, over));
    const refused = (id: string, why: string) => ({ state: 'payment', payment_id: id, why });
    // Not by ACH, another run's, another vendor's, or no payment at all.
    expect(await save([inFile(ozark, '47', SET(1), 81240, { vendor_netsuite_id: '31' })])).toEqual(refused(ozark, 'not_ach'));
    expect(await save([inFile(delta, '60', SET(3), 7500)])).toEqual(refused(delta, 'not_ach'));
    expect(await save([inFile(gateway, '47', SET(1), 245000, { vendor_netsuite_id: '52' })])).toEqual(refused(gateway, 'not_ach'));
    expect(await save([inFile(gateway, '47', SET(1), 245000, { vendor_netsuite_id: null })])).toEqual(refused(gateway, 'not_ach'));
    expect(await save([inFile(RUN(77), '47', SET(1), 245000)])).toEqual(refused(RUN(77), 'not_ach'));
    // Not made in NetSuite yet, or not for what it pays.
    expect(await save([inFile(acme, '52', SET(2), 30000)])).toEqual(refused(acme, 'not_made'));
    expect(await save([inFile(gateway, '47', SET(1), 244999)])).toEqual(refused(gateway, 'cents'));
    expect(await save([inFile(gateway, '47', SET(1), 245000, { cents: null })])).toEqual(refused(gateway, 'cents'));
    // To numbers that aren't the vendor's confirmed now, as they're shown.
    for (const over of [
      { bank_account_id: SET(2) }, { bank_account_id: SET(99) }, { routing_number: '123456780' }, { account_last4: '1235' },
      { account_type: 'checking' }, { name_on_account: 'GATEWAY STEEL INC' }, { name_on_account: null },
    ]) {
      expect(await save([inFile(gateway, '47', SET(1), 245000, over)])).toEqual(refused(gateway, 'bank'));
    }
    // Another vendor's numbers confirmed, just as they're shown.
    const acmes = { routing_number: '123456780', account_last4: '5678', account_type: 'checking', name_on_account: 'Acme Fasteners' };
    expect(await save([inFile(gateway, '47', SET(2), 245000, acmes)])).toEqual(refused(gateway, 'bank'));
    expect(await call(pg, 'vendor_bank_enter', {
      id: SET(4), vendor_netsuite_id: '47', ...NUMBERS['47'], account_last4: '4321', source: 'New ACH form from Gateway', account_locked: LOCKED(4), by: CRAIG,
    })).toMatchObject({ state: 'entered' });
    expect(await save([inFile(gateway, '47', SET(4), 245000, { account_last4: '4321' })])).toEqual(refused(gateway, 'bank'));
    // A count or total that isn't its payments', or no payments at all.
    expect(await save([inFile(gateway, '47', SET(1), 245000)], { entry_count: 2 })).toEqual({ state: 'totals' });
    expect(await save([inFile(gateway, '47', SET(1), 245000)], { total_cents: 245001 })).toEqual({ state: 'totals' });
    expect(await save([inFile(gateway, '47', SET(1), 245000)], { total_cents: null })).toEqual({ state: 'totals' });
    expect(await save([])).toEqual({ state: 'totals' });
    expect(await save([], { payments: null, entry_count: 0, total_cents: 0 })).toEqual({ state: 'totals' });
    expect(await filesKept(pg)).toEqual([]);
  });

  it("keeps nothing that a file can't be", async () => {
    const gw = [inFile(gateway, '47', SET(1), 245000)];
    for (const over of [
      { file_locked: null }, { file_locked: '1 01 0819999941431234567261104' }, { file_locked: `x${LOCKED(90, 400)}` },
      { file_locked: LOCKED(90, 60_000) }, { modifier: 'a' }, { modifier: 'AB' }, { created_time: '2460' }, { created_time: '915' },
      { effective_date: '2026-11-03' }, { entry_hash: '19465600' }, { file_name: 'ACH file.txt' }, { file_name: '../ACH.txt' },
      { destination: '81999994' }, { origin: ' 081999994' }, { origin: '143123456A1' }, { id: null },
    ]) {
      await expect(call(pg, 'vendor_ach_file_save', file(FILE(90), gw, over))).rejects.toThrow();
    }
    // The same payment twice in a file.
    await expect(call(pg, 'vendor_ach_file_save', file(FILE(90), [...gw, ...gw], { total_cents: 490000 }))).rejects.toThrow();
    expect(await filesKept(pg)).toEqual([]);
    expect((await pg.query('SELECT 1 FROM vendor_ach_file_payments')).rows).toEqual([]);
  });

  it('keeps the file made, locked, with its payments in order, once per press', async () => {
    const payments = [inFile(gateway, '47', SET(1), 245000)];
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(1), payments))).toEqual({ state: 'made' });
    expect(await fileRow(pg, FILE(1))).toEqual({
      company: 'BMG', bank_account_netsuite_id: '211', run_id: RUN(1), destination: '081999994', origin: '1431234567', created_on: '2026-11-04',
      created_time: '0915', modifier: 'A', effective_date: '2026-11-06', entry_count: 1, total_cents: 245000, entry_hash: '0019465600',
      file_name: 'ACH-BMG-2026-11-04-A.txt', file_locked: LOCKED(1, 400), status: 'made', made_by: CRAIG, downloads: 0, downloaded_by: null,
      has_downloaded_at: false, sent_by: null, has_sent_at: false, set_aside_by: null, has_set_aside_at: false, set_aside_why: null,
    });
    expect(await paymentsOf(pg, FILE(1))).toEqual([{
      payment_id: gateway, position: 1, vendor_netsuite_id: '47', vendor_name: 'Gateway Steel', bank_account_id: SET(1), routing_number: '071200004',
      account_last4: '1234', account_type: 'savings', name_on_account: 'Gateway Steel Inc', cents: 245000, live: true,
    }]);

    // The same press again is the same file, whatever it says now.
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(1), payments, { modifier: 'B' }))).toEqual({ state: 'made_already' });
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(1), [], { run_id: RUN(3) }))).toEqual({ state: 'made_already' });
    // A payment in a file isn't put in another.
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(3), payments, { modifier: 'C' }))).toEqual({ state: 'payment', payment_id: gateway, why: 'in_file' });
    expect(await filesKept(pg)).toEqual([FILE(1)]);
  });

  it('gives each file made the same day for the bank from BMG its own letter', async () => {
    const run2 = (over: Row) => file(FILE(2), [inFile(delta, '60', SET(3), 7500, { vendor_name: null })], {
      run_id: RUN(2), bank_account_netsuite_id: '214', file_name: 'ACH-BMG-2026-11-04-B.txt', ...over,
    });
    expect(await call(pg, 'vendor_ach_file_save', run2({ modifier: 'A' }))).toEqual({ state: 'modifier_taken' });
    expect(await filesKept(pg)).toEqual([FILE(1)]);
    expect((await pg.query('SELECT 1 FROM vendor_ach_file_payments WHERE payment_id = $1', [delta])).rows).toEqual([]);
    expect(await call(pg, 'vendor_ach_file_save', run2({ modifier: 'B' }))).toEqual({ state: 'made' });
    expect(await paymentsOf(pg, FILE(2))).toMatchObject([{ payment_id: delta, position: 1, vendor_name: null, cents: 7500, live: true }]);
    // Not even the server's login puts a payment in two files that aren't set aside.
    await fails(pg, `
      INSERT INTO vendor_ach_file_payments (file_id, payment_id, position, vendor_netsuite_id, bank_account_id, routing_number, account_last4,
                                            account_type, name_on_account, cents)
      VALUES ($1, $2, 2, '60', $3, '123456780', '9012', 'checking', 'Delta Lighting LLC', 7500)`, [FILE(1), delta, SET(3)]);
  });

  it("is downloaded while each vendor's numbers in it are the ones confirmed", async () => {
    expect(await call(pg, 'vendor_ach_file_downloaded', { id: FILE(1), by: CRAIG })).toEqual({ state: 'downloaded', downloads: 1 });
    expect(await call(pg, 'vendor_ach_file_downloaded', { id: FILE(1), by: JESSIE })).toEqual({ state: 'downloaded', downloads: 2 });
    expect(await fileRow(pg, FILE(1))).toMatchObject({ status: 'made', downloads: 2, downloaded_by: JESSIE, has_downloaded_at: true, file_locked: LOCKED(1, 400) });

    // Gateway's new numbers confirmed replace the ones in the file, and Delta's are removed.
    expect(await call(pg, 'vendor_bank_confirm', { id: SET(4), by: JESSIE, called_phone: '636-555-0142', spoke_with: 'Dana', confirm_seal: SEAL }))
      .toEqual({ state: 'confirmed', replaced: SET(1) });
    expect(await call(pg, 'vendor_ach_file_downloaded', { id: FILE(1), by: CRAIG })).toEqual({ state: 'bank', vendor_name: 'Gateway Steel' });
    expect(await call(pg, 'vendor_bank_end', { id: SET(3), by: CRAIG, status: 'removed', why: 'Delta wants checks again.' })).toEqual({ state: 'removed' });
    expect(await call(pg, 'vendor_ach_file_downloaded', { id: FILE(2), by: CRAIG })).toEqual({ state: 'bank', vendor_name: 'Vendor 60' });
    expect(await fileRow(pg, FILE(1))).toMatchObject({ downloads: 2, downloaded_by: JESSIE });
    expect(await call(pg, 'vendor_ach_file_downloaded', { id: FILE(99), by: CRAIG })).toEqual({ state: 'gone' });
  });

  it('is set aside with why, its locked copy gone and its payments let go for a new file', async () => {
    const setAside = (id: string, why: unknown, by = CRAIG) => call(pg, 'vendor_ach_file_set_aside', { id, by, why });
    for (const why of ['', '   ', null, 'First Bank says account 123456 is closed', 'y'.repeat(301)]) {
      await expect(setAside(FILE(1), why)).rejects.toThrow();
    }
    expect(await fileRow(pg, FILE(1))).toMatchObject({ status: 'made', file_locked: LOCKED(1, 400) });

    expect(await setAside(FILE(1), "  Gateway's numbers changed before it was uploaded.  ")).toEqual({ state: 'set_aside', was: 'made' });
    expect(await fileRow(pg, FILE(1))).toMatchObject({
      status: 'set_aside', file_locked: null, set_aside_by: CRAIG, has_set_aside_at: true, set_aside_why: "Gateway's numbers changed before it was uploaded.",
      downloads: 2,
    });
    expect(await paymentsOf(pg, FILE(1))).toMatchObject([{ payment_id: gateway, live: false }]);
    expect(await setAside(FILE(1), 'Again')).toEqual({ state: 'set_aside_already' });
    expect(await call(pg, 'vendor_ach_file_downloaded', { id: FILE(1), by: CRAIG })).toEqual({ state: 'set_aside' });
    expect(await call(pg, 'vendor_ach_file_sent', { id: FILE(1), by: CRAIG })).toEqual({ state: 'set_aside' });
    expect(await setAside(FILE(99), 'Gone')).toEqual({ state: 'gone' });

    // Gateway goes in a new file to its new numbers, made the next day: letter A again.
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(4), [inFile(gateway, '47', SET(4), 245000, { account_last4: '4321' })], {
      created_on: '2026-11-05', file_name: 'ACH-BMG-2026-11-05-A.txt',
    }))).toEqual({ state: 'made' });
    expect(await paymentsOf(pg, FILE(4))).toMatchObject([{ payment_id: gateway, bank_account_id: SET(4), account_last4: '4321', live: true }]);
  });

  it('is sent to First Bank, its locked copy gone, and set aside after if First Bank refuses it', async () => {
    expect(await call(pg, 'vendor_ach_file_sent', { id: FILE(4), by: JESSIE })).toEqual({ state: 'sent' });
    expect(await fileRow(pg, FILE(4))).toMatchObject({ status: 'sent', file_locked: null, sent_by: JESSIE, has_sent_at: true });
    expect(await call(pg, 'vendor_ach_file_sent', { id: FILE(4), by: CRAIG })).toEqual({ state: 'sent_already' });
    expect(await fileRow(pg, FILE(4))).toMatchObject({ sent_by: JESSIE });
    expect(await call(pg, 'vendor_ach_file_downloaded', { id: FILE(4), by: CRAIG })).toEqual({ state: 'sent' });
    expect(await call(pg, 'vendor_ach_file_sent', { id: FILE(99), by: CRAIG })).toEqual({ state: 'gone' });
    // Sent, its payments stay in it.
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(5), [inFile(gateway, '47', SET(4), 245000, { account_last4: '4321' })], {
      created_on: '2026-11-05', modifier: 'B',
    }))).toEqual({ state: 'payment', payment_id: gateway, why: 'in_file' });

    expect(await call(pg, 'vendor_ach_file_set_aside', { id: FILE(4), by: CRAIG, why: 'First Bank returned it: the batch was out of balance.' }))
      .toEqual({ state: 'set_aside', was: 'sent' });
    expect(await fileRow(pg, FILE(4))).toMatchObject({ status: 'set_aside', sent_by: JESSIE, has_sent_at: true, set_aside_by: CRAIG });
    expect(await paymentsOf(pg, FILE(4))).toMatchObject([{ live: false }]);
  });

  it("holds a file's rules even for the server's login", async () => {
    // FILE(2) is made and locked.
    await fails(pg, `UPDATE vendor_ach_files SET status = 'sent', sent_at = now() WHERE id = $1`, [FILE(2)]);
    await fails(pg, 'UPDATE vendor_ach_files SET file_locked = NULL WHERE id = $1', [FILE(2)]);
    await fails(pg, `UPDATE vendor_ach_files SET status = 'set_aside', set_aside_at = now(), file_locked = NULL WHERE id = $1`, [FILE(2)]);
    await fails(pg, 'UPDATE vendor_ach_files SET downloads = 1 WHERE id = $1', [FILE(2)]);
    await fails(pg, 'UPDATE vendor_ach_files SET sent_at = now() WHERE id = $1', [FILE(2)]);
    await fails(pg, 'UPDATE vendor_ach_files SET entry_count = 51 WHERE id = $1', [FILE(2)]);
    await fails(pg, 'UPDATE vendor_ach_files SET entry_count = 0 WHERE id = $1', [FILE(2)]);
    await fails(pg, 'UPDATE vendor_ach_files SET total_cents = 0 WHERE id = $1', [FILE(2)]);
    await fails(pg, 'UPDATE vendor_ach_files SET downloads = -1, downloaded_at = now() WHERE id = $1', [FILE(2)]);
    await fails(pg, `UPDATE vendor_ach_files SET status = 'sent', file_locked = NULL WHERE id = $1`, [FILE(2)]);
    // FILE(1) is set aside.
    await fails(pg, 'UPDATE vendor_ach_files SET file_locked = $1 WHERE id = $2', [LOCKED(1, 400), FILE(1)]);
    await fails(pg, 'UPDATE vendor_ach_files SET set_aside_why = NULL WHERE id = $1', [FILE(1)]);
    await fails(pg, `UPDATE vendor_ach_files SET set_aside_why = 'Account 7700012345' WHERE id = $1`, [FILE(1)]);
    expect(await fileRow(pg, FILE(2))).toMatchObject({ status: 'made', downloads: 0, file_locked: LOCKED(2, 400) });

    // A payment in FILE(2) after Delta's: each in its own place from 1, to numbers as they're shown, for something.
    const pay = (over: Row) => {
      const row: Row = {
        file_id: FILE(2), payment_id: acme, position: 2, vendor_netsuite_id: '52', vendor_name: 'Acme Fasteners', bank_account_id: SET(2),
        routing_number: '123456780', account_last4: '5678', account_type: 'checking', name_on_account: 'Acme Fasteners', cents: 30000, ...over,
      };
      const cols = Object.keys(row);
      return pg.query(`INSERT INTO vendor_ach_file_payments (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => row[c]));
    };
    await pg.query('BEGIN');
    await pay({});
    await pg.query('ROLLBACK');
    for (const over of [{ position: 0 }, { position: 1 }, { account_last4: '45678' }, { name_on_account: 'A'.repeat(23) }, { cents: 0 }]) {
      await expect(pay(over), JSON.stringify(over)).rejects.toThrow();
    }
    expect(await paymentsOf(pg, FILE(2))).toMatchObject([{ payment_id: delta, position: 1 }]);
  });

  it("keeps how each bank account's file starts, BMG's account only locked and only when the file is balanced", async () => {
    const setup = {
      bank_account_netsuite_id: '211', company: 'BMG', destination: '081999994', destination_name: 'FIRST BANK', origin: '1431234567',
      origin_name: 'BMG FLEET INSTALLATIONS', odfi: '08199999', company_name: 'BMG FLEET INSTAL', company_id: '1431234567',
      entry_description: 'VENDOR PAY', sec_code: 'CCD', addenda: true, balanced: false, line_ending: 'crlf', updated_by: CRAIG,
    };
    const offset = { offset_routing: '081999994', offset_last4: '2345', offset_type: 'checking', offset_locked: LOCKED(5) };
    const put = (row: Row) => {
      const cols = Object.keys(row);
      return pg.query(
        `INSERT INTO vendor_ach_setups (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (bank_account_netsuite_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
        cols.map((c) => row[c]),
      );
    };
    await put(setup);
    await put({ ...setup, bank_account_netsuite_id: '214', origin: '081999994', balanced: true, line_ending: 'lf', ...offset });
    expect((await pg.query<Row>('SELECT bank_account_netsuite_id AS id, balanced, offset_last4, updated_at IS NOT NULL AS has_updated_at FROM vendor_ach_setups ORDER BY 1')).rows)
      .toEqual([{ id: '211', balanced: false, offset_last4: null, has_updated_at: true }, { id: '214', balanced: true, offset_last4: '2345', has_updated_at: true }]);

    for (const over of [
      { balanced: true }, { ...offset }, { balanced: true, ...offset, offset_locked: null }, { balanced: true, ...offset, offset_locked: '7700012345' },
      { balanced: true, ...offset, offset_last4: '12345' }, { balanced: true, ...offset, offset_type: 'money_market' },
      { balanced: true, ...offset, offset_routing: '08199999' }, { balanced: true, ...offset, offset_locked: `x${LOCKED(5)}` },
      { balanced: true, ...offset, offset_routing: null }, { balanced: true, ...offset, offset_last4: null }, { balanced: true, ...offset, offset_type: null },
      { offset_routing: '081999994' }, { offset_last4: '2345' }, { offset_type: 'checking' },
      { destination_name: 'D'.repeat(24) }, { origin_name: 'O'.repeat(24) },
      { destination: '81999994' }, { destination_name: 'First Bank' }, { destination_name: 'FIRST BANK ' }, { destination_name: 'FIRST BANK OF MISSOURI ST' },
      { origin: ' 081999994' }, { origin: '14312345' }, { origin_name: 'BMG FLEET INSTALLATIONS L' }, { origin_name: 'BMG; FLEET' },
      { odfi: '081999994' }, { company_name: 'BMG FLEET INSTALL' }, { company_id: '1431234567A' }, { company_id: 'bmg' },
      { entry_description: 'VENDOR PAYS' }, { entry_description: '' }, { sec_code: 'WEB' }, { line_ending: 'cr' }, { addenda: null },
      { bank_account_netsuite_id: 'Operating' }, { company: ' ' },
    ]) {
      await expect(put({ ...setup, ...over }), JSON.stringify(over)).rejects.toThrow();
    }
    expect((await pg.query<Row>(`SELECT balanced, destination_name, company_id FROM vendor_ach_setups WHERE bank_account_netsuite_id = '211'`)).rows)
      .toEqual([{ balanced: false, destination_name: 'FIRST BANK', company_id: '1431234567' }]);
  });

  it("is the server's login only", async () => {
    const tables = ['vendor_ach_setups', 'vendor_ach_files', 'vendor_ach_file_payments'];
    const fns = ['vendor_ach_file_save', 'vendor_ach_file_downloaded', 'vendor_ach_file_sent', 'vendor_ach_file_set_aside'];
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${role}`);
      for (const t of tables) await fails(pg, `SELECT * FROM ${t}`);
      for (const fn of fns) await fails(pg, `SELECT ${fn}('{}'::jsonb)`);
    }
    await pg.exec('RESET ROLE; SET ROLE service_role');
    expect((await pg.query('SELECT count(*)::int AS n FROM vendor_ach_files')).rows).toEqual([{ n: 3 }]);
    // Nor through PUBLIC, and behind row security even so.
    const reach = await pg.query<{ t: boolean; e: boolean }>(`
      SELECT has_table_privilege(r.role, 'public.' || t.name, 'SELECT') AS t, false AS e
      FROM unnest(ARRAY['anon', 'authenticated']) AS r(role), unnest($1::text[]) AS t(name)
      UNION ALL
      SELECT false, has_function_privilege(r.role, 'public.' || f.fn || '(jsonb)', 'EXECUTE')
      FROM unnest(ARRAY['anon', 'authenticated']) AS r(role), unnest($2::text[]) AS f(fn)`, [tables, fns]);
    expect(reach.rows).toHaveLength(14);
    expect(reach.rows.filter((x) => x.t || x.e)).toEqual([]);
    expect((await pg.query<Row>(`SELECT relname, relrowsecurity AS on FROM pg_class WHERE relname = ANY($1) ORDER BY relname`, [tables])).rows)
      .toEqual(tables.slice().sort().map((relname) => ({ relname, on: true })));
  });

  it("puts a file's payments in its order, each in its own place", async () => {
    const [p47, p52] = await approvedRun(pg, RUN(4), '211', [
      { vendor_netsuite_id: '47', vendor_name: 'Gateway Steel', method: 'ach', bills: [bill('7010', 'GS-214', 120000)] },
      { vendor_netsuite_id: '52', vendor_name: 'Acme Fasteners', method: 'ach', bills: [bill('7011', 'AF-19', 30000)] },
    ]);
    await make(pg, p47, '8310');
    await make(pg, p52, '8311');
    const payments = [inFile(p52, '52', SET(2), 30000), inFile(p47, '47', SET(4), 120000, { account_last4: '4321' })];
    expect(await call(pg, 'vendor_ach_file_save', file(FILE(6), payments, {
      run_id: RUN(4), created_on: '2026-11-05', modifier: 'C', file_name: 'ACH-BMG-2026-11-05-C.txt',
    }))).toEqual({ state: 'made' });
    expect((await paymentsOf(pg, FILE(6))).map((r) => [r.payment_id, r.position])).toEqual([[p52, 1], [p47, 2]]);
  });
});
