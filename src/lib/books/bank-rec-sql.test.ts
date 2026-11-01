// Migration 493 keeps 1084 Cool Springs' bank reconciliation: where
// reconciling its bank account starts, each month's statement with what
// cleared on it, and each month reconciled or undone. Months are reconciled
// in order and undone last first; one is done only when its starting balance
// and what's ticked come to its ending balance; an entry clears once. This
// runs migrations 359 and 493 in an in-memory Postgres (PGlite) as the app's
// server login, the way /api/admin/books/bank-reconciliation calls them.
// Made-up data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const HAROLD = 'a0000000-0000-4000-8000-000000000002';
const TYPED = 'entry:e0000000-0000-4000-8000-000000000007';

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
    -- What migration 493 points at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    INSERT INTO public.profiles (id) VALUES ('${CRAIG}'), ('${HAROLD}');
  `);
  for (const file of ['359-books-ledger-core.sql', '493-bank-reconciliation-for-1084.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    if (file.startsWith('493')) await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const call = async <T = any>(pg: PGlite, fn: string, p: unknown) =>
  (await pg.query<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

type Row = Record<string, any>;

const OCTOBER = '2026-10-01';
const NOVEMBER = '2026-11-01';
const DECEMBER = '2026-12-01';
const BANK = '910';

/** Reconciling starts with October's statement: the bank had $12,000.00 on September 30, and check 1001 hadn't cleared. */
const START = { company: '1084', account: BANK, first_month: OCTOBER, as_of: '2026-09-30', balance_cents: 1200000, outstanding: ['5001'], by: CRAIG };

const start = (pg: PGlite, over: Row = {}) => call(pg, 'bank_rec_start_save', { seen: null, ...START, ...over });
const save = (pg: PGlite, over: Row) =>
  call(pg, 'bank_rec_save', { company: '1084', account: BANK, seen: null, ending_cents: null, ticks: [], finish: false, by: CRAIG, ...over });
const undo = (pg: PGlite, over: Row) => call(pg, 'bank_rec_undo', { company: '1084', account: BANK, reason: 'Missed the fee', by: HAROLD, ...over });

const startRow = async (pg: PGlite) => (await pg.query<Row>(
  `SELECT first_month::text, as_of::text, balance_cents::int, outstanding, updated_by::text, updated_at::text FROM bank_rec_starts
   WHERE company = '1084' AND account = $1`, [BANK])).rows[0];
const rec = async (pg: PGlite, month: string) => (await pg.query<Row>(
  `SELECT ends_on::text, ending_cents::int, status, done_by::text, done_at IS NOT NULL AS done, updated_by::text, updated_at::text
   FROM bank_recs WHERE company = '1084' AND account = $1 AND month = $2`, [BANK, month])).rows[0];
const ticks = async (pg: PGlite, month?: string) => (await pg.query<Row>(
  `SELECT doc, month::text, cents::int FROM bank_rec_ticks WHERE company = '1084' AND account = $1 AND ($2::date IS NULL OR month = $2)
   ORDER BY month, doc`, [BANK, month ?? null])).rows;
const events = async (pg: PGlite) => (await pg.query<Row>(
  `SELECT month::text, action, reason, actor_id::text FROM bank_rec_events WHERE company = '1084' AND account = $1 ORDER BY created_at, action`,
  [BANK])).rows;

describe('migration 493', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); });
  afterAll(async () => { await pg.close(); });

  it('keeps where reconciling starts as the page saw it, the day before the first statement in the month before', async () => {
    expect(await call(pg, 'bank_rec_save', { company: '1084', account: BANK, month: OCTOBER, ends_on: '2026-10-31', seen: null, ticks: [] }))
      .toEqual({ state: 'no_start' });
    for (const over of [
      { company: 'NOPE' }, { account: 'x910' }, { first_month: '2026-10-02' }, { as_of: '2026-10-01' }, { as_of: '2026-08-31' },
      { balance_cents: 10000000001 }, { balance_cents: -10000000001 }, { outstanding: ['50 01'] }, { outstanding: ['5001', '5001'] },
      { outstanding: ['entry:E0000000-0000-4000-8000-000000000007'] }, { outstanding: ['entry:e0000000-0000-4000-8000-00000000000A'] },
      { outstanding: ['entry:7'] },
      { outstanding: Array.from({ length: 501 }, (_, i) => String(i + 1)) },
    ]) {
      await expect(start(pg, over), JSON.stringify(over).slice(0, 60)).rejects.toThrow();
    }
    expect(await pg.query('SELECT 1 FROM bank_rec_starts')).toMatchObject({ rows: [] });

    // Seen by the page, but never saved: someone else's, let go of since.
    expect(await start(pg, { seen: '2026-10-05T12:00:00Z' })).toEqual({ state: 'changed' });
    const saved = await start(pg, { outstanding: ['5001', TYPED], balance_cents: -2500 });
    expect(saved).toMatchObject({ state: 'saved', let_go: [] });
    const first = await startRow(pg);
    expect(first).toMatchObject({ first_month: OCTOBER, as_of: '2026-09-30', balance_cents: -2500, outstanding: ['5001', TYPED], updated_by: CRAIG });
    // Saved by someone else first: the page didn't see it.
    expect(await start(pg, { by: HAROLD })).toEqual({ state: 'changed' });
    expect(await start(pg, { seen: '2026-10-05T12:00:00Z', by: HAROLD })).toEqual({ state: 'changed' });
    expect(await startRow(pg)).toEqual(first);
    // As seen, it changes; a statement can end before the month does.
    expect(await start(pg, { seen: saved.updated_at, as_of: '2026-09-25', by: HAROLD })).toMatchObject({ state: 'saved', let_go: [] });
    expect(await startRow(pg)).toMatchObject({ as_of: '2026-09-25', balance_cents: 1200000, outstanding: ['5001'], updated_by: HAROLD });
    // What the page saw before that is out of date now.
    expect(await start(pg, { seen: saved.updated_at, by: HAROLD })).toEqual({ state: 'changed' });
    expect(await start(pg, { seen: (await startRow(pg)).updated_at, outstanding: [] })).toMatchObject({ state: 'saved' });
    expect((await startRow(pg)).outstanding).toEqual([]);
    expect(await start(pg, { seen: (await startRow(pg)).updated_at })).toMatchObject({ state: 'saved' });
  });

  it('saves the month reconciling starts with, its ticks as sent each time, and no other month', async () => {
    expect(await save(pg, { month: NOVEMBER, ends_on: '2026-11-30' })).toEqual({ state: 'not_next', next: OCTOBER });
    expect(await save(pg, { month: OCTOBER, ends_on: '2026-10-31', seen: '2026-10-05T12:00:00Z' })).toEqual({ state: 'changed' });
    const saved = await save(pg, { month: OCTOBER, ends_on: '2026-10-31', ticks: [{ doc: '5001', cents: -45000 }, { doc: '5002', cents: 850000 }] });
    expect(saved).toMatchObject({ state: 'saved' });
    const first = await rec(pg, OCTOBER);
    expect(first).toMatchObject({ ends_on: '2026-10-31', ending_cents: null, status: 'open', done_by: null, done: false, updated_by: CRAIG });
    expect(await ticks(pg)).toEqual([{ doc: '5001', month: OCTOBER, cents: -45000 }, { doc: '5002', month: OCTOBER, cents: 850000 }]);
    // Saved by someone else first: the page didn't see it.
    expect(await save(pg, { month: OCTOBER, ends_on: '2026-10-31', by: HAROLD })).toEqual({ state: 'changed' });
    expect(await save(pg, { month: OCTOBER, ends_on: '2026-10-31', seen: '2026-10-05T12:00:00Z' })).toEqual({ state: 'changed' });
    expect(await ticks(pg)).toHaveLength(2);

    // Saved as seen: the ticks are what's sent, the rest let go of.
    const again = await save(pg, {
      month: OCTOBER, seen: saved.updated_at, ends_on: '2026-10-30', ending_cents: 1555000, by: HAROLD,
      ticks: [{ doc: '5002', cents: 850000 }, { doc: TYPED, cents: -495000 }],
    });
    expect(again).toMatchObject({ state: 'saved' });
    expect(await rec(pg, OCTOBER)).toMatchObject({ ends_on: '2026-10-30', ending_cents: 1555000, status: 'open', done_by: null, updated_by: HAROLD });
    expect(await ticks(pg)).toEqual([{ doc: '5002', month: OCTOBER, cents: 850000 }, { doc: TYPED, month: OCTOBER, cents: -495000 }]);
    // What the page saw before that is out of date now.
    expect(await save(pg, { month: OCTOBER, ends_on: '2026-10-31', seen: saved.updated_at })).toEqual({ state: 'changed' });

    const seen = (await rec(pg, OCTOBER)).updated_at;
    for (const over of [
      { ends_on: '2026-11-01' }, { ends_on: '2026-09-30' }, { ending_cents: 10000000001 },
      { ticks: [{ doc: '5002', cents: 0 }] }, { ticks: [{ doc: 'x5002', cents: 100 }] }, { ticks: [{ doc: '5002', cents: 10000000001 }] },
      { ticks: [{ doc: '5002', cents: 100 }, { doc: '5002', cents: 100 }] },
    ]) {
      await expect(save(pg, { month: OCTOBER, ends_on: '2026-10-31', seen, ...over }), JSON.stringify(over)).rejects.toThrow();
    }
    expect(await rec(pg, OCTOBER)).toMatchObject({ ends_on: '2026-10-30', ending_cents: 1555000, updated_at: seen });
    expect(await ticks(pg)).toHaveLength(2);
  });

  it("finishes a month only when its starting balance and what's ticked come to its ending balance", async () => {
    const seen = (await rec(pg, OCTOBER)).updated_at;
    const october = { month: OCTOBER, seen, ends_on: '2026-10-31', ticks: [{ doc: '5002', cents: 850000 }, { doc: TYPED, cents: -495000 }] };
    expect(await save(pg, { ...october, finish: true })).toEqual({ state: 'no_ending' });
    // $12,000.00 + $8,500.00 - $4,950.00 is $15,550.00: a cent short.
    expect(await save(pg, { ...october, ending_cents: 1554999, finish: true })).toEqual({ state: 'apart', apart_cents: -1 });
    expect(await save(pg, { ...october, ending_cents: 1555000, ticks: october.ticks.slice(1), finish: true }))
      .toEqual({ state: 'apart', apart_cents: 850000 });
    // Nothing's saved until it's done.
    expect(await rec(pg, OCTOBER)).toMatchObject({ ends_on: '2026-10-30', status: 'open', updated_at: seen });
    expect(await ticks(pg)).toHaveLength(2);
    expect(await events(pg)).toEqual([]);

    expect(await save(pg, { ...october, ending_cents: 1555000, finish: true, by: HAROLD })).toMatchObject({ state: 'done' });
    expect(await rec(pg, OCTOBER)).toMatchObject({ ends_on: '2026-10-31', ending_cents: 1555000, status: 'done', done_by: HAROLD, done: true });
    expect(await events(pg)).toEqual([{ month: OCTOBER, action: 'done', reason: null, actor_id: HAROLD }]);
    // Done, it isn't saved again: November is next.
    expect(await save(pg, { ...october, seen: (await rec(pg, OCTOBER)).updated_at, ending_cents: 1555000 }))
      .toEqual({ state: 'not_next', next: NOVEMBER });
  });

  it("starts the next month from the last one's ending balance, and clears an entry once", async () => {
    expect(await save(pg, { month: DECEMBER, ends_on: '2026-12-31' })).toEqual({ state: 'not_next', next: NOVEMBER });
    // An entry ticked on any other month, even a later one, isn't this one's.
    await pg.query(`INSERT INTO bank_recs (company, account, month, ends_on) VALUES ('1084', $1, $2, '2026-12-31')`, [BANK, DECEMBER]);
    await pg.query(`INSERT INTO bank_rec_ticks (company, account, doc, month, cents) VALUES ('1084', $1, '5009', $2, 100)`, [BANK, DECEMBER]);
    expect(await save(pg, { month: NOVEMBER, ends_on: '2026-11-30', ticks: [{ doc: '5009', cents: 100 }] })).toEqual({ state: 'taken', doc: '5009' });
    await pg.query(`DELETE FROM bank_rec_ticks WHERE company = '1084' AND account = $1 AND month = $2`, [BANK, DECEMBER]);
    await pg.query(`DELETE FROM bank_recs WHERE company = '1084' AND account = $1 AND month = $2`, [BANK, DECEMBER]);
    expect(await save(pg, { month: NOVEMBER, ends_on: '2026-11-30', ticks: [{ doc: '5003', cents: 850000 }, { doc: '5002', cents: 850000 }] }))
      .toEqual({ state: 'taken', doc: '5002' });
    expect(await save(pg, { month: NOVEMBER, ends_on: '2026-11-30', ticks: [{ doc: '5003', cents: 850000 }] })).toMatchObject({ state: 'saved' });
    // $15,550.00 + $8,500.00 is $24,050.00.
    const seen = (await rec(pg, NOVEMBER)).updated_at;
    expect(await save(pg, { month: NOVEMBER, seen, ends_on: '2026-11-30', ending_cents: 1555000, ticks: [{ doc: '5003', cents: 850000 }], finish: true }))
      .toEqual({ state: 'apart', apart_cents: -850000 });
    expect(await save(pg, { month: NOVEMBER, seen, ends_on: '2026-11-30', ending_cents: 2405000, ticks: [{ doc: '5003', cents: 850000 }], finish: true }))
      .toMatchObject({ state: 'done' });
    expect(await save(pg, { month: NOVEMBER, seen: (await rec(pg, NOVEMBER)).updated_at, ends_on: '2026-11-30' }))
      .toEqual({ state: 'not_next', next: DECEMBER });
    expect(await ticks(pg)).toEqual([
      { doc: '5002', month: OCTOBER, cents: 850000 }, { doc: TYPED, month: OCTOBER, cents: -495000 }, { doc: '5003', month: NOVEMBER, cents: 850000 },
    ]);
    // Where reconciling starts stays as it is once a month is done.
    const was = await startRow(pg);
    expect(await start(pg, { seen: was.updated_at, balance_cents: 1 })).toEqual({ state: 'done' });
    expect(await startRow(pg)).toEqual(was);
  });

  it('undoes the last month done, for a reason, while the month after it has nothing ticked', async () => {
    const october = await rec(pg, OCTOBER);
    const november = await rec(pg, NOVEMBER);
    expect(await undo(pg, { month: OCTOBER, seen: october.updated_at })).toEqual({ state: 'not_last' });
    expect(await undo(pg, { month: DECEMBER, seen: november.updated_at })).toEqual({ state: 'not_last' });
    expect(await undo(pg, { month: NOVEMBER, seen: october.updated_at })).toEqual({ state: 'changed' });
    await expect(undo(pg, { month: NOVEMBER, seen: november.updated_at, reason: '  ' })).rejects.toThrow();
    await expect(undo(pg, { month: NOVEMBER, seen: november.updated_at, reason: 'x'.repeat(301) })).rejects.toThrow();
    expect(await rec(pg, NOVEMBER)).toEqual(november);

    expect(await undo(pg, { month: NOVEMBER, seen: november.updated_at, reason: ' Missed the fee ' })).toMatchObject({ state: 'undone' });
    expect(await rec(pg, NOVEMBER)).toMatchObject({ status: 'open', done_by: null, done: false, ending_cents: 2405000, updated_by: HAROLD });
    expect(await ticks(pg, NOVEMBER)).toEqual([{ doc: '5003', month: NOVEMBER, cents: 850000 }]);
    expect(await events(pg)).toEqual([
      { month: OCTOBER, action: 'done', reason: null, actor_id: HAROLD },
      { month: NOVEMBER, action: 'done', reason: null, actor_id: CRAIG },
      { month: NOVEMBER, action: 'undone', reason: 'Missed the fee', actor_id: HAROLD },
    ]);
    // November has an entry ticked, so October stays done until it's unticked.
    expect(await undo(pg, { month: OCTOBER, seen: october.updated_at })).toEqual({ state: 'next_ticked' });
    expect(await save(pg, { month: NOVEMBER, seen: (await rec(pg, NOVEMBER)).updated_at, ends_on: '2026-11-30', ending_cents: 2405000 }))
      .toMatchObject({ state: 'saved' });
    expect(await ticks(pg, NOVEMBER)).toEqual([]);
    expect(await undo(pg, { month: OCTOBER, seen: october.updated_at })).toMatchObject({ state: 'undone' });
    expect(await rec(pg, OCTOBER)).toMatchObject({ status: 'open', ending_cents: 1555000 });
    // October is next again; November waits.
    expect(await save(pg, { month: NOVEMBER, seen: (await rec(pg, NOVEMBER)).updated_at, ends_on: '2026-11-30' }))
      .toEqual({ state: 'not_next', next: OCTOBER });
  });

  it('lets go of the months saved when reconciling starts with another month, and keeps their history', async () => {
    const was = await startRow(pg);
    // Same month: the months stay.
    expect(await start(pg, { seen: was.updated_at, balance_cents: 1200001 })).toMatchObject({ state: 'saved', let_go: [] });
    expect(await rec(pg, OCTOBER)).toMatchObject({ status: 'open' });
    expect(await ticks(pg)).toHaveLength(2);

    const moved = await start(pg, { seen: (await startRow(pg)).updated_at, first_month: NOVEMBER, as_of: '2026-10-31', outstanding: ['5003'] });
    expect(moved).toMatchObject({ state: 'saved', let_go: [OCTOBER, NOVEMBER] });
    expect(await pg.query('SELECT 1 FROM bank_recs')).toMatchObject({ rows: [] });
    expect(await ticks(pg)).toEqual([]);
    expect(await events(pg)).toHaveLength(4);
    expect(await save(pg, { month: OCTOBER, ends_on: '2026-10-31' })).toEqual({ state: 'not_next', next: NOVEMBER });
    expect(await save(pg, { month: NOVEMBER, ends_on: '2026-11-30', ticks: [{ doc: '5003', cents: 850000 }] })).toMatchObject({ state: 'saved' });
  });

  it("keeps a month's statement whole: in its month, done with an ending balance, its ticks on a month saved", async () => {
    await expect(pg.query(
      `INSERT INTO bank_recs (company, account, month, ends_on, status, done_at) VALUES ('1084', $1, '2026-12-01', '2026-12-31', 'done', now())`,
      [BANK])).rejects.toThrow();
    await expect(pg.query(
      `INSERT INTO bank_recs (company, account, month, ends_on, ending_cents, status) VALUES ('1084', $1, '2026-12-01', '2026-12-31', 1, 'done')`,
      [BANK])).rejects.toThrow();
    await expect(pg.query(`INSERT INTO bank_recs (company, account, month, ends_on) VALUES ('1084', '911', '2026-12-01', '2026-12-31')`)).rejects.toThrow();
    await expect(pg.query(`INSERT INTO bank_rec_ticks (company, account, doc, month, cents) VALUES ('1084', $1, '5009', '2026-12-01', 1)`, [BANK]))
      .rejects.toThrow();
    await expect(pg.query(`DELETE FROM bank_recs WHERE company = '1084' AND account = $1`, [BANK])).rejects.toThrow();
    await expect(pg.query(`INSERT INTO bank_rec_events (company, account, month, action, reason) VALUES ('1084', $1, $2, 'done', 'Why')`, [BANK, NOVEMBER]))
      .rejects.toThrow();
    await expect(pg.query(`INSERT INTO bank_rec_events (company, account, month, action) VALUES ('1084', $1, $2, 'undone')`, [BANK, NOVEMBER]))
      .rejects.toThrow();
  });

  it('writes nothing without a WHERE, which the API connections refuse', async () => {
    const bodies = (await pg.query<{ body: string }>(
      `SELECT pg_get_functiondef(p.oid) AS body FROM pg_proc p WHERE p.proname = ANY($1) ORDER BY p.proname`,
      [['bank_rec_start_save', 'bank_rec_save', 'bank_rec_undo']])).rows.map((r) => r.body.replace(/--[^\n]*/g, ''));
    expect(bodies).toHaveLength(3);
    // FOR UPDATE locks a row; it's no write.
    const writes = bodies.flatMap((b) => [...b.matchAll(/\b(?:UPDATE\s+(?:ONLY\s+)?[\w."]+\s+SET|DELETE\s+FROM\s+[\w."]+)\b[^;]*;/gi)].map((m) => m[0]));
    expect(writes).toHaveLength(6);
    expect(writes.filter((w) => !/\bWHERE\b/i.test(w))).toEqual([]);
  });

  it("is the server's login only", async () => {
    const tables = ['bank_rec_starts', 'bank_recs', 'bank_rec_ticks', 'bank_rec_events'];
    const fns = ['bank_rec_start_save', 'bank_rec_save', 'bank_rec_undo'];
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`RESET ROLE; SET ROLE ${role}`);
      for (const t of tables) await expect(pg.query(`SELECT * FROM ${t}`)).rejects.toThrow();
      for (const fn of fns) await expect(pg.query(`SELECT ${fn}('{}'::jsonb)`)).rejects.toThrow();
      await expect(pg.query(`SELECT bank_rec_docs_ok('{}'::text[])`)).rejects.toThrow();
    }
    await pg.exec('RESET ROLE; SET ROLE service_role');
    expect((await pg.query('SELECT count(*)::int AS n FROM bank_recs')).rows).toEqual([{ n: 1 }]);
    expect((await pg.query('SELECT bank_rec_docs_ok(ARRAY[$1, $2]) AS ok', ['5001', TYPED])).rows).toEqual([{ ok: true }]);
    const reach = await pg.query<{ t: boolean; e: boolean }>(`
      SELECT has_table_privilege(r.role, 'public.' || t.name, 'SELECT') AS t, false AS e
      FROM unnest(ARRAY['anon', 'authenticated']) AS r(role), unnest($1::text[]) AS t(name)
      UNION ALL
      SELECT false, has_function_privilege(r.role, 'public.' || f.fn || '(jsonb)', 'EXECUTE')
      FROM unnest(ARRAY['anon', 'authenticated']) AS r(role), unnest($2::text[]) AS f(fn)
      UNION ALL
      SELECT false, has_function_privilege(r.role, 'public.bank_rec_docs_ok(text[])', 'EXECUTE')
      FROM unnest(ARRAY['anon', 'authenticated']) AS r(role)`, [tables, fns]);
    expect(reach.rows).toHaveLength(16);
    expect(reach.rows.filter((x) => x.t || x.e)).toEqual([]);
    expect((await pg.query<Row>(`SELECT relname, relrowsecurity AS on FROM pg_class WHERE relname = ANY($1) ORDER BY relname`, [tables])).rows)
      .toEqual(tables.slice().sort().map((relname) => ({ relname, on: true })));
  });
});
