// Migration 485 switches receiving payments in FleetSuite off, a twelfth books
// switch, keeps one row per press of Receive payment as it goes from being
// made in NetSuite to made, or back to open when NetSuite doesn't make it, and
// Books' own copy of each payment FleetSuite makes. This runs migration 359
// with 466 and 485 in an in-memory Postgres (PGlite) as the app's server
// login, claiming presses worked out by src/lib/receive-payment.ts and saving
// copies from src/lib/books/own-payments.ts the way /api/invoices/payment
// does. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { appliedToKeep, keptApplied, netsuiteMemo, workOutPayment, type OpenInvoice } from '@/lib/receive-payment';
import { SWITCH_PIECES } from './switches';
import { ownPaymentPayload, type MadePayment } from './own-payments';

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
    -- What migrations 466 and 485 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${JESSIE}');
    INSERT INTO public.customers (id, netsuite_id) VALUES ('${ACME}', '501');
  `);
  for (const file of ['359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '485-payments-received-in-fleetsuite.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

const OPEN: OpenInvoice[] = [
  { id: '9001', number: 'INV2001', date: '2026-10-01', dueDate: '2026-10-31', po: null, totalCents: 25000, openCents: 25000 },
  { id: '8990', number: 'INV1990', date: '2026-09-03', dueDate: '2026-10-03', po: 'PO-77', totalCents: 120000, openCents: 40010 },
];
/** Acme's check 10442 for both its open invoices, as Receive payment works it out. */
const WORKED = workOutPayment({
  date: '2026-10-30', method: 'check', reference: ' 10442 ', memo: ' September and October ', amountCents: 65010,
  applied: [{ invoiceId: '9001', cents: 25000 }, { invoiceId: '8990', cents: 40010 }],
}, OPEN, { today: '2026-10-31' });

/** The claim as the route takes it. */
const press = (id: string, over: Record<string, unknown> = {}) => ({
  id, by: CRAIG, company: 'BMG', customer_netsuite_id: '501', customer_name: ' Acme Plumbing ', started_from_invoice_id: '9001',
  received_date: WORKED.date, method: WORKED.method, reference: WORKED.reference, memo: WORKED.memo, amount_cents: WORKED.amountCents,
  applied: appliedToKeep(WORKED.applied), ...over,
});

type Row = Record<string, any>;
const row = async (pg: PGlite, id: string) =>
  (await pg.query<Row>(`SELECT *, received_date::text AS received_date, sent_at IS NOT NULL AS has_sent_at FROM received_payments WHERE id = $1`, [id])).rows[0];

describe('migration 485', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    expect(WORKED.problems).toEqual([]);
  });
  afterAll(async () => { await pg.close(); });

  it('starts receiving payments switched off, a twelfth piece', async () => {
    expect((await pg.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'credit_memos', is_on: false, changed_by: null },
      { piece: 'customer_payments', is_on: false, changed_by: null },
    ]);
    // Every piece the app names is one the column takes, and nothing else is.
    expect(SWITCH_PIECES).toHaveLength(12);
    await pg.exec('BEGIN');
    try {
      for (const piece of SWITCH_PIECES) await pg.query('INSERT INTO books_switches (piece) VALUES ($1) ON CONFLICT (piece) DO NOTHING', [piece]);
      expect((await pg.query('SELECT count(*)::int AS n FROM books_switches')).rows[0]).toEqual({ n: 12 });
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
    const claimed = await call(pg, 'received_payment_claim', press(PRESS(1)));
    expect(claimed.state).toBe('claimed');
    expect(claimed.payment).toMatchObject({ id: PRESS(1), status: 'sending', sent_by: CRAIG, created_by: CRAIG, amount_cents: 65010 });
    const r = await row(pg, PRESS(1));
    expect(r).toMatchObject({
      company: 'BMG', customer_netsuite_id: '501', customer_name: 'Acme Plumbing', started_from_invoice_id: '9001',
      received_date: '2026-10-30', method: 'check', reference: '10442', memo: 'September and October', amount_cents: 65010,
      status: 'sending', sent_by: CRAIG, has_sent_at: true, netsuite_payment_id: null, error: null, warning: null,
    });
    // Oldest first, as NetSuite lists them, and read back as kept.
    expect(r.applied).toEqual([
      { invoice_netsuite_id: '8990', invoice_number: 'INV1990', cents: 40010 },
      { invoice_netsuite_id: '9001', invoice_number: 'INV2001', cents: 25000 },
    ]);
    expect(keptApplied(r.applied)).toEqual(WORKED.applied.map(({ invoiceId, number, cents }) => ({ invoiceId, number, cents })));

    // Pressed again while it's being made: the press holds it.
    const again = await call(pg, 'received_payment_claim', press(PRESS(1), { by: JESSIE }));
    expect(again).toMatchObject({ state: 'sending', payment: { id: PRESS(1), sent_by: CRAIG } });

    expect(await call(pg, 'received_payment_made', { id: PRESS(1), netsuite_payment_id: '7101', netsuite_number: ' PYMT-301 ' })).toEqual({ made: true });
    expect(await row(pg, PRESS(1))).toMatchObject({ status: 'made', netsuite_payment_id: '7101', netsuite_number: 'PYMT-301', error: null, warning: null });
    expect(await call(pg, 'received_payment_claim', press(PRESS(1)))).toEqual({ state: 'made', netsuite_payment_id: '7101', netsuite_number: 'PYMT-301' });
    // Made is made: neither made again nor let go.
    expect(await call(pg, 'received_payment_made', { id: PRESS(1), netsuite_payment_id: '7999' })).toEqual({ made: false });
    expect(await call(pg, 'received_payment_let_go', { id: PRESS(1), error: 'x' })).toEqual({ let_go: false });
    expect(await row(pg, PRESS(1))).toMatchObject({ status: 'made', netsuite_payment_id: '7101', error: null });
  });

  it("lets go of a press NetSuite didn't make, keeping why, and takes it again as it's sent then", async () => {
    await call(pg, 'received_payment_claim', press(PRESS(2)));
    expect(await call(pg, 'received_payment_let_go', { id: PRESS(2), error: ' NetSuite error (400): The invoice is paid in full. ' })).toEqual({ let_go: true });
    expect(await row(pg, PRESS(2))).toMatchObject({
      status: 'open', sent_by: null, has_sent_at: false, error: 'NetSuite error (400): The invoice is paid in full.',
    });
    expect(await call(pg, 'received_payment_let_go', { id: PRESS(2), error: 'again' })).toEqual({ let_go: false });
    expect(await call(pg, 'received_payment_made', { id: PRESS(2), netsuite_payment_id: '7102' })).toEqual({ made: false });

    // Sent again by someone else, as an ACH payment of one invoice.
    const retaken = await call(pg, 'received_payment_claim', press(PRESS(2), {
      by: JESSIE, method: 'ach', reference: '  ', memo: '', customer_name: '', amount_cents: 25000,
      applied: [{ invoice_netsuite_id: '9001', invoice_number: ' INV2001 ', cents: 25000 }],
    }));
    expect(retaken.state).toBe('claimed');
    expect(await row(pg, PRESS(2))).toMatchObject({
      status: 'sending', sent_by: JESSIE, created_by: CRAIG, has_sent_at: true, error: null, method: 'ach', reference: null,
      memo: null, customer_name: null, amount_cents: 25000, applied: [{ invoice_netsuite_id: '9001', invoice_number: 'INV2001', cents: 25000 }],
    });

    // Made, but not applied the way it was sent.
    const warning = `NetSuite shows INV2001 with $250.00 open now. ${'x'.repeat(2100)}`;
    expect(await call(pg, 'received_payment_made', { id: PRESS(2), netsuite_payment_id: '7102', netsuite_number: '', warning })).toEqual({ made: true });
    const made = await row(pg, PRESS(2));
    expect(made).toMatchObject({ status: 'made', netsuite_payment_id: '7102', netsuite_number: null });
    expect(made.warning).toBe(warning.slice(0, 2000));

    // A press let go with no reason says it wasn't made.
    await call(pg, 'received_payment_claim', press(PRESS(3)));
    expect(await call(pg, 'received_payment_let_go', { id: PRESS(3), error: '  ' })).toEqual({ let_go: true });
    expect(await row(pg, PRESS(3))).toMatchObject({ status: 'open', error: 'Not made' });
  });

  it("refuses a press that isn't whole, and keeps nothing of it", async () => {
    const id = PRESS(9);
    const refused = async (over: Record<string, unknown>, why: RegExp) =>
      expect(call(pg, 'received_payment_claim', press(id, over))).rejects.toThrow(why);
    await refused({ by: '' }, /needs who sent it/);
    await refused({ by: null }, /needs who sent it/);
    for (const amount_cents of [0, -100, 650.1, '65010', null]) await refused({ amount_cents }, /whole number of cents above 0/);
    await refused({ applied: [] }, /one invoice or more, 50 at most/);
    await refused({ applied: {} }, /one invoice or more, 50 at most/);
    await refused({
      amount_cents: 51, applied: Array.from({ length: 51 }, (_, i) => ({ invoice_netsuite_id: String(100 + i), cents: 1 })),
    }, /one invoice or more, 50 at most/);
    const one = { invoice_netsuite_id: '9001', invoice_number: 'INV2001', cents: 65010 };
    for (const bad of [
      { ...one, invoice_netsuite_id: 'INV2001' }, { ...one, invoice_netsuite_id: null }, { ...one, cents: 0 }, { ...one, cents: 650.1 },
      { ...one, cents: '65010' }, { ...one, invoice_number: 'I'.repeat(61) }, 'INV2001',
    ]) await refused({ applied: [bad] }, /NetSuite's id for it and a whole number of cents above 0/);
    await refused({ applied: [{ ...one, cents: 32505 }, { ...one, cents: 32505 }] }, /pays each invoice once/);
    await refused({ amount_cents: 65011 }, /must add up to its amount/);
    await refused({ method: 'cash' }, /a check or an ACH payment/);
    await refused({ method: null }, /a check or an ACH payment/);
    await refused({ reference: ' ' }, /a check needs its number/);
    await refused({ reference: null }, /a check needs its number/);
    await refused({ company: ' ' }, /check/);
    await refused({ customer_netsuite_id: 'C-501' }, /check/);
    await refused({ reference: '1'.repeat(41) }, /check/);
    expect((await pg.query('SELECT count(*)::int AS n FROM received_payments WHERE id = $1', [id])).rows[0]).toEqual({ n: 0 });

    await call(pg, 'received_payment_claim', press(PRESS(4)));
    for (const netsuite_payment_id of ['', 'PYMT-301', null]) {
      await expect(call(pg, 'received_payment_made', { id: PRESS(4), netsuite_payment_id })).rejects.toThrow(/NetSuite's id for it/);
    }
    expect(await row(pg, PRESS(4))).toMatchObject({ status: 'sending', netsuite_payment_id: null });
  });

  const made = (over: Partial<MadePayment> = {}): MadePayment & { netsuiteId: string } => ({
    netsuiteId: '7101', netsuiteNumber: 'PYMT-301', company: 'BMG', customerNetsuiteId: '501', date: WORKED.date, method: 'check',
    reference: '10442', memo: netsuiteMemo('check', '10442', 'September and October'), amountCents: 65010,
    applied: WORKED.applied.map(({ invoiceId, number, cents }) => ({ invoiceId, number, cents })), madeFromId: PRESS(1), madeBy: CRAIG,
    ...over,
  } as MadePayment & { netsuiteId: string });
  const save = (m: MadePayment & { netsuiteId: string }, over: Record<string, unknown> = {}) =>
    call(pg, 'gl_own_payment_save', { ...ownPaymentPayload(m, { customerId: ACME }), ...over });

  it("saves Books' own copy whole, in Undeposited Funds, and only once", async () => {
    expect(await save(made())).toEqual({ saved: true, lines: 2 });
    const head = (await pg.query<Row>(`
      SELECT p.netsuite_number, c.code AS company, p.made_from_id, p.customer_netsuite_id, p.customer_id, p.payment_date::text AS payment_date,
             p.method, p.reference, p.memo, p.deposited_to, p.amount::text AS amount, p.made_by
      FROM gl_own_payments p JOIN gl_companies c ON c.id = p.company_id WHERE p.netsuite_id = '7101'`)).rows;
    expect(head).toEqual([{
      netsuite_number: 'PYMT-301', company: 'BMG', made_from_id: PRESS(1), customer_netsuite_id: '501', customer_id: ACME,
      payment_date: '2026-10-30', method: 'check', reference: '10442', memo: 'Check 10442 · September and October',
      deposited_to: 'undeposited_funds', amount: '650.10', made_by: CRAIG,
    }]);
    const lines = async (id: string) => (await pg.query<Row>(`
      SELECT line_no, invoice_netsuite_id, invoice_number, amount::text AS amount FROM gl_own_payment_applications
      WHERE payment_id = $1 ORDER BY line_no`, [id])).rows;
    expect(await lines('7101')).toEqual([
      { line_no: 1, invoice_netsuite_id: '8990', invoice_number: 'INV1990', amount: '400.10' },
      { line_no: 2, invoice_netsuite_id: '9001', invoice_number: 'INV2001', amount: '250.00' },
    ]);

    // Saved again, by the same press or another, it stays as it was.
    expect(await save(made({ amountCents: 25000, applied: [{ invoiceId: '9001', number: 'INV2001', cents: 25000 }] }))).toEqual({ saved: false, lines: 0 });
    expect(await lines('7101')).toHaveLength(2);

    // 1084's, an ACH payment with no reference, no number and nobody's name on it.
    expect(await save(made({
      netsuiteId: '7102', netsuiteNumber: null, company: '1084', method: 'ach', reference: null, memo: 'ACH', madeBy: null, amountCents: 1,
      applied: [{ invoiceId: '9100', number: '', cents: 1 }],
    }))).toEqual({ saved: true, lines: 1 });
    expect((await pg.query<Row>(`
      SELECT c.code AS company, p.netsuite_number, p.reference, p.made_by, p.amount::text AS amount
      FROM gl_own_payments p JOIN gl_companies c ON c.id = p.company_id WHERE p.netsuite_id = '7102'`)).rows)
      .toEqual([{ company: '1084', netsuite_number: null, reference: null, made_by: null, amount: '0.01' }]);
    expect(await lines('7102')).toEqual([{ line_no: 1, invoice_netsuite_id: '9100', invoice_number: null, amount: '0.01' }]);
  });

  it("refuses a copy that isn't whole, and keeps nothing of it", async () => {
    const m = made({ netsuiteId: '7109' });
    await expect(save(m, { company: undefined })).rejects.toThrow(/company \(none\) doesn't exist/);
    await expect(save(m, { company: 'ACME' })).rejects.toThrow(/company ACME doesn't exist/);
    await expect(save(m, { netsuite_id: 'PYMT-309' })).rejects.toThrow(/needs NetSuite's id for the payment/);
    await expect(save(m, { applications: [] })).rejects.toThrow(/needs what it applies to/);
    await expect(save(m, { amount: '650.11' })).rejects.toThrow(/doesn't add up to its amount/);
    await expect(save(m, { method: 'cash' })).rejects.toThrow(/check/);
    await expect(save(m, { deposited_to: 'operating' })).rejects.toThrow(/check/);
    await expect(save(made({
      netsuiteId: '7109', amountCents: 200, applied: [{ invoiceId: '9001', number: 'INV2001', cents: 100 }, { invoiceId: '9001', number: 'INV2001', cents: 100 }],
    }))).rejects.toThrow(/unique|duplicate/i);
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_payments WHERE netsuite_id IN ('7109', 'PYMT-309')`)).rows[0]).toEqual({ n: 0 });
    expect((await pg.query(`SELECT count(*)::int AS n FROM gl_own_payment_applications WHERE payment_id = '7109'`)).rows[0]).toEqual({ n: 0 });
  });

  it('lets only the server login near it', async () => {
    for (const r of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${r}`);
      try {
        for (const table of ['received_payments', 'gl_own_payments', 'gl_own_payment_applications']) {
          await expect(pg.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
        }
        for (const fn of ['received_payment_claim', 'received_payment_let_go', 'received_payment_made', 'gl_own_payment_save']) {
          await expect(call(pg, fn, { id: PRESS(5) })).rejects.toThrow(/permission denied for function/);
        }
      } finally {
        await pg.exec('RESET ROLE; SET ROLE service_role');
      }
    }
    await pg.exec('RESET ROLE');
    const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('received_payments', 'gl_own_payments', 'gl_own_payment_applications') ORDER BY relname`);
    expect(rls.rows).toEqual([
      { relname: 'gl_own_payment_applications', relrowsecurity: true },
      { relname: 'gl_own_payments', relrowsecurity: true },
      { relname: 'received_payments', relrowsecurity: true },
    ]);
    await pg.exec('SET ROLE service_role');
  });
});
