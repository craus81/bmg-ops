// Migration 367 posts NetSuite's invoices to FleetSuite's own journal, and
// migration 370 its credit memos; migration 380 puts each in the month
// NetSuite booked it to. This runs migration 314 (with stand-ins for the app
// tables it points at) and migrations 359–364, 367, 370 and 380, with the
// ones the job reads payments, deposits and bills through (374, 376, 377 and
// 382–386), in an in-memory Postgres (PGlite) as the app's server login and
// holds the functions' rules, then runs the posting job against them with a
// fake NetSuite that answers the job's own SuiteQL.
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

import { BOOKS_INVOICE_POSTING, postInvoices, type InvoicePosting } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import type { InvoiceMonthData } from './invoice-check';

const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';
/** Made-up chart: '120' BMG's receivable, '121' 1084's, '400' income, '220' sales tax, '410' an income account no longer used. */
const ACCOUNT: Record<string, string> = {
  120: 'a0000000-0000-4000-8000-000000000120',
  121: 'a0000000-0000-4000-8000-000000000121',
  400: 'a0000000-0000-4000-8000-000000000400',
  220: 'a0000000-0000-4000-8000-000000000220',
  410: 'a0000000-0000-4000-8000-000000000410',
};
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';

// A fresh database with Supabase's API roles and default grants, migrations
// 314, 359–364, 367 and 370 run twice as the owner, a made-up chart of
// accounts and copy of NetSuite's items, then the app's server login.
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
    '384-books-vendor-bills.sql', '385-books-bill-item-accounts.sql', '386-books-bill-posting.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084';
    INSERT INTO customers (id) VALUES ('${CUSTOMER}');
    INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active) VALUES
      ('${ACCOUNT[120]}', '1200', 'Receivables', 'accounts_receivable', '120', (SELECT id FROM gl_companies WHERE code = 'BMG'), true),
      ('${ACCOUNT[121]}', '1210', 'Receivables 1084', 'accounts_receivable', '121', (SELECT id FROM gl_companies WHERE code = '1084'), true),
      ('${ACCOUNT[400]}', '4000', 'Sales', 'income', '400', NULL, true),
      ('${ACCOUNT[220]}', '2200', 'Sales Tax', 'other_current_liability', '220', NULL, true),
      ('${ACCOUNT[410]}', '4100', 'Old Sales', 'income', '410', NULL, false);
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('item', '11', 'PART-A', true, '{"item_type": "InvtPart", "income_account": "400", "asset_account": "130"}'),
      ('item', '12', 'RENT', true, '{"item_type": "Service", "income_account": "401"}'),
      ('item', '13', 'INSTALL LABOR', true, '{"item_type": "Service", "income_account": "400"}'),
      ('item', '14', 'OLD-PART', true, '{"item_type": "Service", "income_account": "410"}'),
      ('item', '15', 'NEW-PART', true, '{"item_type": "Service", "income_account": "420"}'),
      ('tax_code', '900', 'Some County', true, '{"rate": 7.5}');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

/** A Postgres text[] literal, as PostgREST sends a list. */
const textArray = (items: string[]) => `{${items.map((s) => `"${s.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

// ── NetSuite's invoices and credit memos, and the copies of them ───────────

interface NsLine {
  id: string;
  kind: 'item' | 'tax';
  /** The item, or on a tax line its tax code. */
  item: string;
  number: string | null;
  /** What the line charges, as NetSuite shows it. */
  amount: string;
  /** Where NetSuite posted it. */
  account: string;
}

interface NsInvoice {
  /** A credit memo, which NetSuite posts the other way round; an invoice when left out. */
  kind?: 'credit_memo';
  ref: string;
  number: string;
  date: string;
  /** The month NetSuite booked it to, 'YYYY-MM-01'; its date's month when left out. */
  booked?: string;
  /** The company NetSuite posted it to; null when it hasn't posted it (waiting for approval, say). */
  company: 'BMG' | '1084' | null;
  customer?: string;
  customerId?: string | null;
  lines: NsLine[];
  voided?: boolean;
  deleted?: boolean;
}

const part = (amount: string, id = '1'): NsLine => ({ id, kind: 'item', item: '11', number: 'PART-A', amount, account: '400' });
const labor = (amount: string, id = '1'): NsLine => ({ id, kind: 'item', item: '13', number: 'INSTALL LABOR', amount, account: '400' });
const tax = (amount: string, id: string): NsLine => ({ id, kind: 'tax', item: '900', number: null, amount, account: '220' });

/**
 * Copies an invoice or credit memo as the ledger mirror and the GL copy
 * would. `lines` are the mirror's when it hasn't caught up with NetSuite's
 * (null: it has copied none yet). The mirror keeps NetSuite's signed net
 * amounts, a sale negative on an invoice and positive on a credit memo, and
 * NetSuite posts a credit memo the other way round.
 */
async function copy(pg: PGlite, inv: NsInvoice, lines: NsLine[] | null = inv.lines) {
  const memo = inv.kind === 'credit_memo';
  await pg.query('DELETE FROM ledger_invoices WHERE external_ref = $1', [inv.ref]);
  await pg.query('DELETE FROM gl_netsuite_transactions WHERE netsuite_id = $1', [inv.ref]);
  const total = (inv.lines.reduce((sum, l) => sum + Math.round(Number(l.amount) * 100), 0) / 100).toFixed(2);
  const doc = await pg.query<{ id: string }>(
    `INSERT INTO ledger_invoices (source, external_id, external_ref, doc_type, doc_number, doc_date, total, voided, deleted_at,
                                  lines_synced_at, party_name, customer_id)
     VALUES ('netsuite', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [`${memo ? 'CustCred' : 'CustInvc'}/${inv.ref}`, inv.ref, memo ? 'credit_memo' : 'invoice', inv.number, inv.date, total, !!inv.voided,
      inv.deleted ? '2025-03-14T00:00:00Z' : null, lines ? '2025-03-14T00:00:00Z' : null, inv.customer ?? 'A Customer', inv.customerId ?? null],
  );
  for (const [i, l] of (lines ?? inv.lines).entries()) {
    await pg.query(
      `INSERT INTO ledger_invoice_lines (document_id, line_external_id, line_no, line_kind, item_external_id, item_number, amount, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [doc.rows[0].id, l.id, i + 1, l.kind, l.item, l.number, l.amount, JSON.stringify(lines ? { netamount: `${memo ? '' : '-'}${l.amount}` } : {})],
    );
  }
  if (!inv.company || inv.deleted) return;
  const month = inv.booked ?? `${inv.date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [inv.ref, memo ? 'CustCred' : 'CustInvc', inv.number, inv.date, month],
  );
  const side = (amount: string) => (memo ? { debit: amount, credit: '0.00' } : { debit: '0.00', credit: amount });
  const posted = [
    { id: '0', account: inv.company === 'BMG' ? '120' : '121', ...(memo ? { debit: '0.00', credit: total } : { debit: total, credit: '0.00' }) },
    ...inv.lines.map((l) => ({ id: l.id, account: l.account, ...side(l.amount) })),
  ];
  for (const p of posted) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [inv.ref, p.id, p.account, month, inv.date, p.debit, p.credit, inv.company],
    );
  }
}

/** Answers the posting job's SuiteQL (invoice-line-facts.ts) from its invoices. */
class FakeNetSuite {
  invoices = new Map<string, NsInvoice>();
  queries = 0;
  /** Thrown instead of answering. */
  fail: Error | null = null;
  /** A column NetSuite won't give. */
  refuse: string | null = null;
  /** How long each answer takes. */
  takes = 0;

  constructor(private wait: (ms: number) => void) {}

  query = async (q: string): Promise<Array<Record<string, unknown>>> => {
    this.queries += 1;
    this.wait(this.takes);
    if (this.fail) throw this.fail;
    const columns = (q.match(/AS line_id((?:, tl\.\w+)*)/)?.[1] ?? '').split(', tl.').filter(Boolean);
    if (this.refuse && columns.includes(this.refuse)) {
      throw Object.assign(
        new Error(`NetSuite SuiteQL error (400): {"title":"Bad Request","o:errorDetails":[{"detail":"Invalid search query. Field '${this.refuse}' for record 'transactionLine' was not found.","o:errorCode":"INVALID_PARAMETER"}]}`),
        { status: 400 },
      );
    }
    const ids = (q.match(/tl\.transaction IN \(([\d, ]+)\)/)?.[1] ?? '').split(',').map((s) => s.trim());
    return ids.flatMap((id) => (this.invoices.get(id)?.lines ?? []).map((l) => {
      const sign = this.invoices.get(id)?.kind === 'credit_memo' ? '' : '-';
      const says: Record<string, unknown> = { iscogs: 'F', transactiondiscount: 'F', foreignamount: `${sign}${l.amount}`, quantity: '1', rate: l.amount };
      return { txn_id: Number(id), line_id: Number(l.id), ...Object.fromEntries(columns.map((c) => [c, says[c]])) };
    }));
  };
}

// ── The functions ──────────────────────────────────────────────────────────

describe('migrations 367 and 370\'s functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await copy(db, { ref: '301', number: 'INV301', date: '2025-02-05', company: 'BMG', customerId: CUSTOMER, lines: [part('10.00')] });
    await copy(db, { ref: '304', number: 'INV304', date: '2025-02-06', company: 'BMG', lines: [part('10.00')] });
    await copy(db, { kind: 'credit_memo', ref: '305', number: 'CM305', date: '2025-02-07', company: 'BMG', customerId: CUSTOMER, lines: [part('4.00')] });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const entry = (company: string, key: string, sourceId: string, amount: string, fields: Record<string, unknown> = {}) => ({
    company,
    entry_date: '2025-02-05',
    source_type: 'invoice',
    source_id: sourceId,
    posting_rule: 'invoice@1',
    idempotency_key: key,
    memo: `INV${sourceId}, A Customer`,
    lines: [
      { account_id: company === 'BMG' ? ACCOUNT[120] : ACCOUNT[121], debit: amount, source_line_ref: '0', customer_id: CUSTOMER },
      { account_id: ACCOUNT[400], credit: amount, division: 'upfit', item_number: 'PART-A', source_line_ref: '1' },
    ],
    ...fields,
  });
  const post = (p: unknown) => one<{ id: string; entry_no: number; already_posted: boolean }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
  const repost = (entryId: string, memo: string, p: unknown) =>
    one<{ reversal: { id: string; entry_no: number }; entry: { id: string; entry_no: number; already_posted: boolean } }>(
      'SELECT gl_repost_entry($1::uuid, $2, $3::jsonb) AS r', [entryId, memo, JSON.stringify(p)],
    );
  const postings = async (company: string, ids: string[] | null, lines: boolean) =>
    (await one<{ invoices: InvoicePosting[] }>('SELECT gl_invoice_postings($1, $2::text[], $3) AS r', [company, ids && textArray(ids), lines])).invoices;
  const entries = async () => (await db.query<{ no: number; memo: string | null; reverses: number | null }>(
    `SELECT e.entry_no::int AS no, e.memo, r.entry_no::int AS reverses
     FROM gl_entries e LEFT JOIN gl_entries r ON r.id = e.reverses_entry_id ORDER BY e.entry_no`,
  )).rows;

  let first: { id: string; entry_no: number };
  let second: { id: string; entry_no: number };

  it('gl_invoice_month gives each invoice and credit memo its kind and the FleetSuite customer the ledger mirror matched it to', async () => {
    const month = await one<InvoiceMonthData>(`SELECT gl_invoice_month('BMG', '2025-02-01') AS r`);
    expect(month.invoices.map((i) => [i.number, i.doc_type, i.customer_id])).toEqual([
      ['INV301', 'invoice', CUSTOMER], ['INV304', 'invoice', null], ['CM305', 'credit_memo', CUSTOMER],
    ]);
    // A credit memo's lines come signed the other way round, and NetSuite credits receivables.
    const memo = month.invoices[2];
    expect(memo.lines.map((l) => [l.line_id, l.amount, l.netamount])).toEqual([['1', '4.00', '4.00']]);
    expect(memo.netsuite).toEqual([
      { line_id: '0', account: '120', debit: '0.00', credit: '4.00' },
      { line_id: '1', account: '400', debit: '4.00', credit: '0.00' },
    ]);
  });

  it('gl_invoice_month lists a document in the month NetSuite booked it to, and by its date when NetSuite booked it nowhere', async () => {
    const extra: NsInvoice[] = [
      // Dated before the books start, carried by NetSuite into February 2025.
      { ref: '310', number: 'INV310', date: '2024-11-20', booked: FEB, company: 'BMG', lines: [part('5.00')] },
      // Dated in January, booked into March.
      { ref: '311', number: 'INV311', date: '2025-01-28', booked: MAR, company: 'BMG', lines: [part('6.00')] },
      // Dated in February, not posted in NetSuite.
      { ref: '312', number: 'INV312', date: '2025-02-25', company: null, lines: [part('7.00')] },
    ];
    for (const inv of extra) await copy(db, inv);
    const listed = async (month: string) => (await one<InvoiceMonthData>(`SELECT gl_invoice_month('BMG', $1) AS r`, [month])).invoices
      .map((i) => [i.number, i.date, i.posting_month]);
    expect(await listed(JAN)).toEqual([]);
    expect(await listed(FEB)).toEqual([
      ['INV310', '2024-11-20', FEB], ['INV301', '2025-02-05', FEB], ['INV304', '2025-02-06', FEB], ['CM305', '2025-02-07', FEB],
      ['INV312', '2025-02-25', null],
    ]);
    expect(await listed(MAR)).toEqual([['INV311', '2025-01-28', MAR]]);
    expect(await listed('2024-11-01')).toEqual([]);
    await db.query(`DELETE FROM ledger_invoices WHERE external_ref IN ('310', '311', '312')`);
    await db.query(`DELETE FROM gl_netsuite_transactions WHERE netsuite_id IN ('310', '311', '312')`);
  });

  it('gl_repost_entry reverses a document\'s entry and posts its new one together', async () => {
    first = await post(entry('BMG', 'invoice:301:1', '301', '10.00'));
    const r = await repost(first.id, 'INV301 changed in NetSuite', entry('BMG', 'invoice:301:2', '301', '12.00'));
    second = r.entry;
    expect(r).toEqual({
      reversal: { id: expect.any(String), entry_no: first.entry_no + 1 },
      entry: { id: expect.any(String), entry_no: first.entry_no + 2, already_posted: false },
    });
    expect(await entries()).toEqual([
      { no: 1, memo: 'INV301, A Customer', reverses: null },
      { no: 2, memo: 'INV301 changed in NetSuite', reverses: 1 },
      { no: 3, memo: 'INV301, A Customer', reverses: null },
    ]);
    // The reversal is the old entry's mirror image, customer and all.
    const lines = await db.query(
      `SELECT e.entry_no::int AS no, l.debit::text AS debit, l.credit::text AS credit, l.customer_id
       FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id ORDER BY e.entry_no, l.line_no`,
    );
    expect(lines.rows).toEqual([
      { no: 1, debit: '10.00', credit: '0.00', customer_id: CUSTOMER },
      { no: 1, debit: '0.00', credit: '10.00', customer_id: null },
      { no: 2, debit: '0.00', credit: '10.00', customer_id: CUSTOMER },
      { no: 2, debit: '10.00', credit: '0.00', customer_id: null },
      { no: 3, debit: '12.00', credit: '0.00', customer_id: CUSTOMER },
      { no: 3, debit: '0.00', credit: '12.00', customer_id: null },
    ]);
  });

  it('gl_repost_entry changes nothing unless it can do both', async () => {
    const before = await entries();
    const reversal = (await db.query<{ id: string }>('SELECT id FROM gl_entries WHERE entry_no = 2')).rows[0].id;
    const refused: Array<[string, unknown, RegExp]> = [
      // Another invoice, another company, or not an invoice at all.
      [second.id, entry('BMG', 'invoice:999:1', '999', '12.00'), /entry 3 is another document's, so it isn't replaced/],
      [second.id, entry('1084', 'invoice:301:3', '301', '12.00'), /another document's/],
      [second.id, entry('BMG', 'manual:1', '301', '12.00', { source_type: 'manual' }), /another document's/],
      // The new entry can't post: the journal's own rules hold, and the old entry stays as it was.
      [second.id, entry('BMG', 'invoice:301:3', '301', '12.00', { lines: [{ account_id: ACCOUNT[120], debit: '12.00' }, { account_id: ACCOUNT[410], credit: '12.00' }] }), /account 4100 \(Old Sales\) is inactive/],
      [second.id, entry('BMG', 'invoice:301:3', '301', '12.00', { lines: [{ account_id: ACCOUNT[120], debit: '12.00' }, { account_id: ACCOUNT[400], credit: '11.00' }] }), /does not balance/],
      [second.id, entry('BMG', 'invoice:301:1', '301', '12.00'), /invoice:301:1 has already posted, so entry 3 stays as it is/],
      // An entry already reversed, or a reversal.
      [first.id, entry('BMG', 'invoice:301:3', '301', '12.00'), /entry 1 is already reversed/],
      [reversal, entry('BMG', 'invoice:301:3', '301', '12.00'), /another document's/],
      ['00000000-0000-4000-8000-000000000000', entry('BMG', 'invoice:301:3', '301', '12.00'), /no entry/],
    ];
    for (const [entryId, p, why] of refused) {
      await expect(repost(entryId, 'INV301 changed in NetSuite', p)).rejects.toThrow(why);
    }
    expect(await entries()).toEqual(before);
  });

  it('gl_invoice_postings says what the journal holds for each invoice and what the copy says of it', async () => {
    const other = await post(entry('BMG', 'invoice:302:1', '302', '7.00'));
    await post(entry('1084', 'invoice:303:1', '303', '5.00'));
    await post(entry('BMG', 'manual:1', 'x', '1.00', { source_type: 'manual' }));

    expect(await postings('BMG', null, false)).toEqual([
      {
        source_type: 'invoice',
        source_id: '301',
        entries: 2,
        unreversed: [second.id],
        history: [
          { entry_no: 1, entry_date: '2025-02-05', reversed_by: 2 },
          { entry_no: 3, entry_date: '2025-02-05', reversed_by: null },
        ],
        current: { id: second.id, entry_no: 3, entry_date: '2025-02-05', lines: null },
        invoice: { number: 'INV301', deleted: false, voided: false },
      },
      {
        // Not in the copy of NetSuite's invoices.
        source_type: 'invoice',
        source_id: '302',
        entries: 1,
        unreversed: [other.id],
        history: [{ entry_no: other.entry_no, entry_date: '2025-02-05', reversed_by: null }],
        current: { id: other.id, entry_no: other.entry_no, entry_date: '2025-02-05', lines: null },
        invoice: null,
      },
    ]);

    // Only the invoices asked about, with the lines of the entry that stands.
    const [held] = await postings('BMG', ['301', '999'], true);
    expect(held.source_id).toBe('301');
    expect(held.current?.lines).toEqual([
      { account: '120', debit: '12.00', credit: '0.00', division: null, source_line_ref: '0', customer_id: CUSTOMER },
      { account: '400', debit: '0.00', credit: '12.00', division: 'upfit', source_line_ref: '1', customer_id: null },
    ]);
    expect(await postings('BMG', ['999'], true)).toEqual([]);
    expect((await postings('1084', null, false)).map((p) => p.source_id)).toEqual(['303']);

    // Nothing stands once its entry is reversed; a deleted or voided invoice says so.
    await one(`SELECT gl_reverse_entry($1::uuid, NULL, 'INV302 deleted in NetSuite', NULL, NULL) AS r`, [other.id]);
    await db.query(`UPDATE ledger_invoices SET deleted_at = now() WHERE external_ref = '301'`);
    await db.query(`UPDATE ledger_invoices SET voided = true WHERE external_ref = '304'`);
    await post(entry('BMG', 'invoice:304:1', '304', '10.00'));
    const after = await postings('BMG', ['301', '302', '304'], false);
    expect(after.map((p) => [p.source_id, p.unreversed.length, p.current?.entry_no ?? null, p.invoice])).toEqual([
      ['301', 1, 3, { number: 'INV301', deleted: true, voided: false }],
      ['302', 0, null, null],
      ['304', 1, expect.any(Number), { number: 'INV304', deleted: false, voided: true }],
    ]);
  });

  it('gl_invoice_postings reads credit memos too, each looked up among the copies of its own kind', async () => {
    const memoEntry = (key: string, amount: string) => entry('BMG', key, '305', amount, {
      source_type: 'credit_memo',
      posting_rule: 'credit_memo@1',
      memo: 'CM305, A Customer',
      lines: [
        { account_id: ACCOUNT[120], credit: amount, source_line_ref: '0', customer_id: CUSTOMER },
        { account_id: ACCOUNT[400], debit: amount, division: 'upfit', item_number: 'PART-A', source_line_ref: '1' },
      ],
    });
    const memo = await post(memoEntry('credit_memo:305:1', '4.00'));
    const replaced = (await repost(memo.id, 'CM305 changed in NetSuite', memoEntry('credit_memo:305:2', '5.00'))).entry;
    // An invoice's entry under the credit memo's NetSuite id is another document's, and finds no invoice of that id in the copy.
    await post(entry('BMG', 'invoice:305:1', '305', '1.00'));

    const held = await postings('BMG', ['305'], true);
    expect(held.map((p) => [p.source_type, p.source_id, p.entries, p.unreversed.length, p.invoice])).toEqual([
      ['credit_memo', '305', 2, 1, { number: 'CM305', deleted: false, voided: false }],
      ['invoice', '305', 1, 1, null],
    ]);
    expect(held[0].current).toEqual({
      id: replaced.id,
      entry_no: replaced.entry_no,
      entry_date: '2025-02-05',
      lines: [
        { account: '120', debit: '0.00', credit: '5.00', division: null, source_line_ref: '0', customer_id: CUSTOMER },
        { account: '400', debit: '5.00', credit: '0.00', division: 'upfit', source_line_ref: '1', customer_id: null },
      ],
    });
    // A credit memo's entry can't be replaced with an invoice's, or the other way round.
    await expect(repost(replaced.id, 'CM305 changed in NetSuite', entry('BMG', 'invoice:305:2', '305', '5.00'))).rejects.toThrow(/another document's/);
  });

  it('is the service role\'s alone', async () => {
    const functions = ['gl_invoice_month(text, date)', 'gl_invoice_postings(text, text[], boolean)', 'gl_repost_entry(uuid, text, jsonb)'];
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const f of functions) {
        expect(await one<boolean>(`SELECT has_function_privilege($1::name, $2::text, 'EXECUTE') AS r`, [role, f]), `${role} ${f}`).toBe(role === 'service_role');
      }
    }
  });

  // Supabase's API connections fail a DELETE or UPDATE with no WHERE, even
  // inside a function (migrations/README.md); these write only through the
  // journal's own functions.
  it('writes nothing itself', async () => {
    const bodies = (await db.query<{ name: string; body: string }>(
      `SELECT proname AS name, prosrc AS body FROM pg_proc
       WHERE proname IN ('gl_invoice_month', 'gl_invoice_postings', 'gl_repost_entry') ORDER BY proname`,
    )).rows;
    expect(bodies.map((b) => b.name)).toEqual(['gl_invoice_month', 'gl_invoice_postings', 'gl_repost_entry']);
    for (const { name, body } of bodies) expect(body, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});

// ── The job ────────────────────────────────────────────────────────────────

// Made-up invoices, from January to March 2025.
const INVOICES = (): NsInvoice[] => [
  { ref: '201', number: 'INV201', date: '2025-01-10', company: 'BMG', customerId: CUSTOMER, lines: [part('100.00'), labor('50.00', '2'), tax('12.00', '3')] },
  { ref: '202', number: 'INV202', date: '2025-02-05', company: 'BMG', lines: [labor('80.00')] },
  // An item the copy of NetSuite's items doesn't have, so the rule can't work it out.
  { ref: '203', number: 'INV203', date: '2025-02-20', company: 'BMG', lines: [{ id: '1', kind: 'item', item: '77', number: 'NOT-COPIED', amount: '30.00', account: '400' }] },
  { ref: '204', number: 'INV204', date: '2025-03-03', company: 'BMG', customerId: CUSTOMER, lines: [part('40.00')] },
  // 1084's invoices don't post yet.
  { ref: '205', number: 'INV205', date: '2025-03-04', company: '1084', lines: [{ id: '1', kind: 'item', item: '12', number: 'RENT', amount: '100.00', account: '401' }] },
  // Its lines aren't copied yet.
  { ref: '206', number: 'INV206', date: '2025-03-05', company: 'BMG', lines: [labor('20.00')] },
  // NetSuite hasn't posted it.
  { ref: '207', number: 'INV207', date: '2025-03-06', company: null, lines: [part('10.00')] },
  // Copied mid-refresh: the copy's lines are older than its total.
  { ref: '208', number: 'INV208', date: '2025-03-07', company: 'BMG', lines: [labor('25.00')] },
];

describe('the posting job against the real functions', () => {
  let pg: PGlite;
  let clock = 0;
  const store = new Map<string, any>();
  const ns = new FakeNetSuite((ms) => { clock += ms; });

  // sync_state in memory; gl_accounts, gl_companies and every function the
  // real ones, called the way supabase-js calls them: by name, with named
  // arguments.
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

  const run = (budgetMs = 240_000) => postInvoices(service(), { deadline: clock + budgetMs, deps: { query: ns.query, now: () => clock } });
  const record = () => store.get(BOOKS_INVOICE_POSTING);

  /** The journal, entry by entry: an invoice's entry by its key, a reversal by the entry it reverses. */
  const journal = async () => (await pg.query<{ no: number; date: string; key: string | null; reverses: number | null; memo: string | null }>(
    `SELECT e.entry_no::int AS no, to_char(e.entry_date, 'YYYY-MM-DD') AS date,
            CASE WHEN e.reverses_entry_id IS NULL THEN e.idempotency_key END AS key, r.entry_no::int AS reverses, e.memo
     FROM gl_entries e LEFT JOIN gl_entries r ON r.id = e.reverses_entry_id
     ORDER BY e.entry_no`,
  )).rows;
  const linesOf = async (no: number) => (await pg.query(
    `SELECT a.netsuite_account_id AS account, l.debit::text AS debit, l.credit::text AS credit, l.division, l.customer_id,
            l.item_number, l.source_line_ref
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
     WHERE e.entry_no = $1 ORDER BY l.line_no`,
    [no],
  )).rows;
  /** Each account's balance, debit positive. */
  const balances = async () => Object.fromEntries((await pg.query<{ account: string; net: string }>(
    `SELECT a.netsuite_account_id AS account, sum(l.debit - l.credit)::text AS net
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id
     GROUP BY a.netsuite_account_id ORDER BY 1`,
  )).rows.map((r) => [r.account, r.net]));

  /** NetSuite changes an invoice, and the copies catch up. */
  const edit = async (ref: string, change: (inv: NsInvoice) => void) => {
    const inv = ns.invoices.get(ref)!;
    change(inv);
    await copy(pg, inv);
  };

  const startOver = async () => {
    await pg.query('SELECT gl_reset_journal()');
    await pg.exec('DELETE FROM ledger_invoices WHERE true; DELETE FROM gl_netsuite_transactions WHERE true;');
    store.clear();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [{ tax_code_id: '900', account_id: '220', lines: 40 }], itemAccounts: [] } });
    Object.assign(ns, { fail: null, refuse: null, takes: 0, queries: 0 });
    ns.invoices.clear();
    clock = Date.parse('2025-03-15T12:00:00Z');
    for (const inv of INVOICES()) {
      ns.invoices.set(inv.ref, inv);
      await copy(pg, inv, inv.ref === '206' ? null : inv.ref === '208' ? [labor('20.00')] : inv.lines);
    }
  };

  beforeAll(async () => {
    pg = await freshDb();
    await startOver();
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  describe('kept in step with NetSuite', () => {
    it('posts each BMG invoice the rule works out, once, and leaves the rest as they are', async () => {
      const r = await run();
      expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 3, replaced: 0, reversed: 0, unchanged: 0, left: 3, failedCount: 0 });
      expect(r.error).toBeUndefined();
      expect(r.partial).toBeUndefined();
      expect(r.failed).toBeUndefined();
      expect(r.notes).toEqual([
        "FleetSuite's entry for 1 invoice doesn't come to its total, so whatever FleetSuite holds for it stayed as it is: INV208. "
        + 'Either the copy was caught mid-refresh, and the next run looks again, or the rule leaves out a line NetSuite posts, '
        + 'which Invoices vs NetSuite shows.',
      ]);

      // Not INV203 (unworkable), INV205 (1084's), INV206 (lines not copied), INV207 (not posted in NetSuite) or INV208 (mid-refresh).
      expect(await journal()).toEqual([
        { no: 1, date: '2025-01-10', key: 'invoice:201:1', reverses: null, memo: 'INV201, A Customer' },
        { no: 2, date: '2025-02-05', key: 'invoice:202:1', reverses: null, memo: 'INV202, A Customer' },
        { no: 3, date: '2025-03-03', key: 'invoice:204:1', reverses: null, memo: 'INV204, A Customer' },
      ]);
      expect(await linesOf(1)).toEqual([
        { account: '120', debit: '162.00', credit: '0.00', division: null, customer_id: CUSTOMER, item_number: null, source_line_ref: '0' },
        { account: '400', debit: '0.00', credit: '100.00', division: 'upfit', customer_id: null, item_number: 'PART-A', source_line_ref: '1' },
        { account: '400', debit: '0.00', credit: '50.00', division: 'upfit', customer_id: null, item_number: 'INSTALL LABOR', source_line_ref: '2' },
        { account: '220', debit: '0.00', credit: '12.00', division: null, customer_id: null, item_number: null, source_line_ref: '3' },
      ]);
      expect(await balances()).toEqual({ 120: '282.00', 220: '-12.00', 400: '-270.00' });

      expect(record().synced).toBe(true);
      expect(record().last_result).toEqual({
        months: [JAN, FEB, MAR], posted: 3, replaced: 0, reversed: 0, unchanged: 0, left: 3, failedCount: 0,
        notes: [expect.any(String)], resume: null,
      });
      // No amount goes in the record.
      expect(JSON.stringify(record().last_result)).not.toMatch(/\d\.\d|\$/);
    });

    it('changes nothing on the next run', async () => {
      const before = await journal();
      expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 3, left: 3, failedCount: 0 });
      expect(await journal()).toEqual(before);
    });

    it('replaces an entry when NetSuite changes what the invoice posts, and not when it only renames', async () => {
      await edit('201', (inv) => { inv.customer = 'A Customer, Renamed'; });
      await edit('202', (inv) => { inv.lines = [{ ...inv.lines[0], number: 'INSTALL LABOUR' }]; });
      expect(await run()).toMatchObject({ posted: 0, replaced: 0, unchanged: 3 });
      expect(await journal()).toHaveLength(3);

      await edit('202', (inv) => { inv.lines = [{ ...inv.lines[0], amount: '90.00' }]; });
      expect(await run()).toMatchObject({ posted: 0, replaced: 1, reversed: 0, unchanged: 2, failedCount: 0 });
      expect((await journal()).slice(3)).toEqual([
        { no: 4, date: '2025-02-05', key: null, reverses: 2, memo: 'INV202 changed in NetSuite' },
        { no: 5, date: '2025-02-05', key: 'invoice:202:2', reverses: null, memo: 'INV202, A Customer' },
      ]);
      expect(await linesOf(5)).toEqual([
        { account: '120', debit: '90.00', credit: '0.00', division: null, customer_id: null, item_number: null, source_line_ref: '0' },
        { account: '400', debit: '0.00', credit: '90.00', division: 'upfit', customer_id: null, item_number: 'INSTALL LABOUR', source_line_ref: '1' },
      ]);
      expect(await balances()).toEqual({ 120: '292.00', 220: '-12.00', 400: '-280.00' });
    });

    it('reverses the entry of an invoice NetSuite voids, once', async () => {
      await edit('204', (inv) => { inv.voided = true; });
      expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 1, unchanged: 2 });
      expect((await journal()).slice(5)).toEqual([{ no: 6, date: '2025-03-03', key: null, reverses: 3, memo: 'INV204 voided in NetSuite' }]);
      expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 2 });
      expect(await journal()).toHaveLength(6);
    });

    it('reverses the entry of an invoice NetSuite deletes', async () => {
      await edit('201', (inv) => { inv.deleted = true; });
      expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 1, unchanged: 1 });
      expect((await journal()).slice(6)).toEqual([{ no: 7, date: '2025-01-10', key: null, reverses: 1, memo: 'INV201 deleted in NetSuite' }]);
      expect(await balances()).toEqual({ 120: '90.00', 220: '0.00', 400: '-90.00' });
      expect(await run()).toMatchObject({ reversed: 0 });
    });

    it('posts an invoice once its copy has caught up', async () => {
      await copy(pg, ns.invoices.get('206')!);
      await copy(pg, ns.invoices.get('208')!);
      const r = await run();
      expect(r).toMatchObject({ posted: 2, replaced: 0, reversed: 0, unchanged: 1, left: 1 });
      expect(r.notes).toBeUndefined();
      expect((await journal()).slice(7).map((e) => e.key).sort()).toEqual(['invoice:206:1', 'invoice:208:1']);
    });

    it('reverses any second entry standing for one invoice', async () => {
      await pg.query('SELECT gl_post_entry($1::jsonb)', [JSON.stringify({
        company: 'BMG', entry_date: '2025-02-05', source_type: 'invoice', source_id: '202', posting_rule: 'invoice@1', idempotency_key: 'invoice:202:x',
        lines: [{ account_id: ACCOUNT[120], debit: '1.00' }, { account_id: ACCOUNT[400], credit: '1.00' }],
      })]);
      const before = (await journal()).length;
      expect(await run()).toMatchObject({ posted: 0, replaced: 1, reversed: 1 });
      expect((await journal()).slice(before)).toEqual([
        { no: before + 1, date: '2025-02-05', key: null, reverses: 5, memo: 'INV202 had another entry standing' },
        { no: before + 2, date: '2025-02-05', key: null, reverses: before, memo: 'INV202 changed in NetSuite' },
        { no: before + 3, date: '2025-02-05', key: 'invoice:202:4', reverses: null, memo: 'INV202, A Customer' },
      ]);
      expect(await balances()).toEqual({ 120: '135.00', 220: '0.00', 400: '-135.00' });
    });
  });

  describe('runs that need care', () => {
    it('never runs while another books job holds the lock', async () => {
      const before = { journal: await journal(), record: JSON.stringify(record()), queries: ns.queries };
      await pg.query(`SELECT gl_netsuite_claim_copy('copy:someone-else', 300)`);
      expect(await run()).toEqual({ skipped: 'Another books job is running.' });
      expect(await journal()).toEqual(before.journal);
      expect(JSON.stringify(record())).toBe(before.record);
      expect(ns.queries).toBe(before.queries);
      await pg.query(`SELECT gl_netsuite_release_copy('copy:someone-else')`);
      expect((await run()).skipped).toBeUndefined();
      // Each run lets go when it's done.
      expect((await run()).skipped).toBeUndefined();
    });

    it('leaves a month as it is when NetSuite can\'t be asked about its invoices\' lines', async () => {
      await edit('202', (inv) => { inv.lines = [{ ...inv.lines[0], amount: '95.00' }]; });
      const before = await journal();

      ns.fail = new Error('socket hang up');
      let r = await run();
      expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 0, replaced: 0, reversed: 0 });
      expect(r.notes).toEqual([
        "NetSuite couldn't be asked about the invoices' and credit memos' lines (socket hang up), so no invoice or credit memo in Feb 2025 or Mar 2025 was posted or changed this time.",
      ]);

      ns.fail = null;
      ns.refuse = 'foreignamount';
      r = await run();
      expect(r).toMatchObject({ posted: 0, replaced: 0, reversed: 0 });
      expect(r.notes).toEqual([
        "NetSuite wouldn't say the lines' own amounts on the invoices and credit memos, so no invoice or credit memo in Feb 2025 or Mar 2025 was posted or changed this time.",
      ]);
      expect(await journal()).toEqual(before);

      ns.refuse = null;
      r = await run();
      expect(r).toMatchObject({ replaced: 1 });
      expect(r.notes).toBeUndefined();
    });

    it('says which invoices the journal refused or the chart can\'t take, without amounts', async () => {
      const more: NsInvoice[] = [
        // To an income account no longer used, and to one the chart doesn't have yet.
        { ref: '209', number: 'INV209', date: '2025-03-08', company: 'BMG', lines: [{ id: '1', kind: 'item', item: '14', number: 'OLD-PART', amount: '15.00', account: '410' }] },
        { ref: '210', number: 'INV210', date: '2025-03-09', company: 'BMG', lines: [{ id: '1', kind: 'item', item: '15', number: 'NEW-PART', amount: '16.00', account: '420' }] },
      ];
      for (const inv of more) {
        ns.invoices.set(inv.ref, inv);
        await copy(pg, inv);
      }
      const before = await journal();
      const r = await run();
      expect(r).toMatchObject({
        posted: 0,
        failedCount: 2,
        failed: [
          { number: 'INV210', reason: "It posts to NetSuite account 420, which the chart of accounts doesn't have" },
          { number: 'INV209', reason: 'Account 4100 (Old Sales) is inactive' },
        ],
      });
      expect(r.notes).toEqual([
        "NetSuite account 420 isn't in the chart of accounts yet, so invoices, credit memos, payments, deposits and bills posting there weren't posted. Sync now on the chart of accounts page copies them.",
      ]);
      expect(await journal()).toEqual(before);
      expect(JSON.stringify(record().last_result)).not.toMatch(/\d\.\d|\$/);
    });

    it('stops for time between months and carries on from there', async () => {
      await startOver();
      ns.takes = 20_000;
      const r = await run(50_000);
      expect(r).toMatchObject({ months: [JAN, FEB], posted: 2, partial: true });
      expect(record().last_result.resume).toEqual({ company: 'BMG', month: MAR });
      expect(record().synced).toBe(false);

      const next = await run();
      expect(next).toMatchObject({ months: [MAR, JAN, FEB], posted: 1, unchanged: 2, left: 3 });
      expect(next.partial).toBeUndefined();
      expect(record().last_result.resume).toBeNull();
      expect(record().synced).toBe(true);
      expect((await journal()).map((e) => e.key)).toEqual(['invoice:201:1', 'invoice:202:1', 'invoice:204:1']);
    });

    it('never starts a write with under five seconds left', async () => {
      await startOver();
      ns.takes = 36_000;
      const r = await run(40_000);
      expect(r).toMatchObject({ months: [], posted: 0, partial: true });
      expect(record().last_result.resume).toEqual({ company: 'BMG', month: JAN });
      expect(await journal()).toEqual([]);

      ns.takes = 0;
      expect(await run()).toMatchObject({ months: [JAN, FEB, MAR], posted: 3 });
    });
  });

  describe('credit memos', () => {
    // Made-up credit memos: CM401 gives back a part with its tax, CM402 some labor.
    const MEMOS = (): NsInvoice[] => [
      { kind: 'credit_memo', ref: '401', number: 'CM401', date: '2025-02-10', company: 'BMG', customerId: CUSTOMER, lines: [part('40.00'), tax('3.00', '2')] },
      { kind: 'credit_memo', ref: '402', number: 'CM402', date: '2025-03-10', company: 'BMG', lines: [labor('10.00')] },
    ];

    beforeAll(async () => {
      await startOver();
      for (const memo of MEMOS()) {
        ns.invoices.set(memo.ref, memo);
        await copy(pg, memo);
      }
    });

    it('posts each credit memo the other way round, under its own kind and rule, along with the invoices', async () => {
      const r = await run();
      expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 5, replaced: 0, reversed: 0, unchanged: 0, left: 3, failedCount: 0 });
      const memos = (await journal()).filter((e) => e.key?.startsWith('credit_memo:'));
      expect(memos).toEqual([
        { no: expect.any(Number), date: '2025-02-10', key: 'credit_memo:401:1', reverses: null, memo: 'CM401, A Customer' },
        { no: expect.any(Number), date: '2025-03-10', key: 'credit_memo:402:1', reverses: null, memo: 'CM402, A Customer' },
      ]);
      expect(await linesOf(memos[0].no)).toEqual([
        { account: '120', debit: '0.00', credit: '43.00', division: null, customer_id: CUSTOMER, item_number: null, source_line_ref: '0' },
        { account: '400', debit: '40.00', credit: '0.00', division: 'upfit', customer_id: null, item_number: 'PART-A', source_line_ref: '1' },
        { account: '220', debit: '3.00', credit: '0.00', division: null, customer_id: null, item_number: null, source_line_ref: '2' },
      ]);
      expect((await pg.query(`SELECT source_type, posting_rule, count(*)::int AS n FROM gl_entries GROUP BY 1, 2 ORDER BY 1`)).rows).toEqual([
        { source_type: 'credit_memo', posting_rule: 'credit_memo@1', n: 2 },
        { source_type: 'invoice', posting_rule: 'invoice@1', n: 3 },
      ]);
      // INV201, INV202 and INV204, less the two credit memos.
      expect(await balances()).toEqual({ 120: '229.00', 220: '-9.00', 400: '-220.00' });
      expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 5 });
    });

    it('replaces a credit memo\'s entry when NetSuite changes it, and reverses it when NetSuite deletes it', async () => {
      await edit('402', (m) => { m.lines = [labor('12.00')]; });
      expect(await run()).toMatchObject({ posted: 0, replaced: 1, reversed: 0, unchanged: 4 });
      expect((await journal()).slice(-2)).toEqual([
        { no: expect.any(Number), date: '2025-03-10', key: null, reverses: expect.any(Number), memo: 'CM402 changed in NetSuite' },
        { no: expect.any(Number), date: '2025-03-10', key: 'credit_memo:402:2', reverses: null, memo: 'CM402, A Customer' },
      ]);

      await edit('401', (m) => { m.deleted = true; });
      expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 1, unchanged: 4 });
      expect((await journal()).slice(-1)).toEqual([
        { no: expect.any(Number), date: '2025-02-10', key: null, reverses: expect.any(Number), memo: 'CM401 deleted in NetSuite' },
      ]);
      expect(await balances()).toEqual({ 120: '270.00', 220: '-12.00', 400: '-258.00' });
    });

    it('names invoices and credit memos that don\'t come to their totals in one note', async () => {
      const memo: NsInvoice = { kind: 'credit_memo', ref: '403', number: 'CM403', date: '2025-03-12', company: 'BMG', lines: [labor('5.00'), part('6.00', '2')] };
      ns.invoices.set(memo.ref, memo);
      await copy(pg, memo, [labor('5.00')]);
      const r = await run();
      expect(r).toMatchObject({ posted: 0, replaced: 0, reversed: 0, left: 4 });
      expect(r.notes).toEqual([
        "FleetSuite's entries for 1 invoice and 1 credit memo don't come to their totals, so whatever FleetSuite holds for them stayed as it is: "
        + 'INV208, CM403. Either the copies were caught mid-refresh, and the next run looks again, or the rule leaves out a line NetSuite posts, '
        + 'which Invoices vs NetSuite shows.',
      ]);
    });
  });

  describe('documents NetSuite booked into another month', () => {
    // Made-up: INV501 dated before the books start and carried into January 2025, INV502 dated in January and booked into
    // March, CM503 dated in March and booked into February.
    const MOVED = (): NsInvoice[] => [
      { ref: '501', number: 'INV501', date: '2024-11-20', booked: JAN, company: 'BMG', lines: [labor('30.00')] },
      { ref: '502', number: 'INV502', date: '2025-01-28', booked: MAR, company: 'BMG', lines: [labor('40.00')] },
      { kind: 'credit_memo', ref: '503', number: 'CM503', date: '2025-03-03', booked: FEB, company: 'BMG', lines: [labor('5.00')] },
    ];

    beforeAll(async () => {
      await startOver();
      for (const inv of MOVED()) {
        ns.invoices.set(inv.ref, inv);
        await copy(pg, inv);
      }
    });

    it('posts each in the month NetSuite booked it to, on its first day, or its last when NetSuite booked it earlier', async () => {
      expect(await run()).toMatchObject({ months: [JAN, FEB, MAR], posted: 6, replaced: 0, reversed: 0, failedCount: 0 });
      const moved = (await journal()).filter((e) => /:50\d:/.test(e.key ?? ''));
      expect(moved.map((e) => [e.key, e.date])).toEqual([
        ['invoice:501:1', '2025-01-01'],
        ['credit_memo:503:1', '2025-02-28'],
        ['invoice:502:1', '2025-03-01'],
      ]);
      expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 6 });
    });

    it('moves an entry to the month NetSuite now books its invoice into, the reversal staying in the old one', async () => {
      const was = (await journal()).find((e) => e.key === 'invoice:202:1')!;
      expect(was.date).toBe('2025-02-05');
      await edit('202', (inv) => { inv.booked = MAR; });
      expect(await run()).toMatchObject({ posted: 0, replaced: 1, reversed: 0, unchanged: 5, failedCount: 0 });
      expect((await journal()).slice(-2)).toEqual([
        { no: expect.any(Number), date: '2025-02-05', key: null, reverses: was.no, memo: 'INV202 changed in NetSuite' },
        { no: expect.any(Number), date: '2025-03-01', key: 'invoice:202:2', reverses: null, memo: 'INV202, A Customer' },
      ]);
      expect(await run()).toMatchObject({ posted: 0, replaced: 0, unchanged: 6 });
    });
  });
});
