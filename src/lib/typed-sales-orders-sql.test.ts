// Migration 474: typed_sales_orders, one row per New sales order form, so a
// second press never makes a second order. Runs it twice in PGlite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
  `);
  const sql = readFileSync(path.resolve(__dirname, '../../migrations/474-typed-sales-orders.sql'), 'utf8');
  await pg.exec(sql);
  await pg.exec(sql); // must be safe to re-run
});
afterAll(async () => { await pg?.close(); });

const ID = 'a0000000-0000-4000-8000-000000000001';

describe('migration 474', () => {
  it('keeps one row per form and refuses a second', async () => {
    await pg.query(
      `INSERT INTO typed_sales_orders (id, customer_netsuite_id, customer_name, ship_to, lines, total_cents, claimed_at)
       VALUES ($1, '9001', 'Acme Fleet', $2, $3, 422549, now())`,
      [ID, JSON.stringify({ name: 'Acme', address: '1 Main', city: 'Dayton', state: 'OH', zip: '45402' }), JSON.stringify([{ itemId: '55' }])],
    );
    await expect(pg.query(`INSERT INTO typed_sales_orders (id, customer_netsuite_id) VALUES ($1, '9001')`, [ID])).rejects.toThrow(/duplicate key/);
    await pg.query(`UPDATE typed_sales_orders SET netsuite_so_id = '777', netsuite_so_number = 'SO1205' WHERE id = $1`, [ID]);
    const { rows } = await pg.query<any>(`SELECT netsuite_so_number, ship_to->>'state' AS state FROM typed_sales_orders WHERE id = $1`, [ID]);
    expect(rows[0]).toEqual({ netsuite_so_number: 'SO1205', state: 'OH' });
  });

  it('takes only a NetSuite customer id', async () => {
    await expect(pg.query(`INSERT INTO typed_sales_orders (id, customer_netsuite_id) VALUES (gen_random_uuid(), 'Acme')`)).rejects.toThrow(/check constraint/);
  });

  it('is closed to page sessions', async () => {
    const { rows } = await pg.query<any>(`SELECT has_table_privilege('authenticated', 'typed_sales_orders', 'SELECT') AS can`);
    expect(rows[0].can).toBe(false);
  });
});
