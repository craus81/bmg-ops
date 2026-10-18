// Migration 392 reads what the journal holds for NetSuite's checks and
// credit card charges and refunds, and lets the differences page say what
// the copy of them holds for one; the posting job posts them with the
// spending rule. This runs migration 314 (with stand-ins for the app tables
// it points at) and migrations 359–364, 367, 370, 374, 376, 377, 380,
// 382–387 and 389–392, with the ones the job reads journal entries, bank
// deposits, transfers, refunds and stock documents through (393–395, 397 and
// 399), in an
// in-memory Postgres
// (PGlite) as the app's server login and holds the functions' rules, then
// runs the posting job against them with checks and card charges and
// refunds, and one journal entry voiding a check.
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

import { BOOKS_INVOICE_POSTING, postInvoices, type SpendingPosting } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { NETSUITE_TYPE } from './differences';
import { JOURNAL_ENTRY_SOURCE_TYPE } from './journal-entry-rule';
import type { SpendingType } from './spending-rule';

/**
 * Made-up chart: '100' BMG's checking, '101' checking no longer used, '106'
 * checking only 1084 may use, '220' the Chase card, '130' inventory, '610'
 * shop supplies, '640' meals, '615' 1084's building repairs.
 */
const ACCOUNTS: Array<[string, string, string, string, 'BMG' | '1084' | null, boolean]> = [
  ['100', '1000', 'Checking', 'bank', 'BMG', true],
  ['101', '1010', 'Old Checking', 'bank', 'BMG', false],
  ['106', '1060', 'Checking 1084', 'bank', '1084', true],
  ['220', '2200', 'Chase Card', 'credit_card', 'BMG', true],
  ['130', '1300', 'Inventory', 'other_current_asset', 'BMG', true],
  ['610', '6100', 'Shop Supplies', 'expense', null, true],
  ['640', '6400', 'Meals', 'expense', null, true],
  ['615', '6150', 'Building Repairs', 'expense', '1084', true],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';
const SPENDING_KINDS = { check: NETSUITE_TYPE.check, card_charge: NETSUITE_TYPE.card_charge, card_refund: NETSUITE_TYPE.card_refund };

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
    '367-books-invoice-posting.sql', '370-books-credit-memos.sql', '374-books-payment-check.sql', '376-books-payment-posting.sql',
    '377-books-differences.sql', '380-books-netsuite-month.sql', '382-books-customer-deposits.sql', '383-books-deposit-posting.sql',
    '384-books-vendor-bills.sql', '385-books-bill-item-accounts.sql', '386-books-bill-posting.sql', '387-books-retired-accounts.sql',
    '389-books-bill-payments.sql', '390-books-bill-payment-posting.sql', '391-books-checks-and-cards.sql', '392-books-spending-posting.sql',
    '393-books-journal-entries.sql', '394-books-bank-deposits.sql', '395-books-stock-cost.sql',
    '397-books-stock-postings-once.sql', '399-books-customer-refunds.sql',
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
  // NetSuite's vendors and items, as the lists copy has them.
  for (const [id, name] of [['50', 'Sample Supply Co'], ['51', 'Another Supplier']]) {
    await pg.query(
      `INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ('vendor', $1, $2, true, '{"payables_account": "200"}'::jsonb)`,
      [id, name],
    );
  }
  for (const [id, name, details] of [
    ['901', 'WIDGET-1', { item_type: 'InvtPart', asset_account: '130' }],
    ['902', 'SUPPLY-2', { item_type: 'NonInvtPart', expense_account: '610' }],
  ] as const) {
    await pg.query(
      `INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ('item', $1, $2, true, $3::jsonb)`,
      [id, name, JSON.stringify(details)],
    );
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

/** A Postgres text[] literal, as PostgREST sends a list. */
const textArray = (items: string[]) => `{${items.map((s) => `"${s.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

// ── NetSuite's checks and card charges and refunds, and the copies of them ─

interface NsSpending {
  ref: string;
  type: SpendingType;
  number: string | null;
  date: string;
  /** The month NetSuite booked it into; its own unless said. */
  booked?: string;
  /** The company NetSuite posted it to; null when the GL copy has none of it. */
  company: 'BMG' | '1084' | null;
  /** Its lines as the document shows them, amounts positive: [line id, item, expense account, amount]; null until they've been copied. */
  lines: Array<[string, string | null, string | null, string]> | null;
  /** Its total: what its lines come to unless said. */
  total?: string;
  /** The account the money comes out of, or a refund goes back to, on NetSuite's main line: '100' for a check, '220' for a card, unless said. */
  from?: string;
  /** NetSuite's GL lines as they are, when they aren't the usual ones: [line id, account, cents debit positive]. */
  gl?: Array<[string, string, number]>;
  /** NetSuite's payee: '50' unless said. */
  payee?: string;
  voided?: boolean;
  /** NetSuite no longer has it. */
  gone?: boolean;
}

const cents = (amount: string) => Math.round(Number(amount) * 100);
const money = (c: number) => (c / 100).toFixed(2);
/** Where the made-up items' lines go: stock '901' to inventory, supplies '902' to their expense account. */
const ITEM_ACCOUNT: Record<string, string> = { '901': '130', '902': '610' };

/** Copies a check, card charge or card refund as the checks and cards copy (migration 391) and the GL copy would. */
async function copy(pg: PGlite, d: NsSpending) {
  const refund = d.type === 'CardRfnd';
  const lines = (d.lines ?? []).map(([id, item, account, amount]) => ({ id, account: account ?? ITEM_ACCOUNT[item!], cents: cents(amount) }));
  const total = d.total ?? money(lines.reduce((n, l) => n + l.cents, 0));
  await pg.query('SELECT gl_netsuite_spending_apply($1::jsonb)', [JSON.stringify({
    rows: [{
      netsuite_id: d.ref, tran_type: d.type, tranid: d.number, trandate: d.date, payee_netsuite_id: d.payee ?? '50',
      payee_name: `V-${d.payee ?? '50'}`, total, status: null, status_label: d.voided ? 'Voided' : null, voided: !!d.voided, memo: null,
      // NetSuite gives a check's and a charge's lines negative, a refund's positive.
      ...(d.lines ? {
        lines: d.lines.map(([id, item, account, amount]) => ({
          line_id: id, item, account, amount: refund ? amount : money(-cents(amount)), quantity: null, memo: null, tax: false,
        })),
      } : {}),
    }],
  })]);
  await pg.query(`UPDATE gl_netsuite_spending SET gone_at = ${d.gone ? 'now()' : 'NULL'} WHERE netsuite_id = $1`, [d.ref]);
  await pg.query('DELETE FROM gl_netsuite_lines WHERE transaction_id = $1', [d.ref]);
  await pg.query('DELETE FROM gl_netsuite_transactions WHERE netsuite_id = $1', [d.ref]);
  if (!d.company || d.gone) return;
  // The money comes out of an account and goes to the lines; a refund's goes back the other way.
  const way = refund ? -1 : 1;
  const posted = (d.gl ?? [
    ['0', d.from ?? (d.type === 'Check' ? '100' : '220'), -way * cents(total)] as [string, string, number],
    ...lines.map((l): [string, string, number] => [l.id, l.account, way * l.cents]),
  ]).filter(([, , c]) => c !== 0);
  // NetSuite posts nothing for $0.
  if (!posted.length) return;
  const month = d.booked ?? `${d.date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [d.ref, d.type, d.number, d.date, month],
  );
  for (const [line, account, c] of posted) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [d.ref, line, account, month, d.date, money(Math.max(c, 0)), money(Math.max(-c, 0)), d.company],
    );
  }
}

// ── The functions ──────────────────────────────────────────────────────────

describe('migration 392\'s functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await copy(db, { ref: '801', type: 'Check', number: '10234', date: '2025-03-05', company: 'BMG', lines: [['1', null, '640', '500.00']] });
    await copy(db, { ref: '802', type: 'CardChrg', number: null, date: '2025-03-10', company: 'BMG', payee: '51', lines: [['1', null, '610', '30.00']] });
    await copy(db, { ref: '803', type: 'Check', number: '10236', date: '2025-03-12', company: 'BMG', lines: [['1', null, '640', '20.00']], voided: true });
    await copy(db, { ref: '804', type: 'CardRfnd', number: 'R-804', date: '2025-03-14', company: 'BMG', lines: [['1', null, '610', '60.00']], gone: true });
    // A payee the copy of NetSuite's vendors doesn't have, though an item has the same NetSuite id.
    await copy(db, { ref: '806', type: 'Check', number: '10238', date: '2025-03-16', company: 'BMG', payee: '59', lines: [['1', null, '640', '15.00']] });
    await db.query(`INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES ('item', '59', 'SOME-ITEM', true)`);
    await copy(db, { ref: '807', type: 'Check', number: '10239', date: '2025-03-18', company: 'BMG', lines: [['1', null, '640', '12.00']] });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;
  /** A check's entry, the money out of checking and into meals; `fields` change it. */
  const entry = (company: string, key: string, sourceType: string, sourceId: string, amount: string, fields: Record<string, unknown> = {}) => ({
    company,
    entry_date: '2025-03-05',
    source_type: sourceType,
    source_id: sourceId,
    posting_rule: 'spending@1',
    idempotency_key: key,
    memo: `${sourceId}, Sample Supply Co`,
    lines: [
      { account_id: accountId(company === 'BMG' ? '100' : '106'), credit: amount, source_line_ref: 'paid_from' },
      { account_id: accountId(company === 'BMG' ? '640' : '615'), debit: amount, source_line_ref: '1' },
    ],
    ...fields,
  });
  const post = (p: unknown) => one<{ id: string; entry_no: number }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
  const postings = async (company: string, ids: string[] | null, lines: boolean) =>
    (await one<{ documents: SpendingPosting[] }>('SELECT gl_spending_postings($1, $2::text[], $3) AS r', [company, ids && textArray(ids), lines])).documents;

  it('gl_spending_postings says what the journal holds for each check, card charge and refund and what the copy says of it', async () => {
    const first = await post(entry('BMG', 'check:801:1', 'check', '801', '500.00'));
    const second = (await one<{ entry: { id: string; entry_no: number } }>(
      'SELECT gl_repost_entry($1::uuid, $2, $3::jsonb) AS r',
      [first.id, '10234 changed in NetSuite', JSON.stringify(entry('BMG', 'check:801:2', 'check', '801', '450.00'))],
    )).entry;
    const charge = await post(entry('BMG', 'card_charge:802:1', 'card_charge', '802', '30.00', {
      entry_date: '2025-03-10',
      lines: [
        { account_id: accountId('220'), credit: '30.00', source_line_ref: 'paid_from' },
        { account_id: accountId('610'), debit: '30.00', source_line_ref: '1', item_number: 'SUPPLY-2' },
      ],
    }));
    const voided = await post(entry('BMG', 'check:803:1', 'check', '803', '20.00'));
    const refund = await post(entry('BMG', 'card_refund:804:1', 'card_refund', '804', '60.00', {
      lines: [
        { account_id: accountId('220'), debit: '60.00', source_line_ref: 'paid_from' },
        { account_id: accountId('610'), credit: '60.00', source_line_ref: '1' },
      ],
    }));
    // Not in the copy of NetSuite's checks and cards, and 1084's.
    const other = await post(entry('1084', 'check:805:1', 'check', '805', '5.00'));
    // A bill payment's entry under a check's NetSuite id is another document's, and one filed as a check with no
    // NetSuite id is no document's.
    await post(entry('BMG', 'bill_payment:801:1', 'bill_payment', '801', '1.00', { posting_rule: 'bill_payment@1' }));
    await post(entry('BMG', 'check:none:1', 'check', '', '2.00'));
    // Two entries standing for one check, which the posting job reverses down to one: the newer is the one that stands.
    const older = await post(entry('BMG', 'check:808:1', 'check', '808', '8.00', { entry_date: '2025-04-10' }));
    const newer = await post(entry('BMG', 'check:808:2', 'check', '808', '8.00', { entry_date: '2025-04-11' }));

    const held = await postings('BMG', null, false);
    expect(held.map((p) => [p.source_type, p.source_id, p.entries, p.document])).toEqual([
      ['check', '801', 2, { number: '10234', deleted: false, voided: false }],
      ['card_charge', '802', 1, { number: null, deleted: false, voided: false }],
      ['check', '803', 1, { number: '10236', deleted: false, voided: true }],
      ['card_refund', '804', 1, { number: 'R-804', deleted: true, voided: false }],
      ['check', '808', 2, null],
    ]);
    expect(held[4]).toMatchObject({
      unreversed: [newer.id, older.id],
      current: { id: newer.id, entry_no: newer.entry_no, entry_date: '2025-04-11', lines: null },
    });
    expect(held[0]).toEqual({
      source_type: 'check',
      source_id: '801',
      entries: 2,
      unreversed: [second.id],
      history: [
        { entry_no: first.entry_no, entry_date: '2025-03-05', reversed_by: first.entry_no + 1 },
        { entry_no: second.entry_no, entry_date: '2025-03-05', reversed_by: null },
      ],
      current: { id: second.id, entry_no: second.entry_no, entry_date: '2025-03-05', lines: null },
      document: { number: '10234', deleted: false, voided: false },
    });
    expect(held.map((p) => p.current?.id)).toEqual([second.id, charge.id, voided.id, refund.id, newer.id]);

    // Only the ones asked about, with the lines of the entry that stands: no vendor on any.
    const [asked] = await postings('BMG', ['802', '999'], true);
    expect(asked.current?.lines).toEqual([
      { account: '220', debit: '0.00', credit: '30.00', division: null, source_line_ref: 'paid_from', customer_id: null, vendor_ref: null },
      { account: '610', debit: '30.00', credit: '0.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
    ]);
    expect((await postings('1084', null, false)).map((p) => [p.source_id, p.current?.id, p.document])).toEqual([['805', other.id, null]]);
  });

  it('gl_books_difference_documents says what the copy of the checks and cards holds for one that differs, the payee as its party', async () => {
    // 10239's entry is $2 short of what NetSuite posted.
    await post(entry('BMG', 'check:807:1', 'check', '807', '10.00', { entry_date: '2025-03-18' }));
    // 10238 isn't posted.
    const diff = await one<{ counts: Record<string, number>; documents: any[] }>(
      'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', MAR, JSON.stringify(SPENDING_KINDS), 10],
    );
    // R-804's entry stands though NetSuite no longer has it, and 10234's is $50 short of what NetSuite posted; the
    // biggest gap first. The card charge's matches, and 10236's matches what NetSuite's GL still holds for it, voided
    // or not; 808's entries are April's.
    expect(diff.counts).toEqual({ card_refund: 1, check: 3 });
    expect(diff.documents.map((d) => [d.kind, d.netsuite_id, d.copy])).toEqual([
      ['card_refund', '804', { number: 'R-804', customer: 'Sample Supply Co', voided: false, deleted: true }],
      ['check', '801', { number: '10234', customer: 'Sample Supply Co', voided: false, deleted: false }],
      ['check', '806', { number: '10238', customer: 'V-59', voided: false, deleted: false }],
      ['check', '807', { number: '10239', customer: 'Sample Supply Co', voided: false, deleted: false }],
    ]);
    expect(diff.documents[0].netsuite).toBeNull();
    expect(diff.documents[1].netsuite).toEqual({ type: 'Check', number: '10234', date: '2025-03-05', month: MAR });

    // The bill payment's entry under 10234's NetSuite id differs too, and the copy of the checks and cards says nothing of it.
    const mixed = await one<{ documents: any[] }>(
      'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r',
      ['BMG', MAR, JSON.stringify({ ...SPENDING_KINDS, bill_payment: 'VendPymt' }), 10],
    );
    expect(mixed.documents.filter((d) => d.kind === 'bill_payment').map((d) => [d.netsuite_id, d.copy])).toEqual([['801', null]]);
  });

  it('is the service role\'s alone, and the new read writes nothing', async () => {
    for (const fn of ['gl_spending_postings(text, text[], boolean)', 'gl_books_difference_documents(text, date, jsonb, integer)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>('SELECT has_function_privilege($1::name, $2, \'EXECUTE\') AS r', [role, fn]), `${role} ${fn}`)
          .toBe(role === 'service_role');
      }
    }
    const body = await one<string>(`SELECT prosrc AS r FROM pg_proc WHERE proname = 'gl_spending_postings'`);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});

// ── The job ────────────────────────────────────────────────────────────────

// Made-up checks and card charges and refunds, from December 2024 to March 2025.
const DOCS = (): NsSpending[] => [
  // Meals and supplies paid by check.
  { ref: '801', type: 'Check', number: '10234', date: '2025-01-10', company: 'BMG', lines: [['1', null, '640', '45.12'], ['2', '902', null, '120.00']] },
  // Stock bought on the card, which NetSuite gives no number.
  { ref: '802', type: 'CardChrg', number: null, date: '2025-02-05', company: 'BMG', payee: '51', lines: [['1', '901', null, '300.00']] },
  // Money back on the card.
  { ref: '803', type: 'CardRfnd', number: 'R-803', date: '2025-02-20', company: 'BMG', payee: '51', lines: [['1', null, '610', '25.99']] },
  // NetSuite's posting doesn't say where the money came from: no main line, and two accounts credited.
  {
    ref: '804', type: 'Check', number: '10236', date: '2025-02-24', company: 'BMG', lines: [['1', null, '640', '50.00']],
    gl: [['1', '640', 5000], ['2', '100', -3000], ['3', '220', -2000]],
  },
  // 1084's don't post yet.
  { ref: '805', type: 'Check', number: '10250', date: '2025-03-03', company: '1084', from: '106', lines: [['1', null, '615', '80.00']] },
  // Not in the GL copy.
  { ref: '806', type: 'Check', number: '10240', date: '2025-03-04', company: null, lines: [['1', null, '640', '75.00']] },
  // Dated before the books start, booked by NetSuite into January 2025.
  { ref: '807', type: 'CardChrg', number: 'C-807', date: '2024-12-28', booked: JAN, company: 'BMG', lines: [['1', null, '640', '40.00']] },
  // Its lines haven't been copied yet.
  { ref: '808', type: 'CardChrg', number: 'C-808', date: '2025-03-06', company: 'BMG', lines: null, total: '92.00', gl: [['0', '220', -9200], ['1', '610', 9200]] },
  // The copy of its lines was caught mid-refresh: they don't come to its total.
  {
    ref: '809', type: 'Check', number: '10241', date: '2025-03-08', company: 'BMG', lines: [['1', null, '640', '60.00']], total: '65.00',
    gl: [['0', '100', -6500], ['1', '640', 6500]],
  },
  // $0, and NetSuite posts nothing for it.
  { ref: '810', type: 'Check', number: '10242', date: '2025-03-09', company: 'BMG', lines: [], total: '0.00' },
];

describe('the posting job, for checks and card charges and refunds', () => {
  let pg: PGlite;
  let clock = 0;
  /** How long a function takes, for running out of time. */
  const takes = new Map<string, number>();
  /** When a function fails, by what it was asked. */
  const failing = new Map<string, (args: Record<string, unknown>) => boolean>();
  const store = new Map<string, any>();
  const docs = new Map<string, NsSpending>();

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
    rpc: async (fn: string, args: Record<string, unknown>) => {
      clock += takes.get(fn) ?? 0;
      if (failing.get(fn)?.(args)) return { data: null, error: { message: `${fn} failed` } };
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

  // A check's or a card's entry comes from its copied lines and NetSuite's GL, so there's nothing to ask NetSuite.
  const query = async () => { throw new Error('NetSuite was asked about lines'); };
  const run = (budgetMs = 240_000) => postInvoices(service(), { deadline: clock + budgetMs, deps: { query, now: () => clock } });

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
    'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', month, JSON.stringify(SPENDING_KINDS), 10],
  ).then((res) => res.rows[0].r);

  /** NetSuite changes a check or card, and the copies catch up. */
  const edit = async (ref: string, change: (d: NsSpending) => void) => {
    const d = docs.get(ref)!;
    change(d);
    await copy(pg, d);
  };
  const add = async (d: NsSpending) => {
    docs.set(d.ref, d);
    await copy(pg, d);
  };

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    clock = Date.parse('2025-03-15T12:00:00Z');
    for (const d of DOCS()) await add(d);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('posts each BMG check, card charge and refund the rule works out, once, in the month NetSuite booked it into, with no vendor', async () => {
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 4, replaced: 0, reversed: 0, unchanged: 0, left: 3, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect(r.notes).toEqual([
      "FleetSuite's entry for 1 check doesn't come to its total, so whatever FleetSuite holds for it stayed as it is: 10241. "
        + 'Either the copy was caught mid-refresh, and the next run looks again, or the rule leaves out a line NetSuite posts, '
        + 'which Invoices vs NetSuite shows.',
    ]);

    // Not 10236 (unworkable), 10250 (1084's), 10240 (not in the GL copy), C-808 (no lines yet), 10241 (doesn't come to
    // its total) or 10242 ($0).
    expect(await journal()).toEqual([
      { no: 1, date: JAN, key: 'card_charge:807:1', reverses: null, memo: 'C-807, Sample Supply Co' },
      { no: 2, date: '2025-01-10', key: 'check:801:1', reverses: null, memo: '10234, Sample Supply Co' },
      { no: 3, date: '2025-02-05', key: 'card_charge:802:1', reverses: null, memo: 'NetSuite 802, Another Supplier' },
      { no: 4, date: '2025-02-20', key: 'card_refund:803:1', reverses: null, memo: 'R-803, Another Supplier' },
    ]);
    expect(await ruleOf(2)).toEqual({ rule: 'spending@1', type: 'check', source: '801' });
    expect(await linesOf(2)).toEqual([
      { account: '100', debit: '0.00', credit: '165.12', vendor_ref: null, item_number: null, source_line_ref: 'paid_from' },
      { account: '640', debit: '45.12', credit: '0.00', vendor_ref: null, item_number: null, source_line_ref: '1' },
      { account: '610', debit: '120.00', credit: '0.00', vendor_ref: null, item_number: 'SUPPLY-2', source_line_ref: '2' },
    ]);
    // Stock on the card goes to inventory; the refund puts money back on the card.
    expect(await ruleOf(3)).toEqual({ rule: 'spending@1', type: 'card_charge', source: '802' });
    expect(await linesOf(3)).toEqual([
      { account: '220', debit: '0.00', credit: '300.00', vendor_ref: null, item_number: null, source_line_ref: 'paid_from' },
      { account: '130', debit: '300.00', credit: '0.00', vendor_ref: null, item_number: 'WIDGET-1', source_line_ref: '1' },
    ]);
    expect(await ruleOf(4)).toEqual({ rule: 'spending@1', type: 'card_refund', source: '803' });
    expect((await linesOf(4)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([['220', '25.99', '0.00'], ['610', '0.00', '25.99']]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);

    // Differences: what's posted comes to NetSuite's; 10236, C-808 and 10241 are the ones that differ, and why can be told.
    expect((await differing(JAN)).counts).toEqual({});
    const feb = await differing(FEB);
    expect(feb.counts).toEqual({ check: 1 });
    expect(feb.documents[0]).toMatchObject({
      kind: 'check', netsuite_id: '804', fleetsuite: { entries: 0, standing: null },
      copy: { number: '10236', customer: 'Sample Supply Co', voided: false, deleted: false },
    });
    expect((await differing(MAR)).counts).toEqual({ card_charge: 1, check: 1 });
  });

  it('changes nothing on the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 4, left: 3 });
    expect(await journal()).toEqual(before);
  });

  it('replaces an entry when NetSuite changes what it posts or when, and not for a new number or payee, which only its memo carries', async () => {
    await edit('801', (d) => { d.number = '10234-A'; d.payee = '51'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, unchanged: 4 });

    // More for meals.
    await edit('801', (d) => { d.lines = [['1', null, '640', '55.12'], ['2', '902', null, '120.00']]; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, unchanged: 3 });
    expect((await journal()).slice(-2)).toEqual([
      { no: 5, date: '2025-01-10', key: null, reverses: 2, memo: '10234-A changed in NetSuite' },
      { no: 6, date: '2025-01-10', key: 'check:801:2', reverses: null, memo: '10234-A, Another Supplier' },
    ]);
    expect((await linesOf(6)).map((l: any) => [l.source_line_ref, l.debit, l.credit])).toEqual([
      ['paid_from', '0.00', '175.12'], ['1', '55.12', '0.00'], ['2', '120.00', '0.00'],
    ]);

    // The card's stock was supplies after all, the refund came a day later, and NetSuite moved C-807 into February.
    await edit('802', (d) => { d.lines = [['1', '902', null, '300.00']]; });
    await edit('803', (d) => { d.date = '2025-02-21'; });
    await edit('807', (d) => { d.booked = FEB; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 3, unchanged: 1, left: 3 });
    expect((await journal()).slice(-6)).toEqual([
      { no: 7, date: JAN, key: null, reverses: 1, memo: 'C-807 changed in NetSuite' },
      { no: 8, date: FEB, key: 'card_charge:807:2', reverses: null, memo: 'C-807, Sample Supply Co' },
      { no: 9, date: '2025-02-05', key: null, reverses: 3, memo: 'NetSuite 802 changed in NetSuite' },
      { no: 10, date: '2025-02-05', key: 'card_charge:802:2', reverses: null, memo: 'NetSuite 802, Another Supplier' },
      { no: 11, date: '2025-02-20', key: null, reverses: 4, memo: 'R-803 changed in NetSuite' },
      { no: 12, date: '2025-02-21', key: 'card_refund:803:2', reverses: null, memo: 'R-803, Another Supplier' },
    ]);
    expect((await linesOf(10)).map((l: any) => [l.account, l.item_number])).toEqual([['220', null], ['610', 'SUPPLY-2']]);
    // January no longer holds C-807, as NetSuite's January doesn't.
    expect((await differing(JAN)).counts).toEqual({});
  });

  it('reverses the entry of a check, card charge or refund NetSuite no longer has, voids with its lines taken away, or that comes to nothing now, once', async () => {
    await edit('801', (d) => { d.gone = true; });
    // Voided with its lines kept, as NetSuite voids with a journal entry that takes them back: it still books R-803.
    await edit('803', (d) => { d.voided = true; });
    // Out of the GL copy with its amount unchanged: the copy hasn't caught up, so its entry stays.
    await edit('802', (d) => { d.company = null; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 1, unchanged: 2, left: 4 });
    expect((await journal()).slice(-1).map((e) => [e.reverses, e.memo])).toEqual([[6, '10234-A deleted in NetSuite']]);

    // Voided with its lines taken away: NetSuite books nothing for R-803 now.
    await edit('803', (d) => { d.company = null; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 1, left: 4 });
    expect((await journal()).slice(-1).map((e) => [e.reverses, e.memo])).toEqual([[12, 'R-803 voided in NetSuite']]);

    // $0 now, and NetSuite posts no lines for $0: nothing to post, so its entry is reversed.
    await edit('802', (d) => { d.lines = []; d.total = '0.00'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 1, left: 3 });
    expect((await journal()).slice(-1).map((e) => [e.reverses, e.memo])).toEqual([[10, 'NetSuite 802 comes to nothing in NetSuite']]);

    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0 });
    expect(await journal()).toEqual(before);
  });

  it('posts one once the rule can work it out, and names one the journal refuses, without amounts', async () => {
    // NetSuite's posting of 10236 has its main line now, C-808's lines are copied, and 10241's are whole.
    await edit('804', (d) => { d.gl = undefined; });
    await edit('808', (d) => { d.lines = [['1', null, '610', '92.00']]; d.total = undefined; d.gl = undefined; });
    await edit('809', (d) => { d.lines = [['1', null, '640', '65.00']]; d.total = undefined; d.gl = undefined; });
    // Out of a checking account NetSuite has made inactive since, and out of one only 1084 may use.
    await add({ ref: '811', type: 'Check', number: '10243', date: '2025-03-10', company: 'BMG', from: '101', lines: [['1', null, '640', '9.00']] });
    await add({ ref: '812', type: 'Check', number: '10244', date: '2025-03-11', company: 'BMG', from: '106', lines: [['1', null, '640', '8.00']] });

    const r = await run();
    expect(r).toMatchObject({
      posted: 4, left: 0, failedCount: 1, failed: [{ number: '10244', reason: 'Account 1060 (Checking 1084) belongs to another company' }],
    });
    expect(r.notes).toBeUndefined();
    const posted = (await journal()).slice(-4);
    expect(posted.map((e) => [e.date, e.key])).toEqual([
      ['2025-02-24', 'check:804:1'], ['2025-03-06', 'card_charge:808:1'], ['2025-03-08', 'check:809:1'], ['2025-03-10', 'check:811:1'],
    ]);
    // The inactive account gives the money NetSuite took out of it.
    expect((await linesOf(posted[3].no)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([
      ['101', '0.00', '9.00'],
      ['640', '9.00', '0.00'],
    ]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);
    expect((await differing(MAR)).counts).toEqual({ check: 1 });
  });

  it('never starts a check or card write with under five seconds left, and does that month again next run', async () => {
    await edit('812', (d) => { d.from = '100'; });
    await add({ ref: '813', type: 'CardChrg', number: 'C-813', date: '2025-01-20', company: 'BMG', lines: [['1', null, '640', '40.00']] });
    const before = await journal();

    takes.set('gl_spending_month', 26_000);
    expect(await run(30_000)).toMatchObject({ months: [], posted: 0, partial: true });
    expect(store.get(BOOKS_INVOICE_POSTING).last_result.resume).toEqual({ company: 'BMG', month: JAN });
    expect(await journal()).toEqual(before);

    takes.clear();
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 2, failedCount: 0 });
    expect(r.partial).toBeUndefined();
    expect((await journal()).slice(-2).map((e) => e.key)).toEqual(['card_charge:813:1', 'check:812:1']);
  });

  it('stops, saying why, and writes nothing when it can\'t read the checks and cards or what the journal holds for them', async () => {
    // NetSuite changes C-813, so a run that could read everything would replace its entry.
    await edit('813', (d) => { d.lines = [['1', null, '640', '41.00']]; });
    const before = await journal();
    // Each error says what it was reading.
    const reads: Array<[string, (args: Record<string, unknown>) => boolean, string]> = [
      ['gl_spending_month', () => true, "BMG's checks and cards for Jan 2025"],
      // Step 1's read of every entry, then a month's read of its documents' entries.
      ['gl_spending_postings', (args) => args.p_source_ids === null, "the journal's entries for BMG's checks and cards"],
      ['gl_spending_postings', (args) => args.p_source_ids !== null, "the journal's entries for BMG's checks and cards in Jan 2025"],
    ];
    for (const [fn, when, what] of reads) {
      failing.set(fn, when);
      const r = await run();
      failing.clear();
      expect(r.error, fn).toBe(`Reading ${what}: ${fn} failed`);
      expect(await journal(), fn).toEqual(before);
    }

    // It can read them again: the next run carries on.
    const r = await run();
    expect(r).toMatchObject({ posted: 0, replaced: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['card_charge:813:2']);
  });

  it('names checks, card charges and refunds that don\'t come to their totals in one note, and keeps what stands for them', async () => {
    // Each copy of their lines caught mid-refresh: C-808's and 10241's entries stand, R-814 is new.
    await edit('808', (d) => { d.lines = [['1', null, '610', '90.00']]; d.total = '92.00'; d.gl = [['0', '220', -9200], ['1', '610', 9200]]; });
    await edit('809', (d) => { d.lines = [['1', null, '640', '60.00']]; d.total = '65.00'; d.gl = [['0', '100', -6500], ['1', '640', 6500]]; });
    await add({
      ref: '814', type: 'CardRfnd', number: 'R-814', date: '2025-03-12', company: 'BMG', lines: [['1', null, '610', '10.00']], total: '12.00',
      gl: [['0', '220', 1200], ['1', '610', -1200]],
    });
    const before = await journal();

    const r = await run();
    expect(r).toMatchObject({ posted: 0, replaced: 0, reversed: 0, failedCount: 0 });
    expect(r.notes).toEqual([
      "FleetSuite's entries for 1 check, 1 card charge and 1 card refund don't come to their totals, so whatever FleetSuite holds for "
        + 'them stayed as it is: C-808, 10241, R-814. Either the copies were caught mid-refresh, and the next run looks again, or the '
        + 'rule leaves out a line NetSuite posts, which Invoices vs NetSuite shows.',
    ]);
    expect(await journal()).toEqual(before);
  });

  it('posts a check NetSuite voided but still books, and the journal entry that takes it back, so the two come to nothing as in NetSuite', async () => {
    await add({ ref: '815', type: 'Check', number: '10245', date: '2025-03-13', company: 'BMG', lines: [['1', null, '640', '20.00']], voided: true });
    // NetSuite's journal entry voiding it: each of its lines the other way round.
    await pg.query(
      `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
       VALUES ('915', 'Journal', 'JE915', '2025-03-14', $1, 'x', 's')`,
      [MAR],
    );
    for (const [line, account, debit, credit] of [['0', '100', '20.00', '0.00'], ['1', '640', '0.00', '20.00']]) {
      await pg.query(
        `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, memo)
         SELECT '915', $1, id, $2, $3, '2025-03-14', $4, $5, 'VOID: 10245' FROM gl_companies WHERE code = 'BMG'`,
        [line, account, MAR, debit, credit],
      );
    }

    expect(await run()).toMatchObject({ posted: 2, replaced: 0, reversed: 0, failedCount: 0 });
    const [paid, back] = (await journal()).slice(-2);
    expect([paid.key, back.key]).toEqual(['check:815:1', 'journal_entry:915:1']);
    const net = await pg.query<{ account: string; net: string }>(
      `SELECT a.netsuite_account_id AS account, sum(l.debit - l.credit)::text AS net
       FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
       WHERE e.entry_no IN ($1, $2) GROUP BY 1 ORDER BY 1`,
      [paid.no, back.no],
    );
    expect(net.rows).toEqual([{ account: '100', net: '0.00' }, { account: '640', net: '0.00' }]);
    const kinds = { ...SPENDING_KINDS, [JOURNAL_ENTRY_SOURCE_TYPE]: NETSUITE_TYPE[JOURNAL_ENTRY_SOURCE_TYPE] };
    // March's other differences are the checks and cards whose lines don't come to their totals.
    const differs = await pg.query<{ r: { documents: Array<{ netsuite_id: string }> } }>(
      'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', MAR, JSON.stringify(kinds), 10],
    );
    const ids = differs.rows[0].r.documents.map((d) => d.netsuite_id);
    expect(ids).not.toContain('815');
    expect(ids).not.toContain('915');

    // Neither step of the next run takes it back: its entry stands as NetSuite's posting of it does.
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, failedCount: 0 });
    expect(await journal()).toEqual(before);
  });
});
