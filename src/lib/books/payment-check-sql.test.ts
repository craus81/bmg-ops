// Migration 374 reads a month of NetSuite customer payments for the payment
// rule's check. This runs migration 314 (with stand-ins for the app tables it
// points at), migrations 359–364 and 374 in an in-memory Postgres (PGlite) as
// the app's server login, and holds what the read returns, then checks one
// month end to end with it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { ChartAccount } from './invoice-check';
import { checkPaymentMonth, type PaymentMonthData } from './payment-check';

// A fresh database with Supabase's API roles and default grants, the
// migrations run twice as the owner.
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
    -- What migration 314 points at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '364-books-invoice-check.sql',
    '374-books-payment-check.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'`);
  return pg;
}

// Made-up payments. September 2026: PMT201 (BMG, paying INV101 and an
// invoice not copied yet), PMT202 (1084), PMT203 (in neither company's GL
// copy). Left out: PMT204 (deleted), PMT205 (a payment out to a vendor),
// PMT206 (October), QB207 (from QuickBooks).
async function seed(pg: PGlite) {
  const payment = async (ref: string, number: string, date: string, fields: Record<string, unknown> = {}) => {
    const row = {
      source: 'netsuite', external_id: `CustPymt/${ref}`, external_ref: ref, direction: 'in', party_kind: 'customer',
      doc_number: number, payment_date: date, total: '162.00', party_name: 'A Customer', ...fields,
    };
    const cols = Object.keys(row);
    const res = await pg.query<{ id: string }>(
      `INSERT INTO ledger_payments (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return res.rows[0].id;
  };
  const gl = async (ref: string, number: string, company: string, posted: Array<[string, string, string, string]>) => {
    await pg.query(
      `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
       VALUES ($1, 'CustPymt', $2, '2026-09-10', '2026-09-01', 'x', 's')`,
      [ref, number],
    );
    for (const [lineId, account, debit, credit] of posted) {
      await pg.query(
        `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
         SELECT $1, $2, id, $3, '2026-09-01', '2026-09-10', $4, $5 FROM gl_companies WHERE code = $6`,
        [ref, lineId, account, debit, credit, company],
      );
    }
  };

  const invoice = await pg.query<{ id: string }>(
    `INSERT INTO ledger_invoices (source, external_id, external_ref, doc_type, doc_number, doc_date, total)
     VALUES ('netsuite', 'CustInvc/101', '101', 'invoice', 'INV101', '2026-09-01', '100.00') RETURNING id`,
  );

  const paid = await payment('201', 'PMT201', '2026-09-10');
  // Line ids out of text order, to show they come back in NetSuite's order.
  await gl('201', 'PMT201', 'BMG', [['10', '120', '0.00', '62.00'], ['0', '110', '162.00', '0.00'], ['2', '120', '0.00', '100.00']]);
  await pg.query(
    `INSERT INTO ledger_payment_applications (payment_id, applied_kind, applied_external_id, applied_invoice_id, amount) VALUES
       ($1, 'invoice', 'CustInvc/999', NULL, '62.00'),
       ($1, 'invoice', 'CustInvc/101', $2, '100.00')`,
    [paid, invoice.rows[0].id],
  );
  await payment('202', 'PMT202', '2026-09-11', { total: '100.00' });
  await gl('202', 'PMT202', '1084', [['0', '111', '100.00', '0.00'], ['1', '121', '0.00', '100.00']]);
  await payment('203', 'PMT203', '2026-09-20');
  await payment('204', 'PMT204', '2026-09-12', { deleted_at: '2026-09-13T00:00:00Z' });
  await payment('205', 'PMT205', '2026-09-12', { external_id: 'VendPymt/205', direction: 'out', party_kind: 'vendor' });
  await payment('206', 'PMT206', '2026-10-01');
  await payment('207', 'QB207', '2026-09-12', { source: 'quickbooks', external_id: 'Payment/207' });
}

describe('gl_payment_month (migration 374)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await seed(db);
    await db.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const month = async (company: string | null, day: string) =>
    (await db.query<{ r: PaymentMonthData }>('SELECT gl_payment_month($1, $2::date) AS r', [company, day])).rows[0].r;

  it('returns the company\'s NetSuite customer payments dated in the month, and those in neither company\'s GL copy', async () => {
    const bmg = await month('BMG', '2026-09-01');
    expect(bmg.payments.map((p) => [p.number, p.companies])).toEqual([['PMT201', ['BMG']], ['PMT203', []]]);
    expect((await month('1084', '2026-09-15')).payments.map((p) => p.number)).toEqual(['PMT202', 'PMT203']);
    expect((await month(null, '2026-09-30')).payments.map((p) => p.number)).toEqual(['PMT201', 'PMT202', 'PMT203']);
    expect((await month('BMG', '2026-08-01')).payments).toEqual([]);
  });

  it('gives each payment what it was applied to and NetSuite\'s GL lines in line order', async () => {
    const [p] = (await month('BMG', '2026-09-01')).payments;
    expect(p).toMatchObject({ netsuite_id: '201', date: '2026-09-10', total: '162.00', voided: false, customer: 'A Customer', customer_id: null });
    // An invoice not copied yet goes by NetSuite's reference.
    expect(p.applied).toEqual([
      { kind: 'invoice', number: 'CustInvc/999', amount: '62.00' },
      { kind: 'invoice', number: 'INV101', amount: '100.00' },
    ]);
    expect(p.netsuite).toEqual([
      { line_id: '0', account: '110', debit: '162.00', credit: '0.00' },
      { line_id: '2', account: '120', debit: '0.00', credit: '100.00' },
      { line_id: '10', account: '120', debit: '0.00', credit: '62.00' },
    ]);
    expect((await month('BMG', '2026-09-01')).payments[1]).toMatchObject({ number: 'PMT203', applied: [], netsuite: [] });
  });

  it('checks a month end to end', async () => {
    const chart: ChartAccount[] = [
      { netsuite_account_id: '120', number: '1200', name: 'Receivables', account_type: 'accounts_receivable', company: null, active: true, is_summary: false },
      { netsuite_account_id: '110', number: '1100', name: 'Undeposited Funds', account_type: 'other_current_asset', company: null, active: true, is_summary: false },
    ];
    const m = checkPaymentMonth(await month('BMG', '2026-09-01'), { company: 'BMG', chart });
    expect(m.summary).toEqual({ invoices: 1, matches: 1, differs: 0, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.invoices[0].rows.map((r) => [r.label, r.fleetsuite, r.netsuite])).toEqual([
      ['Deposited to', { account: '110', cents: 16200 }, { account: '110', cents: 16200 }],
      ['Receivable', { account: '120', cents: -16200 }, { account: '120', cents: -16200 }],
    ]);
    expect(m.notes).toHaveLength(1);
    expect(m.notes[0]).toMatch(/^1 more payment dated this month isn't in the copy of NetSuite's GL for either company: PMT203\./);
  });

  it('is the service role\'s alone', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      await expect(db.query(`SELECT gl_payment_month('BMG', '2026-09-01')`)).rejects.toThrow(/permission denied/);
    }
    await db.exec('RESET ROLE; SET ROLE service_role');
  });
});
