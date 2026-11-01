// Migration 481 keeps which NetSuite accounts count toward a 1099 and reads a
// company's year for the 1099 dry run. This runs the books migrations it
// reads from (359–363, 384, 389, 391) and 481 in an in-memory Postgres
// (PGlite) as the app's server login and holds the functions' rules, reads
// a made-up year end to end through the rule (src/lib/books/1099s.ts), and
// runs the chart copy's read of the 1099 accounts against a fake NetSuite.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { buildYear1099, type Year1099Data } from './1099s';
import { ACCOUNTS_QUERY, ACCOUNT_1099_QUERY, ACCOUNT_SUBSIDIARIES_QUERY, SUBSIDIARIES_QUERY, syncBooksAccounts } from './netsuite-accounts';

// A fresh database with Supabase's API roles and default grants, and the
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
  `);
  for (const file of [
    '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '384-books-vendor-bills.sql',
    '389-books-bill-payments.sql', '391-books-checks-and-cards.sql', '481-books-1099s.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  return pg;
}

/** A NetSuite document in the GL copy with its lines: [line id, account, debit, credit]. */
async function gl(pg: PGlite, id: string, type: string, number: string, date: string, company: string, lines: Array<[string, string, string, string]>) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4::date, date_trunc('month', $4::date)::date, 'x', 's')`,
    [id, type, number, date],
  );
  for (const [lineId, account, debit, credit] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, date_trunc('month', $6::date)::date, $6::date, $4, $5 FROM gl_companies WHERE code = $7`,
      [id, lineId, account, debit, credit, date, company],
    );
  }
}

const vendor = (pg: PGlite, id: string, name: string, details: Record<string, string>) => pg.query(
  `INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ('vendor', $1, $2, true, $3::jsonb)`,
  [id, name, JSON.stringify(details)],
);

// Made-up books: '100' checking, '200' payables and '220' a company card
// (BMG's), '105' checking (1084's); '530' subcontractors and '540' rent,
// which count toward a 1099, and '610' shop supplies, which doesn't.
const CHART: Array<[string, string, string, string]> = [
  ['100', '1000', 'Checking', 'bank'], ['105', '1050', '1084 Checking', 'bank'], ['200', '2000', 'Accounts Payable', 'accounts_payable'],
  ['220', '2200', 'Company Card', 'credit_card'], ['530', '5300', 'Subcontractors', 'expense'], ['540', '5400', 'Rent', 'expense'],
  ['610', '6100', 'Shop Supplies', 'expense'],
];

const COUNTED = [
  { netsuite_account_id: '530', category: 'Nonemployee Compensation', category_id: '7' },
  { netsuite_account_id: '540', category: 'Rents', category_id: '1' },
];

type Link = { netsuite_id: string; type: string | null; number: string | null; amount: string; link_type: null };
const link = (id: string, type: string | null, number: string | null, amount: string): Link => ({ netsuite_id: id, type, number, amount, link_type: null });
const billPayment = (id: string, number: string, date: string, payee: string, total: string, links: Link[], fields: Record<string, unknown> = {}) => ({
  netsuite_id: id, tran_type: 'VendPymt', tranid: number, trandate: date, vendor_netsuite_id: payee, vendor_name: `V-${payee}`,
  total, status: null, status_label: null, voided: false, memo: null, links, ...fields,
});
const spent = (id: string, type: string, number: string, date: string, payee: string, total: string, fields: Record<string, unknown> = {}) => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date, payee_netsuite_id: payee, payee_name: `P-${payee}`,
  total, status: null, status_label: null, voided: false, memo: null, lines: [], ...fields,
});

describe('the 1099 accounts copy (migration 481)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const apply = async (accounts: unknown[]) =>
    (await db.query<{ r: Record<string, unknown> }>('SELECT gl_netsuite_1099_accounts_apply($1::jsonb) AS r', [JSON.stringify({ accounts })])).rows[0].r;
  const stored = async () => (await db.query<{ id: string; category: string; category_id: string | null; changed_at: string }>(
    'SELECT netsuite_account_id AS id, category, category_id, changed_at::text AS changed_at FROM gl_netsuite_1099_accounts ORDER BY 1',
  )).rows;

  it("adds NetSuite's list, and changes nothing when it's the same again", async () => {
    expect(await apply(COUNTED)).toEqual({ received: 2, added: 2, changed: 0, removed: 0, here: 0, cut_short: false });
    const before = await stored();
    expect(before.map((r) => [r.id, r.category, r.category_id])).toEqual([['530', 'Nonemployee Compensation', '7'], ['540', 'Rents', '1']]);
    expect(await apply(COUNTED)).toEqual({ received: 2, added: 0, changed: 0, removed: 0, here: 2, cut_short: false });
    expect(await stored()).toEqual(before);
  });

  it('follows a change of category, and takes off an account NetSuite no longer lists', async () => {
    const more = [...COUNTED, { netsuite_account_id: '545', category: 'Rents', category_id: '1' }];
    expect(await apply(more)).toMatchObject({ added: 1, changed: 0, removed: 0 });
    expect(await apply([{ ...COUNTED[0], category: ' Other Income ', category_id: '3' }, COUNTED[1], more[2]]))
      .toMatchObject({ added: 0, changed: 1, removed: 0 });
    expect((await stored())[0]).toMatchObject({ id: '530', category: 'Other Income', category_id: '3' });
    expect(await apply([COUNTED[0], COUNTED[1]])).toEqual({ received: 2, added: 0, changed: 1, removed: 1, here: 3, cut_short: false });
    expect((await stored()).map((r) => r.id)).toEqual(['530', '540']);
  });

  it('takes nothing off when the list looks cut short: none, or under half of what it has', async () => {
    expect(await apply([])).toEqual({ received: 0, added: 0, changed: 0, removed: 0, here: 2, cut_short: true });
    await apply([...COUNTED, ...['546', '547'].map((id) => ({ netsuite_account_id: id, category: 'Rents' }))]);
    expect(await apply([COUNTED[0]])).toMatchObject({ received: 1, removed: 0, here: 4, cut_short: true });
    expect((await stored()).map((r) => r.id)).toEqual(['530', '540', '546', '547']);
    // Half is still a list to follow.
    expect(await apply(COUNTED)).toMatchObject({ removed: 2, cut_short: false });
  });

  it('refuses a bad list whole, changing nothing', async () => {
    const before = await stored();
    await expect(apply([COUNTED[0], COUNTED[0]])).rejects.toThrow(/NetSuite account 530 is in the list twice/);
    await expect(apply([{ ...COUNTED[0], netsuite_account_id: 'x5' }])).rejects.toThrow(/NetSuite account id "x5" isn't a number/);
    await expect(apply([{ category: 'Rents' }])).rejects.toThrow(/NetSuite account id "\(none\)" isn't a number/);
    await expect(apply([COUNTED[1], { netsuite_account_id: '560', category: ' ' }])).rejects.toThrow(/NetSuite account 560 has no 1099 category/);
    await expect(apply([COUNTED[1], { netsuite_account_id: '561' }])).rejects.toThrow(/NetSuite account 561 has no 1099 category/);
    await expect(apply([{ ...COUNTED[1], category_id: 'Rents' }])).rejects.toThrow(/check constraint/);
    await expect(db.query('SELECT gl_netsuite_1099_accounts_apply($1::jsonb)', [JSON.stringify({})])).rejects.toThrow(/accounts must be a list/);
    expect(await stored()).toEqual(before);
  });

  it('lets only the service role read the copy or run the functions, and every write in them is bounded', async () => {
    for (const fn of ['gl_netsuite_1099_accounts_apply(jsonb)', 'gl_1099_year(text, integer)']) {
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(false);
      }
      const s = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn]);
      expect(s.rows[0].ok, fn).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      const t = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'gl_netsuite_1099_accounts', 'SELECT') AS ok`, [role]);
      expect(t.rows[0].ok, role).toBe(false);
    }
    const rls = await db.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'gl_netsuite_1099_accounts'`);
    expect(rls.rows[0].on).toBe(true);

    // Supabase's API connections fail an UPDATE or DELETE with no WHERE, even inside a function (migrations/README.md).
    const body = async (name: string) => (await db.query<{ b: string }>(`SELECT prosrc AS b FROM pg_proc WHERE proname = $1`, [name])).rows[0].b;
    const applyBody = await body('gl_netsuite_1099_accounts_apply');
    expect(applyBody.match(/\b(INSERT|UPDATE|DELETE)\b/g)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    expect(applyBody).toMatch(/ON CONFLICT \(netsuite_account_id\) DO UPDATE SET/);
    expect(applyBody).toMatch(/DELETE FROM public\.gl_netsuite_1099_accounts a\s+WHERE NOT EXISTS/);
    expect(await body('gl_1099_year')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});

describe('gl_1099_year (migration 481)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    for (const [id, number, name, type] of CHART) {
      await db.query('INSERT INTO gl_accounts (netsuite_account_id, number, name, account_type) VALUES ($1, $2, $3, $4)', [id, number, name, type]);
    }
    // 2025 for V-50 Sample Painting, marked to get a 1099: CHK2001 for
    // painting; BP-801 paying B-701 (half painting, half supplies) with a
    // credit for painting; BP-802 paying a bill from before the GL copy
    // starts; CHK2010, not in the GL copy yet; and a voided check. V-52
    // Placeholder Labor isn't marked but is paid for labor by CHK2002 and
    // BP-804; V-53 Test Supply isn't marked and is paid only for supplies.
    // V-55 Sample Cards is marked and paid only by card. 1084 pays V-51
    // Example Rentals its rent. CHK2011 and BP-803 are in BMG's GL copy but
    // not the copies of the payments (BP-803 gone from NetSuite). Around the
    // year's edges: CHK2013 for V-57 Example Hardware on its first day,
    // BP-806 on the next year's first. BP-807 was voided, and BP-808 paid
    // nothing. BP-804's link came without its type or number, which the GL
    // copy has.
    await gl(db, '701', 'VendBill', 'B-701', '2025-01-20', 'BMG', [['0', '200', '0.00', '1000.00'], ['1', '530', '500.00', '0.00'], ['2', '610', '500.00', '0.00']]);
    await gl(db, '702', 'VendCred', 'BC-702', '2025-01-25', 'BMG', [['0', '200', '100.00', '0.00'], ['1', '530', '0.00', '100.00']]);
    await gl(db, '705', 'VendBill', 'B-705', '2025-05-20', 'BMG', [['0', '200', '0.00', '500.00'], ['1', '530', '500.00', '0.00']]);
    await gl(db, '706', 'VendBill', 'B-706', '2025-05-21', 'BMG', [['0', '200', '0.00', '70.00'], ['1', '610', '70.00', '0.00']]);
    await gl(db, '801', 'VendPymt', 'BP-801', '2025-02-01', 'BMG', [['0', '200', '900.00', '0.00'], ['1', '100', '0.00', '900.00']]);
    await gl(db, '802', 'VendPymt', 'BP-802', '2025-02-15', 'BMG', [['0', '200', '300.00', '0.00'], ['1', '100', '0.00', '300.00']]);
    await gl(db, '803', 'VendPymt', 'BP-803', '2025-03-01', 'BMG', [['0', '200', '20.00', '0.00'], ['1', '100', '0.00', '20.00']]);
    await gl(db, '804', 'VendPymt', 'BP-804', '2025-06-01', 'BMG', [['0', '200', '500.00', '0.00'], ['1', '100', '0.00', '500.00']]);
    await gl(db, '805', 'VendPymt', 'BP-805', '2025-06-02', 'BMG', [['0', '200', '70.00', '0.00'], ['1', '100', '0.00', '70.00']]);
    await gl(db, '806', 'VendPymt', 'BP-806', '2026-01-01', 'BMG', [['0', '200', '25.00', '0.00'], ['1', '100', '0.00', '25.00']]);
    await gl(db, '807', 'VendPymt', 'BP-807', '2025-07-03', 'BMG', [['0', '200', '0.00', '0.00'], ['1', '100', '0.00', '0.00']]);
    await gl(db, '808', 'VendPymt', 'BP-808', '2025-07-04', 'BMG', [['0', '200', '0.00', '0.00'], ['1', '100', '0.00', '0.00']]);
    await gl(db, '901', 'Check', 'CHK2001', '2025-03-04', 'BMG', [['0', '100', '0.00', '1200.00'], ['1', '530', '1200.00', '0.00']]);
    await gl(db, '902', 'Check', 'CHK2002', '2025-04-01', 'BMG', [['0', '100', '0.00', '800.00'], ['1', '530', '800.00', '0.00']]);
    await gl(db, '903', 'Check', 'CHK2003', '2025-04-02', 'BMG', [['0', '100', '0.00', '90.00'], ['1', '610', '90.00', '0.00']]);
    await gl(db, '904', 'Check', 'CHK2004', '2025-04-03', 'BMG', [['0', '100', '0.00', '75.00'], ['1', '530', '75.00', '0.00']]);
    await gl(db, '906', 'Check', 'CHK2006', '2026-01-02', 'BMG', [['0', '100', '0.00', '60.00'], ['1', '530', '60.00', '0.00']]);
    await gl(db, '907', 'Check', 'CHK2007', '2025-05-05', '1084', [['0', '105', '0.00', '2400.00'], ['1', '540', '2400.00', '0.00']]);
    await gl(db, '908', 'CardChrg', 'CC-908', '2025-05-01', 'BMG', [['0', '220', '0.00', '45.00'], ['1', '610', '45.00', '0.00']]);
    await gl(db, '909', 'CardChrg', 'CC-909', '2025-05-02', 'BMG', [['0', '220', '0.00', '12.00'], ['1', '530', '12.00', '0.00']]);
    await gl(db, '911', 'Check', 'CHK2011', '2025-08-01', 'BMG', [['0', '100', '0.00', '30.00'], ['1', '610', '30.00', '0.00']]);
    await gl(db, '913', 'Check', 'CHK2013', '2025-01-01', 'BMG', [['0', '100', '0.00', '15.00'], ['1', '610', '15.00', '0.00']]);
    await vendor(db, '50', 'V-50 Sample Painting', { is_1099: 'T', legal_name: 'Sample Painting LLC' });
    await vendor(db, '51', 'V-51 Example Rentals', { is_1099: 'T' });
    await vendor(db, '52', 'V-52 Placeholder Labor', { is_1099: 'F' });
    await vendor(db, '53', 'V-53 Test Supply', { is_1099: 'F' });
    await vendor(db, '55', 'V-55 Sample Cards', { is_1099: 'T' });
    await vendor(db, '56', 'V-56 Unpaid Example', { is_1099: 'T' });
    await vendor(db, '57', 'V-57 Example Hardware', { is_1099: 'T' });
    await db.exec('SET ROLE service_role');
    await db.query('SELECT gl_netsuite_1099_accounts_apply($1::jsonb)', [JSON.stringify({ accounts: COUNTED })]);
    await db.query('SELECT gl_netsuite_bill_payments_apply($1::jsonb)', [JSON.stringify({ rows: [
      billPayment('801', 'BP-801', '2025-02-01', '50', '900.00', [link('701', 'VendBill', 'B-701', '1000.00'), link('702', 'VendCred', 'BC-702', '100.00')]),
      billPayment('802', 'BP-802', '2025-02-15', '50', '300.00', [link('699', 'VendBill', 'B-699', '300.00')]),
      billPayment('803', 'BP-803', '2025-03-01', '50', '20.00', []),
      billPayment('804', 'BP-804', '2025-06-01', '52', '500.00', [link('705', null, null, '500.00')]),
      billPayment('805', 'BP-805', '2025-06-02', '53', '70.00', [link('706', 'VendBill', 'B-706', '70.00')]),
      billPayment('806', 'BP-806', '2026-01-01', '50', '25.00', []),
      billPayment('807', 'BP-807', '2025-07-03', '50', '40.00', [link('705', 'VendBill', 'B-705', '40.00')], { voided: true, status_label: 'Voided' }),
      billPayment('808', 'BP-808', '2025-07-04', '50', '0.00', [link('705', 'VendBill', 'B-705', '20.00'), link('702', 'VendCred', 'BC-702', '20.00')]),
    ] })]);
    await db.query('SELECT gl_netsuite_bill_payments_finish($1::jsonb)', [JSON.stringify({ netsuite_ids: ['801', '802', '804', '805', '806', '807', '808'] })]);
    await db.query('SELECT gl_netsuite_spending_apply($1::jsonb)', [JSON.stringify({ rows: [
      spent('901', 'Check', 'CHK2001', '2025-03-04', '50', '1200.00'),
      spent('902', 'Check', 'CHK2002', '2025-04-01', '52', '800.00'),
      spent('903', 'Check', 'CHK2003', '2025-04-02', '53', '90.00'),
      spent('904', 'Check', 'CHK2004', '2025-04-03', '50', '75.00', { voided: true, status_label: 'Voided' }),
      spent('905', 'Check', 'CHK2005', '2024-12-31', '50', '40.00'),
      spent('906', 'Check', 'CHK2006', '2026-01-02', '50', '60.00'),
      spent('907', 'Check', 'CHK2007', '2025-05-05', '51', '2400.00'),
      spent('908', 'CardChrg', 'CC-908', '2025-05-01', '55', '45.00'),
      spent('909', 'CardChrg', 'CC-909', '2025-05-02', '53', '12.00'),
      spent('910', 'Check', 'CHK2010', '2025-07-01', '50', '50.00'),
      spent('912', 'Check', 'CHK2012', '2025-07-02', '50', '0.00'),
      spent('913', 'Check', 'CHK2013', '2025-01-01', '57', '15.00'),
    ] })]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const year = async (company: string, y: number) =>
    (await db.query<{ r: Year1099Data }>('SELECT gl_1099_year($1, $2) AS r', [company, y])).rows[0].r;

  it("returns the company's payments dated in the year that count, or might: to marked vendors, or on accounts that count", async () => {
    const bmg = await year('BMG', 2025);
    expect(bmg.payments.map((p) => [p.number, p.type, p.date, p.payee, p.total])).toEqual([
      ['CHK2013', 'Check', '2025-01-01', '57', '15.00'],
      ['BP-801', 'VendPymt', '2025-02-01', '50', '900.00'],
      ['BP-802', 'VendPymt', '2025-02-15', '50', '300.00'],
      ['CHK2001', 'Check', '2025-03-04', '50', '1200.00'],
      ['CHK2002', 'Check', '2025-04-01', '52', '800.00'],
      ['CC-908', 'CardChrg', '2025-05-01', '55', '45.00'],
      ['BP-804', 'VendPymt', '2025-06-01', '52', '500.00'],
      ['CHK2010', 'Check', '2025-07-01', '50', '50.00'],
    ]);
    // 1084's rent, and the check in neither company's GL copy, which comes back for both.
    expect((await year('1084', 2025)).payments.map((p) => p.number)).toEqual(['CHK2007', 'CHK2010']);
    // A voided one, or one that paid nothing, isn't paid; the next year starts on its first day.
    expect((await year('BMG', 2026)).payments.map((p) => p.number)).toEqual(['BP-806', 'CHK2006']);
    expect((await year('BMG', 2024)).payments.map((p) => p.number)).toEqual(['CHK2005']);
  });

  it('gives each its GL lines, and a bill payment what it paid with each document\'s own lines', async () => {
    const [, bp801, bp802, chk2001, , , bp804] = (await year('BMG', 2025)).payments;
    expect(chk2001).toEqual({
      netsuite_id: '901', type: 'Check', number: 'CHK2001', date: '2025-03-04', payee: '50', payee_name: 'P-50', total: '1200.00',
      lines: [{ account: '100', debit: '0.00', credit: '1200.00' }, { account: '530', debit: '1200.00', credit: '0.00' }],
      links: null,
    });
    expect(bp801.links).toEqual([
      { netsuite_id: '701', type: 'VendBill', number: 'B-701', amount: '1000.00', lines: [
        { account: '200', debit: '0.00', credit: '1000.00' }, { account: '530', debit: '500.00', credit: '0.00' }, { account: '610', debit: '500.00', credit: '0.00' },
      ] },
      { netsuite_id: '702', type: 'VendCred', number: 'BC-702', amount: '100.00', lines: [
        { account: '200', debit: '100.00', credit: '0.00' }, { account: '530', debit: '0.00', credit: '100.00' },
      ] },
    ]);
    // A bill from before the GL copy starts has no lines to give.
    expect(bp802.links).toEqual([{ netsuite_id: '699', type: 'VendBill', number: 'B-699', amount: '300.00', lines: null }]);
    // What the link didn't say, the GL copy does.
    expect(bp804.links).toEqual([{ netsuite_id: '705', type: 'VendBill', number: 'B-705', amount: '500.00', lines: [
      { account: '200', debit: '0.00', credit: '500.00' }, { account: '530', debit: '500.00', credit: '0.00' },
    ] }]);
  });

  it('names the vendors among the payees, the chart, the accounts that count, and what the copies lack', async () => {
    const bmg = await year('BMG', 2025);
    expect(bmg.payees).toEqual([
      { netsuite_id: '50', name: 'V-50 Sample Painting', entity_id: null, legal_name: 'Sample Painting LLC', is_1099: 'T' },
      { netsuite_id: '52', name: 'V-52 Placeholder Labor', entity_id: null, legal_name: null, is_1099: 'F' },
      { netsuite_id: '55', name: 'V-55 Sample Cards', entity_id: null, legal_name: null, is_1099: 'T' },
      { netsuite_id: '57', name: 'V-57 Example Hardware', entity_id: null, legal_name: null, is_1099: 'T' },
    ]);
    expect(bmg.accounts.map((a) => [a.netsuite_id, a.number, a.type])).toEqual(CHART.map(([id, number, , type]) => [id, number, type]));
    expect(bmg.categories).toEqual([{ netsuite_id: '530', category: 'Nonemployee Compensation' }, { netsuite_id: '540', category: 'Rents' }]);
    expect(bmg.flags_copied).toBe(true);
    expect(bmg.not_copied).toEqual([
      { netsuite_id: '803', type: 'VendPymt', number: 'BP-803', date: '2025-03-01' },
      { netsuite_id: '911', type: 'Check', number: 'CHK2011', date: '2025-08-01' },
    ]);
    expect((await year('1084', 2025)).not_copied).toEqual([]);
  });

  it('works out the year end to end', async () => {
    const bmg = buildYear1099(await year('BMG', 2025));
    expect(bmg.forms.map((f) => [f.name, f.legalName, f.boxes, f.paid, f.unsplit])).toEqual([
      // CHK2001's 1,200.00, and BP-801's 900.00 over B-701 less BC-702: 500.00 less 100.00 of painting.
      ['V-50 Sample Painting', 'Sample Painting LLC', { 'Nonemployee Compensation': 160000 }, 245000, 35000],
    ]);
    expect(bmg.notMarked.map((p) => [p.name, p.boxes])).toEqual([['V-52 Placeholder Labor', { 'Nonemployee Compensation': 130000 }]]);
    expect(bmg.byCard.map((p) => [p.name, p.byCard])).toEqual([['V-55 Sample Cards', 4500]]);
    expect(bmg.nothingCounted.map((p) => [p.name, p.paid])).toEqual([['V-57 Example Hardware', 1500]]);
    expect(bmg.unsplit.map((p) => [p.number, p.unsplit])).toEqual([
      ['BP-802', { kind: 'doc_not_in_ledger', type: 'VendBill', number: 'B-699' }],
      ['CHK2010', { kind: 'not_in_ledger' }],
    ]);
    expect(bmg.totals).toEqual({ boxes: { 'Nonemployee Compensation': 160000 }, total: 160000 });
    const other = buildYear1099(await year('1084', 2025));
    expect(other.forms.map((f) => [f.name, f.boxes])).toEqual([['V-51 Example Rentals', { Rents: 240000 }]]);
  });

  it('says when no vendor has a 1099 flag copied yet', async () => {
    await db.exec('RESET ROLE');
    await db.exec(`UPDATE gl_netsuite_lists SET details = details - 'is_1099' WHERE kind = 'vendor'`);
    await db.exec('SET ROLE service_role');
    const bmg = await year('BMG', 2025);
    expect(bmg.flags_copied).toBe(false);
    // Only what's on accounts that count comes back now, and nobody is marked.
    expect(bmg.payments.map((p) => p.number)).toEqual(['BP-801', 'CHK2001', 'CHK2002', 'BP-804']);
    expect(buildYear1099(bmg).forms).toEqual([]);
  });
});

describe("the chart copy's read of the accounts that count toward a 1099", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  // Just enough of supabase-js for the chart copy: its companies and its two functions.
  const service = () => ({
    from: () => ({ select: async () => ({ data: (await db.query('SELECT code, name, netsuite_subsidiary_id FROM gl_companies')).rows, error: null }) }),
    rpc: async (fn: string, args: { p: unknown }) => {
      try {
        return { data: (await db.query<{ r: unknown }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(args.p)])).rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  }) as any;
  const netsuite = (counted: () => unknown[]) => async (q: string) => {
    if (q === ACCOUNTS_QUERY) return CHART.map(([id, number, name, type]) => ({ id, acctnumber: number, acctname: name, accttype: type === 'bank' ? 'Bank' : type === 'credit_card' ? 'CredCard' : type === 'accounts_payable' ? 'AcctPay' : 'Expense', isinactive: 'F', issummary: 'F' }));
    if (q === ACCOUNT_SUBSIDIARIES_QUERY || q === SUBSIDIARIES_QUERY) return [];
    if (q === ACCOUNT_1099_QUERY) return counted();
    throw new Error(`unexpected query ${q}`);
  };
  const copied = async () => (await db.query<{ id: string; category: string }>('SELECT netsuite_account_id AS id, category FROM gl_netsuite_1099_accounts ORDER BY 1')).rows;

  it('copies them with the chart, and keeps them when NetSuite later won\'t say', async () => {
    const r = await syncBooksAccounts(service(), { query: netsuite(() => [
      { id: 530, category_id: 7, category: 'Nonemployee Compensation' }, { id: 540, category_id: 1, category: 'Rents' },
    ]) });
    expect(r).toMatchObject({ received: 7, accounts1099: { received: 2, added: 2, changed: 0, removed: 0 } });
    expect(r.error).toBeUndefined();
    expect(await copied()).toEqual([{ id: '530', category: 'Nonemployee Compensation' }, { id: '540', category: 'Rents' }]);

    const refused = await syncBooksAccounts(service(), { query: netsuite(() => { throw new Error("Field 'category1099misc' for record 'account' was not found"); }) });
    expect(refused.accounts1099).toEqual({ error: "Field 'category1099misc' for record 'account' was not found" });
    expect(refused.error).toBeUndefined();
    expect(await copied()).toHaveLength(2);

    // NetSuite listing none at all looks cut short, so the copy keeps them and says so.
    const none = await syncBooksAccounts(service(), { query: netsuite(() => []) });
    expect(none.notes).toContain('NetSuite listed 0 accounts that count toward a 1099 and FleetSuite has 2, so none were taken off.');
    expect(await copied()).toHaveLength(2);
  });
});
