// Migration 510 counts what each posting rule has posted and keeps the CPA's
// reviews of how the books work. This builds the books from their
// migrations in an in-memory Postgres (PGlite), as the restore drill does,
// and holds that gl_posting_rule_use counts each company's entries by rule
// with a reversal counted against what it reverses, that a review is kept
// as it was made and takes only what the app writes, that one added outside
// FleetSuite lands in the change history, and that only the service role
// reaches either.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { BACKUP_TABLES } from './backups';
import { DRILL_STAND_INS, readDrillMigrations } from './restore-drill';

let db: PGlite;
const MIGRATIONS = path.resolve(__dirname, '../../../migrations');
const CRAIG = '0b5e1d4a-2f43-4f0f-9d5e-6c1f7a9b3e21';
const FINGERPRINT = 'a'.repeat(64);
const acct: Record<'bank' | 'ar' | 'sales' | 'cash1084' | 'rentIncome', string> = {} as any;

type Posted = { id: string; entry_no: number };

let keySeq = 0;
const post = async (company: string, rule: string, date: string, debit: string, credit: string, cents = '100.00'): Promise<Posted> => {
  const r = await db.query<{ r: Posted }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
    company,
    entry_date: date,
    source_type: rule.split('@')[0],
    source_id: `doc-${++keySeq}`,
    posting_rule: rule,
    idempotency_key: `test:${keySeq}`,
    lines: [{ account_id: debit, debit: cents }, { account_id: credit, credit: cents }],
  })]);
  return r.rows[0].r;
};

const use = async () => (await db.query<{
  company: string; posting_rule: string; entries: string; reversed: string; first_date: string; last_date: string;
}>(
  `SELECT company, posting_rule, entries::text, reversed::text, first_date::text, last_date::text FROM gl_posting_rule_use()`,
)).rows;

const review = (over: Record<string, unknown> = {}) => {
  const row = {
    reviewed_by: CRAIG, reviewed_by_name: 'Pat CPA', reviewed_as: 'cpa', rules: ['invoice@1', 'payment@1'], fingerprint: FINGERPRINT, note: null,
    ...over,
  };
  return db.query(
    `INSERT INTO books_rules_reviews (reviewed_by, reviewed_by_name, reviewed_as, rules, fingerprint, note)
     VALUES ($1, $2, $3, $4::text[], $5, $6) RETURNING id`,
    [row.reviewed_by, row.reviewed_by_name, row.reviewed_as, row.rules, row.fingerprint, row.note],
  );
};

/** Makes the next statements come from FleetSuite's server, or straight in the database. */
async function as(how: 'server' | 'database'): Promise<void> {
  await db.exec('RESET ROLE');
  await db.query(
    `SELECT set_config('request.jwt.claims', $1, false), set_config('fleetsuite.via', '', false), set_config('application_name', $2, false)`,
    [how === 'server' ? JSON.stringify({ role: 'service_role' }) : '', how === 'database' ? 'Supabase Studio' : 'postgrest'],
  );
  if (how === 'server') await db.exec('SET ROLE service_role');
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(DRILL_STAND_INS);
  const migrations = readDrillMigrations(MIGRATIONS, BACKUP_TABLES, null);
  expect(migrations.map((m) => m.name)).toContain('510-books-how-it-works.sql');
  for (const m of migrations) await db.exec(m.sql);
  await db.exec(readFileSync(path.join(MIGRATIONS, '510-books-how-it-works.sql'), 'utf8')); // must be safe to re-run
  await db.exec(`INSERT INTO profiles (id, full_name) VALUES ('${CRAIG}', 'Craig George')`);

  const companies = await db.query<{ id: string; code: string }>('SELECT id, code FROM gl_companies');
  const coolSprings = companies.rows.find((c) => c.code === '1084')!.id;
  const accounts = await db.query<{ id: string; number: string }>(
    `INSERT INTO gl_accounts (number, name, account_type, is_control, company_id) VALUES
       ('10100', 'First Bank Operating', 'bank', false, NULL),
       ('11000', 'Accounts Receivable', 'accounts_receivable', true, NULL),
       ('40000', 'Upfit Sales', 'income', false, NULL),
       ('10900', '1084 Operating', 'bank', false, $1),
       ('41000', 'Rent Income', 'income', false, $1)
     RETURNING id, number`,
    [coolSprings],
  );
  const byNumber = Object.fromEntries(accounts.rows.map((a) => [a.number, a.id]));
  acct.bank = byNumber['10100'];
  acct.ar = byNumber['11000'];
  acct.sales = byNumber['40000'];
  acct.cash1084 = byNumber['10900'];
  acct.rentIncome = byNumber['41000'];
  await as('server');
}, 120_000);

afterAll(async () => { await db?.close(); });

describe('migration 510: what each posting rule has posted', () => {
  it('counts nothing in an empty journal', async () => {
    expect(await use()).toEqual([]);
  });

  it("counts each company's entries by rule, a reversal against the entry it reverses, with the first and last date", async () => {
    const first = await post('BMG', 'invoice@1', '2025-01-02', acct.ar, acct.sales);
    await post('BMG', 'invoice@1', '2025-03-31', acct.ar, acct.sales);
    await post('BMG', 'invoice@1', '2025-02-14', acct.ar, acct.sales);
    await post('BMG', 'payment@1', '2025-02-01', acct.bank, acct.ar);
    await post('1084', 'journal_entry@1', '2025-06-01', acct.cash1084, acct.rentIncome);
    await db.query('SELECT gl_reverse_entry($1, $2::date, NULL, NULL, NULL)', [first.id, '2025-04-15']);

    expect(await use()).toEqual([
      { company: '1084', posting_rule: 'journal_entry@1', entries: '1', reversed: '0', first_date: '2025-06-01', last_date: '2025-06-01' },
      { company: 'BMG', posting_rule: 'invoice@1', entries: '3', reversed: '1', first_date: '2025-01-02', last_date: '2025-03-31' },
      { company: 'BMG', posting_rule: 'payment@1', entries: '1', reversed: '0', first_date: '2025-02-01', last_date: '2025-02-01' },
    ]);
  });

  it('names a rule the journal holds whatever it is, so one nobody wrote down shows', async () => {
    await post('BMG', 'made_up@3', '2025-05-05', acct.bank, acct.sales);
    expect((await use()).find((r) => r.posting_rule === 'made_up@3')).toEqual(
      { company: 'BMG', posting_rule: 'made_up@3', entries: '1', reversed: '0', first_date: '2025-05-05', last_date: '2025-05-05' },
    );
  });
});

describe("migration 510: the CPA's reviews", () => {
  it('keeps a review with who, as what, when, the rules and the fingerprint', async () => {
    const { rows } = await review({ note: 'Read the PDF dated Nov 3.' });
    const kept = (await db.query<Record<string, unknown>>(
      'SELECT reviewed_by::text, reviewed_by_name, reviewed_as, rules, fingerprint, note, reviewed_at IS NOT NULL AS dated FROM books_rules_reviews WHERE id = $1',
      [(rows[0] as { id: string }).id],
    )).rows[0];
    expect(kept).toEqual({
      reviewed_by: CRAIG, reviewed_by_name: 'Pat CPA', reviewed_as: 'cpa', rules: ['invoice@1', 'payment@1'],
      fingerprint: FINGERPRINT, note: 'Read the PDF dated Nov 3.', dated: true,
    });
    await expect(review({ reviewed_as: 'super_admin', reviewed_by_name: 'Craig George' })).resolves.toBeDefined();
  });

  it('takes only what the app writes', async () => {
    await expect(review({ reviewed_as: 'bookkeeper' })).rejects.toThrow(/books_rules_reviews_reviewed_as_check/);
    await expect(review({ rules: [] })).rejects.toThrow(/books_rules_reviews_rules_check/);
    await expect(review({ rules: ['invoice'] })).rejects.toThrow(/books_rules_reviews_rules_check/);
    await expect(review({ rules: ['invoice@1', null] })).rejects.toThrow(/books_rules_reviews_rules_check/);
    await expect(review({ rules: ['Invoice@1'] })).rejects.toThrow(/books_rules_reviews_rules_check/);
    await expect(review({ fingerprint: 'abc' })).rejects.toThrow(/books_rules_reviews_fingerprint_check/);
    await expect(review({ fingerprint: 'A'.repeat(64) })).rejects.toThrow(/books_rules_reviews_fingerprint_check/);
    await expect(review({ note: ' padded ' })).rejects.toThrow(/books_rules_reviews_note_check/);
    await expect(review({ note: '' })).rejects.toThrow(/books_rules_reviews_note_check/);
    await expect(review({ note: 'x'.repeat(601) })).rejects.toThrow(/books_rules_reviews_note_check/);
    await expect(review({ reviewed_by_name: '' })).rejects.toThrow(/books_rules_reviews_reviewed_by_name_check/);
  });

  it('keeps a review as it was made, emptied only before the books go live', async () => {
    const { rows } = await review();
    const id = (rows[0] as { id: string }).id;
    await expect(db.query("UPDATE books_rules_reviews SET note = 'Changed' WHERE id = $1", [id]))
      .rejects.toThrow('books: a review of how the books work stays as it was made');
    await expect(db.query('DELETE FROM books_rules_reviews WHERE id = $1', [id]))
      .rejects.toThrow('books: a review of how the books work stays as it was made');

    await as('database');
    await db.query("UPDATE gl_companies SET books_live_from = '2027-01-01' WHERE code = 'BMG'");
    await expect(db.query('TRUNCATE books_rules_reviews')).rejects.toThrow("gl: books_rules_reviews can't be emptied once any company's books are live");
    await db.query("UPDATE gl_companies SET books_live_from = NULL WHERE code = 'BMG'").catch(() => undefined);
    await as('server');
  });

  it("writes a review added outside FleetSuite into the change history, and not FleetSuite's own", async () => {
    const before = Number((await db.query<{ n: string | null }>('SELECT max(id)::text AS n FROM books_money_changes')).rows[0].n ?? 0);
    await review();
    expect((await db.query('SELECT 1 FROM books_money_changes WHERE id > $1', [before])).rows).toEqual([]);

    await as('database');
    const { rows } = await review({ reviewed_by_name: 'Someone in the database' });
    const changes = (await db.query<{ table_name: string; row_key: unknown; op: string; via: string }>(
      'SELECT table_name, row_key, op, via FROM books_money_changes WHERE id > $1 ORDER BY id', [before],
    )).rows;
    expect(changes).toEqual([{ table_name: 'books_rules_reviews', row_key: { id: (rows[0] as { id: string }).id }, op: 'insert', via: 'database' }]);
    await as('server');
  });
});

describe('migration 510: access', () => {
  it('gives the API roles nothing; only the service role reads the reviews and calls gl_posting_rule_use', async () => {
    for (const role of ['anon', 'authenticated']) {
      const fn = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, 'gl_posting_rule_use()', 'EXECUTE') AS ok", [role]);
      expect(fn.rows[0].ok, role).toBe(false);
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const t = await db.query<{ ok: boolean }>("SELECT has_table_privilege($1, 'books_rules_reviews', $2) AS ok", [role, privilege]);
        expect(t.rows[0].ok, `${role} ${privilege}`).toBe(false);
      }
    }
    const s = await db.query<{ ok: boolean }>("SELECT has_function_privilege('service_role', 'gl_posting_rule_use()', 'EXECUTE') AS ok");
    expect(s.rows[0].ok).toBe(true);
    const rls = await db.query<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'books_rules_reviews'");
    expect(rls.rows[0].on).toBe(true);
  });
});
