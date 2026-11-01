// Migration 487 switches bank deposits made in FleetSuite off, a fourteenth
// books switch, keeps one row per press of Make deposit as it goes from being
// made in NetSuite to made, or back to open when NetSuite doesn't make it,
// holds the payments and deposits in a press being made from every other
// press, and keeps Books' own copy of each bank deposit FleetSuite makes. This
// runs migration 359 with 466, 485, 486 and 487 in an in-memory Postgres
// (PGlite) as the app's server login, claiming presses worked out by
// src/lib/bank-deposit.ts and saving copies from
// src/lib/books/own-bank-deposits.ts the way /api/invoices/bank-deposit does.
// Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { accountName, workOutBankDeposit, type BankAccount, type WaitingItem } from '@/lib/bank-deposit';
import { SWITCH_PIECES } from './switches';
import { ownBankDepositPayload, type MadeBankDeposit } from './own-bank-deposits';

const PRESS = (n: number) => `f0000000-0000-4000-8000-00000000000${n}`;
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
    -- What migrations 466 to 487 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${JESSIE}');
  `);
  for (const file of [
    '359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '485-payments-received-in-fleetsuite.sql',
    '486-deposits-taken-in-fleetsuite.sql', '487-bank-deposits-made-in-fleetsuite.sql',
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

const ACCOUNTS: BankAccount[] = [
  { netsuiteId: '211', number: '10100', name: 'Operating Checking' },
  { netsuiteId: '214', number: null, name: 'Payroll Checking' },
];
const WAITING: WaitingItem[] = [
  { netsuiteId: '9001', kind: 'payment', number: 'PYMT-9001', date: '2026-10-28', customerName: 'Rivera Plumbing', reference: '10442', cents: 125000 },
  { netsuiteId: '9002', kind: 'payment', number: 'PYMT-9002', date: '2026-10-29', customerName: 'Gateway Electric', reference: null, cents: 48050 },
  { netsuiteId: '9003', kind: 'deposit', number: 'DEP-77', date: '2026-10-30', customerName: 'Ozark Fleet Co', reference: '2210', cents: 250000 },
];
/** PYMT-9001 and DEP-77 into Operating Checking, as Make deposit works it out. */
const WORKED = workOutBankDeposit(
  { date: '2026-10-30', accountId: '211', memo: ' Slip  14 ', lineIds: ['9001', '9003'] }, WAITING, ACCOUNTS, { today: '2026-10-31' },
);
const lineOf = (w: WaitingItem) => ({
  netsuite_id: w.netsuiteId, kind: w.kind, number: w.number, date: w.date, customer_name: w.customerName, reference: w.reference, cents: w.cents,
});

/** The claim as the route takes it. */
const press = (id: string, over: Record<string, unknown> = {}) => ({
  id, by: CRAIG, company: 'BMG', subsidiary_netsuite_id: '2', bank_account_netsuite_id: WORKED.account?.netsuiteId,
  bank_account_name: WORKED.account ? ` ${accountName(WORKED.account)} ` : null, deposit_date: WORKED.date, memo: WORKED.memo,
  lines: WORKED.lines.map(lineOf), ...over,
});

type Row = Record<string, any>;
const row = async (pg: PGlite, id: string) => (await pg.query<Row>(`
  SELECT *, deposit_date::text AS deposit_date, total_cents::int AS total_cents, sent_at IS NOT NULL AS has_sent_at
  FROM made_bank_deposits WHERE id = $1`, [id])).rows[0];

describe('migration 487', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    expect(WORKED.problems).toEqual([]);
  });
  afterAll(async () => { await pg.close(); });

  it('starts bank deposits switched off, a fourteenth piece', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'bank_deposits', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'customer_deposits', is_on: false, changed_by: null },
      { piece: 'customer_payments', is_on: false, changed_by: null },
    ]);
    // Every piece the app named then is one the column takes, and nothing else is (488 adds paying vendors).
    const then = SWITCH_PIECES.filter((piece) => piece !== 'vendor_payments');
    expect(then).toHaveLength(14);
    await pg.exec('BEGIN');
    try {
      for (const piece of then) await pg.query('INSERT INTO books_switches (piece) VALUES ($1) ON CONFLICT (piece) DO NOTHING', [piece]);
      expect((await pg.query('SELECT count(*)::int AS n FROM books_switches')).rows[0]).toEqual({ n: 14 });
    } finally {
      await pg.exec('ROLLBACK');
    }
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    const checks = (await pg.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%piece%'`)).rows;
    expect(checks).toHaveLength(1);
  });

  it('takes a press as worked out, then says what became of it when it comes again', async () => {
    const claimed = await call(pg, 'made_bank_deposit_claim', press(PRESS(1)));
    expect(claimed.state).toBe('claimed');
    expect(claimed.deposit).toMatchObject({ id: PRESS(1), status: 'sending', sent_by: CRAIG, created_by: CRAIG, total_cents: 375000 });
    expect(await row(pg, PRESS(1))).toMatchObject({
      company: 'BMG', subsidiary_netsuite_id: '2', bank_account_netsuite_id: '211', bank_account_name: '10100 Operating Checking',
      deposit_date: '2026-10-30', memo: 'Slip 14', lines: [lineOf(WAITING[0]), lineOf(WAITING[2])], line_ids: ['9001', '9003'],
      total_cents: 375000, status: 'sending', sent_by: CRAIG, has_sent_at: true, netsuite_deposit_id: null, netsuite_number: null, error: null,
    });

    // Pressed again while it's being made: the press holds it.
    const again = await call(pg, 'made_bank_deposit_claim', press(PRESS(1), { by: JESSIE }));
    expect(again).toMatchObject({ state: 'sending', deposit: { id: PRESS(1), sent_by: CRAIG } });

    expect(await call(pg, 'made_bank_deposit_made', { id: PRESS(1), netsuite_deposit_id: '8301', netsuite_number: ' DEP-1207 ' })).toEqual({ made: true });
    expect(await row(pg, PRESS(1))).toMatchObject({ status: 'made', netsuite_deposit_id: '8301', netsuite_number: 'DEP-1207', error: null });
    expect(await call(pg, 'made_bank_deposit_claim', press(PRESS(1)))).toEqual({ state: 'made', netsuite_deposit_id: '8301', netsuite_number: 'DEP-1207' });
    // Made is made: neither made again nor let go.
    expect(await call(pg, 'made_bank_deposit_made', { id: PRESS(1), netsuite_deposit_id: '8399' })).toEqual({ made: false });
    expect(await call(pg, 'made_bank_deposit_let_go', { id: PRESS(1), error: 'x' })).toEqual({ let_go: false });
    expect(await row(pg, PRESS(1))).toMatchObject({ status: 'made', netsuite_deposit_id: '8301', error: null });
  });

  it("holds what's in a press being made from every other press, until it's made or let go", async () => {
    // PYMT-9002 and DEP-77, being made.
    expect((await call(pg, 'made_bank_deposit_claim', press(PRESS(2), { lines: [lineOf(WAITING[1]), lineOf(WAITING[2])] }))).state).toBe('claimed');
    // Another press with DEP-77 in it, for either company, is turned away, and nothing of it is kept.
    for (const company of ['BMG', '1084']) {
      expect(await call(pg, 'made_bank_deposit_claim', press(PRESS(3), { company, lines: [lineOf(WAITING[0]), lineOf(WAITING[2])] })))
        .toEqual({ state: 'held', held: ['9003'] });
    }
    expect(await call(pg, 'made_bank_deposit_claim', press(PRESS(3), { lines: [lineOf(WAITING[2]), lineOf(WAITING[1]), lineOf(WAITING[0])] })))
      .toEqual({ state: 'held', held: ['9002', '9003'] });
    expect(await row(pg, PRESS(3))).toBeUndefined();

    // One with neither in it is taken; then it holds PYMT-9001 too.
    expect((await call(pg, 'made_bank_deposit_claim', press(PRESS(4), { lines: [lineOf(WAITING[0])] }))).state).toBe('claimed');
    expect(await call(pg, 'made_bank_deposit_claim', press(PRESS(3)))).toEqual({ state: 'held', held: ['9001', '9003'] });

    // Let go, its payments are free; made, so are they (NetSuite no longer has them waiting).
    expect(await call(pg, 'made_bank_deposit_let_go', { id: PRESS(2), error: 'NetSuite error (400): The period is closed.' })).toEqual({ let_go: true });
    expect(await call(pg, 'made_bank_deposit_claim', press(PRESS(3)))).toEqual({ state: 'held', held: ['9001'] });
    expect(await call(pg, 'made_bank_deposit_made', { id: PRESS(4), netsuite_deposit_id: '8302' })).toEqual({ made: true });
    expect((await call(pg, 'made_bank_deposit_claim', press(PRESS(3)))).state).toBe('claimed');
    // A press that was let go holds nothing.
    expect(await call(pg, 'made_bank_deposit_claim', press(PRESS(2), { lines: [lineOf(WAITING[1])] }))).toMatchObject({ state: 'claimed' });
    expect(await call(pg, 'made_bank_deposit_made', { id: PRESS(2), netsuite_deposit_id: '8303' })).toEqual({ made: true });
    expect(await call(pg, 'made_bank_deposit_made', { id: PRESS(3), netsuite_deposit_id: '8304' })).toEqual({ made: true });
  });

  it("lets go of a press NetSuite didn't make, keeping why, and takes it again as it's sent then", async () => {
    await call(pg, 'made_bank_deposit_claim', press(PRESS(5)));
    expect(await call(pg, 'made_bank_deposit_let_go', { id: PRESS(5), error: ' NetSuite error (400): Invalid account reference key 999. ' })).toEqual({ let_go: true });
    expect(await row(pg, PRESS(5))).toMatchObject({
      status: 'open', sent_by: null, has_sent_at: false, error: 'NetSuite error (400): Invalid account reference key 999.',
    });
    expect(await call(pg, 'made_bank_deposit_let_go', { id: PRESS(5), error: 'again' })).toEqual({ let_go: false });
    expect(await call(pg, 'made_bank_deposit_made', { id: PRESS(5), netsuite_deposit_id: '8305' })).toEqual({ made: false });

    // Sent again by someone else, into another account, on another day, with one payment and no memo or account name.
    const retaken = await call(pg, 'made_bank_deposit_claim', press(PRESS(5), {
      by: JESSIE, bank_account_netsuite_id: '214', bank_account_name: '  ', deposit_date: '2026-10-31', memo: '', lines: [lineOf(WAITING[1])],
    }));
    expect(retaken.state).toBe('claimed');
    expect(await row(pg, PRESS(5))).toMatchObject({
      status: 'sending', sent_by: JESSIE, created_by: CRAIG, has_sent_at: true, error: null, bank_account_netsuite_id: '214',
      bank_account_name: null, deposit_date: '2026-10-31', memo: null, lines: [lineOf(WAITING[1])], line_ids: ['9002'], total_cents: 48050,
    });
    expect(await call(pg, 'made_bank_deposit_made', { id: PRESS(5), netsuite_deposit_id: '8305', netsuite_number: '' })).toEqual({ made: true });
    expect(await row(pg, PRESS(5))).toMatchObject({ status: 'made', netsuite_deposit_id: '8305', netsuite_number: null });

    // A press let go with no reason says it wasn't made, and a long reason is cut to fit.
    await call(pg, 'made_bank_deposit_claim', press(PRESS(6)));
    expect(await call(pg, 'made_bank_deposit_let_go', { id: PRESS(6), error: '  ' })).toEqual({ let_go: true });
    expect(await row(pg, PRESS(6))).toMatchObject({ status: 'open', error: 'Not made' });
    await call(pg, 'made_bank_deposit_claim', press(PRESS(6)));
    expect(await call(pg, 'made_bank_deposit_let_go', { id: PRESS(6), error: 'x'.repeat(2100) })).toEqual({ let_go: true });
    expect((await row(pg, PRESS(6))).error).toHaveLength(2000);
  });

  it("refuses a press that isn't whole, and keeps nothing of it", async () => {
    const id = PRESS(9);
    const refused = async (over: Record<string, unknown>, why: RegExp) =>
      expect(call(pg, 'made_bank_deposit_claim', press(id, over))).rejects.toThrow(why);
    await refused({ by: '' }, /needs who sent it/);
    await refused({ by: null }, /needs who sent it/);
    for (const bank_account_netsuite_id of ['Operating', '', null]) await refused({ bank_account_netsuite_id }, /goes into a bank account, by NetSuite's id for it/);
    const many = Array.from({ length: 101 }, (_, i) => ({ ...lineOf(WAITING[0]), netsuite_id: String(10000 + i), cents: 1 }));
    for (const lines of [[], many, null, { netsuite_id: '9001' }]) await refused({ lines }, /1 to 100 payments and deposits/);
    for (const netsuite_id of ['PYMT-9001', '', null]) {
      await refused({ lines: [{ ...lineOf(WAITING[0]), netsuite_id }] }, /by NetSuite's id for it/);
    }
    await refused({ lines: [lineOf(WAITING[0]), lineOf(WAITING[0])] }, /payment 9001 is in it twice/);
    for (const cents of [0, -100, 2500.5, '125000', null]) {
      await refused({ lines: [{ ...lineOf(WAITING[0]), cents }] }, /whole number of cents above 0/);
    }
    await refused({ company: ' ' }, /check/);
    await refused({ subsidiary_netsuite_id: 'S2' }, /check/);
    await refused({ bank_account_name: 'n'.repeat(301) }, /check/);
    await refused({ memo: 'm'.repeat(301) }, /check/);
    await refused({ deposit_date: null }, /null/);
    expect((await pg.query('SELECT count(*)::int AS n FROM made_bank_deposits WHERE id = $1', [id])).rows[0]).toEqual({ n: 0 });

    await call(pg, 'made_bank_deposit_claim', press(PRESS(7), { lines: [lineOf({ ...WAITING[0], netsuiteId: '9101' })] }));
    for (const netsuite_deposit_id of ['', 'DEP-1207', null]) {
      await expect(call(pg, 'made_bank_deposit_made', { id: PRESS(7), netsuite_deposit_id })).rejects.toThrow(/NetSuite's id for it/);
    }
    expect(await row(pg, PRESS(7))).toMatchObject({ status: 'sending', netsuite_deposit_id: null });
    // A made row always has NetSuite's id, and one being made when it was sent.
    await expect(pg.query(`UPDATE made_bank_deposits SET status = 'made' WHERE id = $1`, [PRESS(7)])).rejects.toThrow(/check/);
    await expect(pg.query(`UPDATE made_bank_deposits SET sent_at = NULL WHERE id = $1`, [PRESS(7)])).rejects.toThrow(/check/);
  });

  const made = (over: Partial<MadeBankDeposit> = {}): MadeBankDeposit & { netsuiteId: string } => ({
    netsuiteId: '8301', netsuiteNumber: 'DEP-1207', company: 'BMG', bankAccountNetsuiteId: '211', date: WORKED.date, memo: WORKED.memo,
    lines: WORKED.lines.map((l) => ({ netsuiteId: l.netsuiteId, kind: l.kind, number: l.number, customerName: l.customerName, cents: l.cents })),
    totalCents: WORKED.totalCents, madeFromId: PRESS(1), madeBy: CRAIG, ...over,
  } as MadeBankDeposit & { netsuiteId: string });
  const save = (m: MadeBankDeposit & { netsuiteId: string }, over: Record<string, unknown> = {}) =>
    call(pg, 'gl_own_bank_deposit_save', { ...ownBankDepositPayload(m), ...over });
  const copy = async (id: string) => (await pg.query<Row>(`
    SELECT d.netsuite_number, c.code AS company, d.made_from_id, d.bank_account_netsuite_id, d.deposit_date::text AS deposit_date,
           d.memo, d.lines, d.amount::text AS amount, d.made_by
    FROM gl_own_bank_deposits d JOIN gl_companies c ON c.id = d.company_id WHERE d.netsuite_id = $1`, [id])).rows;

  it("saves Books' own copy of the bank deposit, and only once", async () => {
    expect(await save(made())).toEqual({ saved: true });
    expect(await copy('8301')).toEqual([{
      netsuite_number: 'DEP-1207', company: 'BMG', made_from_id: PRESS(1), bank_account_netsuite_id: '211', deposit_date: '2026-10-30',
      memo: 'Slip 14',
      lines: [
        { netsuite_id: '9001', kind: 'payment', number: 'PYMT-9001', customer_name: 'Rivera Plumbing', amount: '1250.00' },
        { netsuite_id: '9003', kind: 'deposit', number: 'DEP-77', customer_name: 'Ozark Fleet Co', amount: '2500.00' },
      ],
      amount: '3750.00', made_by: CRAIG,
    }]);

    // Saved again, by the same press or another, it stays as it was.
    expect(await save(made({ totalCents: 100, madeFromId: PRESS(2) }))).toEqual({ saved: false });
    expect(await copy('8301')).toMatchObject([{ amount: '3750.00', made_from_id: PRESS(1) }]);

    // 1084's, with no number or memo, and nobody's name on it.
    expect(await save(made({ netsuiteId: '8302', netsuiteNumber: null, company: '1084', memo: null, madeBy: null, totalCents: 1 }), { made_from_id: null }))
      .toEqual({ saved: true });
    expect(await copy('8302')).toMatchObject([{
      netsuite_number: null, company: '1084', made_from_id: null, memo: null, amount: '0.01', made_by: null,
    }]);
  });

  it("refuses a copy that isn't whole, and keeps nothing of it", async () => {
    const m = made({ netsuiteId: '8309' });
    await expect(save(m, { company: undefined })).rejects.toThrow(/company \(none\) doesn't exist/);
    await expect(save(m, { company: 'ACME' })).rejects.toThrow(/company ACME doesn't exist/);
    for (const netsuite_id of ['DEP-1209', null]) await expect(save(m, { netsuite_id })).rejects.toThrow(/needs NetSuite's id for it/);
    for (const amount of ['0.00', '-5.00']) await expect(save(m, { amount })).rejects.toThrow(/check/);
    // A JSON null is a value, not a missing one.
    for (const lines of [[], { netsuite_id: '9001' }, null]) await expect(save(m, { lines })).rejects.toThrow(/check/);
    await expect(save(m, { bank_account_netsuite_id: 'Operating' })).rejects.toThrow(/check/);
    await expect(save(m, { deposit_date: null })).rejects.toThrow(/null/);
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_bank_deposits WHERE netsuite_id IN ('8309', 'DEP-1209')`)).rows[0]).toEqual({ n: 0 });
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        for (const table of ['made_bank_deposits', 'gl_own_bank_deposits']) {
          await expect(pg.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
        }
        for (const fn of ['made_bank_deposit_claim', 'made_bank_deposit_let_go', 'made_bank_deposit_made', 'gl_own_bank_deposit_save']) {
          await expect(call(pg, fn, { id: PRESS(8) })).rejects.toThrow(/permission denied for function/);
        }
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('made_bank_deposits', 'gl_own_bank_deposits') ORDER BY relname`);
    expect(rls.rows).toEqual([
      { relname: 'gl_own_bank_deposits', relrowsecurity: true },
      { relname: 'made_bank_deposits', relrowsecurity: true },
    ]);
    await pg.exec('SET ROLE service_role');
  });
});
