// Migration 384 keeps a copy of NetSuite's vendor bills and bill credits,
// with their lines, and reads a month of them for the bill rule's check;
// migration 385 says where NetSuite posts the bill lines of an item the copy
// of its items has no account for. This runs migrations 359–363, 384 and 385
// in an in-memory Postgres (PGlite) as the app's server login and holds the
// functions' rules, then runs the whole copy job against them with a fake
// NetSuite that answers the job's own SuiteQL, and checks a month end to end.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({
  isSuiteqlError: (err: unknown) => err instanceof Error && typeof (err as any).status === 'number',
  suiteqlQuery: vi.fn(),
  suiteqlQueryAll: vi.fn(),
}));
vi.mock('@/lib/system-health', () => ({
  recordHeartbeat: vi.fn(async (service: any, syncType: string, lastResult: unknown, opts?: { touchLastSyncedAt?: boolean; lastSyncedAt?: string }) => {
    const row: Record<string, unknown> = { sync_type: syncType, last_result: lastResult };
    if (opts?.lastSyncedAt) row.last_synced_at = opts.lastSyncedAt;
    else if (opts?.touchLastSyncedAt !== false) row.last_synced_at = new Date().toISOString();
    await service.from('sync_state').upsert(row);
    return { ok: true };
  }),
}));

import type { ChartAccount } from './invoice-check';
import { checkBillMonth, itemsWithoutAccount, type BillMonthData } from './bill-check';
import { BILL_IDS_QUERY, BOOKS_BILLS_SYNC, COPY_VERSION, copyNetSuiteBills } from './netsuite-bills';

// A fresh database with Supabase's API roles and default grants, migrations
// 359–363, 384 and 385 run twice as the owner, 1084 linked to subsidiary 5
// (as the account sync does).
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
  `);
  for (const file of [
    '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '384-books-vendor-bills.sql',
    '385-books-bill-item-accounts.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'`);
  return pg;
}

/** A NetSuite document in the GL copy, booked into `booked` (its own month by default), with its lines: [line id, account, debit, credit]. */
async function gl(
  pg: PGlite, id: string, type: string, number: string | null, date: string, company: string,
  lines: Array<[string, string, string, string]>, booked?: string,
) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4::date, coalesce($5::date, date_trunc('month', $4::date)::date), 'x', 's')`,
    [id, type, number, date, booked ?? null],
  );
  for (const [lineId, account, debit, credit] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, coalesce($8::date, date_trunc('month', $6::date)::date), $6::date, $4, $5 FROM gl_companies WHERE code = $7`,
      [id, lineId, account, debit, credit, date, company, booked ?? null],
    );
  }
}

/** A NetSuite list row (migration 363's copy). */
async function listed(pg: PGlite, kind: string, id: string, name: string, details: Record<string, string>) {
  await pg.query(
    `INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ($1, $2, $3, true, $4::jsonb)`,
    [kind, id, name, JSON.stringify(details)],
  );
}

type Line = {
  line_id: string; item: string | null; account: string | null; amount: string | null; own_amount?: string | null; quantity: string | null;
  memo: string | null; tax: boolean;
};
type Link = { netsuite_id: string; type: string | null; number: string | null; amount: string | null; link_type: string | null; lines?: string[] };
const line = (lineId: string, item: string | null, account: string | null, amount: string): Line => ({
  line_id: lineId, item, account, amount, quantity: null, memo: null, tax: false,
});
const link = (id: string, type: string, number: string | null, amount: string | null): Link => ({ netsuite_id: id, type, number, amount, link_type: null });
const doc = (id: string, type: 'VendBill' | 'VendCred', number: string | null, date: string, total: string, fields: Record<string, unknown> = {}) => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date, vendor_netsuite_id: '50', vendor_name: 'V-50 Sample Supply',
  total, status: null, status_label: null, voided: false, memo: null, lines: [] as Line[], links: [] as Link[], ...fields,
});

describe('the bills functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const apply = async (rows: unknown[]) =>
    (await db.query<{ r: { received: number; added: number; changed: number } }>('SELECT gl_netsuite_bills_apply($1::jsonb) AS r', [JSON.stringify({ rows })])).rows[0].r;
  const finish = async (ids: string[]) =>
    (await db.query<{ r: { listed: number; here: number; gone: number; cut_short: boolean } }>(
      'SELECT gl_netsuite_bills_finish($1::jsonb) AS r', [JSON.stringify({ netsuite_ids: ids })],
    )).rows[0].r;
  const stored = async (id: string) => (await db.query<{ total: string; status_label: string | null; lines: Line[] | null; links: Link[] | null; gone: boolean; changed_at: string }>(
    `SELECT total::text AS total, status_label, lines, links, gone_at IS NOT NULL AS gone, changed_at::text AS changed_at FROM gl_netsuite_bills WHERE netsuite_id = $1`,
    [id],
  )).rows[0];

  const B701 = [line('1', null, '530', '500.00'), line('2', '902', null, '150.00')];

  it('adds what NetSuite has, and changes nothing when it\'s the same again', async () => {
    const rows = [
      doc('701', 'VendBill', 'B-701', '2026-09-08', '650.00', { status_label: 'Open', lines: B701, links: [link('601', 'PurchOrd', 'PO601', '650.00')] }),
      doc('702', 'VendCred', 'VC-702', '2026-09-12', '120.00', { lines: [line('1', '902', null, '-120.00')] }),
    ];
    expect(await apply(rows)).toEqual({ received: 2, added: 2, changed: 0 });
    const before = await stored('701');
    expect(before).toMatchObject({ total: '650.00', status_label: 'Open', lines: B701, links: [link('601', 'PurchOrd', 'PO601', '650.00')], gone: false });
    expect(await apply(rows)).toEqual({ received: 2, added: 0, changed: 0 });
    expect((await stored('701')).changed_at).toBe(before.changed_at);
  });

  it('follows NetSuite\'s changes, and keeps the lines and links when a run couldn\'t read them', async () => {
    const changed = [line('1', null, '530', '520.00'), line('2', '902', null, '150.00')];
    expect(await apply([doc('701', 'VendBill', 'B-701', '2026-09-08', '670.00', { status_label: 'Paid In Full', lines: changed, links: [link('601', 'PurchOrd', 'PO601', '650.00')] })]))
      .toMatchObject({ added: 0, changed: 1 });
    const { lines, links, ...row } = doc('701', 'VendBill', 'B-701', '2026-09-08', '670.00', { status_label: 'Paid In Full' });
    expect([lines, links]).toEqual([[], []]);
    expect(await apply([row])).toMatchObject({ changed: 0 });
    // Something else changed in a run that couldn't read the lines or links: the row follows NetSuite and keeps them.
    expect(await apply([{ ...row, memo: 'Shop parts' }])).toMatchObject({ changed: 1 });
    expect(await stored('701')).toMatchObject({ status_label: 'Paid In Full', lines: changed, links: [link('601', 'PurchOrd', 'PO601', '650.00')] });
    // A document copied before its lines could ever be read has none yet, which isn't the same as none in NetSuite.
    const { lines: _l, links: _k, ...bare } = doc('703', 'VendBill', null, '2026-10-02', '50.00');
    await apply([bare]);
    expect(await stored('703')).toMatchObject({ lines: null, links: null });
  });

  it('marks what NetSuite no longer lists as gone, back when it lists it again, and nothing when the list looks cut short', async () => {
    expect(await finish(['701', '702'])).toEqual({ listed: 2, here: 3, gone: 1, cut_short: false });
    expect(await stored('703')).toMatchObject({ gone: true });
    const { lines: _l, links: _k, ...back } = doc('703', 'VendBill', null, '2026-10-02', '50.00');
    expect(await apply([back])).toMatchObject({ changed: 1 });
    expect(await stored('703')).toMatchObject({ gone: false });
    expect(await finish([])).toEqual({ listed: 0, here: 3, gone: 0, cut_short: true });
    expect(await finish(['701'])).toEqual({ listed: 1, here: 3, gone: 0, cut_short: true });
    expect((await stored('702')).gone).toBe(false);
  });

  it('refuses a bad page whole, changing nothing', async () => {
    const before = await stored('701');
    const good = doc('701', 'VendBill', 'B-701', '2026-09-08', '999.00');
    await expect(apply([good, { ...good, tranid: 'Twice' }])).rejects.toThrow(/NetSuite document 701 is in the page twice/);
    await expect(apply([good, { ...good, netsuite_id: 'x7' }])).rejects.toThrow(/NetSuite id "x7" isn't a number/);
    await expect(apply([good, { ...good, netsuite_id: '9', tran_type: 'PurchOrd' }])).rejects.toThrow(/document 9 isn't a bill or bill credit/);
    await expect(apply([good, { ...good, netsuite_id: '9', trandate: null }])).rejects.toThrow(/document 9 isn't a bill or bill credit/);
    await expect(apply([good, { ...good, netsuite_id: '9', total: '' }])).rejects.toThrow(/document 9 isn't a bill or bill credit/);
    await expect(apply([good, { ...good, netsuite_id: '9', lines: null }])).rejects.toThrow(/document 9 isn't a bill or bill credit/);
    await expect(apply([good, { ...good, netsuite_id: '9', links: { not: 'a list' } }])).rejects.toThrow(/document 9 isn't a bill or bill credit/);
    await expect(apply([good, { ...good, netsuite_id: '9', lines: [{ item: '902', amount: '5.00' }] }])).rejects.toThrow(/document 9 has a line without a line id/);
    await expect(apply([good, { ...good, netsuite_id: '9', lines: ['a line'] }])).rejects.toThrow(/document 9 has a line without a line id/);
    await expect(apply([good, { ...good, netsuite_id: '9', vendor_netsuite_id: 'V-50' }])).rejects.toThrow(/check constraint/);
    await expect(apply([good, { ...good, netsuite_id: '9', total: '-5.00' }])).rejects.toThrow(/check constraint/);
    await expect(db.query('SELECT gl_netsuite_bills_apply($1::jsonb)', [JSON.stringify({})])).rejects.toThrow(/rows must be a list/);
    await expect(db.query('SELECT gl_netsuite_bills_finish($1::jsonb)', [JSON.stringify({})])).rejects.toThrow(/netsuite_ids must be a list/);
    expect(await stored('701')).toEqual(before);
  });

  it('lets only the service role read the copy or run the functions, and the one write that changes rows says which', async () => {
    for (const fn of ['gl_netsuite_bills_apply(jsonb)', 'gl_netsuite_bills_finish(jsonb)', 'gl_bill_month(text, date)', 'gl_bill_item_accounts(text[])']) {
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(false);
      }
      const s = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn]);
      expect(s.rows[0].ok, fn).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      const t = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'gl_netsuite_bills', 'SELECT') AS ok`, [role]);
      expect(t.rows[0].ok, role).toBe(false);
    }
    const rls = await db.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'gl_netsuite_bills'`);
    expect(rls.rows[0].on).toBe(true);

    // Supabase's API connections fail an UPDATE or DELETE with no WHERE, even inside a function (migrations/README.md).
    const body = async (name: string) => (await db.query<{ b: string }>(`SELECT prosrc AS b FROM pg_proc WHERE proname = $1`, [name])).rows[0].b;
    expect(await body('gl_netsuite_bills_finish')).toMatch(/UPDATE public\.gl_netsuite_bills d SET gone_at = now\(\)\s+WHERE d\.gone_at IS NULL/);
    expect((await body('gl_netsuite_bills_finish')).match(/\b(UPDATE|DELETE)\b/g)).toEqual(['UPDATE']);
    // The apply's only write is an INSERT, whose ON CONFLICT ... DO UPDATE safeupdate leaves alone.
    expect((await body('gl_netsuite_bills_apply')).match(/\b(INSERT|UPDATE|DELETE)\b/g)).toEqual(['INSERT', 'UPDATE']);
    expect(await body('gl_netsuite_bills_apply')).toMatch(/ON CONFLICT \(netsuite_id\) DO UPDATE SET/);
    expect(await body('gl_bill_month')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(await body('gl_bill_item_accounts')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});

// Made-up books: '200' payables, '205' received not billed, '130' inventory,
// '530' subcontractors, '610' shop supplies and '480' vendor discounts (BMG);
// '210' and '615' 1084's.
const NAMES: Record<string, [string, string]> = {
  '200': ['2000 Accounts Payable', 'accounts_payable'], '205': ['2050 Received Not Billed', 'other_current_liability'],
  '130': ['1300 Inventory', 'other_current_asset'], '530': ['5300 Subcontractors', 'expense'], '610': ['6100 Shop Supplies', 'expense'],
  '480': ['4800 Vendor Discounts', 'other_income'], '210': ['2100 Accounts Payable', 'accounts_payable'], '615': ['6150 Building Repairs', 'expense'],
};
const CHART: ChartAccount[] = Object.entries(NAMES).map(([id, [label, type]]) => ({
  netsuite_account_id: id, number: label.split(' ')[0], name: label.split(' ').slice(1).join(' '), account_type: type,
  company: id === '210' ? '1084' : id === '200' ? 'BMG' : null, active: true, is_summary: false,
}));

describe('gl_bill_month (migration 384)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // September 2026: B-701 (BMG, from PO601 and its receipt, NetSuite's
    // lines signed the other way round from the GL), VC-702 (a bill credit),
    // B-703 dated in August but booked into September, B-704 (1084), B-705
    // (in neither company's GL copy), B-706 dated in September but booked
    // into October, B-708 (gone from NetSuite), and B-709 in BMG's GL copy
    // but not copied yet. Two item receipts of BMG's and one of 1084's, and
    // a customer payment, which credits receivables, not received stock.
    await gl(db, '701', 'VendBill', 'B-701', '2026-09-08', 'BMG',
      [['0', '200', '0.00', '650.00'], ['1', '530', '500.00', '0.00'], ['2', '610', '120.00', '0.00'], ['3', '205', '30.00', '0.00']]);
    // Line ids out of text order, to show they come back in NetSuite's order.
    await gl(db, '702', 'VendCred', 'VC-702', '2026-09-12', 'BMG', [['10', '610', '0.00', '120.00'], ['2', '200', '120.00', '0.00']]);
    await gl(db, '703', 'VendBill', 'B-703', '2026-08-30', 'BMG', [['0', '200', '0.00', '50.00'], ['1', '530', '50.00', '0.00']], '2026-09-01');
    await gl(db, '704', 'VendBill', 'B-704', '2026-09-15', '1084', [['0', '210', '0.00', '80.00'], ['1', '615', '80.00', '0.00']]);
    await gl(db, '706', 'VendBill', 'B-706', '2026-09-29', 'BMG', [['0', '200', '0.00', '10.00'], ['1', '530', '10.00', '0.00']], '2026-10-01');
    await gl(db, '708', 'VendBill', 'B-708', '2026-09-27', 'BMG', [['0', '200', '0.00', '60.00'], ['1', '530', '60.00', '0.00']]);
    await gl(db, '709', 'VendBill', 'B-709', '2026-09-28', 'BMG', [['0', '200', '0.00', '40.00'], ['1', '530', '40.00', '0.00']]);
    await gl(db, '611', 'ItemRcpt', 'IR611', '2026-09-02', 'BMG', [['1', '130', '30.00', '0.00'], ['2', '205', '0.00', '30.00']]);
    await gl(db, '612', 'ItemRcpt', 'IR612', '2025-04-02', 'BMG', [['1', '130', '75.00', '0.00'], ['2', '205', '0.00', '75.00']]);
    await gl(db, '613', 'ItemRcpt', 'IR613', '2026-09-03', '1084', [['1', '130', '5.00', '0.00'], ['2', '205', '0.00', '5.00']]);
    await gl(db, '614', 'CustPymt', 'PMT614', '2026-09-12', 'BMG', [['0', '110', '50.00', '0.00'], ['1', '120', '0.00', '50.00']]);
    await listed(db, 'vendor', '50', 'Sample Supply Co', { payables_account: '200' });
    await listed(db, 'item', '901', 'WIDGET-1', { item_type: 'InvtPart', asset_account: '130' });
    await listed(db, 'item', '902', 'SUPPLY-2', { item_type: 'NonInvtPart', expense_account: '610' });
    await listed(db, 'item', '903', 'NOT-USED', { item_type: 'Service', expense_account: '530' });
    // NetSuite numbers vendors and items apart, so a vendor can have an item's id.
    await listed(db, 'vendor', '901', 'Sample Widget Maker', { payables_account: '200' });
    await db.exec('SET ROLE service_role');
    await db.query('SELECT gl_netsuite_bills_apply($1::jsonb)', [JSON.stringify({ rows: [
      doc('701', 'VendBill', 'B-701', '2026-09-08', '650.00', {
        status_label: 'Open',
        lines: [line('1', null, '530', '-500.00'), line('2', '902', null, '-120.00'), line('3', '901', null, '-30.00')],
        links: [link('601', 'PurchOrd', 'PO601', '650.00'), link('611', 'ItemRcpt', 'IR611', '30.00')],
      }),
      doc('702', 'VendCred', 'VC-702', '2026-09-12', '120.00', { lines: [line('1', '902', null, '120.00')] }),
      doc('703', 'VendBill', 'B-703', '2026-08-30', '50.00', { lines: [line('1', null, '530', '-50.00')] }),
      doc('704', 'VendBill', 'B-704', '2026-09-15', '80.00', { vendor_netsuite_id: '51', vendor_name: 'V-51 Roof Co', lines: [line('1', null, '615', '-80.00')] }),
      doc('705', 'VendBill', 'B-705', '2026-09-25', '75.00', { lines: [line('1', null, '530', '-75.00')] }),
      doc('706', 'VendBill', 'B-706', '2026-09-29', '10.00', { lines: [line('1', null, '530', '-10.00')] }),
      doc('708', 'VendBill', 'B-708', '2026-09-27', '60.00', { lines: [line('1', null, '530', '-60.00')] }),
    ] })]);
    await db.query('SELECT gl_netsuite_bills_finish($1::jsonb)', [JSON.stringify({ netsuite_ids: ['701', '702', '703', '704', '705', '706'] })]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const month = async (company: string | null, day: string) =>
    (await db.query<{ r: BillMonthData }>('SELECT gl_bill_month($1, $2::date) AS r', [company, day])).rows[0].r;

  it('returns the company\'s bills and bill credits NetSuite booked into the month, and those in neither company\'s GL copy', async () => {
    const bmg = await month('BMG', '2026-09-01');
    expect(bmg.bills.map((b) => [b.number, b.type, b.date, b.posting_month, b.companies])).toEqual([
      ['B-703', 'VendBill', '2026-08-30', '2026-09-01', ['BMG']],
      ['B-701', 'VendBill', '2026-09-08', '2026-09-01', ['BMG']],
      ['VC-702', 'VendCred', '2026-09-12', '2026-09-01', ['BMG']],
      ['B-705', 'VendBill', '2026-09-25', null, []],
    ]);
    expect((await month('1084', '2026-09-15')).bills.map((b) => b.number)).toEqual(['B-704', 'B-705']);
    expect((await month(null, '2026-09-30')).bills.map((b) => b.number)).toEqual(['B-703', 'B-701', 'VC-702', 'B-704', 'B-705']);
    expect((await month('BMG', '2026-10-01')).bills.map((b) => b.number)).toEqual(['B-706']);
    expect((await month('BMG', '2026-08-01')).bills).toEqual([]);
  });

  it('gives each its lines, links, vendor and NetSuite\'s GL lines in line order', async () => {
    const [, b701, vc702] = (await month('BMG', '2026-09-01')).bills;
    expect(b701).toMatchObject({
      netsuite_id: '701', total: '650.00', voided: false, status: 'Open', vendor: 'Sample Supply Co', vendor_netsuite_id: '50', vendor_payables: '200',
      lines: [line('1', null, '530', '-500.00'), line('2', '902', null, '-120.00'), line('3', '901', null, '-30.00')],
      links: [link('601', 'PurchOrd', 'PO601', '650.00'), link('611', 'ItemRcpt', 'IR611', '30.00')],
    });
    expect(vc702.netsuite).toEqual([
      { line_id: '2', account: '200', debit: '120.00', credit: '0.00' },
      { line_id: '10', account: '610', debit: '0.00', credit: '120.00' },
    ]);
    // A vendor the copy of NetSuite's vendors doesn't have is named as the document names it.
    expect((await month('1084', '2026-09-01')).bills[0]).toMatchObject({ vendor: 'V-51 Roof Co', vendor_payables: null });
  });

  it('names the items the lines use, counts the accounts the company\'s receipts credit, and names what isn\'t copied yet', async () => {
    const bmg = await month('BMG', '2026-09-01');
    expect(bmg.items).toEqual([
      { netsuite_id: '901', name: 'WIDGET-1', active: true, gone: false, item_type: 'InvtPart', asset_account: '130', expense_account: null, income_account: null },
      { netsuite_id: '902', name: 'SUPPLY-2', active: true, gone: false, item_type: 'NonInvtPart', asset_account: null, expense_account: '610', income_account: null },
    ]);
    // Both of BMG's receipts, whenever they were, and not what they debit; 1084's only its own.
    expect(bmg.receipt_accounts).toEqual([{ account: '205', documents: 2 }]);
    expect((await month('1084', '2026-09-01')).receipt_accounts).toEqual([{ account: '205', documents: 1 }]);
    expect(bmg.not_copied).toEqual([{ netsuite_id: '708', type: 'VendBill', number: 'B-708' }, { netsuite_id: '709', type: 'VendBill', number: 'B-709' }]);
    expect((await month('1084', '2026-09-01')).not_copied).toEqual([]);
  });

  it('checks a month end to end', async () => {
    const m = checkBillMonth(await month('BMG', '2026-09-01'), { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 3, matches: 3, differs: 0, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.invoices.map((b) => [b.number, b.status, b.from, b.booked])).toEqual([
      ['B-703', 'matches', [], { month: '2026-09-01', date: '2026-09-01' }],
      ['B-701', 'matches', ['PO601', 'IR611'], undefined],
      ['VC-702', 'matches', [], undefined],
    ]);
    expect(m.invoices[1].rows.map((r) => [r.label, r.fleetsuite?.account, r.same])).toEqual([
      ['Payables', '200', true], ['Expense', '530', true], ['Items', '610', true], ['Received stock', '205', true],
    ]);
    expect(m.notes).toEqual([
      '1 bill or bill credit dated in another month is here because NetSuite booked it into this month: B-703.',
      "1 more bill or bill credit dated this month isn't in the copy of NetSuite's GL for either company: B-705. NetSuite may not have "
        + "posted it (a bill waiting for approval doesn't post), or the copy, which runs every two hours, hasn't reached it yet.",
      "The copy of NetSuite's GL has 2 bills and bill credits of this company's booked into this month that the copy of the bills "
        + "doesn't: B-708, B-709. The bills copy runs every two hours and may not have reached them yet, or NetSuite deleted them and the "
        + "GL copy hasn't caught up.",
    ]);
    const other = checkBillMonth(await month('1084', '2026-09-01'), { company: '1084', chart: CHART });
    expect(other.invoices.map((b) => [b.number, b.status, b.rows.map((r) => [r.label, r.fleetsuite?.account, r.same])])).toEqual([
      ['B-704', 'matches', [['Payables', '210', true], ['Expense', '615', true]]],
    ]);
  });
});

describe('a discount and a line added on a purchase order\'s bill (migration 385)', () => {
  let db: PGlite;
  const own = (l: Line, amount: string): Line => ({ ...l, own_amount: amount });
  beforeAll(async () => {
    db = await freshDb();
    // September 2026: B-720, $100.00 of stock from PO621 less 8% (a subtotal,
    // then the discount, which the copy of NetSuite's items has no account
    // for), and B-721, $300.00 of stock from PO622's line with $30.00 more
    // added on the bill itself. B-722 (July) and B-724 (June) take the same
    // discount, and B-723, gone from NetSuite, put it somewhere else.
    await gl(db, '720', 'VendBill', 'B-720', '2026-09-10', 'BMG', [['0', '200', '0.00', '92.00'], ['1', '205', '100.00', '0.00'], ['3', '480', '0.00', '8.00']]);
    await gl(db, '721', 'VendBill', 'B-721', '2026-09-14', 'BMG', [['0', '200', '0.00', '330.00'], ['1', '205', '300.00', '0.00'], ['2', '130', '30.00', '0.00']]);
    await gl(db, '722', 'VendBill', 'B-722', '2026-07-02', 'BMG', [['0', '200', '0.00', '46.00'], ['1', '610', '50.00', '0.00'], ['2', '480', '0.00', '4.00']]);
    await gl(db, '723', 'VendBill', 'B-723', '2026-07-09', 'BMG', [['0', '200', '0.00', '9.00'], ['1', '530', '10.00', '0.00'], ['2', '615', '0.00', '1.00']]);
    await gl(db, '724', 'VendBill', 'B-724', '2026-06-04', 'BMG', [['0', '200', '0.00', '19.00'], ['1', '530', '20.00', '0.00'], ['2', '530', '0.00', '1.00']]);
    await gl(db, '631', 'ItemRcpt', 'IR631', '2026-09-02', 'BMG', [['1', '130', '100.00', '0.00'], ['2', '205', '0.00', '100.00']]);
    await listed(db, 'vendor', '50', 'Sample Supply Co', { payables_account: '200' });
    await listed(db, 'item', '901', 'WIDGET-1', { item_type: 'InvtPart', asset_account: '130' });
    await listed(db, 'item', '902', 'SUPPLY-2', { item_type: 'NonInvtPart', expense_account: '610' });
    await listed(db, 'item', '904', 'DISC-8', { item_type: 'Discount' });
    await db.exec('SET ROLE service_role');
    await db.query('SELECT gl_netsuite_bills_apply($1::jsonb)', [JSON.stringify({ rows: [
      doc('720', 'VendBill', 'B-720', '2026-09-10', '92.00', {
        lines: [own(line('1', '901', null, '-92.00'), '-100.00'), own(line('2', '-2', null, '-100.00'), '-100.00'), own(line('3', '904', null, '0.00'), '8.00')],
        links: [{ ...link('621', 'PurchOrd', 'PO621', '100.00'), lines: ['1'] }],
      }),
      doc('721', 'VendBill', 'B-721', '2026-09-14', '330.00', {
        lines: [own(line('1', '901', null, '-300.00'), '-300.00'), own(line('2', '901', null, '-30.00'), '-30.00')],
        links: [{ ...link('622', 'PurchOrd', 'PO622', '300.00'), lines: ['1'] }],
      }),
      doc('722', 'VendBill', 'B-722', '2026-07-02', '46.00', { lines: [own(line('1', '902', null, '-46.00'), '-50.00'), own(line('2', '904', null, '0.00'), '4.00')] }),
      doc('723', 'VendBill', 'B-723', '2026-07-09', '9.00', { lines: [own(line('1', null, '530', '-9.00'), '-10.00'), own(line('2', '904', null, '0.00'), '1.00')] }),
      doc('724', 'VendBill', 'B-724', '2026-06-04', '19.00', { lines: [own(line('1', null, '530', '-19.00'), '-20.00'), own(line('2', '904', null, '0.00'), '1.00')] }),
    ] })]);
    await db.query('SELECT gl_netsuite_bills_finish($1::jsonb)', [JSON.stringify({ netsuite_ids: ['720', '721', '722', '724'] })]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const itemAccounts = async (items: string[] | null) =>
    (await db.query<{ r: NonNullable<BillMonthData['item_accounts']> }>('SELECT gl_bill_item_accounts($1::text[]) AS r', [items])).rows[0].r;

  it('says where NetSuite posted the bill lines of the items asked about, most used first, leaving out what NetSuite deleted', async () => {
    expect(await itemAccounts(['904', '902', '999'])).toEqual([
      { item: '902', account: '610', lines: 1 },
      { item: '904', account: '480', lines: 2 },
      { item: '904', account: '530', lines: 1 },
    ]);
    expect(await itemAccounts([])).toEqual([]);
    expect(await itemAccounts(null)).toEqual([]);
  });

  it('checks the month end to end, as the page does', async () => {
    const data = (await db.query<{ r: BillMonthData }>('SELECT gl_bill_month($1, $2::date) AS r', ['BMG', '2026-09-01'])).rows[0].r;
    expect(itemsWithoutAccount(data.items)).toEqual(['904']);
    const m = checkBillMonth({ ...data, item_accounts: await itemAccounts(itemsWithoutAccount(data.items)) }, { company: 'BMG', chart: CHART });
    expect(m.summary).toMatchObject({ invoices: 2, matches: 2, differs: 0, unworkable: 0 });
    const [b720, b721] = m.invoices;
    expect([b720.amounts, b721.amounts]).toEqual(['own', undefined]);
    expect(b720.lines.map((l) => [l.label, l.cents])).toEqual([['WIDGET-1', 10000], ['Subtotal', 10000], ['DISC-8', -800]]);
    expect(b720.rows.map((r) => [r.label, r.fleetsuite?.account, r.fleetsuite?.cents, r.same])).toEqual([
      ['Payables', '200', -9200, true], ['Received stock', '205', 10000, true], ['Items', '480', -800, true],
    ]);
    expect(b721.rows.map((r) => [r.label, r.fleetsuite?.account, r.fleetsuite?.cents, r.same])).toEqual([
      ['Payables', '200', -33000, true], ['Received stock', '205', 30000, true], ['Inventory', '130', 3000, true],
    ]);
  });
});

// ── The copy job ───────────────────────────────────────────────────────────

interface NsDoc {
  id: number;
  type: 'VendBill' | 'VendCred';
  tranid: string | null;
  /** As SuiteQL gives it, M/D/YYYY. */
  trandate: string;
  total: number;
  status?: string;
  label?: string;
  vendor?: number | null;
  /** lastmodifieddate, YYYY-MM-DD. */
  modified: string;
}

interface NsLine {
  bill: number;
  /** Null for a line NetSuite sends without its id. */
  id: number | null;
  item?: number | null;
  account?: number | null;
  amount: number | string;
  /** Its own amount (foreignamount): the amount's when left out; null for one NetSuite leaves out. */
  own?: number | string | null;
  quantity?: number | null;
  memo?: string | null;
  tax?: boolean;
}

const rejected = (detail: string) => Object.assign(
  new Error(`NetSuite SuiteQL error (400): {"o:errorDetails":[{"detail":"Invalid search query. Detailed unprocessed description follows. ${detail}"}]}`),
  { status: 400 },
);

class FakeNetSuite {
  docs: NsDoc[] = [];
  lines: NsLine[] = [];
  /** Documents the bills come from: purchase orders and receipts. */
  others: Array<{ id: number; type: string; tranid: string | null }> = [];
  links: Array<{ previousdoc: number; nextdoc: number; nextline?: number | null; foreignamount: number | string | null; linktype: string | null }> = [];
  /** Columns, records and link tables this account refuses. */
  refuse = new Set<string>();
  /** The ids NetSuite lists when asked for all of them; every document's when null. */
  ids: number[] | null = null;
  down = false;
  /** Called on every header page, so tests can move the clock. */
  onPage = () => {};
  headerPages = 0;

  page = async (q: string, limit: number): Promise<Record<string, unknown>[]> => {
    if (this.down) throw Object.assign(new Error('NetSuite SuiteQL error (503): unavailable'), { status: 503 });
    const withLabels = q.includes('BUILTIN.DF');
    if (withLabels && this.refuse.has('BUILTIN.DF')) throw rejected("Search error occurred: Field 'BUILTIN.DF' is not valid.");
    this.headerPages++;
    this.onPage();
    const [, m, d, y] = /TO_DATE\('(\d+)\/(\d+)\/(\d+)'/.exec(q)!;
    const since = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const before = Number(/t\.id < (\d+)/.exec(q)?.[1] ?? Infinity);
    return this.docs
      .filter((x) => x.modified >= since && x.id < before)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((x) => ({
        id: x.id, type: x.type, tranid: x.tranid, trandate: x.trandate, status: x.status ?? null, memo: null, total: x.total,
        vendor_id: x.vendor ?? null,
        ...(withLabels ? { status_label: x.label ?? null, vendor_name: x.vendor ? `V-${x.vendor} Vendor Co` : null } : {}),
      }));
  };

  query = async (q: string): Promise<Record<string, unknown>[]> => {
    if (this.down) throw Object.assign(new Error('NetSuite SuiteQL error (503): unavailable'), { status: 503 });
    const ids = (/IN \(([\d, ]+)\)/.exec(q)?.[1] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    const table = /FROM (nexttransactionlinelink|previoustransactionlinelink)/.exec(q)?.[1];
    if (table) {
      if (this.refuse.has(table)) throw rejected(`Search error occurred: Record '${table}' was not found.`);
      const withLines = q.includes('nextline');
      if (withLines && this.refuse.has('nextline')) throw rejected(`Search error occurred: Field 'nextline' for record '${table}' was not found.`);
      return this.links.filter((l) => ids.includes(l.nextdoc)).map(({ nextline, ...l }) => (withLines ? { ...l, nextline: nextline ?? null } : l));
    }
    if (q.includes('FROM transactionline tl')) {
      if (this.refuse.has('transactionline')) throw rejected("Search error occurred: Record 'transactionLine' was not found.");
      const withAccount = q.includes('tl.expenseaccount');
      if (withAccount && this.refuse.has('expenseaccount')) throw rejected("Search error occurred: Field 'expenseaccount' for record 'transactionLine' was not found.");
      const own = q.includes('tl.foreignamount AS own_amount');
      return this.lines
        .filter((l) => ids.includes(l.bill))
        .sort((a, b) => a.bill - b.bill || (a.id ?? 0) - (b.id ?? 0))
        .map((l) => ({
          bill_id: l.bill, line_id: l.id, item: l.item ?? null, amount: l.amount, quantity: l.quantity ?? null, memo: l.memo ?? null,
          taxline: l.tax ? 'T' : 'F', ...(withAccount ? { account: l.account ?? null } : {}),
          // SuiteQL leaves a null column out of the row.
          ...(own && l.own !== null ? { own_amount: l.own ?? l.amount } : {}),
        }));
    }
    if (q.includes('SELECT t.id, t.type, t.tranid')) {
      return [...this.docs, ...this.others].filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, type: x.type, tranid: x.tranid }));
    }
    if (q === BILL_IDS_QUERY) return (this.ids ?? this.docs.map((x) => x.id)).sort((a, b) => a - b).map((id) => ({ id }));
    throw new Error(`unexpected query: ${q}`);
  };
}

function netsuite(): FakeNetSuite {
  const ns = new FakeNetSuite();
  ns.docs = [
    { id: 701, type: 'VendBill', tranid: 'B-701', trandate: '9/8/2026', total: -650, status: 'A', label: 'Open', vendor: 50, modified: '2026-09-20' },
    { id: 702, type: 'VendCred', tranid: 'VC-702', trandate: '9/12/2026', total: 120, status: 'A', label: 'Open', vendor: 50, modified: '2026-09-12' },
    { id: 703, type: 'VendBill', tranid: 'B-703', trandate: '9/15/2026', total: -80, status: 'B', label: 'Paid In Full', vendor: 51, modified: '2026-09-15' },
    { id: 704, type: 'VendBill', tranid: 'B-704', trandate: '9/20/2026', total: 0, status: 'V', label: 'Voided', vendor: 50, modified: '2026-09-20' },
    { id: 705, type: 'VendBill', tranid: null, trandate: '10/2/2026', total: -200, vendor: null, modified: '2026-10-02' },
  ];
  ns.lines = [
    { bill: 701, id: 1, account: 530, amount: '-500.00', memo: 'Labor' },
    { bill: 701, id: 3, item: 901, amount: -30, quantity: -1 },
    { bill: 701, id: 2, item: 902, amount: -120, quantity: -4 },
    { bill: 702, id: 1, item: 902, amount: 120, quantity: 4 },
    { bill: 703, id: 1, account: 615, amount: -80 },
    { bill: 705, id: 1, account: 530, amount: -200 },
  ];
  ns.others = [{ id: 601, type: 'PurchOrd', tranid: 'PO601' }, { id: 611, type: 'ItemRcpt', tranid: 'IR611' }];
  ns.links = [
    // NetSuite lists the bill's purchase order line by line.
    { previousdoc: 601, nextdoc: 701, nextline: 1, foreignamount: '-500.00', linktype: 'Bill' },
    { previousdoc: 601, nextdoc: 701, nextline: 3, foreignamount: '-30.00', linktype: 'Bill' },
    { previousdoc: 601, nextdoc: 701, nextline: 2, foreignamount: '-120.00', linktype: 'Bill' },
    { previousdoc: 611, nextdoc: 701, nextline: 3, foreignamount: 30, linktype: 'Receipt/Bill' },
  ];
  return ns;
}

describe('the copy job against the real functions', () => {
  let pg: PGlite;
  let clock = Date.parse('2026-10-16T13:39:00Z');
  const store = new Map<string, any>();

  beforeAll(async () => {
    pg = await freshDb();
    await pg.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  // sync_state in memory; every function the real one, called the way
  // supabase-js calls them: by name, with named arguments.
  const service = () => ({
    from: (table: string) => {
      if (table !== 'sync_state') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_col: string, key: string) => ({
            maybeSingle: async () => ({
              data: store.has(key) ? { last_result: store.get(key).last_result, last_synced_at: store.get(key).last_synced_at ?? null } : null,
              error: null,
            }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          store.set(row.sync_type as string, JSON.parse(JSON.stringify({ ...store.get(row.sync_type as string), ...row })));
          return { error: null };
        },
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const names = Object.keys(args);
      try {
        const r = await pg.query<{ r: unknown }>(
          `SELECT ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`,
          names.map((n) => JSON.stringify(args[n])),
        );
        return { data: r.rows[0].r, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
  }) as any;

  const run = (ns: FakeNetSuite, opts: { pageSize?: number; budgetMs?: number } = {}) => copyNetSuiteBills(service(), {
    deadline: clock + (opts.budgetMs ?? 240_000),
    deps: { query: ns.query, page: ns.page, pageSize: opts.pageSize ?? 2, now: () => clock },
  });
  const copied = async () => (await pg.query<{
    id: string; type: string; number: string | null; date: string; total: string; voided: boolean; label: string | null; vendor: string | null;
    vendor_id: string | null; lines: Line[] | null; links: Link[] | null; gone: boolean;
  }>(
    `SELECT netsuite_id AS id, tran_type AS type, tranid AS number, to_char(trandate, 'YYYY-MM-DD') AS date, total::text AS total, voided,
            status_label AS label, vendor_name AS vendor, vendor_netsuite_id AS vendor_id, lines, links, gone_at IS NOT NULL AS gone
     FROM gl_netsuite_bills ORDER BY netsuite_id::int`,
  )).rows;
  const recorded = () => store.get(BOOKS_BILLS_SYNC);
  const B701_LINES: Line[] = [
    { line_id: '1', item: null, account: '530', amount: '-500.00', own_amount: '-500.00', quantity: null, memo: 'Labor', tax: false },
    { line_id: '2', item: '902', account: null, amount: '-120.00', own_amount: '-120.00', quantity: '-4', memo: null, tax: false },
    { line_id: '3', item: '901', account: null, amount: '-30.00', own_amount: '-30.00', quantity: '-1', memo: null, tax: false },
  ];
  const B701_LINKS: Link[] = [
    { netsuite_id: '601', type: 'PurchOrd', number: 'PO601', amount: '650.00', link_type: 'Bill', lines: ['1', '2', '3'] },
    { netsuite_id: '611', type: 'ItemRcpt', number: 'IR611', amount: '30.00', link_type: 'Receipt/Bill', lines: ['3'] },
  ];

  it('copies every bill and bill credit, newest first a page at a time, with its lines and what it came from', async () => {
    const ns = netsuite();
    const r = await run(ns);
    expect(r).toMatchObject({ read: 5, added: 5, changed: 0, gone: 0, linkTable: 'nexttransactionlinelink' });
    expect(r.error).toBeUndefined();
    expect(r.partial).toBeUndefined();
    expect(ns.headerPages).toBe(3);
    expect(await copied()).toEqual([
      { id: '701', type: 'VendBill', number: 'B-701', date: '2026-09-08', total: '650.00', voided: false, label: 'Open', vendor: 'V-50 Vendor Co', vendor_id: '50', gone: false,
        lines: B701_LINES, links: B701_LINKS },
      { id: '702', type: 'VendCred', number: 'VC-702', date: '2026-09-12', total: '120.00', voided: false, label: 'Open', vendor: 'V-50 Vendor Co', vendor_id: '50', gone: false,
        lines: [{ line_id: '1', item: '902', account: null, amount: '120.00', own_amount: '120.00', quantity: '4', memo: null, tax: false }], links: [] },
      { id: '703', type: 'VendBill', number: 'B-703', date: '2026-09-15', total: '80.00', voided: false, label: 'Paid In Full', vendor: 'V-51 Vendor Co', vendor_id: '51', gone: false,
        lines: [{ line_id: '1', item: null, account: '615', amount: '-80.00', own_amount: '-80.00', quantity: null, memo: null, tax: false }], links: [] },
      // A voided bill NetSuite gives no lines for has none.
      { id: '704', type: 'VendBill', number: 'B-704', date: '2026-09-20', total: '0.00', voided: true, label: 'Voided', vendor: 'V-50 Vendor Co', vendor_id: '50', gone: false,
        lines: [], links: [] },
      { id: '705', type: 'VendBill', number: null, date: '2026-10-02', total: '200.00', voided: false, label: null, vendor: null, vendor_id: null, gone: false,
        lines: [{ line_id: '1', item: null, account: '530', amount: '-200.00', own_amount: '-200.00', quantity: null, memo: null, tax: false }], links: [] },
    ]);
    // The window closed at the time it was opened, and the record holds counts and words, never an amount.
    const record = recorded();
    expect(record.last_synced_at).toBe(new Date(clock).toISOString());
    expect(record.last_result).toEqual({ read: 5, added: 5, changed: 0, gone: 0, linkTable: 'nexttransactionlinelink', version: COPY_VERSION });
  });

  it('reads only what NetSuite changed since the last run, a day\'s overlap included', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs[2] = { ...ns.docs[2], total: -85, modified: '2026-10-16' };
    ns.lines[4] = { ...ns.lines[4], amount: -85 };
    const r = await run(ns);
    expect(r).toMatchObject({ read: 1, added: 0, changed: 1, gone: 0 });
    expect((await copied()).find((d) => d.id === '703')).toMatchObject({ total: '85.00', lines: [{ line_id: '1', amount: '-85.00' }] });
  });

  it('starts over from the first bill when the copy was made before what it keeps changed, so every document gets it', async () => {
    clock += 2 * 3600_000;
    // The first version's record: no version, its window closed two hours ago, and a run of it cut short below B-702.
    store.set(BOOKS_BILLS_SYNC, {
      sync_type: BOOKS_BILLS_SYNC,
      last_synced_at: new Date(clock - 2 * 3600_000).toISOString(),
      last_result: { read: 1, resume: { windowStartedAt: new Date(clock - 3600_000).toISOString(), since: '2026-10-15T13:39:00.000Z', beforeId: '702', processed: 1 } },
    });
    const ns = netsuite();
    ns.lines[0] = { ...ns.lines[0], own: '-520.00', amount: '-500.00' };
    const r = await run(ns);
    // Every document, though none changed since the last window: the old run's place and window don't count.
    expect(r).toMatchObject({ read: 5 });
    expect(recorded().last_result).toMatchObject({ version: COPY_VERSION });
    expect(recorded().last_result.resume).toBeUndefined();
    expect((await copied()).find((d) => d.id === '701')?.lines?.[0]).toMatchObject({ amount: '-500.00', own_amount: '-520.00' });

    // Then only what changed, as before.
    clock += 2 * 3600_000;
    expect(await run(netsuite())).toMatchObject({ read: 0 });
  });

  it('carries on where a run cut short by time stopped, and closes the window only when it drains', async () => {
    store.delete(BOOKS_BILLS_SYNC);
    const ns = netsuite();
    // Each page takes 25 s: with 50 s, the first run reads two pages.
    const saved: Array<string | null> = [];
    ns.onPage = () => {
      clock += 25_000;
      saved.push(recorded()?.last_result?.resume?.beforeId ?? null);
    };
    const opened = clock;
    const first = await run(ns, { budgetMs: 50_000 });
    expect(first).toMatchObject({ read: 4, partial: true });
    // Its place was saved after the first page, before the second was read, should the run be killed.
    expect(saved).toEqual([null, '704']);
    expect(recorded().last_result.resume).toEqual({ windowStartedAt: new Date(opened).toISOString(), since: '1999-12-31T00:00:00.000Z', beforeId: '702', processed: 4 });
    expect(recorded().last_synced_at).toBeUndefined();

    const second = await run(ns, { budgetMs: 240_000 });
    expect(second).toMatchObject({ read: 1, gone: 0 });
    expect(second.partial).toBeUndefined();
    expect(recorded().last_result.resume).toBeUndefined();
    expect(recorded().last_synced_at).toBe(new Date(opened).toISOString());
  });

  it('marks what NetSuite deleted as gone, and nothing when its list of ids looks cut short', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 704);
    expect(await run(ns)).toMatchObject({ gone: 1 });
    expect((await copied()).find((d) => d.id === '704')?.gone).toBe(true);

    clock += 2 * 3600_000;
    ns.ids = [701];
    const r = await run(ns);
    expect(r).toMatchObject({ gone: 0 });
    expect(r.notes).toEqual(['NetSuite listed 1 bills and bill credits and FleetSuite has 4, so none were marked gone.']);
    expect((await copied()).filter((d) => !d.gone).map((d) => d.id)).toEqual(['701', '702', '703', '705']);
  });

  it('copies the lines without their accounts when NetSuite won\'t give those, and keeps them when it won\'t give lines at all', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    // NetSuite deleted B-704 in the test before; it stays deleted.
    ns.docs = ns.docs.filter((d) => d.id !== 704).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.refuse.add('expenseaccount');
    const r = await run(ns);
    expect(r.notes).toEqual(["NetSuite wouldn't say which account each expense line goes to, so bills with expense lines can't be worked out this time."]);
    expect((await copied()).find((d) => d.id === '701')?.lines?.map((l) => l.account)).toEqual([null, null, null]);

    clock += 2 * 3600_000;
    ns.refuse.delete('expenseaccount');
    ns.refuse.add('transactionline');
    // B-703 changed in NetSuite too, so its row is rewritten in a run that can't read lines.
    ns.docs = ns.docs.map((d) => (d.id === 703 ? { ...d, total: -90 } : d));
    const none = await run(ns);
    expect(none).toMatchObject({ read: 4, changed: 1 });
    expect(none.notes).toEqual([
      "NetSuite wouldn't give the documents' lines (NetSuite SuiteQL error (400): Invalid search query. Detailed unprocessed description "
        + "follows. Search error occurred: Record 'transactionLine' was not found.), so they aren't copied this time; the ones already "
        + 'copied keep theirs.',
    ]);
    expect((await copied()).find((d) => d.id === '703')).toMatchObject({ total: '90.00', lines: [{ line_id: '1', account: null, amount: '-80.00' }] });

    // With the accounts back, the documents with expense lines get them back; the bill credit's one item line never had one.
    clock += 2 * 3600_000;
    ns.refuse.delete('transactionline');
    expect(await run(ns)).toMatchObject({ read: 4, changed: 3 });
    expect((await copied()).find((d) => d.id === '701')?.lines).toEqual(B701_LINES);
  });

  it('reads the links from the other table when NetSuite refuses one, and keeps them when it refuses both', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 704).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.lines[4] = { ...ns.lines[4], amount: -90 };
    ns.docs = ns.docs.map((d) => (d.id === 703 ? { ...d, total: -90 } : d));
    ns.refuse.add('nexttransactionlinelink');
    const r = await run(ns);
    expect(r).toMatchObject({ read: 4, linkTable: 'previoustransactionlinelink', changed: 1 });

    clock += 2 * 3600_000;
    ns.refuse.add('previoustransactionlinelink');
    ns.links = [];
    // B-701 changed in NetSuite too, so its row is rewritten in a run that can't read links.
    ns.docs = ns.docs.map((d) => (d.id === 701 ? { ...d, label: 'Paid In Full' } : d));
    const both = await run(ns);
    expect(both).toMatchObject({ read: 4, linkTable: null, changed: 1 });
    expect(both.notes).toEqual([
      "NetSuite wouldn't list what the documents are linked to (NetSuite SuiteQL error (400): Invalid search query. Detailed unprocessed "
        + "description follows. Search error occurred: Record 'previoustransactionlinelink' was not found.), so which bills came from a "
        + "purchase order isn't copied this time.",
    ]);
    expect((await copied()).find((d) => d.id === '701')).toMatchObject({ label: 'Paid In Full' });
    expect((await copied()).find((d) => d.id === '701')?.links).toHaveLength(2);
  });

  it('reads the links document by document when NetSuite won\'t say which lines they\'re on, and says so', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 704).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.refuse.add('nextline');
    const r = await run(ns);
    expect(r).toMatchObject({ read: 4, linkTable: 'nexttransactionlinelink' });
    expect(r.notes).toEqual([
      "NetSuite wouldn't say which of a document's lines came from its purchase order, so received stock goes by the document as a whole.",
    ]);
    expect((await copied()).find((d) => d.id === '701')?.links).toEqual(B701_LINKS.map(({ lines: _l, ...l }) => l));

    // Line by line again the next time NetSuite says.
    clock += 2 * 3600_000;
    ns.refuse.delete('nextline');
    expect((await run(ns)).notes).toBeUndefined();
    expect((await copied()).find((d) => d.id === '701')?.links).toEqual(B701_LINKS);
  });

  it('copies a line\'s own amount as none when NetSuite leaves it out', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 704).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.lines[1] = { ...ns.lines[1], own: null };
    await run(ns);
    expect((await copied()).find((d) => d.id === '701')?.lines?.map((l) => l.own_amount)).toEqual(['-500.00', '-120.00', null]);
  });

  it('copies without the status and vendor in words when NetSuite won\'t give them, and says so', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 704).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.refuse.add('BUILTIN.DF');
    const r = await run(ns);
    expect(r.notes).toEqual([
      "NetSuite wouldn't give the documents' status in words, so voided ones aren't marked as voided, and vendors are named from the copy "
        + "of NetSuite's vendors.",
    ]);
    expect((await copied()).find((d) => d.id === '701')).toMatchObject({ label: null, voided: false, vendor: null, vendor_id: '50' });
  });

  it('records what failed, and keeps its place, when NetSuite stops answering', async () => {
    clock += 2 * 3600_000;
    store.delete(BOOKS_BILLS_SYNC);
    const ns = netsuite();
    let pages = 0;
    ns.onPage = () => {
      if (++pages === 2) ns.down = true;
    };
    const r = await run(ns);
    // The second page was read, then NetSuite stopped answering: the copy picks up below the first page next time.
    expect(r.error).toBe('the lines of bills below NetSuite id 704: NetSuite SuiteQL error (503): unavailable');
    expect(recorded().last_result).toMatchObject({ read: 4, error: r.error, resume: { beforeId: '704', processed: 2 } });
    expect(recorded().last_synced_at).toBeUndefined();
  });

  it('keeps a document\'s lines when NetSuite sends one it can\'t tell apart, and names it', async () => {
    clock += 2 * 3600_000;
    store.delete(BOOKS_BILLS_SYNC);
    const ns = netsuite();
    ns.lines.push({ bill: 701, id: null, amount: -5 });
    const r = await run(ns);
    expect(r).toMatchObject({ read: 5, gone: 0 });
    expect(r.notes).toEqual(["NetSuite sent a line with no line id on a document, so its lines aren't copied this time: B-701."]);
    expect((await copied()).find((d) => d.id === '701')?.lines).toEqual(B701_LINES);
  });

  it('leaves looking for what NetSuite deleted to the next run when there isn\'t time left', async () => {
    clock += 2 * 3600_000;
    store.delete(BOOKS_BILLS_SYNC);
    const ns = netsuite();
    // NetSuite deleted the bill without a number. Each page takes 25 s: with 60 s, the copy drains with too little left to list every id.
    ns.docs = ns.docs.filter((d) => d.id !== 705);
    ns.onPage = () => {
      clock += 25_000;
    };
    const r = await run(ns, { pageSize: 3, budgetMs: 60_000 });
    expect(r).toMatchObject({ read: 4 });
    expect(r.partial).toBeUndefined();
    expect(r.gone).toBeUndefined();
    expect(r.notes).toEqual(["There wasn't time left to check for documents NetSuite no longer has; the next run will."]);
    expect((await copied()).find((d) => d.id === '705')?.gone).toBe(false);

    clock += 2 * 3600_000;
    expect(await run(ns)).toMatchObject({ read: 0, gone: 1 });
    expect((await copied()).find((d) => d.id === '705')?.gone).toBe(true);
  });
});
