// Migration 502 closes a company's year in FleetSuite's books. This runs
// migrations 359 and 502 in an in-memory Postgres (PGlite), then as the
// app's server login holds what gl_set_year_status does: a year closes
// once the books are live, from the year they went live, when every month
// of it is closed and every year before it is; only the latest year closed
// reopens, for a reason; a closed year's months stay closed; and its
// record is never changed or emptied.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const CRAIG = '0b5e1d4a-2f43-4f0f-9d5e-6c1f7a9b3e21';

let db: PGlite;

const months = (year: number, from = 1, to = 12) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${year}-${String(from + i).padStart(2, '0')}-01`);

const setMonth = (company: string, month: string, status: 'open' | 'closed', reason: string | null = null) =>
  db.query('SELECT gl_set_period_status($1, $2::date, $3, $4::uuid, $5, $6) AS r', [company, month, status, CRAIG, 'Craig', reason]);

const closeMonths = async (company: string, list: string[]) => { for (const m of list) await setMonth(company, m, 'closed'); };

type Year = { year: number; status: string; closed_at: string | null };

const setYear = async (
  company: string, year: number | null, status: string,
  opts: { reason?: string | null; name?: string | null; netIncome?: number | null; retained?: number | null } = {},
) => (await db.query<{ r: Year }>(
  'SELECT gl_set_year_status($1, $2, $3, $4::uuid, $5, $6, $7, $8) AS r',
  [company, year, status, CRAIG, opts.name === undefined ? 'Craig' : opts.name, opts.reason ?? null,
    opts.netIncome === undefined ? 4_250_000 : opts.netIncome, opts.retained === undefined ? 18_000_000 : opts.retained],
)).rows[0].r;

const yearRow = async (company: string, year: number) => (await db.query<{
  status: string; closed_at: string | null; closed_by: string | null; closed_by_name: string | null;
  net_income_cents: string | null; retained_earnings_cents: string | null;
}>(
  `SELECT y.status, y.closed_at::text AS closed_at, y.closed_by::text AS closed_by, y.closed_by_name,
          y.net_income_cents::text AS net_income_cents, y.retained_earnings_cents::text AS retained_earnings_cents
   FROM gl_year_closes y JOIN gl_companies c ON c.id = y.company_id WHERE c.code = $1 AND y.year = $2`,
  [company, year],
)).rows[0];

const events = async (company: string, year: number) => (await db.query<{
  action: string; actor_name: string | null; reason: string | null; net_income_cents: string | null; retained_earnings_cents: string | null;
}>(
  `SELECT e.action, e.actor_name, e.reason, e.net_income_cents::text AS net_income_cents,
          e.retained_earnings_cents::text AS retained_earnings_cents
   FROM gl_year_close_events e JOIN gl_companies c ON c.id = e.company_id
   WHERE c.code = $1 AND e.year = $2 ORDER BY e.created_at, e.id`,
  [company, year],
)).rows;

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
  // The migrations run as the owner, like the deploy does...
  for (const file of ['359-books-ledger-core.sql', '502-books-year-end.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await db.exec(sql);
    await db.exec(sql); // must be safe to re-run
  }
  // ...and everything after runs as the app's server login.
  await db.exec('SET ROLE service_role');
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('migration 502: closing a year', () => {
  it('closes nothing before the books are live, nor a year before the one they went live in', async () => {
    await expect(setYear('BMG', 2027, 'closed')).rejects.toThrow("gl: BMG Fleet Installations's books aren't live yet, so no year closes");
    await db.query("UPDATE gl_companies SET books_live_from = '2027-01-01' WHERE code = 'BMG'");
    await expect(setYear('BMG', 2026, 'closed')).rejects.toThrow("gl: 2026 is before BMG Fleet Installations's books went live, so it closes in NetSuite");
    await expect(setYear('BMG', null, 'closed')).rejects.toThrow('gl: That year is before');
    await expect(setYear('BMG', 2027, 'shut')).rejects.toThrow('gl: status must be open or closed');
    await expect(setYear('ACME', 2027, 'closed')).rejects.toThrow('gl: unknown company ACME');
    expect(await yearRow('BMG', 2027)).toBeUndefined();
  });

  it('closes a year only once every month of it is closed, December last', async () => {
    await expect(setYear('BMG', 2027, 'closed')).rejects.toThrow('gl: January 2027 has to close before 2027 does');
    await closeMonths('BMG', months(2027, 1, 11));
    await expect(setYear('BMG', 2027, 'closed')).rejects.toThrow('gl: December 2027 has to close before 2027 does');
    await closeMonths('BMG', ['2027-12-01']);
    // A month that's reopened counts as open again.
    await setMonth('BMG', '2027-12-01', 'open', 'Missed a vendor bill');
    await expect(setYear('BMG', 2027, 'closed')).rejects.toThrow('gl: December 2027 has to close before 2027 does');
    await setMonth('BMG', '2027-12-01', 'closed');
    expect(await yearRow('BMG', 2027)).toBeUndefined();
    expect(await events('BMG', 2027)).toEqual([]);
  });

  it('keeps the year’s net income and retained earnings, and who closed it', async () => {
    await expect(setYear('BMG', 2027, 'closed', { netIncome: null })).rejects.toThrow('gl: closing a year keeps its net income and retained earnings');
    await expect(setYear('BMG', 2027, 'closed', { retained: null })).rejects.toThrow('gl: closing a year keeps its net income and retained earnings');
    const closed = await setYear('BMG', 2027, 'closed', { name: '  Craig  ', netIncome: -125_000, retained: 17_875_000 });
    expect(closed).toMatchObject({ year: 2027, status: 'closed', closed_at: expect.any(String) });
    expect(await yearRow('BMG', 2027)).toMatchObject({
      status: 'closed', closed_at: expect.any(String), closed_by: CRAIG, closed_by_name: 'Craig',
      net_income_cents: '-125000', retained_earnings_cents: '17875000',
    });
    expect(await events('BMG', 2027)).toEqual([
      { action: 'closed', actor_name: 'Craig', reason: null, net_income_cents: '-125000', retained_earnings_cents: '17875000' },
    ]);
    await expect(setYear('BMG', 2027, 'closed')).rejects.toThrow('gl: 2027 is already closed');
    expect(await events('BMG', 2027)).toHaveLength(1);
  });

  it('holds a closed year’s months closed', async () => {
    await expect(setMonth('BMG', '2027-12-01', 'open', 'Missed a vendor bill'))
      .rejects.toThrow('gl: 2027 is closed, so December 2027 stays closed until the year is reopened');
    await expect(setMonth('BMG', '2027-03-01', 'open', 'Missed a vendor bill'))
      .rejects.toThrow('gl: 2027 is closed, so March 2027 stays closed until the year is reopened');
    // Nor straight on the table, with the reason migration 359's own check asks for.
    await expect(db.transaction(async (tx) => {
      await tx.query("SELECT set_config('gl.reason', 'Missed a vendor bill', true)");
      await tx.query("UPDATE gl_periods SET status = 'open' WHERE period_start = '2027-06-01'");
    })).rejects.toThrow('gl: 2027 is closed, so June 2027 stays closed until the year is reopened');
    // Closing one again changes nothing and isn't refused; another year's months open and close as before.
    await setMonth('BMG', '2027-12-01', 'closed');
    await setMonth('BMG', '2028-01-01', 'closed');
    await setMonth('BMG', '2028-01-01', 'open', 'Missed a vendor bill');
    const statuses = await db.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM gl_periods WHERE period_start BETWEEN '2027-01-01' AND '2027-12-01' GROUP BY status",
    );
    expect(statuses.rows).toEqual([{ status: 'closed', n: 12 }]);
  });

  it('closes years in order and reopens them from the latest, each for a reason', async () => {
    await expect(setYear('BMG', 2029, 'closed')).rejects.toThrow('gl: 2028 has to close first: years close in order');
    await expect(setYear('BMG', 2028, 'closed')).rejects.toThrow('gl: January 2028 has to close before 2028 does');
    await closeMonths('BMG', months(2028));
    await setYear('BMG', 2028, 'closed');

    await expect(setYear('BMG', 2027, 'open', { reason: 'The CPA moved a bill' }))
      .rejects.toThrow('gl: 2028 has to reopen first: years reopen from the latest');
    await expect(setYear('BMG', 2028, 'open')).rejects.toThrow('gl: reopening 2028 needs a reason');
    await expect(setYear('BMG', 2028, 'open', { reason: '   ' })).rejects.toThrow('gl: reopening 2028 needs a reason');
    await expect(setYear('BMG', 2028, 'open', { reason: 'x'.repeat(501) })).rejects.toThrow('gl: a reason is 500 characters at most');
    await expect(setYear('BMG', 2029, 'open', { reason: 'Never closed' })).rejects.toThrow("gl: 2029 isn't closed");

    const reopened = await setYear('BMG', 2028, 'open', { reason: '  The CPA moved a bill  ', netIncome: null, retained: null });
    expect(reopened).toMatchObject({ year: 2028, status: 'open', closed_at: null });
    expect(await yearRow('BMG', 2028)).toEqual({
      status: 'open', closed_at: null, closed_by: null, closed_by_name: null, net_income_cents: null, retained_earnings_cents: null,
    });
    expect((await events('BMG', 2028)).map((e) => [e.action, e.reason, e.net_income_cents])).toEqual([
      ['closed', null, '4250000'],
      ['reopened', 'The CPA moved a bill', null],
    ]);
    await expect(setYear('BMG', 2028, 'open', { reason: 'Again' })).rejects.toThrow("gl: 2028 isn't closed");

    // Its months reopen now, from the latest, as Months has them.
    await setMonth('BMG', '2028-12-01', 'open', 'The CPA moved a bill');
    await setMonth('BMG', '2028-12-01', 'closed');

    // It closes again with what the books have then, and 2027 reopens once 2028 has.
    await setYear('BMG', 2028, 'closed', { netIncome: 4_300_000, retained: 22_175_000 });
    expect(await yearRow('BMG', 2028)).toMatchObject({
      status: 'closed', closed_by: CRAIG, closed_by_name: 'Craig', net_income_cents: '4300000', retained_earnings_cents: '22175000',
    });
    await setYear('BMG', 2028, 'open', { reason: 'The CPA moved a bill again' });
    await setYear('BMG', 2027, 'open', { reason: 'The CPA moved a 2027 bill' });
    expect((await yearRow('BMG', 2027)).status).toBe('open');
    await expect(setYear('BMG', 2028, 'closed')).rejects.toThrow('gl: 2027 has to close first: years close in order');
  });

  it('starts a company that went live during a year from the month it did', async () => {
    await db.query("UPDATE gl_companies SET books_live_from = '2027-03-01' WHERE code = '1084'");
    await expect(setYear('1084', 2027, 'closed')).rejects.toThrow('gl: March 2027 has to close before 2027 does');
    await closeMonths('1084', months(2027, 3, 12));
    const closed = await setYear('1084', 2027, 'closed', { name: null });
    expect(closed.status).toBe('closed');
    expect(await yearRow('1084', 2027)).toMatchObject({ status: 'closed', closed_by_name: null });
    // BMG's years are its own.
    expect((await yearRow('BMG', 2027)).status).toBe('open');
  });

  it('never changes or empties the record', async () => {
    await expect(db.query("UPDATE gl_year_close_events SET reason = 'changed'")).rejects.toThrow("gl: gl_year_close_events rows can't be changed or deleted");
    await expect(db.query('DELETE FROM gl_year_close_events')).rejects.toThrow("gl: gl_year_close_events rows can't be changed or deleted");
    await expect(db.query('DELETE FROM gl_year_closes')).rejects.toThrow("gl: gl_year_closes rows can't be changed or deleted");
    await expect(db.query('TRUNCATE gl_year_close_events')).rejects.toThrow("gl: gl_year_close_events can't be emptied once any company's books are live");
    await expect(db.query('TRUNCATE gl_year_closes')).rejects.toThrow("gl: gl_year_closes can't be emptied once any company's books are live");
  });

  it('holds a year’s row and its events whole', async () => {
    const bmg = (await db.query<{ id: string }>("SELECT id FROM gl_companies WHERE code = 'BMG'")).rows[0].id;
    // Closed without the amounts, or open with them, isn't a year's row.
    await expect(db.query(
      "INSERT INTO gl_year_closes (company_id, year, status, closed_at) VALUES ($1, 2031, 'closed', now())", [bmg],
    )).rejects.toThrow('gl_year_closes_whole');
    await expect(db.query(
      "INSERT INTO gl_year_closes (company_id, year, status, net_income_cents, retained_earnings_cents) VALUES ($1, 2031, 'open', 1, 1)", [bmg],
    )).rejects.toThrow('gl_year_closes_whole');
    // Closed keeps each amount, and open neither.
    for (const sql of [
      "INSERT INTO gl_year_closes (company_id, year, status, closed_at, retained_earnings_cents) VALUES ($1, 2031, 'closed', now(), 1)",
      "INSERT INTO gl_year_closes (company_id, year, status, closed_at, net_income_cents) VALUES ($1, 2031, 'closed', now(), 1)",
      "INSERT INTO gl_year_closes (company_id, year, status, net_income_cents) VALUES ($1, 2031, 'open', 1)",
      "INSERT INTO gl_year_closes (company_id, year, status, retained_earnings_cents) VALUES ($1, 2031, 'open', 1)",
    ]) await expect(db.query(sql, [bmg])).rejects.toThrow('gl_year_closes_whole');
    await expect(db.query(
      "INSERT INTO gl_year_closes (company_id, year, status, closed_by_name) VALUES ($1, 2031, 'open', 'Craig')", [bmg],
    )).rejects.toThrow('gl_year_closes_whole');
    await expect(db.query(
      "INSERT INTO gl_year_closes (company_id, year, status) VALUES ($1, 2024, 'open')", [bmg],
    )).rejects.toThrow('gl_year_closes_year_check');
    // A reopen names why, a close keeps the amounts, and a reason is trimmed and short.
    await expect(db.query(
      "INSERT INTO gl_year_close_events (company_id, year, action) VALUES ($1, 2031, 'reopened')", [bmg],
    )).rejects.toThrow('gl_year_close_events_reason');
    await expect(db.query(
      "INSERT INTO gl_year_close_events (company_id, year, action, reason) VALUES ($1, 2031, 'closed', 'ok')", [bmg],
    )).rejects.toThrow('gl_year_close_events_amounts');
    await expect(db.query(
      "INSERT INTO gl_year_close_events (company_id, year, action, reason, net_income_cents, retained_earnings_cents) VALUES ($1, 2031, 'reopened', 'why', 1, 1)", [bmg],
    )).rejects.toThrow('gl_year_close_events_amounts');
    await expect(db.query(
      "INSERT INTO gl_year_close_events (company_id, year, action, reason) VALUES ($1, 2031, 'reopened', ' why ')", [bmg],
    )).rejects.toThrow('gl_year_close_events_reason_check');
  });
});

describe('migration 502: access', () => {
  it('gives the API roles nothing; only the service role closes a year', async () => {
    const fn = 'gl_set_year_status(text, integer, text, uuid, text, text, bigint, bigint)';
    for (const role of ['anon', 'authenticated']) {
      const r = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, fn]);
      expect(r.rows[0].ok, `${role} on ${fn}`).toBe(false);
      for (const table of ['gl_year_closes', 'gl_year_close_events']) {
        await expect(db.transaction(async (tx) => {
          await tx.exec(`SET LOCAL ROLE ${role}`);
          await tx.query(`SELECT count(*) FROM ${table}`);
        })).rejects.toThrow(/permission denied/);
      }
    }
    const s = await db.query<{ ok: boolean }>("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [fn]);
    expect(s.rows[0].ok).toBe(true);
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('gl_year_closes', 'gl_year_close_events') ORDER BY relname",
    );
    expect(rls.rows).toEqual([
      { relname: 'gl_year_close_events', relrowsecurity: true },
      { relname: 'gl_year_closes', relrowsecurity: true },
    ]);
  });
});
