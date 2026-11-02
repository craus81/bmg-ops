// Migration 508 keeps the change history on the books' money tables: every
// change to the money settings and documents, and any change to the rest of
// the books made outside FleetSuite, with what changed from what to what, how
// it was made and who made it, never a locked column's value. This builds the
// books from their migrations in an in-memory Postgres (PGlite), as the
// restore drill does, and holds each rule; and Books → Change history's route
// (src/lib/books/money-changes.ts) reads it there, its reads built the way
// supabase-js builds them.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';
import { BACKUP_TABLES } from './backups';
import { DRILL_STAND_INS, readDrillMigrations } from './restore-drill';
import { unguardedWrites } from './sql-writes';

let db: PGlite;
const MIGRATIONS = path.resolve(__dirname, '../../../migrations');
const CRAIG = '0b5e1d4a-2f43-4f0f-9d5e-6c1f7a9b3e21';
const JESSIE = '5d0c3a2e-8b1f-4c6d-a7e9-2f4b6c8d0e13';
const ZACH = '7a2e9c41-3d5b-4f60-8e1a-9b3c5d7f1a24';

let roles = ['admin', 'super_admin'];
vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => roles.includes(r));
      return booksAllows(access, need)
        ? { user: { id: CRAIG, email: 'craig@example.com' }, profile: { full_name: 'Craig George' }, access }
        : { error: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) };
    }),
  };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));

import { GET } from '../../app/api/admin/books/change-history/route';
import { TABLES } from './money-changes';

/** A read of a table built the way supabase-js builds it, run against the database; a time comes back as PostgREST gives it. */
function from(table: string) {
  let columns = '*';
  let head = false;
  const where: string[] = [];
  const values: unknown[] = [];
  const orders: string[] = [];
  let range: [number, number] | null = null;
  const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const column = (col: string) => {
    if (!/^[a-z_]+$/.test(col)) throw new Error(`No column ${col}`);
    return col;
  };
  const run = async (): Promise<{ data: any; error: { message: string } | null; count?: number | null }> => {
    const filter = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    try {
      if (head) {
        const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}${filter}`, values);
        return { data: null, error: null, count: r.rows[0].n };
      }
      const r = await db.query<Record<string, unknown>>(
        `SELECT ${columns} FROM ${table}${filter}${orders.length ? ` ORDER BY ${orders.join(', ')}` : ''}`
          + `${range ? ` LIMIT ${range[1] - range[0] + 1} OFFSET ${range[0]}` : ''}`,
        values,
      );
      const data = r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])));
      return { data, error: null };
    } catch (e: any) {
      return { data: null, error: { message: e.message } };
    }
  };
  const query: any = {
    select: (cols: string, opts?: { count?: string; head?: boolean }) => { columns = cols; head = !!opts?.head; return query; },
    eq: (col: string, value: unknown) => { where.push(`${column(col)} = ${param(value)}`); return query; },
    gte: (col: string, value: unknown) => { where.push(`${column(col)} >= ${param(value)}`); return query; },
    in: (col: string, list: unknown[]) => { where.push(`${column(col)} = ANY(${param(list)})`); return query; },
    // PostgREST's not.in.(a,b): names here hold no commas or quotes.
    not: (col: string, op: string, list: string) => {
      if (op !== 'in' || !/^\([a-z0-9_,]+\)$/.test(list)) throw new Error(`No not.${op}.${list} filter`);
      where.push(`NOT (${column(col)} = ANY(${param(list.slice(1, -1).split(','))}))`);
      return query;
    },
    contains: (col: string, value: Record<string, unknown>) => { where.push(`${column(col)} @> ${param(JSON.stringify(value))}::jsonb`); return query; },
    order: (col: string, opts?: { ascending?: boolean }) => {
      orders.push(`${column(col)} ${opts?.ascending === false ? 'DESC' : 'ASC'}`);
      return query;
    },
    range: (start: number, end: number) => { range = [start, end]; return query; },
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
  };
  return query;
}
const service = { from };

/** The money settings and documents: every change to them is written down, however it's made. */
const EVERY_CHANGE = [
  'bank_rec_starts', 'bank_recs', 'bill_fixes', 'books_switches', 'card_charge_sends', 'card_charges', 'card_merchant_rules',
  'detail_changes', 'gl_accounts', 'gl_companies', 'gl_periods', 'gl_snapped_bills', 'gl_year_closes', 'inventory_adjustment_asks',
  'inventory_transfers', 'invoice_credit_memos', 'invoice_fixes', 'made_bank_deposits', 'own_number_series', 'received_deposits',
  'received_payments', 'rent_mortgage_months', 'rent_mortgage_setups', 'sales_tax_rates', 'sales_tax_returns', 'stock_counts',
  'typed_journal_entries', 'typed_vendor_credits', 'vendor_ach_file_payments', 'vendor_ach_files', 'vendor_ach_setups',
  'vendor_bank_accounts', 'vendor_check_layouts', 'vendor_checks', 'vendor_payment_run_payments', 'vendor_payment_runs',
];

// Made-up locked values in the shapes the checks take; neither may ever be copied into the history.
const LOCKED = `v1.0a1b2c3d.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(48)}`;
const LOCKED_AGAIN = `v1.0a1b2c3d.${'D'.repeat(16)}.${'E'.repeat(22)}.${'F'.repeat(48)}`;
const SEAL = `0a1b2c3d.${'G'.repeat(43)}`;

type How = 'server' | 'screen' | 'database' | 'migration';

/** Makes the next statements come the way `how` says: FleetSuite's server, a browser signed in as `sub`, straight in the database, or an update. */
async function as(how: How, sub: string = JESSIE): Promise<void> {
  await db.exec('RESET ROLE');
  const claims = how === 'server' ? { role: 'service_role' } : how === 'screen' ? { role: 'authenticated', sub } : null;
  await db.query(
    `SELECT set_config('request.jwt.claims', $1, false), set_config('fleetsuite.via', $2, false), set_config('application_name', $3, false)`,
    [claims ? JSON.stringify(claims) : '', how === 'migration' ? 'migration 999-made-up.sql' : '', how === 'database' ? 'Supabase Studio' : 'postgrest'],
  );
  if (how === 'server') await db.exec('SET ROLE service_role');
}

const rpc = async <T = any>(fn: string, p: Record<string, unknown>): Promise<T> => {
  const r = await db.query<{ r: T }>(`SELECT ${fn}(p => $1::jsonb) AS r`, [JSON.stringify(p)]);
  return r.rows[0].r;
};

const newest = async () => Number((await db.query<{ n: string | null }>('SELECT max(id)::text AS n FROM books_money_changes')).rows[0].n ?? 0);
/** The changes written since `after` (an id), oldest first. */
const since = async (after: number) => (await db.query<Record<string, any>>('SELECT * FROM books_money_changes WHERE id > $1 ORDER BY id', [after])).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(DRILL_STAND_INS);
  for (const m of readDrillMigrations(MIGRATIONS, BACKUP_TABLES, null)) await db.exec(m.sql);
  await db.exec(readFileSync(path.join(MIGRATIONS, '508-books-money-changes.sql'), 'utf8')); // must be safe to re-run
  await db.exec(`INSERT INTO profiles (id, full_name) VALUES ('${CRAIG}', 'Craig George'), ('${JESSIE}', 'Jessie Jones'), ('${ZACH}', 'Zach Zane')`);
}, 120_000);

afterAll(async () => { await db?.close(); });

describe('migration 508: where changes are written down', () => {
  it('has a trigger on every table of the books but the history: every change to the money tables, outside changes to the rest', async () => {
    const triggers = (await db.query<{ tbl: string; def: string; nargs: number; args: string }>(
      `SELECT c.relname AS tbl, pg_get_triggerdef(t.oid) AS def, t.tgnargs AS nargs, encode(t.tgargs, 'escape') AS args
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'books_money_change' ORDER BY c.relname`,
    )).rows;
    const tables = triggers.map((t) => t.tbl);
    expect(tables).toEqual(BACKUP_TABLES.filter((t) => t !== 'books_money_changes').sort());
    expect(triggers.filter((t) => !/ WHEN /.test(t.def)).map((t) => t.tbl)).toEqual(EVERY_CHANGE);
    for (const t of triggers) {
      expect(t.def, t.tbl).toMatch(/AFTER INSERT OR DELETE OR UPDATE ON public\.\w+ FOR EACH ROW/);
      if (!EVERY_CHANGE.includes(t.tbl)) expect(t.def, t.tbl).toContain("WHEN ((books_change_via() = ANY (ARRAY['database'::text, 'screen'::text])))");
    }

    // The first argument is the table's primary key, in order, or for NetSuite's stock copies without one, the columns
    // of their one unique index; the second names columns the table has.
    const keyless: Record<string, string> = { gl_netsuite_stock_opening: 'company_id,item_id,location_id', gl_netsuite_stock_counts: 'item_id,location_id' };
    for (const t of triggers) {
      const [key, names] = t.args.split('\\000');
      const pk = (await db.query<{ key: string | null }>(
        `SELECT string_agg(a.attname, ',' ORDER BY k.n) AS key FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, n)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE i.indrelid = $1::regclass AND i.indisprimary`, [`public.${t.tbl}`],
      )).rows[0].key;
      expect(key, t.tbl).toBe(pk ?? keyless[t.tbl]);
      expect(!!pk, t.tbl).toBe(!(t.tbl in keyless));
      const unique = (await db.query<{ def: string }>(
        `SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index WHERE indrelid = $1::regclass AND indisunique`, [`public.${t.tbl}`],
      )).rows.map((r) => r.def);
      if (t.tbl in keyless) {
        expect(unique, t.tbl).toEqual([expect.stringContaining(`(${keyless[t.tbl].replace(/,location_id$/, '').split(',').join(', ')}, COALESCE(location_id, ''::text))`)]);
      }
      expect(t.nargs, t.tbl).toBe(2);
      const columns = new Set((await db.query<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t.tbl],
      )).rows.map((r) => r.c));
      for (const name of names ? names.split(',') : []) expect(columns.has(name), `${t.tbl}.${name}`).toBe(true);
      if (!EVERY_CHANGE.includes(t.tbl)) expect(names, t.tbl).toBe('');
      else expect(names, t.tbl).not.toBe('');
    }
  });

  it('records nothing for itself', async () => {
    const r = await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.books_money_changes'::regclass AND NOT tgisinternal ORDER BY tgname`);
    expect(r.rows).toEqual([{ tgname: 'books_money_changes_guard' }, { tgname: 'books_money_changes_truncate_guard' }]);
  });

  it('names each table\'s rows by the columns Books → Change history reads them by (src/lib/books/money-changes.ts)', async () => {
    const triggers = (await db.query<{ tbl: string; args: string }>(
      `SELECT c.relname AS tbl, encode(t.tgargs, 'escape') AS args FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'books_money_change' ORDER BY c.relname`,
    )).rows;
    expect(Object.keys(TABLES).sort()).toEqual(triggers.map((t) => t.tbl));
    for (const t of triggers) {
      const [, names] = t.args.split('\\000');
      // Every change to a table the page names rows of; only changes made outside FleetSuite to the rest.
      expect(TABLES[t.tbl].names?.join(',') ?? '', t.tbl).toBe(names);
    }
  });
});

describe('migration 508: a change to a money setting', () => {
  it('writes down a switch turned on by FleetSuite\'s server: what changed, its key and name, how, and who it stamped', async () => {
    const after = await newest();
    await as('server');
    await db.exec(`UPDATE books_switches SET is_on = true, changed_by = '${CRAIG}', changed_at = '2026-11-02 21:00:00+00' WHERE piece = 'credit_memos'`);
    const [c, ...more] = await since(after);
    expect(more).toEqual([]);
    expect(c).toMatchObject({
      table_name: 'books_switches',
      op: 'update',
      row_key: { piece: 'credit_memos' },
      row_name: { piece: 'credit_memos' },
      changed: {
        is_on: { from: false, to: true },
        changed_by: { from: null, to: CRAIG },
        changed_at: { from: null, to: '2026-11-02T21:00:00+00:00' },
      },
      via: 'server',
      actor: CRAIG,
      db_login: 'postgres',
      db_app: null,
      migration: null,
      told_at: null,
    });
    expect(Object.keys(c.changed).sort()).toEqual(['changed_at', 'changed_by', 'is_on']);
    expect(Number(c.tx)).toBeGreaterThan(0);
    expect(c.at).toBeInstanceOf(Date);
  });

  it('writes down a row added and one taken away in full, its own times aside', async () => {
    const after = await newest();
    await as('server');
    await db.exec(`INSERT INTO sales_tax_rates (location_id, starts_on, rate_pct, note, entered_by) VALUES ('7', '2026-10-01', 8.475, 'Made-up rate', '${JESSIE}')`);
    await db.exec(`DELETE FROM sales_tax_rates WHERE location_id = '7' AND starts_on = '2026-10-01'`);
    const [added, gone] = await since(after);
    expect(added).toMatchObject({
      table_name: 'sales_tax_rates', op: 'insert', row_key: { location_id: '7', starts_on: '2026-10-01' },
      row_name: { location_id: '7', starts_on: '2026-10-01' }, via: 'server', actor: JESSIE,
    });
    expect(added.changed).toEqual({
      location_id: { to: '7' }, starts_on: { to: '2026-10-01' }, rate_pct: { to: 8.475 }, note: { to: 'Made-up rate' },
      entered_by: { to: JESSIE }, entered_at: { to: expect.any(String) },
    });
    expect(gone).toMatchObject({ op: 'delete', row_key: { location_id: '7', starts_on: '2026-10-01' }, via: 'server', actor: null });
    expect(gone.changed).toEqual({
      location_id: { from: '7' }, starts_on: { from: '2026-10-01' }, rate_pct: { from: 8.475 }, note: { from: 'Made-up rate' },
      entered_by: { from: JESSIE }, entered_at: { from: added.changed.entered_at.to },
    });
  });

  it('writes nothing when a change moves only the row\'s updated_at, or nothing at all', async () => {
    await as('server');
    await db.exec(`
      INSERT INTO vendor_ach_setups (bank_account_netsuite_id, company, destination, destination_name, origin, origin_name, odfi,
        company_name, company_id, entry_description, sec_code, addenda, balanced, line_ending, updated_by, updated_at)
      VALUES ('101', 'BMG', '081000210', 'FIRST BANK', '1234567890', 'BMG FLEET', '08100021', 'BMG FLEET', '1234567890',
        'VENDORS', 'CCD', true, false, 'crlf', '${JESSIE}', '2026-11-02 20:00:00+00')`);
    const after = await newest();
    await db.exec(`UPDATE vendor_ach_setups SET updated_at = '2026-11-02 20:05:00+00' WHERE bank_account_netsuite_id = '101'`);
    await db.exec(`UPDATE vendor_ach_setups SET line_ending = 'crlf' WHERE bank_account_netsuite_id = '101'`);
    expect(await since(after)).toEqual([]);
  });

  it('names whoever the change stamped again with its time, and nobody when it stamped no one', async () => {
    await as('server');
    let after = await newest();
    // Saved again by the same person: updated_by stays, its updated_at moves.
    await db.exec(`UPDATE vendor_ach_setups SET entry_description = 'BILLS', updated_by = '${JESSIE}', updated_at = '2026-11-02 20:10:00+00' WHERE bank_account_netsuite_id = '101'`);
    let [c] = await since(after);
    expect(c).toMatchObject({ actor: JESSIE, changed: { entry_description: { from: 'VENDORS', to: 'BILLS' } } });
    expect(Object.keys(c.changed)).toEqual(['entry_description']);

    // Changed without stamping anyone: the record doesn't guess.
    after = await newest();
    await db.exec(`UPDATE vendor_ach_setups SET entry_description = 'PAYMENTS' WHERE bank_account_netsuite_id = '101'`);
    [c] = await since(after);
    expect(c).toMatchObject({ actor: null, via: 'server' });
  });

  it('names the latest of several people one change stamps', async () => {
    await as('server');
    await db.exec(`
      INSERT INTO bank_rec_starts (company, account, first_month, as_of, balance_cents, outstanding, updated_by, updated_at)
      VALUES ('1084', '1000', '2026-01-01', '2025-12-31', 100000, '{}', '${JESSIE}', '2026-11-01 10:00:00+00')`);
    await db.exec(`
      INSERT INTO bank_recs (company, account, month, ends_on, ending_cents, status, updated_by, updated_at)
      VALUES ('1084', '1000', '2026-01-01', '2026-01-31', 120000, 'open', '${JESSIE}', '2026-11-01 10:00:00+00')`);
    const after = await newest();
    await db.exec(`
      UPDATE bank_recs SET status = 'done', done_by = '${CRAIG}', done_at = '2026-11-01 12:00:00+00',
        updated_by = '${ZACH}', updated_at = '2026-11-01 11:00:00+00'
      WHERE company = '1084' AND account = '1000' AND month = '2026-01-01'`);
    const [c] = await since(after);
    expect(c).toMatchObject({ table_name: 'bank_recs', actor: CRAIG, row_name: { company: '1084', account: '1000', month: '2026-01-01' } });
  });

  it('names a vendor\'s bank numbers but never copies them or the call-back\'s seal', async () => {
    await as('server');
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    const after = await newest();
    const enter = (id: string, locked: string) => rpc('vendor_bank_enter', {
      id, vendor_netsuite_id: '4501', vendor_name: 'Acme Supply', routing_number: '081000210', account_last4: '6789',
      account_type: 'checking', name_on_account: 'ACME SUPPLY', source: 'W-9 form, emailed', account_locked: locked, by: JESSIE,
    });
    expect(await enter(first, LOCKED)).toEqual({ state: 'entered', fresh: true });
    expect(await rpc('vendor_bank_confirm', { id: first, by: CRAIG, called_phone: '(314) 555-0100', spoke_with: 'Pat in billing', confirm_seal: SEAL }))
      .toEqual({ state: 'confirmed', replaced: null });
    expect(await enter(second, LOCKED_AGAIN)).toEqual({ state: 'entered', fresh: true });
    expect(await rpc('vendor_bank_confirm', { id: second, by: CRAIG, called_phone: '(314) 555-0100', spoke_with: 'Pat in billing', confirm_seal: SEAL }))
      .toEqual({ state: 'confirmed', replaced: first });

    const rows = await since(after);
    const text = JSON.stringify(rows);
    for (const secret of [LOCKED, LOCKED_AGAIN, SEAL, 'CCCCCCCC', 'FFFFFFFF', 'GGGGGGGG']) expect(text).not.toContain(secret);
    expect(rows.map((r) => [r.op, r.row_key.id, r.actor])).toEqual([
      ['insert', first, JESSIE],
      ['update', first, CRAIG],
      ['insert', second, JESSIE],
      ['update', first, CRAIG],
      ['update', second, CRAIG],
    ]);
    expect(rows[0].changed.account_locked).toEqual({ hidden: true });
    expect(rows[0].row_name).toEqual({ vendor_name: 'Acme Supply', routing_number: '081000210', account_last4: '6789' });
    expect(rows[1].changed).toMatchObject({ status: { from: 'pending', to: 'confirmed' }, confirm_seal: { hidden: true, from: null } });
    expect(rows[3].changed).toMatchObject({
      status: { from: 'confirmed', to: 'replaced' }, account_locked: { hidden: true, to: null }, confirm_seal: { hidden: true, to: null },
    });
  });

  it('names BMG\'s offset account in an ACH file\'s setup as changed, set or emptied, never its numbers', async () => {
    await as('server');
    const after = await newest();
    const offset = (locked: string | null) => db.exec(`
      UPDATE vendor_ach_setups SET balanced = ${locked ? 'true' : 'false'},
        offset_routing = ${locked ? "'081000210'" : 'NULL'}, offset_last4 = ${locked ? "'4321'" : 'NULL'},
        offset_type = ${locked ? "'checking'" : 'NULL'}, offset_locked = ${locked ? `'${locked}'` : 'NULL'}
      WHERE bank_account_netsuite_id = '101'`);
    await offset(LOCKED);
    await offset(LOCKED_AGAIN);
    await offset(null);
    const rows = await since(after);
    expect(rows.map((r) => r.changed.offset_locked)).toEqual([{ hidden: true, from: null }, { hidden: true }, { hidden: true, to: null }]);
    expect(rows[0].changed.offset_last4).toEqual({ from: null, to: '4321' });
    expect(JSON.stringify(rows)).not.toMatch(/CCCCCCCC|FFFFFFFF/);
  });
});

describe('migration 508: how a change was made', () => {
  it('names the person a browser was signed in as, and nobody for a sign-in that isn\'t one', async () => {
    let after = await newest();
    await as('screen', CRAIG);
    await db.exec(`UPDATE own_number_series SET next_seq = next_seq + 1 WHERE doc_type = 'invoice'`);
    let [c] = await since(after);
    expect(c).toMatchObject({ table_name: 'own_number_series', via: 'screen', actor: CRAIG, db_app: null, row_name: { doc_type: 'invoice' } });

    after = await newest();
    await as('screen', 'not-a-person');
    await db.exec(`UPDATE own_number_series SET next_seq = next_seq + 1 WHERE doc_type = 'invoice'`);
    [c] = await since(after);
    expect(c).toMatchObject({ via: 'screen', actor: null });

    // A browser not signed in, with Supabase's public key, is a browser too.
    after = await newest();
    await as('database');
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'anon' })]);
    await db.exec(`UPDATE own_number_series SET next_seq = next_seq + 1 WHERE doc_type = 'invoice'`);
    [c] = await since(after);
    expect(c).toMatchObject({ via: 'screen', actor: null, db_app: null });
  });

  it('says a change was made straight in the database, by which login and program, and trusts no name it stamps', async () => {
    const after = await newest();
    await as('database');
    await db.exec(`UPDATE own_number_series SET next_seq = 50001, changed_by = '${CRAIG}', changed_at = now() WHERE doc_type = 'sales_order'`);
    const [c] = await since(after);
    expect(c).toMatchObject({
      table_name: 'own_number_series', via: 'database', actor: null, db_login: 'postgres', db_app: 'Supabase Studio', migration: null,
      changed: { next_seq: { from: 10001, to: 50001 }, changed_by: { from: null, to: CRAIG } },
    });
  });

  it('says a FleetSuite update made a change, and which', async () => {
    const after = await newest();
    await as('migration');
    await db.exec(`UPDATE own_number_series SET prefix = 'SOX' WHERE doc_type = 'sales_order'`);
    const [c] = await since(after);
    expect(c).toMatchObject({ via: 'migration', migration: '999-made-up.sql', actor: null, db_app: null });
  });

  it('reads the older single settings PostgREST sent the sign-in in', async () => {
    const after = await newest();
    await as('database');
    await db.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false), set_config('request.jwt.claim.sub', $1, false)`, [ZACH]);
    await db.exec(`UPDATE own_number_series SET prefix = 'SO' WHERE doc_type = 'sales_order'`);
    await db.exec(`SELECT set_config('request.jwt.claim.role', '', false), set_config('request.jwt.claim.sub', '', false)`);
    const [c] = await since(after);
    expect(c).toMatchObject({ via: 'screen', actor: ZACH });
  });
});

describe('migration 508: the rest of the books', () => {
  it('writes down nothing FleetSuite\'s server or an update changes there', async () => {
    const after = await newest();
    for (const how of ['server', 'migration'] as const) {
      await as(how);
      await db.exec(`INSERT INTO own_number_outside_told (netsuite_id, told_at) VALUES ('${how === 'server' ? 9001 : 9002}', now())`);
      await db.exec(`UPDATE own_number_outside_told SET told_at = now() + interval '1 hour' WHERE netsuite_id IN ('9001', '9002')`);
      await db.exec(`DELETE FROM own_number_outside_told WHERE netsuite_id IN ('9001', '9002')`);
    }
    expect(await since(after)).toEqual([]);
  });

  it('writes down every change made there outside FleetSuite', async () => {
    const after = await newest();
    await as('database');
    await db.exec(`INSERT INTO own_number_outside_told (netsuite_id, told_at) VALUES ('9003', '2026-11-02 08:00:00+00')`);
    await db.exec(`UPDATE own_number_outside_told SET told_at = '2026-11-02 09:00:00+00' WHERE netsuite_id = '9003'`);
    await as('screen', CRAIG);
    await db.exec(`DELETE FROM own_number_outside_told WHERE netsuite_id = '9003'`);
    const rows = await since(after);
    expect(rows.map((r) => [r.table_name, r.op, r.via, r.actor, r.row_key, r.row_name])).toEqual([
      ['own_number_outside_told', 'insert', 'database', null, { netsuite_id: '9003' }, {}],
      ['own_number_outside_told', 'update', 'database', null, { netsuite_id: '9003' }, {}],
      ['own_number_outside_told', 'delete', 'screen', CRAIG, { netsuite_id: '9003' }, {}],
    ]);
    expect(rows[1].changed).toEqual({ told_at: { from: '2026-11-02T08:00:00+00:00', to: '2026-11-02T09:00:00+00:00' } });
  });

  it('writes down a journal entry FleetSuite posts as nothing, and one posted straight in the database line by line', async () => {
    await as('server');
    const accounts = (await db.query<{ id: string }>(
      `INSERT INTO gl_accounts (number, name, account_type, is_control, company_id) VALUES
         ('10100', 'First Bank Operating', 'bank', false, NULL), ('40000', 'Upfit Sales', 'income', false, NULL)
       RETURNING id`,
    )).rows.map((a) => a.id);
    const post = (key: string) => rpc('gl_post_entry', {
      company: 'BMG', entry_date: '2026-10-15', source_type: 'invoice', source_id: key, posting_rule: 'invoice@1', idempotency_key: key,
      lines: [{ account_id: accounts[0], debit: '10.00' }, { account_id: accounts[1], credit: '10.00' }],
    });
    let after = await newest();
    await post('money-changes:1');
    expect((await since(after)).filter((r) => r.table_name !== 'gl_periods')).toEqual([]);

    after = await newest();
    await as('database');
    const entry = await post('money-changes:2');
    const rows = (await since(after)).filter((r) => r.table_name !== 'gl_periods');
    expect(rows.map((r) => [r.table_name, r.op, r.via])).toEqual([
      ['gl_entries', 'insert', 'database'],
      ['gl_lines', 'insert', 'database'],
      ['gl_lines', 'insert', 'database'],
    ]);
    expect(rows[0].row_key).toEqual({ id: entry.id });
    expect(rows[1].changed).toMatchObject({ account_id: { to: accounts[0] }, debit: { to: 10 }, entry_id: { to: entry.id } });
  });
});

describe('migration 508: telling about changes made outside FleetSuite', () => {
  it('counts the ones nobody has heard of by table and by how, and marks them told up to one', async () => {
    const before = await rpc0('books_outside_changes');
    expect(before.changes).toBeGreaterThan(0);
    const outside = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM books_money_changes WHERE via IN ('database', 'screen') AND told_at IS NULL`)).rows[0].n;
    expect(before.changes).toBe(Number(outside));
    expect(before.through).toBe(Number((await db.query<{ n: string }>(
      `SELECT max(id)::text AS n FROM books_money_changes WHERE via IN ('database', 'screen')`,
    )).rows[0].n));
    expect(before.tables.reduce((n: number, t: { changes: number }) => n + t.changes, 0)).toBe(before.changes);
    expect(before.ways.reduce((n: number, w: { changes: number }) => n + w.changes, 0)).toBe(before.changes);
    expect(before.ways).toContainEqual({ via: 'database', login: 'postgres', app: 'Supabase Studio', changes: expect.any(Number) });
    expect(before.ways).toContainEqual({ via: 'screen', login: 'postgres', app: null, changes: expect.any(Number) });
    expect(new Date(before.first_at).getTime()).toBeLessThanOrEqual(new Date(before.last_at).getTime());

    // One more after the look: marking what the look saw leaves it to tell next time.
    await as('database');
    await db.exec(`UPDATE own_number_series SET next_seq = 50002 WHERE doc_type = 'sales_order'`);
    const later = await newest();
    // And one still being made while it looked, numbered below what it saw but saved after: it waits too.
    await db.exec(
      `INSERT INTO books_money_changes (id, table_name, op, row_key, changed, via, db_login, tx) OVERRIDING SYSTEM VALUE
       VALUES (-1, 'gl_periods', 'update', '{"id": "p"}', '{"status": {"from": "open", "to": "closed"}}', 'database', 'postgres', txid_current())`,
    );
    await as('server');
    const seen = { through: before.through, snapshot: before.snapshot };
    expect(await rpc('books_outside_changes_told', seen)).toEqual({ told: before.changes });
    const after = await rpc0('books_outside_changes');
    expect(after).toMatchObject({ changes: 2, through: later });
    expect(after.tables).toEqual(expect.arrayContaining([{ table: 'own_number_series', changes: 1 }, { table: 'gl_periods', changes: 1 }]));
    expect(await rpc('books_outside_changes_told', seen)).toEqual({ told: 0 });
    expect(await rpc('books_outside_changes_told', { through: after.through, snapshot: after.snapshot })).toEqual({ told: 2 });
    expect(await rpc0('books_outside_changes')).toMatchObject({ changes: 0, through: null, first_at: null, last_at: null, tables: [], ways: [] });

    // FleetSuite's own changes are never told about.
    const server = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM books_money_changes WHERE via IN ('server', 'migration') AND told_at IS NOT NULL`)).rows[0].n;
    expect(server).toBe('0');
  });

  it('asks which change it was told up to, and as of when', async () => {
    await as('server');
    await expect(rpc('books_outside_changes_told', {})).rejects.toThrow(/told about the changes up to which one/);
    await expect(rpc('books_outside_changes_told', { through: 5 })).rejects.toThrow(/told about the changes seen when/);
  });
});

describe('migration 508: the record stays', () => {
  it('won\'t change or take away a change, or mark FleetSuite\'s own told about', async () => {
    await as('database');
    const told = Number((await db.query<{ n: string }>(`SELECT min(id)::text AS n FROM books_money_changes WHERE told_at IS NOT NULL`)).rows[0].n);
    const server = Number((await db.query<{ n: string }>(`SELECT min(id)::text AS n FROM books_money_changes WHERE via = 'server'`)).rows[0].n);
    await expect(db.exec(`UPDATE books_money_changes SET via = 'server' WHERE id = ${told}`)).rejects.toThrow(/a change's record doesn't change/);
    await expect(db.exec(`UPDATE books_money_changes SET told_at = now() WHERE id = ${told}`)).rejects.toThrow(/a change's record doesn't change/);
    await expect(db.exec(`UPDATE books_money_changes SET changed = '{}' WHERE id = ${server}`)).rejects.toThrow(/a change's record doesn't change/);
    await expect(db.exec(`UPDATE books_money_changes SET told_at = now() WHERE id = ${server}`)).rejects.toThrow(/books_money_changes_told/);
    await expect(db.exec(`DELETE FROM books_money_changes WHERE id = ${server}`)).rejects.toThrow(/the change history stays/);
  });
});

describe('migration 508: access', () => {
  const functions = ['books_money_change()', 'books_money_changes_guard()', 'books_outside_changes()', 'books_outside_changes_told(jsonb)'];

  it('lets only the service role read the history and call its functions; anyone may ask how a change is made', async () => {
    await as('database');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of functions) {
        const r = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(role === 'service_role');
      }
      const via = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, 'books_change_via()', 'EXECUTE') AS ok", [role]);
      expect(via.rows[0].ok, `${role} books_change_via()`).toBe(true);
      const t = await db.query<{ ok: boolean }>("SELECT has_table_privilege($1, 'books_money_changes', 'SELECT') AS ok", [role]);
      expect(t.rows[0].ok, `${role} books_money_changes`).toBe(role === 'service_role');
    }
    const rls = await db.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'books_money_changes'`);
    expect(rls.rows[0].on).toBe(true);
  });

  it('gives every DELETE and UPDATE in the functions a WHERE, as Supabase\'s API requires', async () => {
    const bodies = (await db.query<{ name: string; body: string }>(
      `SELECT p.proname AS name, p.prosrc AS body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND (p.proname LIKE 'books\\_money\\_change%' OR p.proname LIKE 'books\\_outside\\_changes%' OR p.proname = 'books_change_via')
       ORDER BY p.proname`,
    )).rows;
    expect(bodies.map((b) => b.name)).toEqual([
      'books_change_via', 'books_money_change', 'books_money_changes_guard', 'books_outside_changes', 'books_outside_changes_told',
    ]);
    expect(bodies.flatMap((b) => unguardedWrites(b.body).map((w) => `${b.name}: ${w}`))).toEqual([]);
  });
});

describe('Books → Change history', () => {
  const get = async (params = '') => {
    const res = await GET(new NextRequest(`https://go.bmgfleet.com/api/admin/books/change-history${params ? `?${params}` : ''}`));
    return { status: res.status, body: await res.json() };
  };
  let seq = 0;

  beforeAll(async () => {
    // Where the rows stand first; then nothing is written down but four changes, one made each way.
    await as('server');
    await db.exec(`UPDATE books_switches SET is_on = true, changed_by = '${CRAIG}', changed_at = '2026-11-02 21:00:00+00' WHERE piece = 'credit_memos'`);
    await db.exec(`UPDATE vendor_ach_setups SET entry_description = 'PAYMENTS' WHERE bank_account_netsuite_id = '101'`);
    await db.exec(`INSERT INTO sales_tax_rates (location_id, starts_on, rate_pct, note, entered_by) VALUES ('7', '2026-10-01', 8.475, 'Made-up rate', '${JESSIE}')`);
    seq = Number((await db.query<{ n: number }>(`SELECT next_seq AS n FROM own_number_series WHERE doc_type = 'invoice'`)).rows[0].n);
    await as('database');
    await db.exec('TRUNCATE books_money_changes');

    await as('server');
    await db.exec(`UPDATE books_switches SET is_on = false, changed_by = '${JESSIE}', changed_at = '2026-11-02 22:00:00+00' WHERE piece = 'credit_memos'`);
    await as('database');
    await db.exec(`UPDATE vendor_ach_setups SET entry_description = 'BMG PAY' WHERE bank_account_netsuite_id = '101'`);
    await as('screen', ZACH);
    await db.exec(`UPDATE sales_tax_rates SET rate_pct = 8.725 WHERE location_id = '7' AND starts_on = '2026-10-01'`);
    await as('migration');
    await db.exec(`UPDATE own_number_series SET next_seq = next_seq + 1 WHERE doc_type = 'invoice'`);
    await as('server');
  });

  beforeEach(() => {
    roles = ['admin', 'super_admin'];
  });

  it('shows a super admin every change, newest first: which record, how it was made and by whom, and what it changed', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      show: 'all', area: null, table: null, tableWhat: null, key: null, page: 0, more: false,
      summary: { days: 30, fleetsuite: 1, outside: 2, updates: 1 },
    });
    expect(body.areas.map((a: { key: string }) => a.key)).toContain('bank');
    expect(body.changes.map((c: any) => [c.what, c.name, c.op, c.outside, c.who, c.how])).toEqual([
      ['Own number series', 'Invoices', 'update', false, null, 'By the FleetSuite update 999-made-up.sql'],
      ['Sales tax rate', 'location 7 · Oct 1, 2026', 'update', true, 'Zach Zane', "From a browser signed in as Zach Zane, around FleetSuite's own screens"],
      ['ACH setup', 'BMG · bank account 101', 'update', true, null, 'Straight in the database with Supabase Studio, signed in as postgres'],
      ['Switch', 'Credit memos', 'update', false, 'Jessie Jones', 'In FleetSuite, by Jessie Jones'],
    ]);
    const [update, rate, setup, toggled] = body.changes;
    expect(update.columns).toEqual([{ column: 'next_seq', label: 'Next number', from: String(seq), to: String(seq + 1), hidden: false }]);
    expect(rate.columns).toEqual([{ column: 'rate_pct', label: 'Rate', from: '8.475%', to: '8.725%', hidden: false }]);
    expect(setup).toMatchObject({ table: 'vendor_ach_setups', key: { bank_account_netsuite_id: '101' }, via: 'database', toldAt: null });
    expect(setup.columns).toEqual([
      { column: 'entry_description', label: 'The description vendors see', from: 'PAYMENTS', to: 'BMG PAY', hidden: false },
    ]);
    expect(toggled.columns).toEqual([
      { column: 'changed_at', label: 'Changed at', from: 'Nov 2, 2026, 3:00 PM Central', to: 'Nov 2, 2026, 4:00 PM Central', hidden: false },
      { column: 'changed_by', label: 'Changed by', from: 'Craig George', to: 'Jessie Jones', hidden: false },
      { column: 'is_on', label: 'On', from: 'Yes', to: 'No', hidden: false },
    ]);
  });

  it('narrows to how a change was made, to a kind of record, or to one record\'s history', async () => {
    const tables = async (params: string) => (await get(params)).body.changes.map((c: { table: string }) => c.table);
    expect(await tables('show=outside')).toEqual(['sales_tax_rates', 'vendor_ach_setups']);
    expect(await tables('show=fleetsuite')).toEqual(['books_switches']);
    expect(await tables('show=updates')).toEqual(['own_number_series']);
    expect(await tables('area=settings')).toEqual(['own_number_series', 'sales_tax_rates']);
    expect(await tables('area=settings&show=outside')).toEqual(['sales_tax_rates']);

    let { body } = await get(`table=books_switches&key=${encodeURIComponent(JSON.stringify({ piece: 'credit_memos' }))}`);
    expect(body).toMatchObject({ table: 'books_switches', tableWhat: 'Switch', key: { piece: 'credit_memos' }, area: null });
    expect(body.changes.map((c: { name: string }) => c.name)).toEqual(['Credit memos']);
    ({ body } = await get(`table=books_switches&key=${encodeURIComponent(JSON.stringify({ piece: 'invoice_pdfs' }))}`));
    expect(body.changes).toEqual([]);
    // A table it doesn't know, a show or an area it doesn't have, or a key that isn't one, narrows nothing.
    ({ body } = await get('table=profiles&show=sometimes&area=everything'));
    expect(body).toMatchObject({ table: null, show: 'all', area: null });
    expect(body.changes).toHaveLength(4);
    ({ body } = await get('table=books_switches&key=%7B%22piece%22%3A%5B1%5D%7D'));
    expect(body).toMatchObject({ table: 'books_switches', key: null });
    expect(body.changes).toHaveLength(1);
  });

  it('shows the bookkeeper and the CPA all but the vendors\' bank numbers and the ACH setups and files', async () => {
    for (const who of [['bookkeeper'], ['cpa']]) {
      roles = who;
      const { status, body } = await get();
      expect(status, who[0]).toBe(200);
      expect(body.summary, who[0]).toMatchObject({ fleetsuite: 1, outside: 1, updates: 1 });
      expect(body.changes.map((c: { table: string }) => c.table), who[0]).toEqual(['own_number_series', 'sales_tax_rates', 'books_switches']);
      expect(body.areas.map((a: { key: string }) => a.key), who[0]).not.toContain('bank');
      for (const params of ['table=vendor_ach_setups', 'table=vendor_bank_accounts&key=%7B%22id%22%3A%221%22%7D', 'area=bank']) {
        const refused = await get(params);
        expect(refused.status, `${who[0]} ${params}`).toBe(403);
        expect(refused.body.error).toBe("Only a super admin sees the history of the vendors' bank numbers and the ACH setups and files.");
      }
    }
    roles = ['admin'];
    expect((await get()).status).toBe(403);
  });

  it('pages 50 at a time, newest first', async () => {
    await as('server');
    for (let n = 0; n < 49; n++) {
      await db.exec(`UPDATE books_switches SET is_on = ${n % 2 === 0}, changed_by = '${CRAIG}', changed_at = now() WHERE piece = 'credit_memos'`);
    }
    const first = await get();
    expect(first.body).toMatchObject({ page: 0, more: true, summary: { fleetsuite: 50 } });
    expect(first.body.changes).toHaveLength(50);
    expect(first.body.changes[49].table).toBe('own_number_series');
    const second = await get('page=1');
    expect(second.body).toMatchObject({ page: 1, more: false });
    expect(second.body.changes.map((c: { table: string }) => c.table)).toEqual(['sales_tax_rates', 'vendor_ach_setups', 'books_switches']);
    const ids = [...first.body.changes, ...second.body.changes].map((c: { id: number }) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(53);
    expect((await get('page=2')).body).toMatchObject({ changes: [], more: false });
    // Exactly a page's worth has no more.
    const made = await get('show=fleetsuite');
    expect(made.body).toMatchObject({ page: 0, more: false });
    expect(made.body.changes).toHaveLength(50);
  });
});

describe('migration 508: once a company\'s books are live', () => {
  // Last in the file: going live can't be undone.
  it('writes the going live down, and won\'t empty the history', async () => {
    const after = await newest();
    await as('database');
    await db.exec(`UPDATE gl_companies SET books_live_from = '2027-01-01' WHERE code = 'BMG'`);
    const [c] = await since(after);
    expect(c).toMatchObject({ table_name: 'gl_companies', via: 'database', changed: { books_live_from: { from: null, to: '2027-01-01' } } });
    expect(c.row_name).toMatchObject({ code: 'BMG' });
    await expect(db.exec('TRUNCATE books_money_changes')).rejects.toThrow(/books_money_changes can't be emptied once any company's books are live/);
  });
});

/** A function of no arguments. */
async function rpc0<T = any>(fn: string): Promise<T> {
  const r = await db.query<{ r: T }>(`SELECT ${fn}() AS r`);
  return r.rows[0].r;
}
