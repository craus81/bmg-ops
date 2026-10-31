// Migration 386 reads what the journal holds for NetSuite's vendor bills and
// bill credits, and lets the differences page say what the copy of the bills
// holds for one; the posting job posts them with the bill rule, even to an
// account NetSuite has made inactive since (migration 387). This runs
// migration 314 (with stand-ins for the app tables it points at) and
// migrations 359–364, 367, 370, 374, 376, 377, 380 and 382–387, with the
// ones the job reads bill payments, checks, card charges, journal entries,
// bank deposits, transfers, refunds and stock documents through (389–395,
// 397 and 399),
// in an in-memory Postgres
// (PGlite) as the app's server login and holds the functions' rules, then
// runs the posting job against them with bills only.
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
  recordHeartbeat: vi.fn(async (service: any, syncType: string, lastResult: unknown, opts?: { touchLastSyncedAt?: boolean }) => {
    await service.from('sync_state').upsert({ sync_type: syncType, last_result: lastResult, synced: opts?.touchLastSyncedAt !== false });
    return { ok: true };
  }),
}));

import { BOOKS_INVOICE_POSTING, postInvoices, type BillPosting } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { NETSUITE_TYPE } from './differences';

/**
 * Made-up chart: '200' BMG's payables, '210' 1084's, '205' received not
 * billed, '130' inventory, '530' subcontractors, '531' subcontractors no
 * longer used, '532' subcontractors only 1084 may use, '610' shop supplies,
 * '480' vendor discounts, '615' building repairs.
 */
const ACCOUNTS: Array<[string, string, string, string, 'BMG' | '1084' | null, boolean]> = [
  ['200', '2000', 'Accounts Payable', 'accounts_payable', 'BMG', true],
  ['210', '2100', 'Accounts Payable 1084', 'accounts_payable', '1084', true],
  ['205', '2050', 'Received Not Billed', 'other_current_liability', null, true],
  ['130', '1300', 'Inventory', 'other_current_asset', null, true],
  ['530', '5300', 'Subcontractors', 'expense', null, true],
  ['531', '5310', 'Old Subcontractors', 'expense', null, false],
  ['532', '5320', 'Subcontractors 1084', 'expense', '1084', true],
  ['610', '6100', 'Shop Supplies', 'expense', null, true],
  ['480', '4800', 'Vendor Discounts', 'other_income', null, true],
  ['615', '6150', 'Building Repairs', 'expense', null, true],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';
const BILL_KINDS = { vendor_bill: NETSUITE_TYPE.vendor_bill, vendor_credit: NETSUITE_TYPE.vendor_credit };

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
    -- What migrations 314, 407, 416, 435 and 454 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.netsuite_parts (id UUID PRIMARY KEY);
    CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE TABLE public.netsuite_sales_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), netsuite_id TEXT NOT NULL UNIQUE, tranid TEXT,
      customer_netsuite_id TEXT, customer_name TEXT
    );
    CREATE TABLE public.vendor_invoices (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.payouts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.po_receipts (id UUID PRIMARY KEY, ns_status TEXT NOT NULL);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '364-books-invoice-check.sql',
    '367-books-invoice-posting.sql', '370-books-credit-memos.sql', '374-books-payment-check.sql', '376-books-payment-posting.sql',
    '377-books-differences.sql', '380-books-netsuite-month.sql', '382-books-customer-deposits.sql', '383-books-deposit-posting.sql',
    '384-books-vendor-bills.sql', '385-books-bill-item-accounts.sql', '386-books-bill-posting.sql', '387-books-retired-accounts.sql',
    '389-books-bill-payments.sql', '390-books-bill-payment-posting.sql', '391-books-checks-and-cards.sql', '392-books-spending-posting.sql',
    '393-books-journal-entries.sql', '394-books-bank-deposits.sql', '395-books-stock-cost.sql',
    '397-books-stock-postings-once.sql', '399-books-customer-refunds.sql',
    // Stock by item, which Books' own fulfillments are costed from.
    '401-books-stock-by-item.sql', '402-books-stock-values.sql', '403-books-stock-item-setup.sql',
    '404-books-stock-ledger-parts.sql', '405-books-stock-account-items.sql',
    // FleetSuite's own invoices, which the job reads with BMG's invoices.
    '407-books-own-invoices.sql', '409-books-own-invoice-posting.sql',
    // Books' own fulfillments, receipts and bills, which the job reads with NetSuite's.
    '416-books-own-fulfillments.sql', '435-books-own-bills.sql', '436-books-snap-a-bill.sql', '454-inventory-adjustments.sql',
    '456-books-own-postings.sql', '457-books-own-adjustments.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'`);
  for (const [ns, number, name, type, company, active] of ACCOUNTS) {
    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active)
       VALUES ($1, $2, $3, $4, $5, (SELECT id FROM gl_companies WHERE code = $6), $7)`,
      [accountId(ns), number, name, type, ns, company, active],
    );
  }
  // NetSuite's vendors and items, as the lists copy has them. DISC-8's account isn't one the items copy reads.
  for (const [kind, id, name, details] of [
    ['vendor', '50', 'Sample Supply Co', { payables_account: '200' }],
    ['vendor', '51', 'Another Supplier', { payables_account: '200' }],
    ['item', '901', 'WIDGET-1', { item_type: 'InvtPart', asset_account: '130' }],
    ['item', '902', 'SUPPLY-2', { item_type: 'NonInvtPart', expense_account: '610' }],
    ['item', '904', 'DISC-8', { item_type: 'Discount' }],
  ] as const) {
    await pg.query(
      'INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ($1, $2, $3, true, $4::jsonb)',
      [kind, id, name, JSON.stringify(details)],
    );
  }
  // An item receipt of BMG's, which holds received stock in '205' until it's billed. It's from before the books start, so
  // the posting job, which posts item receipts too (stock-posting-sql.test.ts), leaves it be here.
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ('611', 'ItemRcpt', 'IR611', '2024-12-05', '2024-12-01', 'x', 's')`,
  );
  await pg.query(
    `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
     SELECT '611', l.line_id, c.id, l.account, '2024-12-01', '2024-12-05', l.debit, l.credit
     FROM gl_companies c, (VALUES ('1', '130', 30.00, 0), ('2', '205', 0, 30.00)) AS l(line_id, account, debit, credit)
     WHERE c.code = 'BMG'`,
  );
  await pg.exec('SET ROLE service_role');
  return pg;
}

/** A Postgres text[] literal, as PostgREST sends a list. */
const textArray = (items: string[]) => `{${items.map((s) => `"${s.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

// ── NetSuite's bills, and the copies of them ───────────────────────────────

interface NsLine {
  id: string;
  /** NetSuite's item; an expense line when left out. */
  item?: string;
  /** An expense line's account. */
  account?: string;
  /** Where NetSuite's GL posts the line: the expense line's account unless said. */
  gl?: string;
  /** Its net amount, debit positive. */
  cents: number;
  /** Its own amount, debit positive, when that isn't the net one: a discount's, or a line it's shared out over. */
  own?: number;
}

interface NsBill {
  ref: string;
  type: 'VendBill' | 'VendCred';
  number: string | null;
  date: string;
  /** The month NetSuite booked it into; its own unless said. */
  booked?: string;
  /** The company NetSuite posted it to; null when the GL copy has none of it. */
  company: 'BMG' | '1084' | null;
  total: string;
  lines: NsLine[];
  /** It came from a purchase order. */
  ordered?: boolean;
  /** NetSuite's vendor: '50' unless said. */
  vendor?: string;
  /** NetSuite's status for it. */
  status?: string;
  voided?: boolean;
  /** NetSuite no longer has it. */
  gone?: boolean;
}

const cents = (amount: string) => Math.round(Number(amount) * 100);
const money = (c: number) => (c / 100).toFixed(2);

/** Copies a bill or bill credit as the bills copy (migration 384) and the GL copy would. */
async function copy(pg: PGlite, b: NsBill) {
  await pg.query('SELECT gl_netsuite_bills_apply($1::jsonb)', [JSON.stringify({
    rows: [{
      netsuite_id: b.ref, tran_type: b.type, tranid: b.number, trandate: b.date, vendor_netsuite_id: b.vendor ?? '50',
      vendor_name: `V-${b.vendor ?? '50'}`, total: b.total, status_label: b.voided ? 'Voided' : b.status ?? null, voided: !!b.voided,
      // This NetSuite gives bill lines the other way round from the GL, as the check finds out.
      lines: b.lines.map((l) => ({
        line_id: l.id, item: l.item ?? null, account: l.item ? null : l.account ?? null, amount: money(-l.cents),
        own_amount: money(-(l.own ?? l.cents)), quantity: null, memo: null, tax: false,
      })),
      links: b.ordered ? [{ netsuite_id: `9${b.ref}`, type: 'PurchOrd', number: `PO${b.ref}`, amount: b.total, link_type: null }] : [],
    }],
  })]);
  await pg.query(`UPDATE gl_netsuite_bills SET gone_at = ${b.gone ? 'now()' : 'NULL'} WHERE netsuite_id = $1`, [b.ref]);
  await pg.query('DELETE FROM gl_netsuite_transactions WHERE netsuite_id = $1', [b.ref]);
  if (!b.company || b.gone) return;
  const total = cents(b.total);
  const posted = [
    ['0', b.company === 'BMG' ? '200' : '210', b.type === 'VendBill' ? -total : total] as const,
    ...b.lines.map((l) => [l.id, l.gl ?? l.account!, l.own ?? l.cents] as const),
  ].filter(([, , c]) => c !== 0);
  // NetSuite posts nothing for $0.
  if (!posted.length) return;
  const month = b.booked ?? `${b.date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [b.ref, b.type, b.number, b.date, month],
  );
  for (const [line, account, c] of posted) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [b.ref, line, account, month, b.date, money(Math.max(c, 0)), money(Math.max(-c, 0)), b.company],
    );
  }
}

// ── The functions ──────────────────────────────────────────────────────────

describe('migration 386\'s functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    const supplies = (cents: number): NsLine[] => [{ id: '1', item: '902', gl: '610', cents }];
    await copy(db, { ref: '701', type: 'VendBill', number: 'B-701', date: '2025-03-05', company: 'BMG', total: '500.00', lines: supplies(50000) });
    await copy(db, { ref: '702', type: 'VendCred', number: 'VC-702', date: '2025-03-10', company: 'BMG', total: '30.00', lines: supplies(-3000), vendor: '51' });
    await copy(db, { ref: '703', type: 'VendBill', number: 'B-703', date: '2025-03-12', company: 'BMG', total: '20.00', lines: supplies(2000), voided: true });
    await copy(db, { ref: '704', type: 'VendBill', number: 'B-704', date: '2025-03-14', company: 'BMG', total: '60.00', lines: supplies(6000), gone: true });
    // A vendor the copy of NetSuite's vendors doesn't have.
    await copy(db, { ref: '706', type: 'VendBill', number: 'B-706', date: '2025-03-16', company: 'BMG', total: '15.00', lines: supplies(1500), vendor: '59' });
    await copy(db, { ref: '707', type: 'VendCred', number: 'VC-707', date: '2025-03-18', company: 'BMG', total: '12.00', lines: supplies(-1200) });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const entry = (company: string, key: string, sourceType: string, sourceId: string, amount: string, fields: Record<string, unknown> = {}) => ({
    company,
    entry_date: '2025-03-05',
    source_type: sourceType,
    source_id: sourceId,
    posting_rule: 'bill@1',
    idempotency_key: key,
    memo: `B-${sourceId}, Sample Supply Co`,
    lines: [
      { account_id: accountId(company === 'BMG' ? '200' : '210'), credit: amount, source_line_ref: 'payables', vendor_ref: '50' },
      { account_id: accountId('610'), debit: amount, source_line_ref: '1', item_number: 'SUPPLY-2' },
    ],
    ...fields,
  });
  const post = (p: unknown) => one<{ id: string; entry_no: number }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
  const postings = async (company: string, ids: string[] | null, lines: boolean) =>
    (await one<{ bills: BillPosting[] }>('SELECT gl_bill_postings($1, $2::text[], $3) AS r', [company, ids && textArray(ids), lines])).bills;

  it('gl_bill_postings says what the journal holds for each bill and bill credit and what the copy says of it', async () => {
    const first = await post(entry('BMG', 'vendor_bill:701:1', 'vendor_bill', '701', '500.00'));
    const second = (await one<{ entry: { id: string; entry_no: number } }>(
      'SELECT gl_repost_entry($1::uuid, $2, $3::jsonb) AS r',
      [first.id, 'B-701 changed in NetSuite', JSON.stringify(entry('BMG', 'vendor_bill:701:2', 'vendor_bill', '701', '450.00'))],
    )).entry;
    const credited = await post(entry('BMG', 'vendor_credit:702:1', 'vendor_credit', '702', '30.00', {
      entry_date: '2025-03-10',
      lines: [
        { account_id: accountId('200'), debit: '30.00', source_line_ref: 'payables', vendor_ref: '51' },
        { account_id: accountId('610'), credit: '30.00', source_line_ref: '1', item_number: 'SUPPLY-2' },
      ],
    }));
    const voided = await post(entry('BMG', 'vendor_bill:703:1', 'vendor_bill', '703', '20.00'));
    const gone = await post(entry('BMG', 'vendor_bill:704:1', 'vendor_bill', '704', '60.00'));
    // Not in the copy of NetSuite's bills, and 1084's.
    const other = await post(entry('1084', 'vendor_bill:705:1', 'vendor_bill', '705', '5.00'));
    // A deposit's entry under a bill's NetSuite id is another document's.
    await post(entry('BMG', 'customer_deposit:701:1', 'customer_deposit', '701', '1.00', { posting_rule: 'deposit@1' }));
    // Two entries standing for one bill, which the posting job reverses down to one: the newer is the one that stands.
    const older = await post(entry('BMG', 'vendor_bill:708:1', 'vendor_bill', '708', '8.00', { entry_date: '2025-04-10' }));
    const newer = await post(entry('BMG', 'vendor_bill:708:2', 'vendor_bill', '708', '8.00', { entry_date: '2025-04-11' }));

    const held = await postings('BMG', null, false);
    expect(held.map((p) => [p.source_type, p.source_id, p.entries, p.bill])).toEqual([
      ['vendor_bill', '701', 2, { number: 'B-701', deleted: false, voided: false }],
      ['vendor_credit', '702', 1, { number: 'VC-702', deleted: false, voided: false }],
      ['vendor_bill', '703', 1, { number: 'B-703', deleted: false, voided: true }],
      ['vendor_bill', '704', 1, { number: 'B-704', deleted: true, voided: false }],
      ['vendor_bill', '708', 2, null],
    ]);
    expect(held[4]).toMatchObject({
      unreversed: [newer.id, older.id],
      current: { id: newer.id, entry_no: newer.entry_no, entry_date: '2025-04-11', lines: null },
    });
    expect(held[0]).toEqual({
      source_type: 'vendor_bill',
      source_id: '701',
      entries: 2,
      unreversed: [second.id],
      history: [
        { entry_no: first.entry_no, entry_date: '2025-03-05', reversed_by: first.entry_no + 1 },
        { entry_no: second.entry_no, entry_date: '2025-03-05', reversed_by: null },
      ],
      // Migration 456 has it say which rule made the entry that stands.
      current: { id: second.id, entry_no: second.entry_no, entry_date: '2025-03-05', posting_rule: 'bill@1', lines: null },
      bill: { number: 'B-701', deleted: false, voided: false },
    });
    expect(held.map((p) => p.current?.id)).toEqual([second.id, credited.id, voided.id, gone.id, newer.id]);

    // Only the ones asked about, with the lines of the entry that stands, the vendor on payables.
    const [asked] = await postings('BMG', ['702', '999'], true);
    expect(asked.current?.lines).toEqual([
      { account: '200', debit: '30.00', credit: '0.00', division: null, source_line_ref: 'payables', customer_id: null, vendor_ref: '51' },
      { account: '610', debit: '0.00', credit: '30.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
    ]);
    expect((await postings('1084', null, false)).map((p) => [p.source_id, p.current?.id, p.bill])).toEqual([['705', other.id, null]]);
  });

  it('gl_books_difference_documents says what the copy of the bills holds for one that differs, the vendor as its party', async () => {
    // VC-707's entry is $2 short of what NetSuite posted.
    await post(entry('BMG', 'vendor_credit:707:1', 'vendor_credit', '707', '10.00', {
      entry_date: '2025-03-18',
      lines: [
        { account_id: accountId('200'), debit: '10.00', source_line_ref: 'payables', vendor_ref: '50' },
        { account_id: accountId('610'), credit: '10.00', source_line_ref: '1', item_number: 'SUPPLY-2' },
      ],
    }));
    // B-706 isn't posted.
    const diff = await one<{ counts: Record<string, number>; documents: any[] }>(
      'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', MAR, JSON.stringify(BILL_KINDS), 10],
    );
    // B-701's entry is $50 short of what NetSuite posted; B-704's stands though NetSuite no longer has it; the rest match.
    expect(diff.counts).toEqual({ vendor_bill: 3, vendor_credit: 1 });
    expect(diff.documents.map((d) => [d.kind, d.netsuite_id, d.copy])).toEqual([
      ['vendor_bill', '704', { number: 'B-704', customer: 'Sample Supply Co', voided: false, deleted: true }],
      ['vendor_bill', '701', { number: 'B-701', customer: 'Sample Supply Co', voided: false, deleted: false }],
      ['vendor_bill', '706', { number: 'B-706', customer: 'V-59', voided: false, deleted: false }],
      ['vendor_credit', '707', { number: 'VC-707', customer: 'Sample Supply Co', voided: false, deleted: false }],
    ]);
    expect(diff.documents[1].netsuite).toEqual({ type: 'VendBill', number: 'B-701', date: '2025-03-05', month: MAR });
    expect(diff.documents[0].netsuite).toBeNull();

    // The deposit entry under B-701's NetSuite id differs too, and the copy of the bills says nothing of it.
    const mixed = await one<{ documents: any[] }>(
      'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r',
      ['BMG', MAR, JSON.stringify({ ...BILL_KINDS, customer_deposit: 'CustDep' }), 10],
    );
    expect(mixed.documents.filter((d) => d.kind === 'customer_deposit').map((d) => [d.netsuite_id, d.copy])).toEqual([['701', null]]);
  });

  it('is the service role\'s alone, and the new read writes nothing', async () => {
    for (const fn of ['gl_bill_postings(text, text[], boolean)', 'gl_books_difference_documents(text, date, jsonb, integer)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>('SELECT has_function_privilege($1::name, $2, \'EXECUTE\') AS r', [role, fn]), `${role} ${fn}`)
          .toBe(role === 'service_role');
      }
    }
    const body = await one<string>(`SELECT prosrc AS r FROM pg_proc WHERE proname = 'gl_bill_postings'`);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it('says what gl_lines.vendor_ref holds', async () => {
    const comment = await one<string | null>(
      `SELECT col_description(a.attrelid, a.attnum) AS r FROM pg_attribute a
       WHERE a.attrelid = 'public.gl_lines'::regclass AND a.attname = 'vendor_ref'`,
    );
    expect(comment).toMatch(/^The vendor a line is owed to or by: its NetSuite internal id/);
  });
});

// ── The job ────────────────────────────────────────────────────────────────

// Made-up bills and bill credits, from December 2024 to March 2025.
const BILLS = (): NsBill[] => [
  // From a purchase order: an installer's labor, supplies, and stock already received.
  {
    ref: '801', type: 'VendBill', number: 'B-801', date: '2025-01-10', company: 'BMG', total: '650.00', ordered: true,
    lines: [{ id: '1', account: '530', cents: 50000 }, { id: '2', item: '902', gl: '610', cents: 12000 }, { id: '3', item: '901', gl: '205', cents: 3000 }],
  },
  // Supplies sent back.
  { ref: '802', type: 'VendCred', number: 'VC-802', date: '2025-02-05', company: 'BMG', total: '120.00', lines: [{ id: '1', item: '902', gl: '610', cents: -12000 }] },
  // An item the copy of NetSuite's items doesn't have yet, so the rule can't work it out.
  { ref: '803', type: 'VendBill', number: 'B-803', date: '2025-02-20', company: 'BMG', total: '50.00', lines: [{ id: '1', item: '999', gl: '530', cents: 5000 }] },
  // 1084's, which a run for BMG leaves alone.
  { ref: '804', type: 'VendBill', number: 'B-804', date: '2025-03-03', company: '1084', total: '80.00', lines: [{ id: '1', account: '615', cents: 8000 }] },
  // Not in the GL copy: waiting for approval.
  { ref: '805', type: 'VendBill', number: 'B-805', date: '2025-03-04', company: null, total: '75.00', lines: [{ id: '1', account: '530', cents: 7500 }] },
  // Dated before the books start, booked by NetSuite into January 2025.
  {
    ref: '806', type: 'VendBill', number: 'B-806', date: '2024-12-28', booked: JAN, company: 'BMG', total: '40.00',
    lines: [{ id: '1', account: '530', cents: 4000 }],
  },
  // 8% off: NetSuite shares the discount out over the line in its net amount, but books the line at its own and the discount apart.
  {
    ref: '807', type: 'VendBill', number: 'B-807', date: '2025-03-06', company: 'BMG', total: '92.00',
    lines: [{ id: '1', item: '902', gl: '610', cents: 9200, own: 10000 }, { id: '2', item: '904', gl: '480', cents: 0, own: -800 }],
  },
  // $0, and nothing on either side.
  { ref: '809', type: 'VendBill', number: 'B-809', date: '2025-03-08', company: 'BMG', total: '0.00', lines: [{ id: '1', account: '530', cents: 0 }] },
];

describe('the posting job, for bills', () => {
  let pg: PGlite;
  let clock = 0;
  /** How long a function takes, for running out of time. */
  const takes = new Map<string, number>();
  const store = new Map<string, any>();
  const bills = new Map<string, NsBill>();

  // sync_state in memory; gl_accounts, gl_companies and every function the
  // real ones, called the way supabase-js calls them.
  const service = () => ({
    from: (table: string) => {
      if (table === 'sync_state') {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => ({ data: store.has(key) ? { last_result: store.get(key).last_result } : null, error: null }),
            }),
          }),
          upsert: async (row: Record<string, unknown>) => {
            store.set(row.sync_type as string, JSON.parse(JSON.stringify({ ...store.get(row.sync_type as string), ...row })));
            return { error: null };
          },
        };
      }
      if (table === 'gl_accounts') {
        return {
          select: (cols: string) => ({
            order: (col: string) => ({
              range: async (from: number, to: number) => ({
                data: (await pg.query(`SELECT ${cols} FROM gl_accounts ORDER BY ${col} LIMIT ${to - from + 1} OFFSET ${from}`)).rows,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'gl_companies') {
        return { select: async (cols: string) => ({ data: (await pg.query(`SELECT ${cols} FROM gl_companies ORDER BY code`)).rows, error: null }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      clock += takes.get(fn) ?? 0;
      const names = Object.keys(args);
      const value = (v: unknown) => (Array.isArray(v) ? textArray(v.map(String)) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
      try {
        const r = await pg.query<{ r: unknown }>(
          `SELECT ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`,
          names.map((n) => value(args[n])),
        );
        return { data: r.rows[0].r, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
  }) as any;

  // The copy keeps bills' lines, so there's nothing to ask NetSuite.
  const query = async () => { throw new Error('NetSuite was asked about lines'); };
  // A run for BMG's books alone (deps.companies): 1084's documents here are another company's, which it leaves alone.
  const run = (budgetMs = 240_000) => postInvoices(service(), { deadline: clock + budgetMs, deps: { query, now: () => clock, companies: ['BMG'] } });

  /** The journal, entry by entry: a document's entry by its key, a reversal by the entry it reverses. */
  const journal = async () => (await pg.query<{ no: number; date: string; key: string | null; reverses: number | null; memo: string | null }>(
    `SELECT e.entry_no::int AS no, to_char(e.entry_date, 'YYYY-MM-DD') AS date,
            CASE WHEN e.reverses_entry_id IS NULL THEN e.idempotency_key END AS key, r.entry_no::int AS reverses, e.memo
     FROM gl_entries e LEFT JOIN gl_entries r ON r.id = e.reverses_entry_id
     ORDER BY e.entry_no`,
  )).rows;
  const linesOf = async (no: number) => (await pg.query(
    `SELECT a.netsuite_account_id AS account, l.debit::text AS debit, l.credit::text AS credit, l.vendor_ref, l.item_number, l.source_line_ref
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
     WHERE e.entry_no = $1 ORDER BY l.line_no`,
    [no],
  )).rows;
  const ruleOf = async (no: number) => (await pg.query<{ rule: string; type: string; source: string }>(
    'SELECT posting_rule AS rule, source_type AS type, source_id AS source FROM gl_entries WHERE entry_no = $1', [no],
  )).rows[0];
  const differing = async (month: string) => pg.query<{ r: { counts: Record<string, number>; documents: any[] } }>(
    'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', month, JSON.stringify(BILL_KINDS), 10],
  ).then((res) => res.rows[0].r);

  /** NetSuite changes a bill or bill credit, and the copies catch up. */
  const edit = async (ref: string, change: (b: NsBill) => void) => {
    const b = bills.get(ref)!;
    change(b);
    await copy(pg, b);
  };
  const add = async (b: NsBill) => {
    bills.set(b.ref, b);
    await copy(pg, b);
  };

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    clock = Date.parse('2025-03-15T12:00:00Z');
    for (const b of BILLS()) await add(b);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('posts each BMG bill and bill credit the rule works out, once, in the month NetSuite booked it into, the vendor on payables', async () => {
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 4, replaced: 0, reversed: 0, unchanged: 0, left: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect(r.notes).toBeUndefined();

    // Not B-803 (unworkable), B-804 (1084's), B-805 (not in the GL copy) or B-809 ($0).
    expect(await journal()).toEqual([
      { no: 1, date: JAN, key: 'vendor_bill:806:1', reverses: null, memo: 'B-806, Sample Supply Co' },
      { no: 2, date: '2025-01-10', key: 'vendor_bill:801:1', reverses: null, memo: 'B-801, Sample Supply Co' },
      { no: 3, date: '2025-02-05', key: 'vendor_credit:802:1', reverses: null, memo: 'VC-802, Sample Supply Co' },
      { no: 4, date: '2025-03-06', key: 'vendor_bill:807:1', reverses: null, memo: 'B-807, Sample Supply Co' },
    ]);
    expect(await ruleOf(2)).toEqual({ rule: 'bill@1', type: 'vendor_bill', source: '801' });
    expect(await ruleOf(3)).toEqual({ rule: 'bill@1', type: 'vendor_credit', source: '802' });
    expect(await linesOf(2)).toEqual([
      { account: '200', debit: '0.00', credit: '650.00', vendor_ref: '50', item_number: null, source_line_ref: 'payables' },
      { account: '530', debit: '500.00', credit: '0.00', vendor_ref: null, item_number: null, source_line_ref: '1' },
      { account: '610', debit: '120.00', credit: '0.00', vendor_ref: null, item_number: 'SUPPLY-2', source_line_ref: '2' },
      { account: '205', debit: '30.00', credit: '0.00', vendor_ref: null, item_number: 'WIDGET-1', source_line_ref: '3' },
    ]);
    expect(await linesOf(3)).toEqual([
      { account: '200', debit: '120.00', credit: '0.00', vendor_ref: '50', item_number: null, source_line_ref: 'payables' },
      { account: '610', debit: '0.00', credit: '120.00', vendor_ref: null, item_number: 'SUPPLY-2', source_line_ref: '1' },
    ]);
    // The discount at its own amount, in the account NetSuite posts DISC-8's bill lines to.
    expect((await linesOf(4)).map((l: any) => [l.account, l.debit, l.credit, l.item_number])).toEqual([
      ['200', '0.00', '92.00', null], ['610', '100.00', '0.00', 'SUPPLY-2'], ['480', '0.00', '8.00', 'DISC-8'],
    ]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);

    // Differences: what's posted comes to NetSuite's; B-803 is the one bill that differs, and why can be told.
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(MAR)).counts).toEqual({});
    const feb = await differing(FEB);
    expect(feb.counts).toEqual({ vendor_bill: 1 });
    expect(feb.documents[0]).toMatchObject({
      kind: 'vendor_bill', netsuite_id: '803', fleetsuite: { entries: 0, standing: null },
      copy: { number: 'B-803', customer: 'Sample Supply Co', voided: false, deleted: false },
    });
  });

  it('changes nothing on the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 4, left: 1 });
    expect(await journal()).toEqual(before);
  });

  it('replaces an entry when NetSuite changes what it posts or who it\'s owed to, and not for a new number or status', async () => {
    await edit('801', (b) => { b.number = 'B-801-A'; b.status = 'Paid In Full'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, unchanged: 4 });

    await edit('802', (b) => { b.total = '100.00'; b.lines = [{ id: '1', item: '902', gl: '610', cents: -10000 }]; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, unchanged: 3 });
    expect((await journal()).slice(-2)).toEqual([
      { no: 5, date: '2025-02-05', key: null, reverses: 3, memo: 'VC-802 changed in NetSuite' },
      { no: 6, date: '2025-02-05', key: 'vendor_credit:802:2', reverses: null, memo: 'VC-802, Sample Supply Co' },
    ]);
    expect((await linesOf(6)).map((l: any) => [l.source_line_ref, l.debit, l.credit])).toEqual([['payables', '100.00', '0.00'], ['1', '0.00', '100.00']]);

    // B-806 is owed to another vendor now: its entry carries that one.
    await edit('806', (b) => { b.vendor = '51'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, unchanged: 3 });
    expect((await journal()).slice(-1)[0]).toMatchObject({ no: 8, date: JAN, key: 'vendor_bill:806:2', memo: 'B-806, Another Supplier' });
    expect((await linesOf(8)).map((l: any) => [l.source_line_ref, l.vendor_ref])).toEqual([['payables', '51'], ['1', null]]);
  });

  it('reverses the entry of a bill NetSuite voids, no longer has, or that comes to nothing now, once', async () => {
    await edit('801', (b) => { b.gone = true; });
    await edit('807', (b) => { b.voided = true; });
    // Out of the GL copy with its amount unchanged: the copy hasn't caught up, so its entry stays.
    await edit('802', (b) => { b.company = null; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 2, left: 2 });
    expect((await journal()).slice(-2).map((e) => [e.reverses, e.memo])).toEqual([
      [2, 'B-801-A deleted in NetSuite'],
      [4, 'B-807 voided in NetSuite'],
    ]);

    // $0 now, and NetSuite posts no lines for $0: nothing to post, so its entry is reversed.
    await edit('802', (b) => { b.total = '0.00'; b.lines = [{ id: '1', item: '902', gl: '610', cents: 0 }]; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 1, left: 1 });
    expect((await journal()).slice(-1).map((e) => [e.reverses, e.memo])).toEqual([[6, 'VC-802 comes to nothing in NetSuite']]);

    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0 });
    expect(await journal()).toEqual(before);
  });

  it('posts a bill once the rule can work it out, and names one the journal refuses, without amounts', async () => {
    await pg.query(`INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ('item', '999', 'LABOR-9', true, '{"item_type": "Service", "expense_account": "530"}')`);
    // To a subcontractors account NetSuite has made inactive since, as the Apex loan bills are, and to one only 1084 may use.
    await add({ ref: '810', type: 'VendBill', number: 'B-810', date: '2025-03-07', company: 'BMG', total: '9.00', lines: [{ id: '1', account: '531', cents: 900 }] });
    await add({ ref: '811', type: 'VendBill', number: 'B-811', date: '2025-03-08', company: 'BMG', total: '8.00', lines: [{ id: '1', account: '532', cents: 800 }] });

    const r = await run();
    expect(r).toMatchObject({ posted: 2, failedCount: 1, failed: [{ number: 'B-811', reason: 'Account 5320 (Subcontractors 1084) belongs to another company' }] });
    const posted = (await journal()).slice(-2);
    expect(posted.map((e) => [e.date, e.key])).toEqual([['2025-02-20', 'vendor_bill:803:1'], ['2025-03-07', 'vendor_bill:810:1']]);
    // The inactive account takes the bill line NetSuite posted to it.
    expect((await linesOf(posted[1].no)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([
      ['200', '0.00', '9.00'],
      ['531', '9.00', '0.00'],
    ]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);
  });

  it('leaves whatever stands for a bill whose lines don\'t come to its total, and says which', async () => {
    // The copy caught the new total before the new lines.
    await edit('806', (b) => { b.total = '45.00'; });
    await pg.query(`UPDATE gl_netsuite_bills SET lines = jsonb_set(lines, '{0,amount}', '"-40.00"'), total = 45.00 WHERE netsuite_id = '806'`);
    const before = await journal();
    const r = await run();
    expect(r).toMatchObject({ posted: 0, replaced: 0, reversed: 0 });
    expect(r.notes).toContainEqual("FleetSuite's entry for 1 bill doesn't come to its total, so whatever FleetSuite holds for it stayed as it is: "
      + 'B-806. Either the copy was caught mid-refresh, and the next run looks again, or the rule leaves out a line NetSuite posts, which '
      + 'Invoices vs NetSuite shows.');
    expect(await journal()).toEqual(before);
  });

  it('never starts a bill write with under five seconds left, and does that month again next run', async () => {
    await add({ ref: '811', type: 'VendBill', number: 'B-811', date: '2025-01-20', company: 'BMG', total: '40.00', lines: [{ id: '1', account: '530', cents: 4000 }] });
    const before = await journal();

    takes.set('gl_bill_month', 26_000);
    expect(await run(30_000)).toMatchObject({ months: [], posted: 0, partial: true });
    expect(store.get(BOOKS_INVOICE_POSTING).last_result.resume).toEqual({ company: 'BMG', month: JAN });
    expect(await journal()).toEqual(before);

    takes.clear();
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 1 });
    expect(r.partial).toBeUndefined();
    expect((await journal()).slice(-1)[0].key).toBe('vendor_bill:811:1');
  });
});
