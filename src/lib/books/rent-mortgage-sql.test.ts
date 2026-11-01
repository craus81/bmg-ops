// Migration 492 keeps how 1084 Cool Springs' months are read and booked, and
// each month's rent received from BMG and the lender's statement, as typed:
// each in the month the books show it in, saved as the page saw the month,
// and the two entries that book them made as draft typed journal entries in
// the general journal, once each per month, left as they are once asked for
// approval. This runs migrations 359, 466 to 469, 484 and 492 in an
// in-memory Postgres (PGlite) as the app's server login, the way
// /api/admin/books/rent-and-mortgage calls them. Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const ENTRY = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const HAROLD = 'a0000000-0000-4000-8000-000000000002';

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
    -- What migrations 466 to 492 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, netsuite_id TEXT);
    CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID);
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${HAROLD}');
  `);
  for (const file of [
    '359-books-ledger-core.sql', '466-credit-memos-in-fleetsuite.sql', '467-vendor-credits-in-fleetsuite.sql',
    '468-card-charges-in-fleetsuite.sql', '469-journal-entries-typed-in-fleetsuite.sql', '484-books-cpa-adjustments-journal.sql',
    '492-rent-and-mortgage-for-1084.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    if (file.startsWith('492')) await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

type Row = Record<string, any>;

const RENT = { date: '2027-03-01', cents: 850000 };
const STATEMENT = { paid_on: '2027-03-05', principal_cents: 312040, interest_cents: 287960, escrow_cents: 41500, balance_after_cents: 72118833 };
const MARCH = '2027-03-01';

const save = (pg: PGlite, over: Row = {}) =>
  call(pg, 'rent_mortgage_month_save', { company: '1084', month: MARCH, seen: null, rent: RENT, statement: STATEMENT, by: CRAIG, ...over });

const month = async (pg: PGlite, m = MARCH) => (await pg.query<Row>(
  `SELECT rent_date::text, rent_cents::int, paid_on::text, principal_cents::int, interest_cents::int, escrow_cents::int,
          balance_after_cents::int, rent_entry_id::text, mortgage_entry_id::text, updated_by::text, updated_at::text
   FROM rent_mortgage_months WHERE company = '1084' AND month = $1`, [m])).rows[0];

const typed = async (pg: PGlite, id: string) => (await pg.query<Row>(
  `SELECT journal, company, tran_date::text, memo, lines, total_cents::int, status, created_by::text, updated_at::text
   FROM typed_journal_entries WHERE id = $1`, [id])).rows[0];

/** The rent entry as the route works it out: the bank debited, rent income credited. */
const RENT_ENTRY = {
  tran_date: '2027-03-01', memo: 'Rent from BMG Fleet Installations for March 2027',
  lines: [
    { account_netsuite_id: '910', debit_cents: 850000, credit_cents: 0, memo: null },
    { account_netsuite_id: '930', debit_cents: 0, credit_cents: 850000, memo: null },
  ],
};

const entry = (pg: PGlite, over: Row) =>
  call(pg, 'rent_mortgage_entry_save', { company: '1084', month: MARCH, kind: 'rent', id: ENTRY(1), by: CRAIG, ...RENT_ENTRY, ...over });

describe('migration 492', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it("keeps how a landlord's months are read and booked, each account by NetSuite's id", async () => {
    const put = (row: Row) => pg.query(
      `INSERT INTO rent_mortgage_setups (company, bank_account, rent_income_account, tenant_rent_account, mortgage_account,
                                         interest_account, escrow_account, lender, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (company) DO UPDATE SET bank_account = EXCLUDED.bank_account, lender = EXCLUDED.lender`,
      [row.company, row.bank, row.income, row.tenant, row.mortgage, row.interest, row.escrow, row.lender, CRAIG]);
    const setup = { company: '1084', bank: '910', income: '930', tenant: '640', mortgage: '920', interest: '950', escrow: null, lender: 'Ozark Federal' };
    await put(setup);
    for (const over of [
      { company: 'NOPE' }, { bank: '91O' }, { income: '' }, { tenant: '64 0' }, { mortgage: 'x' }, { interest: '-950' }, { escrow: '9.5' },
      { lender: ' Ozark Federal' }, { lender: '' }, { lender: 'O'.repeat(101) },
    ]) {
      await expect(put({ ...setup, ...over }), JSON.stringify(over)).rejects.toThrow();
    }
    await put({ ...setup, lender: 'O'.repeat(100) });
    await put({ ...setup, bank: null, lender: null });
    expect((await pg.query<Row>(`SELECT bank_account, lender, escrow_account FROM rent_mortgage_setups`)).rows)
      .toEqual([{ bank_account: null, lender: null, escrow_account: null }]);
  });

  it("saves a month's rent and statement as the page saw it, once each time it's seen", async () => {
    expect(await save(pg)).toMatchObject({ state: 'saved' });
    const first = await month(pg);
    expect(first).toMatchObject({
      rent_date: '2027-03-01', rent_cents: 850000, paid_on: '2027-03-05', principal_cents: 312040, interest_cents: 287960,
      escrow_cents: 41500, balance_after_cents: 72118833, rent_entry_id: null, mortgage_entry_id: null, updated_by: CRAIG,
    });
    // Saved by someone else first: the page didn't see it.
    expect(await save(pg, { by: HAROLD })).toEqual({ state: 'changed' });
    expect(await save(pg, { seen: '2027-03-05T12:00:00Z', by: HAROLD })).toEqual({ state: 'changed' });
    // Saved again as it is: nothing changes.
    const same = await save(pg, { seen: first.updated_at, by: HAROLD });
    expect(same).toMatchObject({ state: 'saved', unchanged: true });
    expect(await month(pg)).toEqual(first);
    // Changed, as seen.
    const changed = await save(pg, { seen: first.updated_at, rent: { date: '2027-03-02', cents: 850000 }, by: HAROLD });
    expect(changed).toMatchObject({ state: 'saved' });
    expect(await month(pg)).toMatchObject({ rent_date: '2027-03-02', updated_by: HAROLD });
    expect((await month(pg)).updated_at).not.toBe(first.updated_at);
    // A month seen that isn't there.
    expect(await save(pg, { month: '2027-04-01', seen: first.updated_at })).toEqual({ state: 'changed' });
    expect(await month(pg, '2027-04-01')).toBeUndefined();
    // A month with nothing typed yet is kept as nothing.
    expect(await save(pg, { month: '2027-05-01', rent: null, statement: null })).toMatchObject({ state: 'saved' });
    expect(await month(pg, '2027-05-01')).toMatchObject({ rent_date: null, rent_cents: null, paid_on: null, principal_cents: null });
  });

  it('takes each figure only whole, to the cent and in its month', async () => {
    const at = async (m: string) => (await month(pg, m))?.updated_at ?? null;
    const june = (over: Row) => save(pg, { month: '2027-06-01', rent: { date: '2027-06-01', cents: 850000 },
      statement: { ...STATEMENT, paid_on: '2027-06-05' }, ...over });
    for (const over of [
      { rent: { date: '2027-07-01', cents: 850000 } }, { rent: { date: '2027-05-31', cents: 850000 } },
      { rent: { date: '2027-06-01', cents: 0 } }, { rent: { date: '2027-06-01', cents: -5 } }, { rent: { date: '2027-06-01' } },
      { rent: { cents: 850000 } }, { rent: { date: '2027-06-01', cents: 10000000001 } },
      { statement: { ...STATEMENT, paid_on: '2027-07-05' } }, { statement: { ...STATEMENT, paid_on: null } },
      { statement: { ...STATEMENT, paid_on: '2027-06-05', balance_after_cents: null } },
      { statement: { ...STATEMENT, paid_on: '2027-06-05', escrow_cents: null } },
      { statement: { ...STATEMENT, paid_on: '2027-06-05', principal_cents: -1 } },
      { statement: { ...STATEMENT, paid_on: '2027-06-05', interest_cents: 10000000001 } },
      { statement: { paid_on: '2027-06-05', principal_cents: 0, interest_cents: 0, escrow_cents: 0, balance_after_cents: 72118833 } },
      { statement: { ...STATEMENT, paid_on: '2027-06-05', balance_after_cents: -1 } },
      { month: '2027-06-02', rent: null, statement: null },
    ]) {
      await expect(june(over), JSON.stringify(over)).rejects.toThrow();
      expect(await at('2027-06-01')).toBeNull();
    }
    // Paid off: nothing left after it.
    expect(await june({ statement: { ...STATEMENT, paid_on: '2027-06-05', balance_after_cents: 0 } })).toMatchObject({ state: 'saved' });
    expect(await month(pg, '2027-06-01')).toMatchObject({ balance_after_cents: 0, rent_cents: 850000 });
  });

  it("makes the month's entry as a draft in the general journal, once, linked to the month", async () => {
    const seen = (await month(pg)).updated_at;
    expect(await entry(pg, { seen })).toMatchObject({ state: 'saved', id: ENTRY(1), status: 'draft' });
    expect(await typed(pg, ENTRY(1))).toMatchObject({
      journal: 'general', company: '1084', tran_date: '2027-03-01', memo: 'Rent from BMG Fleet Installations for March 2027',
      total_cents: 850000, status: 'draft', created_by: CRAIG,
      lines: [
        { account_netsuite_id: '910', debit_cents: 850000, credit_cents: 0, memo: null },
        { account_netsuite_id: '930', debit_cents: 0, credit_cents: 850000, memo: null },
      ],
    });
    // Linked, and the month's own time stays when its figures were saved.
    expect(await month(pg)).toMatchObject({ rent_entry_id: ENTRY(1), mortgage_entry_id: null, updated_at: seen });

    // Made again, with another new id: the same draft changes.
    expect(await entry(pg, { seen, id: ENTRY(2), tran_date: '2027-03-02', by: HAROLD })).toMatchObject({ state: 'saved', id: ENTRY(1) });
    expect(await typed(pg, ENTRY(1))).toMatchObject({ tran_date: '2027-03-02', status: 'draft' });
    expect(await typed(pg, ENTRY(2))).toBeUndefined();
    expect(await month(pg)).toMatchObject({ rent_entry_id: ENTRY(1), updated_at: seen });

    // Worked out from figures saved since, or for a month that isn't there: nothing changes.
    expect(await entry(pg, { seen: '2027-03-05T12:00:00Z', tran_date: '2027-03-09' })).toEqual({ state: 'changed' });
    expect(await entry(pg, { seen, month: '2027-04-01' })).toEqual({ state: 'gone' });
    expect(await typed(pg, ENTRY(1))).toMatchObject({ tran_date: '2027-03-02' });
    await expect(entry(pg, { seen, kind: 'deposit' })).rejects.toThrow(/no deposit entry/);
    await expect(entry(pg, { seen, kind: null })).rejects.toThrow(/no unnamed entry/);

    // The mortgage's entry is its own, and never another entry's id.
    expect(await entry(pg, { seen, kind: 'mortgage', id: ENTRY(1) })).toEqual({ state: 'taken' });
    await call(pg, 'typed_journal_entry_save', { id: ENTRY(9), company: 'BMG', tran_date: '2027-03-31', memo: 'Accrual', lines: [], by: HAROLD });
    expect(await entry(pg, { seen, kind: 'mortgage', id: ENTRY(9) })).toEqual({ state: 'taken' });
    expect(await typed(pg, ENTRY(9))).toMatchObject({ company: 'BMG', memo: 'Accrual' });
    const mortgage = {
      kind: 'mortgage', id: ENTRY(3), tran_date: '2027-03-05', memo: 'Mortgage payment to Ozark Federal for March 2027',
      lines: [
        { account_netsuite_id: '920', debit_cents: 312040, credit_cents: 0, memo: 'Principal' },
        { account_netsuite_id: '950', debit_cents: 287960, credit_cents: 0, memo: 'Interest' },
        { account_netsuite_id: '960', debit_cents: 41500, credit_cents: 0, memo: 'Escrow' },
        { account_netsuite_id: '910', debit_cents: 0, credit_cents: 641500, memo: null },
      ],
    };
    expect(await entry(pg, { seen, ...mortgage })).toMatchObject({ state: 'saved', id: ENTRY(3), status: 'draft' });
    expect(await typed(pg, ENTRY(3))).toMatchObject({ company: '1084', total_cents: 641500, journal: 'general' });
    expect(await month(pg)).toMatchObject({ rent_entry_id: ENTRY(1), mortgage_entry_id: ENTRY(3), updated_at: seen });
  });

  it('leaves what an entry booked as it is once that entry is asked for approval', async () => {
    const before = await month(pg);
    expect(await call(pg, 'typed_journal_entry_ask', { id: ENTRY(1), by: CRAIG, updated_at: (await typed(pg, ENTRY(1))).updated_at }))
      .toMatchObject({ state: 'asked' });
    // The rent can't change now; the statement, whose entry is still a draft, can.
    expect(await save(pg, { seen: before.updated_at, rent: { date: '2027-03-03', cents: 850000 } }))
      .toEqual({ state: 'rent_asked', status: 'waiting' });
    expect(await save(pg, { seen: before.updated_at, rent: null })).toEqual({ state: 'rent_asked', status: 'waiting' });
    expect(await month(pg)).toEqual(before);
    const statement = { ...STATEMENT, escrow_cents: 41600 };
    expect(await save(pg, { seen: before.updated_at, rent: { date: '2027-03-02', cents: 850000 }, statement }))
      .toMatchObject({ state: 'saved' });
    const after = await month(pg);
    expect(after).toMatchObject({ escrow_cents: 41600, rent_date: '2027-03-02' });

    // Made again: the asked one stays as it is, saying where it is.
    expect(await entry(pg, { seen: after.updated_at, tran_date: '2027-03-09' })).toEqual({ state: 'kept', id: ENTRY(1), status: 'waiting' });
    expect(await typed(pg, ENTRY(1))).toMatchObject({ tran_date: '2027-03-02', status: 'waiting' });

    // The statement's entry asked too: the statement stays.
    expect(await call(pg, 'typed_journal_entry_ask', { id: ENTRY(3), by: CRAIG, updated_at: (await typed(pg, ENTRY(3))).updated_at }))
      .toMatchObject({ state: 'asked' });
    expect(await save(pg, { seen: after.updated_at, rent: { date: '2027-03-02', cents: 850000 }, statement: STATEMENT }))
      .toEqual({ state: 'statement_asked', status: 'waiting' });
    expect(await month(pg)).toEqual(after);
    // Saved as it is, nothing's refused.
    expect(await save(pg, { seen: after.updated_at, rent: { date: '2027-03-02', cents: 850000 }, statement }))
      .toMatchObject({ state: 'saved', unchanged: true });

    // Taken back to a draft on Journal entries, they can change again.
    expect(await call(pg, 'typed_journal_entry_take_back', { id: ENTRY(1), by: CRAIG })).toMatchObject({ state: 'taken_back' });
    expect(await save(pg, { seen: after.updated_at, rent: { date: '2027-03-03', cents: 850000 }, statement })).toMatchObject({ state: 'saved' });
  });

  it("lets go of an entry whose draft is deleted, and makes the next one new", async () => {
    const before = await month(pg);
    expect(before.rent_entry_id).toBe(ENTRY(1));
    await pg.query(`DELETE FROM typed_journal_entries WHERE id = $1 AND status = 'draft'`, [ENTRY(1)]);
    expect(await month(pg)).toEqual({ ...before, rent_entry_id: null });
    expect(await entry(pg, { seen: before.updated_at, id: ENTRY(4) })).toMatchObject({ state: 'saved', id: ENTRY(4) });
    expect(await month(pg)).toMatchObject({ rent_entry_id: ENTRY(4), mortgage_entry_id: ENTRY(3) });
    // An entry books one month.
    await expect(pg.query(`UPDATE rent_mortgage_months SET rent_entry_id = $1 WHERE company = '1084' AND month = '2027-06-01'`, [ENTRY(4)]))
      .rejects.toThrow();
    await expect(pg.query(`UPDATE rent_mortgage_months SET mortgage_entry_id = $1 WHERE company = '1084' AND month = '2027-06-01'`, [ENTRY(3)]))
      .rejects.toThrow();
    await expect(pg.query(`UPDATE rent_mortgage_months SET mortgage_entry_id = rent_entry_id WHERE company = '1084' AND month = $1`, [MARCH]))
      .rejects.toThrow();
    expect(await month(pg)).toMatchObject({ rent_entry_id: ENTRY(4), mortgage_entry_id: ENTRY(3) });
  });

  it('writes nothing without a WHERE, which the API connections refuse', async () => {
    const bodies = (await pg.query<{ body: string }>(
      `SELECT pg_get_functiondef(p.oid) AS body FROM pg_proc p WHERE p.proname = ANY($1) ORDER BY p.proname`,
      [['rent_mortgage_month_save', 'rent_mortgage_entry_save']])).rows.map((r) => r.body.replace(/--[^\n]*/g, ''));
    expect(bodies).toHaveLength(2);
    // FOR UPDATE locks a row; it's no write.
    const writes = bodies.flatMap((b) => [...b.matchAll(/\b(?:UPDATE\s+(?:ONLY\s+)?[\w."]+\s+SET|DELETE\s+FROM\s+[\w."]+)\b[^;]*;/gi)].map((m) => m[0]));
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.filter((w) => !/\bWHERE\b/i.test(w))).toEqual([]);
  });

  it("is the server's login only", async () => {
    const tables = ['rent_mortgage_setups', 'rent_mortgage_months'];
    const fns = ['rent_mortgage_month_save', 'rent_mortgage_entry_save'];
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${role}`);
      for (const t of tables) await expect(pg.query(`SELECT * FROM ${t}`)).rejects.toThrow();
      for (const fn of fns) await expect(pg.query(`SELECT ${fn}('{}'::jsonb)`)).rejects.toThrow();
    }
    await pg.exec('RESET ROLE; SET ROLE service_role');
    expect((await pg.query('SELECT count(*)::int AS n FROM rent_mortgage_months')).rows).toEqual([{ n: 3 }]);
    const reach = await pg.query<{ t: boolean; e: boolean }>(`
      SELECT has_table_privilege(r.role, 'public.' || t.name, 'SELECT') AS t, false AS e
      FROM unnest(ARRAY['anon', 'authenticated']) AS r(role), unnest($1::text[]) AS t(name)
      UNION ALL
      SELECT false, has_function_privilege(r.role, 'public.' || f.fn || '(jsonb)', 'EXECUTE')
      FROM unnest(ARRAY['anon', 'authenticated']) AS r(role), unnest($2::text[]) AS f(fn)`, [tables, fns]);
    expect(reach.rows).toHaveLength(8);
    expect(reach.rows.filter((x) => x.t || x.e)).toEqual([]);
    expect((await pg.query<Row>(`SELECT relname, relrowsecurity AS on FROM pg_class WHERE relname = ANY($1) ORDER BY relname`, [tables])).rows)
      .toEqual(tables.slice().sort().map((relname) => ({ relname, on: true })));
  });
});
