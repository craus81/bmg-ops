import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join } from 'path';
import { unguardedWrites } from '@/lib/books/sql-writes';

/**
 * Migration 515 (a purchase order's other lines on FleetSuite's copy) on a
 * real Postgres: it applies twice, vendor_po_expense_lines_put replaces the
 * lines of the POs it's given and marks each read, leaves out a PO the copy
 * doesn't have, keeps "not known" apart from "none", and only the service
 * role may call it. Made-up POs, vendors and accounts.
 */

const migration = (name: string) => readFileSync(join(__dirname, '../../migrations', name), 'utf8');

const PO1 = '00000000-0000-4000-8000-000000000001';
const PO2 = '00000000-0000-4000-8000-000000000002';
const GONE = '00000000-0000-4000-8000-0000000000ff';

let db: PGlite;

const put = async (pos: unknown) => (await db.query<{ n: number }>('SELECT public.vendor_po_expense_lines_put($1::jsonb) AS n', [JSON.stringify(pos)])).rows[0].n;
const lines = async (po: string) => (await db.query<Record<string, unknown>>(
  `SELECT line_id, account_netsuite_id, account_name, memo, amount::text AS amount, closed, billed_by
   FROM netsuite_vendor_po_expense_lines WHERE po_id = $1 ORDER BY line_id::int`, [po],
)).rows;
const readAt = async (po: string) => (await db.query<{ at: string | null }>('SELECT expense_lines_read_at::text AS at FROM netsuite_vendor_pos WHERE id = $1', [po])).rows[0].at;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE FUNCTION public.is_internal_staff() RETURNS boolean LANGUAGE sql AS 'select true';`);
  await db.exec(migration('161-vendor-po-sync.sql'));
  await db.exec(migration('511-po-copy-company.sql'));
  await db.exec(migration('515-po-expense-lines.sql'));
  // Deploys re-run the pipeline.
  await db.exec(migration('515-po-expense-lines.sql'));
  await db.exec(`INSERT INTO netsuite_vendor_pos (id, netsuite_id, tranid, vendor_name, status) VALUES
    ('${PO1}', '9101', 'PO9101', 'Acme Racks', 'B'),
    ('${PO2}', '9102', 'PO9102', 'Acme Racks', 'F');`);
});

describe('migration 515', () => {
  it("starts every PO's other lines as not read", async () => {
    expect(await readAt(PO1)).toBeNull();
    expect(await readAt(PO2)).toBeNull();
  });

  it("replaces the other lines of the POs it's given, marks each read, and leaves out one the copy doesn't have", async () => {
    const n = await put([
      {
        po_id: PO1,
        lines: [
          { line_id: '3', account_netsuite_id: '612', account_name: '5100 Freight In', memo: 'Freight', amount: 45.5, closed: false, billed_by: [] },
          { line_id: '4', account_netsuite_id: '613', account_name: null, memo: '', amount: 12, closed: null, billed_by: ['8801', '8802'] },
        ],
      },
      { po_id: PO2, lines: [] },
      { po_id: GONE, lines: [{ line_id: '1', account_netsuite_id: '612', amount: 5, billed_by: [] }] },
    ]);
    expect(n).toBe(2);
    expect(await lines(PO1)).toEqual([
      { line_id: '3', account_netsuite_id: '612', account_name: '5100 Freight In', memo: 'Freight', amount: '45.50', closed: false, billed_by: [] },
      { line_id: '4', account_netsuite_id: '613', account_name: null, memo: null, amount: '12.00', closed: null, billed_by: ['8801', '8802'] },
    ]);
    // Read, with none: not the same as not read.
    expect(await lines(PO2)).toEqual([]);
    expect(await readAt(PO1)).not.toBeNull();
    expect(await readAt(PO2)).not.toBeNull();
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM netsuite_vendor_po_expense_lines WHERE po_id = '${GONE}'`)).rows[0].n).toBe(0);
  });

  it("keeps not knowing a line's bills, its amount or whether it's closed apart from none", async () => {
    await put([{ po_id: PO2, lines: [{ line_id: '7', account_netsuite_id: '612', amount: null, billed_by: null }] }]);
    expect(await lines(PO2)).toEqual([
      { line_id: '7', account_netsuite_id: '612', account_name: null, memo: null, amount: null, closed: null, billed_by: null },
    ]);
  });

  it('a second read of a PO replaces its lines, and leaves the other POs as they were', async () => {
    expect(await put([{ po_id: PO1, lines: [{ line_id: '3', account_netsuite_id: '612', memo: 'Freight', amount: 50, closed: true, billed_by: ['8803'] }] }])).toBe(1);
    expect(await lines(PO1)).toEqual([
      { line_id: '3', account_netsuite_id: '612', account_name: null, memo: 'Freight', amount: '50.00', closed: true, billed_by: ['8803'] },
    ]);
    expect((await lines(PO2)).map((l) => l.line_id)).toEqual(['7']);
  });

  it('refuses what NetSuite never sends: a line id, an account or a bill that is not a number, the same line twice, no list', async () => {
    const refused = async (row: Record<string, unknown>) => {
      await expect(put([{ po_id: PO2, lines: [{ line_id: '9', account_netsuite_id: '612', amount: 1, billed_by: [], ...row }] }])).rejects.toThrow();
      // All or nothing: the PO keeps what it had.
      expect((await lines(PO2)).map((l) => l.line_id)).toEqual(['7']);
    };
    await refused({ line_id: 'x9' });
    await refused({ account_netsuite_id: 'Freight' });
    await refused({ billed_by: ['8801', 'B-2'] });
    await refused({ billed_by: [''] });
    await refused({ billed_by: [null] });
    await expect(put([{ po_id: PO2, lines: [
      { line_id: '9', account_netsuite_id: '612', amount: 1, billed_by: [] },
      { line_id: '9', account_netsuite_id: '612', amount: 2, billed_by: [] },
    ] }])).rejects.toThrow();
    await expect(db.query("SELECT public.vendor_po_expense_lines_put('{}'::jsonb)")).rejects.toThrow('takes a list of purchase orders');
    await expect(db.query('SELECT public.vendor_po_expense_lines_put(NULL)')).rejects.toThrow('takes a list of purchase orders');
  });

  it("drops a PO's other lines with the PO", async () => {
    await db.exec(`DELETE FROM netsuite_vendor_pos WHERE id = '${PO1}'`);
    expect(await lines(PO1)).toEqual([]);
    expect((await lines(PO2)).length).toBe(1);
  });

  it('lets only the service role write, and staff read as they read the rest of the copy', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const r = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, 'public.vendor_po_expense_lines_put(jsonb)', 'EXECUTE') AS ok", [role]);
      expect(r.rows[0].ok, role).toBe(role === 'service_role');
    }
    const rls = await db.query<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'netsuite_vendor_po_expense_lines'");
    expect(rls.rows[0].on).toBe(true);
    const policies = await db.query<{ cmd: string; roles: string[] }>(
      "SELECT cmd, roles::text[] AS roles FROM pg_policies WHERE tablename = 'netsuite_vendor_po_expense_lines'",
    );
    expect(policies.rows).toEqual([{ cmd: 'SELECT', roles: ['authenticated'] }]);
  });

  it("gives the function's DELETE and UPDATE a WHERE, as Supabase's API requires", async () => {
    const body = (await db.query<{ body: string }>("SELECT prosrc AS body FROM pg_proc WHERE proname = 'vendor_po_expense_lines_put'")).rows[0].body;
    expect(body).toMatch(/DELETE FROM/);
    expect(body).toMatch(/UPDATE public\.netsuite_vendor_pos/);
    expect(unguardedWrites(body)).toEqual([]);
  });
});
