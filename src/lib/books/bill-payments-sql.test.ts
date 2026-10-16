// Migration 389 keeps a copy of NetSuite's bill payments, with the bills each
// one paid, and reads a month of them for the bill payment rule's check. This
// runs migrations 359–363 and 389 in an in-memory Postgres (PGlite) as the
// app's server login and holds the functions' rules, then runs the whole copy
// job against them with a fake NetSuite that answers the job's own SuiteQL,
// and checks a month end to end.
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
import { checkBillPaymentMonth, type BillPaymentMonthData } from './bill-payment-check';
import { BILL_PAYMENT_IDS_QUERY, BOOKS_BILL_PAYMENTS_SYNC, copyNetSuiteBillPayments } from './netsuite-bill-payments';

// A fresh database with Supabase's API roles and default grants, migrations
// 359–363 and 389 run twice as the owner, 1084 linked to subsidiary 5 (as the
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
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '389-books-bill-payments.sql',
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

type Link = { netsuite_id: string; type: string | null; number: string | null; amount: string | null; link_type: string | null };
const link = (id: string, type: string, number: string | null, amount: string | null): Link => ({ netsuite_id: id, type, number, amount, link_type: null });
const doc = (id: string, number: string | null, date: string, total: string, fields: Record<string, unknown> = {}) => ({
  netsuite_id: id, tran_type: 'VendPymt', tranid: number, trandate: date, vendor_netsuite_id: '50', vendor_name: 'V-50 Sample Supply',
  total, status: null, status_label: null, voided: false, memo: null, links: [] as Link[], ...fields,
});

describe('the bill payments functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const apply = async (rows: unknown[]) =>
    (await db.query<{ r: { received: number; added: number; changed: number } }>('SELECT gl_netsuite_bill_payments_apply($1::jsonb) AS r', [JSON.stringify({ rows })])).rows[0].r;
  const finish = async (ids: string[]) =>
    (await db.query<{ r: { listed: number; here: number; gone: number; cut_short: boolean } }>(
      'SELECT gl_netsuite_bill_payments_finish($1::jsonb) AS r', [JSON.stringify({ netsuite_ids: ids })],
    )).rows[0].r;
  const stored = async (id: string) => (await db.query<{ total: string; status_label: string | null; voided: boolean; links: Link[] | null; gone: boolean; changed_at: string }>(
    `SELECT total::text AS total, status_label, voided, links, gone_at IS NOT NULL AS gone, changed_at::text AS changed_at
     FROM gl_netsuite_bill_payments WHERE netsuite_id = $1`,
    [id],
  )).rows[0];

  const PAID = [link('701', 'VendBill', 'B-701', '400.00'), link('702', 'VendBill', null, '250.00')];

  it('adds what NetSuite has, and changes nothing when it\'s the same again', async () => {
    const rows = [
      doc('801', 'CHK1001', '2026-09-08', '650.00', { status_label: 'Online Bill Pay', links: PAID }),
      doc('802', 'CHK1002', '2026-09-12', '637.00', { links: [link('704', 'VendBill', 'B-704', '650.00')] }),
    ];
    expect(await apply(rows)).toEqual({ received: 2, added: 2, changed: 0 });
    const before = await stored('801');
    expect(before).toMatchObject({ total: '650.00', status_label: 'Online Bill Pay', voided: false, links: PAID, gone: false });
    expect(await apply(rows)).toEqual({ received: 2, added: 0, changed: 0 });
    expect((await stored('801')).changed_at).toBe(before.changed_at);
  });

  it('follows NetSuite\'s changes, and keeps the links when a run couldn\'t read them', async () => {
    expect(await apply([doc('801', 'CHK1001', '2026-09-08', '650.00', { status_label: 'Voided', voided: true, links: PAID })]))
      .toMatchObject({ added: 0, changed: 1 });
    const { links, ...row } = doc('801', 'CHK1001', '2026-09-08', '650.00', { status_label: 'Voided', voided: true });
    expect(links).toEqual([]);
    expect(await apply([row])).toMatchObject({ changed: 0 });
    // Something else changed in a run that couldn't read the links: the row follows NetSuite and keeps them.
    expect(await apply([{ ...row, memo: 'September parts' }])).toMatchObject({ changed: 1 });
    expect(await stored('801')).toMatchObject({ status_label: 'Voided', voided: true, links: PAID });
    // A payment copied before its links could ever be read has none yet, which isn't the same as none in NetSuite.
    const { links: _none, ...unlinked } = doc('803', null, '2026-10-02', '200.00');
    await apply([unlinked]);
    expect((await stored('803')).links).toBeNull();
  });

  it('marks what NetSuite no longer lists as gone, back when it lists it again, and nothing when the list looks cut short', async () => {
    expect(await finish(['801', '802'])).toEqual({ listed: 2, here: 3, gone: 1, cut_short: false });
    expect(await stored('803')).toMatchObject({ gone: true });
    const { links: _none, ...back } = doc('803', null, '2026-10-02', '200.00');
    expect(await apply([back])).toMatchObject({ changed: 1 });
    expect(await stored('803')).toMatchObject({ gone: false });
    expect(await finish([])).toEqual({ listed: 0, here: 3, gone: 0, cut_short: true });
    expect(await finish(['801', '801'])).toEqual({ listed: 1, here: 3, gone: 0, cut_short: true });
    expect((await stored('802')).gone).toBe(false);
  });

  it('refuses a bad page whole, changing nothing', async () => {
    const before = await stored('801');
    const good = doc('801', 'CHK1001', '2026-09-08', '999.00');
    await expect(apply([good, { ...good, tranid: 'Twice' }])).rejects.toThrow(/NetSuite document 801 is in the page twice/);
    await expect(apply([good, { ...good, netsuite_id: 'x7' }])).rejects.toThrow(/NetSuite id "x7" isn't a number/);
    await expect(apply([good, { ...good, netsuite_id: undefined }])).rejects.toThrow(/NetSuite id "\(none\)" isn't a number/);
    await expect(apply([good, { ...good, netsuite_id: '9', tran_type: 'VendBill' }])).rejects.toThrow(/document 9 isn't a bill payment with a date and total/);
    await expect(apply([good, { ...good, netsuite_id: '9', trandate: null }])).rejects.toThrow(/document 9 isn't a bill payment/);
    await expect(apply([good, { ...good, netsuite_id: '9', total: '' }])).rejects.toThrow(/document 9 isn't a bill payment/);
    await expect(apply([good, { ...good, netsuite_id: '9', links: { not: 'a list' } }])).rejects.toThrow(/document 9 isn't a bill payment/);
    await expect(apply([good, { ...good, netsuite_id: '9', links: null }])).rejects.toThrow(/document 9 isn't a bill payment/);
    await expect(apply([good, { ...good, netsuite_id: '9', vendor_netsuite_id: 'V-50' }])).rejects.toThrow(/check constraint/);
    await expect(apply([good, { ...good, netsuite_id: '9', total: '-5.00' }])).rejects.toThrow(/check constraint/);
    await expect(db.query('SELECT gl_netsuite_bill_payments_apply($1::jsonb)', [JSON.stringify({})])).rejects.toThrow(/rows must be a list/);
    await expect(db.query('SELECT gl_netsuite_bill_payments_finish($1::jsonb)', [JSON.stringify({})])).rejects.toThrow(/netsuite_ids must be a list/);
    expect(await stored('801')).toEqual(before);
  });

  it('lets only the service role read the copy or run the functions, and the one write that changes rows says which', async () => {
    for (const fn of ['gl_netsuite_bill_payments_apply(jsonb)', 'gl_netsuite_bill_payments_finish(jsonb)', 'gl_bill_payment_month(text, date)']) {
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(false);
      }
      const s = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn]);
      expect(s.rows[0].ok, fn).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      const t = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'gl_netsuite_bill_payments', 'SELECT') AS ok`, [role]);
      expect(t.rows[0].ok, role).toBe(false);
    }
    const rls = await db.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'gl_netsuite_bill_payments'`);
    expect(rls.rows[0].on).toBe(true);

    // Supabase's API connections fail an UPDATE or DELETE with no WHERE, even inside a function (migrations/README.md).
    const body = async (name: string) => (await db.query<{ b: string }>(`SELECT prosrc AS b FROM pg_proc WHERE proname = $1`, [name])).rows[0].b;
    expect(await body('gl_netsuite_bill_payments_finish')).toMatch(/UPDATE public\.gl_netsuite_bill_payments d SET gone_at = now\(\)\s+WHERE d\.gone_at IS NULL/);
    expect((await body('gl_netsuite_bill_payments_finish')).match(/\b(UPDATE|DELETE)\b/g)).toEqual(['UPDATE']);
    // The apply's only write is an INSERT, whose ON CONFLICT ... DO UPDATE safeupdate leaves alone.
    expect((await body('gl_netsuite_bill_payments_apply')).match(/\b(INSERT|UPDATE|DELETE)\b/g)).toEqual(['INSERT', 'UPDATE']);
    expect(await body('gl_netsuite_bill_payments_apply')).toMatch(/ON CONFLICT \(netsuite_id\) DO UPDATE SET/);
    expect(await body('gl_bill_payment_month')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});

// Made-up books: '200' payables, '100' checking, '220' a company card and
// '485' purchase discounts (BMG's); '210' payables and '105' checking
// (1084's); '530' subcontractors.
const NAMES: Record<string, [string, string]> = {
  '200': ['2000 Accounts Payable', 'accounts_payable'], '100': ['1000 Checking', 'bank'], '220': ['2200 Company Card', 'credit_card'],
  '485': ['4850 Purchase Discounts', 'other_income'], '210': ['2100 Accounts Payable', 'accounts_payable'], '105': ['1050 Checking', 'bank'],
  '530': ['5300 Subcontractors', 'expense'],
};
const CHART: ChartAccount[] = Object.entries(NAMES).map(([id, [label, type]]) => ({
  netsuite_account_id: id, number: label.split(' ')[0], name: label.split(' ').slice(1).join(' '), account_type: type,
  company: id === '210' || id === '105' ? '1084' : id === '200' ? 'BMG' : null, active: true, is_summary: false,
}));

describe('gl_bill_payment_month (migration 389)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // September 2026: CHK1001 (BMG, paying B-701 and a bill with no number),
    // CHK1002 (BMG, with a discount), CHK1003 (1084, by a vendor the copy of
    // NetSuite's vendors doesn't have), CHK1007 dated in August but booked
    // into September, CHK1004 (in neither company's GL copy), CHK1005
    // (voided, $0 and in neither), CHK1006 dated in September but booked into
    // October, CHK1008 (gone from NetSuite), and CHK1009 in BMG's GL copy but
    // not copied yet. A bill and a customer payment, which aren't bill
    // payments.
    await gl(db, '801', 'VendPymt', 'CHK1001', '2026-09-08', 'BMG', [['0', '100', '0.00', '650.00'], ['1', '200', '650.00', '0.00']]);
    // Line ids out of text order, to show they come back in NetSuite's order.
    await gl(db, '802', 'VendPymt', 'CHK1002', '2026-09-12', 'BMG',
      [['10', '485', '0.00', '13.00'], ['0', '100', '0.00', '637.00'], ['2', '200', '650.00', '0.00']]);
    await gl(db, '803', 'VendPymt', 'CHK1003', '2026-09-15', '1084', [['0', '105', '0.00', '80.00'], ['1', '210', '80.00', '0.00']]);
    await gl(db, '807', 'VendPymt', 'CHK1007', '2026-08-31', 'BMG', [['0', '220', '0.00', '20.00'], ['1', '200', '20.00', '0.00']], '2026-09-01');
    await gl(db, '806', 'VendPymt', 'CHK1006', '2026-09-29', 'BMG', [['0', '100', '0.00', '10.00'], ['1', '200', '10.00', '0.00']], '2026-10-01');
    await gl(db, '808', 'VendPymt', 'CHK1008', '2026-09-27', 'BMG', [['0', '100', '0.00', '60.00'], ['1', '200', '60.00', '0.00']]);
    await gl(db, '809', 'VendPymt', 'CHK1009', '2026-09-28', 'BMG', [['0', '100', '0.00', '40.00'], ['1', '200', '40.00', '0.00']]);
    await gl(db, '701', 'VendBill', 'B-701', '2026-09-02', 'BMG', [['0', '200', '0.00', '400.00'], ['1', '530', '400.00', '0.00']]);
    await gl(db, '614', 'CustPymt', 'PMT614', '2026-09-12', 'BMG', [['0', '100', '50.00', '0.00'], ['1', '120', '0.00', '50.00']]);
    await listed(db, 'vendor', '50', 'Sample Supply Co', { payables_account: '200' });
    // NetSuite numbers vendors and items apart, so an item can have a vendor's id.
    await listed(db, 'item', '51', 'ROOF-KIT', { item_type: 'InvtPart', asset_account: '130' });
    await db.exec('SET ROLE service_role');
    await db.query('SELECT gl_netsuite_bill_payments_apply($1::jsonb)', [JSON.stringify({ rows: [
      doc('801', 'CHK1001', '2026-09-08', '650.00', {
        status_label: 'Online Bill Pay', links: [link('701', 'VendBill', 'B-701', '400.00'), link('702', 'VendBill', null, '250.00')],
      }),
      doc('802', 'CHK1002', '2026-09-12', '637.00', { links: [link('704', 'VendBill', 'B-704', '637.00'), link('705', 'VendCred', 'VC-705', null)] }),
      doc('803', 'CHK1003', '2026-09-15', '80.00', { vendor_netsuite_id: '51', vendor_name: 'V-51 Roof Co' }),
      doc('807', 'CHK1007', '2026-08-31', '20.00'),
      doc('804', 'CHK1004', '2026-09-25', '75.00'),
      doc('805', 'CHK1005', '2026-09-26', '0.00', { status_label: 'Voided', voided: true }),
      doc('806', 'CHK1006', '2026-09-29', '10.00'),
      doc('808', 'CHK1008', '2026-09-27', '60.00'),
    ] })]);
    await db.query('SELECT gl_netsuite_bill_payments_finish($1::jsonb)', [JSON.stringify({ netsuite_ids: ['801', '802', '803', '804', '805', '806', '807'] })]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const month = async (company: string | null, day: string) =>
    (await db.query<{ r: BillPaymentMonthData }>('SELECT gl_bill_payment_month($1, $2::date) AS r', [company, day])).rows[0].r;

  it('returns the company\'s bill payments NetSuite booked into the month, and those in neither company\'s GL copy', async () => {
    const bmg = await month('BMG', '2026-09-01');
    expect(bmg.payments.map((p) => [p.number, p.date, p.posting_month, p.companies])).toEqual([
      ['CHK1007', '2026-08-31', '2026-09-01', ['BMG']],
      ['CHK1001', '2026-09-08', '2026-09-01', ['BMG']],
      ['CHK1002', '2026-09-12', '2026-09-01', ['BMG']],
      ['CHK1004', '2026-09-25', null, []],
      ['CHK1005', '2026-09-26', null, []],
    ]);
    expect((await month('1084', '2026-09-15')).payments.map((p) => p.number)).toEqual(['CHK1003', 'CHK1004', 'CHK1005']);
    expect((await month(null, '2026-09-30')).payments.map((p) => p.number)).toEqual(['CHK1007', 'CHK1001', 'CHK1002', 'CHK1003', 'CHK1004', 'CHK1005']);
    expect((await month('BMG', '2026-10-01')).payments.map((p) => p.number)).toEqual(['CHK1006']);
    expect((await month('BMG', '2026-08-01')).payments).toEqual([]);
  });

  it('gives each what it paid, its vendor and NetSuite\'s GL lines in line order', async () => {
    const [, chk1001, chk1002, , chk1005] = (await month('BMG', '2026-09-01')).payments;
    expect(chk1001).toEqual({
      netsuite_id: '801', type: 'VendPymt', number: 'CHK1001', date: '2026-09-08', posting_month: '2026-09-01', total: '650.00', voided: false,
      status: 'Online Bill Pay', vendor: 'Sample Supply Co', vendor_netsuite_id: '50', vendor_payables: '200', companies: ['BMG'],
      links: [link('701', 'VendBill', 'B-701', '400.00'), link('702', 'VendBill', null, '250.00')],
      netsuite: [{ line_id: '0', account: '100', debit: '0.00', credit: '650.00' }, { line_id: '1', account: '200', debit: '650.00', credit: '0.00' }],
    });
    expect(chk1002.netsuite.map((l) => l.line_id)).toEqual(['0', '2', '10']);
    expect(chk1005).toMatchObject({ total: '0.00', voided: true, status: 'Voided', netsuite: [] });
    // A vendor the copy of NetSuite's vendors doesn't have is named as the payment names it, whatever item has its id.
    expect((await month('1084', '2026-09-01')).payments[0]).toMatchObject({ vendor: 'V-51 Roof Co', vendor_netsuite_id: '51', vendor_payables: null, links: [] });
  });

  it('names the bill payments in the company\'s GL copy for the month that aren\'t copied, or are gone', async () => {
    expect((await month('BMG', '2026-09-01')).not_copied).toEqual([
      { netsuite_id: '808', type: 'VendPymt', number: 'CHK1008' }, { netsuite_id: '809', type: 'VendPymt', number: 'CHK1009' },
    ]);
    expect((await month(null, '2026-09-01')).not_copied.map((m) => m.number)).toEqual(['CHK1008', 'CHK1009']);
    expect((await month('1084', '2026-09-01')).not_copied).toEqual([]);
    expect((await month('BMG', '2026-10-01')).not_copied).toEqual([]);
  });

  it('checks a month end to end', async () => {
    const m = checkBillPaymentMonth(await month('BMG', '2026-09-01'), { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 3, matches: 3, differs: 0, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.invoices.map((p) => [p.number, p.status, p.booked, p.applied])).toEqual([
      ['CHK1007', 'matches', { month: '2026-09-01', date: '2026-09-01' }, []],
      ['CHK1001', 'matches', undefined, [{ number: 'B-701', cents: 40000 }, { number: 'NetSuite bill 702', cents: 25000 }]],
      ['CHK1002', 'matches', undefined, [{ number: 'B-704', cents: 63700 }, { number: 'bill credit VC-705', cents: null }]],
    ]);
    expect(m.invoices.map((p) => p.rows.map((r) => [r.label, r.fleetsuite?.account, r.fleetsuite?.cents, r.same]))).toEqual([
      [['Payables', '200', 2000, true], ['Paid from', '220', -2000, true]],
      [['Payables', '200', 65000, true], ['Paid from', '100', -65000, true]],
      [['Payables', '200', 65000, true], ['Paid from', '100', -63700, true], ['Discount', '485', -1300, true]],
    ]);
    // The voided $0 payment with nothing posted is nothing to say.
    expect(m.notes).toEqual([
      '1 bill payment dated in another month is here because NetSuite booked it into this month: CHK1007.',
      "1 more bill payment dated this month isn't in the copy of NetSuite's GL for either company: CHK1004. NetSuite may have voided "
        + "or deleted it, or the copy, which runs every two hours, hasn't reached it yet.",
      "The copy of NetSuite's GL has 2 bill payments of this company's booked into this month that the copy of the bill payments "
        + "doesn't: CHK1008, CHK1009. The bill payments copy runs every two hours and may not have reached them yet, or NetSuite deleted "
        + "them and the GL copy hasn't caught up.",
    ]);
    const other = checkBillPaymentMonth(await month('1084', '2026-09-01'), { company: '1084', chart: CHART });
    expect(other.invoices.map((p) => [p.number, p.status, p.customer, p.rows.map((r) => [r.label, r.fleetsuite?.account, r.same])])).toEqual([
      ['CHK1003', 'matches', 'V-51 Roof Co', [['Payables', '210', true], ['Paid from', '105', true]]],
    ]);
  });
});

// ── The copy job ───────────────────────────────────────────────────────────

interface NsDoc {
  id: number;
  tranid: string | null;
  /** As SuiteQL gives it, M/D/YYYY. */
  trandate: string | null;
  total: number;
  status?: string;
  label?: string;
  vendor?: number | null;
  /** lastmodifieddate, YYYY-MM-DD. */
  modified: string;
}

const rejected = (detail: string) => Object.assign(
  new Error(`NetSuite SuiteQL error (400): {"o:errorDetails":[{"detail":"Invalid search query. Detailed unprocessed description follows. ${detail}"}]}`),
  { status: 400 },
);

class FakeNetSuite {
  docs: NsDoc[] = [];
  /** Documents the payments paid: bills and bill credits. */
  others: Array<{ id: number; type: string; tranid: string | null }> = [];
  links: Array<{ previousdoc: number; nextdoc: number; foreignamount: number | string | null; linktype: string | null }> = [];
  /** Columns and link tables this account refuses. */
  refuse = new Set<string>();
  /** The ids NetSuite lists when asked for all of them; every payment's when null. */
  ids: number[] | null = null;
  down = false;
  /** Called on every header page, so tests can move the clock. */
  onPage = () => {};
  headerPages = 0;

  page = async (q: string, limit: number): Promise<Record<string, unknown>[]> => {
    if (this.down) throw Object.assign(new Error('NetSuite SuiteQL error (503): unavailable'), { status: 503 });
    if (!q.includes("WHERE t.type = 'VendPymt'")) throw new Error(`unexpected page: ${q}`);
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
        id: x.id, type: 'VendPymt', tranid: x.tranid, trandate: x.trandate, status: x.status ?? null, memo: null, total: x.total,
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
      return this.links.filter((l) => ids.includes(l.nextdoc)).map((l) => ({ ...l }));
    }
    if (q.includes('SELECT t.id, t.type, t.tranid')) {
      return this.others.filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, type: x.type, tranid: x.tranid }));
    }
    if (q === BILL_PAYMENT_IDS_QUERY) return (this.ids ?? this.docs.map((x) => x.id)).sort((a, b) => a - b).map((id) => ({ id }));
    throw new Error(`unexpected query: ${q}`);
  };
}

function netsuite(): FakeNetSuite {
  const ns = new FakeNetSuite();
  ns.docs = [
    { id: 801, tranid: 'CHK1001', trandate: '9/8/2026', total: -650, status: 'Y', label: 'Online Bill Pay', vendor: 50, modified: '2026-09-20' },
    { id: 802, tranid: 'CHK1002', trandate: '9/12/2026', total: -637, vendor: 50, modified: '2026-09-12' },
    // NetSuite signs some totals the other way round; the copy keeps them positive.
    { id: 803, tranid: 'CHK1003', trandate: '9/15/2026', total: 80, vendor: 51, modified: '2026-09-15' },
    { id: 804, tranid: 'CHK1004', trandate: '9/20/2026', total: 0, status: 'V', label: 'Voided', vendor: 50, modified: '2026-09-20' },
    { id: 805, tranid: null, trandate: '10/2/2026', total: -200, vendor: null, modified: '2026-10-02' },
  ];
  ns.others = [
    { id: 701, type: 'VendBill', tranid: 'B-701' }, { id: 702, type: 'VendBill', tranid: null },
    { id: 703, type: 'VendCred', tranid: 'VC-703' }, { id: 704, type: 'VendBill', tranid: 'B-704' },
  ];
  ns.links = [
    { previousdoc: 701, nextdoc: 801, foreignamount: -400, linktype: 'Payment' },
    { previousdoc: 702, nextdoc: 801, foreignamount: '-250.00', linktype: 'Payment' },
    // NetSuite lists the payment of B-704 in two parts.
    { previousdoc: 704, nextdoc: 802, foreignamount: -300, linktype: 'Payment' },
    { previousdoc: 704, nextdoc: 802, foreignamount: -337, linktype: 'Payment' },
    { previousdoc: 703, nextdoc: 803, foreignamount: 20, linktype: 'Payment' },
    // What a bill came from isn't what a payment paid.
    { previousdoc: 601, nextdoc: 701, foreignamount: -400, linktype: 'Bill' },
  ];
  return ns;
}

describe('the copy job against the real functions', () => {
  let pg: PGlite;
  let clock = Date.parse('2026-10-16T15:21:00Z');
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

  const run = (ns: FakeNetSuite, opts: { pageSize?: number; budgetMs?: number } = {}) => copyNetSuiteBillPayments(service(), {
    deadline: clock + (opts.budgetMs ?? 240_000),
    deps: { query: ns.query, page: ns.page, pageSize: opts.pageSize ?? 2, now: () => clock },
  });
  const copied = async () => (await pg.query<{
    id: string; number: string | null; date: string; total: string; voided: boolean; label: string | null; vendor: string | null;
    vendor_id: string | null; links: Link[] | null; gone: boolean;
  }>(
    `SELECT netsuite_id AS id, tranid AS number, to_char(trandate, 'YYYY-MM-DD') AS date, total::text AS total, voided,
            status_label AS label, vendor_name AS vendor, vendor_netsuite_id AS vendor_id, links, gone_at IS NOT NULL AS gone
     FROM gl_netsuite_bill_payments ORDER BY netsuite_id::int`,
  )).rows;
  const recorded = () => store.get(BOOKS_BILL_PAYMENTS_SYNC);
  const CHK1001_PAID: Link[] = [
    { netsuite_id: '701', type: 'VendBill', number: 'B-701', amount: '400.00', link_type: 'Payment' },
    { netsuite_id: '702', type: 'VendBill', number: null, amount: '250.00', link_type: 'Payment' },
  ];

  it('copies every bill payment, newest first a page at a time, with what each paid', async () => {
    const ns = netsuite();
    const r = await run(ns);
    expect(r).toMatchObject({ read: 5, added: 5, changed: 0, gone: 0, linkTable: 'nexttransactionlinelink' });
    expect(r.error).toBeUndefined();
    expect(r.partial).toBeUndefined();
    expect(r.notes).toBeUndefined();
    expect(ns.headerPages).toBe(3);
    expect(await copied()).toEqual([
      { id: '801', number: 'CHK1001', date: '2026-09-08', total: '650.00', voided: false, label: 'Online Bill Pay', vendor: 'V-50 Vendor Co', vendor_id: '50',
        gone: false, links: CHK1001_PAID },
      { id: '802', number: 'CHK1002', date: '2026-09-12', total: '637.00', voided: false, label: null, vendor: 'V-50 Vendor Co', vendor_id: '50', gone: false,
        links: [{ netsuite_id: '704', type: 'VendBill', number: 'B-704', amount: '637.00', link_type: 'Payment' }] },
      { id: '803', number: 'CHK1003', date: '2026-09-15', total: '80.00', voided: false, label: null, vendor: 'V-51 Vendor Co', vendor_id: '51', gone: false,
        links: [{ netsuite_id: '703', type: 'VendCred', number: 'VC-703', amount: '20.00', link_type: 'Payment' }] },
      { id: '804', number: 'CHK1004', date: '2026-09-20', total: '0.00', voided: true, label: 'Voided', vendor: 'V-50 Vendor Co', vendor_id: '50', gone: false,
        links: [] },
      { id: '805', number: null, date: '2026-10-02', total: '200.00', voided: false, label: null, vendor: null, vendor_id: null, gone: false, links: [] },
    ]);
    // The window closed at the time it was opened, and the record holds counts and words, never an amount.
    const record = recorded();
    expect(record.last_synced_at).toBe(new Date(clock).toISOString());
    expect(record.last_result).toEqual({ read: 5, added: 5, changed: 0, gone: 0, linkTable: 'nexttransactionlinelink' });
  });

  it('reads only what NetSuite changed since the last run, a day\'s overlap included', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs[2] = { ...ns.docs[2], total: 85, modified: '2026-10-16' };
    const r = await run(ns);
    expect(r).toMatchObject({ read: 1, added: 0, changed: 1, gone: 0 });
    expect((await copied()).find((d) => d.id === '803')?.total).toBe('85.00');
  });

  it('carries on where a run cut short by time stopped, and closes the window only when it drains', async () => {
    store.delete(BOOKS_BILL_PAYMENTS_SYNC);
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
    expect(r.notes).toEqual(['NetSuite listed 1 bill payments and FleetSuite has 4, so none were marked gone.']);
    expect((await copied()).filter((d) => !d.gone).map((d) => d.id)).toEqual(['801', '802', '803', '805']);
  });

  it('reads the links from the other table when NetSuite refuses one, and keeps them when it refuses both', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    // NetSuite deleted CHK1004 in the test before; it stays deleted.
    ns.docs = ns.docs.filter((d) => d.id !== 804).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.refuse.add('nexttransactionlinelink');
    const r = await run(ns);
    expect(r).toMatchObject({ read: 4, linkTable: 'previoustransactionlinelink', changed: 0 });
    expect(r.notes).toBeUndefined();

    clock += 2 * 3600_000;
    ns.refuse.add('previoustransactionlinelink');
    ns.links = [];
    // CHK1002 changed in NetSuite too, so its row is rewritten in a run that can't read links.
    ns.docs = ns.docs.map((d) => (d.id === 802 ? { ...d, total: -640 } : d));
    const both = await run(ns);
    expect(both).toMatchObject({ read: 4, linkTable: null, changed: 1 });
    expect(both.notes).toEqual([
      "NetSuite wouldn't list what the payments are linked to (NetSuite SuiteQL error (400): Invalid search query. Detailed unprocessed "
        + "description follows. Search error occurred: Record 'previoustransactionlinelink' was not found.), so which bills each one "
        + "paid isn't copied this time.",
    ]);
    expect((await copied()).find((d) => d.id === '802')).toMatchObject({ total: '640.00' });
    expect((await copied()).find((d) => d.id === '802')?.links).toHaveLength(1);
    expect((await copied()).find((d) => d.id === '801')?.links).toEqual(CHK1001_PAID);
  });

  it('copies without the status and vendor in words when NetSuite won\'t give them, and says so', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 804).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.refuse.add('BUILTIN.DF');
    const r = await run(ns);
    expect(r.notes).toEqual([
      "NetSuite wouldn't give the payments' status in words, so voided ones aren't marked as voided, and vendors are named from the copy "
        + "of NetSuite's vendors.",
    ]);
    expect((await copied()).find((d) => d.id === '801')).toMatchObject({ label: null, voided: false, vendor: null, vendor_id: '50' });
  });

  it('names a payment it can\'t copy and copies the rest', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 804).map((d) => ({ ...d, modified: '2026-10-16' }));
    ns.docs.push({ id: 806, tranid: 'CHK1006', trandate: null, total: -10, vendor: 50, modified: '2026-10-16' });
    const r = await run(ns);
    expect(r).toMatchObject({ read: 5, added: 0 });
    expect(r.notes).toEqual(["NetSuite sent a bill payment with no date or a total FleetSuite can't read, so it isn't copied: CHK1006."]);
    expect((await copied()).map((d) => d.id)).toEqual(['801', '802', '803', '804', '805']);
  });

  it('records what failed, and keeps its place, when NetSuite stops answering', async () => {
    clock += 2 * 3600_000;
    store.delete(BOOKS_BILL_PAYMENTS_SYNC);
    const ns = netsuite();
    let pages = 0;
    ns.onPage = () => {
      if (++pages === 2) ns.down = true;
    };
    const r = await run(ns);
    // The second page was read, then NetSuite stopped answering: the copy picks up below the first page next time.
    expect(r.error).toBe('what bill payments below NetSuite id 804 paid: NetSuite SuiteQL error (503): unavailable');
    expect(recorded().last_result).toMatchObject({ read: 4, error: r.error, resume: { beforeId: '804', processed: 2 } });
    expect(recorded().last_synced_at).toBeUndefined();
  });

  it('leaves looking for what NetSuite deleted to the next run when there isn\'t time left', async () => {
    clock += 2 * 3600_000;
    store.delete(BOOKS_BILL_PAYMENTS_SYNC);
    const ns = netsuite();
    // NetSuite deleted the payment without a number. Each page takes 25 s: with 60 s, the copy drains with too little left to list every id.
    ns.docs = ns.docs.filter((d) => d.id !== 805);
    ns.onPage = () => {
      clock += 25_000;
    };
    const r = await run(ns, { pageSize: 3, budgetMs: 60_000 });
    expect(r).toMatchObject({ read: 4 });
    expect(r.partial).toBeUndefined();
    expect(r.gone).toBeUndefined();
    expect(r.notes).toEqual(["There wasn't time left to check for payments NetSuite no longer has; the next run will."]);
    expect((await copied()).find((d) => d.id === '805')?.gone).toBe(false);

    clock += 2 * 3600_000;
    expect(await run(ns)).toMatchObject({ read: 0, gone: 1 });
    expect((await copied()).find((d) => d.id === '805')?.gone).toBe(true);
  });
});
