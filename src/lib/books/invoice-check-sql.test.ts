// Migration 364 reads a month of NetSuite invoices for the invoice rule's
// check. This runs migration 314 (with stand-ins for the app tables it points
// at) and migrations 359–364 in an in-memory Postgres (PGlite) as the app's
// server login, and holds what the read returns, then checks one month end
// to end with it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { checkMonth, type ChartAccount, type InvoiceMonthData } from './invoice-check';

// A fresh database with Supabase's API roles and default grants, migrations
// 314 and 359–364 run twice as the owner.
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
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'`);
  return pg;
}

// Made-up invoices. September 2026: INV101 (BMG), INV102 (1084), INV103 (in
// neither company's GL copy), INV108 (BMG, lines not copied yet). Left out:
// INV104 (deleted), CM105 (a credit memo), INV106 (October), QB107 (from
// QuickBooks).
async function seed(pg: PGlite) {
  const invoice = async (ref: string, number: string, date: string, fields: Record<string, unknown> = {}) => {
    const row = {
      source: 'netsuite', external_id: `CustInvc/${ref}`, external_ref: ref, doc_type: 'invoice', doc_number: number,
      doc_date: date, total: '162.00', lines_synced_at: '2026-10-01T00:00:00Z', party_name: 'A Customer', ...fields,
    };
    const cols = Object.keys(row);
    const res = await pg.query<{ id: string }>(
      `INSERT INTO ledger_invoices (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return res.rows[0].id;
  };
  const lines = async (documentId: string, rows: Array<[string, number, string, string | null, string | null, string, unknown]>) => {
    for (const [lineId, lineNo, kind, itemId, itemNumber, amount, netamount] of rows) {
      await pg.query(
        `INSERT INTO ledger_invoice_lines (document_id, line_external_id, line_no, line_kind, item_external_id, item_number, amount, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [documentId, lineId, lineNo, kind, itemId, itemNumber, amount, JSON.stringify(netamount === undefined ? {} : { netamount })],
      );
    }
  };
  const gl = async (ref: string, number: string, company: string, posted: Array<[string, string, string, string]>) => {
    await pg.query(
      `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
       VALUES ($1, 'CustInvc', $2, '2026-09-10', '2026-09-01', 'x', 's')`,
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

  const sale: Array<[string, number, string, string | null, string | null, string, unknown]> = [
    ['1', 1, 'item', '11', 'PART-A', '100.00', -100],
    ['10', 3, 'tax', '900', null, '12.00', '-12.00'],
    ['2', 2, 'item', '13', 'INSTALL LABOR', '50.00', -50],
  ];
  const posted: Array<[string, string, string, string]> = [
    ['10', '220', '0.00', '12.00'], ['0', '120', '162.00', '0.00'], ['2', '400', '0.00', '50.00'], ['1', '400', '0.00', '100.00'],
  ];

  await lines(await invoice('101', 'INV101', '2026-09-10'), sale);
  await gl('101', 'INV101', 'BMG', posted);
  await lines(await invoice('102', 'INV102', '2026-09-11'), [['1', 1, 'item', '12', 'RENT', '100.00', -100]]);
  await gl('102', 'INV102', '1084', [['0', '121', '100.00', '0.00'], ['1', '401', '0.00', '100.00']]);
  await lines(await invoice('103', 'INV103', '2026-09-20'), [['1', 1, 'item', '11', 'PART-A', '100.00', -100]]);
  await lines(await invoice('108', 'INV108', '2026-09-30', { lines_synced_at: null }), [['1', 1, 'item', '11', 'PART-A', '100.00', undefined]]);
  await lines(await invoice('104', 'INV104', '2026-09-12', { deleted_at: '2026-09-13T00:00:00Z' }), sale);
  await lines(await invoice('105', 'CM105', '2026-09-12', { external_id: 'CustCred/105', doc_type: 'credit_memo' }), sale);
  await lines(await invoice('106', 'INV106', '2026-10-01'), sale);
  await lines(await invoice('107', 'QB107', '2026-09-12', { source: 'quickbooks', external_id: 'Invoice/107' }), sale);

  await pg.query(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('item', '11', 'PART-A', true, '{"item_type": "InvtPart", "income_account": "400", "asset_account": "130"}'),
      ('item', '12', 'RENT', true, '{"item_type": "Service", "income_account": "401"}'),
      ('item', '13', 'INSTALL LABOR', true, '{"item_type": "Service", "income_account": "400"}'),
      ('item', '99', 'UNUSED', true, '{"item_type": "Service", "income_account": "400"}'),
      ('tax_code', '900', 'Some County', true, '{"rate": 7.5}')
  `);
}

describe('gl_invoice_month (migration 364)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await seed(db);
    await db.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const month = async (company: string | null, day: string) =>
    (await db.query<{ r: InvoiceMonthData }>('SELECT gl_invoice_month($1, $2::date) AS r', [company, day])).rows[0].r;

  it('returns the company\'s NetSuite invoices dated in the month, and those in neither company\'s GL copy', async () => {
    const bmg = await month('BMG', '2026-09-01');
    expect(bmg.invoices.map((i) => [i.number, i.companies, i.lines_copied])).toEqual([
      ['INV101', ['BMG'], true], ['INV103', [], true], ['INV108', [], false],
    ]);
    expect((await month('1084', '2026-09-15')).invoices.map((i) => i.number)).toEqual(['INV102', 'INV103', 'INV108']);
    expect((await month(null, '2026-09-30')).invoices.map((i) => i.number)).toEqual(['INV101', 'INV102', 'INV103', 'INV108']);
  });

  it('gives each invoice its lines in order with NetSuite\'s signed amount, and NetSuite\'s GL lines in line order', async () => {
    const [inv] = (await month('BMG', '2026-09-01')).invoices;
    expect(inv).toMatchObject({ netsuite_id: '101', date: '2026-09-10', total: '162.00', voided: false, customer: 'A Customer' });
    expect(inv.lines).toEqual([
      { line_id: '1', line_no: 1, kind: 'item', item_id: '11', item_number: 'PART-A', amount: '100.00', netamount: '-100' },
      { line_id: '2', line_no: 2, kind: 'item', item_id: '13', item_number: 'INSTALL LABOR', amount: '50.00', netamount: '-50' },
      { line_id: '10', line_no: 3, kind: 'tax', item_id: '900', item_number: null, amount: '12.00', netamount: '-12.00' },
    ]);
    expect(inv.netsuite).toEqual([
      { line_id: '0', account: '120', debit: '162.00', credit: '0.00' },
      { line_id: '1', account: '400', debit: '0.00', credit: '100.00' },
      { line_id: '2', account: '400', debit: '0.00', credit: '50.00' },
      { line_id: '10', account: '220', debit: '0.00', credit: '12.00' },
    ]);
    const notCopied = (await month('BMG', '2026-09-01')).invoices[2];
    expect(notCopied.lines.map((l) => l.netamount)).toEqual([null]);
  });

  it('brings the copied items and tax codes those invoices name, and no others', async () => {
    expect((await month('BMG', '2026-09-01')).items).toEqual([
      { kind: 'item', netsuite_id: '11', name: 'PART-A', active: true, gone: false, item_type: 'InvtPart', income_account: '400', asset_account: '130' },
      { kind: 'item', netsuite_id: '13', name: 'INSTALL LABOR', active: true, gone: false, item_type: 'Service', income_account: '400', asset_account: null },
      { kind: 'tax_code', netsuite_id: '900', name: 'Some County', active: true, gone: false, item_type: null, income_account: null, asset_account: null },
    ]);
  });

  it('checks a month end to end', async () => {
    const chart: ChartAccount[] = [
      { netsuite_account_id: '120', number: '1200', name: 'Receivables', account_type: 'accounts_receivable', company: null, active: true, is_summary: false },
      { netsuite_account_id: '400', number: '4000', name: 'Sales', account_type: 'income', company: null, active: true, is_summary: false },
      { netsuite_account_id: '220', number: '2200', name: 'Sales Tax', account_type: 'other_current_liability', company: null, active: true, is_summary: false },
    ];
    const m = checkMonth(await month('BMG', '2026-09-01'), { company: 'BMG', chart, taxAccounts: [{ tax_code_id: '900', account_id: '220', lines: 1 }] });
    expect(m.summary).toEqual({ invoices: 1, matches: 1, differs: 0, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.notes).toHaveLength(1);
    expect(m.notes[0]).toMatch(/^2 more invoices dated this month aren't in the copy of NetSuite's GL for either company: INV103, INV108\./);
  });

  it('is the service role\'s alone', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      await expect(db.query(`SELECT gl_invoice_month('BMG', '2026-09-01')`)).rejects.toThrow(/permission denied/);
    }
    await db.exec('RESET ROLE; SET ROLE service_role');
  });
});
