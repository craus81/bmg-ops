// Migration 482 keeps NetSuite's 1099 report for a company's year, to hold
// against FleetSuite's totals. This runs it (on the ledger core, 359) in an
// in-memory Postgres (PGlite) as the app's server login: who may use it, a
// report read from a made-up export kept and replaced as the route sends it,
// and everything it refuses, above all nine digits in a row: a tax ID, maybe.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { checkReport, read1099Report } from './1099-report';
import { parseDelimited } from '@/lib/import-installs-parse';

const UPLOADER = '00000000-0000-4000-8000-000000000051';

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
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    INSERT INTO public.profiles (id) VALUES ('${UPLOADER}');
  `);
  for (const file of ['359-books-ledger-core.sql', '482-books-1099-report.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  return pg;
}

// A made-up export: NetSuite's title, the headings with a tax ID and an address, two vendors and the total.
const EXPORT = [
  'Sample Fleet Co',
  'January 2025 - December 2025',
  'Vendor,Tax ID,Address,Rents,Nonemployee Compensation,Total',
  '"V-50 Sample Painting",12-3456789,"100 Main St, Springfield MO 65800-1234",,"$1,500.00","$1,500.00"',
  '"Example Rentals",123-45-6789,200 Oak Ave,"12,000,050.00",,"12,000,050.00"',
  'Total,,,"12,000,050.00","1,500.00","12,001,550.00"',
].join('\n');

/** The report as the route sends it to be kept (src/app/api/admin/books/1099s/route.ts). */
function payload(company: string, year: number, fileName = '1099 Summary.csv') {
  const read = read1099Report(parseDelimited(EXPORT, ','), ['Nonemployee Compensation', 'Rents']);
  const checked = checkReport({ ...read.report, fileName });
  if (!('report' in checked)) throw new Error(checked.error);
  const r = checked.report;
  return {
    company, year, file_name: r.fileName, title: r.title, left_out: r.leftOut, columns: r.columns, vendors: r.vendors,
    skipped: { totals: r.skipped.totals, no_name: r.skipped.noName, combined: r.skipped.combined }, uploaded_by: UPLOADER,
  };
}

describe("NetSuite's 1099 reports (migration 482)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const save = async (p: unknown) =>
    (await db.query<{ r: Record<string, unknown> }>('SELECT gl_netsuite_1099_report_save($1::jsonb) AS r', [JSON.stringify(p)])).rows[0].r;
  const refused = async (p: unknown) => {
    try {
      await save(p);
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  };
  const kept = async () => (await db.query<Record<string, unknown>>(`
    SELECT c.code, r.year, r.file_name, r.title_lines, r.amount_columns, r.left_out, r.vendors, r.skipped, r.uploaded_by
    FROM gl_netsuite_1099_reports r JOIN gl_companies c ON c.id = r.company_id ORDER BY c.code, r.year
  `)).rows;

  it('lets only the service role read them or run the functions, and the one delete in them is bounded', async () => {
    for (const fn of [
      'gl_1099_report_has_nine_digits(jsonb)', 'gl_netsuite_1099_report_save(jsonb)', 'gl_netsuite_1099_report_remove(text, integer)',
    ]) {
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(false);
      }
      const s = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn]);
      expect(s.rows[0].ok, fn).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      const t = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'gl_netsuite_1099_reports', 'SELECT') AS ok`, [role]);
      expect(t.rows[0].ok, role).toBe(false);
    }
    const rls = await db.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'gl_netsuite_1099_reports'`);
    expect(rls.rows[0].on).toBe(true);

    // Supabase's API connections fail an UPDATE or DELETE with no WHERE, even inside a function (migrations/README.md).
    const body = async (name: string) => (await db.query<{ b: string }>(`SELECT prosrc AS b FROM pg_proc WHERE proname = $1`, [name])).rows[0].b;
    const saveBody = await body('gl_netsuite_1099_report_save');
    expect(saveBody.match(/\b(INSERT|UPDATE|DELETE)\b/g)).toEqual(['INSERT', 'UPDATE']);
    expect(saveBody).toMatch(/ON CONFLICT \(company_id, year\) DO UPDATE SET/);
    const removeBody = await body('gl_netsuite_1099_report_remove');
    expect(removeBody.match(/\b(INSERT|UPDATE|DELETE)\b/g)).toEqual(['DELETE']);
    expect(removeBody).toMatch(/DELETE FROM public\.gl_netsuite_1099_reports r WHERE r\.company_id = v_company AND r\.year = p_year/);
  });

  it('keeps a report read from an export with no tax ID or address in it, each company and year apart', async () => {
    expect(await save(payload('BMG', 2025))).toEqual({ company: 'BMG', year: 2025, vendors: 2, replaced: false });
    expect(await save(payload('1084', 2025, "1084's.csv"))).toEqual({ company: '1084', year: 2025, vendors: 2, replaced: false });
    const rows = await kept();
    expect(rows.map((r) => [r.code, r.year, r.file_name])).toEqual([['1084', 2025, "1084's.csv"], ['BMG', 2025, '1099 Summary.csv']]);
    expect(rows[1]).toMatchObject({
      title_lines: ['Sample Fleet Co', 'January 2025 - December 2025'],
      amount_columns: [
        { key: 'c1', header: 'Rents', box: 'Rents' },
        { key: 'c2', header: 'Nonemployee Compensation', box: 'Nonemployee Compensation' },
        { key: 'c3', header: 'Total', box: null },
      ],
      left_out: ['Tax ID', 'Address'],
      // Over a million dollars is nine digits of cents, and kept: amounts are numbers, not text.
      vendors: [
        { label: 'V-50 Sample Painting', names: [], amounts: { c2: 150000, c3: 150000 } },
        { label: 'Example Rentals', names: [], amounts: { c1: 1200005000, c3: 1200005000 } },
      ],
      skipped: { totals: 1, no_name: 0, combined: 0 },
      uploaded_by: UPLOADER,
    });
    const all = JSON.stringify(rows);
    for (const id of ['3456789', '6789', 'Main St', 'Oak Ave']) expect(all).not.toContain(id);
  });

  it('replaces the year\'s report with a new one', async () => {
    const next = { ...payload('BMG', 2025, 'Again.csv'), vendors: [{ label: 'Demo Signs', names: ['Demo Signs LLC'], amounts: { c1: -500 } }], skipped: {} };
    expect(await save(next)).toEqual({ company: 'BMG', year: 2025, vendors: 1, replaced: true });
    const bmg = (await kept()).find((r) => r.code === 'BMG');
    expect(bmg).toMatchObject({
      file_name: 'Again.csv', vendors: [{ label: 'Demo Signs', names: ['Demo Signs LLC'], amounts: { c1: -500 } }],
      skipped: { totals: 0, no_name: 0, combined: 0 },
    });
  });

  it('refuses nine digits in a row in any name, heading or title, keeping nothing', async () => {
    const before = await kept();
    const p = payload('BMG', 2026);
    const tin = '12-3456789';
    for (const bad of [
      { ...p, file_name: `${tin}.csv` },
      { ...p, title: [`EIN ${tin}`] },
      { ...p, left_out: ['Tax ID', `${tin}`] },
      { ...p, columns: [{ ...p.columns[0], header: tin }, ...p.columns.slice(1)] },
      { ...p, columns: [{ ...p.columns[0], box: `Rents ${tin}` }, ...p.columns.slice(1)] },
      { ...p, vendors: [{ label: `Sample 123 45 6789`, names: [], amounts: {} }] },
      { ...p, vendors: [{ label: 'Sample', names: ['Sample LLC', '123.45.6789'], amounts: {} }] },
    ]) {
      expect(await refused(bad), JSON.stringify(bad).slice(0, 80)).toMatch(/nine digits in a row/);
    }
    expect(await kept()).toEqual(before);
    // The table itself refuses one written without the function.
    await expect(db.query(`
      INSERT INTO gl_netsuite_1099_reports (company_id, year, file_name, amount_columns, vendors)
      SELECT id, 2027, 'f.csv', '[{"key":"c1","header":"Rents","box":"Rents"}]', '[{"label":"V 123456789","names":[],"amounts":{}}]'
      FROM gl_companies WHERE code = 'BMG'
    `)).rejects.toThrow(/gl_netsuite_1099_reports_no_tax_ids/);
  });

  it("refuses a report that isn't the shape the route sends, keeping nothing", async () => {
    const before = await kept();
    const p = payload('BMG', 2026);
    const vendor = (v: Record<string, unknown>) => ({ ...p, vendors: [{ label: 'Sample', names: [], amounts: {}, ...v }] });
    const column = (c: Record<string, unknown>) => ({ ...p, columns: [{ key: 'c1', header: 'Rents', box: 'Rents', ...c }] });
    for (const [bad, message] of [
      [{ ...p, company: 'XYZ' }, 'gl: no company XYZ'],
      [{ ...p, year: '25' }, 'gl: the year must be four digits'],
      [{ ...p, file_name: ' ' }, "gl: the report's file name is missing"],
      [{ ...p, title: 'x' }, "gl: the report's title and left-out headings must be lists of text"],
      [{ ...p, left_out: [1] }, "gl: the report's title and left-out headings must be lists of text"],
      [{ ...p, columns: [] }, 'gl: the report needs a column of amounts'],
      [column({ key: 'x1' }), 'gl: column x1 needs a key, a heading and a box or none'],
      [column({ header: ' ' }), 'gl: column c1 needs a key, a heading and a box or none'],
      [column({ box: ' ' }), 'gl: column c1 needs a key, a heading and a box or none'],
      [column({ box: 7 }), 'gl: column c1 needs a key, a heading and a box or none'],
      [{ ...p, columns: [{ key: 'c1', header: 'Rents' }] }, 'gl: column c1 needs a key, a heading and a box or none'],
      [{ ...p, columns: [p.columns[0], { ...p.columns[1], key: 'c1' }] }, 'gl: column c1 is in the report twice'],
      [{ ...p, vendors: [] }, 'gl: the report lists no vendors'],
      [vendor({ label: ' ' }), "gl: vendor 1 of the report needs a name and its amounts in whole cents under the report's columns"],
      [vendor({ names: [5] }), "gl: vendor 1 of the report needs a name and its amounts in whole cents under the report's columns"],
      [vendor({ amounts: [] }), "gl: vendor 1 of the report needs a name and its amounts in whole cents under the report's columns"],
      [vendor({ amounts: { c1: 12.5 } }), "gl: vendor 1 of the report needs a name and its amounts in whole cents under the report's columns"],
      [vendor({ amounts: { c1: '100' } }), "gl: vendor 1 of the report needs a name and its amounts in whole cents under the report's columns"],
      [vendor({ amounts: { c9: 100 } }), "gl: vendor 1 of the report needs a name and its amounts in whole cents under the report's columns"],
      [vendor({ amounts: { c1: 1e15 } }), "gl: vendor 1 of the report needs a name and its amounts in whole cents under the report's columns"],
    ] as Array<[unknown, string]>) {
      expect(await refused(bad), message).toBe(message);
    }
    expect(await kept()).toEqual(before);
  });

  it("takes a company's year's report off, and only that one", async () => {
    const remove = async (company: string, year: number) =>
      (await db.query<{ r: Record<string, unknown> }>('SELECT gl_netsuite_1099_report_remove($1, $2) AS r', [company, year])).rows[0].r;
    expect(await remove('BMG', 2025)).toEqual({ removed: true });
    expect((await kept()).map((r) => [r.code, r.year])).toEqual([['1084', 2025]]);
    expect(await remove('BMG', 2025)).toEqual({ removed: false });
    await expect(remove('XYZ', 2025)).rejects.toThrow('gl: no company XYZ');
  });
});
