// Migration 488 switches paying vendors in FleetSuite off, a fifteenth books
// switch, keeps each payment run as it goes from a draft to asked for
// approval, approved and paid (and back to a draft when it's taken back or
// sent back with why), holds the bills in a run that's asked for or being
// paid from every other run, makes one payment per vendor when a super admin
// who didn't ask approves it, keeps each payment as it's made in NetSuite,
// refused, made again or dropped, and keeps Books' own copy of each bill
// payment FleetSuite makes. This runs migration 359 with 466 and 485 to 488 in
// an in-memory Postgres (PGlite) as the app's server login, saving runs worked
// out by src/lib/pay-vendors.ts and copies from
// src/lib/books/own-bill-payments.ts the way /api/pay-vendors does. Made-up
// data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { accountName, paymentsToKeep, workOutRun, type BankAccount, type BillNow, type RunBill, type RunPayment } from '@/lib/pay-vendors';
import { SWITCH_PIECES } from './switches';
import { ownBillPaymentPayload, type MadeBillPayment } from './own-bill-payments';

const RUN = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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
    -- What migrations 466 to 488 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${JESSIE}');
  `);
  for (const file of [
    '359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '485-payments-received-in-fleetsuite.sql',
    '486-deposits-taken-in-fleetsuite.sql', '487-bank-deposits-made-in-fleetsuite.sql', '488-vendors-paid-in-fleetsuite.sql',
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
const bill = (billId: string, number: string, date: string, dueDate: string, openCents: number, cents = openCents): RunBill =>
  ({ billId, number, date, dueDate, openCents, cents });
const B4410 = bill('7001', 'B-4410', '2026-09-20', '2026-10-20', 81240);
const B4471 = bill('7002', 'B-4471', '2026-10-06', '2026-11-05', 110000, 60000);
const GS209 = bill('7003', 'GS-209', '2026-10-11', '2026-11-10', 245000);
const OZARK: RunPayment = { vendorId: '31', vendorName: 'Ozark Hose & Fitting', method: 'check', bills: [B4471, B4410] };
const GATEWAY: RunPayment = { vendorId: '47', vendorName: 'Gateway Steel', method: 'ach', bills: [GS209] };
const NOW = new Map<string, BillNow>([
  ['7001', { open: true, openCents: 81240, vendorId: '31' }],
  ['7002', { open: true, openCents: 110000, vendorId: '31' }],
  ['7003', { open: true, openCents: 245000, vendorId: '47' }],
]);
/** Ozark's two bills, part of B-4471, by check, and Gateway's by ACH, from Operating Checking, as the page works it out. */
const WORKED = workOutRun(
  { date: '2026-11-06', accountId: '211', memo: ' November  run ', payments: [OZARK, GATEWAY] }, NOW, ACCOUNTS, { today: '2026-11-01' },
);

/** A draft as the route saves it. */
const draft = (id: string, over: Record<string, unknown> = {}) => ({
  id, company: 'BMG', bank_account_netsuite_id: WORKED.account?.netsuiteId, bank_account_name: WORKED.account ? ` ${accountName(WORKED.account)} ` : null,
  pay_date: WORKED.date, memo: WORKED.memo, by: CRAIG, payments: paymentsToKeep(WORKED.payments), ...over,
});
const keptBill = (b: RunBill) => ({ bill_netsuite_id: b.billId, number: b.number, date: b.date, due_date: b.dueDate, open_cents: b.openCents, cents: b.cents });
/** A payment as a run keeps it. */
const kept = (p: RunPayment, over: Record<string, unknown> = {}) => ({
  vendor_netsuite_id: p.vendorId, vendor_name: p.vendorName, method: p.method, bills: p.bills.map(keptBill), ...over,
});

type Row = Record<string, any>;
const run = async (pg: PGlite, id: string) => (await pg.query<Row>(`
  SELECT *, pay_date::text AS pay_date, total_cents::int AS total_cents
  FROM vendor_payment_runs WHERE id = $1`, [id])).rows[0];
const payments = async (pg: PGlite, runId: string) => (await pg.query<Row>(`
  SELECT *, total_cents::int AS total_cents, sent_at IS NOT NULL AS has_sent_at
  FROM vendor_payment_run_payments WHERE run_id = $1 ORDER BY position`, [runId])).rows;
const payment = async (pg: PGlite, id: string) => (await pg.query<Row>(`
  SELECT *, total_cents::int AS total_cents, sent_at IS NOT NULL AS has_sent_at, dropped_at IS NOT NULL AS has_dropped_at
  FROM vendor_payment_run_payments WHERE id = $1`, [id])).rows[0];
const held = async (pg: PGlite, ids: string[], except: string | null = null) =>
  (await pg.query<{ r: string[] }>('SELECT vendor_payment_bills_held($1::text[], $2::uuid) AS r', [ids, except])).rows[0].r;
/** Saved, then asked for as saved. */
const saveAndAsk = async (pg: PGlite, id: string, over: Record<string, unknown> = {}, by = CRAIG) => {
  const saved = await call(pg, 'vendor_payment_run_save', draft(id, { by, ...over }));
  return call(pg, 'vendor_payment_run_ask', { id, by, updated_at: saved.updated_at });
};
const updatedAt = async (pg: PGlite, id: string) => (await pg.query<{ t: string }>(
  `SELECT to_jsonb(updated_at) #>> '{}' AS t FROM vendor_payment_runs WHERE id = $1`, [id])).rows[0].t;

describe('migration 488', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    expect(WORKED.problems).toEqual([]);
  });
  afterAll(async () => { await pg.close(); });

  it('starts paying vendors switched off, a fifteenth piece', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'bank_deposits', is_on: false, changed_by: null },
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'customer_deposits', is_on: false, changed_by: null },
      { piece: 'customer_payments', is_on: false, changed_by: null },
      { piece: 'vendor_payments', is_on: false, changed_by: null },
    ]);
    // Every piece the app named then is one the column takes, and nothing else is (494 adds approving adjustments).
    const then = SWITCH_PIECES.filter((piece) => piece !== 'adjustment_approvals');
    expect(then).toHaveLength(15);
    await pg.exec('BEGIN');
    try {
      for (const piece of then) await pg.query('INSERT INTO books_switches (piece) VALUES ($1) ON CONFLICT (piece) DO NOTHING', [piece]);
      expect((await pg.query('SELECT count(*)::int AS n FROM books_switches')).rows[0]).toEqual({ n: 15 });
    } finally {
      await pg.exec('ROLLBACK');
    }
    await expect(pg.query(`INSERT INTO books_switches (piece) VALUES ('payroll')`)).rejects.toThrow(/check/i);
    const checks = (await pg.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%piece%'`)).rows;
    expect(checks).toHaveLength(1);
  });

  it('saves a draft as worked out, and changes it while it stays a draft', async () => {
    const saved = await call(pg, 'vendor_payment_run_save', draft(RUN(1)));
    expect(saved).toMatchObject({ saved: true, status: 'draft' });
    expect(typeof saved.updated_at).toBe('string');
    expect(await run(pg, RUN(1))).toMatchObject({
      company: 'BMG', bank_account_netsuite_id: '211', bank_account_name: '10100 Operating Checking', pay_date: '2026-11-06',
      memo: 'November run', payments: [kept(GATEWAY), kept({ ...OZARK, bills: [B4410, B4471] })], bill_ids: ['7003', '7001', '7002'],
      total_cents: 386240, status: 'draft', created_by: CRAIG, updated_by: CRAIG, asked_by: null, asked_at: null, approved_at: null, done_at: null,
    });

    // Changed by someone else: no bank account yet, Gateway only, with days it doesn't know left out.
    const changed = await call(pg, 'vendor_payment_run_save', draft(RUN(1), {
      by: JESSIE, bank_account_netsuite_id: null, bank_account_name: '', memo: '  ',
      payments: [kept(GATEWAY, { vendor_name: '  ', bills: [{ ...keptBill(GS209), number: ' ', date: 'soon', due_date: '11/10/2026' }] })],
    }));
    expect(changed).toMatchObject({ saved: true, status: 'draft' });
    expect(changed.updated_at).not.toBe(saved.updated_at);
    expect(await run(pg, RUN(1))).toMatchObject({
      bank_account_netsuite_id: null, bank_account_name: null, memo: null, created_by: CRAIG, updated_by: JESSIE, total_cents: 245000,
      payments: [kept(GATEWAY, { vendor_name: null, bills: [{ ...keptBill(GS209), number: null, date: null, due_date: null }] })], bill_ids: ['7003'],
    });

    // And back as it was; a draft with nothing ticked is kept too.
    expect((await call(pg, 'vendor_payment_run_save', draft(RUN(1)))).saved).toBe(true);
    expect(await call(pg, 'vendor_payment_run_save', draft(RUN(2), { payments: [] }))).toMatchObject({ saved: true });
    expect(await run(pg, RUN(2))).toMatchObject({ payments: [], bill_ids: [], total_cents: 0 });
  });

  it("refuses a draft that isn't whole, and keeps nothing of it", async () => {
    const id = RUN(99);
    const refused = async (over: Record<string, unknown>, why: RegExp) =>
      expect(call(pg, 'vendor_payment_run_save', draft(id, over))).rejects.toThrow(why);
    for (const p of [{ vendor_netsuite_id: '31' }, 'none', null]) await refused({ payments: p }, /a run's payments must be a list/);
    await refused({ payments: Array.from({ length: 51 }, (_, i) => kept(GATEWAY, { vendor_netsuite_id: String(100 + i), bills: [] })) }, /50 vendors at most/);
    for (const bank_account_netsuite_id of ['Operating', '10100 Operating']) await refused({ bank_account_netsuite_id }, /by NetSuite's id for it/);
    const eachPayment = /each payment is a vendor \(NetSuite's id\), check or ACH, and 100 bills at most/;
    for (const p of [
      kept(GATEWAY, { vendor_netsuite_id: 'V-47' }), kept(GATEWAY, { vendor_netsuite_id: null }), kept(GATEWAY, { method: 'wire' }),
      kept(GATEWAY, { vendor_name: 'n'.repeat(301) }), kept(GATEWAY, { bills: 'GS-209' }), kept(GATEWAY, { bills: null }),
      kept(GATEWAY, { bills: Array.from({ length: 101 }, (_, i) => ({ ...keptBill(GS209), bill_netsuite_id: String(20000 + i) })) }),
      'Gateway',
    ]) await refused({ payments: [p] }, eachPayment);
    const eachBill = /each bill is NetSuite's id for it and whole cents of \$0 or more/;
    for (const b of [
      { bill_netsuite_id: 'GS-209' }, { bill_netsuite_id: null }, { cents: '245000' }, { cents: null }, { cents: -1 }, { cents: 2450.5 },
      { cents: 1_000_000_001 }, { open_cents: '245000' }, { open_cents: -1 }, { open_cents: 0.5 }, { open_cents: 100_000_000_001 },
      { number: 'n'.repeat(101) },
    ]) await refused({ payments: [kept(GATEWAY, { bills: [{ ...keptBill(GS209), ...b }] })] }, eachBill);
    await refused({ payments: [kept(GATEWAY, { bills: ['GS-209'] })] }, eachBill);
    const five = Array.from({ length: 6 }, (_, v) => kept(GATEWAY, {
      vendor_netsuite_id: String(100 + v),
      bills: Array.from({ length: 100 }, (__, i) => ({ ...keptBill(GS209), bill_netsuite_id: String(30000 + v * 1000 + i), cents: 1 })),
    }));
    await refused({ payments: five }, /500 bills at most/);
    const oneMore = kept(GATEWAY, { vendor_netsuite_id: '199', bills: [{ ...keptBill(GS209), bill_netsuite_id: '39999', cents: 1 }] });
    await refused({ payments: [...five.slice(0, 5), oneMore] }, /500 bills at most/);
    await refused({ company: ' ' }, /check/);
    await refused({ bank_account_name: 'n'.repeat(301) }, /check/);
    await refused({ memo: 'm'.repeat(301) }, /check/);
    await refused({ pay_date: null }, /null/);
    expect((await pg.query('SELECT count(*)::int AS n FROM vendor_payment_runs WHERE id = $1', [id])).rows[0]).toEqual({ n: 0 });
    // 500 bills is as many as a run pays.
    expect((await call(pg, 'vendor_payment_run_save', draft(RUN(98), { payments: five.slice(0, 5) }))).saved).toBe(true);
    expect((await run(pg, RUN(98))).bill_ids).toHaveLength(500);
  });

  it('asks for approval of the draft the asker saw, once it is whole, and holds its bills', async () => {
    expect(await call(pg, 'vendor_payment_run_ask', { id: RUN(1), by: CRAIG, updated_at: '2026-11-01T00:00:00Z' })).toEqual({ state: 'changed' });
    expect(await call(pg, 'vendor_payment_run_ask', { id: RUN(97), by: CRAIG, updated_at: '2026-11-01T00:00:00Z' })).toEqual({ state: 'gone' });

    // Whole: a bank account, each vendor once with a bill or more, each bill once, more than $0 and no more than it had open.
    const whole = /needs a bank account and a vendor once each, each paying a bill or more, a bill once, each more than \$0 and no more than it had open/;
    for (const [n, over] of [
      [10, { bank_account_netsuite_id: null }],
      [11, { payments: [] }],
      [12, { payments: [kept(GATEWAY), kept(OZARK, { bills: [] })] }],
      [13, { payments: [kept(GATEWAY, { bills: [{ ...keptBill(GS209), cents: 0 }] })] }],
      [14, { payments: [kept(GATEWAY, { bills: [{ ...keptBill(GS209), cents: 245001 }] })] }],
      [15, { payments: [kept(GATEWAY), kept(GATEWAY, { bills: [keptBill(B4410)] })] }],
      [16, { payments: [kept(GATEWAY), kept(OZARK, { bills: [keptBill(GS209)] })] }],
    ] as Array<[number, Record<string, unknown>]>) {
      await expect(saveAndAsk(pg, RUN(n), over)).rejects.toThrow(whole);
      expect(await run(pg, RUN(n))).toMatchObject({ status: 'draft', asked_at: null });
    }

    const asked = await call(pg, 'vendor_payment_run_ask', { id: RUN(1), by: CRAIG, updated_at: await updatedAt(pg, RUN(1)) });
    expect(asked).toMatchObject({ state: 'asked' });
    expect(await run(pg, RUN(1))).toMatchObject({ status: 'waiting', asked_by: CRAIG });
    expect((await run(pg, RUN(1))).asked_at).toBeInstanceOf(Date);
    expect(await call(pg, 'vendor_payment_run_ask', { id: RUN(1), by: CRAIG, updated_at: await updatedAt(pg, RUN(1)) })).toEqual({ state: 'waiting' });

    // Asked for, it stays as it was asked.
    expect(await call(pg, 'vendor_payment_run_save', draft(RUN(1), { payments: [] }))).toMatchObject({ saved: false, status: 'waiting' });
    expect((await run(pg, RUN(1))).bill_ids).toEqual(['7003', '7001', '7002']);

    // Its bills are held from every other run, for either company.
    for (const company of ['BMG', '1084']) {
      expect(await saveAndAsk(pg, RUN(3), { company, payments: [kept(GATEWAY)] })).toEqual({ state: 'held', held: ['7003'] });
    }
    expect(await saveAndAsk(pg, RUN(3), { payments: [kept(OZARK), kept(GATEWAY)] })).toEqual({ state: 'held', held: ['7001', '7002', '7003'] });
    expect(await run(pg, RUN(3))).toMatchObject({ status: 'draft', asked_at: null });
    expect(await held(pg, ['7003', '7004', '7001'])).toEqual(['7001', '7003']);
    expect(await held(pg, ['7003'], RUN(1))).toEqual([]);
    expect(await held(pg, [])).toEqual([]);
  });

  it('takes a run back to change it, or sends it back with why', async () => {
    const asAsked = await updatedAt(pg, RUN(1));
    expect(await call(pg, 'vendor_payment_run_take_back', { id: RUN(1), by: JESSIE })).toEqual({ state: 'taken_back' });
    expect(await run(pg, RUN(1))).toMatchObject({ status: 'draft', asked_by: null, asked_at: null, updated_by: JESSIE });
    // Taken back, it's changed: a page from before can't ask for it again as it was.
    expect(await call(pg, 'vendor_payment_run_ask', { id: RUN(1), by: CRAIG, updated_at: asAsked })).toEqual({ state: 'changed' });
    expect(await call(pg, 'vendor_payment_run_take_back', { id: RUN(1) })).toEqual({ state: 'draft' });
    expect(await call(pg, 'vendor_payment_run_take_back', { id: RUN(97) })).toEqual({ state: 'gone' });

    // Its bills are free again: another run with Gateway's is asked for, and holds it.
    expect((await saveAndAsk(pg, RUN(3), { payments: [kept(GATEWAY)] })).state).toBe('asked');
    expect(await call(pg, 'vendor_payment_run_ask', { id: RUN(1), by: CRAIG, updated_at: await updatedAt(pg, RUN(1)) }))
      .toEqual({ state: 'held', held: ['7003'] });

    await expect(call(pg, 'vendor_payment_run_send_back', { id: RUN(3), by: JESSIE, reason: '  ' })).rejects.toThrow(/needs a reason/);
    await expect(call(pg, 'vendor_payment_run_send_back', { id: RUN(3), by: JESSIE })).rejects.toThrow(/needs a reason/);
    const asSent = await updatedAt(pg, RUN(3));
    expect(await call(pg, 'vendor_payment_run_send_back', { id: RUN(3), by: JESSIE, reason: ' Pay GS-209 next week ' })).toEqual({ state: 'sent_back' });
    expect(await run(pg, RUN(3))).toMatchObject({
      status: 'draft', asked_by: null, asked_at: null, returned_by: JESSIE, returned_reason: 'Pay GS-209 next week',
    });
    expect((await run(pg, RUN(3))).returned_at).toBeInstanceOf(Date);
    // Sent back, it's changed: asking again takes a page that shows why.
    expect(await call(pg, 'vendor_payment_run_ask', { id: RUN(3), by: CRAIG, updated_at: asSent })).toEqual({ state: 'changed' });
    expect(await call(pg, 'vendor_payment_run_send_back', { id: RUN(3), by: JESSIE, reason: 'again' })).toEqual({ state: 'draft' });
    expect(await call(pg, 'vendor_payment_run_send_back', { id: RUN(97), by: JESSIE, reason: 'x' })).toEqual({ state: 'gone' });

    // Asked again, the reason it was sent back goes; a long one is cut to fit.
    expect((await call(pg, 'vendor_payment_run_ask', { id: RUN(3), by: CRAIG, updated_at: await updatedAt(pg, RUN(3)) })).state).toBe('asked');
    expect(await run(pg, RUN(3))).toMatchObject({ status: 'waiting', returned_by: null, returned_at: null, returned_reason: null });
    expect(await call(pg, 'vendor_payment_run_send_back', { id: RUN(3), by: JESSIE, reason: 'r'.repeat(600) })).toEqual({ state: 'sent_back' });
    expect((await run(pg, RUN(3))).returned_reason).toHaveLength(500);

    expect((await call(pg, 'vendor_payment_run_ask', { id: RUN(1), by: CRAIG, updated_at: await updatedAt(pg, RUN(1)) })).state).toBe('asked');
  });

  let gateway = '';
  let ozark = '';

  it("approves the ask the approver saw, by someone who didn't ask, making a payment for each vendor", async () => {
    const askedAt = (await pg.query<{ t: string }>(`SELECT to_jsonb(asked_at) #>> '{}' AS t FROM vendor_payment_runs WHERE id = $1`, [RUN(1)])).rows[0].t;
    await expect(call(pg, 'vendor_payment_run_approve', { id: RUN(1), asked_at: askedAt })).rejects.toThrow(/needs who approved it/);
    expect(await call(pg, 'vendor_payment_run_approve', { id: RUN(3), approver: JESSIE, asked_at: askedAt })).toEqual({ state: 'draft' });
    expect(await call(pg, 'vendor_payment_run_approve', { id: RUN(97), approver: JESSIE, asked_at: askedAt })).toEqual({ state: 'gone' });
    expect(await call(pg, 'vendor_payment_run_approve', { id: RUN(1), approver: JESSIE, asked_at: '2026-11-01T00:00:00Z' })).toEqual({ state: 'changed' });
    expect(await call(pg, 'vendor_payment_run_approve', { id: RUN(1), approver: CRAIG, asked_at: askedAt })).toEqual({ state: 'yours' });
    expect(await payments(pg, RUN(1))).toEqual([]);

    const approved = await call(pg, 'vendor_payment_run_approve', { id: RUN(1), approver: JESSIE, asked_at: askedAt });
    expect(approved).toMatchObject({ state: 'claimed', run: { id: RUN(1), status: 'approved', approved_by: JESSIE, asked_by: CRAIG } });
    expect(await run(pg, RUN(1))).toMatchObject({ status: 'approved', approved_by: JESSIE, done_at: null });
    const made = await payments(pg, RUN(1));
    expect(made).toMatchObject([
      {
        position: 1, vendor_netsuite_id: '47', vendor_name: 'Gateway Steel', method: 'ach', bills: [keptBill(GS209)], bill_ids: ['7003'],
        total_cents: 245000, status: 'to_make', sent_by: null, has_sent_at: false, netsuite_payment_id: null, error: null,
      },
      {
        position: 2, vendor_netsuite_id: '31', vendor_name: 'Ozark Hose & Fitting', method: 'check', bills: [keptBill(B4410), keptBill(B4471)],
        bill_ids: ['7001', '7002'], total_cents: 141240, status: 'to_make',
      },
    ]);
    [gateway, ozark] = made.map((p) => p.id);

    // Approved again: it says so, and makes no more payments.
    expect(await call(pg, 'vendor_payment_run_approve', { id: RUN(1), approver: JESSIE, asked_at: askedAt })).toMatchObject({ state: 'approved', run: { id: RUN(1) } });
    expect(await payments(pg, RUN(1))).toHaveLength(2);
    // Taken back or sent back, it can't be: it's being paid.
    expect(await call(pg, 'vendor_payment_run_take_back', { id: RUN(1) })).toEqual({ state: 'approved' });
    expect(await call(pg, 'vendor_payment_run_send_back', { id: RUN(1), reason: 'x' })).toEqual({ state: 'approved' });

    // Its payments hold its bills now, not the run.
    expect(await held(pg, ['7001', '7003', '7004'])).toEqual(['7001', '7003']);
    expect(await held(pg, ['7001', '7003'], RUN(1))).toEqual([]);
    expect(await call(pg, 'vendor_payment_run_ask', { id: RUN(3), by: CRAIG, updated_at: await updatedAt(pg, RUN(3)) }))
      .toEqual({ state: 'held', held: ['7003'] });
    // An approved run can't be deleted out from under its payments.
    await expect(pg.query('DELETE FROM vendor_payment_runs WHERE id = $1', [RUN(1)])).rejects.toThrow(/foreign key/);
  });

  it("makes each payment once: being made, refused and made again, or dropped, and the run's paid after the last", async () => {
    await expect(call(pg, 'vendor_payment_claim', { id: gateway })).rejects.toThrow(/needs who made it/);
    const claimed = await call(pg, 'vendor_payment_claim', { id: gateway, by: JESSIE });
    expect(claimed).toMatchObject({ state: 'claimed', payment: { id: gateway, status: 'sending', sent_by: JESSIE } });
    expect(await payment(pg, gateway)).toMatchObject({ status: 'sending', sent_by: JESSIE, has_sent_at: true });
    // Pressed again while it's being made: the first press holds it, and it can't be dropped.
    expect(await call(pg, 'vendor_payment_claim', { id: gateway, by: CRAIG })).toMatchObject({ state: 'sending', payment: { id: gateway, sent_by: JESSIE } });
    expect(await call(pg, 'vendor_payment_drop', { id: gateway, by: CRAIG, reason: 'x' })).toEqual({ state: 'sending', run_done: false });

    // Refused, with why: held still, to make again or drop.
    expect(await call(pg, 'vendor_payment_let_go', { id: gateway, error: ' NetSuite error (400): Invalid apply reference key 7003. ' })).toEqual({ let_go: true });
    expect(await payment(pg, gateway)).toMatchObject({ status: 'refused', error: 'NetSuite error (400): Invalid apply reference key 7003.' });
    expect(await call(pg, 'vendor_payment_let_go', { id: gateway, error: 'again' })).toEqual({ let_go: false });
    expect(await call(pg, 'vendor_payment_made', { id: gateway, netsuite_payment_id: '8301' })).toEqual({ made: false, run_done: false });
    expect(await held(pg, ['7003'])).toEqual(['7003']);

    // Ozark's is refused meanwhile: the run isn't paid while it is.
    await call(pg, 'vendor_payment_claim', { id: ozark, by: JESSIE });
    expect(await call(pg, 'vendor_payment_let_go', { id: ozark, error: 'NetSuite error (400): Vendor is inactive.' })).toEqual({ let_go: true });

    // Made again, then made.
    expect(await call(pg, 'vendor_payment_claim', { id: gateway, by: CRAIG })).toMatchObject({ state: 'claimed', payment: { sent_by: CRAIG, error: null } });
    for (const netsuite_payment_id of ['', 'CHK-5521', null]) {
      await expect(call(pg, 'vendor_payment_made', { id: gateway, netsuite_payment_id })).rejects.toThrow(/needs NetSuite's id for its bill payment/);
    }
    expect(await call(pg, 'vendor_payment_made', { id: gateway, netsuite_payment_id: '8301', netsuite_number: ' ACH-0912 ' })).toEqual({ made: true, run_done: false });
    expect(await payment(pg, gateway)).toMatchObject({ status: 'made', netsuite_payment_id: '8301', netsuite_number: 'ACH-0912', error: null });
    expect(await run(pg, RUN(1))).toMatchObject({ status: 'approved', done_at: null });
    expect(await call(pg, 'vendor_payment_claim', { id: gateway, by: CRAIG })).toEqual({ state: 'made', netsuite_payment_id: '8301', netsuite_number: 'ACH-0912' });
    // Made is made: not made again, let go or dropped.
    expect(await call(pg, 'vendor_payment_made', { id: gateway, netsuite_payment_id: '8399' })).toEqual({ made: false, run_done: false });
    expect(await call(pg, 'vendor_payment_let_go', { id: gateway, error: 'x' })).toEqual({ let_go: false });
    expect(await call(pg, 'vendor_payment_drop', { id: gateway, by: CRAIG, reason: 'x' })).toEqual({ state: 'made', run_done: false });
    expect(await payment(pg, gateway)).toMatchObject({ status: 'made', netsuite_payment_id: '8301' });
    // Paid, GS-209 isn't held: NetSuite has it paid.
    expect(await held(pg, ['7003'])).toEqual([]);

    // Ozark's is dropped, its bills left open, and that was the run's last.
    await expect(call(pg, 'vendor_payment_drop', { id: ozark, reason: 'x' })).rejects.toThrow(/needs who dropped it/);
    expect(await call(pg, 'vendor_payment_drop', { id: ozark, by: JESSIE, reason: ' Ozark is sending a credit ' })).toEqual({ state: 'dropped', run_done: true });
    expect(await payment(pg, ozark)).toMatchObject({
      status: 'dropped', dropped_by: JESSIE, has_dropped_at: true, dropped_reason: 'Ozark is sending a credit', netsuite_payment_id: null,
    });
    expect(await run(pg, RUN(1))).toMatchObject({ status: 'done' });
    expect((await run(pg, RUN(1))).done_at).toBeInstanceOf(Date);
    expect(await held(pg, ['7001', '7002', '7003'])).toEqual([]);
    expect(await call(pg, 'vendor_payment_drop', { id: ozark, by: JESSIE })).toEqual({ state: 'already_dropped', run_done: false });
    expect(await call(pg, 'vendor_payment_claim', { id: ozark, by: CRAIG })).toEqual({ state: 'dropped' });
    expect((await pg.query<{ r: boolean }>('SELECT vendor_payment_run_finish($1::uuid) AS r', [RUN(1)])).rows[0].r).toBe(false);
    expect(await call(pg, 'vendor_payment_run_approve', { id: RUN(1), approver: JESSIE, asked_at: '2026-11-01T00:00:00Z' })).toMatchObject({ state: 'done' });

    const nobody = 'f0000000-0000-4000-8000-000000000099';
    expect(await call(pg, 'vendor_payment_claim', { id: nobody, by: CRAIG })).toEqual({ state: 'gone' });
    expect(await call(pg, 'vendor_payment_drop', { id: nobody, by: CRAIG })).toEqual({ state: 'gone', run_done: false });
    expect(await call(pg, 'vendor_payment_made', { id: nobody, netsuite_payment_id: '8300' })).toEqual({ made: false, run_done: false });
    expect(await call(pg, 'vendor_payment_let_go', { id: nobody, error: 'x' })).toEqual({ let_go: false });
  });

  it('pays a run whose only payment NetSuite refused once it is dropped, with or without why', async () => {
    // Ozark's bills are free again for a run of their own, asked for by Jessie and approved by Craig.
    expect((await saveAndAsk(pg, RUN(4), { payments: [kept(OZARK)] }, JESSIE)).state).toBe('asked');
    const askedAt = (await pg.query<{ t: string }>(`SELECT to_jsonb(asked_at) #>> '{}' AS t FROM vendor_payment_runs WHERE id = $1`, [RUN(4)])).rows[0].t;
    expect((await call(pg, 'vendor_payment_run_approve', { id: RUN(4), approver: CRAIG, asked_at: askedAt })).state).toBe('claimed');
    const [only] = await payments(pg, RUN(4));
    expect(only).toMatchObject({ position: 1, vendor_netsuite_id: '31', bill_ids: ['7002', '7001'], total_cents: 141240 });

    await call(pg, 'vendor_payment_claim', { id: only.id, by: CRAIG });
    expect(await call(pg, 'vendor_payment_let_go', { id: only.id, error: '  ' })).toEqual({ let_go: true });
    expect(await payment(pg, only.id)).toMatchObject({ status: 'refused', error: 'Not made' });
    await call(pg, 'vendor_payment_claim', { id: only.id, by: CRAIG });
    expect(await call(pg, 'vendor_payment_let_go', { id: only.id, error: 'x'.repeat(2100) })).toEqual({ let_go: true });
    expect((await payment(pg, only.id)).error).toHaveLength(2000);
    expect(await run(pg, RUN(4))).toMatchObject({ status: 'approved' });

    expect(await call(pg, 'vendor_payment_drop', { id: only.id, by: CRAIG, reason: '   ' })).toEqual({ state: 'dropped', run_done: true });
    expect(await payment(pg, only.id)).toMatchObject({ status: 'dropped', dropped_reason: null, dropped_by: CRAIG });
    expect(await run(pg, RUN(4))).toMatchObject({ status: 'done' });
  });

  it("keeps a run's rows to what its steps make of them", async () => {
    // A run asked for has its asking, one approved its approval, one paid when; a made payment has NetSuite's id.
    await expect(pg.query(`UPDATE vendor_payment_runs SET status = 'waiting' WHERE id = $1`, [RUN(3)])).rejects.toThrow(/check/);
    await expect(pg.query(`UPDATE vendor_payment_runs SET status = 'done' WHERE id = $1`, [RUN(3)])).rejects.toThrow(/check/);
    await expect(pg.query(`UPDATE vendor_payment_runs SET done_at = NULL WHERE id = $1`, [RUN(1)])).rejects.toThrow(/check/);
    await expect(pg.query(`UPDATE vendor_payment_run_payments SET status = 'made' WHERE id = $1`, [ozark])).rejects.toThrow(/check/);
    await expect(pg.query(`UPDATE vendor_payment_run_payments SET dropped_at = NULL WHERE id = $1`, [ozark])).rejects.toThrow(/check/);
    await expect(pg.query(`UPDATE vendor_payment_run_payments SET status = 'sending', sent_at = NULL WHERE id = $1`, [ozark])).rejects.toThrow(/check/);
    // One payment per vendor in a run, in one place each.
    await expect(pg.query(`
      INSERT INTO vendor_payment_run_payments (run_id, position, vendor_netsuite_id, method, bills, bill_ids, total_cents)
      VALUES ($1, 3, '31', 'check', '[{"bill_netsuite_id": "7009"}]'::jsonb, ARRAY['7009'], 100)`, [RUN(1)])).rejects.toThrow(/unique/);
    await expect(pg.query(`
      INSERT INTO vendor_payment_run_payments (run_id, position, vendor_netsuite_id, method, bills, bill_ids, total_cents)
      VALUES ($1, 1, '99', 'check', '[{"bill_netsuite_id": "7009"}]'::jsonb, ARRAY['7009'], 100)`, [RUN(1)])).rejects.toThrow(/unique/);
    await expect(pg.query(`
      INSERT INTO vendor_payment_run_payments (run_id, position, vendor_netsuite_id, method, bills, bill_ids, total_cents)
      VALUES ($1, 3, '99', 'check', '[{"bill_netsuite_id": "7009"}]'::jsonb, ARRAY['7009'], 0)`, [RUN(1)])).rejects.toThrow(/check/);
  });

  it('refuses a row no step makes, one rule at a time', async () => {
    const one = (billId: string) => [kept(GATEWAY, { bills: [{ ...keptBill(GS209), bill_netsuite_id: billId }] })];
    expect((await call(pg, 'vendor_payment_run_save', draft(RUN(80), { payments: one('7801') }))).saved).toBe(true);
    expect((await saveAndAsk(pg, RUN(81), { payments: one('7811') })).state).toBe('asked');
    expect((await saveAndAsk(pg, RUN(82), { payments: one('7821') })).state).toBe('asked');
    const askedAt = (await pg.query<{ t: string }>(`SELECT to_jsonb(asked_at) #>> '{}' AS t FROM vendor_payment_runs WHERE id = $1`, [RUN(82)])).rows[0].t;
    expect((await call(pg, 'vendor_payment_run_approve', { id: RUN(82), approver: JESSIE, asked_at: askedAt })).state).toBe('claimed');
    const [{ id: pay }] = await payments(pg, RUN(82));
    // Each of these breaks one rule only, so each rule is shown to hold by itself.
    const refused = (sql: string, id: string) => expect(pg.query(sql, [id])).rejects.toThrow(/violates check constraint/);
    const ids = (n: number) => `ARRAY(SELECT (40000 + g)::text FROM generate_series(1, ${n}) AS g)`;
    const list = (n: number) => `(SELECT jsonb_agg(jsonb_build_object('bill_netsuite_id', (40000 + g)::text)) FROM generate_series(1, ${n}) AS g)`;

    // A run: NetSuite's id for its bank account, a list of 50 vendors and 500 bills at most, $0 or more, one of its four
    // steps, a bank account once it's asked for, and its approval once it's approved.
    for (const set of [
      "bank_account_netsuite_id = 'Operating'", "payments = '{}'::jsonb", `payments = ${list(51)}`, `bill_ids = ${ids(501)}`, 'total_cents = -1',
    ]) await refused(`UPDATE vendor_payment_runs SET ${set} WHERE id = $1`, RUN(80));
    await pg.query(`UPDATE vendor_payment_runs SET payments = ${list(50)}, bill_ids = ${ids(500)}, total_cents = 0 WHERE id = $1`, [RUN(80)]);
    for (const set of ["status = 'paid'", 'bank_account_netsuite_id = NULL']) await refused(`UPDATE vendor_payment_runs SET ${set} WHERE id = $1`, RUN(81));
    await refused('UPDATE vendor_payment_runs SET approved_at = NULL WHERE id = $1', RUN(82));

    // A payment: in place 1 to 50, NetSuite's id for its vendor, a list of 1 to 100 bills, one of its five states, NetSuite's
    // id for its bill payment once it's made and only then, and when it was sent while it's being made.
    for (const set of [
      'position = 0', 'position = 51', "vendor_netsuite_id = 'V-47'", "bills = '[]'::jsonb", "bills = '{}'::jsonb", `bills = ${list(101)}`,
      'bill_ids = ARRAY[]::text[]', `bill_ids = ${ids(101)}`, "status = 'paid'", "netsuite_payment_id = '8302'", "status = 'sending'",
    ]) await refused(`UPDATE vendor_payment_run_payments SET ${set} WHERE id = $1`, pay);
    await pg.query(`UPDATE vendor_payment_run_payments SET position = 50, bills = ${list(100)}, bill_ids = ${ids(100)} WHERE id = $1`, [pay]);
    await pg.query(`UPDATE vendor_payment_run_payments SET status = 'made', netsuite_payment_id = '8302' WHERE id = $1`, [pay]);
    for (const set of ["netsuite_payment_id = 'CHK-5521'", 'netsuite_payment_id = NULL']) {
      await refused(`UPDATE vendor_payment_run_payments SET ${set} WHERE id = $1`, pay);
    }
  });

  const made = (over: Partial<MadeBillPayment> = {}): MadeBillPayment & { netsuiteId: string } => ({
    netsuiteId: '8301', netsuiteNumber: 'ACH-0912', company: 'BMG', vendorNetsuiteId: '47', vendorName: 'Gateway Steel', bankAccountNetsuiteId: '211',
    date: WORKED.date, method: 'ach', memo: 'ACH: November run', bills: [{ netsuiteId: '7003', number: 'GS-209', cents: 245000 }], totalCents: 245000,
    madeFromRun: RUN(1), madeFromPayment: gateway, askedBy: CRAIG, approvedBy: JESSIE, ...over,
  } as MadeBillPayment & { netsuiteId: string });
  const save = (m: MadeBillPayment & { netsuiteId: string }, over: Record<string, unknown> = {}) =>
    call(pg, 'gl_own_bill_payment_save', { ...ownBillPaymentPayload(m), ...over });
  const copy = async (id: string) => (await pg.query<Row>(`
    SELECT p.netsuite_number, c.code AS company, p.made_from_run, p.made_from_payment, p.vendor_netsuite_id, p.vendor_name,
           p.bank_account_netsuite_id, p.payment_date::text AS payment_date, p.method, p.memo, p.bills, p.amount::text AS amount,
           p.asked_by, p.approved_by
    FROM gl_own_bill_payments p JOIN gl_companies c ON c.id = p.company_id WHERE p.netsuite_id = $1`, [id])).rows;

  it("saves Books' own copy of the bill payment, and only once", async () => {
    expect(await save(made({ netsuiteNumber: ' ACH-0912 ' }))).toEqual({ saved: true });
    expect(await copy('8301')).toEqual([{
      netsuite_number: 'ACH-0912', company: 'BMG', made_from_run: RUN(1), made_from_payment: gateway, vendor_netsuite_id: '47',
      vendor_name: 'Gateway Steel', bank_account_netsuite_id: '211', payment_date: '2026-11-06', method: 'ach', memo: 'ACH: November run',
      bills: [{ netsuite_id: '7003', number: 'GS-209', amount: '2450.00' }], amount: '2450.00', asked_by: CRAIG, approved_by: JESSIE,
    }]);

    // Saved again, by the same payment or another, it stays as it was.
    expect(await save(made({ totalCents: 100, madeFromPayment: ozark }))).toEqual({ saved: false });
    expect(await copy('8301')).toMatchObject([{ amount: '2450.00', made_from_payment: gateway }]);

    // 1084's check, with no number, name or memo, and nobody's name on it.
    expect(await save(
      made({ netsuiteId: '8302', netsuiteNumber: '  ', company: '1084', vendorName: '  ', method: 'check', memo: null, askedBy: null, approvedBy: null, totalCents: 1 }),
      { made_from_run: null, made_from_payment: null },
    )).toEqual({ saved: true });
    expect(await copy('8302')).toMatchObject([{
      netsuite_number: null, company: '1084', made_from_run: null, made_from_payment: null, vendor_name: null, method: 'check', memo: null,
      amount: '0.01', asked_by: null, approved_by: null,
    }]);
  });

  it("refuses a copy that isn't whole, and keeps nothing of it", async () => {
    const m = made({ netsuiteId: '8309' });
    await expect(save(m, { company: undefined })).rejects.toThrow(/company \(none\) doesn't exist/);
    await expect(save(m, { company: 'ACME' })).rejects.toThrow(/company ACME doesn't exist/);
    for (const netsuite_id of ['CHK-5521', null]) await expect(save(m, { netsuite_id })).rejects.toThrow(/needs NetSuite's id for it/);
    for (const amount of ['0.00', '-5.00']) await expect(save(m, { amount })).rejects.toThrow(/check/);
    // A JSON null is a value, not a missing one.
    for (const bills of [[], { netsuite_id: '7003' }, null]) await expect(save(m, { bills })).rejects.toThrow(/check/);
    await expect(save(m, { method: 'wire' })).rejects.toThrow(/check/);
    for (const vendor_netsuite_id of ['V-47', null]) await expect(save(m, { vendor_netsuite_id })).rejects.toThrow(/check|null/);
    await expect(save(m, { bank_account_netsuite_id: 'Operating' })).rejects.toThrow(/check/);
    await expect(save(m, { payment_date: null })).rejects.toThrow(/null/);
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_bill_payments WHERE netsuite_id IN ('8309', 'CHK-5521')`)).rows[0]).toEqual({ n: 0 });

    // A copy is kept by NetSuite's id for it, and its company can't be deleted out from under it.
    await expect(pg.query(`UPDATE gl_own_bill_payments SET netsuite_id = 'CHK-5521' WHERE netsuite_id = '8301'`)).rejects.toThrow(/violates check constraint/);
    await pg.query(`INSERT INTO gl_companies (code, name) VALUES ('ZZTEST', 'Made-up Co')`);
    expect(await save(made({ netsuiteId: '8398' }), { company: 'ZZTEST' })).toEqual({ saved: true });
    await expect(pg.query(`DELETE FROM gl_companies WHERE code = 'ZZTEST'`)).rejects.toThrow(/gl_own_bill_payments/);
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        for (const table of ['vendor_payment_runs', 'vendor_payment_run_payments', 'gl_own_bill_payments']) {
          await expect(pg.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
        }
        for (const fn of [
          'vendor_payment_run_save', 'vendor_payment_run_ask', 'vendor_payment_run_take_back', 'vendor_payment_run_send_back',
          'vendor_payment_run_approve', 'vendor_payment_claim', 'vendor_payment_let_go', 'vendor_payment_made', 'vendor_payment_drop',
          'gl_own_bill_payment_save',
        ]) {
          await expect(call(pg, fn, { id: RUN(8) })).rejects.toThrow(/permission denied for function/);
        }
        await expect(held(pg, ['7001'])).rejects.toThrow(/permission denied for function/);
        await expect(pg.query('SELECT vendor_payment_run_finish($1::uuid)', [RUN(8)])).rejects.toThrow(/permission denied for function/);
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('vendor_payment_runs', 'vendor_payment_run_payments', 'gl_own_bill_payments') ORDER BY relname`);
    expect(rls.rows).toEqual([
      { relname: 'gl_own_bill_payments', relrowsecurity: true },
      { relname: 'vendor_payment_run_payments', relrowsecurity: true },
      { relname: 'vendor_payment_runs', relrowsecurity: true },
    ]);
    await pg.exec('SET ROLE service_role');
  });
});
