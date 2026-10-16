// Migration 391 keeps a copy of NetSuite's checks and credit card charges
// and refunds, with their lines, reads a month of them for the spending
// rule's check, and says where NetSuite posts the lines of an item the copy
// of its items has no account for. This runs migrations 359–363 and 391 in an
// in-memory Postgres (PGlite) as the app's server login and holds the
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
import { itemsWithoutAccount } from './bill-check';
import { checkSpendingMonth, type SpendingMonthData } from './spending-check';
import { BOOKS_SPENDING_SYNC, COPY_VERSION, SPENDING_IDS_QUERY, copyNetSuiteSpending, readSpendingMonth } from './netsuite-spending';

// A fresh database with Supabase's API roles and default grants, migrations
// 359–363 and 391 run twice as the owner, 1084 linked to subsidiary 5 (as the
// account sync does).
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
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '391-books-checks-and-cards.sql',
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

/** The functions, called the way supabase-js calls them: by name, with named arguments. */
const rpc = (pg: PGlite) => async (fn: string, args: Record<string, unknown>) => {
  const names = Object.keys(args);
  try {
    const r = await pg.query<{ r: unknown }>(
      `SELECT ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`,
      names.map((n) => (args[n] !== null && typeof args[n] === 'object' && !Array.isArray(args[n]) ? JSON.stringify(args[n]) : args[n])),
    );
    return { data: r.rows[0].r, error: null };
  } catch (e: any) {
    return { data: null, error: { message: e.message } };
  }
};

type Line = {
  line_id: string; item: string | null; account: string | null; amount: string | null; own_amount?: string | null; quantity: string | null;
  memo: string | null; tax: boolean;
};
type SpendingType = 'Check' | 'CardChrg' | 'CardRfnd';
const line = (lineId: string, item: string | null, account: string | null, amount: string): Line => ({
  line_id: lineId, item, account, amount, quantity: null, memo: null, tax: false,
});
const own = (l: Line, amount: string): Line => ({ ...l, own_amount: amount });
const doc = (id: string, type: SpendingType, number: string | null, date: string, total: string, fields: Record<string, unknown> = {}) => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date, payee_netsuite_id: '50', payee_name: 'V-50 Sample Supply',
  total, status: null, status_label: null, voided: false, memo: null, lines: [] as Line[], ...fields,
});

describe('the spending functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const apply = async (rows: unknown[]) =>
    (await db.query<{ r: { received: number; added: number; changed: number } }>('SELECT gl_netsuite_spending_apply($1::jsonb) AS r', [JSON.stringify({ rows })])).rows[0].r;
  const finish = async (ids: string[]) =>
    (await db.query<{ r: { listed: number; here: number; gone: number; cut_short: boolean } }>(
      'SELECT gl_netsuite_spending_finish($1::jsonb) AS r', [JSON.stringify({ netsuite_ids: ids })],
    )).rows[0].r;
  const stored = async (id: string) => (await db.query<{
    type: string; total: string; status_label: string | null; payee: string | null; lines: Line[] | null; gone: boolean; changed_at: string;
  }>(
    `SELECT tran_type AS type, total::text AS total, status_label, payee_name AS payee, lines, gone_at IS NOT NULL AS gone, changed_at::text AS changed_at
     FROM gl_netsuite_spending WHERE netsuite_id = $1`,
    [id],
  )).rows[0];

  const C801 = [line('1', null, '640', '-45.12'), line('2', '902', null, '-120.00')];

  it('adds what NetSuite has, and changes nothing when it\'s the same again', async () => {
    const rows = [
      doc('801', 'Check', '10234', '2026-09-03', '165.12', { lines: C801 }),
      doc('802', 'CardChrg', null, '2026-09-10', '330.00', { payee_netsuite_id: null, payee_name: null, lines: [line('1', '901', null, '-300.00')] }),
      doc('803', 'CardRfnd', 'R-803', '2026-09-15', '25.99', { lines: [line('1', null, '610', '25.99')] }),
    ];
    expect(await apply(rows)).toEqual({ received: 3, added: 3, changed: 0 });
    const before = await stored('801');
    expect(before).toMatchObject({ type: 'Check', total: '165.12', status_label: null, payee: 'V-50 Sample Supply', lines: C801, gone: false });
    expect(await stored('802')).toMatchObject({ type: 'CardChrg', payee: null });
    expect(await apply(rows)).toEqual({ received: 3, added: 0, changed: 0 });
    expect((await stored('801')).changed_at).toBe(before.changed_at);
  });

  it('follows NetSuite\'s changes, and keeps the lines when a run couldn\'t read them', async () => {
    const changed = [line('1', null, '640', '-55.12'), line('2', '902', null, '-120.00')];
    expect(await apply([doc('801', 'Check', '10234', '2026-09-03', '175.12', { lines: changed })])).toMatchObject({ added: 0, changed: 1 });
    const { lines, ...row } = doc('801', 'Check', '10234', '2026-09-03', '175.12');
    expect(lines).toEqual([]);
    expect(await apply([row])).toMatchObject({ changed: 0 });
    // Something else changed in a run that couldn't read the lines: the row follows NetSuite and keeps them.
    expect(await apply([{ ...row, status: 'V', status_label: 'Voided', voided: true }])).toMatchObject({ changed: 1 });
    expect(await stored('801')).toMatchObject({ total: '175.12', status_label: 'Voided', lines: changed });
    // A document copied before its lines could ever be read has none yet, which isn't the same as none in NetSuite.
    const { lines: _l, ...bare } = doc('804', 'Check', '10235', '2026-10-02', '50.00');
    await apply([bare]);
    expect(await stored('804')).toMatchObject({ lines: null });
  });

  it('marks what NetSuite no longer lists as gone, back when it lists it again, and nothing when the list looks cut short', async () => {
    expect(await finish(['801', '802', '803'])).toEqual({ listed: 3, here: 4, gone: 1, cut_short: false });
    expect(await stored('804')).toMatchObject({ gone: true });
    const { lines: _l, ...back } = doc('804', 'Check', '10235', '2026-10-02', '50.00');
    expect(await apply([back])).toMatchObject({ changed: 1 });
    expect(await stored('804')).toMatchObject({ gone: false });
    expect(await finish([])).toEqual({ listed: 0, here: 4, gone: 0, cut_short: true });
    expect(await finish(['801'])).toEqual({ listed: 1, here: 4, gone: 0, cut_short: true });
    expect((await stored('802')).gone).toBe(false);
  });

  it('refuses a bad page whole, changing nothing', async () => {
    const before = await stored('801');
    const good = doc('801', 'Check', '10234', '2026-09-03', '999.00');
    const notOne = /document 9 isn't a check, card charge or card refund with a date and total/;
    await expect(apply([good, { ...good, tranid: 'Twice' }])).rejects.toThrow(/NetSuite document 801 is in the page twice/);
    await expect(apply([good, { ...good, netsuite_id: 'x7' }])).rejects.toThrow(/NetSuite id "x7" isn't a number/);
    await expect(apply([good, { ...good, netsuite_id: '9', tran_type: 'VendBill' }])).rejects.toThrow(notOne);
    await expect(apply([good, { ...good, netsuite_id: '9', trandate: null }])).rejects.toThrow(notOne);
    await expect(apply([good, { ...good, netsuite_id: '9', total: '' }])).rejects.toThrow(notOne);
    await expect(apply([good, { ...good, netsuite_id: '9', lines: null }])).rejects.toThrow(notOne);
    await expect(apply([good, { ...good, netsuite_id: '9', lines: [{ item: '902', amount: '5.00' }] }])).rejects.toThrow(/document 9 has a line without a line id/);
    await expect(apply([good, { ...good, netsuite_id: '9', lines: ['a line'] }])).rejects.toThrow(/document 9 has a line without a line id/);
    await expect(apply([good, { ...good, netsuite_id: '9', payee_netsuite_id: 'V-50' }])).rejects.toThrow(/check constraint/);
    await expect(apply([good, { ...good, netsuite_id: '9', total: '-5.00' }])).rejects.toThrow(/check constraint/);
    await expect(db.query('SELECT gl_netsuite_spending_apply($1::jsonb)', [JSON.stringify({})])).rejects.toThrow(/rows must be a list/);
    await expect(db.query('SELECT gl_netsuite_spending_finish($1::jsonb)', [JSON.stringify({})])).rejects.toThrow(/netsuite_ids must be a list/);
    expect(await stored('801')).toEqual(before);
  });

  it('lets only the service role read the copy or run the functions, and the one write that changes rows says which', async () => {
    for (const fn of ['gl_netsuite_spending_apply(jsonb)', 'gl_netsuite_spending_finish(jsonb)', 'gl_spending_month(text, date)', 'gl_spending_item_accounts(text[])']) {
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(false);
      }
      const s = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn]);
      expect(s.rows[0].ok, fn).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      const t = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'gl_netsuite_spending', 'SELECT') AS ok`, [role]);
      expect(t.rows[0].ok, role).toBe(false);
    }
    const rls = await db.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'gl_netsuite_spending'`);
    expect(rls.rows[0].on).toBe(true);

    // Supabase's API connections fail an UPDATE or DELETE with no WHERE, even inside a function (migrations/README.md).
    const body = async (name: string) => (await db.query<{ b: string }>(`SELECT prosrc AS b FROM pg_proc WHERE proname = $1`, [name])).rows[0].b;
    expect(await body('gl_netsuite_spending_finish')).toMatch(/UPDATE public\.gl_netsuite_spending d SET gone_at = now\(\)\s+WHERE d\.gone_at IS NULL/);
    expect((await body('gl_netsuite_spending_finish')).match(/\b(UPDATE|DELETE)\b/g)).toEqual(['UPDATE']);
    // The apply's only write is an INSERT, whose ON CONFLICT ... DO UPDATE safeupdate leaves alone.
    expect((await body('gl_netsuite_spending_apply')).match(/\b(INSERT|UPDATE|DELETE)\b/g)).toEqual(['INSERT', 'UPDATE']);
    expect(await body('gl_netsuite_spending_apply')).toMatch(/ON CONFLICT \(netsuite_id\) DO UPDATE SET/);
    expect(await body('gl_spending_month')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(await body('gl_spending_item_accounts')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});

// Made-up books: '100' the bank, '220' the Chase card, '130' inventory,
// '610' shop supplies, '640' meals, '520' freight in and '480' vendor
// discounts (BMG); '105' and '615' 1084's.
const NAMES: Record<string, [string, string]> = {
  '100': ['1000 Operating Checking', 'bank'], '220': ['2200 Chase Card', 'credit_card'], '130': ['1300 Inventory', 'other_current_asset'],
  '610': ['6100 Shop Supplies', 'expense'], '640': ['6400 Meals', 'expense'], '520': ['5200 Freight In', 'cost_of_goods_sold'],
  '480': ['4800 Vendor Discounts', 'other_income'], '105': ['1050 Building Checking', 'bank'], '615': ['6150 Building Repairs', 'expense'],
};
const CHART: ChartAccount[] = Object.entries(NAMES).map(([id, [label, type]]) => ({
  netsuite_account_id: id, number: label.split(' ')[0], name: label.split(' ').slice(1).join(' '), account_type: type,
  company: id === '105' ? '1084' : null, active: true, is_summary: false,
}));

describe('gl_spending_month (migration 391)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // September 2026: check 10234 and card charge 802, which NetSuite gives
    // no number (BMG, NetSuite's lines signed the other way round from the
    // GL), card refund R-803, check 10220 dated in August but booked into
    // September, check 10250 (1084), check 10240 (in neither company's GL
    // copy), card charge C-807 dated in September but booked into October,
    // check 10245 (gone from NetSuite), and check 10249 in BMG's GL copy but
    // not copied yet. And a bill, which isn't a check or a card.
    await gl(db, '801', 'Check', '10234', '2026-09-03', 'BMG', [['0', '100', '0.00', '165.12'], ['1', '640', '45.12', '0.00'], ['2', '610', '120.00', '0.00']]);
    await gl(db, '802', 'CardChrg', null, '2026-09-10', 'BMG', [['0', '220', '0.00', '330.00'], ['1', '130', '300.00', '0.00'], ['2', '520', '30.00', '0.00']]);
    // Line ids out of text order, to show they come back in NetSuite's order.
    await gl(db, '803', 'CardRfnd', 'R-803', '2026-09-15', 'BMG', [['0', '220', '25.99', '0.00'], ['10', '610', '0.00', '20.00'], ['2', '610', '0.00', '5.99']]);
    await gl(db, '804', 'Check', '10220', '2026-08-31', 'BMG', [['0', '100', '0.00', '50.00'], ['1', '640', '50.00', '0.00']], '2026-09-01');
    await gl(db, '805', 'Check', '10250', '2026-09-15', '1084', [['0', '105', '0.00', '80.00'], ['1', '615', '80.00', '0.00']]);
    await gl(db, '807', 'CardChrg', 'C-807', '2026-09-29', 'BMG', [['0', '220', '0.00', '10.00'], ['1', '640', '10.00', '0.00']], '2026-10-01');
    await gl(db, '808', 'Check', '10245', '2026-09-27', 'BMG', [['0', '100', '0.00', '60.00'], ['1', '640', '60.00', '0.00']]);
    await gl(db, '809', 'Check', '10249', '2026-09-28', 'BMG', [['0', '100', '0.00', '40.00'], ['1', '640', '40.00', '0.00']]);
    await gl(db, '701', 'VendBill', 'B-701', '2026-09-08', 'BMG', [['0', '200', '0.00', '650.00'], ['1', '530', '650.00', '0.00']]);
    await listed(db, 'vendor', '50', 'Sample Supply Co', { payables_account: '200' });
    await listed(db, 'vendor', '51', 'Uline', { payables_account: '200' });
    await listed(db, 'item', '901', 'WIDGET-1', { item_type: 'InvtPart', asset_account: '130' });
    await listed(db, 'item', '902', 'SUPPLY-2', { item_type: 'NonInvtPart', expense_account: '610' });
    await listed(db, 'item', '903', 'FREIGHT', { item_type: 'OthCharge', expense_account: '520' });
    await listed(db, 'item', '905', 'NOT-USED', { item_type: 'Service', expense_account: '640' });
    // NetSuite numbers vendors and items apart, so a vendor can have an item's id, and an item a payee's.
    await listed(db, 'vendor', '901', 'Sample Widget Maker', { payables_account: '200' });
    await listed(db, 'item', '51', 'NOT-A-PAYEE', { item_type: 'Service', expense_account: '640' });
    await db.exec('SET ROLE service_role');
    await db.query('SELECT gl_netsuite_spending_apply($1::jsonb)', [JSON.stringify({ rows: [
      doc('801', 'Check', '10234', '2026-09-03', '165.12', { lines: [line('1', null, '640', '-45.12'), line('2', '902', null, '-120.00')] }),
      doc('802', 'CardChrg', null, '2026-09-10', '330.00', {
        payee_netsuite_id: '51', payee_name: 'V-51 Uline', lines: [line('1', '901', null, '-300.00'), line('2', '903', null, '-30.00')],
      }),
      doc('803', 'CardRfnd', 'R-803', '2026-09-15', '25.99', {
        payee_netsuite_id: '51', payee_name: 'V-51 Uline', lines: [line('1', null, '610', '20.00'), line('2', null, '610', '5.99')],
      }),
      doc('804', 'Check', '10220', '2026-08-31', '50.00', { lines: [line('1', null, '640', '-50.00')] }),
      doc('805', 'Check', '10250', '2026-09-15', '80.00', { payee_netsuite_id: '70', payee_name: 'Roof Co', lines: [line('1', null, '615', '-80.00')] }),
      doc('806', 'Check', '10240', '2026-09-25', '75.00', { lines: [line('1', null, '640', '-75.00')] }),
      doc('807', 'CardChrg', 'C-807', '2026-09-29', '10.00', { lines: [line('1', null, '640', '-10.00')] }),
      doc('808', 'Check', '10245', '2026-09-27', '60.00', { lines: [line('1', null, '640', '-60.00')] }),
    ] })]);
    await db.query('SELECT gl_netsuite_spending_finish($1::jsonb)', [JSON.stringify({ netsuite_ids: ['801', '802', '803', '804', '805', '806', '807'] })]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const month = async (company: string | null, day: string) =>
    (await db.query<{ r: SpendingMonthData }>('SELECT gl_spending_month($1, $2::date) AS r', [company, day])).rows[0].r;

  it('returns the company\'s checks and card charges and refunds NetSuite booked into the month, and those in neither company\'s GL copy', async () => {
    const bmg = await month('BMG', '2026-09-01');
    expect(bmg.documents.map((d) => [d.number, d.type, d.date, d.posting_month, d.companies])).toEqual([
      ['10220', 'Check', '2026-08-31', '2026-09-01', ['BMG']],
      ['10234', 'Check', '2026-09-03', '2026-09-01', ['BMG']],
      [null, 'CardChrg', '2026-09-10', '2026-09-01', ['BMG']],
      ['R-803', 'CardRfnd', '2026-09-15', '2026-09-01', ['BMG']],
      ['10240', 'Check', '2026-09-25', null, []],
    ]);
    expect((await month('1084', '2026-09-15')).documents.map((d) => d.number)).toEqual(['10250', '10240']);
    // Those of a day in the order of their numbers.
    expect((await month(null, '2026-09-30')).documents.map((d) => d.number)).toEqual(['10220', '10234', null, '10250', 'R-803', '10240']);
    expect((await month('BMG', '2026-10-01')).documents.map((d) => d.number)).toEqual(['C-807']);
    expect((await month('BMG', '2026-08-01')).documents).toEqual([]);
  });

  it('gives each its lines, payee and NetSuite\'s GL lines in line order', async () => {
    const [, c801, c802, r803] = (await month('BMG', '2026-09-01')).documents;
    expect(c801).toMatchObject({
      netsuite_id: '801', total: '165.12', voided: false, status: null, payee: 'Sample Supply Co', payee_netsuite_id: '50',
      lines: [line('1', null, '640', '-45.12'), line('2', '902', null, '-120.00')],
    });
    // The vendors copy's name for a payee that's a vendor.
    expect(c802).toMatchObject({ payee: 'Uline', payee_netsuite_id: '51' });
    expect(r803.netsuite).toEqual([
      { line_id: '0', account: '220', debit: '25.99', credit: '0.00' },
      { line_id: '2', account: '610', debit: '0.00', credit: '5.99' },
      { line_id: '10', account: '610', debit: '0.00', credit: '20.00' },
    ]);
    // Anyone else is named as the document names them.
    expect((await month('1084', '2026-09-01')).documents[0]).toMatchObject({ payee: 'Roof Co', payee_netsuite_id: '70' });
  });

  it('names the items the lines use, and what isn\'t copied yet', async () => {
    const bmg = await month('BMG', '2026-09-01');
    expect(bmg.items).toEqual([
      { netsuite_id: '901', name: 'WIDGET-1', active: true, gone: false, item_type: 'InvtPart', asset_account: '130', expense_account: null, income_account: null },
      { netsuite_id: '902', name: 'SUPPLY-2', active: true, gone: false, item_type: 'NonInvtPart', asset_account: null, expense_account: '610', income_account: null },
      { netsuite_id: '903', name: 'FREIGHT', active: true, gone: false, item_type: 'OthCharge', asset_account: null, expense_account: '520', income_account: null },
    ]);
    // What NetSuite deleted counts as not copied, as the GL copy still has it; a bill never does.
    expect(bmg.not_copied).toEqual([{ netsuite_id: '808', type: 'Check', number: '10245' }, { netsuite_id: '809', type: 'Check', number: '10249' }]);
    expect((await month('1084', '2026-09-01')).not_copied).toEqual([]);
  });

  it('checks a month end to end', async () => {
    const m = checkSpendingMonth(await month('BMG', '2026-09-01'), { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 4, matches: 4, differs: 0, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.invoices.map((d) => [d.number, d.type, d.status, d.customer, d.booked])).toEqual([
      ['10220', 'Check', 'matches', 'Sample Supply Co', { month: '2026-09-01', date: '2026-09-01' }],
      ['10234', 'Check', 'matches', 'Sample Supply Co', undefined],
      ['NetSuite 802', 'CardChrg', 'matches', 'Uline', undefined],
      ['R-803', 'CardRfnd', 'matches', 'Uline', undefined],
    ]);
    expect(m.invoices.map((d) => d.rows.map((r) => [r.label, r.fleetsuite?.account, r.same]))).toEqual([
      [['Paid from', '100', true], ['Expense', '640', true]],
      [['Paid from', '100', true], ['Expense', '640', true], ['Items', '610', true]],
      [['Paid from', '220', true], ['Inventory', '130', true], ['Items', '520', true]],
      [['Refunded to', '220', true], ['Expense', '610', true]],
    ]);
    expect(m.notes).toEqual([
      '1 check, card charge or refund dated in another month is here because NetSuite booked it into this month: 10220.',
      "1 more check, card charge or refund dated this month isn't in the copy of NetSuite's GL for either company: 10240. NetSuite may have "
        + "deleted it, or the copy, which runs every two hours, hasn't reached it yet.",
      "The copy of NetSuite's GL has 2 checks, card charges and refunds of this company's booked into this month that the copy of the "
        + "checks, card charges and refunds doesn't: 10245, 10249. That copy runs every two hours and may not have reached them yet, or "
        + "NetSuite deleted them and the GL copy hasn't caught up.",
    ]);
    const other = checkSpendingMonth(await month('1084', '2026-09-01'), { company: '1084', chart: CHART });
    expect(other.invoices.map((d) => [d.number, d.status, d.rows.map((r) => [r.label, r.fleetsuite?.account, r.same])])).toEqual([
      ['10250', 'matches', [['Paid from', '105', true], ['Expense', '615', true]]],
    ]);
  });
});

describe('a discount on a card charge (migration 391)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // September 2026: card charge 810, $100.00 of supplies less 8% (a
    // subtotal, then the discount, which the copy of NetSuite's items has no
    // account for). Checks 10300 (July) and 10302 (June) take the same
    // discount, and 10301, gone from NetSuite, put it somewhere else.
    await gl(db, '810', 'CardChrg', null, '2026-09-10', 'BMG', [['0', '220', '0.00', '92.00'], ['1', '610', '100.00', '0.00'], ['3', '480', '0.00', '8.00']]);
    await gl(db, '811', 'Check', '10300', '2026-07-02', 'BMG', [['0', '100', '0.00', '46.00'], ['1', '610', '50.00', '0.00'], ['2', '480', '0.00', '4.00']]);
    await gl(db, '812', 'Check', '10301', '2026-07-09', 'BMG', [['0', '100', '0.00', '9.00'], ['1', '640', '10.00', '0.00'], ['2', '615', '0.00', '1.00']]);
    await gl(db, '813', 'Check', '10302', '2026-06-04', 'BMG', [['0', '100', '0.00', '19.00'], ['1', '640', '20.00', '0.00'], ['2', '640', '0.00', '1.00']]);
    await listed(db, 'item', '902', 'SUPPLY-2', { item_type: 'NonInvtPart', expense_account: '610' });
    await listed(db, 'item', '904', 'DISC-8', { item_type: 'Discount' });
    await db.exec('SET ROLE service_role');
    await db.query('SELECT gl_netsuite_spending_apply($1::jsonb)', [JSON.stringify({ rows: [
      doc('810', 'CardChrg', null, '2026-09-10', '92.00', {
        lines: [own(line('1', '902', null, '-92.00'), '-100.00'), own(line('2', '-2', null, '-100.00'), '-100.00'), own(line('3', '904', null, '0.00'), '8.00')],
      }),
      doc('811', 'Check', '10300', '2026-07-02', '46.00', { lines: [own(line('1', '902', null, '-46.00'), '-50.00'), own(line('2', '904', null, '0.00'), '4.00')] }),
      doc('812', 'Check', '10301', '2026-07-09', '9.00', { lines: [own(line('1', null, '640', '-9.00'), '-10.00'), own(line('2', '904', null, '0.00'), '1.00')] }),
      doc('813', 'Check', '10302', '2026-06-04', '19.00', { lines: [own(line('1', null, '640', '-19.00'), '-20.00'), own(line('2', '904', null, '0.00'), '1.00')] }),
    ] })]);
    await db.query('SELECT gl_netsuite_spending_finish($1::jsonb)', [JSON.stringify({ netsuite_ids: ['810', '811', '813'] })]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const itemAccounts = async (items: string[] | null) =>
    (await db.query<{ r: NonNullable<SpendingMonthData['item_accounts']> }>('SELECT gl_spending_item_accounts($1::text[]) AS r', [items])).rows[0].r;

  it('says where NetSuite posted the lines of the items asked about, most used first, leaving out what NetSuite deleted', async () => {
    expect(await itemAccounts(['904', '902', '999'])).toEqual([
      { item: '902', account: '610', lines: 2 },
      { item: '904', account: '480', lines: 2 },
      { item: '904', account: '640', lines: 1 },
    ]);
    expect(await itemAccounts([])).toEqual([]);
    expect(await itemAccounts(null)).toEqual([]);
  });

  it('checks the month end to end, read as the page reads it', async () => {
    const data = await readSpendingMonth({ rpc: rpc(db) } as any, 'BMG', '2026-09-01');
    expect(itemsWithoutAccount(data.items)).toEqual(['904']);
    expect(data.item_accounts).toEqual([{ item: '904', account: '480', lines: 2 }, { item: '904', account: '640', lines: 1 }]);
    const m = checkSpendingMonth(data, { company: 'BMG', chart: CHART });
    expect(m.summary).toMatchObject({ invoices: 1, matches: 1, differs: 0, unworkable: 0 });
    const [c810] = m.invoices;
    expect(c810.amounts).toBe('own');
    expect(c810.lines.map((l) => [l.label, l.cents])).toEqual([['SUPPLY-2', 10000], ['Subtotal', 10000], ['DISC-8', -800]]);
    expect(c810.rows.map((r) => [r.label, r.fleetsuite?.account, r.fleetsuite?.cents, r.same])).toEqual([
      ['Paid from', '220', -9200, true], ['Items', '610', 10000, true], ['Items', '480', -800, true],
    ]);
    // A reader that fails says so.
    await expect(readSpendingMonth({ rpc: rpc(db) } as any, 'BMG', 'not a month')).rejects.toThrow(/date/);
  });
});

// ── The copy job ───────────────────────────────────────────────────────────

interface NsDoc {
  id: number;
  type: SpendingType;
  tranid: string | null;
  /** As SuiteQL gives it, M/D/YYYY. */
  trandate: string;
  total: number;
  status?: string;
  label?: string;
  payee?: number | null;
  /** lastmodifieddate, YYYY-MM-DD. */
  modified: string;
}

interface NsLine {
  doc: number;
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
  /** Columns and records this account refuses. */
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
    // A copy that asks for the same page again and again would never stop.
    if (this.headerPages > 100) throw new Error('the copy asked for more pages than NetSuite has');
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
        payee_id: x.payee ?? null,
        ...(withLabels ? { status_label: x.label ?? null, payee_name: x.payee ? `V-${x.payee} Vendor Co` : null } : {}),
      }));
  };

  query = async (q: string): Promise<Record<string, unknown>[]> => {
    if (this.down) throw Object.assign(new Error('NetSuite SuiteQL error (503): unavailable'), { status: 503 });
    const ids = (/IN \(([\d, ]+)\)/.exec(q)?.[1] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    if (q.includes('FROM transactionline tl')) {
      if (this.refuse.has('transactionline')) throw rejected("Search error occurred: Record 'transactionLine' was not found.");
      const withAccount = q.includes('tl.expenseaccount');
      if (withAccount && this.refuse.has('expenseaccount')) throw rejected("Search error occurred: Field 'expenseaccount' for record 'transactionLine' was not found.");
      return this.lines
        .filter((l) => ids.includes(l.doc))
        .sort((a, b) => a.doc - b.doc || (a.id ?? 0) - (b.id ?? 0))
        .map((l) => ({
          bill_id: l.doc, line_id: l.id, item: l.item ?? null, amount: l.amount, quantity: l.quantity ?? null, memo: l.memo ?? null,
          taxline: l.tax ? 'T' : 'F', ...(withAccount ? { account: l.account ?? null } : {}),
          // SuiteQL leaves a null column out of the row.
          ...(l.own !== null ? { own_amount: l.own ?? l.amount } : {}),
        }));
    }
    if (q === SPENDING_IDS_QUERY) return (this.ids ?? this.docs.map((x) => x.id)).sort((a, b) => a - b).map((id) => ({ id }));
    throw new Error(`unexpected query: ${q}`);
  };
}

function netsuite(): FakeNetSuite {
  const ns = new FakeNetSuite();
  ns.docs = [
    { id: 801, type: 'Check', tranid: '10234', trandate: '9/3/2026', total: -165.12, payee: 50, modified: '2026-09-20' },
    { id: 802, type: 'CardChrg', tranid: null, trandate: '9/10/2026', total: -330, payee: 51, modified: '2026-09-12' },
    { id: 803, type: 'CardRfnd', tranid: 'R-803', trandate: '9/15/2026', total: 25.99, payee: 51, modified: '2026-09-15' },
    { id: 804, type: 'Check', tranid: '10236', trandate: '9/20/2026', total: 0, status: 'V', label: 'Voided', payee: 50, modified: '2026-09-20' },
    { id: 805, type: 'Check', tranid: '10237', trandate: '10/2/2026', total: -200, payee: null, modified: '2026-10-02' },
  ];
  ns.lines = [
    { doc: 801, id: 1, account: 640, amount: '-45.12', memo: 'Lunch' },
    { doc: 801, id: 2, item: 902, amount: -120, quantity: -4 },
    { doc: 802, id: 2, item: 903, amount: -30 },
    { doc: 802, id: 1, item: 901, amount: -300, quantity: -10 },
    { doc: 803, id: 1, account: 610, amount: 25.99 },
    { doc: 805, id: 1, account: 640, amount: -200 },
  ];
  return ns;
}

describe('the copy job against the real functions', () => {
  let pg: PGlite;
  let clock = Date.parse('2026-10-16T01:33:00Z');
  const store = new Map<string, any>();

  beforeAll(async () => {
    pg = await freshDb();
    await pg.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  // sync_state in memory; every function the real one.
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
    rpc: rpc(pg),
  }) as any;

  const run = (ns: FakeNetSuite, opts: { pageSize?: number; budgetMs?: number } = {}) => copyNetSuiteSpending(service(), {
    deadline: clock + (opts.budgetMs ?? 240_000),
    deps: { query: ns.query, page: ns.page, pageSize: opts.pageSize ?? 2, now: () => clock },
  });
  const copied = async () => (await pg.query<{
    id: string; type: string; number: string | null; date: string; total: string; voided: boolean; label: string | null; payee: string | null;
    payee_id: string | null; lines: Line[] | null; gone: boolean;
  }>(
    `SELECT netsuite_id AS id, tran_type AS type, tranid AS number, to_char(trandate, 'YYYY-MM-DD') AS date, total::text AS total, voided,
            status_label AS label, payee_name AS payee, payee_netsuite_id AS payee_id, lines, gone_at IS NOT NULL AS gone
     FROM gl_netsuite_spending ORDER BY netsuite_id::int`,
  )).rows;
  const recorded = () => store.get(BOOKS_SPENDING_SYNC);
  const copyLine = (lineId: string, fields: Partial<Line>): Line => ({
    line_id: lineId, item: null, account: null, amount: null, own_amount: null, quantity: null, memo: null, tax: false, ...fields,
  });
  const C801_LINES: Line[] = [
    copyLine('1', { account: '640', amount: '-45.12', own_amount: '-45.12', memo: 'Lunch' }),
    copyLine('2', { item: '902', amount: '-120.00', own_amount: '-120.00', quantity: '-4' }),
  ];

  it('copies every check, card charge and card refund, newest first a page at a time, with its lines', async () => {
    const ns = netsuite();
    const r = await run(ns);
    expect(r).toMatchObject({ read: 5, added: 5, changed: 0, gone: 0 });
    expect(r.error).toBeUndefined();
    expect(r.partial).toBeUndefined();
    expect(r.notes).toBeUndefined();
    expect(ns.headerPages).toBe(3);
    expect(await copied()).toEqual([
      { id: '801', type: 'Check', number: '10234', date: '2026-09-03', total: '165.12', voided: false, label: null, payee: 'V-50 Vendor Co', payee_id: '50',
        gone: false, lines: C801_LINES },
      { id: '802', type: 'CardChrg', number: null, date: '2026-09-10', total: '330.00', voided: false, label: null, payee: 'V-51 Vendor Co', payee_id: '51',
        gone: false, lines: [
          copyLine('1', { item: '901', amount: '-300.00', own_amount: '-300.00', quantity: '-10' }),
          copyLine('2', { item: '903', amount: '-30.00', own_amount: '-30.00' }),
        ] },
      { id: '803', type: 'CardRfnd', number: 'R-803', date: '2026-09-15', total: '25.99', voided: false, label: null, payee: 'V-51 Vendor Co', payee_id: '51',
        gone: false, lines: [copyLine('1', { account: '610', amount: '25.99', own_amount: '25.99' })] },
      // A voided check NetSuite gives no lines for has none.
      { id: '804', type: 'Check', number: '10236', date: '2026-09-20', total: '0.00', voided: true, label: 'Voided', payee: 'V-50 Vendor Co', payee_id: '50',
        gone: false, lines: [] },
      { id: '805', type: 'Check', number: '10237', date: '2026-10-02', total: '200.00', voided: false, label: null, payee: null, payee_id: null,
        gone: false, lines: [copyLine('1', { account: '640', amount: '-200.00', own_amount: '-200.00' })] },
    ]);
    // The window closed at the time it was opened, and the record holds counts, never an amount.
    const record = recorded();
    expect(record.last_synced_at).toBe(new Date(clock).toISOString());
    expect(record.last_result).toEqual({ read: 5, added: 5, changed: 0, gone: 0, version: COPY_VERSION });
  });

  it('reads only what NetSuite changed since the last run, a day\'s overlap included', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs[2] = { ...ns.docs[2], total: 30, modified: '2026-10-16' };
    ns.lines[4] = { ...ns.lines[4], amount: 30 };
    const r = await run(ns);
    expect(r).toMatchObject({ read: 1, added: 0, changed: 1, gone: 0 });
    expect((await copied()).find((d) => d.id === '803')).toMatchObject({ total: '30.00', lines: [{ line_id: '1', amount: '30.00' }] });
  });

  it('starts over from the first document when the copy was made by an older version of the job', async () => {
    clock += 2 * 3600_000;
    // A record without this version: its window closed two hours ago, and a run of it cut short below 802.
    store.set(BOOKS_SPENDING_SYNC, {
      sync_type: BOOKS_SPENDING_SYNC,
      last_synced_at: new Date(clock - 2 * 3600_000).toISOString(),
      last_result: { read: 1, resume: { windowStartedAt: new Date(clock - 3600_000).toISOString(), since: '2026-10-15T01:33:00.000Z', beforeId: '802', processed: 1 } },
    });
    const ns = netsuite();
    ns.lines[0] = { ...ns.lines[0], own: '-50.00' };
    const r = await run(ns);
    // Every document, though none changed since the last window: the old run's place and window don't count.
    expect(r).toMatchObject({ read: 5 });
    expect(recorded().last_result).toMatchObject({ version: COPY_VERSION });
    expect(recorded().last_result.resume).toBeUndefined();
    expect((await copied()).find((d) => d.id === '801')?.lines?.[0]).toMatchObject({ amount: '-45.12', own_amount: '-50.00' });

    // Then only what changed, as before.
    clock += 2 * 3600_000;
    expect(await run(netsuite())).toMatchObject({ read: 0 });
  });

  it('carries on where a run cut short by time stopped, and closes the window only when it drains', async () => {
    store.delete(BOOKS_SPENDING_SYNC);
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
    expect(saved).toEqual([null, '804']);
    expect(recorded().last_result.resume).toEqual({ windowStartedAt: new Date(opened).toISOString(), since: '1999-12-31T00:00:00.000Z', beforeId: '802', processed: 4 });
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
    ns.docs = ns.docs.filter((d) => d.id !== 804);
    expect(await run(ns)).toMatchObject({ read: 0, gone: 1 });
    expect((await copied()).find((d) => d.id === '804')?.gone).toBe(true);

    clock += 2 * 3600_000;
    ns.ids = [801];
    const r = await run(ns);
    expect(r).toMatchObject({ gone: 0 });
    expect(r.notes).toEqual(['NetSuite listed 1 checks, card charges and refunds and FleetSuite has 4, so none were marked gone.']);
    expect((await copied()).filter((d) => !d.gone).map((d) => d.id)).toEqual(['801', '802', '803', '805']);
  });

  it('copies the lines without their accounts when NetSuite won\'t give those, and keeps them when it won\'t give lines at all', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    // NetSuite deleted 804 in the test before; it stays deleted.
    ns.docs = ns.docs.filter((d) => d.id !== 804).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.refuse.add('expenseaccount');
    const r = await run(ns);
    expect(r.notes).toEqual([
      "NetSuite wouldn't say which account each expense line goes to, so checks, card charges and refunds with expense lines can't be "
        + 'worked out this time.',
    ]);
    expect((await copied()).find((d) => d.id === '801')?.lines?.map((l) => l.account)).toEqual([null, null]);

    clock += 2 * 3600_000;
    ns.refuse.delete('expenseaccount');
    ns.refuse.add('transactionline');
    // 803 changed in NetSuite too, so its row is rewritten in a run that can't read lines.
    ns.docs = ns.docs.map((d) => (d.id === 803 ? { ...d, total: 35 } : d));
    const none = await run(ns);
    expect(none).toMatchObject({ read: 4, changed: 1 });
    expect(none.notes).toEqual([
      "NetSuite wouldn't give the documents' lines (NetSuite SuiteQL error (400): Invalid search query. Detailed unprocessed description "
        + "follows. Search error occurred: Record 'transactionLine' was not found.), so they aren't copied this time; the ones already "
        + 'copied keep theirs.',
    ]);
    expect((await copied()).find((d) => d.id === '803')).toMatchObject({ total: '35.00', lines: [{ line_id: '1', account: null, amount: '25.99' }] });

    // With the accounts back, the documents with expense lines get them back; the card charge's item lines never had one.
    clock += 2 * 3600_000;
    ns.refuse.delete('transactionline');
    expect(await run(ns)).toMatchObject({ read: 4, changed: 3 });
    expect((await copied()).find((d) => d.id === '801')?.lines).toEqual(C801_LINES);
  });

  it('copies a line\'s own amount as none when NetSuite leaves it out', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 804).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.lines[1] = { ...ns.lines[1], own: null };
    await run(ns);
    expect((await copied()).find((d) => d.id === '801')?.lines?.map((l) => l.own_amount)).toEqual(['-45.12', null]);
  });

  it('copies without the status and payee in words when NetSuite won\'t give them, and says so', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 804).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.refuse.add('BUILTIN.DF');
    const r = await run(ns);
    expect(r.notes).toEqual([
      "NetSuite wouldn't give the documents' status or payee in words, so voided ones aren't marked as voided, and only payees that are "
        + "vendors are named, from the copy of NetSuite's vendors.",
    ]);
    expect((await copied()).find((d) => d.id === '801')).toMatchObject({ label: null, voided: false, payee: null, payee_id: '50' });
  });

  it('records what failed, and keeps its place, when NetSuite stops answering', async () => {
    clock += 2 * 3600_000;
    store.delete(BOOKS_SPENDING_SYNC);
    const ns = netsuite();
    let pages = 0;
    ns.onPage = () => {
      if (++pages === 2) ns.down = true;
    };
    const r = await run(ns);
    // The second page was read, then NetSuite stopped answering: the copy picks up below the first page next time.
    expect(r.error).toBe('the lines of checks, card charges and refunds below NetSuite id 804: NetSuite SuiteQL error (503): unavailable');
    expect(recorded().last_result).toMatchObject({ read: 4, error: r.error, resume: { beforeId: '804', processed: 2 } });
    expect(recorded().last_synced_at).toBeUndefined();
  });

  it('keeps a document\'s lines when NetSuite sends one it can\'t tell apart, and names it', async () => {
    clock += 2 * 3600_000;
    store.delete(BOOKS_SPENDING_SYNC);
    const ns = netsuite();
    ns.lines.push({ doc: 801, id: null, amount: -5 });
    const r = await run(ns);
    expect(r).toMatchObject({ read: 5, gone: 0 });
    expect(r.notes).toEqual(["NetSuite sent a line with no line id on a document, so its lines aren't copied this time: 10234."]);
    expect((await copied()).find((d) => d.id === '801')?.lines).toEqual(C801_LINES);
  });

  it('leaves looking for what NetSuite deleted to the next run when there isn\'t time left', async () => {
    clock += 2 * 3600_000;
    store.delete(BOOKS_SPENDING_SYNC);
    const ns = netsuite();
    // NetSuite deleted check 10237. Each page takes 25 s: with 60 s, the copy drains with too little left to list every id.
    ns.docs = ns.docs.filter((d) => d.id !== 805);
    ns.onPage = () => {
      clock += 25_000;
    };
    const r = await run(ns, { pageSize: 3, budgetMs: 60_000 });
    expect(r).toMatchObject({ read: 4 });
    expect(r.partial).toBeUndefined();
    expect(r.gone).toBeUndefined();
    expect(r.notes).toEqual(["There wasn't time left to check for documents NetSuite no longer has; the next run will."]);
    expect((await copied()).find((d) => d.id === '805')?.gone).toBe(false);

    clock += 2 * 3600_000;
    expect(await run(ns)).toMatchObject({ read: 0, gone: 1 });
    expect((await copied()).find((d) => d.id === '805')?.gone).toBe(true);
  });
});
