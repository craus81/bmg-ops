// Migration 489 keeps where each bank account's checks print on its stock,
// and one row per check number FleetSuite gives a payment run's checks on a
// bank account: taken all or none for the run's checks made in NetSuite,
// numbered once NetSuite takes the number (the payment and Books' own copy
// of the bill payment taking it as NetSuite's number), let go when NetSuite
// doesn't, printed, or spoiled with why and its number never given again,
// and a check printed from NetSuite kept with NetSuite's number. The numbers
// used on a bank account, and the highest, come from FleetSuite's checks and
// the checks, bill payments and refunds in NetSuite's copy. This runs
// migrations 359 to 361 with 466 and 485 to 489 in an in-memory Postgres
// (PGlite) as the app's server login, the way /api/pay-vendors/checks calls
// them. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const RUN = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const JESSIE = 'a0000000-0000-4000-8000-000000000002';
const NOBODY = 'c0000000-0000-4000-8000-000000000099';

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
    -- What migrations 466 to 489 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${JESSIE}');
  `);
  for (const file of [
    '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql', '466-credit-memos-in-fleetsuite.sql',
    '485-payments-received-in-fleetsuite.sql', '486-deposits-taken-in-fleetsuite.sql', '487-bank-deposits-made-in-fleetsuite.sql',
    '488-vendors-paid-in-fleetsuite.sql', '489-checks-printed-in-fleetsuite.sql',
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
const bill = (id: string, number: string, cents: number) => ({
  bill_netsuite_id: id, number, date: '2026-10-06', due_date: '2026-11-05', open_cents: cents, cents,
});
/** A run saved by Craig, asked for, and approved by Jessie. */
async function approvedRun(pg: PGlite, id: string, account: string, payments: Row[]) {
  const saved = await call(pg, 'vendor_payment_run_save', {
    id, company: 'BMG', bank_account_netsuite_id: account, bank_account_name: `${account} Checking`, pay_date: '2026-11-06',
    memo: 'November run', by: CRAIG, payments,
  });
  expect(saved.saved).toBe(true);
  expect(await call(pg, 'vendor_payment_run_ask', { id, by: CRAIG, updated_at: saved.updated_at })).toMatchObject({ state: 'asked' });
  const askedAt = (await pg.query<{ t: string }>(`SELECT to_jsonb(asked_at) #>> '{}' AS t FROM vendor_payment_runs WHERE id = $1`, [id])).rows[0].t;
  expect(await call(pg, 'vendor_payment_run_approve', { id, approver: JESSIE, asked_at: askedAt })).toMatchObject({ state: 'claimed' });
  return (await pg.query<Row>('SELECT id, vendor_netsuite_id FROM vendor_payment_run_payments WHERE run_id = $1 ORDER BY position', [id])).rows
    .map((r) => r.id as string);
}
async function make(pg: PGlite, paymentId: string, billPaymentId: string) {
  expect(await call(pg, 'vendor_payment_claim', { id: paymentId, by: JESSIE })).toMatchObject({ state: 'claimed' });
  expect(await call(pg, 'vendor_payment_made', { id: paymentId, netsuite_payment_id: billPaymentId, netsuite_number: 'To Print' }))
    .toMatchObject({ made: true });
}
/** A transaction in NetSuite's copy with one line on each account named. */
async function inNetSuite(pg: PGlite, id: string, type: string, tranid: string, accounts: string[]) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, '2026-10-15', '2026-10-01', 'x', 's')`,
    [id, type, tranid],
  );
  for (const [i, account] of accounts.entries()) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, '2026-10-01', '2026-10-15', 0, 10 FROM gl_companies WHERE code = 'BMG'`,
      [id, String(i), account],
    );
  }
}

const PRINTED_AS = { date: '2026-11-06', payee: 'Ozark Hose & Fitting', address: ['1200 Industrial Dr'], cents: 141240, memo: 'November run', vendor_name: 'Ozark Hose & Fitting', account_name: '10100 Operating Checking', bills: [] };
const check = async (pg: PGlite, id: string) => (await pg.query<Row>(`
  SELECT company, bank_account_netsuite_id, check_number::int AS check_number, run_id, payment_id, netsuite_payment_id, status, printed_as,
         numbered_by, numbered_at IS NOT NULL AS has_numbered_at, error, printed_by, printed_at IS NOT NULL AS has_printed_at,
         spoiled_by, spoiled_at IS NOT NULL AS has_spoiled_at, spoiled_reason
  FROM vendor_checks WHERE id = $1`, [id])).rows[0];
const checksOf = async (pg: PGlite, paymentId: string) => (await pg.query<Row>(
  'SELECT check_number::int AS number, status FROM vendor_checks WHERE payment_id = $1 ORDER BY check_number', [paymentId])).rows;
const paymentNumber = async (pg: PGlite, id: string) =>
  (await pg.query<Row>('SELECT netsuite_number FROM vendor_payment_run_payments WHERE id = $1', [id])).rows[0].netsuite_number;
const copyNumber = async (pg: PGlite, id: string) =>
  (await pg.query<Row>('SELECT netsuite_number FROM gl_own_bill_payments WHERE netsuite_id = $1', [id])).rows[0]?.netsuite_number;
const used = async (pg: PGlite, account: string, from: number, to: number) => (await pg.query<{ r: number[] }>(
  'SELECT vendor_check_numbers_used($1, $2::bigint, $3::bigint)::int[] AS r', [account, from, to])).rows[0].r;
const last = async (pg: PGlite, account: string) => (await pg.query<{ r: number | null }>(
  'SELECT vendor_check_last_number($1)::int AS r', [account])).rows[0].r;

describe('migration 489', () => {
  let pg: PGlite;
  // Run 1 from 211: Ozark by check, Gateway by ACH, Acme by check. Run 2 from 214: Delta by check.
  let ozark: string, gateway: string, acme: string, delta: string;
  /** Ozark's checks, as they're taken. */
  let first: string, second: string;
  const claim = (checks: Row[], over: Row = {}) =>
    call(pg, 'vendor_checks_claim', { run_id: RUN(1), by: JESSIE, checks: checks.map((c) => ({ printed_as: PRINTED_AS, ...c })), ...over });

  beforeAll(async () => {
    pg = await freshDb();
    [ozark, gateway, acme] = await approvedRun(pg, RUN(1), '211', [
      { vendor_netsuite_id: '31', vendor_name: 'Ozark Hose & Fitting', method: 'check', bills: [bill('7001', 'B-4410', 81240), bill('7002', 'B-4471', 60000)] },
      { vendor_netsuite_id: '47', vendor_name: 'Gateway Steel', method: 'ach', bills: [bill('7003', 'GS-209', 245000)] },
      { vendor_netsuite_id: '52', vendor_name: 'Acme Fasteners', method: 'check', bills: [bill('7004', 'AF-17', 30000)] },
    ]);
    [delta] = await approvedRun(pg, RUN(2), '214', [
      { vendor_netsuite_id: '60', vendor_name: 'Delta Lighting', method: 'check', bills: [bill('7005', 'DL-3', 5000)] },
    ]);
    await make(pg, ozark, '8302');
    await make(pg, gateway, '8301');
    await make(pg, acme, '8303');
    expect(await call(pg, 'gl_own_bill_payment_save', {
      netsuite_id: '8302', netsuite_number: 'To Print', company: 'BMG', made_from_run: RUN(1), made_from_payment: ozark, vendor_netsuite_id: '31',
      bank_account_netsuite_id: '211', payment_date: '2026-11-06', method: 'check', bills: [{ netsuite_id: '7001', number: 'B-4410', amount: '812.40' }],
      amount: '1412.40',
    })).toEqual({ saved: true });
    // A draft from 211 that's never approved.
    expect((await call(pg, 'vendor_payment_run_save', {
      id: RUN(3), company: 'BMG', bank_account_netsuite_id: '211', pay_date: '2026-11-06', by: CRAIG, payments: [],
    })).saved).toBe(true);

    // NetSuite's own checks, bill payments and refunds on the bank accounts, and what isn't one.
    await inNetSuite(pg, '9001', 'Check', '1047', ['211', '6100']);
    await inNetSuite(pg, '9002', 'VendPymt', '1049', ['211', '2000']);
    await inNetSuite(pg, '9003', 'CustRfnd', '1048', ['1200', '211']);
    await inNetSuite(pg, '9004', 'VendPymt', 'To Print', ['211', '2000']);
    await inNetSuite(pg, '9005', 'Check', '1060', ['214', '6100']);
    await inNetSuite(pg, '9006', 'Deposit', '1070', ['211', '1200']);
    await inNetSuite(pg, '9007', 'Check', '123456789', ['211', '6100']);
    await inNetSuite(pg, '9008', 'Check', 'CHK1090', ['211', '6100']);
    await inNetSuite(pg, '9009', 'Check', '1095', ['6100']);
  });
  afterAll(async () => { await pg.close(); });

  it("reads the numbers used on a bank account, and the highest, from NetSuite's checks, bill payments and refunds", async () => {
    expect(await last(pg, '211')).toBe(1049);
    expect(await last(pg, '214')).toBe(1060);
    expect(await last(pg, '221')).toBeNull();
    expect(await used(pg, '211', 1040, 1100)).toEqual([1047, 1048, 1049]);
    expect(await used(pg, '211', 1048, 1048)).toEqual([1048]);
    expect(await used(pg, '211', 1050, 1059)).toEqual([]);
    expect(await used(pg, '214', 1040, 1100)).toEqual([1060]);
    expect(await used(pg, '6100', 1040, 1100)).toEqual([1047, 1060, 1095]);
  });

  it('keeps where each bank account prints, top and not moved unless set, an inch either way at most', async () => {
    await pg.query(`INSERT INTO vendor_check_layouts (bank_account_netsuite_id, company) VALUES ('211', 'BMG')`);
    expect((await pg.query<Row>('SELECT check_position, right_sixteenths, down_sixteenths FROM vendor_check_layouts')).rows)
      .toEqual([{ check_position: 'top', right_sixteenths: 0, down_sixteenths: 0 }]);
    await pg.query(`
      INSERT INTO vendor_check_layouts (bank_account_netsuite_id, company, check_position, right_sixteenths, down_sixteenths, updated_by)
      VALUES ('214', 'BMG', 'bottom', -16, 16, '${CRAIG}')`);
    for (const [col, v] of [['check_position', "'left'"], ['right_sixteenths', '17'], ['down_sixteenths', '-17'], ['bank_account_netsuite_id', "'Operating'"], ['company', "' '"]]) {
      await expect(pg.query(`UPDATE vendor_check_layouts SET ${col} = ${v} WHERE bank_account_netsuite_id = '211'`)).rejects.toThrow(/violates check constraint/);
    }
    await expect(pg.query(`INSERT INTO vendor_check_layouts (bank_account_netsuite_id, company) VALUES ('211', 'BMG')`)).rejects.toThrow(/duplicate key/);
  });

  it("takes numbers for the run's checks made in NetSuite, all or none", async () => {
    await expect(claim([{ payment_id: ozark, number: 1050 }], { by: '' })).rejects.toThrow(/needs who numbered them/);
    await expect(claim([])).rejects.toThrow(/1 to 50 checks/);
    await expect(claim(Array.from({ length: 51 }, (_, i) => ({ payment_id: ozark, number: 2000 + i })))).rejects.toThrow(/1 to 50 checks/);
    await expect(call(pg, 'vendor_checks_claim', { run_id: RUN(1), by: JESSIE, checks: { payment_id: ozark } })).rejects.toThrow(/1 to 50 checks/);
    for (const bad of [
      { payment_id: 'ozark', number: 1050 }, { payment_id: ozark, number: 0 }, { payment_id: ozark, number: 100_000_000 },
      { payment_id: ozark, number: 1050.5 }, { payment_id: ozark, number: '1050' }, { payment_id: ozark, number: 1050, printed_as: null },
      { payment_id: ozark, number: 1050, printed_as: [] },
    ]) {
      await expect(claim([bad])).rejects.toThrow(/each check is a payment/);
    }
    await expect(claim([{ payment_id: ozark, number: 1050 }, { payment_id: ozark, number: 1051 }])).rejects.toThrow(/each payment and each number once/);
    await expect(claim([{ payment_id: ozark, number: 1050 }, { payment_id: acme, number: 1050 }])).rejects.toThrow(/each payment and each number once/);

    expect(await claim([{ payment_id: ozark, number: 1050 }], { run_id: RUN(97) })).toEqual({ state: 'gone' });
    expect(await claim([{ payment_id: ozark, number: 1050 }], { run_id: RUN(3) })).toEqual({ state: 'gone' });
    // An ACH payment, another run's check, a payment that isn't one, and a check not made yet: none is the run's check made.
    expect(await claim([{ payment_id: ozark, number: 1050 }, { payment_id: gateway, number: 1051 }, { payment_id: delta, number: 1052 }, { payment_id: NOBODY, number: 1053 }]))
      .toEqual({ state: 'not_made', payments: [gateway, delta, NOBODY] });
    expect(await call(pg, 'vendor_checks_claim', { run_id: RUN(2), by: JESSIE, checks: [{ payment_id: delta, number: 1050, printed_as: PRINTED_AS }] }))
      .toEqual({ state: 'not_made', payments: [delta] });
    expect((await pg.query('SELECT count(*)::int AS n FROM vendor_checks')).rows[0]).toEqual({ n: 0 });

    const claimed = await claim([{ payment_id: acme, number: 1051 }, { payment_id: ozark, number: 1050 }]);
    expect(claimed).toEqual({
      state: 'claimed',
      checks: [{ id: expect.any(String), payment_id: ozark, number: 1050 }, { id: expect.any(String), payment_id: acme, number: 1051 }],
    });
    [first, second] = claimed.checks.map((c: Row) => c.id);
    expect(await check(pg, first)).toEqual({
      company: 'BMG', bank_account_netsuite_id: '211', check_number: 1050, run_id: RUN(1), payment_id: ozark, netsuite_payment_id: '8302',
      status: 'numbering', printed_as: PRINTED_AS, numbered_by: JESSIE, has_numbered_at: true, error: null, printed_by: null, has_printed_at: false,
      spoiled_by: null, has_spoiled_at: false, spoiled_reason: null,
    });
    expect(await check(pg, second)).toMatchObject({ check_number: 1051, payment_id: acme, netsuite_payment_id: '8303', status: 'numbering' });

    // Taken again while they're numbering: each payment has its check, and each number is used.
    expect(await claim([{ payment_id: ozark, number: 1060 }, { payment_id: acme, number: 1061 }])).toEqual({ state: 'has_check', payments: [ozark, acme] });
    expect(await used(pg, '211', 1040, 1100)).toEqual([1047, 1048, 1049, 1050, 1051]);
    expect(await last(pg, '211')).toBe(1051);
    // Another bank account's stock has its own numbers.
    await make(pg, delta, '8304');
    // Made, and still another run's check.
    expect(await claim([{ payment_id: delta, number: 1070 }])).toEqual({ state: 'not_made', payments: [delta] });
    expect(await call(pg, 'vendor_checks_claim', { run_id: RUN(2), by: JESSIE, checks: [{ payment_id: delta, number: 1050, printed_as: PRINTED_AS }] }))
      .toMatchObject({ state: 'claimed', checks: [{ payment_id: delta, number: 1050 }] });
    expect(await used(pg, '214', 1040, 1100)).toEqual([1050, 1060]);
  });

  it("numbers a check once NetSuite takes it, as the payment's and Books' copy's number, and frees one it doesn't", async () => {
    expect(await call(pg, 'vendor_check_numbered', { id: first })).toEqual({ numbered: true });
    expect(await check(pg, first)).toMatchObject({ status: 'numbered', error: null });
    expect(await paymentNumber(pg, ozark)).toBe('1050');
    expect(await copyNumber(pg, '8302')).toBe('1050');
    expect(await call(pg, 'vendor_check_numbered', { id: first })).toEqual({ numbered: false });
    // A numbered check isn't let go.
    expect(await call(pg, 'vendor_check_let_go', { id: first })).toEqual({ let_go: false });
    expect(await check(pg, first)).toMatchObject({ status: 'numbered' });

    // Acme's NetSuite didn't take: its number is free again, and Acme can take one.
    expect(await call(pg, 'vendor_check_let_go', { id: second })).toEqual({ let_go: true });
    expect(await check(pg, second)).toBeUndefined();
    expect(await call(pg, 'vendor_check_let_go', { id: second })).toEqual({ let_go: false });
    expect(await call(pg, 'vendor_check_numbered', { id: second })).toEqual({ numbered: false });
    expect(await paymentNumber(pg, acme)).toBe('To Print');
    expect(await used(pg, '211', 1050, 1051)).toEqual([1050]);
  });

  it('marks numbered checks printed, and spoils one that did not print right, its number kept and its payment free to take another', async () => {
    await expect(call(pg, 'vendor_checks_printed', { ids: [first] })).rejects.toThrow(/needs who printed them/);
    await expect(call(pg, 'vendor_checks_printed', { ids: [], by: JESSIE })).rejects.toThrow(/1 to 50 checks/);
    await expect(call(pg, 'vendor_checks_printed', { ids: first, by: JESSIE })).rejects.toThrow(/1 to 50 checks/);
    expect(await call(pg, 'vendor_checks_printed', { ids: [first, NOBODY], by: JESSIE })).toEqual({ printed: 1 });
    expect(await check(pg, first)).toMatchObject({ status: 'printed', printed_by: JESSIE, has_printed_at: true });
    expect(await call(pg, 'vendor_checks_printed', { ids: [first], by: CRAIG })).toEqual({ printed: 0 });
    expect(await check(pg, first)).toMatchObject({ printed_by: JESSIE });

    await expect(call(pg, 'vendor_check_spoil', { id: first, reason: 'Jammed' })).rejects.toThrow(/needs who spoiled it/);
    for (const reason of ['', '  ', null]) {
      await expect(call(pg, 'vendor_check_spoil', { id: first, by: JESSIE, reason })).rejects.toThrow(/needs why it didn't print right/);
    }
    expect(await call(pg, 'vendor_check_spoil', { id: NOBODY, by: JESSIE, reason: 'Jammed' })).toEqual({ state: 'gone' });
    expect(await call(pg, 'vendor_check_spoil', { id: first, by: JESSIE, reason: '  Jammed in the printer  ' })).toEqual({ state: 'spoiled' });
    expect(await check(pg, first)).toMatchObject({ status: 'spoiled', spoiled_by: JESSIE, has_spoiled_at: true, spoiled_reason: 'Jammed in the printer', has_printed_at: true });
    expect(await call(pg, 'vendor_check_spoil', { id: first, by: CRAIG, reason: 'again' })).toEqual({ state: 'already_spoiled' });
    expect(await call(pg, 'vendor_checks_printed', { ids: [first], by: JESSIE })).toEqual({ printed: 0 });

    // Its number is never given again, and its payment takes the next.
    expect(await claim([{ payment_id: acme, number: 1050 }])).toEqual({ state: 'taken', numbers: [1050] });
    const again = await claim([{ payment_id: ozark, number: 1052 }]);
    expect(again).toMatchObject({ state: 'claimed', checks: [{ payment_id: ozark, number: 1052 }] });
    // One numbering doesn't spoil.
    expect(await call(pg, 'vendor_check_spoil', { id: again.checks[0].id, by: JESSIE, reason: 'x' })).toEqual({ state: 'numbering' });
    expect(await call(pg, 'vendor_check_numbered', { id: again.checks[0].id })).toEqual({ numbered: true });
    expect(await paymentNumber(pg, ozark)).toBe('1052');
    expect(await copyNumber(pg, '8302')).toBe('1052');
    expect(await checksOf(pg, ozark)).toEqual([{ number: 1050, status: 'spoiled' }, { number: 1052, status: 'numbered' }]);
    // A numbered check that never printed right spoils too, straight from numbered; a long why is cut to fit.
    const why = `Printed on plain paper, ${'and smudged '.repeat(40)}`;
    expect(await call(pg, 'vendor_check_spoil', { id: again.checks[0].id, by: JESSIE, reason: why })).toEqual({ state: 'spoiled' });
    expect(await check(pg, again.checks[0].id)).toMatchObject({ status: 'spoiled', has_printed_at: false, spoiled_reason: why.trim().slice(0, 300) });
  });

  it('keeps a check printed from NetSuite with its number, once, and never on a number FleetSuite used', async () => {
    const kept = (over: Row = {}) => call(pg, 'vendor_check_printed_in_netsuite', { run_id: RUN(1), payment_id: acme, number: 1053, by: JESSIE, ...over });
    await expect(kept({ by: null })).rejects.toThrow(/needs who found it/);
    for (const number of [0, 1053.5, '1053', null, 100_000_000]) await expect(kept({ number })).rejects.toThrow(/whole number from 1 to 99,999,999/);
    expect(await kept({ run_id: RUN(97) })).toEqual({ state: 'gone' });
    expect(await kept({ run_id: RUN(3) })).toEqual({ state: 'gone' });
    expect(await kept({ payment_id: gateway })).toEqual({ state: 'not_made' });
    expect(await kept({ payment_id: delta })).toEqual({ state: 'not_made' });
    expect(await kept({ number: 1052 })).toEqual({ state: 'taken' });

    expect(await kept()).toEqual({ state: 'kept' });
    const [row] = (await pg.query<Row>(`SELECT id FROM vendor_checks WHERE payment_id = $1 AND status = 'printed_in_netsuite'`, [acme])).rows;
    expect(await check(pg, row.id)).toMatchObject({
      check_number: 1053, status: 'printed_in_netsuite', printed_as: null, numbered_by: JESSIE, netsuite_payment_id: '8303', run_id: RUN(1),
    });
    expect(await paymentNumber(pg, acme)).toBe('1053');
    expect(await kept({ number: 1054 })).toEqual({ state: 'has_check' });
    expect(await claim([{ payment_id: acme, number: 1054 }])).toEqual({ state: 'has_check', payments: [acme] });
    // FleetSuite didn't print it, so it doesn't spoil it, or mark it printed.
    expect(await call(pg, 'vendor_check_spoil', { id: row.id, by: JESSIE, reason: 'x' })).toEqual({ state: 'printed_in_netsuite' });
    expect(await call(pg, 'vendor_checks_printed', { ids: [row.id], by: JESSIE })).toEqual({ printed: 0 });
    expect(await used(pg, '211', 1040, 1100)).toEqual([1047, 1048, 1049, 1050, 1052, 1053]);
    expect(await last(pg, '211')).toBe(1053);
    // Another bank account's checks aren't this one's.
    expect(await last(pg, '221')).toBeNull();
  });

  it('refuses a check row no step makes', async () => {
    const insert = (over: Row = {}) => {
      const r = {
        company: "'BMG'", bank_account_netsuite_id: "'211'", check_number: '1080', run_id: `'${RUN(1)}'`, payment_id: `'${ozark}'`,
        netsuite_payment_id: "'8302'", status: "'numbered'", printed_as: `'${JSON.stringify(PRINTED_AS)}'::jsonb`, ...over,
      };
      return pg.query(`INSERT INTO vendor_checks (${Object.keys(r).join(', ')}) VALUES (${Object.values(r).join(', ')})`);
    };
    // Ozark has no check that isn't spoiled now: one like this would be whole.
    for (const over of [
      { check_number: '0' }, { check_number: '100000000' }, { bank_account_netsuite_id: "'Operating'" }, { netsuite_payment_id: "'CHK-1080'" },
      { status: "'voided'" }, { printed_as: 'NULL' }, { printed_as: "'[]'::jsonb" }, { status: "'printed'" }, { status: "'spoiled'" },
      { status: "'spoiled'", spoiled_at: 'now()' }, { status: "'spoiled'", spoiled_at: 'now()', spoiled_reason: "'  '" },
      { spoiled_at: 'now()' }, { company: "' '" }, { error: `'${'x'.repeat(2001)}'` }, { spoiled_reason: `'${'x'.repeat(301)}'` },
    ]) {
      await expect(insert(over)).rejects.toThrow(/violates check constraint/);
    }
    await expect(insert({ check_number: '1047', payment_id: `'${NOBODY}'` })).rejects.toThrow(/foreign key/);
    // Two checks on one number, or two live checks for one payment, never.
    await expect(insert({ check_number: '1053' })).rejects.toThrow(/duplicate key/);
    await insert({ check_number: '1080' });
    await expect(insert({ check_number: '1081' })).rejects.toThrow(/vendor_checks_one_live_idx/);
    await expect(insert({ check_number: '1081', status: "'printed_in_netsuite'", printed_as: 'NULL' })).rejects.toThrow(/vendor_checks_one_live_idx/);
    await pg.query(`DELETE FROM vendor_checks WHERE check_number = 1080 AND bank_account_netsuite_id = '211'`);
    // A payment or run with checks can't be deleted out from under them.
    await expect(pg.query('DELETE FROM vendor_payment_run_payments WHERE id = $1', [acme])).rejects.toThrow(/foreign key/);
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        for (const table of ['vendor_check_layouts', 'vendor_checks']) {
          await expect(pg.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
        }
        for (const fn of [
          'vendor_checks_claim', 'vendor_check_numbered', 'vendor_check_let_go', 'vendor_checks_printed', 'vendor_check_spoil',
          'vendor_check_printed_in_netsuite',
        ]) {
          await expect(call(pg, fn, { id: NOBODY })).rejects.toThrow(/permission denied for function/);
        }
        await expect(used(pg, '211', 1, 2)).rejects.toThrow(/permission denied for function/);
        await expect(last(pg, '211')).rejects.toThrow(/permission denied for function/);
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('vendor_check_layouts', 'vendor_checks') ORDER BY relname`);
    expect(rls.rows).toEqual([
      { relname: 'vendor_check_layouts', relrowsecurity: true },
      { relname: 'vendor_checks', relrowsecurity: true },
    ]);
    await pg.exec('SET ROLE service_role');
  });
});
