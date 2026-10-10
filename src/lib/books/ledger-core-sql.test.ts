// FleetSuite's own journal (migration 359) protects itself in the database:
// entries balance, posted rows never change, closed months refuse postings,
// and the journal can only be emptied before the books go live. This runs
// the migration in an in-memory Postgres (PGlite) and holds each rule.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { postEntry, resetJournal, reverseEntry, setPeriodStatus } from './journal';

let db: PGlite;
let bmgId: string;
let coolSpringsId: string;
const acct: Record<'bank' | 'ar' | 'sales' | 'supplies' | 'rent' | 'mortgage' | 'cash1084' | 'rentIncome', string> = {} as any;

type Posted = { id: string; entry_no: number; already_posted: boolean };

const post = async (p: Record<string, unknown>): Promise<Posted> => {
  const r = await db.query<{ r: Posted }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
  return r.rows[0].r;
};

let keySeq = 0;
const sale = (over: Record<string, unknown> = {}) => ({
  company: 'BMG',
  entry_date: '2026-11-03',
  source_type: 'invoice',
  source_id: 'INV-100',
  posting_rule: 'invoice@1',
  idempotency_key: `test:${++keySeq}`,
  lines: [
    { account_id: acct.ar, debit: '1250.00', customer_id: '6f1c2c1e-6a0b-4d55-9a57-2f9a1b0c0d11', job_ref: 'so:1060' },
    { account_id: acct.sales, credit: '1250.00', division: 'upfit', location: 'ofallon', item_number: 'LBR-UPFIT' },
  ],
  ...over,
});

const typed = (lines: unknown[], over: Record<string, unknown> = {}) => ({
  company: 'BMG',
  entry_date: '2026-11-04',
  source_type: 'manual',
  posting_rule: 'manual',
  idempotency_key: `test:${++keySeq}`,
  lines,
  ...over,
});

const count = async (table: string): Promise<number> =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

// Calls the functions the way supabase-js does: by name, with named
// arguments, so a renamed parameter on either side fails here.
const rpcClient = {
  rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    const names = Object.keys(args);
    const call = `SELECT ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`;
    const params = names.map((n) => {
      const v = args[n];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    try {
      const r = await db.query<{ r: any }>(call, params);
      return { data: r.rows[0]?.r ?? null, error: null };
    } catch (e: any) {
      return { data: null, error: { message: e.message } };
    }
  },
} as unknown as Pick<SupabaseClient, 'rpc'>;

const setStatus = (company: string, month: string, status: 'open' | 'closed', reason: string | null) =>
  db.query<{ r: { status: string } }>(
    'SELECT gl_set_period_status($1, $2::date, $3, $4::uuid, $5, $6) AS r',
    [company, month, status, '0b5e1d4a-2f43-4f0f-9d5e-6c1f7a9b3e21', 'Craig', reason],
  );

beforeAll(async () => {
  db = new PGlite();
  // Supabase's API roles with its default grants (everything to all three),
  // so the migration's revokes are what keeps anon and authenticated out.
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  `);
  // The migration runs as the owner, like the deploy does...
  const sql = readFileSync(path.resolve(__dirname, '../../../migrations/359-books-ledger-core.sql'), 'utf8');
  await db.exec(sql);
  await db.exec(sql); // must be safe to re-run
  // ...and everything after runs as the app's server login.
  await db.exec('SET ROLE service_role');

  const companies = await db.query<{ id: string; code: string }>('SELECT id, code FROM gl_companies');
  bmgId = companies.rows.find((c) => c.code === 'BMG')!.id;
  coolSpringsId = companies.rows.find((c) => c.code === '1084')!.id;

  const accounts = await db.query<{ id: string; number: string }>(
    `INSERT INTO gl_accounts (number, name, account_type, is_control, company_id) VALUES
       ('10100', 'First Bank Operating', 'bank', false, NULL),
       ('11000', 'Accounts Receivable', 'accounts_receivable', true, NULL),
       ('40000', 'Upfit Sales', 'income', false, NULL),
       ('60100', 'Shop Supplies', 'expense', false, NULL),
       ('64000', 'Rent', 'expense', false, NULL),
       ('25000', 'Building Mortgage', 'long_term_liability', false, $1),
       ('10900', '1084 Operating', 'bank', false, $1),
       ('41000', 'Rent Income', 'income', false, $1)
     RETURNING id, number`,
    [coolSpringsId],
  );
  const byNumber = Object.fromEntries(accounts.rows.map((a) => [a.number, a.id]));
  acct.bank = byNumber['10100'];
  acct.ar = byNumber['11000'];
  acct.sales = byNumber['40000'];
  acct.supplies = byNumber['60100'];
  acct.rent = byNumber['64000'];
  acct.mortgage = byNumber['25000'];
  acct.cash1084 = byNumber['10900'];
  acct.rentIncome = byNumber['41000'];
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('companies, accounts and months', () => {
  it('seeds BMG (NetSuite subsidiary 2) and 1084 Cool Springs, once', async () => {
    const r = await db.query<{ code: string; legal_name: string; netsuite_subsidiary_id: string | null; books_live_from: string | null }>(
      'SELECT code, legal_name, netsuite_subsidiary_id, books_live_from FROM gl_companies ORDER BY code',
    );
    expect(r.rows).toEqual([
      { code: '1084', legal_name: '1084 Cool Springs LLC', netsuite_subsidiary_id: null, books_live_from: null },
      { code: 'BMG', legal_name: 'BMG Fleet Installations LLC', netsuite_subsidiary_id: '2', books_live_from: null },
    ]);
  });

  it('derives each account\'s normal balance and statement from its type', async () => {
    const r = await db.query<{ number: string; normal_balance: string; statement: string }>(
      `SELECT number, normal_balance, statement FROM gl_accounts WHERE number IN ('10100', '11000', '40000', '60100', '25000') ORDER BY number`,
    );
    expect(r.rows).toEqual([
      { number: '10100', normal_balance: 'debit', statement: 'balance_sheet' },
      { number: '11000', normal_balance: 'debit', statement: 'balance_sheet' },
      { number: '25000', normal_balance: 'credit', statement: 'balance_sheet' },
      { number: '40000', normal_balance: 'credit', statement: 'income_statement' },
      { number: '60100', normal_balance: 'debit', statement: 'income_statement' },
    ]);
  });

  it('keeps months on the first of the month and ends them on the last day', async () => {
    const r = await db.query<{ a: string; b: string; c: string }>(
      `SELECT gl_month_start('2026-11-30')::text AS a, gl_month_start('2028-02-29')::text AS b, gl_month_start('2027-01-01')::text AS c`,
    );
    expect(r.rows[0]).toEqual({ a: '2026-11-01', b: '2028-02-01', c: '2027-01-01' });
    await db.query(`INSERT INTO gl_periods (company_id, period_start) VALUES ($1, '2028-02-01')`, [bmgId]);
    const end = await db.query<{ e: string }>(`SELECT period_end::text AS e FROM gl_periods WHERE period_start = '2028-02-01'`);
    expect(end.rows[0].e).toBe('2028-02-29');
    await expect(db.query(`INSERT INTO gl_periods (company_id, period_start) VALUES ($1, '2028-03-15')`, [bmgId])).rejects.toThrow();
    await expect(db.query(`UPDATE gl_periods SET period_start = '2028-03-01' WHERE period_start = '2028-02-01'`)).rejects.toThrow(/can't change/);
  });
});

describe('posting', () => {
  it('posts a balanced entry, copies company and date onto its lines, and opens the month', async () => {
    const r = await post(sale({ idempotency_key: 'invoice:INV-100:1' }));
    expect(r.already_posted).toBe(false);
    expect(r.entry_no).toBeGreaterThan(0);
    const lines = await db.query<{ line_no: number; company_id: string; entry_date: string; debit: string; credit: string; division: string | null; location: string | null; job_ref: string | null }>(
      'SELECT line_no, company_id, entry_date::text AS entry_date, debit::text AS debit, credit::text AS credit, division, location, job_ref FROM gl_lines WHERE entry_id = $1 ORDER BY line_no',
      [r.id],
    );
    expect(lines.rows).toEqual([
      { line_no: 1, company_id: bmgId, entry_date: '2026-11-03', debit: '1250.00', credit: '0.00', division: null, location: null, job_ref: 'so:1060' },
      { line_no: 2, company_id: bmgId, entry_date: '2026-11-03', debit: '0.00', credit: '1250.00', division: 'upfit', location: 'ofallon', job_ref: null },
    ]);
    const month = await db.query<{ status: string }>(`SELECT status FROM gl_periods WHERE company_id = $1 AND period_start = '2026-11-01'`, [bmgId]);
    expect(month.rows[0].status).toBe('open');
  });

  it('posts the same idempotency key only once', async () => {
    const before = await count('gl_lines');
    const again = await post(sale({ idempotency_key: 'invoice:INV-100:1' }));
    expect(again.already_posted).toBe(true);
    expect(await count('gl_lines')).toBe(before);
  });

  it('refuses an entry whose debits and credits differ, and writes nothing', async () => {
    const before = await count('gl_entries');
    await expect(post(typed([
      { account_id: acct.supplies, debit: '40.00' },
      { account_id: acct.bank, credit: '39.99' },
    ]))).rejects.toThrow(/does not balance/);
    expect(await count('gl_entries')).toBe(before);
  });

  it('refuses an entry with fewer than two lines', async () => {
    await expect(post(typed([{ account_id: acct.supplies, debit: '40.00' }]))).rejects.toThrow(/at least two lines/);
    await expect(post(typed([]))).rejects.toThrow(/at least two lines/);
  });

  it('refuses a line with both sides, neither side, a negative amount, or fractions of a cent', async () => {
    await expect(post(typed([
      { account_id: acct.supplies, debit: '40.00', credit: '40.00' },
      { account_id: acct.bank, credit: '0.01' },
      { account_id: acct.supplies, debit: '0.01' },
    ]))).rejects.toThrow(/gl_lines_one_side/);
    await expect(post(typed([
      { account_id: acct.supplies },
      { account_id: acct.bank, credit: '1.00' },
      { account_id: acct.supplies, debit: '1.00' },
    ]))).rejects.toThrow(/gl_lines_one_side/);
    await expect(post(typed([
      { account_id: acct.supplies, debit: '-5.00' },
      { account_id: acct.bank, debit: '5.00' },
    ]))).rejects.toThrow(/check constraint/);
    await expect(post(typed([
      { account_id: acct.supplies, debit: '10.005' },
      { account_id: acct.bank, credit: '10.005' },
    ]))).rejects.toThrow(/more than two decimal places/);
  });

  it('refuses a bad company, date, key or account', async () => {
    await expect(post(sale({ company: 'ACME' }))).rejects.toThrow(/unknown company/);
    await expect(post(sale({ entry_date: '11/03/2026' }))).rejects.toThrow(/YYYY-MM-DD/);
    await expect(post(sale({ idempotency_key: '  ' }))).rejects.toThrow(/idempotency_key is required/);
    await expect(post(typed([
      { account_id: '00000000-0000-0000-0000-000000000000', debit: '1.00' },
      { account_id: acct.bank, credit: '1.00' },
    ]))).rejects.toThrow(/unknown account/);
  });

  it('never lets a posted entry or line change or disappear', async () => {
    const { id } = await post(sale());
    await expect(db.query('UPDATE gl_entries SET memo = $2 WHERE id = $1', [id, 'edited'])).rejects.toThrow(/can't be changed or deleted/);
    await expect(db.query('DELETE FROM gl_entries WHERE id = $1', [id])).rejects.toThrow(/can't be changed or deleted/);
    await expect(db.query(`UPDATE gl_lines SET debit = 1 WHERE entry_id = $1 AND line_no = 1`, [id])).rejects.toThrow(/can't be changed or deleted/);
    await expect(db.query('DELETE FROM gl_lines WHERE entry_id = $1', [id])).rejects.toThrow(/can't be changed or deleted/);
  });

  it('only accepts lines in the transaction that posts the entry', async () => {
    const { id } = await post(sale());
    await expect(db.query(
      'INSERT INTO gl_lines (entry_id, line_no, account_id, debit) VALUES ($1, 3, $2, 5)',
      [id, acct.supplies],
    )).rejects.toThrow(/already posted/);
  });

  it('checks the balance at commit even when rows are inserted directly', async () => {
    const insertEntry = `INSERT INTO gl_entries (company_id, entry_date, source_type, posting_rule, idempotency_key)
                         VALUES ($1, '2026-11-05', 'manual', 'manual', $2) RETURNING id`;
    await expect(db.transaction(async (tx) => {
      await tx.query(insertEntry, [bmgId, 'direct:no-lines']);
    })).rejects.toThrow(/needs at least two/);
    await expect(db.transaction(async (tx) => {
      const e = await tx.query<{ id: string }>(insertEntry, [bmgId, 'direct:unbalanced']);
      await tx.query('INSERT INTO gl_lines (entry_id, line_no, account_id, debit) VALUES ($1, 1, $2, 10)', [e.rows[0].id, acct.supplies]);
      await tx.query('INSERT INTO gl_lines (entry_id, line_no, account_id, credit) VALUES ($1, 2, $2, 9)', [e.rows[0].id, acct.bank]);
    })).rejects.toThrow(/does not balance/);
    const left = await db.query(`SELECT 1 FROM gl_entries WHERE idempotency_key LIKE 'direct:%'`);
    expect(left.rows).toHaveLength(0);
  });

  it('keeps a typed entry off control accounts, but lets documents post there', async () => {
    await expect(post(typed([
      { account_id: acct.ar, debit: '10.00' },
      { account_id: acct.sales, credit: '10.00' },
    ]))).rejects.toThrow(/posted only by its own documents/);
    await expect(post(typed([
      { account_id: acct.supplies, debit: '10.00' },
      { account_id: acct.bank, credit: '10.00' },
    ]))).resolves.toMatchObject({ already_posted: false });
  });

  it('keeps an account restricted to 1084 out of BMG\'s entries', async () => {
    await expect(post(typed([
      { account_id: acct.rent, debit: '1000.00' },
      { account_id: acct.bank, credit: '1000.00' },
    ]))).resolves.toMatchObject({ already_posted: false });
    await expect(post(typed([
      { account_id: acct.mortgage, debit: '500.00' },
      { account_id: acct.bank, credit: '500.00' },
    ]))).rejects.toThrow(/belongs to another company/);
    const r = await post(typed([
      { account_id: acct.mortgage, debit: '500.00' },
      { account_id: acct.cash1084, credit: '500.00' },
    ], { company: '1084' }));
    const lines = await db.query<{ company_id: string }>('SELECT DISTINCT company_id FROM gl_lines WHERE entry_id = $1', [r.id]);
    expect(lines.rows).toEqual([{ company_id: coolSpringsId }]);
  });

  it('refuses an inactive account, and an account\'s type change once it has postings', async () => {
    const r = await db.query<{ id: string }>(`INSERT INTO gl_accounts (number, name, account_type, active) VALUES ('69999', 'Old Expense', 'expense', false) RETURNING id`);
    await expect(post(typed([
      { account_id: r.rows[0].id, debit: '1.00' },
      { account_id: acct.bank, credit: '1.00' },
    ]))).rejects.toThrow(/is inactive/);
    await expect(db.query(`UPDATE gl_accounts SET account_type = 'other_expense' WHERE id = $1`, [acct.supplies])).rejects.toThrow(/has postings/);
    await expect(db.query(`UPDATE gl_accounts SET company_id = $2 WHERE id = $1`, [acct.supplies, coolSpringsId])).rejects.toThrow(/has postings/);
    await db.query(`UPDATE gl_accounts SET name = 'Shop Supplies & Consumables' WHERE id = $1`, [acct.supplies]);
    // An unused account can still be fixed.
    await db.query(`UPDATE gl_accounts SET account_type = 'other_expense' WHERE id = $1`, [r.rows[0].id]);
  });

  it('refuses an inactive company', async () => {
    await db.query(`INSERT INTO gl_companies (code, name) VALUES ('TEST', 'Test Co')`);
    await db.query(`UPDATE gl_companies SET active = false WHERE code = 'TEST'`);
    await expect(post(sale({ company: 'TEST' }))).rejects.toThrow(/is inactive/);
  });
});

describe('closing months', () => {
  it('refuses postings to a closed month and records who closed it', async () => {
    await post(sale({ entry_date: '2026-10-15' }));
    const r = await setStatus('BMG', '2026-10-01', 'closed', null);
    expect(r.rows[0].r.status).toBe('closed');
    await expect(post(sale({ entry_date: '2026-10-31' }))).rejects.toThrow(/closed/);
    const month = await db.query<{ closed_by_name: string; closed_at: string | null }>(
      `SELECT closed_by_name, closed_at FROM gl_periods WHERE company_id = $1 AND period_start = '2026-10-01'`, [bmgId],
    );
    expect(month.rows[0].closed_by_name).toBe('Craig');
    expect(month.rows[0].closed_at).not.toBeNull();
  });

  it('closes one company\'s month without closing the other\'s', async () => {
    await expect(post(typed([
      { account_id: acct.mortgage, debit: '400.00' },
      { account_id: acct.cash1084, credit: '400.00' },
    ], { company: '1084', entry_date: '2026-10-01' }))).resolves.toMatchObject({ already_posted: false });
  });

  it('won\'t let the close stamp be edited by hand', async () => {
    await db.query(`UPDATE gl_periods SET closed_by_name = 'Someone else' WHERE company_id = $1 AND period_start = '2026-10-01'`, [bmgId]);
    const month = await db.query<{ closed_by_name: string }>(
      `SELECT closed_by_name FROM gl_periods WHERE company_id = $1 AND period_start = '2026-10-01'`, [bmgId],
    );
    expect(month.rows[0].closed_by_name).toBe('Craig');
  });

  it('needs a reason to reopen, and logs the close and the reopen', async () => {
    await expect(setStatus('BMG', '2026-10-01', 'open', null)).rejects.toThrow(/needs a reason/);
    await expect(setStatus('BMG', '2026-10-01', 'open', '   ')).rejects.toThrow(/needs a reason/);
    await setStatus('BMG', '2026-10-01', 'open', 'Missed a vendor bill');
    await expect(post(sale({ entry_date: '2026-10-31' }))).resolves.toMatchObject({ already_posted: false });
    const events = await db.query<{ action: string; actor_name: string; reason: string | null }>(
      `SELECT e.action, e.actor_name, e.reason FROM gl_period_events e JOIN gl_periods p ON p.id = e.period_id
       WHERE p.company_id = $1 AND p.period_start = '2026-10-01' ORDER BY e.created_at, e.action`, [bmgId],
    );
    expect(events.rows).toEqual([
      { action: 'closed', actor_name: 'Craig', reason: null },
      { action: 'reopened', actor_name: 'Craig', reason: 'Missed a vendor bill' },
    ]);
    await expect(db.query(`UPDATE gl_period_events SET reason = 'x'`)).rejects.toThrow(/can't be changed or deleted/);
    await expect(db.query(`DELETE FROM gl_period_events`)).rejects.toThrow(/can't be changed or deleted/);
  });
});

describe('reversals', () => {
  it('posts the mirror image, linked to the original, so each account nets to zero', async () => {
    const orig = await post(sale({ entry_date: '2026-11-10', idempotency_key: 'invoice:INV-200:1' }));
    const rev = await db.query<{ r: { id: string; entry_no: number } }>(
      'SELECT gl_reverse_entry($1, NULL, $2, NULL, $3) AS r', [orig.id, 'Invoice voided', 'Craig'],
    );
    const revId = rev.rows[0].r.id;
    const head = await db.query<{ source_type: string; reverses_entry_id: string; memo: string; entry_date: string }>(
      'SELECT source_type, reverses_entry_id, memo, entry_date::text AS entry_date FROM gl_entries WHERE id = $1', [revId],
    );
    expect(head.rows[0]).toEqual({ source_type: 'reversal', reverses_entry_id: orig.id, memo: 'Invoice voided', entry_date: '2026-11-10' });
    const net = await db.query<{ account_id: string; net: string }>(
      `SELECT account_id, sum(debit - credit)::text AS net FROM gl_lines WHERE entry_id IN ($1, $2) GROUP BY account_id`, [orig.id, revId],
    );
    expect(net.rows.map((r) => r.net)).toEqual(['0.00', '0.00']);
    const revLines = await db.query<{ debit: string; credit: string; job_ref: string | null }>(
      'SELECT debit::text AS debit, credit::text AS credit, job_ref FROM gl_lines WHERE entry_id = $1 ORDER BY line_no', [revId],
    );
    expect(revLines.rows).toEqual([
      { debit: '0.00', credit: '1250.00', job_ref: 'so:1060' },
      { debit: '1250.00', credit: '0.00', job_ref: null },
    ]);
  });

  it('posts a reversal only through gl_reverse_entry', async () => {
    await expect(post(sale({ source_type: 'reversal' }))).rejects.toThrow(/posted by gl_reverse_entry/);
  });

  it('reverses an entry once, and never reverses a reversal', async () => {
    const orig = await post(sale({ entry_date: '2026-11-11' }));
    const rev = await db.query<{ r: { id: string } }>('SELECT gl_reverse_entry($1, NULL, NULL, NULL, NULL) AS r', [orig.id]);
    await expect(db.query('SELECT gl_reverse_entry($1, NULL, NULL, NULL, NULL)', [orig.id])).rejects.toThrow(/already reversed/);
    await expect(db.query('SELECT gl_reverse_entry($1, NULL, NULL, NULL, NULL)', [rev.rows[0].r.id])).rejects.toThrow(/itself a reversal/);
  });

  it('holds the reversal links for direct inserts too', async () => {
    const orig = await post(sale({ entry_date: '2026-11-12' }));
    const rev = await db.query<{ r: { id: string } }>('SELECT gl_reverse_entry($1, NULL, NULL, NULL, NULL) AS r', [orig.id]);
    const insert = (company: string, key: string, reverses: string) => db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO gl_entries (company_id, entry_date, source_type, posting_rule, idempotency_key, reverses_entry_id)
         VALUES ($1, '2026-11-12', 'reversal', 'reversal', $2, $3)`,
        [company, key, reverses],
      );
    });
    await expect(insert(bmgId, 'direct:rev-of-rev', rev.rows[0].r.id)).rejects.toThrow(/itself a reversal/);
    const other = await post(sale({ entry_date: '2026-11-12' }));
    await expect(insert(coolSpringsId, 'direct:cross-company', other.id)).rejects.toThrow(/same company/);
  });

  it('dates a reversal into an open month when the original\'s month is closed', async () => {
    const orig = await post(sale({ entry_date: '2026-09-20' }));
    await setStatus('BMG', '2026-09-01', 'closed', null);
    await expect(db.query('SELECT gl_reverse_entry($1, NULL, NULL, NULL, NULL)', [orig.id])).rejects.toThrow(/closed/);
    const rev = await db.query<{ r: { id: string } }>(`SELECT gl_reverse_entry($1, '2026-11-01', NULL, NULL, NULL) AS r`, [orig.id]);
    const head = await db.query<{ entry_date: string }>('SELECT entry_date::text AS entry_date FROM gl_entries WHERE id = $1', [rev.rows[0].r.id]);
    expect(head.rows[0].entry_date).toBe('2026-11-01');
  });

  it('reverses onto an account that was deactivated after the original posted', async () => {
    const r = await db.query<{ id: string }>(`INSERT INTO gl_accounts (number, name, account_type) VALUES ('60200', 'Small Tools', 'expense') RETURNING id`);
    const orig = await post(typed([
      { account_id: r.rows[0].id, debit: '75.00' },
      { account_id: acct.bank, credit: '75.00' },
    ]));
    await db.query('UPDATE gl_accounts SET active = false WHERE id = $1', [r.rows[0].id]);
    await expect(db.query('SELECT gl_reverse_entry($1, NULL, NULL, NULL, NULL)', [orig.id])).resolves.toBeDefined();
  });
});

describe('access', () => {
  it('gives the API roles nothing; only the service role may call the functions', async () => {
    const fns = ['gl_post_entry(jsonb)', 'gl_reverse_entry(uuid, date, text, uuid, text)', 'gl_set_period_status(text, date, text, uuid, text, text)', 'gl_reset_journal()'];
    for (const fn of fns) {
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>('SELECT has_function_privilege($1, $2, \'EXECUTE\') AS ok', [role, fn]);
        expect(r.rows[0].ok, `${role} on ${fn}`).toBe(false);
      }
      const s = await db.query<{ ok: boolean }>('SELECT has_function_privilege(\'service_role\', $1, \'EXECUTE\') AS ok', [fn]);
      expect(s.rows[0].ok, `service_role on ${fn}`).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      await expect(db.transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE ${role}`);
        await tx.query('SELECT count(*) FROM gl_entries');
      })).rejects.toThrow(/permission denied/);
      await expect(db.transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE ${role}`);
        await tx.query(`SELECT gl_post_entry('{}'::jsonb)`);
      })).rejects.toThrow(/permission denied/);
    }
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('gl_companies', 'gl_accounts', 'gl_periods', 'gl_period_events', 'gl_entries', 'gl_lines') ORDER BY relname`,
    );
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
    expect(rls.rows).toHaveLength(6);
  });
});

describe('the server helper against the real functions', () => {
  const craig = { id: '0b5e1d4a-2f43-4f0f-9d5e-6c1f7a9b3e21', name: 'Craig' };

  it('posts, repeats safely, reverses, and closes and reopens a month', async () => {
    const entry = {
      company: '1084' as const,
      entryDate: '2026-12-01',
      sourceType: 'rent_invoice',
      sourceId: 'rent:2026-12',
      postingRule: 'rent@1',
      idempotencyKey: 'rent:1084:2026-12',
      memo: 'Test rent',
      postedBy: craig,
      lines: [
        { accountId: acct.cash1084, debit: 1000 },
        { accountId: acct.rentIncome, credit: '1000.00' },
      ],
    };
    const first = await postEntry(rpcClient, entry);
    expect(first.alreadyPosted).toBe(false);
    await expect(postEntry(rpcClient, entry)).resolves.toEqual({ ...first, alreadyPosted: true });
    const head = await db.query<{ posted_by_name: string; memo: string }>('SELECT posted_by_name, memo FROM gl_entries WHERE id = $1', [first.id]);
    expect(head.rows[0]).toEqual({ posted_by_name: 'Craig', memo: 'Test rent' });

    const rev = await reverseEntry(rpcClient, { entryId: first.id, memo: 'Rent re-billed', actor: craig });
    expect(rev.entryNo).toBeGreaterThan(first.entryNo);

    await expect(setPeriodStatus(rpcClient, { company: '1084', month: '2026-12', status: 'closed', actor: craig }))
      .resolves.toMatchObject({ periodStart: '2026-12-01', status: 'closed' });
    await expect(postEntry(rpcClient, { ...entry, idempotencyKey: 'rent:1084:2026-12:2' })).rejects.toMatchObject({
      kind: 'refused',
      message: expect.stringMatching(/^2026-12 is closed for 1084 Cool Springs/),
    });
    await expect(setPeriodStatus(rpcClient, { company: '1084', month: '2026-12', status: 'open', actor: craig, reason: 'Rent re-billed' }))
      .resolves.toMatchObject({ status: 'open' });
  });
});

// Last: going live is one-way, so these run after everything else.
describe('rehearsals and going live', () => {
  it('empties the journal and its months for a rehearsal while no company is live', async () => {
    expect(await count('gl_entries')).toBeGreaterThan(0);
    await resetJournal(rpcClient);
    expect(await count('gl_entries')).toBe(0);
    expect(await count('gl_lines')).toBe(0);
    expect(await count('gl_periods')).toBe(0);
    expect(await count('gl_period_events')).toBe(0);
    const r = await post(sale({ entry_date: '2026-12-01' }));
    expect(r.entry_no).toBe(1);
  });

  it('once live: no reset, no moving the date, nothing dated earlier except opening balances', async () => {
    await db.query(`UPDATE gl_companies SET books_live_from = '2027-01-01' WHERE code = 'BMG'`);
    await expect(resetJournal(rpcClient)).rejects.toMatchObject({ kind: 'refused' });
    await expect(db.query('SELECT gl_reset_journal()')).rejects.toThrow(/can't be emptied/);
    await expect(db.query('TRUNCATE gl_lines, gl_entries')).rejects.toThrow(/can't be emptied/);
    await expect(db.query('TRUNCATE gl_periods CASCADE')).rejects.toThrow(/can't be emptied/);
    await expect(db.query(`UPDATE gl_companies SET books_live_from = '2027-02-01' WHERE code = 'BMG'`)).rejects.toThrow(/can't change/);
    await expect(db.query(`UPDATE gl_companies SET books_live_from = NULL WHERE code = 'BMG'`)).rejects.toThrow(/can't change/);
    await expect(post(sale({ entry_date: '2026-12-31' }))).rejects.toThrow(/before .* went live/);
    await expect(post({
      company: 'BMG',
      entry_date: '2026-12-31',
      source_type: 'opening_balance',
      posting_rule: 'opening_balance@1',
      idempotency_key: 'opening:BMG:2027',
      lines: [
        { account_id: acct.bank, debit: '5000.00' },
        { account_id: acct.ar, debit: '2500.00' },
        { account_id: acct.mortgage, credit: '0.01' },
        { account_id: acct.sales, credit: '7499.99' },
      ],
    })).rejects.toThrow(/belongs to another company/);
    await expect(post({
      company: 'BMG',
      entry_date: '2026-12-31',
      source_type: 'opening_balance',
      posting_rule: 'opening_balance@1',
      idempotency_key: 'opening:BMG:2027',
      lines: [
        { account_id: acct.bank, debit: '5000.00' },
        { account_id: acct.ar, debit: '2500.00' },
        { account_id: acct.sales, credit: '7500.00' },
      ],
    })).resolves.toMatchObject({ already_posted: false });
    await expect(post(sale({ entry_date: '2027-01-04' }))).resolves.toMatchObject({ already_posted: false });
  });
});
