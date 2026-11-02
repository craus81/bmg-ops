// Migration 486 switches taking deposits in FleetSuite off, a thirteenth books
// switch, keeps one row per press of Take deposit as it goes from being made
// in NetSuite to made, or back to open when NetSuite doesn't make it, and
// Books' own copy of each deposit FleetSuite makes. This runs migration 359
// with 466, 485 and 486 in an in-memory Postgres (PGlite) as the app's server
// login, claiming presses worked out by src/lib/take-deposit.ts and saving
// copies from src/lib/books/own-deposits.ts the way /api/sales-orders/deposit
// does. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { netsuiteMemo } from '@/lib/receive-payment';
import { workOutDeposit, type DepositOrder } from '@/lib/take-deposit';
import { SWITCH_PIECES } from './switches';
import { ownDepositPayload, type MadeDeposit } from './own-deposits';

const PRESS = (n: number) => `f0000000-0000-4000-8000-00000000000${n}`;
const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const JESSIE = 'a0000000-0000-4000-8000-000000000002';
const ACME = 'c0000000-0000-4000-8000-00000000000a';

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
    -- What migrations 466, 485 and 486 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${JESSIE}');
    INSERT INTO public.customers (id, netsuite_id) VALUES ('${ACME}', '501');
  `);
  for (const file of [
    '359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '485-payments-received-in-fleetsuite.sql', '486-deposits-taken-in-fleetsuite.sql',
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

const ORDER: DepositOrder = { id: '4521', number: 'SO1450', status: 'B', statusName: 'Pending Fulfillment', totalCents: 1250040 };
/** Acme's check 10442, half down on SO1450, as Take deposit works it out. */
const WORKED = workOutDeposit(
  { date: '2026-10-30', method: 'check', reference: ' 10442 ', memo: ' half down ', amountCents: 250050 }, ORDER, [], { today: '2026-10-31' },
);

/** The claim as the route takes it. */
const press = (id: string, over: Record<string, unknown> = {}) => ({
  id, by: CRAIG, company: 'BMG', customer_netsuite_id: '501', customer_name: ' Acme Plumbing ', sales_order_netsuite_id: ORDER.id,
  sales_order_number: ORDER.number, received_date: WORKED.date, method: WORKED.method, reference: WORKED.reference, memo: WORKED.memo,
  amount_cents: WORKED.amountCents, ...over,
});

type Row = Record<string, any>;
const row = async (pg: PGlite, id: string) =>
  (await pg.query<Row>(`SELECT *, received_date::text AS received_date, sent_at IS NOT NULL AS has_sent_at FROM received_deposits WHERE id = $1`, [id])).rows[0];

describe('migration 486', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    expect(WORKED.problems).toEqual([]);
  });
  afterAll(async () => { await pg.close(); });

  it('starts taking deposits switched off, a thirteenth piece', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'customer_deposits', is_on: false, changed_by: null },
      { piece: 'customer_payments', is_on: false, changed_by: null },
    ]);
    // Every piece the app named then is one the column takes, and nothing else is (487 adds bank deposits, 488 paying vendors,
    // 494 approving adjustments, 497 FleetSuite's own numbers, 498 invoice PDFs).
    const then = SWITCH_PIECES.filter((piece) => !['bank_deposits', 'vendor_payments', 'adjustment_approvals', 'own_numbers', 'invoice_pdfs'].includes(piece));
    expect(then).toHaveLength(13);
    await pg.exec('BEGIN');
    try {
      for (const piece of then) await pg.query('INSERT INTO books_switches (piece) VALUES ($1) ON CONFLICT (piece) DO NOTHING', [piece]);
      expect((await pg.query('SELECT count(*)::int AS n FROM books_switches')).rows[0]).toEqual({ n: 13 });
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
    const claimed = await call(pg, 'received_deposit_claim', press(PRESS(1)));
    expect(claimed.state).toBe('claimed');
    expect(claimed.deposit).toMatchObject({ id: PRESS(1), status: 'sending', sent_by: CRAIG, created_by: CRAIG, amount_cents: 250050 });
    expect(await row(pg, PRESS(1))).toMatchObject({
      company: 'BMG', customer_netsuite_id: '501', customer_name: 'Acme Plumbing', sales_order_netsuite_id: '4521', sales_order_number: 'SO1450',
      received_date: '2026-10-30', method: 'check', reference: '10442', memo: 'half down', amount_cents: 250050,
      status: 'sending', sent_by: CRAIG, has_sent_at: true, netsuite_deposit_id: null, netsuite_number: null, error: null,
    });

    // Pressed again while it's being made: the press holds it.
    const again = await call(pg, 'received_deposit_claim', press(PRESS(1), { by: JESSIE }));
    expect(again).toMatchObject({ state: 'sending', deposit: { id: PRESS(1), sent_by: CRAIG } });

    expect(await call(pg, 'received_deposit_made', { id: PRESS(1), netsuite_deposit_id: '7301', netsuite_number: ' DEP-41 ' })).toEqual({ made: true });
    expect(await row(pg, PRESS(1))).toMatchObject({ status: 'made', netsuite_deposit_id: '7301', netsuite_number: 'DEP-41', error: null });
    expect(await call(pg, 'received_deposit_claim', press(PRESS(1)))).toEqual({ state: 'made', netsuite_deposit_id: '7301', netsuite_number: 'DEP-41' });
    // Made is made: neither made again nor let go.
    expect(await call(pg, 'received_deposit_made', { id: PRESS(1), netsuite_deposit_id: '7999' })).toEqual({ made: false });
    expect(await call(pg, 'received_deposit_let_go', { id: PRESS(1), error: 'x' })).toEqual({ let_go: false });
    expect(await row(pg, PRESS(1))).toMatchObject({ status: 'made', netsuite_deposit_id: '7301', error: null });
  });

  it("lets go of a press NetSuite didn't make, keeping why, and takes it again as it's sent then", async () => {
    await call(pg, 'received_deposit_claim', press(PRESS(2)));
    expect(await call(pg, 'received_deposit_let_go', { id: PRESS(2), error: ' NetSuite error (400): The sales order is closed. ' })).toEqual({ let_go: true });
    expect(await row(pg, PRESS(2))).toMatchObject({
      status: 'open', sent_by: null, has_sent_at: false, error: 'NetSuite error (400): The sales order is closed.',
    });
    expect(await call(pg, 'received_deposit_let_go', { id: PRESS(2), error: 'again' })).toEqual({ let_go: false });
    expect(await call(pg, 'received_deposit_made', { id: PRESS(2), netsuite_deposit_id: '7302' })).toEqual({ made: false });

    // Sent again by someone else, as an ACH deposit of another amount.
    const retaken = await call(pg, 'received_deposit_claim', press(PRESS(2), {
      by: JESSIE, method: 'ach', reference: '  ', memo: '', customer_name: '', sales_order_number: ' SO1450 ', amount_cents: 100000,
    }));
    expect(retaken.state).toBe('claimed');
    expect(await row(pg, PRESS(2))).toMatchObject({
      status: 'sending', sent_by: JESSIE, created_by: CRAIG, has_sent_at: true, error: null, method: 'ach', reference: null,
      memo: null, customer_name: null, sales_order_number: 'SO1450', amount_cents: 100000,
    });
    expect(await call(pg, 'received_deposit_made', { id: PRESS(2), netsuite_deposit_id: '7302', netsuite_number: '' })).toEqual({ made: true });
    expect(await row(pg, PRESS(2))).toMatchObject({ status: 'made', netsuite_deposit_id: '7302', netsuite_number: null });

    // A press let go with no reason says it wasn't made, and a long reason is cut to fit.
    await call(pg, 'received_deposit_claim', press(PRESS(3)));
    expect(await call(pg, 'received_deposit_let_go', { id: PRESS(3), error: '  ' })).toEqual({ let_go: true });
    expect(await row(pg, PRESS(3))).toMatchObject({ status: 'open', error: 'Not made' });
    await call(pg, 'received_deposit_claim', press(PRESS(3)));
    expect(await call(pg, 'received_deposit_let_go', { id: PRESS(3), error: 'x'.repeat(2100) })).toEqual({ let_go: true });
    expect((await row(pg, PRESS(3))).error).toHaveLength(2000);
  });

  it("refuses a press that isn't whole, and keeps nothing of it", async () => {
    const id = PRESS(9);
    const refused = async (over: Record<string, unknown>, why: RegExp) =>
      expect(call(pg, 'received_deposit_claim', press(id, over))).rejects.toThrow(why);
    await refused({ by: '' }, /needs who sent it/);
    await refused({ by: null }, /needs who sent it/);
    for (const amount_cents of [0, -100, 2500.5, '250050', null]) await refused({ amount_cents }, /whole number of cents above 0/);
    for (const sales_order_netsuite_id of ['SO1450', '', null]) await refused({ sales_order_netsuite_id }, /goes on a sales order, by NetSuite's id for it/);
    await refused({ method: 'cash' }, /a check or an ACH payment/);
    await refused({ method: null }, /a check or an ACH payment/);
    await refused({ reference: ' ' }, /a check needs its number/);
    await refused({ reference: null }, /a check needs its number/);
    await refused({ company: ' ' }, /check/);
    await refused({ customer_netsuite_id: 'C-501' }, /check/);
    await refused({ reference: '1'.repeat(41) }, /check/);
    await refused({ memo: 'm'.repeat(301) }, /check/);
    await refused({ customer_name: 'n'.repeat(301) }, /check/);
    await refused({ sales_order_number: 'S'.repeat(61) }, /check/);
    expect((await pg.query('SELECT count(*)::int AS n FROM received_deposits WHERE id = $1', [id])).rows[0]).toEqual({ n: 0 });

    await call(pg, 'received_deposit_claim', press(PRESS(4)));
    for (const netsuite_deposit_id of ['', 'DEP-41', null]) {
      await expect(call(pg, 'received_deposit_made', { id: PRESS(4), netsuite_deposit_id })).rejects.toThrow(/NetSuite's id for it/);
    }
    expect(await row(pg, PRESS(4))).toMatchObject({ status: 'sending', netsuite_deposit_id: null });
  });

  const made = (over: Partial<MadeDeposit> = {}): MadeDeposit & { netsuiteId: string } => ({
    netsuiteId: '7301', netsuiteNumber: 'DEP-41', company: 'BMG', customerNetsuiteId: '501', salesOrderNetsuiteId: '4521',
    salesOrderNumber: 'SO1450', date: WORKED.date, method: 'check', reference: '10442', memo: netsuiteMemo('check', '10442', 'half down'),
    amountCents: 250050, madeFromId: PRESS(1), madeBy: CRAIG, ...over,
  } as MadeDeposit & { netsuiteId: string });
  const save = (m: MadeDeposit & { netsuiteId: string }, over: Record<string, unknown> = {}) =>
    call(pg, 'gl_own_deposit_save', { ...ownDepositPayload(m, { customerId: ACME }), ...over });
  const copy = async (id: string) => (await pg.query<Row>(`
    SELECT d.netsuite_number, c.code AS company, d.made_from_id, d.customer_netsuite_id, d.customer_id, d.sales_order_netsuite_id,
           d.sales_order_number, d.deposit_date::text AS deposit_date, d.method, d.reference, d.memo, d.deposited_to,
           d.amount::text AS amount, d.made_by
    FROM gl_own_deposits d JOIN gl_companies c ON c.id = d.company_id WHERE d.netsuite_id = $1`, [id])).rows;

  it("saves Books' own copy, in Undeposited Funds, on its order, and only once", async () => {
    expect(await save(made())).toEqual({ saved: true });
    expect(await copy('7301')).toEqual([{
      netsuite_number: 'DEP-41', company: 'BMG', made_from_id: PRESS(1), customer_netsuite_id: '501', customer_id: ACME,
      sales_order_netsuite_id: '4521', sales_order_number: 'SO1450', deposit_date: '2026-10-30', method: 'check', reference: '10442',
      memo: 'Check 10442 · half down', deposited_to: 'undeposited_funds', amount: '2500.50', made_by: CRAIG,
    }]);

    // Saved again, by the same press or another, it stays as it was.
    expect(await save(made({ amountCents: 100, madeFromId: PRESS(2) }))).toEqual({ saved: false });
    expect(await copy('7301')).toMatchObject([{ amount: '2500.50', made_from_id: PRESS(1) }]);

    // 1084's, an ACH deposit with no reference, no numbers and nobody's name on it.
    expect(await save(made({
      netsuiteId: '7302', netsuiteNumber: null, company: '1084', salesOrderNumber: null, method: 'ach', reference: null, memo: 'ACH',
      madeBy: null, amountCents: 1,
    }), { customer_id: null, made_from_id: null })).toEqual({ saved: true });
    expect(await copy('7302')).toEqual([{
      netsuite_number: null, company: '1084', made_from_id: null, customer_netsuite_id: '501', customer_id: null,
      sales_order_netsuite_id: '4521', sales_order_number: null, deposit_date: '2026-10-30', method: 'ach', reference: null, memo: 'ACH',
      deposited_to: 'undeposited_funds', amount: '0.01', made_by: null,
    }]);
  });

  it("refuses a copy that isn't whole, and keeps nothing of it", async () => {
    const m = made({ netsuiteId: '7309' });
    await expect(save(m, { company: undefined })).rejects.toThrow(/company \(none\) doesn't exist/);
    await expect(save(m, { company: 'ACME' })).rejects.toThrow(/company ACME doesn't exist/);
    for (const netsuite_id of ['DEP-49', null]) await expect(save(m, { netsuite_id })).rejects.toThrow(/needs NetSuite's id for the deposit/);
    for (const amount of ['0.00', '-5.00']) await expect(save(m, { amount })).rejects.toThrow(/check/);
    await expect(save(m, { method: 'cash' })).rejects.toThrow(/check/);
    await expect(save(m, { deposited_to: 'operating' })).rejects.toThrow(/check/);
    await expect(save(m, { sales_order_netsuite_id: 'SO1450' })).rejects.toThrow(/check/);
    await expect(save(m, { sales_order_netsuite_id: null })).rejects.toThrow(/null/);
    await expect(save(m, { customer_netsuite_id: 'C-501' })).rejects.toThrow(/check/);
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_deposits WHERE netsuite_id IN ('7309', 'DEP-49')`)).rows[0]).toEqual({ n: 0 });
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        for (const table of ['received_deposits', 'gl_own_deposits']) {
          await expect(pg.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
        }
        for (const fn of ['received_deposit_claim', 'received_deposit_let_go', 'received_deposit_made', 'gl_own_deposit_save']) {
          await expect(call(pg, fn, { id: PRESS(5) })).rejects.toThrow(/permission denied for function/);
        }
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('received_deposits', 'gl_own_deposits') ORDER BY relname`);
    expect(rls.rows).toEqual([
      { relname: 'gl_own_deposits', relrowsecurity: true },
      { relname: 'received_deposits', relrowsecurity: true },
    ]);
    await pg.exec('SET ROLE service_role');
  });
});
