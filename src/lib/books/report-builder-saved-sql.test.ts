// Migration 501 keeps the report builder's reports saved by name. This runs
// migrations 359–363, 396, 500 and 501 in an in-memory Postgres (PGlite) as
// the app's server login and holds what books_saved_report_save and
// books_saved_report_remove do: a name once per company in any case, the
// months kept only when picked, a report changed or deleted only by its
// saver or a super admin and only as the page last saw it, and the
// table's rules on what a saved report can hold.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const ANN = '00000000-0000-4000-8000-0000000000a1';
const BEN = '00000000-0000-4000-8000-0000000000b2';
const GONE = '00000000-0000-4000-8000-0000000000c3';

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
    -- What migration 501's saved reports point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    INSERT INTO public.profiles (id) VALUES ('${ANN}'), ('${BEN}'), ('${GONE}');
  `);
  for (const file of [
    '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '396-books-reports.sql',
    '500-books-report-builder.sql', '501-books-saved-reports.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  return pg;
}

type Answer = { state: string; id?: string; updated_at?: string; name?: string };
type Saved = {
  company: string; name: string; rows: string; columns: string; division: string | null; location: string | null;
  months: string; from_month: string | null; to_month: string | null; saved_by: string | null; saved_by_name: string | null;
  updated_at: string;
};

const call = async (pg: PGlite, fn: 'books_saved_report_save' | 'books_saved_report_remove', p: Record<string, unknown>) =>
  (await pg.query<{ r: Answer }>(`SELECT public.${fn}($1::jsonb) AS r`, [JSON.stringify(p)])).rows[0].r;

/** A save as the route sends it: Ann's year to date by division on BMG unless told otherwise. */
const save = (pg: PGlite, p: Record<string, unknown>) => call(pg, 'books_saved_report_save', {
  id: null, company: 'BMG', name: 'Upfit by month', rows: 'account', columns: 'division', division: '', location: '',
  months: 'year_to_date', from: null, to: null, by: ANN, by_name: 'Ann', owner: false, ...p,
});
const remove = (pg: PGlite, p: Record<string, unknown>) => call(pg, 'books_saved_report_remove', { by: ANN, owner: false, ...p });

const stored = async (pg: PGlite, id: string) => (await pg.query<Saved>(
  `SELECT company, name, rows, columns, division, location, months, to_char(from_month, 'YYYY-MM-DD') AS from_month,
          to_char(to_month, 'YYYY-MM-DD') AS to_month, saved_by, saved_by_name, updated_at::text AS updated_at
   FROM books_saved_reports WHERE id = $1`, [id])).rows[0];

describe('migration 501: reports saved by name', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg.close(); });

  it('saves a new report as its saver’s, with the months only when picked', async () => {
    const picked = await save(pg, {
      name: '  Graphics Q1  ', rows: 'customer', columns: 'month', division: 'graphics', location: '2',
      months: 'picked', from: '2026-01-01', to: '2026-03-01', by_name: '  Ann  ',
    });
    expect(picked).toMatchObject({ state: 'saved', id: expect.any(String), updated_at: expect.any(String) });
    expect(await stored(pg, picked.id!)).toMatchObject({
      company: 'BMG', name: 'Graphics Q1', rows: 'customer', columns: 'month', division: 'graphics', location: '2',
      months: 'picked', from_month: '2026-01-01', to_month: '2026-03-01', saved_by: ANN, saved_by_name: 'Ann',
    });

    // Months that move with the calendar keep no months, whatever the page sent.
    const moving = await save(pg, { name: 'Vendors last quarter', rows: 'vendor', columns: 'total', months: 'last_quarter',
      from: '2026-01-01', to: '2026-03-01', location: 'own:wentzville', by_name: '' });
    expect(moving.state).toBe('saved');
    expect(await stored(pg, moving.id!)).toMatchObject({
      rows: 'vendor', columns: 'total', division: null, location: 'own:wentzville', months: 'last_quarter',
      from_month: null, to_month: null, saved_by_name: null,
    });
  });

  it('takes a name once per company, in any case', async () => {
    const first = await save(pg, { name: 'Monthly P&L', columns: 'month' });
    expect(first.state).toBe('saved');
    expect(await save(pg, { name: 'monthly p&l', by: BEN })).toEqual({ state: 'name_taken' });
    expect(await save(pg, { name: ' MONTHLY P&L ' })).toEqual({ state: 'name_taken' });
    // 1084 has its own names.
    const other = await save(pg, { company: '1084', name: 'Monthly P&L' });
    expect(other.state).toBe('saved');
    expect((await stored(pg, other.id!)).company).toBe('1084');
  });

  it('changes a report as the page saw it, keeping its saver', async () => {
    const made = await save(pg, { name: 'By location', columns: 'location' });
    const seen = made.updated_at!;
    const changed = await save(pg, {
      id: made.id, seen, name: 'By location, picked months', columns: 'location', division: 'upfit',
      months: 'picked', from: '2025-01-01', to: '2025-12-01', by_name: 'Ann again',
    });
    expect(changed).toMatchObject({ state: 'saved', id: made.id });
    expect(changed.updated_at).not.toBe(seen);
    expect(await stored(pg, made.id!)).toMatchObject({
      name: 'By location, picked months', division: 'upfit', months: 'picked', from_month: '2025-01-01', to_month: '2025-12-01',
      saved_by: ANN, saved_by_name: 'Ann',
    });

    // Its own name in another case is no clash; another report's name is.
    const recased = await save(pg, { id: made.id, seen: changed.updated_at, name: 'BY LOCATION, PICKED MONTHS', columns: 'location' });
    expect(recased.state).toBe('saved');
    expect(await save(pg, { id: made.id, seen: recased.updated_at, name: 'monthly p&l' })).toEqual({ state: 'name_taken' });
    expect((await stored(pg, made.id!)).name).toBe('BY LOCATION, PICKED MONTHS');

    // Back to months that move with the calendar: the months picked go, whatever the page sent.
    const moving = await save(pg, {
      id: made.id, seen: recased.updated_at, name: 'By location', columns: 'location', months: 'last_year', from: '2025-01-01', to: '2025-12-01',
    });
    expect(moving.state).toBe('saved');
    expect(await stored(pg, made.id!)).toMatchObject({ name: 'By location', months: 'last_year', from_month: null, to_month: null });
  });

  it('refuses a change to a report saved since the page saw it, or deleted', async () => {
    const made = await save(pg, { name: 'Two tabs' });
    const later = await save(pg, { id: made.id, seen: made.updated_at, name: 'Two tabs', columns: 'year' });
    expect(later.state).toBe('saved');
    // The other tab still has the first save.
    expect(await save(pg, { id: made.id, seen: made.updated_at, name: 'Two tabs', columns: 'quarter' })).toEqual({ state: 'changed' });
    expect(await save(pg, { id: made.id, name: 'Two tabs' })).toEqual({ state: 'changed' });
    expect(await save(pg, { id: made.id, seen: '2020-01-01T00:00:00Z', name: 'Two tabs' })).toEqual({ state: 'changed' });
    expect((await stored(pg, made.id!)).columns).toBe('year');

    expect(await save(pg, { id: '00000000-0000-4000-8000-00000000dead', seen: made.updated_at })).toEqual({ state: 'gone' });
    expect(await remove(pg, { id: '00000000-0000-4000-8000-00000000dead', seen: made.updated_at })).toEqual({ state: 'gone' });
  });

  it('lets only its saver or a super admin change or delete a report', async () => {
    const made = await save(pg, { name: 'Ann’s report' });
    expect(await save(pg, { id: made.id, seen: made.updated_at, name: 'Ben’s now', by: BEN })).toEqual({ state: 'not_yours' });
    expect(await save(pg, { id: made.id, seen: made.updated_at, name: 'Nobody’s', by: null })).toEqual({ state: 'not_yours' });
    expect(await remove(pg, { id: made.id, seen: made.updated_at, by: BEN })).toEqual({ state: 'not_yours' });

    const owner = await save(pg, { id: made.id, seen: made.updated_at, name: 'Ann’s report, fixed', by: BEN, by_name: 'Ben', owner: true });
    expect(owner.state).toBe('saved');
    expect(await stored(pg, made.id!)).toMatchObject({ name: 'Ann’s report, fixed', saved_by: ANN, saved_by_name: 'Ann' });

    expect(await remove(pg, { id: made.id, seen: made.updated_at })).toEqual({ state: 'changed' });
    expect(await remove(pg, { id: made.id, seen: owner.updated_at })).toEqual({ state: 'removed', name: 'Ann’s report, fixed' });
    expect(await stored(pg, made.id!)).toBeUndefined();
    expect(await remove(pg, { id: made.id, seen: owner.updated_at })).toEqual({ state: 'gone' });

    // A report whose saver's login was deleted is a super admin's to change.
    const orphan = await save(pg, { name: 'Left the company', by: GONE });
    await pg.query('DELETE FROM public.profiles WHERE id = $1', [GONE]);
    expect((await stored(pg, orphan.id!)).saved_by).toBeNull();
    expect(await save(pg, { id: orphan.id, seen: orphan.updated_at, name: 'Mine now', by: null })).toEqual({ state: 'not_yours' });
    expect(await remove(pg, { id: orphan.id, seen: orphan.updated_at, by: null })).toEqual({ state: 'not_yours' });
    expect(await remove(pg, { id: orphan.id, seen: orphan.updated_at, by: BEN, owner: true })).toEqual({ state: 'removed', name: 'Left the company' });
  });

  it('holds what a saved report can be', async () => {
    const bad: Array<Record<string, unknown>> = [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(61) },
      { rows: 'item' },
      { columns: 'week' },
      { months: 'next_month' },
      { division: 'paint' },
      { location: 'O Fallon' },
      { location: 'own:A' },
      { location: '12a' },
      { months: 'picked', from: '2026-03-01', to: '2026-01-01' },
      { months: 'picked', from: '2026-01-01', to: null },
      { months: 'picked', from: '2024-12-01', to: '2025-01-01' },
      { months: 'picked', from: '2026-01-15', to: '2026-02-01' },
      { months: 'picked', from: '2026-01-01', to: '2026-02-15' },
      { company: 'NOPE' },
    ];
    for (const [i, p] of bad.entries()) {
      await expect(save(pg, { name: `Bad ${i}`, ...p }), JSON.stringify(p)).rejects.toThrow();
    }
    expect((await save(pg, { name: 'x'.repeat(60) })).state).toBe('saved');
    expect((await save(pg, { name: 'No location', location: 'none', division: 'none' })).state).toBe('saved');
  });

  it('holds its rules on whatever writes to it, not only the save', async () => {
    const insert = (name: string, more: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = { company: 'BMG', name, rows: 'account', columns: 'total', months: 'year_to_date', ...more };
      const columns = Object.keys(row);
      return pg.query(
        `INSERT INTO books_saved_reports (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    await insert('Typed straight in');
    await expect(insert('TYPED STRAIGHT IN')).rejects.toThrow(/books_saved_reports_name/);
    await expect(insert(' Padded ')).rejects.toThrow(/books_saved_reports_name_check/);
    await expect(insert('Moving with months', { months: 'last_year', from_month: '2025-01-01', to_month: '2025-12-01' }))
      .rejects.toThrow(/books_saved_reports_months/);
    await expect(insert('Picked without months', { months: 'picked' })).rejects.toThrow(/books_saved_reports_months/);
    await insert('Picked straight in', { months: 'picked', from_month: '2025-01-01', to_month: '2025-12-01' });
  });

  it('is for the server login only', async () => {
    // Row level security on, and neither function the other logins' at all.
    expect((await pg.query<{ r: boolean }>(`SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.books_saved_reports'::regclass`)).rows[0].r)
      .toBe(true);
    for (const f of ['books_saved_report_save(jsonb)', 'books_saved_report_remove(jsonb)']) {
      const can = async (role: string) =>
        (await pg.query<{ r: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS r`, [role, `public.${f}`])).rows[0].r;
      expect([f, await can('anon'), await can('authenticated'), await can('service_role')]).toEqual([f, false, false, true]);
    }

    const saved = await save(pg, { name: 'Server only' });
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`SET ROLE ${role}`);
      try {
        await expect(pg.query('SELECT count(*) FROM books_saved_reports')).rejects.toThrow(/permission denied/);
        await expect(pg.query(`SELECT public.books_saved_report_save('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
        await expect(pg.query(`SELECT public.books_saved_report_remove('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
      } finally {
        await pg.exec('RESET ROLE');
      }
    }
    await pg.exec('SET ROLE service_role');
    try {
      expect((await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM books_saved_reports WHERE id = $1', [saved.id])).rows[0].n).toBe(1);
      const answer = await remove(pg, { id: saved.id, seen: saved.updated_at });
      expect(answer).toEqual({ state: 'removed', name: 'Server only' });
    } finally {
      await pg.exec('RESET ROLE');
    }
  });
});
